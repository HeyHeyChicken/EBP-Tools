"""Génère des données d'entraînement SYNTHÉTIQUES pour les modèles Tesseract de
pseudos, à partir de la police officielle EVA (Edsonna) et de la liste des
pseudos réels (export `T_Game_Players.json`, 34330 noms).

Deux cibles, alimentées par la même source :
  - `evapseudos`   (cartouches, MAJUSCULES)      → renforce `_ocr_cart_pseudo`
  - `evakillfeed`  (killfeed, casse d'origine)   → remplace `lang='eng'` dans
                                                    `_ocr_killfeed_name`

Chaque pseudo est rendu dans la police (Medium primaire + Regular/Bold en
augmentation), dégradé pour matcher la distribution runtime de sa zone, puis
écrit au format tesstrain (`<id>.png` + `<id>.gt.txt`) dans
`tesstrain/data/<MODEL>-ground-truth/` (gitignoré).

Cartouche : le prétraitement final réutilise `prepare_tesstrain._preprocess`
(parité exacte avec l'inférence : Otsu → polarité → ×4 → pad).
Killfeed  : miroir de `_ocr_killfeed_name` (upscale couleur → masque → pad).

Usage :
    # aperçu de calibration (n'écrit rien dans le dataset)
    python3 gen_pseudo_synth.py --preview out.png --limit 24

    # génération complète
    python3 gen_pseudo_synth.py --mode both

Entraînement ensuite (hors app) :
    cd tesstrain
    gmake training MODEL_NAME=evapseudos  START_MODEL=eng MAX_ITERATIONS=10000
    gmake training MODEL_NAME=evakillfeed START_MODEL=eng MAX_ITERATIONS=10000
Puis copier les .traineddata dans python/tessdata/ et basculer
analyze_video.py:902 `lang='eng'` → `lang='evakillfeed'`.
"""

import argparse
import json
import random
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageOps

import prepare_tesstrain  # réutilise _preprocess (parité cartouche)

_HERE = Path(__file__).parent
_DEFAULT_FONT_DIR = Path('/Users/antoine/Downloads/EDSONNA/T32351-OT')
_DEFAULT_JSON = Path('/Users/antoine/Downloads/T_Game_Players.json')
_DATA_ROOT = _HERE.parent / 'tesstrain' / 'data'

# Graisses : Medium primaire, Regular/Bold en augmentation (cf. analyse
# épaisseur de trait vs vrais crops : graisse effective à l'écran = Medium→Bold).
_WEIGHTS = [('Medium', 0.5), ('Regular', 0.25), ('Bold', 0.25)]

# Couleurs d'équipe (RGB, cf. TEAM_ORANGE/TEAM_BLUE dans analyze_video.py).
_TEAM_RGB = [(238, 120, 12), (43, 137, 237), (150, 150, 150)]  # orange, bleu, neutre

# --- Cartouche : bande 147×18, texte sombre centré sur carte couleur ---------
_CART_W, _CART_H = 147, 18
_CART_CAP_PX = (15, 18)      # taille de police (cap-height ~11-13px)
_CART_MAX_TEXT_W = 132       # au-delà → troncature "..." (marge sur les 147px)

# --- Killfeed : petit texte couleur d'équipe sur fond sombre gameplay --------
_KF_CAP_PX = (14, 17)        # glyphe natif ~11px
_KF_UPSCALE = 4              # miroir _ocr_killfeed_name (upscale-puis-masque)


def _font(font_dir, weight, size):
    return ImageFont.truetype(str(font_dir / f'403-Edsonna-{weight}.otf'), size)


def _pick_weight(rng):
    r = rng.random()
    acc = 0.0
    for name, p in _WEIGHTS:
        acc += p
        if r <= acc:
            return name
    return _WEIGHTS[0][0]


def load_pseudos(json_path):
    raw = json.loads(Path(json_path).read_text(encoding='utf-8'))
    for obj in raw:
        if isinstance(obj, dict) and obj.get('type') == 'table':
            return [r['nice_name'] for r in obj['data'] if r.get('nice_name')]
    raise ValueError('table T_Game_Players introuvable dans le JSON')


def _glyph_bmp(ch, font):
    img = Image.new('L', (60, 60), 0)
    ImageDraw.Draw(img).text((10, 10), ch, fill=255, font=font)
    return np.asarray(img)


def _unrenderable_chars(pseudos, font):
    """Ensemble des caractères du corpus SANS glyphe dans la police (№ CJK…).
    Calculé une fois sur les caractères uniques. PIL rend un glyphe .notdef
    (carré tofu, donc `ink>0`) pour les caractères non couverts : on les
    détecte en comparant au bitmap .notdef (codepoint privé non mappé)."""
    notdef = _glyph_bmp('', font)
    bad = set()
    for ch in set(''.join(pseudos)):
        if ch == ' ':
            continue
        b = _glyph_bmp(ch, font)
        if b.max() == 0 or np.array_equal(b, notdef):
            bad.add(ch)
    return bad


def _text_width(text, font):
    d = ImageDraw.Draw(Image.new('L', (10, 10)))
    b = d.textbbox((0, 0), text, font=font)
    return b[2] - b[0]


def _truncate_to_width(text, font, max_w):
    """Tronque par LARGEUR rendue (police proportionnelle) + '...', comme l'UI."""
    if _text_width(text, font) <= max_w:
        return text
    ell = '...'
    while text and _text_width(text + ell, font) > max_w:
        text = text[:-1]
    return text + ell if text else ell


def _draw_text(size_wh, text, font, xy, fill):
    img = Image.new('RGB', size_wh, (0, 0, 0))
    ImageDraw.Draw(img).text(xy, text, fill=fill, font=font, anchor='lm')
    return img


def _degrade(bgr, rng, blur_p=0.6, noise_sigma=6):
    """Léger flou + bruit pour mimer compression/anti-aliasing de capture."""
    if rng.random() < blur_p:
        bgr = cv2.GaussianBlur(bgr, (3, 3), 0)
    if noise_sigma:
        n = rng.normalvariate  # bruit gaussien par pixel
        noise = np.array([[n(0, noise_sigma) for _ in range(bgr.shape[1])]
                          for _ in range(bgr.shape[0])])[:, :, None]
        bgr = np.clip(bgr.astype(np.float32) + noise, 0, 255).astype(np.uint8)
    return bgr


def _corner_brackets(img_rgb, color, rng):
    """Décorations de coin de la cartouche, FORTEMENT randomisées (présence,
    épaisseur, style, taille, position). L'objectif n'est pas le réalisme d'un
    crop donné mais l'INVARIANCE : en faisant varier les brackets pendant que
    le label reste constant, le LSTM apprend qu'ils ne font pas partie du texte
    (sinon il les lit comme des `[`/`]`/`I`, cf. brackets fixes = échec)."""
    if rng.random() < 0.15:
        return                                   # parfois aucun
    d = ImageDraw.Draw(img_rgb)
    w, h = img_rgb.size
    style = rng.choice(['chevron', 'bracket', 'chevron', 'bracket'])
    tw = rng.randint(1, 2)                        # épaisseur
    L = rng.randint(3, 6)                         # longueur des branches
    ox, oy = rng.randint(1, 3), rng.randint(0, 1)  # jitter position
    left, right = ox, w - 1 - ox
    for x, dx in ((left, 1), (right, -1)):
        if style == 'bracket':                   # `[` / `]` pleine hauteur
            d.line([(x, oy), (x, h - 1 - oy)], fill=color, width=tw)
            d.line([(x, oy), (x + dx * L, oy)], fill=color, width=tw)
            d.line([(x, h - 1 - oy), (x + dx * L, h - 1 - oy)], fill=color, width=tw)
        else:                                     # chevrons de coin
            for y, dy in ((oy, 1), (h - 1 - oy, -1)):
                d.line([(x, y), (x + dx * L, y)], fill=color, width=tw)
                d.line([(x, y), (x, y + dy * L)], fill=color, width=tw)


def make_cartouche_raw(pseudo, font_dir, rng):
    """Rend un pseudo UPPERCASE en cartouche brute 147×18 (texte sombre centré
    sur carte couleur d'équipe, chevrons de coin, dégradé). Retourne un array
    BGR prêt pour prepare_tesstrain._preprocess."""
    text = pseudo.upper()
    weight = _pick_weight(rng)
    size = rng.randint(*_CART_CAP_PX)
    font = _font(font_dir, weight, size)
    text = _truncate_to_width(text, font, _CART_MAX_TEXT_W)

    team = list(_TEAM_RGB[rng.randrange(len(_TEAM_RGB))])
    # jitter de teinte (carte translucide sur gameplay variable)
    team = [int(np.clip(c + rng.randint(-25, 25), 0, 255)) for c in team]
    ink = rng.randint(10, 45)                      # texte sombre quasi noir
    ink_rgb = (ink, ink, ink)

    img = Image.new('RGB', (_CART_W, _CART_H), tuple(team))
    tw = _text_width(text, font)
    x = max(2, (_CART_W - tw) // 2)
    ImageDraw.Draw(img).text((x, _CART_H // 2), text, fill=ink_rgb,
                             font=font, anchor='lm')
    # couleur bracket variée : sombre (encre) ou teinte d'équipe assombrie
    if rng.random() < 0.5:
        bcol = ink_rgb
    else:
        bcol = tuple(int(c * rng.uniform(0.3, 0.6)) for c in team)
    _corner_brackets(img, bcol, rng)
    bgr = cv2.cvtColor(np.asarray(img), cv2.COLOR_RGB2BGR)
    return _degrade(bgr, rng), text


def make_killfeed_sample(pseudo, font_dir, rng):
    """Rend un pseudo (casse d'origine) tel que Tesseract le reçoit APRÈS un
    masque couleur réussi : glyphes ~11px natifs, upscale ×4 BICUBIC (miroir
    _ocr_killfeed_name), binarisé noir-sur-blanc, + augmentation légère
    (flou/épaisseur/bruit) pour la robustesse aux fade-ins. On ne simule PAS
    l'échec du masque (fragments) : ces cas dégradés sont gérés en aval par le
    fuzzy-match, pas par l'OCR — l'entraîner à sortir du garbage nuirait."""
    text = pseudo
    weight = _pick_weight(rng)
    size = rng.randint(*_KF_CAP_PX)
    font = _font(font_dir, weight, size)

    # couverture du glyphe (blanc sur noir), à la résolution native ~11px
    tw = _text_width(text, font)
    pad = 6
    W, H = tw + 2 * pad, size + 2 * pad
    cov = Image.new('L', (W, H), 0)
    ImageDraw.Draw(cov).text((pad, H // 2), text, fill=255, font=font,
                             anchor='lm')
    a = np.asarray(cov)

    # upscale ×4 BICUBIC (reproduit le crénelage upscale-puis-masque)
    big = np.asarray(Image.fromarray(a).resize(
        (W * _KF_UPSCALE, H * _KF_UPSCALE), Image.BICUBIC)).astype(np.float32)
    # bruit avant seuil → bords irréguliers/rongés comme le masque couleur réel
    # (les vrais crops apportent le gros du réalisme ; ici on évite juste des
    # glyphes trop lisses). Amplitude variable = qualité variable.
    sigma = rng.uniform(0, 45)
    big = np.clip(big + np.random.normal(0, sigma, big.shape), 0, 255).astype(np.uint8)
    if rng.random() < 0.5:
        big = cv2.GaussianBlur(big, (3, 3), 0)
    # seuil → texte NOIR sur fond BLANC (polarité Tesseract)
    _, bw = cv2.threshold(big, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    bw = 255 - bw
    # augmentation d'épaisseur : le masque couleur amincit ou épaissit selon tol
    k = np.ones((2, 2), np.uint8)
    r = rng.random()
    if r < 0.25:
        bw = cv2.erode(bw, k)           # érode le blanc → texte plus épais
    elif r > 0.75:
        bw = cv2.dilate(bw, k)          # dilate le blanc → texte plus fin
    pil = ImageOps.expand(Image.fromarray(bw), border=10, fill=255).convert('RGB')
    return pil, text


def _clear_synth(dst):
    for f in dst.glob('synth_*'):
        f.unlink()


def _generate(mode, pseudos, font_dir, rng, limit):
    model = 'evapseudos' if mode == 'cartouche' else 'evakillfeed'
    dst = _DATA_ROOT / f'{model}-ground-truth'
    dst.mkdir(parents=True, exist_ok=True)
    _clear_synth(dst)
    bad = _unrenderable_chars(pseudos, _font(font_dir, 'Medium', 20))
    n_ok = n_skip = 0
    items = pseudos[:limit] if limit else pseudos
    for i, pseudo in enumerate(items):
        if any(c in bad for c in pseudo):
            n_skip += 1
            continue
        sid = f'synth_{mode}_{i:06d}'
        if mode == 'cartouche':
            bgr, label = make_cartouche_raw(pseudo, font_dir, rng)
            cv2.imwrite(str(dst / f'{sid}.png'), bgr)  # temp brut
            prepare_tesstrain._preprocess(dst / f'{sid}.png').save(dst / f'{sid}.png')
        else:
            pil, label = make_killfeed_sample(pseudo, font_dir, rng)
            pil.save(dst / f'{sid}.png')
        (dst / f'{sid}.gt.txt').write_text(label + '\n')
        n_ok += 1
    print(f'[{mode}] écrit {n_ok} samples dans {dst} (skip charset {n_skip})')


def _preview(pseudos, font_dir, rng, out_path, n):
    """Planche de contrôle : synthétique cartouche + killfeed côte à côte,
    et vrais crops cartouche pour comparaison d'échelle."""
    rows = []
    real_dir = _HERE / 'training_data' / 'letters' / '_unsorted'
    reals = sorted(real_dir.glob('*.png'))[:4]
    for rp in reals:
        im = cv2.imread(str(rp))
        big = cv2.resize(im, (im.shape[1] * 4, im.shape[0] * 4),
                         interpolation=cv2.INTER_NEAREST)
        rows.append(('REAL ' + rp.stem.split('_')[-1], big))
    sample = rng.sample(pseudos, min(n, len(pseudos)))
    bad = _unrenderable_chars(pseudos, _font(font_dir, 'Medium', 20))
    for pseudo in sample:
        if any(c in bad for c in pseudo):
            continue
        bgr, lab = make_cartouche_raw(pseudo, font_dir, rng)
        big = cv2.resize(bgr, (bgr.shape[1] * 4, bgr.shape[0] * 4),
                         interpolation=cv2.INTER_NEAREST)
        rows.append(('CART ' + lab, big))
        pil, lab2 = make_killfeed_sample(pseudo, font_dir, rng)
        kf = cv2.cvtColor(np.asarray(pil), cv2.COLOR_RGB2BGR)
        rows.append(('KILL ' + lab2, kf))
    maxw = max(im.shape[1] for _, im in rows)
    canvas = []
    for label, im in rows:
        strip = np.zeros((im.shape[0], 180 + maxw, 3), np.uint8)
        cv2.putText(strip, label, (4, im.shape[0] // 2 + 5),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 255, 0), 1, cv2.LINE_AA)
        strip[:, 180:180 + im.shape[1]] = im
        canvas.append(strip)
        canvas.append(np.full((4, strip.shape[1], 3), 60, np.uint8))
    cv2.imwrite(out_path, np.vstack(canvas))
    print('preview →', out_path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--mode', choices=['cartouche', 'killfeed', 'both'],
                    default='both')
    ap.add_argument('--font-dir', type=Path, default=_DEFAULT_FONT_DIR)
    ap.add_argument('--json', type=Path, default=_DEFAULT_JSON)
    ap.add_argument('--limit', type=int, default=0, help='0 = tous')
    ap.add_argument('--seed', type=int, default=1234)
    ap.add_argument('--preview', type=str, default='',
                    help="chemin PNG d'aperçu (n'écrit pas le dataset)")
    args = ap.parse_args()

    rng = random.Random(args.seed)
    pseudos = load_pseudos(args.json)
    print(f'{len(pseudos)} pseudos chargés depuis {args.json.name}')

    if args.preview:
        _preview(pseudos, args.font_dir, rng, args.preview, args.limit or 12)
        return

    modes = ['cartouche', 'killfeed'] if args.mode == 'both' else [args.mode]
    for m in modes:
        _generate(m, pseudos, args.font_dir, rng, args.limit)


if __name__ == '__main__':
    main()
