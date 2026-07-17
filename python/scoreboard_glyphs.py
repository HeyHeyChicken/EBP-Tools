#!/usr/bin/env python3
"""Atlas de glyphes du scoreboard (« formes apprises », comme le killfeed).

La police des chiffres/pseudos du scoreboard EVA est fixe mais stylisée (4
ouvert, 7 barré, 5 carré...) : Tesseract la lit mal même bien binarisée. On
classifie donc chaque glyphe par template matching contre un atlas extrait
une fois pour toutes des frames annotées.

Atlas : templates/scoreboard_glyphs/<char>_<n>.png — glyphes binaires (encre
noire sur blanc) normalisés NORM×NORM. Harvest : `python scoreboard_glyphs.py
harvest DIR` segmente les zones score/K/D/A des frames de DIR et aligne les
glyphes sur les valeurs des .txt (uniquement quand le compte de segments
correspond — alignement sans ambiguïté).

API :
  classify(bw)      -> (char, confidence) pour un glyphe binarisé
  read_digits(bw)   -> str : segmente une ligne binarisée et classifie
"""
import collections
import os
import sys

import cv2
import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
ATLAS_DIR = os.path.join(_HERE, 'templates', 'scoreboard_glyphs')
NORM = 32          # taille de normalisation des glyphes
MIN_SEG_W = 4      # largeur mini d'un segment (px, à hauteur 48)
MIN_CONF = 0.75    # similarité mini pour accepter une classification


def segment(bw, min_w=MIN_SEG_W):
    """Segments [x0, x1) des glyphes d'une ligne binarisée (encre == 0),
    séparés par des colonnes vides."""
    ink = (bw == 0)
    cols = ink.sum(axis=0)
    segs, start = [], None
    for i, c in enumerate(cols):
        if c > 0 and start is None:
            start = i
        elif c == 0 and start is not None:
            if i - start >= min_w:
                segs.append((start, i))
            start = None
    if start is not None and len(cols) - start >= min_w:
        segs.append((start, len(cols)))
    return segs


def _normalize(glyph_bw):
    """Glyphe binaire recadré serré puis mis à l'échelle NORM×NORM (étiré :
    la forme relative suffit, la police est unique)."""
    ink = (glyph_bw == 0)
    ys, xs = np.where(ink)
    if not len(ys):
        return None
    tight = glyph_bw[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    return cv2.resize(tight, (NORM, NORM), interpolation=cv2.INTER_AREA)


class Atlas:
    def __init__(self, atlas_dir=ATLAS_DIR):
        self.templates = []          # (char, glyphe NORM×NORM float ±1)
        if os.path.isdir(atlas_dir):
            for f in sorted(os.listdir(atlas_dir)):
                if not f.endswith('.png'):
                    continue
                char = f.split('_')[0]
                img = cv2.imread(os.path.join(atlas_dir, f),
                                 cv2.IMREAD_GRAYSCALE)
                if img is not None:
                    self.templates.append((char, self._signed(img)))

    @staticmethod
    def _signed(bw):
        """binaire → ±1 float : le produit scalaire devient un accord signé
        (encre commune ET fond commun comptent, désaccord pénalise)."""
        return np.where(bw < 128, 1.0, -1.0).astype(np.float32)

    MARGIN = 0.02   # écart mini best vs 2e caractère (sinon ambigu → abstention)

    def classify(self, glyph_bw, charset=None):
        """(char, similarité 0-1) du glyphe binarisé. ('', 0) si atlas vide
        ou si deux caractères différents sont trop proches pour trancher
        (ex. 5/6 sur des petits glyphes épaissis par l'upscale).
        `charset` restreint les templates comparés (chiffres seuls pour les
        zones numériques : sans ça un chiffre dégradé peut matcher une
        lettre de l'atlas)."""
        norm = _normalize(glyph_bw)
        if norm is None or not self.templates:
            return '', 0.0
        best = {}
        for char, tpl in self.templates:
            if charset is not None and char not in charset:
                continue
            sim = float((self._signed(norm) * tpl).mean())
            if sim > best.get(char, -1.0):
                best[char] = sim
        if not best:
            return '', 0.0
        ranked = sorted(best.items(), key=lambda kv: -kv[1])
        char, sim = ranked[0]
        if len(ranked) > 1 and sim - ranked[1][1] < self.MARGIN:
            return '', (sim + 1.0) / 2.0
        return char, (sim + 1.0) / 2.0

    def read(self, bw, min_conf=MIN_CONF, charset=None):
        """Segmente une ligne binarisée et classifie chaque glyphe.
        Retourne (texte, confiance_min) — texte '' si un glyphe est sous le
        seuil (on préfère l'abstention à l'invention)."""
        out, worst = [], 1.0
        for x0, x1 in segment(bw):
            char, conf = self.classify(bw[:, x0:x1], charset=charset)
            worst = min(worst, conf)
            if conf < min_conf:
                return '', worst
            out.append(char)
        return ''.join(out), worst


_DEFAULT = None


def default_atlas():
    global _DEFAULT
    if _DEFAULT is None:
        _DEFAULT = Atlas()
    return _DEFAULT


# ---------------------------------------------------------------------------
# Harvest depuis les frames annotées
# ---------------------------------------------------------------------------

def _harvest(frames_dir, max_per_char=6):
    import scoreboard_zones
    import scoreboard_read

    os.makedirs(ATLAS_DIR, exist_ok=True)
    counts = collections.Counter()
    for png in sorted(os.listdir(frames_dir)):
        if not png.endswith('.png'):
            continue
        txt = os.path.join(frames_dir, png[:-4] + '.txt')
        if not os.path.isfile(txt):
            continue
        gt = scoreboard_read.parse_gt(txt)
        if any(p['name'] == 'JOUEUR' for p in gt['players']):
            continue
        img = cv2.imread(os.path.join(frames_dir, png))
        zones = scoreboard_zones.zones_for_frame(img)
        if zones['layout'] == 'unknown':
            continue
        def save_glyphs(bw, value):
            segs = segment(bw)
            if len(segs) != len(value):
                return   # alignement ambigu (glyphes collés...) → on saute
            for (x0, x1), char in zip(segs, value):
                if counts[char] >= max_per_char:
                    continue
                norm = _normalize(bw[:, x0:x1])
                if norm is None:
                    continue
                cv2.imwrite(os.path.join(ATLAS_DIR,
                                         f'{char}_{counts[char]}.png'), norm)
                counts[char] += 1

        def binarize48(tight):
            s = 48.0 / tight.shape[0]
            big = cv2.resize(tight, (max(int(tight.shape[1] * s), 8), 48),
                             interpolation=cv2.INTER_CUBIC)
            t2 = scoreboard_read._text_color(tight)
            return np.where(np.abs(big.astype(np.int16) - t2).max(axis=2)
                            <= 70, 0, 255).astype(np.uint8)

        for p, gp in zip(zones['players'], gt['players']):
            for field in ('score', 'k', 'd', 'a'):
                crop = scoreboard_read._crop(img, p[field])
                if crop.size == 0:
                    continue
                target = scoreboard_read._text_color(crop)
                mask = np.abs(crop.astype(np.int16) - target).max(axis=2) <= 70
                ys = np.where(mask.sum(axis=1) >= 2)[0]
                xs = np.where(mask.sum(axis=0) >= 2)[0]
                if len(ys) < 7 or not len(xs):
                    continue
                tight = crop[max(0, ys.min() - 2):ys.max() + 3,
                             max(0, xs.min() - 4):xs.max() + 5]
                save_glyphs(binarize48(tight), gp[field])
            # pseudos : uniquement les non-wrappés (1 seule ligne, sinon la
            # répartition des caractères entre lignes est inconnue).
            name_crop = scoreboard_read._crop(img, p['name'])
            if name_crop.size == 0:
                continue
            lines = scoreboard_read._name_lines(name_crop)
            if len(lines) == 1:
                save_glyphs(binarize48(lines[0]), gp['name'])
    print('atlas:', dict(sorted(counts.items())))


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == 'harvest':
        sys.path.insert(0, _HERE)
        _harvest(sys.argv[2])
    else:
        print(__doc__)
