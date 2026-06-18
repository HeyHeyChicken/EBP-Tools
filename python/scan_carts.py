"""
QA cart_assignment : compare l'ordre cart→slot détecté à l'identité attendue.

Hypothèse de vérité-terrain (confirmée : « la bonne réponse est [6,7,8,9] ») :
les cartes à l'écran sont dans l'ordre des numéros, et teams.txt liste les
joueurs dans ce même ordre. Donc le cart_assignment CORRECT est l'identité :
  orange → [1,2,3,4(,5)]   blue → [6,7,8,9(,0)]
Une position est FAUSSE si got[i] != expected[i] et got[i] is not None.

Usage : python scan_carts.py [name ...]
"""
import json
import subprocess
import sys
from pathlib import Path

from scan_baseline import (VIDEO_DIR, SCRIPT, PYTHON, FFMPEG, TESSERACT,
                           _run, run_detect, teams_from_file)


def expected(team, n):
    if team == 'orange':
        return [i + 1 for i in range(n)]
    return [(i + 6 if i < 4 else 0) for i in range(n)]


def run_chunks_carts(video, games, orange, blue):
    chunks = [{
        'startSeconds': int(g['start']), 'endSeconds': int(g['end']),
        'gameID': f'g{i}', 'mode': int(g['mode']),
        'orangePlayers': [{'name': n} for n in orange],
        'bluePlayers': [{'name': n} for n in blue],
    } for i, g in enumerate(games)]
    settings = json.dumps({'chunks': chunks})
    cmd = [PYTHON, str(SCRIPT), 'chunks', str(video), FFMPEG, TESSERACT, settings]
    events, _ = _run(cmd, timeout=2400)
    ca = None
    for e in events:
        for r in e.get('results', []) or []:
            c = r.get('payload', {}).get('cart_assignment')
            if c:
                ca = c
    return ca or {}


def score_team(got, exp):
    correct = nulls = wrong = 0
    for i in range(len(exp)):
        g = got[i] if i < len(got) else None
        if g is None:
            nulls += 1
        elif g == exp[i]:
            correct += 1
        else:
            wrong += 1
    return correct, nulls, wrong


def main():
    all_names = sorted(p.parent.name for p in VIDEO_DIR.glob('*/teams.txt'))
    names = sys.argv[1:] or all_names
    print(f"{'video':<14} {'team':<7} {'expected':<16} {'got':<18} ok null wrong")
    print('-' * 72)
    agg = {'ok': 0, 'null': 0, 'wrong': 0}
    for name in names:
        d = VIDEO_DIR / name
        try:
            orange, blue = teams_from_file(d / 'teams.txt')
        except Exception as exc:
            print(f"{name:<14} teams err: {exc}"); continue
        try:
            games = run_detect(d / 'replay.mp4')
        except subprocess.TimeoutExpired:
            print(f"{name:<14} detect timeout"); continue
        if not games:
            print(f"{name:<14} no games"); continue
        ca = run_chunks_carts(d / 'replay.mp4', games, orange, blue)
        for team, roster in (('orange', orange), ('blue', blue)):
            exp = expected(team, len(roster))
            got = ca.get(team, [])
            ok, nu, wr = score_team(got, exp)
            agg['ok'] += ok; agg['null'] += nu; agg['wrong'] += wr
            print(f"{name:<14} {team:<7} {str(exp):<16} {str(got):<18} {ok:>2} {nu:>4} {wr:>5}",
                  flush=True)
    print('-' * 72)
    tot = agg['ok'] + agg['null'] + agg['wrong']
    print(f"TOTAL positions={tot}  ok={agg['ok']}  null={agg['null']}  WRONG={agg['wrong']}")


if __name__ == '__main__':
    main()
