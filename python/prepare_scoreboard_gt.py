#!/usr/bin/env python3
"""Génère les données d'entraînement tesstrain pour un modèle OCR pseudo
spécifique au scoreboard (`evascores`), à partir des frames annotées de
Tools-Training.

Pour chaque pseudo affiché sur UNE ligne (les pseudos wrappés sur 2 lignes
sont ignorés : on ne peut pas répartir le label entre les lignes), on produit
les MÊMES variantes binarisées que celles vues à l'inférence
(scoreboard_read._line_images : masque couleur-du-texte à 3 tolérances + Otsu,
glyphes ramenés à ~32 px, pad blanc), chacune appariée au pseudo attendu.
Entraîner sur la distribution exacte de l'inférence est ce qui a fait
marcher evadigits/evapseudos.

Découpe train/test par FRAME (via --test) : aucune frame de test ne fournit
d'échantillon d'entraînement, pour mesurer la généralisation sur du non-vu.

Sortie : tesstrain/data/<model>-ground-truth/<id>.png + <id>.gt.txt

Usage :
  python prepare_scoreboard_gt.py --frames <dir> [--model evascores]
         [--test f1,f2,...]
"""
import argparse
import os
import sys

import cv2
from PIL import Image

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import scoreboard_read as sr
import scoreboard_zones as sz


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--frames', required=True, help='dossier des frames + .txt')
    ap.add_argument('--model', default='evascores')
    ap.add_argument('--test', default='', help='frames de test (csv), exclues')
    ap.add_argument('--test-out', default='', help='écrit la liste des frames de test')
    args = ap.parse_args()

    test = {t.strip() for t in args.test.split(',') if t.strip()}
    dst = os.path.join(_HERE, '..', 'tesstrain', 'data',
                       f'{args.model}-ground-truth')
    os.makedirs(dst, exist_ok=True)
    for f in os.listdir(dst):
        os.remove(os.path.join(dst, f))

    n_samples = 0
    train_frames = []
    for png in sorted(os.listdir(args.frames)):
        if not png.endswith('.png'):
            continue
        name = png[:-4]
        txt = os.path.join(args.frames, name + '.txt')
        if not os.path.isfile(txt) or name in test:
            continue
        gt = sr.parse_gt(txt)
        if any(p['name'] == 'JOUEUR' for p in gt['players']):
            continue
        img = cv2.imread(os.path.join(args.frames, png))
        z = sz.zones_for_frame(img)
        if z['layout'] == 'unknown':
            continue
        train_frames.append(name)
        h, w = img.shape[:2]
        img_1080 = img if (w, h) == (1920, 1080) else cv2.resize(img, (1920, 1080))
        z1080 = sz.zones_for_frame(img_1080)
        for p, gp in zip(z1080['players'], gt['players']):
            crop = sr._crop(img_1080, p['name'])
            lines = sr._name_lines(crop)
            if len(lines) != 1:
                continue   # pseudo wrappé : label non répartissable
            for vi, pil in enumerate(sr._line_images(lines[0])):
                sid = f'{name}_{gp["name"]}_{vi}'
                pil.save(os.path.join(dst, f'{sid}.png'))
                with open(os.path.join(dst, f'{sid}.gt.txt'), 'w',
                          encoding='utf-8') as fh:
                    fh.write(gp['name'].upper())
                n_samples += 1

    if args.test_out:
        with open(args.test_out, 'w') as fh:
            fh.write('\n'.join(sorted(test)))
    print(f'{n_samples} échantillons écrits dans {dst}')
    print(f'frames train : {len(train_frames)} | frames test exclues : {sorted(test)}')


if __name__ == '__main__':
    sys.exit(main())
