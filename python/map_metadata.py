# Copyright (c) 2026, Antoine Duval
# This file is part of a source-visible project.
# See LICENSE for terms. Unauthorized use is prohibited.

"""Loader des métadonnées statiques par map.

Chaque map a son dossier `templates/minimaps/<slug>/` contenant `<slug>.json`
(éléments statiques : spawns, téléporteurs, points de capture), `<slug>.png`
(template visuel) et, optionnel, `walkable.png` (masque de zones traversables :
noir = traversable, blanc = mur/décor). Coordonnées en pixels du template
minimap (cf. `size` du JSON).

Schema attendu (validé par `_validate`) :

    {
      "name": str,
      "template": str (filename du PNG),
      "size": [int, int],          # [w, h]
      "spawns": {
        "orange": [ {"polygon": [[x,y], ...]}, ... ],
        "blue":   [ {"polygon": [[x,y], ...]}, ... ]
      },
      "teleporters": [
        {"id": str, "position": [x,y], "radius": int, "paired_with": str},
        ...
      ],
      "capture_points": [
        {"letter": str, "position": [[x1,y1], [x2,y2]]},
        ...
      ]
    }

Usage :
    md = map_metadata.load('The Cliff')
    md['spawns']['orange'][0]['polygon']  → liste de [x,y]

Exécution directe :
    python3 map_metadata.py [map_name]
    → vérifie le schéma + génère une image overlay /tmp/<slug>_metadata.png
      pour QA visuelle (spawns colorés, TPs cerclés, points encadrés).
"""

import json
import os
import sys
from typing import Optional


# Résout `templates/minimaps/` dans le bundle PyInstaller (via sys._MEIPASS)
# ou en dev. Aligné avec la convention d'analyze_video.py et minimap.py.
_BASE = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
_TEMPLATES_DIR = os.path.join(_BASE, 'templates', 'minimaps')

# Nom canonique → fichier JSON. Aligné sur minimap._TEMPLATE_FILES.
_METADATA_FILES = {
    'Artefact':       'artefact.json',
    'Atlantis':       'atlantis.json',
    'Ceres':          'ceres.json',
    'Engine':         'engine.json',
    'Helios Station': 'helios_station.json',
    'Horizon':        'horizon.json',
    'Lunar Outpost':  'lunar_outpost.json',
    'Outlaw':         'outlaw.json',
    'Polaris':        'polaris.json',
    'Silva':          'silva.json',
    'The Cliff':      'the_cliff.json',
    'The Rock':       'the_rock.json',
}

# Cache : map_name → dict chargé. Le JSON ne change pas pendant l'exécution.
_cache: dict = {}


def load(map_name: str) -> Optional[dict]:
    """Charge (et met en cache) la metadata pour map_name. None si absent."""
    if map_name in _cache:
        return _cache[map_name]
    fn = _METADATA_FILES.get(map_name)
    if fn is None:
        return None
    # Layout : un dossier par map (`templates/minimaps/<slug>/`) contenant
    # `<slug>.json`, `<slug>.png` et (optionnel) `<slug>_walkable.png`.
    slug = os.path.splitext(fn)[0]
    path = os.path.join(_TEMPLATES_DIR, slug, fn)
    if not os.path.isfile(path):
        return None
    with open(path, 'r') as f:
        data = json.load(f)
    _validate(data, map_name)
    _cache[map_name] = data
    return data


def _validate(data: dict, map_name: str) -> None:
    """Valide le schéma. Lève AssertionError sur le 1er problème détecté."""
    assert isinstance(data, dict), f'{map_name}: root must be a dict'
    assert isinstance(data.get('size'), list) and len(data['size']) == 2, \
        f'{map_name}: size must be [w, h]'
    w, h = data['size']

    # --- Spawns ---
    spawns = data.get('spawns')
    assert isinstance(spawns, dict), f'{map_name}: spawns must be a dict'
    for team in ('orange', 'blue'):
        assert team in spawns, f'{map_name}: spawns.{team} missing'
        sp_list = spawns[team]
        assert isinstance(sp_list, list) and len(sp_list) >= 1, \
            f'{map_name}: spawns.{team} must be a non-empty list'
        for i, sp in enumerate(sp_list):
            poly = sp.get('polygon')
            assert isinstance(poly, list) and len(poly) >= 3, \
                f'{map_name}: spawns.{team}[{i}].polygon needs ≥3 points'
            for j, p in enumerate(poly):
                assert isinstance(p, list) and len(p) == 2, \
                    f'{map_name}: spawns.{team}[{i}].polygon[{j}] must be [x, y]'
                assert 0 <= p[0] <= w and 0 <= p[1] <= h, \
                    f'{map_name}: spawns.{team}[{i}].polygon[{j}]={p} out of bounds {w}x{h}'

    # --- Teleporters ---
    tps = data.get('teleporters', [])
    assert isinstance(tps, list), f'{map_name}: teleporters must be a list'
    ids = set()
    pair_to = {}
    for i, tp in enumerate(tps):
        tid = tp.get('id')
        assert isinstance(tid, str) and tid, f'{map_name}: tp[{i}].id missing or empty'
        assert tid not in ids, f'{map_name}: duplicate tp id {tid}'
        ids.add(tid)
        pos = tp.get('position')
        assert isinstance(pos, list) and len(pos) == 2, \
            f'{map_name}: tp {tid}.position must be [x, y]'
        assert 0 <= pos[0] <= w and 0 <= pos[1] <= h, \
            f'{map_name}: tp {tid}.position={pos} out of bounds'
        assert isinstance(tp.get('radius'), (int, float)) and tp['radius'] > 0, \
            f'{map_name}: tp {tid}.radius must be > 0'
        pair_to[tid] = tp.get('paired_with')
    # Pair coherence : each tp must reference another tp by id, mutually.
    for tid, partner in pair_to.items():
        assert partner in ids, \
            f'{map_name}: tp {tid}.paired_with={partner} is not a known tp id'
        assert pair_to.get(partner) == tid, \
            f'{map_name}: tp {tid}↔{partner} pairing not mutual ' \
            f'({partner} is paired with {pair_to.get(partner)})'

    # --- Capture points ---
    cps = data.get('capture_points', [])
    assert isinstance(cps, list), f'{map_name}: capture_points must be a list'
    seen_letters = set()
    for i, cp in enumerate(cps):
        letter = cp.get('letter')
        assert isinstance(letter, str) and len(letter) == 1, \
            f'{map_name}: cp[{i}].letter must be a single char'
        assert letter not in seen_letters, \
            f'{map_name}: duplicate capture point letter {letter!r}'
        seen_letters.add(letter)
        pos = cp.get('position')
        assert isinstance(pos, list) and len(pos) == 2, \
            f'{map_name}: cp {letter}.position must be [[x1,y1], [x2,y2]] (bbox)'
        for j, corner in enumerate(pos):
            assert isinstance(corner, list) and len(corner) == 2, \
                f'{map_name}: cp {letter}.position[{j}] must be [x, y]'
            assert 0 <= corner[0] <= w and 0 <= corner[1] <= h, \
                f'{map_name}: cp {letter}.position[{j}]={corner} out of bounds'
        assert pos[0][0] < pos[1][0] and pos[0][1] < pos[1][1], \
            f'{map_name}: cp {letter}.position bbox corners must be top-left then bottom-right'


def _render_overlay(map_name: str, out_path: str) -> None:
    """Dessine la metadata par-dessus le template PNG pour QA visuelle."""
    import cv2
    import numpy as np

    data = load(map_name)
    if data is None:
        print(f'!! no metadata for {map_name!r}')
        return
    slug = os.path.splitext(data['template'])[0]
    tpl_path = os.path.join(_TEMPLATES_DIR, slug, data['template'])
    img = cv2.imread(tpl_path, cv2.IMREAD_COLOR)
    if img is None:
        print(f'!! cannot read template {tpl_path}')
        return

    # Upscale x3 pour lisibilité dans l'overlay.
    scale = 3
    img = cv2.resize(img, (img.shape[1] * scale, img.shape[0] * scale),
                     interpolation=cv2.INTER_NEAREST)

    # Calque overlay alpha-blended pour les polygones (sinon ils cachent le fond).
    overlay = img.copy()

    # Spawns : remplissage couleur d'équipe + bordure pleine.
    for color_bgr, team in ((( 60, 140, 240), 'orange'),
                            ((230, 160,  60), 'blue')):
        for sp in data['spawns'][team]:
            pts = np.array(sp['polygon'], dtype=np.int32) * scale
            cv2.fillPoly(overlay, [pts], color_bgr)
            cv2.polylines(img, [pts], isClosed=True, color=color_bgr, thickness=2)

    # 40% transparence pour le fill (le template reste visible derrière).
    cv2.addWeighted(overlay, 0.4, img, 0.6, 0, img)

    # Téléporteurs : cercle blanc + ligne pointillée vers le partenaire.
    tp_pos = {tp['id']: tp['position'] for tp in data['teleporters']}
    drawn_pairs = set()
    for tp in data['teleporters']:
        p = (tp['position'][0] * scale, tp['position'][1] * scale)
        r = int(tp['radius'] * scale)
        cv2.circle(img, p, r, (255, 255, 255), 2)
        cv2.putText(img, tp['id'].replace('tp_', ''),
                    (p[0] + r + 3, p[1] + 4),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1)
        # Ligne pointillée vers le partenaire (1× par paire).
        pair_key = tuple(sorted([tp['id'], tp['paired_with']]))
        if pair_key not in drawn_pairs:
            drawn_pairs.add(pair_key)
            q = tp_pos.get(tp['paired_with'])
            if q:
                q = (q[0] * scale, q[1] * scale)
                _dashed_line(img, p, q, (200, 200, 255), thickness=1, dash=8)

    # Capture points : rectangle vert + lettre.
    for cp in data['capture_points']:
        (x1, y1), (x2, y2) = cp['position']
        cv2.rectangle(img, (x1 * scale, y1 * scale), (x2 * scale, y2 * scale),
                      (0, 220, 0), 2)
        cv2.putText(img, cp['letter'],
                    ((x1 + x2) * scale // 2 - 6, (y1 + y2) * scale // 2 + 8),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 220, 0), 2)

    cv2.imwrite(out_path, img)
    print(f'OK  {map_name}: overlay written to {out_path}')


def _dashed_line(img, p1, p2, color, thickness=1, dash=6):
    """Ligne pointillée (cv2 n'en a pas de native)."""
    import math
    x1, y1 = p1
    x2, y2 = p2
    dist = math.hypot(x2 - x1, y2 - y1)
    if dist == 0:
        return
    n = int(dist // dash)
    for i in range(0, n, 2):
        a = i / n
        b = min((i + 1) / n, 1)
        sx = int(x1 + (x2 - x1) * a)
        sy = int(y1 + (y2 - y1) * a)
        ex = int(x1 + (x2 - x1) * b)
        ey = int(y1 + (y2 - y1) * b)
        import cv2
        cv2.line(img, (sx, sy), (ex, ey), color, thickness)


def main() -> None:
    map_name = sys.argv[1] if len(sys.argv) > 1 else 'The Cliff'
    print(f'=== {map_name} ===')
    data = load(map_name)
    if data is None:
        print(f'!! no metadata file for {map_name}')
        sys.exit(1)
    print(f'OK  validation passed')
    print(f'    spawns: orange={len(data["spawns"]["orange"])}, '
          f'blue={len(data["spawns"]["blue"])}')
    print(f'    teleporters: {len(data["teleporters"])} '
          f'({len(data["teleporters"]) // 2} paires)')
    print(f'    capture points: '
          f'{[cp["letter"] for cp in data["capture_points"]]}')
    slug = _METADATA_FILES[map_name].replace('.json', '')
    out = f'/tmp/{slug}_metadata.png'
    _render_overlay(map_name, out)


if __name__ == '__main__':
    main()
