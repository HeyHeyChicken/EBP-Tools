#!/usr/bin/env python3
"""Annotation / vérification manuelle des scores pour un dossier de frames `tmp/`.

Outil clavier (fenêtre OpenCV) pour construire la vérité-terrain `scores.txt`
(tests de non-régression de analyze_video.py), indépendamment de l'OCR du code
testé.

Principe : on parcourt les frames (0000.jpg, 0001.jpg, ...) une par une. Les
valeurs sont « collantes » (reprises de la frame précédente) et le timer
s'auto-décrémente de 1 s par frame. On ne touche donc qu'aux frames où un score
change, ou quand le timer dérape (pause de pré-partie, etc.).

Sorties :
  - scores.txt          : format artefact, une ligne par CHANGEMENT de score
                          (MM:SS orange blue). Réécrit à chaque commit.
  - <tmp>/.annotations.csv : log par frame (frame,timer,orange,blue,skip),
                          relu au démarrage pour reprendre / vérifier.

Raccourcis (rappelés en bas de la fenêtre — clique d'abord sur la fenêtre) :
  ← / →           : frame précédente / suivante SANS valider
  Espace / Entrée : valide la frame et avance
  a               : frame précédente
  o / l           : orange +1 / -1     (O / L = +10 / -10)
  p / m           : blue   +1 / -1     (P / M = +10 / -10)
  [ / ]           : timer +1 s / -1 s
  t               : saisir le timer (MM:SS, dans le terminal)
  x               : marquer « pas de HUD » (frame exclue du scores.txt)
  v               : afficher la frame entière / le crop HUD
  g               : aller à une frame (numéro, dans le terminal)
  Échap           : sauvegarde et quitte
"""
import argparse
import csv
import os
import sys

import cv2

# Zone HUD haut-centre (orange% | timer | blue%) en pixels plein écran 1920x1080.
DEFAULT_CROP = (845, 40, 1115, 110)
WIN = 'annotate_scores'

# Codes des flèches retournés par cv2.waitKeyEx selon le backend (macOS / Windows / Qt-GTK).
KEYS_LEFT = {63234, 2424832, 65361}
KEYS_RIGHT = {63235, 2555904, 65363}


def parse_args():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('tmp_dir', help='dossier contenant les frames 0000.jpg, ...')
    p.add_argument('-o', '--out', default=None,
                   help='fichier scores.txt (défaut : <tmp_dir>/../scores.txt)')
    p.add_argument('--start-timer', default='10:00', help='timer de la 1re frame (MM:SS)')
    p.add_argument('--crop', type=int, nargs=4, metavar=('X0', 'Y0', 'X1', 'Y1'),
                   default=DEFAULT_CROP, help='zone HUD à zoomer (défaut : %(default)s)')
    p.add_argument('--scale', type=int, default=4, help='zoom du crop HUD (défaut : 4)')
    return p.parse_args()


def mmss_to_secs(s):
    m, sec = s.strip().split(':')
    return int(m) * 60 + int(sec)


def secs_to_mmss(t):
    t = max(0, int(t))
    return f'{t // 60:02d}:{t % 60:02d}'


class Annotator:
    def __init__(self, args):
        self.args = args
        self.crop = tuple(args.crop)
        self.scale = args.scale
        self.tmp_dir = args.tmp_dir
        self.files = sorted(f for f in os.listdir(args.tmp_dir)
                            if f.lower().endswith(('.jpg', '.jpeg', '.png')))
        if not self.files:
            sys.exit(f'Aucune image dans {args.tmp_dir}')
        self.out = args.out or os.path.join(
            os.path.dirname(os.path.abspath(args.tmp_dir.rstrip('/'))), 'scores.txt')
        self.sidecar = os.path.join(args.tmp_dir, '.annotations.csv')

        self.ann = [None] * len(self.files)   # (timer, orange, blue) ou None si skip/non-annoté
        self.done = [False] * len(self.files)
        self._load_sidecar()

        self.timer = mmss_to_secs(args.start_timer)
        self.orange = 0
        self.blue = 0
        self.skip = False
        self.show_full = False
        self.i = self._first_unannotated()

    # ----- persistance -------------------------------------------------------
    def _load_sidecar(self):
        if not os.path.exists(self.sidecar):
            return
        idx = {f: k for k, f in enumerate(self.files)}
        with open(self.sidecar, newline='') as fh:
            for row in csv.DictReader(fh):
                k = idx.get(row['frame'])
                if k is None:
                    continue
                self.done[k] = True
                self.ann[k] = None if row['skip'] == '1' else (
                    int(row['timer']), int(row['orange']), int(row['blue']))

    def _save_sidecar(self):
        with open(self.sidecar, 'w', newline='') as fh:
            w = csv.writer(fh)
            w.writerow(['frame', 'timer', 'orange', 'blue', 'skip'])
            for k, f in enumerate(self.files):
                if not self.done[k]:
                    continue
                if self.ann[k] is None:
                    w.writerow([f, '', '', '', 1])
                else:
                    w.writerow([f, *self.ann[k], 0])

    def _write_scores(self):
        lines, last = [], None
        for k in range(len(self.files)):
            if not self.done[k] or self.ann[k] is None:
                continue
            t, o, b = self.ann[k]
            if (o, b) != last:
                lines.append(f'{secs_to_mmss(t)} {o} {b}')
                last = (o, b)
        with open(self.out, 'w') as fh:
            fh.write('\n'.join(lines) + ('\n' if lines else ''))

    def _first_unannotated(self):
        for k in range(len(self.files)):
            if not self.done[k]:
                return k
        return 0

    # ----- rendu -------------------------------------------------------------
    def _enter_frame(self, i, first=False):
        self.i = i
        if self.ann[i] is not None:
            self.timer, self.orange, self.blue = self.ann[i]
            self.skip = False
        elif self.done[i]:
            self.skip = True
        else:
            self.skip = False
            if not first:
                self.timer = max(0, self.timer - 1)

    def _render(self):
        path = os.path.join(self.tmp_dir, self.files[self.i])
        im = cv2.imread(path)
        if self.show_full:
            top = cv2.resize(im, (1080, 608))
        else:
            x0, y0, x1, y1 = self.crop
            crop = im[y0:y1, x0:x1]
            top = cv2.resize(crop, ((x1 - x0) * self.scale, (y1 - y0) * self.scale),
                             interpolation=cv2.INTER_NEAREST)
            top = cv2.copyMakeBorder(top, 0, 0, 0, max(0, 1080 - top.shape[1]),
                                     cv2.BORDER_CONSTANT, value=(0, 0, 0))
        W = top.shape[1]
        panel = self._panel(W)
        canvas = cv2.vconcat([top, panel])
        cv2.imshow(WIN, canvas)

    def _panel(self, W):
        import numpy as np
        h = 150
        p = np.zeros((h, W, 3), dtype=np.uint8)
        font = cv2.FONT_HERSHEY_SIMPLEX
        n, n_done = len(self.files), sum(self.done)
        head = f'[{self.i + 1}/{n}]  {self.files[self.i]}    ({n_done} annotees)'
        cv2.putText(p, head, (10, 26), font, 0.6, (200, 200, 200), 1, cv2.LINE_AA)
        if self.skip:
            cv2.putText(p, 'SKIP (pas de HUD)', (10, 64), font, 0.9,
                        (150, 150, 150), 2, cv2.LINE_AA)
        else:
            cv2.putText(p, secs_to_mmss(self.timer), (10, 66), font, 0.95,
                        (255, 255, 255), 2, cv2.LINE_AA)
            cv2.putText(p, f'orange {self.orange}', (180, 66), font, 0.95,
                        (60, 150, 255), 2, cv2.LINE_AA)
            cv2.putText(p, f'blue {self.blue}', (430, 66), font, 0.95,
                        (255, 170, 60), 2, cv2.LINE_AA)
        l1 = '< / >: naviguer sans valider   ESPACE/ENTREE: valider+suivant   o/l: orange +/-1   p/m: blue +/-1   (MAJ=+/-10)'
        l2 = '[ / ]: timer +/-1s   t: timer   x: pas de HUD   v: frame entiere   g: aller a   ECHAP: quitter'
        cv2.putText(p, l1, (10, 110), font, 0.45, (130, 130, 130), 1, cv2.LINE_AA)
        cv2.putText(p, l2, (10, 134), font, 0.45, (130, 130, 130), 1, cv2.LINE_AA)
        return p

    # ----- actions -----------------------------------------------------------
    def _bump(self, attr, d):
        if self.skip:
            self.skip = False
        setattr(self, attr, max(0, getattr(self, attr) + d))

    def _save_current(self):
        self.done[self.i] = True
        self.ann[self.i] = None if self.skip else (self.timer, self.orange, self.blue)

    def _commit_next(self):
        self._save_current()
        self._save_sidecar()
        self._write_scores()
        if self.i + 1 < len(self.files):
            self._enter_frame(self.i + 1)

    def _ask(self, prompt):
        cv2.setWindowTitle(WIN, 'saisie dans le terminal...')
        try:
            return input(prompt)
        except EOFError:
            return ''
        finally:
            cv2.setWindowTitle(WIN, WIN)

    # ----- boucle ------------------------------------------------------------
    def run(self):
        cv2.namedWindow(WIN, cv2.WINDOW_AUTOSIZE)
        self._enter_frame(self.i, first=True)
        while True:
            self._render()
            key = cv2.waitKeyEx(0)
            if key == -1 or cv2.getWindowProperty(WIN, cv2.WND_PROP_VISIBLE) < 1:
                break
            if key in KEYS_LEFT:        # flèche gauche : reculer sans valider
                if self.i > 0:
                    self._enter_frame(self.i - 1)
                continue
            if key in KEYS_RIGHT:       # flèche droite : avancer sans valider
                if self.i + 1 < len(self.files):
                    self._enter_frame(self.i + 1)
                continue
            k = key & 0xFF
            if k in (32, 13, 10):       # espace / entrée
                self._commit_next()
            elif k == ord('a'):
                if self.i > 0:
                    self._enter_frame(self.i - 1)
            elif k == ord('o'):
                self._bump('orange', +1)
            elif k == ord('O'):
                self._bump('orange', +10)
            elif k == ord('l'):
                self._bump('orange', -1)
            elif k == ord('L'):
                self._bump('orange', -10)
            elif k == ord('p'):
                self._bump('blue', +1)
            elif k == ord('P'):
                self._bump('blue', +10)
            elif k == ord('m'):
                self._bump('blue', -1)
            elif k == ord('M'):
                self._bump('blue', -10)
            elif k == ord('['):
                self.timer = max(0, self.timer + 1)
            elif k == ord(']'):
                self.timer = max(0, self.timer - 1)
            elif k == ord('t'):
                v = self._ask('Timer MM:SS : ')
                try:
                    self.timer = mmss_to_secs(v)
                    self.skip = False
                except (ValueError, IndexError):
                    pass
            elif k == ord('x'):
                self.skip = not self.skip
            elif k == ord('v'):
                self.show_full = not self.show_full
            elif k == ord('g'):
                v = self._ask(f'Aller a la frame (1..{len(self.files)}) : ')
                if v.strip().isdigit():
                    j = int(v) - 1
                    if 0 <= j < len(self.files):
                        self._enter_frame(j)
            elif k == 27:               # échap
                break
        self._save_sidecar()
        self._write_scores()
        cv2.destroyAllWindows()


if __name__ == '__main__':
    Annotator(parse_args()).run()
