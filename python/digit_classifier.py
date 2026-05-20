# Copyright (c) 2026, Antoine Duval
# This file is part of a source-visible project.
# See LICENSE for terms. Unauthorized use is prohibited.

"""Classifier ONNX pour identifier les chiffres joueurs.

Charge le modèle CNN entraîné (export ONNX) et fournit une API simple :
  - `classify_crops(crops)` : liste de crops 21×21 BGR → (digit, conf) par crop
  - `filter_blobs(frame_bgr, minimap_info, blobs, min_conf)` : prend la sortie
    de `blob_detector.detect_blobs` et garde uniquement les candidates
    classifiés comme digit avec confidence ≥ seuil.

L'inference se fait sur CPU via onnxruntime (sans dépendance PyTorch au runtime).
"""

import os
import sys
from typing import List, Optional, Tuple

import cv2
import numpy as np
import onnxruntime as ort


# Résout `models/` dans le bundle PyInstaller (via sys._MEIPASS) ou en dev
# (dossier parent du script). Aligné avec la convention d'analyze_video.py.
_BASE = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
_DEFAULT_MODEL_PATH = os.path.join(_BASE, 'models', 'digit_cnn.onnx')

# Doit matcher train_cnn.IMG_SIZE, GARBAGE_LABEL.
_IMG_SIZE = 21
_GARBAGE_LABEL = 10
# Seuil minimum de softmax sur la classe digit pour garder un candidate.
_DEFAULT_MIN_CONF = 0.7
# Demi-côté pour découper le crop dans le ROI minimap.
_CROP_HALF = 10
# Rayon d'exclusion autour d'un élément statique (TP, capture point) :
# une détection plus proche que ça est considérée comme un faux positif
# (le CNN classifie souvent la flèche d'un TP ou la lettre d'un point
# comme un digit).
_STATIC_ELEMENT_RADIUS = 10.0
# Marge autour du polygone de spawn ennemi pour rejeter aussi les candidates
# en bordure (flèches/icônes TP dépassant dans la trouée d'un spawn en U).
_ENEMY_SPAWN_BUFFER = 8.0


def _softmax(logits: np.ndarray) -> np.ndarray:
    """Softmax stable sur la dernière dim."""
    e = np.exp(logits - logits.max(axis=-1, keepdims=True))
    return e / e.sum(axis=-1, keepdims=True)


class DigitClassifier:
    """Wrapper ONNX Runtime pour le CNN digit/garbage."""

    def __init__(self, model_path: str = _DEFAULT_MODEL_PATH):
        if not os.path.isfile(model_path):
            raise FileNotFoundError(f'ONNX model not found: {model_path}')
        # Suppress ONNX Runtime verbose logging
        opts = ort.SessionOptions()
        opts.log_severity_level = 3  # only errors
        self.session = ort.InferenceSession(
            model_path, sess_options=opts, providers=['CPUExecutionProvider'])
        self.input_name = self.session.get_inputs()[0].name

    def classify_crops(self, crops_bgr: List[np.ndarray]) -> List[Tuple[int, float]]:
        """Classifie une liste de crops BGR. Retourne [(digit, conf), ...].

        digit = label argmax (0-9 ou 10 = garbage). conf = softmax prob du label.
        Si un crop n'a pas la bonne shape, on le resize en 21×21.
        """
        if not crops_bgr:
            return []
        batch = []
        for crop in crops_bgr:
            gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
            if gray.shape != (_IMG_SIZE, _IMG_SIZE):
                gray = cv2.resize(gray, (_IMG_SIZE, _IMG_SIZE),
                                  interpolation=cv2.INTER_AREA)
            batch.append(gray.astype(np.float32) / 255.0)
        x = np.stack(batch).reshape(-1, 1, _IMG_SIZE, _IMG_SIZE)
        logits = self.session.run(None, {self.input_name: x})[0]
        probs = _softmax(logits)
        labels = probs.argmax(axis=1)
        confs = probs.max(axis=1)
        return [(int(l), float(c)) for l, c in zip(labels, confs)]

    def filter_blobs(self, frame_bgr: np.ndarray, minimap_info: dict,
                      blobs: dict, min_conf: float = _DEFAULT_MIN_CONF,
                      map_meta: Optional[dict] = None,
                      valid_numbers: Optional[dict] = None) -> dict:
        """Filtre les blobs détectés en gardant ceux classifiés comme digit.

        Pour chaque candidate de `blobs[team]`, on extrait le crop 21×21
        centré (en coords ROI), on le classifie, et on le garde si :
          - label ≠ garbage
          - confidence ≥ min_conf
          - label appartient au range valide pour l'équipe (orange = 1-5,
            blue = 0,6-9) — élimine les misreads cross-team
          - position pas trop proche d'un élément statique connu (TP icon,
            capture point) si `map_meta` est fourni — élimine les faux
            positifs récurrents où le CNN classifie la flèche d'un TP
            comme un digit
          - au plus 1 détection par (team, number) — la plus haute
            confidence gagne (contrainte de jeu : unicité de (team, number))

        Sortie : dict {team: [{'x', 'y', 'strength', 'digit', 'conf'}, ...]},
        x/y en coords TEMPLATE comme le détecteur initial.
        """
        # Pré-calcule les positions interdites (TPs + capture points) en
        # coords TEMPLATE — les blobs sont déjà en TEMPLATE coords.
        forbidden_points: list = []
        # Spawns ennemis : un digit orange ne peut jamais apparaître dans un
        # spawn bleu (et inversement). Plus solide que le rayon TP fixe : couvre
        # toute la zone des flèches/icônes TP qui dépassent souvent du radius.
        enemy_spawn_polys: dict = {'orange': [], 'blue': []}
        if map_meta:
            for tp in map_meta.get('teleporters', []):
                forbidden_points.append((float(tp['position'][0]),
                                          float(tp['position'][1]),
                                          float(tp.get('radius', _STATIC_ELEMENT_RADIUS))))
            # NOTE : on n'exclut PLUS les capture points. À l'origine on
            # voulait rejeter la lettre A/B/C du point (confondue avec un digit
            # par le CNN), mais ça filtrait aussi les vrais joueurs qui passent
            # SUR le point. Le CNN entraîné avec hard negatives gère désormais
            # la lettre comme garbage.
            spawns = map_meta.get('spawns', {})
            for team in ('orange', 'blue'):
                other = 'blue' if team == 'orange' else 'orange'
                for sp in spawns.get(other, []):
                    poly = np.array(sp['polygon'], dtype=np.int32)
                    enemy_spawn_polys[team].append(poly)

        def _is_in_static(x: float, y: float) -> bool:
            for (sx, sy, sr) in forbidden_points:
                if (x - sx) ** 2 + (y - sy) ** 2 <= sr ** 2:
                    return True
            return False

        def _is_in_enemy_spawn(team: str, x: float, y: float) -> bool:
            # Marge : on rejette aussi les candidates juste hors du polygone
            # (les flèches TP / icônes en bord de spawn dépassent souvent
            # jusque dans la "trouée" en U du spawn).
            for poly in enemy_spawn_polys.get(team, []):
                dist = cv2.pointPolygonTest(poly, (float(x), float(y)), True)
                if dist >= -_ENEMY_SPAWN_BUFFER:
                    return True
            return False

        (x1, y1), (x2, y2) = minimap_info['box']
        scale = float(minimap_info.get('scale', 1.0)) or 1.0
        roi = frame_bgr[y1:y2, x1:x2]
        if roi.size == 0:
            return {'orange': [], 'blue': []}
        h, w = roi.shape[:2]

        # Collecte tous les crops d'un coup pour batch inference.
        all_meta: List[Tuple[str, dict]] = []  # (team, blob)
        all_crops: List[np.ndarray] = []
        for team, candidates in blobs.items():
            for b in candidates:
                # Convert template-px → ROI-px pour cropping
                cx = int(round(b['x'] * scale))
                cy = int(round(b['y'] * scale))
                xa = max(0, cx - _CROP_HALF)
                ya = max(0, cy - _CROP_HALF)
                xb = min(w, cx + _CROP_HALF + 1)
                yb = min(h, cy + _CROP_HALF + 1)
                crop = roi[ya:yb, xa:xb]
                # Skip si le crop déborde trop (en bord de ROI)
                if crop.shape[0] < _IMG_SIZE - 4 or crop.shape[1] < _IMG_SIZE - 4:
                    continue
                all_meta.append((team, b))
                all_crops.append(crop)

        if not all_crops:
            return {'orange': [], 'blue': []}

        results = self.classify_crops(all_crops)

        # Numéros valides par équipe. Si `valid_numbers` est fourni (par
        # ex. depuis le roster réel de la game), on l'utilise — sinon on
        # tombe sur le superset 5v5 (règles EVA standard) ce qui peut
        # accepter des digits impossibles (ex: blue #0 en 4v4).
        valid_by_team = valid_numbers if valid_numbers else {
            'orange': {1, 2, 3, 4, 5},
            'blue':   {0, 6, 7, 8, 9},
        }

        # Premier passage : filtre par confidence + cross-team + garbage +
        # éléments statiques (TPs, points), puis dédup hard par (team,
        # number) : EXACTEMENT 1 détection par (team, number) par frame,
        # la plus haute confidence gagne. Justification : le jeu garantit
        # l'unicité d'un (team, number) à tout instant. Plusieurs candidates
        # classifiés "orange #4" à des positions différentes = forcément
        # 1 vrai + N-1 faux positifs.
        best_by_key: dict = {}  # (team, digit) → (conf, blob)
        for (team, blob), (digit, conf) in zip(all_meta, results):
            if digit == _GARBAGE_LABEL:
                continue
            if conf < min_conf:
                continue
            if digit not in valid_by_team[team]:
                continue  # misread cross-team
            if _is_in_static(blob['x'], blob['y']):
                continue  # candidate sur un TP / capture point statique
            if _is_in_enemy_spawn(team, blob['x'], blob['y']):
                continue  # un digit ne peut pas apparaître dans le spawn adverse
            key = (team, digit)
            if key not in best_by_key or conf > best_by_key[key][0]:
                best_by_key[key] = (conf, blob)

        out: dict = {'orange': [], 'blue': []}
        for (team, digit), (conf, blob) in best_by_key.items():
            out[team].append({
                **blob,
                'digit': digit,
                'conf': conf,
            })
        return out


# ─── Quick CLI test ────────────────────────────────────────────────────────

def main():
    """Test rapide : classifie tous les crops d'un dossier et affiche stats."""
    import sys
    if len(sys.argv) < 2:
        print('Usage: digit_classifier.py <crops_dir>')
        sys.exit(1)
    d = sys.argv[1]
    classifier = DigitClassifier()
    crops = []
    paths = []
    for f in sorted(os.listdir(d)):
        if not f.endswith('.png'):
            continue
        img = cv2.imread(os.path.join(d, f))
        if img is None:
            continue
        crops.append(img)
        paths.append(f)
    if not crops:
        print('no crops found')
        return
    results = classifier.classify_crops(crops)
    from collections import Counter
    counter = Counter([r[0] for r in results])
    print(f'classified {len(crops)} crops, distribution:')
    for label in sorted(counter):
        name = '_garbage' if label == _GARBAGE_LABEL else str(label)
        print(f'  {name}: {counter[label]}')


if __name__ == '__main__':
    main()
