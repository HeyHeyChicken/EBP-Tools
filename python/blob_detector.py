# Copyright (c) 2026, Antoine Duval
# This file is part of a source-visible project.
# See LICENSE for terms. Unauthorized use is prohibited.

"""Détection des blobs joueurs sur la minimap (Layer 1 du player tracking).

Pour chaque équipe, on cherche les **chiffres noirs** présents à l'intérieur
ou au bord d'une zone team color. Chaque chiffre = 1 joueur. Cette approche
fonctionne uniformément :
- Hors spawn : pastille = disque coloré + chiffre noir au centre
- Dans spawn : zone team color saturée + chiffres noirs des joueurs présents
  (séparables tant que les chiffres ne se superposent pas pixel à pixel)

Avantage vs détection par "centre de pastille via distance transform" : dans
le spawn, la team color forme UN seul gros blob → le DT n'aurait qu'un seul
pic au centroïde, ratant les joueurs individuels. Les chiffres restent
distincts car ils sont positionnellement séparés.

Sortie : coordonnées en pixels du TEMPLATE de la map (indépendant du `scale`
de rendu à l'écran). Layer 2 consomme ces positions sans transformation.

Usage :
    info  = minimap.find_minimap_box(frame_bgr, 'The Cliff')
    blobs = detect_blobs(frame_bgr, info, orange_rgb, blue_rgb)
    # blobs = {'orange': [{'x', 'y', 'strength'}, ...], 'blue': [...]}
"""

import os
import sys
from typing import Optional, Tuple

import cv2
import numpy as np


RGB = Tuple[int, int, int]


# --- HSV team color mask ---
# Hue tol : transparence atténue saturation/luminance mais préserve la teinte.
# Sat/Val mins : la pastille est parfois pâle (anti-aliasing, transparence
# sur fond clair), donc on ne peut pas être trop strict sur sat. C'est
# l'angle HUE qui sépare la team color du sol de la map (le brun a hue
# 0-30, l'orange a hue ~40+). On utilise hue + un sat min modeste comme
# filtre, val_min pour exclure les pixels sombres (qui sont les digits).
_HUE_TOL = 12
_SAT_MIN = 40
_VAL_MIN = 80

# --- Détection de pixels "digit" ---
# Un chiffre se manifeste comme un pixel :
#   - DARK (hors-spawn) : V < 80 → chiffre noir sur fond clair (pastille
#     standard avec disque coloré dilué)
#   - BRIGHT non-saturé (dans spawn) : V > 200 ET S < 60 → chiffre blanc
#     sur fond team color saturé
# Et qui est dans la "zone team color" (proche d'au moins 1 pixel team color).
# On dilate le mask team color pour définir cette zone.
_DARK_V_MAX = 80
_BRIGHT_V_MIN = 200
_BRIGHT_S_MAX = 60
_TEAM_ZONE_DILATE = 11    # rayon ≈ 5 px → couvre pastille même patchy

# --- Filtre composante digit ---
_DIGIT_AREA_MIN = 2
_DIGIT_AREA_MAX = 100
_DIGIT_DIM_MIN = 2
_DIGIT_DIM_MAX = 14
_DEDUP_PX = 6             # 2 candidats < 6 px d'écart = même digit


def _color_mask(roi_bgr: np.ndarray, target_rgb: RGB) -> np.ndarray:
    """Masque binaire HSV pour la couleur d'équipe (transparence-friendly)."""
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


def _digit_centroids_in_zone(roi_bgr: np.ndarray,
                              color_mask: np.ndarray) -> list:
    """Centres des chiffres dans la zone team color (dilatée).

    Détection directe par pixel :
      - Pixel "digit" = DARK (chiffre noir hors-spawn) OU BRIGHT-non-team
        (chiffre blanc sur fond team color saturé en spawn)
      - ET dans la zone team color dilatée (proche d'au moins 1 pixel team)
      - ET pas team color lui-même

    Marche pour TOUS les chiffres (boucle interne ou pas — contrairement à
    RETR_CCOMP qui ne voit que les 0, 6, 8, 9).

    Retourne une liste de (cx, cy, area) en pixels du ROI.
    """
    hsv = cv2.cvtColor(roi_bgr, cv2.COLOR_BGR2HSV)
    v = hsv[..., 2]
    s = hsv[..., 1]

    dark = v < _DARK_V_MAX
    bright = (v > _BRIGHT_V_MIN) & (s < _BRIGHT_S_MAX)
    digit_pixels = (dark | bright) & (color_mask == 0)

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE,
                                        (_TEAM_ZONE_DILATE, _TEAM_ZONE_DILATE))
    team_zone = cv2.dilate(color_mask, kernel)
    candidates = digit_pixels & (team_zone > 0)
    candidates_mask = candidates.astype(np.uint8) * 255

    n, _, stats, centroids = cv2.connectedComponentsWithStats(
        candidates_mask, connectivity=8)
    raw = []
    for i in range(1, n):
        area = int(stats[i, cv2.CC_STAT_AREA])
        bw = int(stats[i, cv2.CC_STAT_WIDTH])
        bh = int(stats[i, cv2.CC_STAT_HEIGHT])
        if not (_DIGIT_AREA_MIN <= area <= _DIGIT_AREA_MAX):
            continue
        if not (_DIGIT_DIM_MIN <= bw <= _DIGIT_DIM_MAX
                and _DIGIT_DIM_MIN <= bh <= _DIGIT_DIM_MAX):
            continue
        cx, cy = centroids[i]
        raw.append((float(cx), float(cy), area))

    return _merge_close_holes(raw)


def _merge_close_holes(holes: list) -> list:
    """Fusionne les holes à < _DEDUP_PX d'écart. Garde la position du plus gros,
    somme les aires. Une passe simple par voisin (O(N²), N≤~20)."""
    if not holes:
        return []
    holes = sorted(holes, key=lambda h: -h[2])  # plus gros d'abord
    kept = []
    used = [False] * len(holes)
    for i, (cx, cy, area) in enumerate(holes):
        if used[i]:
            continue
        used[i] = True
        total_area = area
        for j in range(i + 1, len(holes)):
            if used[j]:
                continue
            dx, dy = holes[j][0] - cx, holes[j][1] - cy
            if dx * dx + dy * dy < _DEDUP_PX * _DEDUP_PX:
                used[j] = True
                total_area += holes[j][2]
        kept.append((cx, cy, total_area))
    return kept


def detect_blobs(
    frame_bgr: np.ndarray,
    minimap_info: dict,
    orange_rgb: Optional[RGB],
    blue_rgb: Optional[RGB],
) -> dict:
    """Détecte les positions des joueurs vivants sur la minimap.

    Args:
        frame_bgr:    image BGR (typiquement 1080×1920).
        minimap_info: dict {'box': ((x1,y1),(x2,y2)), 'scale': float}.
                      Sortie typique de `minimap.find_minimap_box`.
        orange_rgb:   couleur résolue de l'équipe orange. None → skip team.
        blue_rgb:     couleur résolue de l'équipe bleue. None → skip team.

    Returns:
        dict {
          'orange': [{'x', 'y', 'strength'}, ...],
          'blue':   [{'x', 'y', 'strength'}, ...]
        }
        x, y en pixels TEMPLATE (rescalés par minimap_info['scale']).
        strength = aire du chiffre détecté (proxy de confiance).
    """
    (x1, y1), (x2, y2) = minimap_info['box']
    scale = float(minimap_info.get('scale', 1.0)) or 1.0
    roi = frame_bgr[y1:y2, x1:x2]
    out = {'orange': [], 'blue': []}
    if roi.size == 0:
        return out

    for team, color in (('orange', orange_rgb), ('blue', blue_rgb)):
        if color is None:
            continue
        cmask = _color_mask(roi, color)
        for cx, cy, area in _digit_centroids_in_zone(roi, cmask):
            out[team].append({
                'x':        cx / scale,
                'y':        cy / scale,
                'strength': area,
            })
    return out


# ─── Debug visuel ──────────────────────────────────────────────────────────

def _render_debug(frame_bgr: np.ndarray, minimap_info: dict,
                   blobs: dict, out_path: str) -> None:
    """Overlay des blobs détectés sur le crop minimap, upscale ×3."""
    (x1, y1), (x2, y2) = minimap_info['box']
    scale = float(minimap_info.get('scale', 1.0)) or 1.0
    roi = frame_bgr[y1:y2, x1:x2].copy()
    up = 3
    big = cv2.resize(roi, (roi.shape[1] * up, roi.shape[0] * up),
                     interpolation=cv2.INTER_NEAREST)
    for team, color_bgr in (('orange', (0, 165, 255)),
                            ('blue',   (255, 165, 0))):
        for b in blobs[team]:
            # blob coords sont en template px → re-scale en ROI px → x up
            px = int(b['x'] * scale * up)
            py = int(b['y'] * scale * up)
            cv2.circle(big, (px, py), 10, color_bgr, 2)
            cv2.putText(big, f'{int(b["strength"])}',
                        (px + 12, py + 4),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.4, color_bgr, 1)
    cv2.imwrite(out_path, big)


def main() -> None:
    if len(sys.argv) < 5:
        print('Usage: blob_detector.py <frame.png> <map_name> '
              '<orange_rgb> <blue_rgb>')
        print('       <orange_rgb> format: R,G,B  (e.g. 144,220,80)')
        sys.exit(1)
    frame_path = sys.argv[1]
    map_name = sys.argv[2]
    orange_rgb = tuple(int(c) for c in sys.argv[3].split(','))
    blue_rgb = tuple(int(c) for c in sys.argv[4].split(','))

    import minimap as _minimap
    frame = cv2.imread(frame_path)
    if frame is None:
        print(f'!! cannot read {frame_path}')
        sys.exit(1)
    info = _minimap.find_minimap_box(frame, map_name, min_score=0.0)
    if info is None:
        print(f'!! minimap not found for {map_name}')
        sys.exit(1)
    print(f'minimap box={info["box"]} score={info["score"]:.2f} '
          f'scale={info["scale"]:.2f}')
    blobs = detect_blobs(frame, info, orange_rgb, blue_rgb)
    for team in ('orange', 'blue'):
        print(f'{team}: {len(blobs[team])} blobs')
        for b in sorted(blobs[team], key=lambda x: (x['y'], x['x'])):
            print(f'  ({b["x"]:5.1f}, {b["y"]:5.1f}) strength={b["strength"]}')
    base = os.path.splitext(os.path.basename(frame_path))[0]
    out = f'/tmp/{base}_blobs.png'
    _render_debug(frame, info, blobs, out)
    print(f'debug overlay → {out}')


if __name__ == '__main__':
    main()
