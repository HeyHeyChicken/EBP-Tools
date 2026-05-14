"""
QA orchestrator: replays analyze_video.py (detect → chunks) on each video in
/Users/antoine/Desktop/test/video/, matches the detected killfeed against the
ground-truth `<name>.txt`, and prints one line per video in the same format
as `_scan_baseline.txt`.

Matching rules (strict):
  - TP if |Δt| ≤ 3 s AND killer normalized equals AND victim normalized equals
  - normalize = lower + strip
  - each ground-truth kill matched at most once (greedy by smallest |Δt|)
  - weap_tot = TP whose ground-truth weapon ∈ template set
  - weap_ok  = weap_tot whose detected weapon equals ground-truth weapon
  - hs_tot   = TP
  - hs_ok    = hs_tot whose detected headshot bool equals ground-truth

Usage:
  python scan_baseline.py                  # runs all 13 videos
  python scan_baseline.py cliff3 ceres     # runs only the named videos
"""

import json
import subprocess
import sys
from pathlib import Path

VIDEO_DIR = Path('/Users/antoine/Desktop/test/video')
SCRIPT    = Path(__file__).parent / 'analyze_video.py'
PYTHON    = sys.executable
FFMPEG    = '/opt/homebrew/bin/ffmpeg'
TESSERACT = '/opt/homebrew/bin/tesseract'

TIME_WINDOW = 3

WEAPON_SET = {
    'admin', 'ak77', 'atlas', 'fury', 'grenade', 'm12', 'mp52', 'mx42',
    'needle', 'socom', 'spectre', 'striker', 't1gauss', 'warden', 'westfire',
}

VIDEOS = [
    'artefact', 'atlantis', 'ceres', 'cliff', 'cliff2', 'cliff3', 'engine',
    'heliosstation', 'horizon', 'lunar', 'outlaw', 'polaris', 'silva',
]


def parse_gt(path: Path):
    """Parse `MM:SS killer victim weapon [headshot]` into list of dicts."""
    out = []
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line:
            continue
        parts = line.split()
        mm, ss = parts[0].split(':')
        elapsed = int(mm) * 60 + int(ss)
        killer = parts[1]
        victim = parts[2]
        weapon = parts[3] if len(parts) > 3 else ''
        headshot = any(p == 'headshot' for p in parts[4:])
        out.append({
            'elapsed': elapsed, 'killer': killer, 'victim': victim,
            'weapon': weapon, 'headshot': headshot,
        })
    return out


def teams_from_gt(gt: list):
    """2-color the kill graph to split pseudos into two teams (each kill must
    be cross-team). Returns (team_A, team_B) as ordered lists. If a connected
    component is not bipartite, falls back to dumping the whole component into
    team A (best-effort — that component will be poorly matched). We don't
    know which team is orange and which is blue at render time, so the caller
    must try both assignments."""
    valid = lambda n: any(c.isalnum() for c in n)
    nodes = []
    edges = {}
    for k in gt:
        for n in (k['killer'], k['victim']):
            if valid(n) and n not in edges:
                edges[n] = set()
                nodes.append(n)
        if valid(k['killer']) and valid(k['victim']):
            edges[k['killer']].add(k['victim'])
            edges[k['victim']].add(k['killer'])
    color = {}
    for start in nodes:
        if start in color:
            continue
        color[start] = 0
        stack = [start]
        while stack:
            u = stack.pop()
            for v in edges[u]:
                if v not in color:
                    color[v] = 1 - color[u]
                    stack.append(v)
    team_a = [n for n in nodes if color[n] == 0]
    team_b = [n for n in nodes if color[n] == 1]
    return team_a, team_b


def slot_to_name(slot, orange_roster, blue_roster):
    """Slot mapping in analyze_video.py: orange[0..3] → 1..4, blue[0..3] → 6..9."""
    if not isinstance(slot, int):
        return str(slot)
    if 1 <= slot <= 4:
        idx = slot - 1
        return orange_roster[idx] if 0 <= idx < len(orange_roster) else ''
    if 6 <= slot <= 9:
        idx = slot - 6
        return blue_roster[idx] if 0 <= idx < len(blue_roster) else ''
    return ''


def _run(cmd, timeout):
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    events = []
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except Exception:
            pass
    return events, proc.stderr


def run_detect(video: Path):
    cmd = [PYTHON, str(SCRIPT), 'detect', str(video), FFMPEG, TESSERACT, '{}']
    events, _ = _run(cmd, timeout=900)
    return [e['game'] for e in events if e.get('type') == 'game']


def run_chunks(video: Path, games: list, orange_roster: list, blue_roster: list):
    chunks = [{
        'startSeconds':  int(g['start']),
        'endSeconds':    int(g['end']),
        'gameID':        f'g{i}',
        'mode':          int(g['mode']),
        'orangePlayers': [{'name': n} for n in orange_roster],
        'bluePlayers':   [{'name': n} for n in blue_roster],
    } for i, g in enumerate(games)]
    settings = json.dumps({'chunks': chunks})
    cmd = [PYTHON, str(SCRIPT), 'chunks', str(video), FFMPEG, TESSERACT, settings]
    events, _ = _run(cmd, timeout=2400)
    kills = []
    for e in events:
        for r in e.get('results', []) or []:
            for k in r.get('payload', {}).get('kills', []) or []:
                # V3 positional: [elapsed, killer_slot, victim_slot, weapon, headshot]
                kills.append({
                    'elapsed':  int(k[0]),
                    'killer':   slot_to_name(k[1], orange_roster, blue_roster),
                    'victim':   slot_to_name(k[2], orange_roster, blue_roster),
                    'weapon':   (k[3] or '').strip().lower(),
                    'headshot': bool(k[4]),
                })
    return kills


def match(detected, gt):
    used = [False] * len(gt)
    tp = fp = 0
    pairs = []
    for d in detected:
        dk = d['killer'].strip().lower()
        dv = d['victim'].strip().lower()
        best, best_dt = None, None
        for i, g in enumerate(gt):
            if used[i]:
                continue
            if g['killer'].strip().lower() != dk:
                continue
            if g['victim'].strip().lower() != dv:
                continue
            dt = abs(d['elapsed'] - g['elapsed'])
            if dt > TIME_WINDOW:
                continue
            if best is None or dt < best_dt:
                best, best_dt = i, dt
        if best is None:
            fp += 1
        else:
            used[best] = True
            tp += 1
            pairs.append((d, gt[best]))
    fn = sum(1 for u in used if not u)

    weap_ok = weap_tot = hs_ok = hs_tot = 0
    for d, g in pairs:
        hs_tot += 1
        if bool(d['headshot']) == bool(g['headshot']):
            hs_ok += 1
        gw = g['weapon'].strip().lower()
        if gw in WEAPON_SET:
            weap_tot += 1
            if d['weapon'] == gw:
                weap_ok += 1
    return {'ref': len(gt), 'det': len(detected), 'tp': tp, 'fp': fp, 'fn': fn,
            'weap_ok': weap_ok, 'weap_tot': weap_tot,
            'hs_ok': hs_ok, 'hs_tot': hs_tot}


def fmt(name, m):
    tp, fp, fn = m['tp'], m['fp'], m['fn']
    p = tp / (tp + fp) if (tp + fp) else 0.0
    r = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * p * r / (p + r) if (p + r) else 0.0
    return (f"{name:<14} {m['ref']:3d} {m['det']:3d} {m['tp']:3d} "
            f"{m['fp']:3d} {m['fn']:3d} {p:.3f} {r:.3f} {f1:.3f} "
            f"{m['weap_ok']:3d} {m['weap_tot']:3d} {m['hs_ok']:3d} {m['hs_tot']:3d}")


def main():
    names = sys.argv[1:] or VIDEOS
    print("# columns: video ref det TP FP FN precision recall F1 weap_ok weap_tot hs_ok hs_tot")
    aggr = {k: 0 for k in
            ('ref', 'det', 'tp', 'fp', 'fn', 'weap_ok', 'weap_tot', 'hs_ok', 'hs_tot')}
    for name in names:
        video = VIDEO_DIR / f'{name}.mp4'
        gt    = parse_gt(VIDEO_DIR / f'{name}.txt')
        try:
            games = run_detect(video)
        except subprocess.TimeoutExpired:
            print(f"{name:<14} ERROR: detect timeout", flush=True)
            continue
        if not games:
            print(f"{name:<14} ERROR: no games detected", flush=True)
            continue
        team_a, team_b = teams_from_gt(gt)
        # We don't know which team is rendered orange. Run chunks twice (once
        # per assignment) and keep the one with more TP. Chunks is the
        # expensive call, but doubling it on 13 short videos is acceptable
        # for QA.
        best = None
        for orange, blue in ((team_a, team_b), (team_b, team_a)):
            try:
                det = run_chunks(video, games, orange, blue)
            except subprocess.TimeoutExpired:
                print(f"{name:<14} ERROR: chunks timeout", flush=True)
                det = None
                break
            cand = match(det, gt)
            if best is None or cand['tp'] > best['tp']:
                best = cand
        if best is None:
            continue
        m = best
        print(fmt(name, m), flush=True)
        for k in aggr:
            aggr[k] += m[k]
    print()
    print(fmt('GLOBAL', aggr))


if __name__ == '__main__':
    main()
