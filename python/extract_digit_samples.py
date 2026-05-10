# Copyright (c) 2026, Antoine Duval
# This file is part of a source-visible project.
# See LICENSE for terms. Unauthorized use is prohibited.

"""Extrait des crops de chiffres candidats depuis toutes les vidéos.

Pipeline :
  - Pour chaque vidéo : sample N frames espacées
  - Pour chaque frame : localise minimap, résout couleurs, détecte candidats
    (méthode 2.1 : isolated peaks + dark centers in color zone)
  - Crop chaque candidate à _CROP_SIZE px centré, sauvegarde dans
    `training_data/digits/_unsorted/`
  - Le nom du fichier encode (video, timestamp, team, indice) pour traçabilité

L'utilisateur trie ensuite manuellement les crops dans 0/, 1/, ..., 9/,
_garbage/ (croix de mort, faux positifs).
"""

import os
import subprocess
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import minimap as _minimap
import players as _players
import analyze_video as _av

VIDEO_DIR = '/Users/antoine/Desktop/test/video'
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       'training_data', 'digits', '_unsorted')

# Mapping basename → nom canonique de map (cf. _MAPS dans analyze_video.py).
VIDEOS = {
    'artefact':       'Artefact',
    'atlantis':       'Atlantis',
    'ceres':          'Ceres',
    'cliff':          'The Cliff',
    'engine':         'Engine',
    'heliosstation':  'Helios Station',
    'horizon':        'Horizon',
    'lunar':          'Lunar Outpost',
    'outlaw':         'Outlaw',
    'polaris':        'Polaris',
    'silva':          'Silva',
}

# Nombre de frames échantillonnées par vidéo. 8 frames × 11 vidéos × ~8
# candidats moyen = ~700 crops avant déduplication, gérable à trier en 20-30 min.
N_FRAMES = 8
# Demi-côté du crop natif (21×21 px). Marge généreuse pour absorber
# le décalage entre centre détecté et centre réel du chiffre.
_CROP_HALF = 10
_CROP_SIZE = 2 * _CROP_HALF + 1  # 21
# Facteur d'upscale pour la sauvegarde — facilite le tri à l'œil nu.
# INTER_NEAREST conserve les pixels exacts (pas de lissage trompeur).
_UPSCALE = 4


def _video_duration(path: str) -> float:
    out = subprocess.check_output([
        'ffprobe', '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=duration', '-of', 'csv=p=0', path
    ]).decode().strip()
    return float(out)


def _grab_frame(cap, t_sec):
    cap.set(cv2.CAP_PROP_POS_MSEC, t_sec * 1000)
    ok, frame = cap.read()
    return frame if ok else None


def extract_from_video(video_basename: str, map_name: str) -> int:
    video_path = os.path.join(VIDEO_DIR, f'{video_basename}.mp4')
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f'!! cannot open {video_path}')
        return 0
    duration = _video_duration(video_path)
    timestamps = np.linspace(60, max(60, duration - 30), N_FRAMES)

    # Localise minimap UNE FOIS (statique pendant la partie). On essaie
    # plusieurs frames jusqu'à un score satisfaisant.
    minimap_box = None
    for t in timestamps[: min(5, len(timestamps))]:
        f = _grab_frame(cap, float(t))
        if f is None:
            continue
        res = _minimap.find_minimap_box(f, map_name, min_score=0.0)
        if res and res['score'] >= 0.55:
            minimap_box = res['box']
            break
    if minimap_box is None:
        print(f'!! {video_basename}: cannot locate minimap')
        cap.release()
        return 0

    # Couleurs résolues : essaie sur quelques frames jusqu'à succès.
    orange = blue = None
    for t in timestamps[: min(10, len(timestamps))]:
        f = _grab_frame(cap, float(t))
        if f is None:
            continue
        rgb = cv2.cvtColor(f, cv2.COLOR_BGR2RGB)
        o, b = _av._resolve_team_colors(rgb)
        orange = orange or o
        blue = blue or b
        if orange and blue:
            break
    if orange is None or blue is None:
        print(f'!! {video_basename}: cannot resolve team colors '
              f'(orange={orange} blue={blue})')
        cap.release()
        return 0

    (x1, y1), (x2, y2) = minimap_box
    bw, bh = x2 - x1, y2 - y1
    saved = 0
    # Hashes des crops déjà sauvegardés pour cette vidéo → déduplication
    # exacte (même chiffre statique sur 2 frames consécutives).
    seen_hashes = set()

    for t in timestamps:
        f = _grab_frame(cap, float(t))
        if f is None:
            continue
        # On utilise la liste des CANDIDATS (avant filtre OCR) — c'est le
        # but : capturer tout ce qui PEUT être un chiffre, l'humain triera.
        roi = f[y1:y2, x1:x2]
        for team_name, color in (('orange', orange), ('blue', blue)):
            mask = _players._color_mask(roi, color)
            candidates = _players._dedup(
                _players._isolated_pastille_centers(mask)
                + _players._dark_centers_in_color(roi, mask),
                _players._DEDUP_DIST,
            )
            for i, (cx, cy) in enumerate(candidates):
                cxa = int(cx)
                cya = int(cy)
                fx = x1 + cxa
                fy = y1 + cya
                xa = max(0, fx - _CROP_HALF)
                ya = max(0, fy - _CROP_HALF)
                xb = min(f.shape[1], fx + _CROP_HALF + 1)
                yb = min(f.shape[0], fy + _CROP_HALF + 1)
                crop = f[ya:yb, xa:xb]
                if crop.shape[0] != _CROP_SIZE or crop.shape[1] != _CROP_SIZE:
                    continue
                h = hash(crop.tobytes())
                if h in seen_hashes:
                    continue
                seen_hashes.add(h)
                # Upscale ×_UPSCALE pour le tri visuel.
                big = cv2.resize(crop, (_CROP_SIZE * _UPSCALE,
                                         _CROP_SIZE * _UPSCALE),
                                 interpolation=cv2.INTER_NEAREST)
                fn = f'{video_basename}_t{int(t):03d}_{team_name}_{i}.png'
                cv2.imwrite(os.path.join(OUT_DIR, fn), big)
                saved += 1
    cap.release()
    print(f'OK  {video_basename:14s} ({map_name:14s}) → {saved} crops')
    return saved


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    total = 0
    for video, map_name in VIDEOS.items():
        total += extract_from_video(video, map_name)
    print(f'\nTOTAL: {total} crops in {OUT_DIR}')


if __name__ == '__main__':
    main()
