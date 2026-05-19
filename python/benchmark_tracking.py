# Copyright (c) 2026, Antoine Duval
# This file is part of a source-visible project.
# See LICENSE for terms. Unauthorized use is prohibited.

"""Benchmark : compare un ground truth (manual_crop.py --truth) avec la sortie
de la chaîne blob_detector + CNN sur les mêmes timestamps.

Deux métriques :
  1. Position-only (Hungarian par frame/team) : à quel point les detections
     algo sont-elles proches des vraies positions, quelle que soit l'identité ?
  2. Identification (match exact team+number) : le CNN classifie-t-il
     correctement le digit de chaque joueur visible ?

Le tracker n'est PAS utilisé ici — on évalue le détecteur instantané. Pour
benchmark le tracker, il faudrait run à 10 FPS et comparer aux ts GT, ce
qui n'est pas couvert par ce script.

Usage :
    python3 benchmark_tracking.py <ground_truth.json> <video.mp4>
"""

import json
import os
import sys
from typing import Dict, Tuple

import cv2
import numpy as np
from scipy.optimize import linear_sum_assignment

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import minimap as _minimap
import blob_detector as _bd
import map_metadata as _map_metadata
from digit_classifier import DigitClassifier
from analyze_video import _sample_team_colors_from_spawns


# Seuil "détection correcte" : distance algo↔GT en fraction de map.
# 5% sur The Cliff (355px) ≈ 18px ≈ ~1 pastille de diamètre.
_MATCH_THRESHOLD = 0.05
# Min confidence pour le CNN. Plus permissif que la prod (0.7) pour benchmark.
_CNN_MIN_CONF = 0.5


def _load_ground_truth(path: str) -> Tuple[Dict, str, list]:
    """Charge le JSON ground truth.

    Retourne :
      - gt: dict {(ts, team) -> [(number, x_frac, y_frac), ...]}
      - map_name
      - template_size [w, h]
    """
    with open(path) as f:
        data = json.load(f)
    gt: Dict = {}
    for tr in data['players_tracks']:
        team, num = tr['team'], int(tr['number'])
        for entry in tr['history']:
            t = round(float(entry[0]), 3)
            gt.setdefault((t, team), []).append(
                (num, float(entry[1]), float(entry[2])))
    return gt, data['map'], data['template_size']


def _run_detection(video_path: str, map_name: str, gt_ts_list: list,
                   template_size: list) -> Dict:
    """Pour chaque ts du GT, lance blob_detector + CNN.

    Retourne dict {(ts, team) -> [(number, x_frac, y_frac, conf), ...]}.
    """
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f'cannot open {video_path}')
    md = _map_metadata.load(map_name)
    classifier = DigitClassifier()

    # Localise minimap sur frame milieu (la box est statique).
    duration = (cap.get(cv2.CAP_PROP_FRAME_COUNT)
                / (cap.get(cv2.CAP_PROP_FPS) or 30))
    cap.set(cv2.CAP_PROP_POS_MSEC, (duration / 2.0) * 1000)
    _, seed = cap.read()
    info = _minimap.find_minimap_box(seed, map_name, min_score=0.0)
    if info is None:
        raise RuntimeError(f'minimap not found for map={map_name!r}')
    (x1, y1), (x2, y2) = info['box']
    scale = float(info.get('scale', 1.0)) or 1.0
    print(f'minimap box=({x1},{y1})-({x2},{y2}) scale={scale:.2f}')

    # Sample team colors depuis les spawns.
    roi_seed = seed[y1:y2, x1:x2]
    orange_rgb, blue_rgb = _sample_team_colors_from_spawns(roi_seed, md, scale)
    print(f'orange_rgb={orange_rgb} blue_rgb={blue_rgb}')
    if orange_rgb is None or blue_rgb is None:
        raise RuntimeError('couleurs equipe non resolvables')

    tpl_w, tpl_h = template_size
    out: Dict = {}
    n = len(gt_ts_list)
    last_pct = -1
    for i, ts in enumerate(gt_ts_list):
        cap.set(cv2.CAP_PROP_POS_MSEC, ts * 1000)
        ok, frame = cap.read()
        if not ok:
            continue
        blobs = _bd.detect_blobs(frame, info, orange_rgb, blue_rgb)
        filtered = classifier.filter_blobs(
            frame, info, blobs, min_conf=_CNN_MIN_CONF, map_meta=md)
        for team in ('orange', 'blue'):
            out[(ts, team)] = [
                (int(b['digit']),
                 float(b['x']) / tpl_w,
                 float(b['y']) / tpl_h,
                 float(b.get('conf', 0)))
                for b in filtered[team]
            ]
        pct = int(100 * (i + 1) / n)
        if pct != last_pct and pct % 10 == 0:
            print(f'  detection {pct}% ({i + 1}/{n})')
            last_pct = pct
    cap.release()
    return out


def _hungarian_distances(gt_pts: list, algo_pts: list) -> list:
    """Hungarian par distance. Retourne distances des matchs valides.

    Les points non matchés (taille différente) sont comptés comme misses.
    """
    if not gt_pts or not algo_pts:
        return []
    n_gt = len(gt_pts)
    n_algo = len(algo_pts)
    n = max(n_gt, n_algo)
    cost = np.full((n, n), 99.0)
    for i in range(n_gt):
        for j in range(n_algo):
            dx = gt_pts[i][0] - algo_pts[j][0]
            dy = gt_pts[i][1] - algo_pts[j][1]
            cost[i, j] = (dx * dx + dy * dy) ** 0.5
    row_ind, col_ind = linear_sum_assignment(cost)
    distances = []
    for r, c in zip(row_ind, col_ind):
        if r < n_gt and c < n_algo:
            distances.append(cost[r, c])
    return distances


def _evaluate(gt: Dict, algo: Dict) -> None:
    """Calcule et affiche les métriques."""
    pos_distances: list = []           # distances de matching position-only
    pos_missed = 0                      # GT players sans match algo
    pos_extra = 0                       # algo detections sans GT
    id_correct = 0                      # (team, number) GT correctement détecté
    id_wrong = 0                        # GT player détecté mais mauvais number
    id_missed = 0                       # GT player pas détecté du tout
    id_total = 0

    per_player = {}  # (team, num) → [list of dist or None]

    for (ts, team), gt_list in gt.items():
        algo_list = algo.get((ts, team), [])
        gt_xy = [(x, y) for (_, x, y) in gt_list]
        algo_xy = [(x, y) for (_, x, y, _) in algo_list]

        # 1. Position-only Hungarian
        dists = _hungarian_distances(gt_xy, algo_xy)
        pos_distances.extend(dists)
        pos_missed += max(0, len(gt_xy) - len(algo_xy))
        pos_extra += max(0, len(algo_xy) - len(gt_xy))

        # 2. Identification : pour chaque GT, on cherche si une detection algo
        #    a le bon (team, number) ET est dans le seuil de distance.
        for (gt_num, gx, gy) in gt_list:
            id_total += 1
            key = (team, gt_num)
            best = None
            for (a_num, ax, ay, _conf) in algo_list:
                d = ((gx - ax) ** 2 + (gy - ay) ** 2) ** 0.5
                if best is None or d < best[1]:
                    best = (a_num, d)
            if best is None:
                id_missed += 1
                per_player.setdefault(key, []).append(None)
            elif best[1] > _MATCH_THRESHOLD:
                # algo a des dets mais aucune n'est proche → missed
                id_missed += 1
                per_player.setdefault(key, []).append(None)
            elif best[0] == gt_num:
                id_correct += 1
                per_player.setdefault(key, []).append(best[1])
            else:
                id_wrong += 1
                per_player.setdefault(key, []).append(-1.0)  # marqueur "wrong id"

    # ─── Affichage ────────────────────────────────────────────────────
    print('\n=== Position-only (Hungarian par frame/team) ===')
    if pos_distances:
        arr = np.array(pos_distances)
        print(f'  Matches : {len(arr)}')
        print(f'  Distance mean   : {arr.mean():.4f}')
        print(f'  Distance median : {np.median(arr):.4f}')
        print(f'  Distance p95    : {np.percentile(arr, 95):.4f}')
        within = (arr <= _MATCH_THRESHOLD).sum() / len(arr) * 100
        print(f'  ≤ {_MATCH_THRESHOLD:.0%} threshold : {within:.1f}%')
    print(f'  GT sans match (joueurs ratés) : {pos_missed}')
    print(f'  Algo sans GT (faux positifs)  : {pos_extra}')

    print('\n=== Identification (team + number) ===')
    print(f'  Total GT entries : {id_total}')
    print(f'  Correct          : {id_correct} ({100*id_correct/id_total:.1f}%)')
    print(f'  Wrong number     : {id_wrong} ({100*id_wrong/id_total:.1f}%)')
    print(f'  Missed           : {id_missed} ({100*id_missed/id_total:.1f}%)')

    print('\n=== Par joueur (% correct / wrong / missed) ===')
    for key in sorted(per_player.keys()):
        team, num = key
        vals = per_player[key]
        n = len(vals)
        correct = sum(1 for v in vals if v is not None and v >= 0)
        wrong = sum(1 for v in vals if v == -1.0)
        missed = sum(1 for v in vals if v is None)
        dists = [v for v in vals if v is not None and v >= 0]
        mean_d = (sum(dists) / len(dists)) if dists else None
        mean_s = f'mean_dist={mean_d:.4f}' if mean_d is not None else 'mean_dist=N/A'
        print(f'  {team} #{num}: {n} frames | '
              f'correct={100*correct/n:.1f}% '
              f'wrong={100*wrong/n:.1f}% '
              f'missed={100*missed/n:.1f}% | {mean_s}')


def main():
    if len(sys.argv) < 3:
        print('Usage: benchmark_tracking.py <ground_truth.json> <video.mp4>')
        sys.exit(1)
    gt_path, video_path = sys.argv[1], sys.argv[2]
    gt, map_name, template_size = _load_ground_truth(gt_path)
    gt_ts_list = sorted({t for (t, _) in gt.keys()})
    print(f'Ground truth : {len(gt_ts_list)} ts uniques, map={map_name}')

    algo = _run_detection(video_path, map_name, gt_ts_list, template_size)
    _evaluate(gt, algo)


if __name__ == '__main__':
    main()
