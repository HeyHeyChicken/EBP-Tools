"""Évalue un modèle Tesseract de pseudos sur un jeu de vrais crops labellisés.

Mesure exact-match et CER (Character Error Rate = Levenshtein / longueur GT),
pour comparer un modèle AVANT/APRÈS entraînement. Sert de test de
non-régression (cf. Tools-Training/pseudo_ocr/).

Le ground-truth vient soit d'un `.gt.txt` du même nom, soit — à défaut — du
nom de fichier au format `<video>_<team>_<idx>_<PSEUDO>` (crops cartouche).

Cartouche : prétraitement = prepare_tesstrain._preprocess (miroir inférence).
Killfeed  : les crops sont déjà binarisés noir-sur-blanc → OCR direct.

Usage :
    TESSDATA_PREFIX=$(pwd)/tessdata \\
    python3 eval_pseudo_ocr.py --crops <dir> --lang evapseudos --mode cartouche
"""

import argparse
import os
from pathlib import Path

from PIL import Image, ImageOps

import eva_ocr
import prepare_tesstrain


def _levenshtein(a, b):
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1,
                           prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def _gt_for(png):
    txt = png.with_suffix('.gt.txt')
    if txt.exists():
        return txt.read_text(encoding='utf-8').strip()
    return prepare_tesstrain._filename_to_pseudo(png.stem)


def _prep(png, mode):
    if mode == 'cartouche':
        return prepare_tesstrain._preprocess(png)
    # killfeed : crop déjà binarisé → pad léger si besoin
    return ImageOps.expand(Image.open(png).convert('RGB'), border=10, fill=255)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--crops', type=Path, required=True)
    ap.add_argument('--lang', required=True)
    ap.add_argument('--mode', choices=['cartouche', 'killfeed'], default='cartouche')
    ap.add_argument('--psm', type=int, default=7)
    ap.add_argument('--whitelist', default='')
    ap.add_argument('--show', type=int, default=15, help='nb d’erreurs à lister')
    args = ap.parse_args()

    pngs = sorted(p for p in args.crops.glob('*.png'))
    n = exact = tot_cer = 0.0
    n = 0
    errors = []
    for png in pngs:
        gt = _gt_for(png)
        if not gt:
            continue
        pil = _prep(png, args.mode)
        out = eva_ocr.recognize(pil, lang=args.lang, psm=args.psm,
                                whitelist=args.whitelist)
        out = out.replace('\r', '').replace('\n', '').strip()
        n += 1
        if out == gt:
            exact += 1
        else:
            errors.append((gt, out))
        tot_cer += _levenshtein(out, gt) / max(1, len(gt))

    print(f'\nmodèle={args.lang}  mode={args.mode}  psm={args.psm}  '
          f'whitelist={"(aucune)" if not args.whitelist else "oui"}')
    print(f'  n={n}  exact-match={exact}/{n} ({100*exact/max(1,n):.1f}%)  '
          f'CER moyen={100*tot_cer/max(1,n):.2f}%')
    if args.show and errors:
        print(f'  erreurs (GT → OCR), {min(args.show, len(errors))} premières :')
        for gt, out in errors[:args.show]:
            print(f'    {gt!r:24} → {out!r}')


if __name__ == '__main__':
    main()
