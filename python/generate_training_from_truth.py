# Copyright (c) 2026, Antoine Duval
# This file is part of a source-visible project.
# See LICENSE for terms. Unauthorized use is prohibited.

"""Génère automatiquement des crops d'entraînement à partir d'un ground truth
annoté manuellement (manual_crop.py --truth) et de la vidéo source.

Pour chaque entry (ts, team, number, x_frac, y_frac) du ground truth, extrait
le crop 21×21 centré sur la position GT (en coords ROI minimap), l'upscale ×8
(168×168 BGR pour matcher le format attendu par train_cnn.py), et l'enregistre
dans `training_data/digits/<number>/`.

Avantage vs manual_crop : 100% des crops sont labellisés correctement par
construction (position venant du GT) — pas d'erreur humaine au clic.

Usage :
    python3 generate_training_from_truth.py <ground_truth.json> <video.mp4>
                                              [--prefix gt_replay]
"""

import argparse
import os
import sys
from typing import Optional

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import minimap as _minimap
import json as _json

_HERE = os.path.dirname(os.path.abspath(__file__))
_TRAIN_DIR = os.path.join(_HERE, 'training_data', 'digits')

_CROP_HALF = 10                # 21×21 natif
_CROP_SIZE = 2 * _CROP_HALF + 1
_TRAIN_UPSCALE = 8             # 168×168 PNG sauvegardé (cohérent avec manual_crop)


def _load_gt(path: str) -> tuple:
    with open(path) as f:
        data = _json.load(f)
    entries = []  # (ts, team, number, x_template_px, y_template_px)
    tpl_w, tpl_h = data['template_size']
    for tr in data['players_tracks']:
        team = tr['team']
        num = int(tr['number'])
        for entry in tr['history']:
            t = float(entry[0])
            xt = float(entry[1]) * tpl_w
            yt = float(entry[2]) * tpl_h
            entries.append((t, team, num, xt, yt))
    return entries, data['map'], (tpl_w, tpl_h)


def _ensure_class_dirs() -> None:
    for cls in [str(i) for i in range(10)]:
        os.makedirs(os.path.join(_TRAIN_DIR, cls), exist_ok=True)


def _next_seq(class_dir: str, prefix: str) -> int:
    """Numérotation continue : reprend après les fichiers existants avec ce prefix."""
    if not os.path.isdir(class_dir):
        return 1
    existing = [f for f in os.listdir(class_dir)
                if f.startswith(prefix) and f.endswith('.png')]
    return len(existing) + 1


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('ground_truth')
    parser.add_argument('video')
    parser.add_argument('--prefix', default=None,
                        help='prefix des fichiers generes (defaut: basename video)')
    args = parser.parse_args()

    prefix = args.prefix or ('gt_' + ''.join(
        c if c.isalnum() or c in '_-' else '_'
        for c in os.path.splitext(os.path.basename(args.video))[0]
    ))

    entries, map_name, tpl_size = _load_gt(args.ground_truth)
    print(f'Ground truth : {len(entries)} entries, map={map_name}, '
          f'template={tpl_size}')

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        raise RuntimeError(f'cannot open {args.video}')
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    duration = cap.get(cv2.CAP_PROP_FRAME_COUNT) / fps

    # Localise minimap sur frame milieu (statique pendant toute la partie).
    cap.set(cv2.CAP_PROP_POS_MSEC, (duration / 2.0) * 1000)
    ok, seed = cap.read()
    if not ok:
        raise RuntimeError('cannot read seed frame')
    info = _minimap.find_minimap_box(seed, map_name, min_score=0.0)
    if info is None:
        raise RuntimeError(f'minimap not found for map={map_name!r}')
    (x1, y1), (x2, y2) = info['box']
    scale = float(info.get('scale', 1.0)) or 1.0
    print(f'minimap box=({x1},{y1})-({x2},{y2}) scale={scale:.2f}')

    _ensure_class_dirs()

    # Pré-charge le seq counter par classe (pour éviter de re-scanner à chaque crop).
    seq_by_class = {
        str(d): _next_seq(os.path.join(_TRAIN_DIR, str(d)), prefix)
        for d in range(10)
    }

    # Group entries par ts pour ne lire qu'une fois chaque frame.
    by_ts: dict = {}
    for (t, team, num, xt, yt) in entries:
        by_ts.setdefault(t, []).append((team, num, xt, yt))
    sorted_ts = sorted(by_ts.keys())

    saved = 0
    skipped_oob = 0  # crop deborde la ROI (en bord de map)
    read_fail = 0
    n = len(sorted_ts)
    last_pct = -1
    for i, ts in enumerate(sorted_ts):
        cap.set(cv2.CAP_PROP_POS_MSEC, ts * 1000)
        ok, frame = cap.read()
        if not ok:
            read_fail += 1
            continue
        roi = frame[y1:y2, x1:x2]
        h, w = roi.shape[:2]
        for (team, num, xt, yt) in by_ts[ts]:
            # template px → ROI px
            cx = int(round(xt * scale))
            cy = int(round(yt * scale))
            xa = cx - _CROP_HALF
            ya = cy - _CROP_HALF
            xb = cx + _CROP_HALF + 1
            yb = cy + _CROP_HALF + 1
            if xa < 0 or ya < 0 or xb > w or yb > h:
                skipped_oob += 1
                continue
            crop = roi[ya:yb, xa:xb]
            big = cv2.resize(crop,
                             (_CROP_SIZE * _TRAIN_UPSCALE,
                              _CROP_SIZE * _TRAIN_UPSCALE),
                             interpolation=cv2.INTER_NEAREST)
            cls = str(num)
            class_dir = os.path.join(_TRAIN_DIR, cls)
            fn = f'{prefix}_t{int(ts * 10):05d}_{seq_by_class[cls]:04d}.png'
            cv2.imwrite(os.path.join(class_dir, fn), big)
            seq_by_class[cls] += 1
            saved += 1
        pct = int(100 * (i + 1) / n)
        if pct != last_pct and pct % 10 == 0:
            print(f'  generation {pct}% ({i + 1}/{n} frames, {saved} crops)')
            last_pct = pct
    cap.release()

    print(f'\nTotal sauvegarde : {saved} crops')
    if skipped_oob:
        print(f'  crops ignores (deborde ROI) : {skipped_oob}')
    if read_fail:
        print(f'  frames non lisibles         : {read_fail}')

    # Resume distribution finale (existing + nouveaux).
    print('\nDistribution finale par classe :')
    for d in range(10):
        cls = str(d)
        n_total = sum(1 for f in os.listdir(os.path.join(_TRAIN_DIR, cls))
                      if f.endswith('.png'))
        print(f'  {cls}: {n_total} total')


if __name__ == '__main__':
    main()
