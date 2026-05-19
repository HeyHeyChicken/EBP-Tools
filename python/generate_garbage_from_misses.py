# Copyright (c) 2026, Antoine Duval
# This file is part of a source-visible project.
# See LICENSE for terms. Unauthorized use is prohibited.

"""Hard negative mining : génère des crops garbage à partir des erreurs
du CNN sur la vidéo de test.

Pour chaque détection algo, on compare au ground truth manuel :
  - Si (team, number) est annoté dans le GT à ce ts MAIS la position algo
    est >5% du GT → c'est une hallucination CNN du même digit à une
    mauvaise position → SAFE garbage (à ce ts, le digit est ailleurs).
    Sauvegardé directement dans `training_data/digits/garbage/`.

  - Si (team, number) n'est PAS dans le GT à ce ts → cas SUSPECT :
    peut être un FP pur (à étiqueter garbage) MAIS peut aussi être une
    pastille cas 3 (joueur mort en respawn) non annotée par le user
    → sauvegardé dans `training_data/digits/garbage_pending/` pour
    revue MANUELLE avant inclusion dans le training set.

Le script ne réentraîne PAS. À l'utilisateur de vérifier `garbage_pending/`
et de copier dans `garbage/` les crops qui sont effectivement du garbage.

Usage :
    python3 generate_garbage_from_misses.py <ground_truth.json> <video.mp4>
"""

import argparse
import os
import sys
from typing import Dict

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import minimap as _minimap
import blob_detector as _bd
import map_metadata as _map_metadata
import json as _json
from digit_classifier import DigitClassifier
from analyze_video import _sample_team_colors_from_spawns


_HERE = os.path.dirname(os.path.abspath(__file__))
_TRAIN_DIR = os.path.join(_HERE, 'training_data', 'digits')
_GARBAGE_DIR = os.path.join(_TRAIN_DIR, 'garbage')
_PENDING_DIR = os.path.join(_TRAIN_DIR, 'garbage_pending')

_CROP_HALF = 10
_CROP_SIZE = 21
_TRAIN_UPSCALE = 8
_MATCH_THRESHOLD = 0.05
_CNN_MIN_CONF = 0.5


def _load_gt(path: str) -> tuple:
    with open(path) as f:
        data = _json.load(f)
    gt: Dict = {}  # (ts, team, number) → (x_frac, y_frac)
    for tr in data['players_tracks']:
        team, num = tr['team'], int(tr['number'])
        for e in tr['history']:
            t = round(float(e[0]), 3)
            gt[(t, team, num)] = (float(e[1]), float(e[2]))
    return gt, data['map'], data['template_size']


def _next_seq(d: str, prefix: str) -> int:
    if not os.path.isdir(d):
        return 1
    return sum(1 for f in os.listdir(d)
               if f.startswith(prefix) and f.endswith('.png')) + 1


def _save_crop(roi: np.ndarray, cx_roi: float, cy_roi: float,
               out_dir: str, fn: str) -> bool:
    """Crop 21×21 BGR centré, upscale ×8, save. Skip si déborde."""
    h, w = roi.shape[:2]
    cx = int(round(cx_roi))
    cy = int(round(cy_roi))
    xa = cx - _CROP_HALF
    ya = cy - _CROP_HALF
    xb = cx + _CROP_HALF + 1
    yb = cy + _CROP_HALF + 1
    if xa < 0 or ya < 0 or xb > w or yb > h:
        return False
    crop = roi[ya:yb, xa:xb]
    big = cv2.resize(crop,
                     (_CROP_SIZE * _TRAIN_UPSCALE, _CROP_SIZE * _TRAIN_UPSCALE),
                     interpolation=cv2.INTER_NEAREST)
    cv2.imwrite(os.path.join(out_dir, fn), big)
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('ground_truth')
    parser.add_argument('video')
    args = parser.parse_args()

    gt, map_name, template_size = _load_gt(args.ground_truth)
    tpl_w, tpl_h = template_size
    md = _map_metadata.load(map_name)
    classifier = DigitClassifier()

    os.makedirs(_GARBAGE_DIR, exist_ok=True)
    os.makedirs(_PENDING_DIR, exist_ok=True)

    prefix = 'hnm_' + ''.join(
        c if c.isalnum() or c in '_-' else '_'
        for c in os.path.splitext(os.path.basename(args.video))[0]
    )
    seq_safe = _next_seq(_GARBAGE_DIR, prefix)
    seq_pend = _next_seq(_PENDING_DIR, prefix)

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        raise RuntimeError(f'cannot open {args.video}')
    duration = (cap.get(cv2.CAP_PROP_FRAME_COUNT)
                / (cap.get(cv2.CAP_PROP_FPS) or 30))
    cap.set(cv2.CAP_PROP_POS_MSEC, (duration / 2.0) * 1000)
    _, seed = cap.read()
    info = _minimap.find_minimap_box(seed, map_name, min_score=0.0)
    (x1, y1), (x2, y2) = info['box']
    scale = float(info.get('scale', 1.0)) or 1.0
    roi_seed = seed[y1:y2, x1:x2]
    orange_rgb, blue_rgb = _sample_team_colors_from_spawns(roi_seed, md, scale)
    print(f'minimap box=({x1},{y1})-({x2},{y2}) scale={scale:.2f}')
    print(f'orange_rgb={orange_rgb} blue_rgb={blue_rgb}')

    gt_ts_list = sorted({t for (t, _, _) in gt.keys()})

    n_safe = 0
    n_pend = 0
    n_skip_oob = 0
    n_pct = -1
    for i, ts in enumerate(gt_ts_list):
        cap.set(cv2.CAP_PROP_POS_MSEC, ts * 1000)
        ok, frame = cap.read()
        if not ok:
            continue
        roi = frame[y1:y2, x1:x2]
        blobs = _bd.detect_blobs(frame, info, orange_rgb, blue_rgb)
        filtered = classifier.filter_blobs(
            frame, info, blobs, min_conf=_CNN_MIN_CONF, map_meta=md)
        for team in ('orange', 'blue'):
            for b in filtered[team]:
                num = int(b['digit'])
                ax = float(b['x']) / tpl_w
                ay = float(b['y']) / tpl_h
                cx_roi = float(b['x']) * scale
                cy_roi = float(b['y']) * scale
                gt_pos = gt.get((round(ts, 3), team, num))
                if gt_pos is not None:
                    gx, gy = gt_pos
                    d = ((ax - gx) ** 2 + (ay - gy) ** 2) ** 0.5
                    if d <= _MATCH_THRESHOLD:
                        continue  # vrai positif → pas garbage
                    # Wrong position : (team, num) annoté ailleurs → safe garbage
                    fn = f'{prefix}_t{int(ts * 10):05d}_{seq_safe:04d}.png'
                    if _save_crop(roi, cx_roi, cy_roi, _GARBAGE_DIR, fn):
                        seq_safe += 1
                        n_safe += 1
                    else:
                        n_skip_oob += 1
                else:
                    # FP pur : peut être case 3 → pending review
                    fn = f'{prefix}_t{int(ts * 10):05d}_{seq_pend:04d}.png'
                    if _save_crop(roi, cx_roi, cy_roi, _PENDING_DIR, fn):
                        seq_pend += 1
                        n_pend += 1
                    else:
                        n_skip_oob += 1
        pct = int(100 * (i + 1) / len(gt_ts_list))
        if pct != n_pct and pct % 10 == 0:
            print(f'  generation {pct}% ({i + 1}/{len(gt_ts_list)} frames)')
            n_pct = pct
    cap.release()

    print()
    print(f'Crops SAFE garbage (wrong position)      : {n_safe}')
    print(f'  -> {_GARBAGE_DIR}')
    print(f'Crops PENDING (FPs purs, a verifier)     : {n_pend}')
    print(f'  -> {_PENDING_DIR}')
    if n_skip_oob:
        print(f'Crops sautes (deborde ROI)               : {n_skip_oob}')
    print()
    print('AVANT de re-entrainer : verifier garbage_pending/ et :')
    print('  - deplacer dans garbage/ les vrais garbage (X markers, noise, etc.)')
    print('  - supprimer les pastilles legitimes case 3 (mort respawn)')


if __name__ == '__main__':
    main()
