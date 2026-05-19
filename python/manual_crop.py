# Copyright (c) 2026, Antoine Duval
# This file is part of a source-visible project.
# See LICENSE for terms. Unauthorized use is prohibited.

"""Outil de labélisation manuelle des chiffres joueurs sur la minimap.

Deux modes selon les arguments CLI :

1. **Mode crops** (défaut) : génère des crops 21×21 pour l'entraînement CNN.
   Sélectionner une classe (0-9 ou g), cliquer sur chaque digit apparaissant
   sur la minimap. Crop centré sauvé dans `training_data/digits/<classe>/`.

2. **Mode ground truth** (`--truth <out.json>`) : annote la position
   réelle de chaque joueur frame par frame, pour créer un JSON de référence
   au format `players_tracks`. Sert de source de vérité pour benchmarker
   l'algorithme de tracking. Sélectionner un numéro (0-9), cliquer sur le
   joueur correspondant ; team déduite du numéro (1-5 = orange, 0,6-9 = blue).

Avantages vs extraction auto + tri :
  - 0 % de garbage à trier (sauf si on clique en mode garbage)
  - Crops centrés à 1 px près sur le digit (vs ~5 px d'erreur avec le
    blob_detector)
  - Le user choisit la diversité (spawn, hors-spawn, focus, etc.)

Contrôles communs :
  - 0-9             : sélectionne la classe / numéro joueur actif
  - click souris    : enregistre à la position cliquée
  - z               : annule le dernier enregistrement de la frame courante
  - → / d           : frame suivante
  - ← / a           : frame précédente
  - ↑ / w           : saut +15s
  - ↓ / s           : saut -15s
  - SPACE           : frame +0.1s (fine)
  - q / ESC         : quitter

Mode crops uniquement :
  - g               : passe en mode garbage

Usage :
    # Mode crops (entraînement CNN) :
    python3 manual_crop.py <video_path> <map_name>

    # Mode ground truth (benchmark tracking) :
    python3 manual_crop.py <video_path> <map_name> --truth <out.json> [--step 1.0]
"""

import argparse
import json
import os
import sys
from typing import Optional, Tuple

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import minimap as _minimap
import map_metadata as _map_metadata

# Auto-assignment au clic (mode truth) : si aucun digit n'est pré-tapé, on
# assigne séquentiellement dans l'ordre des joueurs visibles, en sautant les
# numéros déjà posés sur la frame.
_AUTO_DIGIT_SEQUENCE = (1, 2, 3, 4, 6, 7, 8, 9, 0)


_HERE = os.path.dirname(os.path.abspath(__file__))
TRAIN_DIR = os.path.join(_HERE, 'training_data', 'digits')

# Demi-côté du crop natif (21×21 px), upscale ×8 pour la cohérence avec
# le pipeline d'entraînement existant (qui re-lit en couleur 168×168 et
# downscale à 21×21 en grayscale).
_CROP_HALF = 10
_CROP_SIZE = 2 * _CROP_HALF + 1
_TRAIN_UPSCALE = 8

# Upscale du display dans la fenêtre cv2 (assez gros pour cliquer précis).
_DISPLAY_UPSCALE = 6

# Pas temporel entre frames.
_STEP_S = 1.5
_BIG_STEP_S = 15.0
_FINE_STEP_S = 0.1

# Mapping numéro joueur → équipe (règle EVA standard).
_TEAM_BY_DIGIT = {
    0: 'blue', 1: 'orange', 2: 'orange', 3: 'orange', 4: 'orange',
    5: 'orange', 6: 'blue', 7: 'blue', 8: 'blue', 9: 'blue',
}


# Codes touches : cv2.waitKeyEx retourne le code full sur macOS pour les
# flèches (63232-63235), Linux/Win en utilisent d'autres. On accepte
# plusieurs codes + aliases lettre.
_KEY_LEFT = {63234, 65361, 81, 2}      # ← + variantes
_KEY_RIGHT = {63235, 65363, 83, 3}     # →
_KEY_UP = {63232, 65362, 82, 0}        # ↑
_KEY_DOWN = {63233, 65364, 84, 1}      # ↓


class ManualCropper:
    def __init__(self, video_path: str, map_name: str):
        self.video_path = video_path
        self.map_name = map_name
        self.basename = ''.join(
            c if c.isalnum() or c in '_-' else '_'
            for c in os.path.splitext(os.path.basename(video_path))[0]
        )
        self.cap = cv2.VideoCapture(video_path)
        if not self.cap.isOpened():
            raise RuntimeError(f'cannot open {video_path}')
        self.fps = self.cap.get(cv2.CAP_PROP_FPS) or 30
        self.duration = self.cap.get(cv2.CAP_PROP_FRAME_COUNT) / self.fps
        self.box = None
        self.scale = 1.0
        self._locate_minimap()

        self.ts = 0.0
        self.active_class: Optional[int] = None  # None | 0-9 | 10 (garbage)
        self.current_frame_clicks: list = []     # [(window_x, window_y, class, filepath)]
        self.last_label_msg = ''
        self.counts = self._scan_existing_counts()

    # ─── Init ──────────────────────────────────────────────────────────

    def _locate_minimap(self) -> None:
        """Localise la box minimap sur une frame mid-game."""
        mid_ts = self.duration / 2.0
        self.cap.set(cv2.CAP_PROP_POS_MSEC, mid_ts * 1000)
        ok, seed = self.cap.read()
        if not ok:
            raise RuntimeError(f'cannot read seed frame at t={mid_ts:.1f}s')
        info = _minimap.find_minimap_box(seed, self.map_name, min_score=0.0)
        if info is None:
            raise RuntimeError(f'minimap not found for map={self.map_name}')
        self.box = info['box']
        self.scale = float(info.get('scale', 1.0)) or 1.0
        (x1, y1), (x2, y2) = self.box
        print(f'minimap box=({x1},{y1})-({x2},{y2}) score={info["score"]:.2f} '
              f'scale={self.scale:.2f}')

    def _scan_existing_counts(self) -> dict:
        """Compte les fichiers déjà présents par classe (pour numérotation continue)."""
        out = {}
        for cls in [str(i) for i in range(10)] + ['garbage']:
            d = os.path.join(TRAIN_DIR, cls)
            if os.path.isdir(d):
                out[cls] = sum(1 for f in os.listdir(d) if f.endswith('.png'))
            else:
                out[cls] = 0
                os.makedirs(d, exist_ok=True)
        return out

    # ─── Frame loading ─────────────────────────────────────────────────

    def _get_roi(self) -> Optional[np.ndarray]:
        """Crop minimap à `self.ts` en coords frame originales."""
        self.cap.set(cv2.CAP_PROP_POS_MSEC, self.ts * 1000)
        ok, frame = self.cap.read()
        if not ok:
            return None
        (x1, y1), (x2, y2) = self.box
        return frame[y1:y2, x1:x2]

    # ─── Rendering ─────────────────────────────────────────────────────

    def _render(self, roi: np.ndarray) -> np.ndarray:
        """Compose le display : ROI upscalé + marqueurs des clicks + HUD."""
        big = cv2.resize(
            roi, (roi.shape[1] * _DISPLAY_UPSCALE, roi.shape[0] * _DISPLAY_UPSCALE),
            interpolation=cv2.INTER_NEAREST)

        # Marqueurs sur les clicks de la frame courante.
        for wx, wy, cls, _ in self.current_frame_clicks:
            color = (0, 255, 255) if cls == 10 else (0, 200, 0)
            label = 'g' if cls == 10 else str(cls)
            cv2.circle(big, (wx, wy), 10, color, 2, cv2.LINE_AA)
            cv2.putText(big, label, (wx + 12, wy + 5),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1, cv2.LINE_AA)

        # HUD avec bande noire en bas.
        h, w = big.shape[:2]
        hud = np.zeros((50, w, 3), dtype=np.uint8)
        active = 'NONE' if self.active_class is None else (
            'garbage' if self.active_class == 10 else str(self.active_class))
        hud_line1 = (f't={self.ts:6.2f}s / {self.duration:.0f}s  '
                     f'classe active: {active}  '
                     f'clicks cette frame: {len(self.current_frame_clicks)}')
        counts_str = ' '.join(f'{k}:{self.counts[k]}'
                              for k in [str(i) for i in range(10)] + ['garbage'])
        hud_line2 = f'totaux:  {counts_str}'
        cv2.putText(hud, hud_line1, (8, 18),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1, cv2.LINE_AA)
        cv2.putText(hud, hud_line2, (8, 38),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.4, (180, 180, 180), 1, cv2.LINE_AA)
        if self.last_label_msg:
            cv2.putText(big, self.last_label_msg, (8, 20),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1, cv2.LINE_AA)
        return np.vstack([big, hud])

    # ─── Actions ───────────────────────────────────────────────────────

    def _on_mouse(self, event, x, y, flags, param) -> None:
        if event != cv2.EVENT_LBUTTONDOWN:
            return
        if self.active_class is None:
            self.last_label_msg = 'choisis une classe (0-9 ou g) avant de cliquer'
            return
        # Window coords → ROI coords
        cx = x // _DISPLAY_UPSCALE
        cy = y // _DISPLAY_UPSCALE
        # Re-récupère la ROI courante pour le crop pixel-exact
        roi = self._get_roi()
        if roi is None:
            return
        xa = cx - _CROP_HALF
        ya = cy - _CROP_HALF
        xb = cx + _CROP_HALF + 1
        yb = cy + _CROP_HALF + 1
        if xa < 0 or ya < 0 or xb > roi.shape[1] or yb > roi.shape[0]:
            self.last_label_msg = 'click trop proche du bord, crop annule'
            return
        crop = roi[ya:yb, xa:xb]
        big = cv2.resize(crop, (_CROP_SIZE * _TRAIN_UPSCALE,
                                 _CROP_SIZE * _TRAIN_UPSCALE),
                         interpolation=cv2.INTER_NEAREST)
        cls = 'garbage' if self.active_class == 10 else str(self.active_class)
        self.counts[cls] += 1
        seq = self.counts[cls]
        fn = f'{self.basename}_t{int(self.ts * 10):05d}_{seq:04d}.png'
        path = os.path.join(TRAIN_DIR, cls, fn)
        cv2.imwrite(path, big)
        self.current_frame_clicks.append((x, y, self.active_class, path))
        self.last_label_msg = f'sauve {cls} #{seq}'

    def _undo(self) -> None:
        if not self.current_frame_clicks:
            return
        _, _, cls_idx, path = self.current_frame_clicks.pop()
        try:
            os.remove(path)
        except OSError:
            pass
        cls = 'garbage' if cls_idx == 10 else str(cls_idx)
        self.counts[cls] = max(0, self.counts[cls] - 1)
        self.last_label_msg = f'annulation {cls}'

    def _advance(self, delta_s: float) -> None:
        self.ts = max(0.0, min(self.duration, self.ts + delta_s))
        self.current_frame_clicks = []
        self.last_label_msg = ''

    # ─── Main loop ─────────────────────────────────────────────────────

    def run(self) -> None:
        win = 'manual_crop'
        cv2.namedWindow(win, cv2.WINDOW_AUTOSIZE)
        cv2.setMouseCallback(win, self._on_mouse)
        print()
        print('Contrôles :')
        print('  0-9 / g  : classe active')
        print('  click    : crop a la position cliquee')
        print('  z        : annule le dernier crop')
        print('  → / d    : frame +1.5s')
        print('  ← / a    : frame -1.5s')
        print('  ↑ / w    : frame +15s')
        print('  ↓ / s    : frame -15s')
        print('  SPACE    : frame +0.1s (fine)')
        print('  q / ESC  : quitter')
        print()

        while True:
            roi = self._get_roi()
            if roi is None:
                print(f'cannot read frame at t={self.ts:.1f}s')
                break
            display = self._render(roi)
            cv2.imshow(win, display)
            key = cv2.waitKeyEx(0)
            if key == ord('q') or key == 27:  # q or ESC
                break
            if ord('0') <= key <= ord('9'):
                self.active_class = key - ord('0')
                self.last_label_msg = f'classe = {self.active_class}'
            elif key == ord('g'):
                self.active_class = 10
                self.last_label_msg = 'classe = garbage'
            elif key == ord('z'):
                self._undo()
            elif key in _KEY_RIGHT or key == ord('d'):
                self._advance(_STEP_S)
            elif key in _KEY_LEFT or key == ord('a'):
                self._advance(-_STEP_S)
            elif key in _KEY_UP or key == ord('w'):
                self._advance(_BIG_STEP_S)
            elif key in _KEY_DOWN or key == ord('s'):
                self._advance(-_BIG_STEP_S)
            elif key == ord(' '):
                self._advance(_FINE_STEP_S)
            elif key == -1:
                # Window closed
                break

        self.cap.release()
        cv2.destroyAllWindows()
        print(f'\nTotal samples par classe : {self.counts}')


# ───────────────────────────────────────────────────────────────────────
# Mode 2 : Ground truth annotation
# ───────────────────────────────────────────────────────────────────────


class GroundTruthAnnotator:
    """Annote frame par frame la position réelle des joueurs sur la minimap.

    Output : JSON au format players_tracks (compatible avec celui généré par
    analyze_video.py), utilisable comme source de vérité pour benchmarker
    l'algo de tracking automatique. Une entry par numéro joueur, history
    triée par t avec coords normalisées (fraction 0..1 du template minimap).
    """

    def __init__(self, video_path: str, map_name: str, output_path: str,
                 step_s: float = 1.0):
        self.video_path = video_path
        self.map_name = map_name
        self.output_path = output_path
        self.step_s = step_s

        self.cap = cv2.VideoCapture(video_path)
        if not self.cap.isOpened():
            raise RuntimeError(f'cannot open {video_path}')
        self.fps = self.cap.get(cv2.CAP_PROP_FPS) or 30
        self.duration = self.cap.get(cv2.CAP_PROP_FRAME_COUNT) / self.fps

        # Box minimap + scale (template-px ↔ ROI-px).
        self.box = None
        self.scale = 1.0
        self._locate_minimap()

        # Taille du template minimap (pour normaliser en fraction 0..1).
        md = _map_metadata.load(map_name)
        self.template_w, self.template_h = md['size']

        self.ts = 0.0
        self.active_digit: Optional[int] = None  # None | 0..9
        self.last_label_msg = ''

        # Index par (team, number) → liste triée par t de (t, x_template, y_template).
        # Stockage en coords TEMPLATE (px) → on normalise au moment d'écrire le JSON.
        self.tracks: dict = {}
        self._load_existing()

        # État UI : cache du ROI courant (évite un seek vidéo par MOUSEMOVE
        # pendant le drag), entry en cours de drag, dirty-flag pour piloter
        # le re-render dans la boucle non-bloquante.
        self._roi_cache: Optional[np.ndarray] = None
        self._cached_ts: Optional[float] = None
        self.drag: Optional[Tuple[str, int]] = None  # (team, digit) en cours de drag
        self.dirty = True


    # ─── Init ──────────────────────────────────────────────────────────

    def _locate_minimap(self) -> None:
        mid_ts = self.duration / 2.0
        self.cap.set(cv2.CAP_PROP_POS_MSEC, mid_ts * 1000)
        ok, seed = self.cap.read()
        if not ok:
            raise RuntimeError(f'cannot read seed frame at t={mid_ts:.1f}s')
        info = _minimap.find_minimap_box(seed, self.map_name, min_score=0.0)
        if info is None:
            raise RuntimeError(f'minimap not found for map={self.map_name}')
        self.box = info['box']
        self.scale = float(info.get('scale', 1.0)) or 1.0
        (x1, y1), (x2, y2) = self.box
        print(f'minimap box=({x1},{y1})-({x2},{y2}) score={info["score"]:.2f} '
              f'scale={self.scale:.2f}')

    def _load_existing(self) -> None:
        """Charge un JSON déjà annoté pour reprendre l'annotation où on l'a laissée."""
        if not os.path.isfile(self.output_path):
            return
        try:
            with open(self.output_path, 'r') as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            print(f'warn: cannot load {self.output_path}: {e}')
            return
        for t in data.get('players_tracks', []):
            key = (t['team'], int(t['number']))
            # Reconvertit fraction → template px.
            history = []
            for entry in t.get('history', []):
                ts, xf, yf = entry[0], entry[1], entry[2]
                history.append((float(ts),
                                float(xf) * self.template_w,
                                float(yf) * self.template_h))
            self.tracks[key] = history
        total = sum(len(v) for v in self.tracks.values())
        print(f'loaded {total} existing annotations from {self.output_path}')

    # ─── Frame loading & rendering ─────────────────────────────────────

    def _get_roi(self) -> Optional[np.ndarray]:
        # Cache : le seek + read vidéo est lent et serait appelé à chaque
        # MOUSEMOVE pendant le drag. Invalidé dans _advance().
        if self._cached_ts is not None and abs(self._cached_ts - self.ts) < 1e-9:
            return self._roi_cache
        self.cap.set(cv2.CAP_PROP_POS_MSEC, self.ts * 1000)
        ok, frame = self.cap.read()
        if not ok:
            return None
        (x1, y1), (x2, y2) = self.box
        self._roi_cache = frame[y1:y2, x1:x2]
        self._cached_ts = self.ts
        return self._roi_cache

    def _find_marker_at(self, wx: int, wy: int, radius: int = 14
                         ) -> Optional[Tuple[str, int]]:
        """Trouve le marqueur le plus proche du point (wx, wy) en window coords.

        Retourne (team, digit) ou None si rien dans le rayon.
        """
        best = None
        best_d2 = radius * radius + 1
        for (team, digit, xt, yt) in self._entries_at_ts():
            mwx = xt * self.scale * _DISPLAY_UPSCALE
            mwy = yt * self.scale * _DISPLAY_UPSCALE
            d2 = (wx - mwx) ** 2 + (wy - mwy) ** 2
            if d2 < best_d2:
                best = (team, digit)
                best_d2 = d2
        return best

    def _entries_at_ts(self) -> list:
        """Retourne les entries (team, digit, x_template, y_template) au ts courant."""
        out = []
        for (team, digit), history in self.tracks.items():
            for (t, xt, yt) in history:
                if abs(t - self.ts) < 1e-6:
                    out.append((team, digit, xt, yt))
                    break
        return out

    def _render(self, roi: np.ndarray) -> np.ndarray:
        big = cv2.resize(
            roi, (roi.shape[1] * _DISPLAY_UPSCALE, roi.shape[0] * _DISPLAY_UPSCALE),
            interpolation=cv2.INTER_NEAREST)

        # Marqueurs des entries existantes au ts courant. Couleur unique vive
        # (#00FF00) pour max contraste vs minimap (l'identité team/numero est
        # déjà dans le digit affiché à côté).
        marker_color = (0, 255, 0)
        for (team, digit, xt, yt) in self._entries_at_ts():
            # template px → ROI px → window px.
            wx = int(xt * self.scale * _DISPLAY_UPSCALE)
            wy = int(yt * self.scale * _DISPLAY_UPSCALE)
            cv2.circle(big, (wx, wy), 14, marker_color, 2, cv2.LINE_AA)
            cv2.putText(big, str(digit), (wx + 16, wy + 6),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, marker_color, 2, cv2.LINE_AA)

        # HUD.
        h, w = big.shape[:2]
        hud = np.zeros((50, w, 3), dtype=np.uint8)
        active = 'NONE' if self.active_digit is None else (
            f'{self.active_digit} ({_TEAM_BY_DIGIT[self.active_digit]})')
        total = sum(len(v) for v in self.tracks.values())
        n_here = len(self._entries_at_ts())
        hud_line1 = (f't={self.ts:6.2f}s / {self.duration:.0f}s  '
                     f'actif: {active}  '
                     f'cette frame: {n_here}/10  '
                     f'total entries: {total}')
        counts_str = ' '.join(
            f'{d}:{sum(1 for k in self.tracks if k[1] == d)}'
            for d in range(10))
        hud_line2 = f'numeros avec >=1 entry:  {counts_str}'
        cv2.putText(hud, hud_line1, (8, 18),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1, cv2.LINE_AA)
        cv2.putText(hud, hud_line2, (8, 38),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.4, (180, 180, 180), 1, cv2.LINE_AA)
        if self.last_label_msg:
            cv2.putText(big, self.last_label_msg, (8, 20),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1, cv2.LINE_AA)
        return np.vstack([big, hud])

    # ─── Actions ───────────────────────────────────────────────────────

    def _on_mouse(self, event, x, y, flags, param) -> None:
        if event == cv2.EVENT_RBUTTONDOWN:
            # Clic droit sur un marqueur existant → supprime cette annotation.
            found = self._find_marker_at(x, y)
            if found is None:
                return
            team, digit = found
            history = self.tracks.get((team, digit), [])
            for i, (t, _, _) in enumerate(history):
                if abs(t - self.ts) < 1e-6:
                    history.pop(i)
                    if not history:
                        self.tracks.pop((team, digit), None)
                    self.last_label_msg = f'delete {team} #{digit}'
                    self._save()
                    self.dirty = True
                    return
        elif event == cv2.EVENT_LBUTTONDOWN:
            # 1) Si un marqueur existant est sous le curseur → drag start
            #    (peu importe le digit actif : on devine team/digit du marqueur).
            found = self._find_marker_at(x, y)
            if found is not None:
                self.drag = found
                self.last_label_msg = f'drag {found[0]} #{found[1]}'
                self.dirty = True
                return
            # 2) Sinon, pose un nouveau marqueur. Digit choisi :
            #    - active_digit s'il est sélectionné (override manuel)
            #    - sinon → CNN auto-classification du crop autour du clic
            xt, yt = self._window_to_template(x, y)
            if not (0 <= xt < self.template_w and 0 <= yt < self.template_h):
                self.last_label_msg = 'click hors minimap, ignore'
                self.dirty = True
                return
            # Sans active_digit, on demarre la sequence a 1. Sinon, on utilise
            # le digit actif puis on avance pour le prochain clic.
            digit = self.active_digit
            if digit is None:
                digit = _AUTO_DIGIT_SEQUENCE[0]
            team = _TEAM_BY_DIGIT[digit]
            key = (team, digit)
            history = self.tracks.setdefault(key, [])
            for i, (t, _, _) in enumerate(history):
                if abs(t - self.ts) < 1e-6:
                    history[i] = (self.ts, xt, yt)
                    self.last_label_msg = f'maj {team} #{digit}'
                    break
            else:
                history.append((self.ts, xt, yt))
                history.sort(key=lambda e: e[0])
                self.last_label_msg = f'pose {team} #{digit}'
            # Avance le digit actif pour le prochain clic.
            self.active_digit = self._advance_in_sequence(digit)
            self._save()
            self.dirty = True

        elif event == cv2.EVENT_MOUSEMOVE:
            if self.drag is None:
                return
            xt, yt = self._window_to_template(x, y)
            # Pendant le drag on clamp dans la minimap au lieu d'ignorer
            # (sinon la pastille reste collée à la dernière position valide).
            xt = max(0.0, min(self.template_w - 1, xt))
            yt = max(0.0, min(self.template_h - 1, yt))
            team, digit = self.drag
            history = self.tracks.get((team, digit), [])
            for i, (t, _, _) in enumerate(history):
                if abs(t - self.ts) < 1e-6:
                    history[i] = (self.ts, xt, yt)
                    self.dirty = True
                    break

        elif event == cv2.EVENT_LBUTTONUP:
            if self.drag is not None:
                team, digit = self.drag
                self.drag = None
                self.last_label_msg = f'drop {team} #{digit}'
                self._save()
                self.dirty = True

    def _window_to_template(self, x: int, y: int) -> Tuple[float, float]:
        """Convertit (window px) → (template px)."""
        cx_roi = x / _DISPLAY_UPSCALE
        cy_roi = y / _DISPLAY_UPSCALE
        return cx_roi / self.scale, cy_roi / self.scale

    def _advance_in_sequence(self, digit: int) -> Optional[int]:
        """Retourne le digit suivant apres `digit` dans _AUTO_DIGIT_SEQUENCE.

        Si `digit` est en fin de séquence ou hors séquence (ex: 5), retourne
        None → la séquence s'arrête, l'utilisateur doit retaper une touche
        pour reprendre.
        """
        if digit in _AUTO_DIGIT_SEQUENCE:
            i = _AUTO_DIGIT_SEQUENCE.index(digit)
            if i + 1 < len(_AUTO_DIGIT_SEQUENCE):
                return _AUTO_DIGIT_SEQUENCE[i + 1]
        return None

    def _undo(self) -> None:
        """Supprime l'entry pour active_digit au ts courant."""
        if self.active_digit is None:
            return
        team = _TEAM_BY_DIGIT[self.active_digit]
        key = (team, self.active_digit)
        history = self.tracks.get(key, [])
        for i, (t, _, _) in enumerate(history):
            if abs(t - self.ts) < 1e-6:
                history.pop(i)
                if not history:
                    self.tracks.pop(key, None)
                self.last_label_msg = f'undo {team} #{self.active_digit}'
                self._save()
                self.dirty = True
                return
        self.last_label_msg = f'pas d entry a undo pour {team} #{self.active_digit}'
        self.dirty = True

    def _advance(self, delta_s: float) -> None:
        new_ts = max(0.0, min(self.duration, self.ts + delta_s))
        if new_ts == self.ts:
            return
        self.ts = new_ts
        self.last_label_msg = ''
        # Invalide le cache ROI et annule un éventuel drag en cours.
        self._cached_ts = None
        self._roi_cache = None
        self.drag = None
        self.dirty = True

    def _save(self) -> None:
        """Écrit le JSON au format players_tracks (coords normalisées 0..1)."""
        tracks_out = []
        for (team, digit), history in sorted(self.tracks.items()):
            # `slot` 1..10 (slot 10 → digit 0), aligné avec player_identifier.
            slot = digit if digit != 0 else 10
            tracks_out.append({
                'team': team,
                'number': digit,
                'slot': slot,
                'history': [
                    [round(t, 3),
                     round(xt / self.template_w, 5),
                     round(yt / self.template_h, 5)]
                    for (t, xt, yt) in history
                ],
            })
        payload = {
            'video': os.path.basename(self.video_path),
            'map': self.map_name,
            'template_size': [self.template_w, self.template_h],
            'players_tracks': tracks_out,
        }
        tmp = self.output_path + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(payload, f, indent=2)
        os.replace(tmp, self.output_path)

    # ─── Main loop ─────────────────────────────────────────────────────

    def run(self) -> None:
        win = 'ground_truth'
        cv2.namedWindow(win, cv2.WINDOW_AUTOSIZE)
        cv2.setMouseCallback(win, self._on_mouse)
        print()
        print('Mode : ground truth')
        print(f'Output : {self.output_path}')
        print(f'Step temporel : {self.step_s}s')
        print('Contrôles :')
        print('  0-9      : reset le digit actif a ce numero (interrompt la sequence auto)')
        print('  click    : pose le digit actif, puis avance dans la sequence')
        print('             1 → 2 → 3 → 4 → 6 → 7 → 8 → 9 → 0 → (stop)')
        print('             Sans digit actif, demarre a 1.')
        print('  drag     : deplace un marqueur existant (cliquer dessus + bouger + lacher)')
        print('  right-click : supprime le marqueur sous le curseur (a ce ts)')
        print('  z        : undo l entry du joueur actif au ts courant')
        print(f'  → / d    : frame +{self.step_s}s')
        print(f'  ← / a    : frame -{self.step_s}s')
        print('  ↑ / w    : frame +15s')
        print('  ↓ / s    : frame -15s')
        print('  SPACE    : frame +0.1s (fine)')
        print('  q / ESC  : quitter (auto-save)')
        print()

        # Boucle non-bloquante (waitKey 20 ms) pour que les MOUSEMOVE du drag
        # rafraichissent l'affichage en temps reel. Re-render uniquement si
        # le state a change (dirty-flag).
        while True:
            roi = self._get_roi()
            if roi is None:
                print(f'cannot read frame at t={self.ts:.1f}s')
                break
            if self.dirty:
                display = self._render(roi)
                cv2.imshow(win, display)
                self.dirty = False
            key = cv2.waitKeyEx(20)
            # Fenetre fermee via le bouton X → on quitte.
            try:
                if cv2.getWindowProperty(win, cv2.WND_PROP_VISIBLE) < 1:
                    break
            except cv2.error:
                break
            if key == -1:
                continue  # idle tick, pas de touche
            if key == ord('q') or key == 27:
                break
            if ord('0') <= key <= ord('9'):
                self.active_digit = key - ord('0')
                team = _TEAM_BY_DIGIT[self.active_digit]
                self.last_label_msg = f'actif = {team} #{self.active_digit}'
                self.dirty = True
            elif key == ord('z'):
                self._undo()
            elif key in _KEY_RIGHT or key == ord('d'):
                self._advance(self.step_s)
            elif key in _KEY_LEFT or key == ord('a'):
                self._advance(-self.step_s)
            elif key in _KEY_UP or key == ord('w'):
                self._advance(_BIG_STEP_S)
            elif key in _KEY_DOWN or key == ord('s'):
                self._advance(-_BIG_STEP_S)
            elif key == ord(' '):
                self._advance(_FINE_STEP_S)

        self.cap.release()
        cv2.destroyAllWindows()
        self._save()
        total = sum(len(v) for v in self.tracks.values())
        print(f'\nground truth sauvee dans {self.output_path} ({total} entries)')


# ───────────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('video_path')
    parser.add_argument('map_name')
    parser.add_argument('--truth', metavar='OUT_JSON',
                        help='active le mode ground truth, ecrit le JSON ici')
    parser.add_argument('--step', type=float, default=1.0,
                        help='pas temporel en secondes (mode --truth, defaut 1.0)')
    args = parser.parse_args()

    if args.truth:
        annotator = GroundTruthAnnotator(args.video_path, args.map_name,
                                          args.truth, step_s=args.step)
        annotator.run()
    else:
        cropper = ManualCropper(args.video_path, args.map_name)
        cropper.run()


if __name__ == '__main__':
    main()
