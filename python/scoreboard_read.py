#!/usr/bin/env python3
"""Lecture OCR d'une frame de scoreboard de fin de partie.

S'appuie sur scoreboard_zones.py pour localiser les zones (map, % équipes,
joueurs), puis OCR chaque zone via eva_ocr (tesserocr in-process, fallback
pytesseract). Recette héritée d'analyze_video : upscale ×4 BICUBIC du crop
COULEUR d'abord (binariser à résolution native crénelle les glyphes), puis
plusieurs passes de binarisation (luminance, chroma pour le texte coloré du
joueur sélectionné, niveaux de gris bruts) × plusieurs PSM, et vote
majoritaire sur les candidats filtrés. Chiffres : evadigits + atlas de
glyphes. Pseudos : evascores (modèle fine-tuné sur les pseudos du scoreboard,
cf. prepare_scoreboard_gt.py).

Sortie : même structure que les .txt d'annotation —
    ligne 1 : nom de la map ('' si illisible / layout cast)
    ligne 2 : % équipe haut, % équipe bas
    lignes suivantes : "PSEUDO score k d a" par joueur (rangée haut G→D,
    puis rangée bas G→D)

Usage :
  python scoreboard_read.py frame.png            # lecture, format .txt
  python scoreboard_read.py frame.png --json     # lecture, JSON détaillé
  python scoreboard_read.py --qa DIR             # compare chaque <n>.png au
                                                 # ground-truth <n>.txt de DIR
"""
import argparse
import base64
import collections
import json
import os
import re
import sys

import cv2
import numpy as np
from PIL import Image, ImageOps

_HERE = os.path.dirname(os.path.abspath(__file__))
# eng.traineddata (symlink) + evadigits + evapseudos vivent dans ./tessdata.
os.environ.setdefault('TESSDATA_PREFIX', os.path.join(_HERE, 'tessdata'))

import eva_ocr
import scoreboard_glyphs
import scoreboard_zones

# Upscale par type de zone : Tesseract LSTM vise ~30-50 px de hauteur de
# glyphe. Trop grand est aussi néfaste que trop petit (mesuré : un pseudo
# upscalé ×4 → 64 px de glyphe → lecture VIDE ; ×2 → lecture exacte).
# Les % (~85 px natifs) ne sont pas upscalés.
PAD = 16
NAME_WHITELIST = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
MAP_WHITELIST = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz '

# Noms canoniques (aliases OCR → nom) — sous-ensemble scoreboard de
# analyze_video._MAPS, pour normaliser la lecture ET le ground-truth.
MAPS = {
    'Artefact': ['artefact'], 'Atlantis': ['atlantis'], 'Ceres': ['ceres'],
    'Engine': ['engine', 'enaine'], 'Helios Station': ['helios', 'station', 'heliosstation'],
    'Lunar Outpost': ['lunar', 'outpost', 'lunaroutpost'],
    'Outlaw': ['outlaw', 'qutlaw'], 'Polaris': ['polaris'], 'Silva': ['silva'],
    'The Cliff': ['cliff', 'thecliff'], 'The Rock': ['rock', 'therock'],
    'Horizon': ['horizon'],
}


def canonical_map(text):
    """Nom canonique de map depuis un texte OCR ou d'annotation, '' sinon."""
    words = re.sub(r'[^a-z ]', '', text.lower()).split()
    joined = ''.join(words)
    for name, aliases in MAPS.items():
        if joined in aliases or any(w in aliases for w in words):
            return name
    return ''


def _crop(img, zone):
    x1, y1, x2, y2 = (int(v) for v in zone)
    return img[max(y1, 0):y2, max(x1, 0):x2]


def _crop_b64(img, zone):
    """Crop d'une zone encodé en data-URI PNG, ou None si zone absente/vide.
    Sert au client (Angular) pour afficher côte à côte la lecture OCR et le
    pixel réel lu, afin de vérifier/corriger."""
    if not zone:
        return None
    crop = _crop(img, zone)
    if crop.size == 0:
        return None
    ok, buf = cv2.imencode('.png', crop)
    if not ok:
        return None
    return 'data:image/png;base64,' + base64.b64encode(buf.tobytes()).decode('ascii')


def _variants(crop_bgr, upscale):
    """Images candidates pour l'OCR : upscale couleur d'abord, puis
    binarisations complémentaires (texte → noir sur blanc).

    - luminance : texte blanc/clair standard
    - chroma    : texte coloré du joueur sélectionné ou des %, y compris sur
                  fond clair où la luminance seule est aveugle (cas lunar)
    - gris brut : filet de sécurité, Tesseract segmente lui-même
    """
    big = cv2.resize(crop_bgr, (crop_bgr.shape[1] * upscale,
                                crop_bgr.shape[0] * upscale),
                     interpolation=cv2.INTER_CUBIC) if upscale > 1 else crop_bgr
    gray = cv2.cvtColor(big, cv2.COLOR_BGR2GRAY)
    mx = big.astype(np.int16).max(axis=2)
    chroma = (mx - big.astype(np.int16).min(axis=2)).astype(np.uint8)

    out = []
    for chan in (gray, chroma):
        _, bw = cv2.threshold(chan, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        # Otsu sur une zone sans texte coupe dans le bruit : on ne garde la
        # passe que si la part d'« encre » ressemble à du texte (ni vide, ni
        # aplat). Le seuil d'Otsu lui-même n'est pas un critère : il est
        # légitimement bas sur fond sombre.
        ink = (bw == 0).mean()
        if 0.01 <= ink <= 0.45:
            out.append(bw)
    out.append(gray)
    return [ImageOps.expand(Image.fromarray(v), border=PAD, fill=255).convert('RGB')
            for v in out]


def _ocr_zone(img, zone, langs, psms, whitelist, checker=None, upscale=2):
    """OCR multi-passes d'une zone, vote majoritaire sur les candidats."""
    crop = _crop(img, zone)
    if crop.size == 0:
        return ''
    pattern = re.compile(f'[^{re.escape(whitelist)}]') if whitelist else None
    candidates = []
    for pil in _variants(crop, upscale):
        for lang in langs:
            for psm in psms:
                try:
                    txt = eva_ocr.recognize(pil, lang=lang, psm=psm,
                                            whitelist=whitelist)
                except Exception:
                    continue
                txt = txt.replace('\r', '').replace('\n', '').strip()
                if pattern:
                    txt = pattern.sub('', txt)
                if checker:
                    txt = checker(txt)
                if txt:
                    candidates.append(txt)
    if not candidates:
        return ''
    freq = collections.Counter(candidates)
    return max(candidates, key=lambda c: freq[c])


def _int_checker(lo, hi, multiple=1):
    def check(txt):
        digits = re.sub(r'\D', '', txt)
        if not digits:
            return ''
        v = int(digits)
        return str(v) if lo <= v <= hi and v % multiple == 0 else ''
    return check


def _text_color(crop):
    """Couleur médiane des pixels les plus clairs = couleur du texte (blanc,
    ou couleur d'équipe pour le joueur sélectionné). Percentile élevé : un
    pseudo court (K6) ne couvre que ~5 % de sa zone — à p92 on échantillonne
    le fond."""
    px = crop.reshape(-1, 3).astype(np.int16)
    lum = px.max(axis=1)
    return np.median(px[lum >= np.percentile(lum, 99)], axis=0)


def _name_lines(crop):
    """Découpe le crop pseudo en 1-2 lignes de texte, recadrées serré.

    Le banding se fait sur le masque couleur-du-texte (et non la simple
    luminance) : sur fond clair (chat, webcam) la luminance fusionne les deux
    lignes d'un pseudo wrappé en une seule bande illisible."""
    target = _text_color(crop)
    mask = np.abs(crop.astype(np.int16) - target).max(axis=2) <= 70
    rows = mask.sum(axis=1)
    bands, start = [], None
    for i, c in enumerate(rows):
        if c >= 3 and start is None:
            start = i
        elif c < 3 and start is not None:
            if i - start >= 7:
                bands.append((start, i))
            start = None
    if start is not None and len(rows) - start >= 7:
        bands.append((start, len(rows)))
    out = []
    for y0, y1 in bands[:2]:
        cols = np.where(mask[y0:y1].any(axis=0))[0]
        if len(cols):
            out.append(crop[max(0, y0 - 2):y1 + 2,
                            max(0, int(cols.min()) - 4):int(cols.max()) + 5])
    return out


def _line_images(line):
    """Variantes binarisées d'une ligne de pseudo, glyphes ramenés à ~28 px :
    masques couleur-du-texte à plusieurs tolérances + Otsu luminance.

    Multi-tolérance : à 70 un fond clair (beige d'Engine, ~25-45 d'écart avec
    le blanc du texte) entre dans le masque et noie le texte ; à 30 on perd
    l'anti-aliasing sur les fonds sombres. Les deux bords du spectre se
    complètent, le vote tranche."""
    s = 32.0 / line.shape[0]
    big = cv2.resize(line, (int(line.shape[1] * s), 32),
                     interpolation=cv2.INTER_CUBIC)
    target = _text_color(line)
    diff = np.abs(big.astype(np.int16) - target).max(axis=2)
    arrs = [np.where(diff <= tol, 0, 255).astype(np.uint8)
            for tol in (70, 45, 30)]
    gray = cv2.cvtColor(big, cv2.COLOR_BGR2GRAY)
    _, otsu = cv2.threshold(gray, 0, 255,
                            cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    arrs.append(otsu)
    return [ImageOps.expand(Image.fromarray(a), border=12, fill=255).convert('RGB')
            for a in arrs]


def _name_candidates(img, zone):
    """Toutes les lectures candidates d'un pseudo (1-2 lignes concaténées),
    dédupliquées, plus fréquentes d'abord."""
    crop = _crop(img, zone)
    if crop.size == 0:
        return []
    lines = _name_lines(crop)
    if not lines:
        return []
    # Lecture primaire par l'atlas de glyphes (police fixe ; distingue 0/O là
    # où Tesseract ne peut pas). Une ligne illisible → on retombe sur les
    # candidats Tesseract.
    atlas = scoreboard_glyphs.default_atlas()
    atlas_parts = []
    for line in lines:
        s = 48.0 / line.shape[0]
        big = cv2.resize(line, (max(int(line.shape[1] * s), 8), 48),
                         interpolation=cv2.INTER_CUBIC)
        target = _text_color(line)
        bw = np.where(np.abs(big.astype(np.int16) - target).max(axis=2) <= 70,
                      0, 255).astype(np.uint8)
        txt, _ = atlas.read(bw)
        atlas_parts.append(txt)
    atlas_name = ''.join(atlas_parts) if all(atlas_parts) else ''
    per_line = []
    for line in lines:
        reads = []
        for pil in _line_images(line):
            # evascores : modèle Tesseract fine-tuné sur les pseudos du
            # scoreboard (glyphes plus grands que le killfeed → distingue les
            # X/H, V/U, 0/O que evapseudos confondait). Mesuré sur 6 frames
            # non vues à l'entraînement : 52→79 % de pseudos exacts. Seul,
            # sans eng/evapseudos qui réinjectaient leurs confusions au vote.
            for lang in ('evascores',):
                for psm in (7, 8):
                    try:
                        txt = eva_ocr.recognize(pil, lang=lang, psm=psm,
                                                whitelist=NAME_WHITELIST)
                    except Exception:
                        continue
                    txt = ''.join(c for c in txt if c in NAME_WHITELIST)
                    reads.append(txt)
        per_line.append(reads)
    # produit cartésien ligne1 × ligne2 borné : on concatène les lectures de
    # même rang (les recettes sont alignées entre lignes).
    n = max(len(r) for r in per_line)
    cands = []
    for i in range(n):
        joined = ''.join(r[min(i, len(r) - 1)] for r in per_line)
        if len(joined) >= 2:
            cands.append(joined)
    freq = collections.Counter(cands)
    ordered = [c for c, _ in freq.most_common()]
    if len(atlas_name) >= 2:
        ordered = [atlas_name] + [c for c in ordered if c != atlas_name]
    return ordered


def _ocr_digits(img, zone, checker, psms=(7, 8, 13), heights=(32,)):
    """Chiffres (score / K / D / A) : recadrage serré sur le texte réel de la
    zone (le chiffre de tête se perd quand la zone est lue en entier), masque
    couleur-du-texte + Otsu, multi-hauteurs de glyphe, vote sur les candidats
    validés par `checker` (les 7/5 stylisés d'EVA se lisent différemment
    selon l'échelle — le vote multi-hauteurs tranche)."""
    crop = _crop(img, zone)
    if crop.size == 0:
        return ''
    target = _text_color(crop)
    mask = np.abs(crop.astype(np.int16) - target).max(axis=2) <= 70
    ys = np.where(mask.sum(axis=1) >= 2)[0]
    xs = np.where(mask.sum(axis=0) >= 2)[0]
    if len(ys) >= 7 and len(xs):
        crop = crop[max(0, ys.min() - 2):ys.max() + 3,
                    max(0, xs.min() - 4):xs.max() + 5]
        target = _text_color(crop)
    # Lecture primaire : classification par glyphes contre l'atlas de formes
    # apprises (police fixe → quasi infaillible ; s'abstient sous 0.75 de
    # similarité). Multi-tolérance de masque (cf. _line_images). Tesseract ne
    # sert plus que de secours.
    s48 = 48.0 / crop.shape[0]
    big48 = cv2.resize(crop, (max(int(crop.shape[1] * s48), 8), 48),
                       interpolation=cv2.INTER_CUBIC)
    diff48 = np.abs(big48.astype(np.int16) - target).max(axis=2)
    atlas_reads = collections.Counter()
    for tol in (70, 45, 30):
        bw48 = np.where(diff48 <= tol, 0, 255).astype(np.uint8)
        atlas_txt, _ = scoreboard_glyphs.default_atlas().read(
            bw48, charset='0123456789')
        atlas_txt = checker(atlas_txt)
        if atlas_txt:
            # un glyphe à faible contraste peut se dégrader différemment
            # selon la tolérance (6 lu 8) : on vote entre tolérances.
            atlas_reads[atlas_txt] += 1
    if atlas_reads:
        best, n = atlas_reads.most_common(1)[0]
        if n >= 2 or len(atlas_reads) == 1:
            return best
    candidates = []
    for height in heights:
        s = float(height) / crop.shape[0]
        big = cv2.resize(crop, (max(int(crop.shape[1] * s), 8), height),
                         interpolation=cv2.INTER_CUBIC)
        diff = np.abs(big.astype(np.int16) - target).max(axis=2)
        cms = [np.where(diff <= tol, 0, 255).astype(np.uint8)
               for tol in (70, 40)]
        gray = cv2.cvtColor(big, cv2.COLOR_BGR2GRAY)
        _, otsu = cv2.threshold(gray, 0, 255,
                                cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        for arr in cms + [otsu]:
            pil = ImageOps.expand(Image.fromarray(arr), border=12,
                                  fill=255).convert('RGB')
            for lang in ('evadigits', 'eng'):
                for psm in psms:
                    try:
                        txt = eva_ocr.recognize(pil, lang=lang, psm=psm,
                                                whitelist='0123456789')
                    except Exception:
                        continue
                    txt = checker(''.join(c for c in txt if c.isdigit()))
                    if txt:
                        candidates.append(txt)
    if not candidates:
        return ''
    freq = collections.Counter(candidates)
    return max(candidates, key=lambda c: freq[c])


def _levenshtein(a, b):
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        curr = [i] + [0] * len(b)
        for j, cb in enumerate(b, 1):
            curr[j] = min(prev[j] + 1, curr[j - 1] + 1,
                          prev[j - 1] + (ca != cb))
        prev = curr
    return prev[-1]


def match_roster(players, roster):
    """Assigne à chaque joueur le meilleur nom du roster (Levenshtein
    multi-candidats, comme le killfeed d'analyze_video), affectation gloutonne
    par ratio décroissant, chaque nom du roster servant au plus une fois.
    Remplace `name` in place quand un match >= 0.4 existe."""
    roster_up = [r.upper() for r in roster]
    scored = []
    for pi, p in enumerate(players):
        for name in roster_up:
            best = 0.0
            for cand in p.get('name_candidates') or [p['name']]:
                if not cand:
                    continue
                ratio = 1 - _levenshtein(cand.upper(), name) / max(len(cand), len(name))
                best = max(best, ratio)
            scored.append((best, pi, name))
    used_p, used_n = set(), set()
    for ratio, pi, name in sorted(scored, reverse=True):
        if ratio < 0.4 or pi in used_p or name in used_n:
            continue
        players[pi]['name'] = name
        used_p.add(pi)
        used_n.add(name)


def read_frame(img, roster=None, keep_candidates=False, with_zone_images=False):
    """Lit une frame BGR. Retourne un dict :
    {'layout', 'map', 'team1', 'team2',
     'players': [{'name', 'score', 'k', 'd', 'a'}, ...]} (valeurs str, ''
    si illisible ; ordre rangée haut G→D puis rangée bas G→D).

    `roster` : liste optionnelle des pseudos attendus (les settings de chunk
    d'analyze_video les fournissent) — les noms lus sont alors fuzzy-matchés
    dessus, ce qui absorbe les confusions de glyphes de la police EVA.

    `with_zone_images` : joint une clé 'zones' avec le crop PNG base64 de chaque
    zone où l'OCR a lu (map, %, et par joueur name/score/k/d/a), pour que le
    client puisse vérifier/corriger la lecture face au pixel réel."""
    zones = scoreboard_zones.zones_for_frame(img)
    out = {'layout': zones['layout'], 'map': '', 'team1': '', 'team2': '',
           'players': []}
    if zones['layout'] == 'unknown':
        return out

    h, w = img.shape[:2]
    img_1080 = img if (w, h) == (1920, 1080) else cv2.resize(img, (1920, 1080))
    # zones_for_frame retourne des zones à l'échelle de la frame source ;
    # on lit sur la 1080p de référence, donc on rescale si besoin.
    if (w, h) != (1920, 1080):
        zones = scoreboard_zones.zones_for_frame(img_1080)

    if zones.get('map'):
        raw = _ocr_zone(img_1080, zones['map'], ('eng',), (7,), MAP_WHITELIST,
                        upscale=3)
        out['map'] = canonical_map(raw) or raw
    pct = _int_checker(0, 100)
    out['team1'] = _ocr_zone(img_1080, zones['team1_pct'], ('evadigits', 'eng'),
                             (7, 8), '0123456789%', pct, upscale=1)
    out['team2'] = _ocr_zone(img_1080, zones['team2_pct'], ('evadigits', 'eng'),
                             (7, 8), '0123456789%', pct, upscale=1)
    # Les scores EVA sont des multiples de 25 : filtre les lectures tronquées
    # ('750' lu '70') ou polluées ('9475').
    score_check = _int_checker(0, 3000, multiple=25)
    kda_check = _int_checker(0, 99)
    zone_imgs = {'players': []} if with_zone_images else None
    for p in zones['players']:
        cands = _name_candidates(img_1080, p['name'])
        # row 1 = rangée haut = équipe orange, row 2 = rangée bas = équipe bleue.
        entry = {'name': cands[0] if cands else '',
                 'name_candidates': cands,
                 'team': 'orange' if p['row'] == 1 else 'blue',
                 'score': _ocr_digits(img_1080, p['score'], score_check,
                                      heights=(32, 40, 48))}
        for key in ('k', 'd', 'a'):
            entry[key] = _ocr_digits(img_1080, p[key], kda_check,
                                     psms=(7, 8, 10))
        out['players'].append(entry)
        if with_zone_images:
            zone_imgs['players'].append(
                {key: _crop_b64(img_1080, p[key])
                 for key in ('name', 'score', 'k', 'd', 'a')})
    if roster:
        match_roster(out['players'], roster)
    if not keep_candidates:
        for p in out['players']:
            p.pop('name_candidates', None)
    if with_zone_images:
        zone_imgs['map'] = _crop_b64(img_1080, zones.get('map'))
        zone_imgs['team1_pct'] = _crop_b64(img_1080, zones['team1_pct'])
        zone_imgs['team2_pct'] = _crop_b64(img_1080, zones['team2_pct'])
        out['zones'] = zone_imgs
    return out


def format_txt(result):
    lines = [result['map'], f"{result['team1']} {result['team2']}"]
    for p in result['players']:
        lines.append(f"{p['name']} {p['score']} {p['k']} {p['d']} {p['a']}")
    return '\n'.join(lines)


# ---------------------------------------------------------------------------
# QA contre les .txt d'annotation
# ---------------------------------------------------------------------------

def parse_gt(path):
    lines = [l.strip() for l in open(path, encoding='utf-8') if l.strip()]
    team = lines[1].split()
    players = []
    for l in lines[2:]:
        parts = l.split()
        players.append({'name': parts[0].upper(), 'score': parts[1],
                        'k': parts[2], 'd': parts[3], 'a': parts[4]})
    return {'map': lines[0], 'team1': team[0], 'team2': team[1],
            'players': players}


def qa(directory):
    stats = collections.Counter()
    for png in sorted(os.listdir(directory)):
        if not png.endswith('.png'):
            continue
        name = png[:-4]
        txt = os.path.join(directory, f'{name}.txt')
        if not os.path.isfile(txt):
            continue
        gt = parse_gt(txt)
        if any(p['name'] == 'JOUEUR' for p in gt['players']):
            print(f'--  {name} (annotation template, ignoré)')
            continue
        img = cv2.imread(os.path.join(directory, png))
        res = read_frame(img, keep_candidates=True)
        # noms roster-assistés (cas production : les settings de chunk donnent
        # les joueurs attendus) — mesurés en plus de la lecture brute.
        import copy
        matched = copy.deepcopy(res['players'])
        match_roster(matched, [p['name'] for p in gt['players']])
        errors = []

        if res['layout'] != 'cast':  # cast : map absente de l'écran
            stats['map_total'] += 1
            if canonical_map(res['map']) == canonical_map(gt['map']):
                stats['map_ok'] += 1
            else:
                errors.append(f"map: lu={res['map']!r} gt={gt['map']!r}")
        for key in ('team1', 'team2'):
            stats['pct_total'] += 1
            if res[key] == gt[key]:
                stats['pct_ok'] += 1
            else:
                errors.append(f"{key}: lu={res[key]!r} gt={gt[key]!r}")
        if len(res['players']) != len(gt['players']):
            errors.append(f"joueurs: {len(res['players'])} lus, "
                          f"{len(gt['players'])} attendus")
            stats['players_mismatch'] += 1
        for i, (rp, gp) in enumerate(zip(res['players'], gt['players'])):
            stats['name_total'] += 1
            if rp['name'] == gp['name']:
                stats['name_ok'] += 1
            else:
                errors.append(f"j{i+1} name: lu={rp['name']!r} gt={gp['name']!r}")
            stats['roster_total'] += 1
            if matched[i]['name'] == gp['name']:
                stats['roster_ok'] += 1
            else:
                errors.append(f"j{i+1} roster: lu={matched[i]['name']!r} "
                              f"gt={gp['name']!r}")
            for key in ('score', 'k', 'd', 'a'):
                stats[f'{key}_total'] += 1
                if rp[key] == gp[key]:
                    stats[f'{key}_ok'] += 1
                else:
                    errors.append(
                        f"j{i+1} {key}: lu={rp[key]!r} gt={gp[key]!r}")
        mark = 'OK ' if not errors else 'KO '
        print(f'{mark}{name}')
        for e in errors:
            print(f'    {e}')
    print()
    for field in ('map', 'pct', 'name', 'roster', 'score', 'k', 'd', 'a'):
        tot = stats[f'{field}_total']
        if tot:
            ok = stats[f'{field}_ok']
            print(f'{field:6s}: {ok}/{tot} ({100.0 * ok / tot:.1f}%)')


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('frame', nargs='?', help='image de la frame (png/jpg)')
    ap.add_argument('--json', action='store_true', help='sortie JSON détaillée')
    ap.add_argument('--zones', action='store_true',
                    help='sortie JSON avec le crop base64 de chaque zone OCR')
    ap.add_argument('--qa', metavar='DIR',
                    help='compare chaque <n>.png de DIR à son <n>.txt')
    args = ap.parse_args()

    if args.qa:
        qa(args.qa)
        return 0
    if not args.frame:
        print('frame ou --qa requis', file=sys.stderr)
        return 1
    img = cv2.imread(args.frame)
    if img is None:
        print(f'lecture impossible : {args.frame}', file=sys.stderr)
        return 1
    result = read_frame(img, with_zone_images=args.zones)
    print(json.dumps(result) if (args.json or args.zones)
          else format_txt(result))
    return 0


if __name__ == '__main__':
    sys.exit(main())
