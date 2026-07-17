# Copyright (c) 2026, Antoine Duval
# This file is part of a source-visible project.
# See LICENSE for terms. Unauthorized use is prohibited.

"""Détection « point capturable » sur la minimap.

Un point capturable est rendu avec une bordure blanche et un fond blanc
translucide : ses pixels sont quasi achromatiques ET nettement plus lumineux
que le voisinage immédiat de la zone. Un point possédé par une équipe a un
fond couleur équipe (saturé) ; un point désactivé n'est pas rendu du tout —
les deux comptent comme NON capturable.

La décision se prend au niveau pixel — `frac_active` = fraction de l'intérieur
du polygone qui est « fond blanc actif » — pour rester robuste aux pastilles
joueurs qui couvrent une partie (parfois large) de la zone : elles retirent
des pixels du numérateur sans polluer la mesure des autres.

Seuils calibrés sur le dataset annoté (196 frames × 3 maps, 2026-07-17) plus
4 screenshots « délavés » (minimap semi-transparente sur scène très lumineuse,
qui compresse le contraste local — d'où le critère à 3 conditions détaillé
ci-dessous). Géométrie : `map_metadata.load(...)['capture_points']`
(polygones en pixels template), projetée via `minimap.find_minimap_box`.
Dans le pipeline, `analyze_video` ajoute deux fiabilisations d'ordre métier :
exclusivité Outlaw (EXCLUSIVE_MAPS) et veto « possédé » via la jauge HUD.

Source de vérité unique du critère — consommé par `analyze_video.py`
(timeline `points_capturable`). Le harnais d'évaluation sur dataset annoté
(`benchmark_capture_state.py`) vit hors repo, à côté du dataset
(`~/Desktop/points-dataset/`).
"""

import cv2
import numpy as np

# Maps où la détection est activée (points parfois inactifs selon la phase de
# jeu). Sur les autres maps, l'état des points est constant → pas de timeline.
CAPTURABLE_MAPS = ('Atlantis', 'Outlaw', 'Horizon')

# Maps où AU PLUS UN point est capturable à la fois (Hardpoint) : si plusieurs
# zones passent le seuil sur une frame, seule la meilleure est retenue.
EXCLUSIVE_MAPS = ('Outlaw',)

# Pixel « fond blanc actif » : achromatique ET plus clair que la médiane V de
# l'anneau extérieur d'au moins PIXEL_LIFT_MIN (référence locale → insensible
# à la luminosité du fond de map).
PIXEL_S_MAX = 40
PIXEL_LIFT_MIN = 35
# Décision à deux étages :
#   - frac ≥ FRAC_TRUST : plus d'un tiers de la zone est « fond blanc actif »
#     — aucun inactif du dataset n'a jamais dépassé 0.227 (structures claires
#     du décor comprises) → capturable, sans autre condition. Nécessaire pour
#     les vidéos surexposées où l'anneau de référence est lui-même strié de
#     blanc (lift_p25 aveugle) mais où le fond blanc reste massif.
#   - sinon, zone faiblement blanche (délavée) : trois conditions cumulatives.
#       1. frac ≥ FRAC_ACTIVE_MIN — actifs délavés mesurés dès 0.20 ;
#       2. lift_p25 ≥ LIFT_P25_MIN — le fond blanc translucide soulève TOUT
#          l'intérieur, donc même son quartile sombre dépasse celui de
#          l'anneau (+32 à +99 mesurés). Les structures claires qui traversent
#          une zone inactive laissent ses pixels sombres sombres (≤ +2) —
#          c'est ce qui les écarte malgré une frac parfois haute ;
#       3. nonactive_s ≤ NONACTIVE_S_MAX — le fond hors pixels actifs n'est
#          pas saturé : écarte une zone possédée couleur équipe sur laquelle
#          une grosse pastille joueur blanche gonfle frac et lift (mesuré :
#          frac 0.22 / S 140, contre S ≤ 119 pour les actifs délavés faibles).
FRAC_ACTIVE_MIN = 0.15
LIFT_P25_MIN = 25
FRAC_TRUST = 0.35
NONACTIVE_S_MAX = 130

# Épaisseur (px template) de l'anneau de bordure exclu de l'intérieur (la
# ligne blanche compterait comme « fond actif » sur les petites zones), et
# taille de l'anneau extérieur de référence.
BORDER_THICKNESS_TPL = 3
OUTSIDE_RING_TPL = 12


def project_polygon(poly, box, scale_x: float, scale_y: float) -> np.ndarray:
    """Polygone en pixels template → pixels frame (via la box full-template)."""
    (bx1, by1), _ = box
    return np.array(
        [[bx1 + x * scale_x, by1 + y * scale_y] for x, y in poly],
        dtype=np.int32,
    )


def point_features(frame_hsv, poly_frame, border_px: int, outside_px: int) -> dict:
    """Features d'un polygone projeté : {'frac', 'lift_p25', 'nonactive_s', 'v_ref'}.

    `frame_hsv` : frame en HSV. Seuls S et V sont lus — identiques que la
    conversion vienne de RGB2HSV ou BGR2HSV (ne PAS utiliser H ici).
    """
    h, w = frame_hsv.shape[:2]
    mask_fill = np.zeros((h, w), dtype=np.uint8)
    cv2.fillPoly(mask_fill, [poly_frame], 255)
    mask_border = np.zeros((h, w), dtype=np.uint8)
    cv2.polylines(mask_border, [poly_frame], isClosed=True, color=255,
                  thickness=border_px)
    mask_inner = cv2.subtract(mask_fill, mask_border)
    kernel = np.ones((outside_px, outside_px), dtype=np.uint8)
    mask_outside = cv2.subtract(cv2.dilate(mask_fill, kernel), mask_fill)

    s = frame_hsv[:, :, 1]
    v = frame_hsv[:, :, 2]
    inner_sel = mask_inner > 0
    outside_sel = mask_outside > 0
    if not inner_sel.any() or not outside_sel.any():
        return {'frac': 0.0, 'lift_p25': -255.0, 'nonactive_s': 255.0, 'v_ref': 255.0}
    v_ref = float(np.median(v[outside_sel]))
    active = (s[inner_sel] <= PIXEL_S_MAX) & (v[inner_sel] >= v_ref + PIXEL_LIFT_MIN)
    nonactive = ~active
    return {
        'frac': float(np.count_nonzero(active)) / int(inner_sel.sum()),
        'lift_p25': float(np.percentile(v[inner_sel], 25))
        - float(np.percentile(v[outside_sel], 25)),
        'nonactive_s': float(np.median(s[inner_sel][nonactive])) if nonactive.any() else 0.0,
        'v_ref': v_ref,
    }


def classify(feat: dict) -> bool:
    if feat['frac'] >= FRAC_TRUST:
        return True
    return (
        feat['frac'] >= FRAC_ACTIVE_MIN
        and feat['lift_p25'] >= LIFT_P25_MIN
        and feat['nonactive_s'] <= NONACTIVE_S_MAX
    )


def detect_frame(frame_hsv, polys_by_letter: dict, scale_x: float,
                 exclusive: bool = False) -> dict:
    """État capturable de chaque point sur une frame.

    Args:
        frame_hsv:       frame HSV complète (cf. note S/V de point_features).
        polys_by_letter: {letter: polygone projeté en px frame (np.int32)}.
        scale_x:         échelle template→frame (dimensionne les anneaux).
        exclusive:       au plus un point capturable (EXCLUSIVE_MAPS) — si
                         plusieurs passent le seuil, seul le meilleur reste.

    Returns:
        {letter: bool}
    """
    border_px = max(2, int(round(BORDER_THICKNESS_TPL * scale_x)))
    outside_px = max(4, int(round(OUTSIDE_RING_TPL * scale_x)))
    feats = {
        letter: point_features(frame_hsv, poly, border_px, outside_px)
        for letter, poly in polys_by_letter.items()
    }
    states = {letter: classify(f) for letter, f in feats.items()}
    if exclusive and sum(states.values()) > 1:
        best = max((f['frac'], letter) for letter, f in feats.items())[1]
        states = {letter: letter == best for letter in states}
    return states
