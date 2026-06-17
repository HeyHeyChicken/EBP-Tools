"""
QA score : compare la score_timeline détectée par analyze_video.py (detect →
chunks) au ground-truth `<name>/scores.txt`, pour chaque vidéo qui en a un.

scores.txt : `MM:SS orange blue` (timer in-game, décompte, MAX:00 = début),
une ligne par changement de score (cumulatif). La score_timeline détectée est
elle aussi indexée sur l'elapsed dérivé du timer (elapsed = MAX*60 - timer),
donc les deux axes s'alignent directement (pas de dépendance à game.start).

Métriques par vidéo :
  - final  : (orange, blue) final détecté vs GT, et OK/KO
  - mae_o/mae_b : erreur absolue moyenne par équipe, échantillonnée par seconde
                  sur [0, dernier elapsed GT]
  - exact% : % de secondes où (orange, blue) détecté == GT exactement

Usage : python scan_scores.py [name ...]
"""
import json
import subprocess
import sys
from pathlib import Path

from scan_baseline import (VIDEO_DIR, SCRIPT, PYTHON, FFMPEG, TESSERACT,
                           _run, run_detect, teams_from_file)


def parse_scores_gt(path: Path):
    """Retourne (max_time_min, {elapsed_sec: [o, b]}). max déduit de la 1re ligne."""
    lines = []
    for raw in path.read_text().splitlines():
        s = raw.strip()
        if not s or s.startswith('#'):
            continue
        p = s.split()
        if len(p) < 3 or ':' not in p[0]:
            continue
        mm, ss = p[0].split(':')
        lines.append((int(mm) * 60 + int(ss), int(p[1]), int(p[2])))
    if not lines:
        return 10, {}
    max_time = (lines[0][0] + 59) // 60  # 10:00 -> 10
    out = {}
    for timer, o, b in lines:
        out[max_time * 60 - timer] = [o, b]
    return max_time, out


def run_chunks_scores(video: Path, games: list, orange: list, blue: list):
    """Retourne la score_timeline fusionnée {elapsed_int: [o, b]} de tous les chunks."""
    chunks = [{
        'startSeconds': int(g['start']), 'endSeconds': int(g['end']),
        'gameID': f'g{i}', 'mode': int(g['mode']),
        'orangePlayers': [{'name': n} for n in orange],
        'bluePlayers': [{'name': n} for n in blue],
    } for i, g in enumerate(games)]
    settings = json.dumps({'chunks': chunks})
    cmd = [PYTHON, str(SCRIPT), 'chunks', str(video), FFMPEG, TESSERACT, settings]
    events, _ = _run(cmd, timeout=2400)
    tl = {}
    for e in events:
        for r in e.get('results', []) or []:
            for k, pair in (r.get('payload', {}).get('score_timeline') or {}).items():
                tl[int(k)] = [int(pair[0]), int(pair[1])]
    return tl


def step_at(tl: dict, elapsed: int):
    """Valeur step-function (dernière clé <= elapsed), [0,0] avant tout."""
    o = b = 0
    for k in sorted(tl):
        if k <= elapsed:
            o, b = tl[k]
        else:
            break
    return o, b


def compare(det_tl: dict, gt_tl: dict):
    if not gt_tl:
        return None
    end = max(gt_tl)
    n = end + 1
    err_o = err_b = exact = 0
    # pré-trie une fois pour step (perf)
    det_keys = sorted(det_tl)
    gt_keys = sorted(gt_tl)

    def step(keys, tl, e):
        o = b = 0
        for k in keys:
            if k <= e:
                o, b = tl[k]
            else:
                break
        return o, b

    for sec in range(n):
        do, db = step(det_keys, det_tl, sec)
        go, gb = step(gt_keys, gt_tl, sec)
        err_o += abs(do - go)
        err_b += abs(db - gb)
        if do == go and db == gb:
            exact += 1
    gfo, gfb = gt_tl[end]
    dfo, dfb = step(det_keys, det_tl, end)
    return {
        'n': n, 'mae_o': err_o / n, 'mae_b': err_b / n, 'exact': exact / n,
        'gt_final': (gfo, gfb), 'det_final': (dfo, dfb),
        'final_ok': (gfo, gfb) == (dfo, dfb),
    }


def main():
    all_names = sorted(p.parent.name for p in VIDEO_DIR.glob('*/scores.txt'))
    names = sys.argv[1:] or all_names
    print(f"{'video':<12} {'gt_final':>10} {'det_final':>10} {'fin':>4} "
          f"{'mae_o':>6} {'mae_b':>6} {'exact%':>7}")
    print('-' * 64)
    for name in names:
        d = VIDEO_DIR / name
        video = d / 'replay.mp4'
        gt_path = d / 'scores.txt'
        if not gt_path.exists():
            print(f"{name:<12} (pas de scores.txt)"); continue
        _, gt_tl = parse_scores_gt(gt_path)
        try:
            games = run_detect(video)
        except subprocess.TimeoutExpired:
            print(f"{name:<12} ERROR detect timeout"); continue
        if not games:
            print(f"{name:<12} ERROR no games"); continue
        try:
            orange, blue = teams_from_file(d / 'teams.txt')
        except Exception:
            orange, blue = [], []
        try:
            det_tl = run_chunks_scores(video, games, orange, blue)
        except subprocess.TimeoutExpired:
            print(f"{name:<12} ERROR chunks timeout"); continue
        r = compare(det_tl, gt_tl)
        if r is None:
            print(f"{name:<12} (GT vide)"); continue
        gf = f"{r['gt_final'][0]}-{r['gt_final'][1]}"
        df = f"{r['det_final'][0]}-{r['det_final'][1]}"
        print(f"{name:<12} {gf:>10} {df:>10} {'OK' if r['final_ok'] else 'KO':>4} "
              f"{r['mae_o']:>6.2f} {r['mae_b']:>6.2f} {r['exact']*100:>6.1f}%",
              flush=True)


if __name__ == '__main__':
    main()
