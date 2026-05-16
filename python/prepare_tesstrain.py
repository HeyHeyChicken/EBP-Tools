"""Convert validated pseudo crops in `training_data/letters/_unsorted/` into
the tesstrain ground-truth layout (`tesstrain/data/evapseudos-ground-truth/`).

For each `<video>_<team>_<idx>_<PSEUDO>.png`:
  - Copy the image as `<sample_id>.png`
  - Write `<sample_id>.gt.txt` containing the pseudo on a single line.
    Trailing `___` (the user's encoding for truncated pseudos) becomes `...`.
  - Skip files whose pseudo part is empty.

After running, train with:
  cd tesstrain
  make training MODEL_NAME=evapseudos START_MODEL=eng \\
                TESSDATA=/opt/homebrew/share/tessdata MAX_ITERATIONS=10000

Then copy `tesstrain/data/evapseudos.traineddata` to `python/tessdata/`
and switch `_ocr_cart_pseudo` to `lang='evapseudos'`.
"""

import shutil
import sys
from pathlib import Path

SRC = Path(__file__).parent / 'training_data' / 'letters' / '_unsorted'
DST = Path(__file__).parent.parent / 'tesstrain' / 'data' / 'evapseudos-ground-truth'


def _filename_to_pseudo(stem: str) -> str:
    """`cliff_orange_0_TTLXOXYD76` → `TTLXOXYD76`.
    `artefact_blue_2_LNTXPRIM___` → `LNTXPRIM...` (trailing `___` → `...`)."""
    parts = stem.split('_')
    if len(parts) < 4:
        return ''
    pseudo = '_'.join(parts[3:])
    # Convert trailing underscores (user-encoded `...`) back to dots.
    stripped = pseudo.rstrip('_')
    n_trail = len(pseudo) - len(stripped)
    if n_trail >= 3:
        pseudo = stripped + '.' * n_trail
    return pseudo


def main():
    if not SRC.exists():
        print(f'ERROR: source dir not found: {SRC}', file=sys.stderr)
        sys.exit(1)
    DST.mkdir(parents=True, exist_ok=True)
    n_ok = n_skip = 0
    for png in sorted(SRC.glob('*.png')):
        pseudo = _filename_to_pseudo(png.stem)
        if not pseudo:
            print(f'  skip (no pseudo): {png.name}')
            n_skip += 1
            continue
        sample = png.stem
        shutil.copy2(png, DST / f'{sample}.png')
        (DST / f'{sample}.gt.txt').write_text(pseudo + '\n')
        n_ok += 1
    print(f'\nWrote {n_ok} samples to {DST} (skipped {n_skip}).')


if __name__ == '__main__':
    main()
