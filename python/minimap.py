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

# Échelles testées, ordonnées du plus probable (taille standard) au plus
# excentrique. Pas de 5 % couvre [-20 %, +20 %] en 9 essais.
_SCALES = (1.00, 0.95, 1.05, 0.90, 1.10, 0.85, 1.15, 0.80, 1.20)

# Cache : nom de map → (template_bgr, edges_bgr_par_échelle)
_template_cache: dict = {}


def _load_template(map_name: str) -> Optional[np.ndarray]:
    """Charge (et met en cache) le template BGR pour map_name."""
    if map_name in _template_cache:
        return _template_cache[map_name]['bgr']
    fn = _TEMPLATE_FILES.get(map_name)
    if fn is None:
        return None
    path = os.path.join(_TEMPLATES_DIR, fn)
    if not os.path.isfile(path):
        return None
    img = cv2.imread(path, cv2.IMREAD_COLOR)
    if img is None:
        return None
    _template_cache[map_name] = {'bgr': img, 'edges': {}}
    return img


def _edges(img: np.ndarray) -> np.ndarray:
    """Canny robuste : flou léger + seuils auto basés sur la médiane."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    med = float(np.median(gray))
    lo = int(max(0, 0.66 * med))
    hi = int(min(255, 1.33 * med))
    return cv2.Canny(gray, lo, hi)


def _scaled_template_edges(map_name: str, scale: float) -> Optional[np.ndarray]:
    cache = _template_cache.get(map_name)
    if cache is None:
        return None
    if scale in cache['edges']:
        return cache['edges'][scale]
    base = cache['bgr']
    h, w = base.shape[:2]
    nh, nw = max(1, int(round(h * scale))), max(1, int(round(w * scale)))
    resized = cv2.resize(base, (nw, nh), interpolation=cv2.INTER_AREA)
    e = _edges(resized)
    cache['edges'][scale] = e
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

    best = None  # (score, scale, top_left, (tw, th))
    for s in _SCALES:
        tpl_edges = _scaled_template_edges(map_name, s)
        if tpl_edges is None:
            continue
        th, tw = tpl_edges.shape[:2]
        # Ne pas matcher un template plus grand que la ROI.
        if th > roi_edges.shape[0] or tw > roi_edges.shape[1]:
            continue
        res = cv2.matchTemplate(roi_edges, tpl_edges, cv2.TM_CCOEFF_NORMED)
        _, max_val, _, max_loc = cv2.minMaxLoc(res)
        if best is None or max_val > best[0]:
            best = (float(max_val), float(s), max_loc, (tw, th))

    if best is None or best[0] < min_score:
        return None

    score, scale, (tlx, tly), (tw, th) = best
    x1 = _ROI_X1 + tlx
    y1 = _ROI_Y1 + tly
    x2 = x1 + tw
    y2 = y1 + th
    return {
        'box': ((x1, y1), (x2, y2)),
        'score': score,
        'scale': scale,
    }
