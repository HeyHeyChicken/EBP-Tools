"""Convert validated pseudo crops in `training_data/letters/_unsorted/` into
the tesstrain ground-truth layout (`tesstrain/data/evapseudos-ground-truth/`).

For each `<video>_<team>_<idx>_<PSEUDO>.png`:
  - Apply the same preprocessing pipeline used at inference time
    (Otsu threshold → invert → 4× BICUBIC upscale → white pad), so the model
    trains on the exact distribution it'll see at runtime.
  - Save the preprocessed image as `<sample_id>.png`
  - Write `<sample_id>.gt.txt` containing the pseudo on a single line.
    Trailing `___` (the user's encoding for truncated pseudos) becomes `...`.
  - Skip files whose pseudo part is empty.

After running, train with:
  cd tesstrain
  gmake training MODEL_NAME=evapseudos START_MODEL=eng \\
                 TESSDATA=$(pwd)/usr/share/tessdata MAX_ITERATIONS=10000

Then copy `tesstrain/data/evapseudos.traineddata` to `python/tessdata/`
and switch `_ocr_cart_pseudo` to `lang='evapseudos'`.
"""

import sys
from pathlib import Path

import cv2
from PIL import Image, ImageOps

SRC = Path(__file__).parent / 'training_data' / 'letters' / '_unsorted'
DST = Path(__file__).parent.parent / 'tesstrain' / 'data' / 'evapseudos-ground-truth'


def _preprocess(src_png: Path) -> Image.Image:
    """Mirror of `_ocr_cart_pseudo`'s pipeline so training and inference see
    the same pixel distribution: BGR → grayscale → Otsu binarise → force
    Tesseract polarity (text dark on light bg = minority class becomes black)
    → 4× BICUBIC upscale → 20 px white pad."""
    bgr = cv2.imread(str(src_png))
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    # Otsu doesn't know which side is text; whichever class is the minority
    # is the text. Force text=0 (black) and bg=255 (white) by inverting if
    # there are more zeros than 255s.
    if (bw == 0).sum() > (bw == 255).sum():
        bw = 255 - bw
    pil = Image.fromarray(bw).resize(
        (bw.shape[1] * 4, bw.shape[0] * 4), Image.BICUBIC
    )
    return ImageOps.expand(pil, border=20, fill=255).convert('RGB')


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
        _preprocess(png).save(DST / f'{sample}.png')
        (DST / f'{sample}.gt.txt').write_text(pseudo + '\n')
        n_ok += 1
    print(f'\nWrote {n_ok} samples to {DST} (skipped {n_skip}).')


if __name__ == '__main__':
    main()
