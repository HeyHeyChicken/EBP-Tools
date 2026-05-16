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


def teams_from_file(path: Path):
    """Parse a `teams.txt` file with two lines:
        orange: pseudo1, pseudo2, pseudo3, pseudo4
        blue:   pseudo1, pseudo2, pseudo3, pseudo4
    Pseudos may be separated by whitespace and/or commas. Returns
    (orange, blue) lists. Raises if the file is missing or both teams empty —
    the orange/blue split must come from a hand-curated source (we used to
    bipartition the kill graph as a fallback, but it required running chunks
    twice per video to discover the correct color assignment)."""
    if not path.exists():
        raise FileNotFoundError(f'teams.txt not found at {path}')
    o, b = [], []
    for line in path.read_text().splitlines():
        line = line.strip()
        if line.startswith('orange:'):
            o = line[len('orange:'):].replace(',', ' ').split()
        elif line.startswith('blue:'):
            b = line[len('blue:'):].replace(',', ' ').split()
    if not o and not b:
        raise ValueError(f'teams.txt at {path} has both teams empty')
    return o, b


def slot_to_name(slot, orange_roster, blue_roster):
    """Slot mapping (shared with analyze_video.py `_player_slot`):
      orange[0..4] → 1..5
      blue[0..3]   → 6..9
      blue[4]      → 0  (10 wraps to 0 so slots stay single-digit)
    `None` (or anything non-int) → empty string (unknown)."""
    if not isinstance(slot, int):
        return ''
    if 1 <= slot <= 5:
        idx = slot - 1
        return orange_roster[idx] if idx < len(orange_roster) else ''
    if 6 <= slot <= 9:
        idx = slot - 6
        return blue_roster[idx] if idx < len(blue_roster) else ''
    if slot == 0:
        return blue_roster[4] if len(blue_roster) > 4 else ''
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
    """Returns (kills, hp_timeline). hp_timeline = {sec_int: {'orange':[...], 'blue':[...]}}."""
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
    hp_timeline = {}
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
            for sec_str, pair in (r.get('payload', {}).get('hp_timeline') or {}).items():
                hp_timeline[int(sec_str)] = pair
    return kills, hp_timeline


def parse_hp_gt(path: Path, max_time_min: int = 10):
    """Parse `MM:SS team h1 h2 h3 h4` (one snapshot per line, sparse).
    Returns list of {'elapsed', 'team', 'hps'}. Lines starting with # are
    ignored. The MM:SS column accepts two conventions, auto-detected from
    the first non-comment line:
      - elapsed (00:00 = start, like kills.txt) if the first MM is < max-1
      - countdown timer in-game (max:00 = start, 00:00 = end) otherwise
    Default max_time_min is 10 (EVA standard). `team` is 'orange' or 'blue'."""
    raw_lines = []
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        raw_lines.append(line)
    if not raw_lines:
        return []
    first_mm = int(raw_lines[0].split()[0].split(':')[0])
    countdown = first_mm >= max_time_min - 1
    out = []
    for line in raw_lines:
        parts = line.split()
        mm, ss = parts[0].split(':')
        ts = int(mm) * 60 + int(ss)
        elapsed = max_time_min * 60 - ts if countdown else ts
        team = parts[1].lower()
        if team not in ('orange', 'blue'):
            continue
        hps = [int(p) for p in parts[2:]]
        out.append({'elapsed': elapsed, 'team': team, 'hps': hps})
    return out


def match_hp(hp_timeline: dict, hp_gt: list):
    """For each (sec, team, hps) in ground truth, look up the same sec in
    hp_timeline (forward-fill: latest sec ≤ target). Compute per-player |Δ|
    and aggregate as MAE + share of measurements within ±5pp. Returns dict
    or None if there's no GT to compare."""
    if not hp_gt:
        return None
    sorted_secs = sorted(hp_timeline)
    diffs = []
    for snap in hp_gt:
        # Forward-fill: pick the most recent sec ≤ snap.elapsed
        applicable = [s for s in sorted_secs if s <= snap['elapsed']]
        if not applicable:
            continue
        det = hp_timeline[applicable[-1]].get(snap['team']) or []
        for i, gt_hp in enumerate(snap['hps']):
            if i >= len(det):
                continue
            diffs.append(abs(det[i] - gt_hp))
    if not diffs:
        return {'n': 0, 'mae': 0.0, 'within5': 0.0}
    mae = sum(diffs) / len(diffs)
    within5 = sum(1 for d in diffs if d <= 5) / len(diffs)
    return {'n': len(diffs), 'mae': mae, 'within5': within5}


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
        video = VIDEO_DIR / name / 'replay.mp4'
        gt    = parse_gt(VIDEO_DIR / name / 'kills.txt')
        try:
            games = run_detect(video)
        except subprocess.TimeoutExpired:
            print(f"{name:<14} ERROR: detect timeout", flush=True)
            continue
        if not games:
            print(f"{name:<14} ERROR: no games detected", flush=True)
            continue
        try:
            orange, blue = teams_from_file(VIDEO_DIR / name / 'teams.txt')
        except (FileNotFoundError, ValueError) as exc:
            print(f"{name:<14} ERROR: {exc}", flush=True)
            continue
        try:
            det, hp_timeline = run_chunks(video, games, orange, blue)
        except subprocess.TimeoutExpired:
            print(f"{name:<14} ERROR: chunks timeout", flush=True)
            continue
        m = match(det, gt)
        print(fmt(name, m), flush=True)
        for k in aggr:
            aggr[k] += m[k]
        hp_path = VIDEO_DIR / name / 'hp.txt'
        if hp_path.exists():
            hp_metrics = match_hp(hp_timeline, parse_hp_gt(hp_path))
            if hp_metrics and hp_metrics['n']:
                print(f"{'  └─ HP:':<14} n={hp_metrics['n']:3d} "
                      f"MAE={hp_metrics['mae']:5.1f}pp "
                      f"within±5pp={hp_metrics['within5']*100:5.1f}%",
                      flush=True)
    print()
    print(fmt('GLOBAL', aggr))


if __name__ == '__main__':
    main()
