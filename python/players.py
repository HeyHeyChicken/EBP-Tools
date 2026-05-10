# Copyright (c) 2026, Antoine Duval
# This file is part of a source-visible project.
# See LICENSE for terms. Unauthorized use is prohibited.

"""Détection et identification des joueurs sur la minimap.

Étape 2.2 : pour une frame donnée et la box minimap localisée par le
module `minimap`, retourne la liste des joueurs détectés sous forme
`{team, number, x_pct, y_pct, confidence}`.

Pipeline :
  1. Mask HSV par couleur d'équipe résolue (cf. `_resolve_team_colors`).
  2. Génération de candidats par DEUX méthodes complémentaires :
       a. Pics de distance transform → pastilles isolées et groupes.
       b. Chiffres noirs entourés de couleur → pastilles posées sur un
          spawn (joueur "caché").
  3. Pour chaque candidat, classification du chiffre via un MLP
     scikit-learn entraîné (cf. train_digits.py). Le modèle a 11 classes
     (chiffres 0-9 + "garbage"). Un candidat classé "garbage" ou avec
     confiance < seuil est écarté → filtre mécanique pour :
       - Croix de mort (pas de chiffre lisible)
       - Pics multiples sur les bords des spawns
       - Bords/portes/téléporteurs colorés accidentellement
       - Halos divers

Couleurs d'équipe :
    Les couleurs varient (orange/bleu, vert/violet, jaune-fluo/bleu-fluo
    en pro league). On reçoit les couleurs RÉSOLUES par
    `_resolve_team_colors` — une seule paire (R,G,B) par équipe.

API :
    find_players(frame_bgr, minimap_box, orange_rgb, blue_rgb)
        -> list[{team, number, x_pct, y_pct, confidence}]
"""

import os
from typing import List, Optional, Tuple

import cv2
import joblib
import numpy as np


RGB = Tuple[int, int, int]

# --- Mask HSV par couleur d'équipe ---
_HUE_TOL = 8
_SAT_MIN = 80
_VAL_MIN = 60

# --- Détection candidats : pics de distance transform (pastilles isolées) ---
# Pastille Ø 14-22 px → pic dt central = rayon 6-11. Spawn (50 px+) = pic ≈ 25.
_PEAK_MIN = 4
_PEAK_MAX = 13
_PEAK_NMS = 12
_CLOSE_KERNEL = 5

# --- Détection candidats : chiffres noirs en zone colorée (joueur caché) ---
_DARK_V_MAX = 80
_DARK_S_MAX = 100
_DARK_AREA_MIN = 6
_DARK_AREA_MAX = 90
_DARK_DIM_MIN = 2
_DARK_DIM_MAX = 14
_COLOR_DILATE = 11  # px ; doit déborder de ≥ (rayon pastille - rayon chiffre)

# --- Dédoublonnage des candidats (peak + dark center souvent au même endroit) ---
_DEDUP_DIST = 10.0
# Pas du sliding window (en px du ROI minimap). 6 px = ~rayon d'une pastille,
# garantit qu'on tombe à au plus 3 px du chiffre attendu.
_SLIDING_STEP = 6
# Distance min entre 2 détections finales du même (team, number) — au delà
# c'est probablement une vraie 2e instance, sinon c'est un doublon.
# 25 px ≈ diamètre d'une pastille : 2 détections plus proches que ça
# pointent forcément le même chiffre.
_DEDUP_FINAL_DIST = 25.0

# --- Identification du chiffre via MLP scikit-learn ---
_MODEL_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), 'models', 'digit_mlp.pkl'
)
# Taille d'entrée du modèle (cf. train_digits.IMG_SIZE).
_MODEL_INPUT_SIZE = 21
# Demi-côté du crop natif autour d'un candidat → 21×21 px.
_DIGIT_CROP_HALF = 10
# Label du modèle pour "non-chiffre". Tout candidat classé ainsi est rejeté.
_GARBAGE_LABEL = 10
_DIGIT_CONFIDENCE_MIN = 0.55

# Numéros valides par équipe. En 4v4 standard : orange 1-4, bleu 6-9.
# En 5v5 : orange ajoute 5, bleu ajoute 0 (= joueur 10). On accepte les
# 5 numéros possibles dans les 2 modes — le pipeline reste agnostique.
_DIGITS_BY_TEAM = {
    'orange': frozenset({1, 2, 3, 4, 5}),
    'blue':   frozenset({0, 6, 7, 8, 9}),
}

# Cache du modèle MLP. Chargé paresseusement (1×) à la 1ère prédiction.
_digit_model = None


# ─── Mask couleur ──────────────────────────────────────────────────────────

def _color_mask(roi_bgr: np.ndarray, target_rgb: RGB) -> np.ndarray:
    """Masque HSV : pixels dont la teinte est proche de la cible.

    Plus robuste que RGB strict car la transparence atténue luminance
    et saturation mais conserve la teinte.
    """
    r, g, b = target_rgb
    target_hsv = cv2.cvtColor(np.array([[[b, g, r]]], dtype=np.uint8),
                               cv2.COLOR_BGR2HSV)[0, 0]
    h_target = int(target_hsv[0])

    hsv = cv2.cvtColor(roi_bgr, cv2.COLOR_BGR2HSV)
    h, s, v = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    dh = np.abs(h.astype(np.int16) - h_target)
    dh = np.minimum(dh, 180 - dh)
    mask = (dh <= _HUE_TOL) & (s >= _SAT_MIN) & (v >= _VAL_MIN)
    return mask.astype(np.uint8) * 255


# ─── Génération des candidats (positions à valider par OCR) ────────────────

def _isolated_pastille_centers(mask: np.ndarray) -> List[Tuple[float, float]]:
    """Pics de distance transform → pastilles isolées et groupes."""
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE,
                                        (_CLOSE_KERNEL, _CLOSE_KERNEL))
    filled = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
    dt = cv2.distanceTransform(filled, cv2.DIST_L2, 5)
    dilated = cv2.dilate(dt, np.ones((_PEAK_NMS, _PEAK_NMS), np.uint8))
    peaks_mask = ((dt == dilated)
                  & (dt >= _PEAK_MIN)
                  & (dt <= _PEAK_MAX)).astype(np.uint8)
    _, _, _, centroids = cv2.connectedComponentsWithStats(peaks_mask,
                                                           connectivity=8)
    return [(float(c[0]), float(c[1])) for c in centroids[1:]]


def _dark_centers_in_color(roi_bgr: np.ndarray,
                            color_mask: np.ndarray) -> List[Tuple[float, float]]:
    """Chiffres noirs encerclés de pixels d'équipe → pastilles cachées."""
    hsv = cv2.cvtColor(roi_bgr, cv2.COLOR_BGR2HSV)
    s, v = hsv[:, :, 1], hsv[:, :, 2]
    dark = ((v < _DARK_V_MAX) & (s < _DARK_S_MAX)).astype(np.uint8) * 255
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE,
                                        (_COLOR_DILATE, _COLOR_DILATE))
    color_zone = cv2.dilate(color_mask, kernel)
    candidates = cv2.bitwise_and(dark, color_zone)
    contours, _ = cv2.findContours(candidates, cv2.RETR_EXTERNAL,
                                    cv2.CHAIN_APPROX_SIMPLE)
    out = []
    for c in contours:
        a = cv2.contourArea(c)
        if a < _DARK_AREA_MIN or a > _DARK_AREA_MAX:
            continue
        x, y, bw, bh = cv2.boundingRect(c)
        if (bw < _DARK_DIM_MIN or bh < _DARK_DIM_MIN
                or bw > _DARK_DIM_MAX or bh > _DARK_DIM_MAX):
            continue
        M = cv2.moments(c)
        if M['m00'] == 0:
            continue
        out.append((M['m10'] / M['m00'], M['m01'] / M['m00']))
    return out


def _dedup(points: List[Tuple[float, float]],
           min_dist: float) -> List[Tuple[float, float]]:
    kept: List[Tuple[float, float]] = []
    for p in points:
        if any((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 < min_dist ** 2
                for q in kept):
            continue
        kept.append(p)
    return kept


def _sliding_positions(color_mask: np.ndarray, h: int, w: int,
                        step: int) -> List[Tuple[float, float]]:
    """Liste des centres (x, y) à tester en sliding window.

    On ne teste QUE les positions où la couleur d'équipe est suffisamment
    présente dans le crop autour : ça filtre 95 %+ des positions inutiles
    (zones grises, ciel, fond) sans perdre les pastilles cachées dans un
    spawn (forcément dans une grande zone colorée).
    """
    out = []
    half = _DIGIT_CROP_HALF
    # Seuil minimal de pixels colorés autour du candidate (~10% du crop)
    min_color_px = int(0.10 * (2 * half + 1) ** 2)
    for cy in range(half, h - half, step):
        for cx in range(half, w - half, step):
            sub = color_mask[cy - half:cy + half + 1,
                             cx - half:cx + half + 1]
            if int(sub.sum() // 255) >= min_color_px:
                out.append((float(cx), float(cy)))
    return out


def _dedup_by_identity(detections: List[dict]) -> List[dict]:
    """Garde une seule détection par cluster de même (team, number) proche.

    Quand 2 détections ont les mêmes (team, number) et sont à moins de
    _DEDUP_FINAL_DIST l'une de l'autre, on garde celle de plus haute
    confidence. Les autres sont écartées (typiquement le sliding window
    propose plusieurs positions très voisines pour la même pastille).
    """
    by_key: dict = {}  # (team, number) → list[dict]
    for d in detections:
        by_key.setdefault((d['team'], d['number']), []).append(d)
    kept = []
    for (_team, _num), group in by_key.items():
        # Tri par confidence décroissante : on garde le meilleur de
        # chaque cluster spatial.
        group.sort(key=lambda x: -x['confidence'])
        cluster_centers = []
        for d in group:
            close = any((d['_x'] - cx) ** 2 + (d['_y'] - cy) ** 2
                        < _DEDUP_FINAL_DIST ** 2
                        for cx, cy in cluster_centers)
            if close:
                continue
            cluster_centers.append((d['_x'], d['_y']))
            kept.append({k: v for k, v in d.items() if not k.startswith('_')})
    return kept


# ─── Identification du chiffre via MLP ─────────────────────────────────────

def _load_model():
    """Charge (1×) le MLP entraîné. Renvoie None si le modèle est absent."""
    global _digit_model
    if _digit_model is not None:
        return _digit_model
    if not os.path.isfile(_MODEL_PATH):
        return None
    _digit_model = joblib.load(_MODEL_PATH)
    return _digit_model


def _identify_digit(crop_bgr: np.ndarray,
                     team: str) -> Optional[Tuple[int, float]]:
    """Classifie un crop (BGR, ~21×21) avec le MLP, contraint par équipe.

    On restreint le argmax aux chiffres VALIDES pour cette équipe (orange
    1-5, bleu 0,6-9). Élimine mécaniquement les confusions cross-team
    (ex : modèle hésite "8" vs "9" pour un bleu → reste bleu).

    Sécurité : si la proba du label "garbage" est plus élevée que celle du
    meilleur chiffre allowed, on rejette. Évite de "forcer" un chiffre
    quand le crop ne ressemble à aucun chiffre.

    Returns (digit, confidence) ou None.
    """
    model = _load_model()
    if model is None:
        return None
    gray = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2GRAY)
    if gray.shape != (_MODEL_INPUT_SIZE, _MODEL_INPUT_SIZE):
        gray = cv2.resize(gray, (_MODEL_INPUT_SIZE, _MODEL_INPUT_SIZE),
                          interpolation=cv2.INTER_AREA)
    x = (gray.astype(np.float32) / 255.0).reshape(1, -1)
    proba = model.predict_proba(x)[0]
    classes = list(model.classes_)

    allowed = _DIGITS_BY_TEAM.get(team, frozenset())
    allowed_idx = [i for i, c in enumerate(classes) if int(c) in allowed]
    if not allowed_idx:
        return None
    best_local = int(np.argmax(proba[allowed_idx]))
    best_idx = allowed_idx[best_local]
    label = int(classes[best_idx])
    conf = float(proba[best_idx])

    if _GARBAGE_LABEL in classes:
        garbage_proba = float(proba[classes.index(_GARBAGE_LABEL)])
        if garbage_proba > conf:
            return None

    if conf < _DIGIT_CONFIDENCE_MIN:
        return None
    return (label, conf)


# ─── API publique ──────────────────────────────────────────────────────────

def find_players(
    frame_bgr: np.ndarray,
    minimap_box,
    orange_rgb: Optional[RGB],
    blue_rgb: Optional[RGB],
) -> List[dict]:
    """Détecte et identifie les joueurs dans la box minimap.

    Args:
        frame_bgr:    image BGR (1080×1920 typiquement).
        minimap_box:  ((x1, y1), (x2, y2)) en pixels absolus de la frame.
        orange_rgb:   couleur résolue de l'équipe "orange". None = on saute.
        blue_rgb:     idem pour l'équipe "bleue".

    Returns:
        liste de dicts { 'team': 'orange'|'blue', 'number': int,
                         'x_pct': float [0..1], 'y_pct': float [0..1],
                         'confidence': float }
    """
    (x1, y1), (x2, y2) = minimap_box
    roi = frame_bgr[y1:y2, x1:x2]
    if roi.size == 0:
        return []
    h, w = roi.shape[:2]

    # Union des positions à tester par équipe : centres des candidats
    # (rapide, ciblé) + sliding window à pas serré sur tous les pixels
    # de la couleur d'équipe (récupère les pastilles cachées dans les
    # spawns que la détection ciblée rate). Le MLP discrimine ensuite.
    all_detections = []
    for team_name, color in (('orange', orange_rgb),
                              ('blue',   blue_rgb)):
        if color is None:
            continue
        mask = _color_mask(roi, color)
        targeted = (_isolated_pastille_centers(mask)
                    + _dark_centers_in_color(roi, mask))
        sliding = _sliding_positions(mask, h, w, step=_SLIDING_STEP)
        positions = _dedup(targeted + sliding, _DEDUP_DIST)
        for cx, cy in positions:
            xa = max(0, int(cx) - _DIGIT_CROP_HALF)
            ya = max(0, int(cy) - _DIGIT_CROP_HALF)
            xb = min(w, int(cx) + _DIGIT_CROP_HALF + 1)
            yb = min(h, int(cy) + _DIGIT_CROP_HALF + 1)
            crop = roi[ya:yb, xa:xb]
            ident = _identify_digit(crop, team_name)
            if ident is None:
                continue
            digit, score = ident
            all_detections.append({
                'team':       team_name,
                'number':     digit,
                'x_pct':      cx / w,
                'y_pct':      cy / h,
                'confidence': score,
                '_x':         cx,
                '_y':         cy,
            })

    # Dédoublonnage final : 2 détections de même numéro et même équipe à
    # < _DEDUP_FINAL_DIST → garde celle de meilleure confidence.
    return _dedup_by_identity(all_detections)
