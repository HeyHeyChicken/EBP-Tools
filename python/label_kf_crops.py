"""Labellise les crops killfeed dumpés (EVA_KF_DUMP dans analyze_video) contre
le `kills.txt` de chaque vidéo, pour constituer un jeu de crops killfeed RÉELS
labellisés (entraînement/éval de `evakillfeed`).

Les crops dumpés sont nommés `<elapsed>_<team>_<side>_<n>.png` où side ∈
{killer, victim}. On matche chaque crop à un kill de `kills.txt` :
  - |elapsed_crop − elapsed_kill| ≤ WINDOW
  - le nom (killer|victim selon side) appartient à l'équipe <team> (via teams.txt)
  - match UNIQUE (sinon ambigu → écarté)
Le label est le pseudo tel qu'écrit dans kills.txt (casse d'origine, tag inclus).

Usage :
    python3 label_kf_crops.py <dump_dir> <video_name> <out_dir> [--window 3]
"""

import argparse
import shutil
from pathlib import Path

from scan_baseline import VIDEO_DIR, parse_gt, teams_from_file


def _team_of(name, orange, blue):
    low = name.lower()
    if any(low == n.lower() for n in orange):
        return 'orange'
    if any(low == n.lower() for n in blue):
        return 'blue'
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('dump_dir', type=Path)
    ap.add_argument('video')
    ap.add_argument('out_dir', type=Path)
    ap.add_argument('--window', type=int, default=3)
    args = ap.parse_args()

    gt = parse_gt(VIDEO_DIR / args.video / 'kills.txt')
    orange, blue = teams_from_file(VIDEO_DIR / args.video / 'teams.txt')
    args.out_dir.mkdir(parents=True, exist_ok=True)

    n_ok = n_ambig = n_none = 0
    for png in sorted(args.dump_dir.glob('*.png')):
        parts = png.stem.split('_')
        if len(parts) < 4:
            continue
        elapsed, team, side = int(parts[0]), parts[1], parts[2]
        # kills candidats : bonne fenêtre temporelle + nom du bon côté sur <team>
        cands = []
        for k in gt:
            if abs(k['elapsed'] - elapsed) > args.window:
                continue
            name = k['killer'] if side == 'killer' else k['victim']
            if _team_of(name, orange, blue) == team:
                cands.append(name)
        uniq = set(cands)
        if len(uniq) == 1:
            label = uniq.pop()
            base = f'{args.video}_{png.stem}'
            shutil.copy(png, args.out_dir / f'{base}.png')
            (args.out_dir / f'{base}.gt.txt').write_text(label + '\n')
            n_ok += 1
        elif len(uniq) > 1:
            n_ambig += 1
        else:
            n_none += 1
    print(f'{args.video}: labellisés={n_ok}  ambigus={n_ambig}  sans_match={n_none}')


if __name__ == '__main__':
    main()
