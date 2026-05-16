"""Extract one cropped pseudo banner per player per video into
`training_data/letters/_unsorted/` so they can be sorted by hand and fed to
tesstrain (target model: `evapseudos`).

For each video in /Users/antoine/Desktop/test/video/<name>/:
  - Read teams.txt → orange/blue rosters (= ground truth left-to-right cart
    order, per the user)
  - Detect game.start via `analyze_video.py detect` (subprocess)
  - Sample 1 frame ~10 s into the game (everybody at full HP, banner stable)
  - For each on-screen cart, crop the pseudo band (y_offset / height from the
    canonical _PLAYER_PSEUDO_* constants) and save as PNG named
    `<video>_<team>_<idx>_<expected_pseudo>.png` so the user can verify and
    rename.

Run:  python extract_pseudo_samples.py
"""

import json
import subprocess
import sys
from pathlib import Path

import cv2

sys.path.insert(0, str(Path(__file__).parent))
import analyze_video as av
from scan_baseline import teams_from_file, run_detect, VIDEO_DIR

OUT_DIR = Path(__file__).parent / 'training_data' / 'letters' / '_unsorted'

VIDEOS = ['artefact', 'atlantis', 'ceres', 'cliff', 'cliff2', 'cliff3',
          'engine', 'heliosstation', 'horizon', 'lunar', 'outlaw',
          'polaris', 'silva']

# Sample at this offset (in-game seconds) from game start. ~10 s in is past
# any intro/spawn animation but typically before the first kill, so all 8/10
# carts are still full HP and the pseudo banner is unobscured.
SAMPLE_OFFSET_SEC = 10


def _crop_pseudo(frame_bgr, cart_x: int, cart_w: int, anchor):
    y1, y2 = av._player_pseudo_band(anchor)
    return frame_bgr[y1:y2, cart_x:cart_x + cart_w]


def _safe_filename_part(s: str) -> str:
    return ''.join(c if c.isalnum() else '_' for c in s)


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name in VIDEOS:
        folder = VIDEO_DIR / name
        replay = folder / 'replay.mp4'
        teams = folder / 'teams.txt'
        if not replay.exists() or not teams.exists():
            print(f'{name}: missing replay or teams.txt, skip', flush=True)
            continue
        try:
            orange, blue = teams_from_file(teams)
        except Exception as exc:
            print(f'{name}: teams parse error: {exc}', flush=True)
            continue
        try:
            games = run_detect(replay)
        except Exception as exc:
            print(f'{name}: detect error: {exc}', flush=True)
            continue
        if not games:
            print(f'{name}: no games detected, skip', flush=True)
            continue
        # Take the first game; sample at start + SAMPLE_OFFSET_SEC.
        game_start = float(games[0]['start'])
        sample_ts = game_start + SAMPLE_OFFSET_SEC
        # Read the frame via OpenCV (msec-accurate seek).
        cap = cv2.VideoCapture(str(replay))
        cap.set(cv2.CAP_PROP_POS_MSEC, sample_ts * 1000)
        ok, frame = cap.read()
        cap.release()
        if not ok or frame is None:
            print(f'{name}: failed to read frame at {sample_ts:.1f}s', flush=True)
            continue
        # Locate the playing_top anchor on this frame to derive the pseudo
        # band y-range (cart_y and pseudo height/offset are anchor-relative).
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        anchor = av._find_playing_top_anchor(rgb)
        if anchor is None:
            print(f'{name}: no HUD anchor at {sample_ts:.1f}s, skip', flush=True)
            continue
        n_o, n_b = len(orange), len(blue)
        max_n = max(n_o, n_b)
        w = av._player_cart_w(max_n)
        for team, n, roster in (('orange', n_o, orange), ('blue', n_b, blue)):
            for i in range(n):
                x = av._player_cart_x_left(team, i, n, max_n)
                crop = _crop_pseudo(frame, x, w, anchor)
                expected = roster[i] if i < len(roster) else ''
                fname = (f'{name}_{team}_{i}_'
                         f'{_safe_filename_part(expected.upper())}.png')
                cv2.imwrite(str(OUT_DIR / fname), crop)
        print(f'{name}: saved {n_o + n_b} crops (game_start={game_start:.1f}s '
              f'+{SAMPLE_OFFSET_SEC}s)', flush=True)


if __name__ == '__main__':
    main()
