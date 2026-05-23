# Copyright (c) 2026, Antoine Duval
# This file is part of a source-visible project.
# See LICENSE for terms. Unauthorized use is prohibited.

"""Localisation de la minimap dans une frame de gameplay.

Le nom de map est déjà connu (OCR amont, cf. analyze_video.py). On charge
le template correspondant (médiane multi-frame nettoyée des pastilles
joueurs) et on le cherche dans le quart inférieur gauche de la frame, en
testant plusieurs échelles autour de la taille standard.

Le matching se fait sur les **edges** (Canny) plutôt que sur les pixels :
la minimap est semi-transparente, son contenu intérieur varie selon la
scène derrière, mais ses contours (murs, bordures) restent stables.
"""

import os
from typing import Optional, Tuple

import cv2
import numpy as np

import map_metadata as _map_metadata


_TEMPLATES_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), 'templates', 'minimaps'
)

# Map canonique (cf. _MAPS dans analyze_video.py) → filename du template.
_TEMPLATE_FILES = {
    'Artefact':       'artefact.png',
    'Atlantis':       'atlantis.png',
    'Ceres':          'ceres.png',
    'Engine':         'engine.png',
    'Helios Station': 'helios_station.png',
    'Horizon':        'horizon.png',
    'Lunar Outpost':  'lunar_outpost.png',
    'Outlaw':         'outlaw.png',
    'Polaris':        'polaris.png',
    'Silva':          'silva.png',
    'The Cliff':      'the_cliff.png',
    'The Rock':       'the_rock.png',
}

# ROI dans la frame 1920×1080 : quart inférieur gauche, élargi pour absorber
# les marges. La minimap n'apparaît jamais en dehors de cette zone.
# Dimensionné pour accepter les templates les plus grands à scale 1.20
# (≈ 720×450 px max).
_ROI_X1, _ROI_Y1, _ROI_X2, _ROI_Y2 = 0, 580, 800, 1080

# Filets de sécurité sur la box retournée : la minimap est toujours collée
# au bord bas-gauche du HUD. On rejette tout match dont x1 > _MAX_X1 ou
# y2 < _MIN_Y2 — c'est forcément un faux positif (typiquement une zone
# du HUD aux contours qui ressemblent à la minimap).
_MAX_X1 = 100
_MIN_Y2 = 980

# Échelles testées en X et Y independamment. Les enregistrements EVA ont
# parfois une minimap **etiree** (typiquement en Y) selon le ratio de la
# capture. On balaie donc une grille (sx, sy). X reste assez dense autour
# de 1.0 ; Y est plus dense (les stretches Y de 5-10% sont communs).
_SCALES_X = (1.00, 0.99, 1.01, 0.97, 1.03, 0.95, 1.05, 0.90, 1.10, 0.85, 1.15)
_SCALES_Y = (1.00, 0.99, 1.01, 0.98, 1.02, 0.96, 1.04, 0.94, 1.06, 0.92, 1.08,
             0.90, 1.10, 0.85, 1.15, 0.80, 1.20)

# Cache : nom de map → (template_bgr, edges_bgr_par_échelle)
_template_cache: dict = {}


def _load_template(map_name: str) -> Optional[np.ndarray]:
    """Charge (et met en cache) le template BGR pour map_name.

    Le PNG contient le contenu visible (ce qu'on voit en jeu). Les marges
    transparentes "tampon" autour (pour les joueurs qui debordent au bord
    de la map) sont declarees dans le JSON `margins` — single source of
    truth. On les utilise pour reconstruire la box "full" en sortie.

    Backward compat : si un PNG a encore un canal alpha avec des pixels
    transparents (avant migration), on crop a son alpha bbox d'abord. Le
    resultat est equivalent au cas "PNG deja croppe".
    """
    if map_name in _template_cache:
        return _template_cache[map_name]['bgr']
    fn = _TEMPLATE_FILES.get(map_name)
    if fn is None:
        return None
    path = os.path.join(_TEMPLATES_DIR, fn)
    if not os.path.isfile(path):
        return None
    img = cv2.imread(path, cv2.IMREAD_UNCHANGED)
    if img is None:
        return None

    # Backward compat : si alpha present, crop a la bbox non-transparente.
    if img.ndim == 3 and img.shape[2] == 4:
        alpha = img[:, :, 3]
        ys, xs = np.where(alpha > 0)
        if len(xs) == 0:
            return None
        x0, y0 = int(xs.min()), int(ys.min())
        x1 = int(xs.max() + 1)
        y1 = int(ys.max() + 1)
        bgr = img[y0:y1, x0:x1, :3]
    else:
        bgr = img[:, :, :3] if img.ndim == 3 else img

    inner_h, inner_w = bgr.shape[:2]

    # JSON `margins` = source de verite. Offset = (left, top) ; full_size =
    # inner + margins. On verifie que ca matche `size` du JSON (contrat de
    # l'API : md['size'] est la taille du template "full" utilisee pour
    # normaliser les positions joueurs).
    md = _map_metadata.load(map_name)
    if md is None:
        offset = (0, 0)
        full_size = (inner_w, inner_h)
    else:
        m = md.get('margins') or {}
        ml = int(m.get('left', 0))
        mt = int(m.get('top', 0))
        mr = int(m.get('right', 0))
        mb = int(m.get('bottom', 0))
        offset = (ml, mt)
        full_w = inner_w + ml + mr
        full_h = inner_h + mt + mb
        json_size = md.get('size')
        if json_size and (full_w, full_h) != (int(json_size[0]), int(json_size[1])):
            # Si le PNG (apres crop alpha eventuel) + margins ne reconstruit
            # pas la `size` declaree, on fait confiance au JSON et on log.
            print(f"[minimap] {map_name}: size mismatch png+margins=({full_w},"
                  f"{full_h}) vs json={tuple(json_size)} — using json")
            full_w, full_h = int(json_size[0]), int(json_size[1])
        full_size = (full_w, full_h)

    _template_cache[map_name] = {
        'bgr': bgr,
        'offset': offset,
        'full_size': full_size,
        'edges': {},
    }
    return bgr


def _edges(img: np.ndarray) -> np.ndarray:
    """Canny robuste : flou léger + seuils auto basés sur la médiane."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    med = float(np.median(gray))
    lo = int(max(0, 0.66 * med))
    hi = int(min(255, 1.33 * med))
    return cv2.Canny(gray, lo, hi)


def _scaled_template_edges(map_name: str, scale_x: float,
                            scale_y: Optional[float] = None) -> Optional[np.ndarray]:
    """Retourne les edges Canny du template scale (sx, sy). Cache par (sx, sy)."""
    if scale_y is None:
        scale_y = scale_x
    cache = _template_cache.get(map_name)
    if cache is None:
        return None
    key = (round(scale_x, 4), round(scale_y, 4))
    if key in cache['edges']:
        return cache['edges'][key]
    base = cache['bgr']
    h, w = base.shape[:2]
    nw = max(1, int(round(w * scale_x)))
    nh = max(1, int(round(h * scale_y)))
    resized = cv2.resize(base, (nw, nh), interpolation=cv2.INTER_AREA)
    e = _edges(resized)
    cache['edges'][key] = e
    return e


def find_minimap_box(
    frame: np.ndarray,
    map_name: str,
    min_score: float = 0.20,
) -> Optional[dict]:
    """Localise la minimap dans frame.

    Args:
        frame:    image BGR (H, W, 3), typiquement 1080×1920.
        map_name: nom canonique (cf. _TEMPLATE_FILES).
        min_score: seuil minimal de confiance (TM_CCOEFF_NORMED).

    Returns:
        dict { 'box': ((x1, y1), (x2, y2)), 'score': float, 'scale': float }
        en coordonnées absolues de frame, ou None si rien trouvé.
    """
    if _load_template(map_name) is None:
        return None

    # Restreint la recherche à la ROI bas-gauche.
    h, w = frame.shape[:2]
    rx2 = min(_ROI_X2, w)
    ry2 = min(_ROI_Y2, h)
    roi = frame[_ROI_Y1:ry2, _ROI_X1:rx2]
    roi_edges = _edges(roi)

    # Le template cache contient maintenant le crop alpha-bbox (= zone visible)
    # et l'offset/taille du template "full". On match l'inner pour eviter les
    # edges fantomes au bord des marges transparentes, puis on reconstruit la
    # box full size a la sortie (les marges transparentes restent renvoyees
    # pour que le tracker capture les joueurs qui debordent au bord de map).
    cache = _template_cache[map_name]
    ox_t, oy_t = cache['offset']
    full_w, full_h = cache['full_size']

    best = None  # (score, sx, sy, inner_top_left)
    for sx in _SCALES_X:
        for sy in _SCALES_Y:
            tpl_edges = _scaled_template_edges(map_name, sx, sy)
            if tpl_edges is None:
                continue
            th, tw = tpl_edges.shape[:2]
            if th > roi_edges.shape[0] or tw > roi_edges.shape[1]:
                continue
            res = cv2.matchTemplate(roi_edges, tpl_edges, cv2.TM_CCOEFF_NORMED)
            # Filets de sécurité sur la box FULL (template scalé entier) :
            #   full_x1 = _ROI_X1 + rx - ox_t * sx ≤ _MAX_X1
            #     → rx ≤ _MAX_X1 - _ROI_X1 + ox_t * sx
            #   full_y2 = _ROI_Y1 + ry - oy_t * sy + full_h * sy ≥ _MIN_Y2
            #     → ry ≥ _MIN_Y2 - _ROI_Y1 + oy_t * sy - full_h * sy
            ox_s = ox_t * sx
            oy_s = oy_t * sy
            full_h_s = full_h * sy
            max_rx = int(_MAX_X1 - _ROI_X1 + ox_s)
            min_ry = max(0, int(round(_MIN_Y2 - _ROI_Y1 + oy_s - full_h_s)))
            if max_rx < 0 or min_ry >= res.shape[0]:
                continue
            sub = res[min_ry:, : max_rx + 1]
            if sub.size == 0:
                continue
            _, max_val, _, sub_loc = cv2.minMaxLoc(sub)
            max_loc = (sub_loc[0], sub_loc[1] + min_ry)
            if best is None or max_val > best[0]:
                best = (float(max_val), float(sx), float(sy), max_loc)

    if best is None or best[0] < min_score:
        return None

    score, sx, sy, (tlx, tly) = best
    # inner_topleft dans la frame.
    inner_x1 = _ROI_X1 + tlx
    inner_y1 = _ROI_Y1 + tly
    # Reconstruit le top-left "full template" en retranchant l'offset alpha-bbox.
    ox_s = int(round(ox_t * sx))
    oy_s = int(round(oy_t * sy))
    full_w_s = int(round(full_w * sx))
    full_h_s = int(round(full_h * sy))
    x1 = inner_x1 - ox_s
    y1 = inner_y1 - oy_s
    x2 = x1 + full_w_s
    y2 = y1 + full_h_s
    return {
        'box': ((x1, y1), (x2, y2)),
        'score': score,
        'scale_x': sx,
        'scale_y': sy,
        # Backward compat : scale uniforme pour les outils qui n'ont pas
        # besoin de l'axe Y separe (manual_crop, benchmark_tracking, etc.).
        # On choisit sx (typiquement le plus proche de 1.0) — les stretches
        # vivent surtout en Y.
        'scale': sx,
    }
