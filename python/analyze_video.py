# Copyright (c) 2026, Antoine Duval
# This file is part of a source-visible project.
# See LICENSE for terms. Unauthorized use is prohibited.

import sys
import os
import json
import io
import re
import base64
import time
import numpy as np
import cv2
from collections import deque, Counter
from concurrent.futures import ThreadPoolExecutor
from PIL import Image, ImageOps, ImageEnhance
import pytesseract

# ---------------------------------------------------------------------------
# MODES
# All positions are in 1920×1080 coordinate space.
# ---------------------------------------------------------------------------

# Couleurs des équipes — partagées entre l'identify (matching pixel) et la
# détection de bordure (find_text_border). Une seule source de vérité par couleur.
TEAM_ORANGE = [
    (238, 120, 12), # Orange
    (40, 255, 119), # Vert fluo
    (169, 220, 83)  # Jaune fluo (pro league)
]
TEAM_BLUE   = [
    (43, 137, 237), # Bleu
    (180, 0, 244),  # Violet
    (55, 189, 218)  # Bleu fluo (pro league)
]

MODES = [
    #region Mode 0
    {
        'scoreFrame': {
            'identify': [
                (78, 412, TEAM_ORANGE),  # orange team circle
                (78, 745, TEAM_BLUE),    # blue team circle
            ],
            # Le nom d'équipe est entouré d'une bordure colorée. On la cherche
            # dynamiquement dans une zone large, on prend son bbox, on rentre
            # de quelques px (inset) pour ne pas inclure le bord lui-même dans
            # le crop OCR.
            'orangeName': {
                'colors': TEAM_ORANGE,
                'search': ((70, 381), (192, 431)),
                'inset': 4,    # rentre dans la bordure (texte à l'intérieur)
            },
            'blueName': {
                'colors': TEAM_BLUE,
                'search': ((70, 727), (192, 781)),
                'inset': 4,
            },
            # Le SCORE est lui-même coloré (chiffres en couleur de l'équipe). On
            # cherche tous les pixels colorés, le bbox englobant = bbox des chiffres.
            # On élargit de 3 px (inset négatif) pour donner du padding à l'OCR.
            'orangeScore': {
                'colors': TEAM_ORANGE,
                'search': ((30, 430), (356, 527)),
                'inset': -10,
            },
            'blueScore': {
                'colors': TEAM_BLUE,
                'search': ((30, 626), (356, 728)),
                'inset': -10,
            },
        },
        'endFrame': {
            'orangeScore': ((636, 545), (903, 648)),
            'blueScore': ((996, 545), (1257, 648)),
        },
        'gameFrame': {
            'map': ((845, 124), (1072, 159)),
            'orangeName': ((704, 58), (796, 97)),
            'blueName': ((1121, 58), (1214, 97)),
            'timer': ((916, 50), (1004, 88)),
            'playersY': [[732, 755], [814, 838], [898, 921], [980, 1004]],
            'orangeScore': {
                'colors': TEAM_ORANGE,
                'search': ((830, 65), (906, 107)),
                'inset': -10,
            },
            'blueScore': {
                'colors': TEAM_BLUE,
                'search': ((1014, 65), (1095, 107)),
                'inset': -10,
            },
            # Killfeed top-right : on détecte des bandes de texte (couleur équipe
            # + picto arme blanc) par row-scan vertical. textHeight = hauteur de
            # la bande de texte coloré (≠ hauteur de la box visuelle ~30 px,
            # le reste est du fond noir non discriminant).
            'killFeed': {
                # Région de détection conservatrice : la victime (texte coloré
                # sur fond noir) et le picto arme sont toujours dans cette
                # zone même pour les pseudos très longs. La détection de row
                # ne génère donc pas de faux positifs ici.
                'region': ((1690, 140), (1920, 400)),
                # Bord gauche d'extension dynamique du bbox : pour les
                # pseudos longs (ex. TAESxJacquepastel = 17 chars), le killer
                # peut commencer bien avant x=1690. Une fois la row détectée
                # par la victime, on étend bbox.x1 vers la gauche tant qu'on
                # voit du signal team-color dans la y-band, jusqu'à cette
                # limite. Mesuré : la row la plus longue commence à x=1641.
                'leftExtendLimit': 1500,
                'leftExtendMaxGap': 8,  # arrêt si N cols consécutives sans team color

                'textHeight': 11,
                'textHeightTol': 6,
                'minTextPixels': 3,         # min pixels couleur équipe par row pour être "row de texte"
                'rowGap': 3,                # max rows sans signal couleur tolérés au sein d'un cluster
                'minTotalWhitePixels': 20,  # min pixels near-white cumulés dans la bande (= picto arme)
                'minWhitePerRow': 3,        # min near-white pixels par row pour considérer une row "dans la bande de texte"
                                            # (sert à trimmer la fuite du cluster dans le décor team-couleur)
                'minWidth': 80,             # une vraie kill row fait ~120-160 px (killer+picto+victim) ;
                                            # rejette les clusters étroits type bord de HUD ou notif "DÉFENDRE"
                # Validation anti-faux-positif : on vérifie le bord droit du bbox,
                # qui correspond à l'extrémité arrondie de la box noire de la victime.
                # Toujours quasi-100 % noir pour un vrai kill (le fond solide noir
                # entoure le texte). Approche plus robuste qu'une moyenne sur la
                # moitié droite, car celle-ci peut leak dans le gap entre 2 kills
                # empilés (qui montre le décor) → ratio dégradé.
                'edgePx': 15,                # largeur du bord droit à inspecter
                'edgePadY': 5,               # extension verticale ± px (juste de quoi sortir de l'anti-aliasing)
                'blackMaxChannel': 60,       # max(R,G,B) pour qualifier "noir"
                'minEdgeBlackRatio': 0.15,   # min black ratio dans le bord droit. Volontairement bas
                                             # pour accepter les kill rows en fade-in/fade-out (background
                                             # encore semi-transparent). Les vrais faux positifs (DÉFENDRE,
                                             # HUD) restent à ~0 % donc séparation reste nette.
            },
        },
        'playingFrame': {
            'identify': [
                (1731, 811, [(238, 241, 238)]),  # top blanc
                (1731, 990, [(238, 241, 238)]),  # bottom blanc
                (1858, 813, TEAM_ORANGE + TEAM_BLUE),  # player color
            ],
        },
        'loadingFrames': [
            {
                'logoTop': (958, 427), 'logoLeft': (857, 653),
                'logoRight': (1060, 653), 'logoMiddle': (958, 642),
                'logoBlack1': (958, 463), 'logoBlack2': (880, 653),
                'logoBlack3': (1037, 653), 'logoBlack4': (958, 610),
            },
            {
                'logoTop': (959, 484), 'logoLeft': (908, 596),
                'logoRight': (1010, 596), 'logoMiddle': (959, 589),
                'logoBlack1': (959, 503), 'logoBlack2': (920, 596),
                'logoBlack3': (996, 596), 'logoBlack4': (959, 573),
            },
            {
                'logoTop': (959, 369), 'logoLeft': (808, 708),
                'logoRight': (1110, 708), 'logoMiddle': (959, 708),
                'logoBlack1': (959, 430), 'logoBlack2': (840, 708),
                'logoBlack3': (1070, 708), 'logoBlack4': (959, 640),
            },
        ],
    },
    #endregion
]

# A-letter patterns for game intro detection — from detectGameIntro() in the service
_A_PATTERNS = [
    [(1495, 942, 255, 30), (1512, 950, 255, 30), (1495, 962, 255, 30),
     (1512, 972, 255, 30), (1495, 982, 255, 30),
     (1503, 951,   0, 200), (1503, 972,   0, 200)],
    [(1558, 960, 255, 30), (1572, 968, 255, 30), (1558, 977, 255, 30),
     (1572, 987, 255, 30), (1558, 995, 255, 30),
     (1564, 969,   0, 200), (1564, 986,   0, 200)],
    [(1556, 957, 255, 30), (1571, 964, 255, 30), (1556, 975, 255, 30),
     (1571, 984, 255, 30), (1556, 993, 255, 30),
     (1564, 966,   0, 200), (1564, 984,   0, 200)],
    [(1617, 979, 255, 30), (1630, 985, 255, 30), (1617, 995, 255, 30),
     (1630, 1004, 255, 30), (1617, 1011, 255, 30),
     (1623, 987,   0, 200), (1623, 1004,   0, 200)],
    [(1606, 976, 255, 30), (1619, 982, 255, 30), (1606, 991, 255, 30),
     (1619, 1000, 255, 30), (1606, 1008, 255, 30),
     (1612, 983,   0, 200), (1612, 1000,   0, 200)],
]

_MAPS = {
    'Artefact': ['artefact'],
    'Atlantis': ['atlantis'],
    'Ceres': ['ceres'],
    'Engine': ['engine', 'enaine'],
    'Helios Station': ['helios', 'station', 'hheliosstation', 'rheliosstation', 'heliosstation'],
    'Lunar Outpost': ['lunar', 'outpost', 'lunaroutpost'],
    'Outlaw': ['outlaw', 'qutlaw'],
    'Polaris': ['polaris'],
    'Silva': ['silva'],
    'The Cliff': ['cliff', 'citt', 'clit', 'cltt', 'cit', 'ciitt', 'theclife', 'the clife', 'theclifen'],
    'The Rock': ['rock', 'therock'],
    'Horizon': ['horizon'],
}

WIDTH  = 1920
HEIGHT = 1080

# Vitesse max de progression du score en EVA : 2 points par seconde de hold.
# Sert à filtrer les OCR aberrants en phase 2 (ex : score qui saute de 0 à 100).
MAX_SCORE_RATE_PER_SECOND = 2

# ---------------------------------------------------------------------------
# Low-level helpers
# ---------------------------------------------------------------------------

def check_pixels(frame, points, tol_color=20, tol_pos=10):
    """
    frame: image (H, W, 3)
    points: liste de tuples (x, y, r, g, b)
    tol_color: tolérance couleur
    tol_pos: tolérance position (zone autour du point)
    """
    h, w, _ = frame.shape

    for (x, y, r, g, b) in points:
        x1 = max(0, x - tol_pos)
        x2 = min(w, x + tol_pos)
        y1 = max(0, y - tol_pos)
        y2 = min(h, y + tol_pos)

        roi = frame[y1:y2, x1:x2]

        target = np.array([r, g, b])
        diff = np.abs(roi - target)

        match = (diff < tol_color).all(axis=2)

        if not match.any():
            return False

    return True

def _emit(msg: dict) -> None:
    """Sérialise msg en JSON et l'écrit sur stdout (flush immédiat)."""
    print(json.dumps(msg), flush=True)


def _get_pixel(frame: np.ndarray, x: float, y: float):
    """Retourne le pixel RGB à la position (x, y) dans le frame numpy."""
    return frame[int(y), int(x)]


def _color_similar(pixel, target: tuple, tol: int = 20) -> bool:
    """Retourne True si pixel est dans la tolérance tol de la couleur target (RGB)."""
    return (abs(int(pixel[0]) - target[0]) <= tol and
            abs(int(pixel[1]) - target[1]) <= tol and
            abs(int(pixel[2]) - target[2]) <= tol)


def _region_to_pil(frame: np.ndarray, x1: float, y1: float, x2: float, y2: float) -> Image.Image:
    """Découpe la région (x1, y1)→(x2, y2) du frame et retourne une image PIL."""
    return Image.fromarray(frame[int(y1):int(y2), int(x1):int(x2)])


def _region_to_base64(frame: np.ndarray, x1: float, y1: float, x2: float, y2: float) -> str:
    """Découpe la région du frame et retourne une data-URL PNG en base64."""
    buf = io.BytesIO()
    _region_to_pil(frame, x1, y1, x2, y2).save(buf, format='PNG')
    return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode('ascii')


def _most_frequent(arr: list) -> str:
    """Retourne l'élément le plus fréquent de arr (chaîne vide si arr est vide)."""
    if not arr:
        return ''
    freq: dict = {}
    for item in arr:
        freq[item] = freq.get(item, 0) + 1
    return max(arr, key=lambda x: freq[x])


def _score_checker(value: str) -> str:
    """Valide et normalise une chaîne de score OCR vers un entier entre 0 et 100."""
    DIGITS = re.sub(r'\D', '', value)
    if not DIGITS:
        return ''
    try:
        return str(min(max(int(DIGITS[:3]), 0), 100))
    except Exception:
        return ''


def _get_map_by_name(text: str) -> str:
    """Recherche un nom de map connu dans text et retourne le nom canonique, ou '' si non trouvé."""
    words = re.sub(r'[\r\n]', '', text).lower().split()
    for MAP_NAME, keywords in _MAPS.items():
        if any(w in keywords for w in words):
            return MAP_NAME
    return ''

# ---------------------------------------------------------------------------
# OCR — mirrors getTextFromImage() from the TypeScript service
# ---------------------------------------------------------------------------

def _ocr_region(
    frame: np.ndarray,
    x1: float, y1: float, x2: float, y2: float,
    psm: int = 7,
    extra_psms: list = None,
    whitelist: str = '',
    luminance: int = None,
    apply_filter: bool = False,
    include_raw: bool = True,
    checker=None,
    lang: str = 'eng',
    debug_save_bw: str = '',
) -> str:
    """
    Lance Tesseract sur la région (x1, y1)→(x2, y2) du frame avec plusieurs passes
    d'image (brute, N&B par seuil de luminance, inversion+contraste, niveaux de gris+contraste)
    et retourne le résultat le plus fréquent — miroir de getTextFromImage() en TypeScript.

    extra_psms : liste optionnelle de PSMs supplémentaires à essayer en plus de psm.
                 Utile pour les scores où PSM 8 (single word) complète PSM 7 (single line).
    include_raw : si False, skip la passe sur l'image brute (utile quand un modèle
                  custom comme evadigits a été entraîné uniquement sur du N&B).
    checker : fonction optionnelle appliquée à chaque résultat avant le vote (ex. _score_checker).
    """
    img = _region_to_pil(frame, x1, y1, x2, y2)

    def _build_config(p: int) -> str:
        c = f'--psm {p}'
        if whitelist:
            c += f' -c "tessedit_char_whitelist={whitelist}"'
        return c

    PSMS = [psm] + [p for p in (extra_psms or []) if p != psm]
    CONFIGS = [_build_config(p) for p in PSMS]

    # Pattern de filtrage : si un whitelist est défini, on ne garde que ses caractères
    FILTER_PATTERN = re.compile(f'[^{re.escape(whitelist)}]') if whitelist else None

    def _recognize(i: Image.Image) -> list:
        out = []
        for cfg in CONFIGS:
            try:
                TEXT = pytesseract.image_to_string(i, lang=lang, config=cfg).replace('\r', '').replace('\n', '').strip()
                if FILTER_PATTERN:
                    TEXT = FILTER_PATTERN.sub('', TEXT)
                out.append(TEXT)
            except Exception as EXC:
                #_emit({'log': f'[OCR][ERROR] lang={lang!r} cfg={cfg!r} cmd={pytesseract.pytesseract.tesseract_cmd!r} tessdata={os.environ.get("TESSDATA_PREFIX", "<unset>")} exc={type(EXC).__name__}: {EXC}'})
                out.append('')
        return out

    results = list(_recognize(img)) if include_raw else []
    BW = None

    if luminance is not None:
        BW = img.convert('L').point(lambda p: 255 if p < luminance else 0).convert('RGB')
        results.extend(_recognize(BW))
        if debug_save_bw:
            try:
                STAMP = int(time.time() * 1000)
                BW.save(os.path.expanduser(f'~/Downloads/{debug_save_bw}_{STAMP}.png'))
            except Exception:
                pass

    F1 = F2 = None
    if apply_filter:
        try:
            F1 = ImageOps.invert(img.convert('RGB'))
            F1 = ImageEnhance.Contrast(F1).enhance(2.0)
            F1 = ImageEnhance.Brightness(F1).enhance(1.5)
            results.extend(_recognize(F1))
        except Exception:
            pass
        try:
            F2 = img.convert('L').convert('RGB')
            F2 = ImageEnhance.Contrast(F2).enhance(3.0)
            F2 = ImageEnhance.Brightness(F2).enhance(1.5)
            results.extend(_recognize(F2))
        except Exception:
            pass

    if checker:
        results = [checker(r) for r in results]

    NON_EMPTY = [r for r in results if r]
    if not NON_EMPTY:
        RESULT = ''
    else:
        RESULT = _most_frequent(NON_EMPTY)
    #try:
    #    STAMP = int(time.time() * 1000)
    #    BASE = os.path.expanduser(f'~/Downloads/ocr_{int(x1)}_{int(y1)}_{int(x2)}_{int(y2)}_{STAMP}')
    #    img.save(f'{BASE}_0orig.png')
    #    if BW is not None:
    #        BW.save(f'{BASE}_1bw.png')
    #    if F1 is not None:
    #        F1.save(f'{BASE}_2inv.png')
    #    if F2 is not None:
    #        F2.save(f'{BASE}_3gray.png')
    #except Exception:
    #    pass
    #_emit({'log': f'[OCR] region=({x1},{y1})-({x2},{y2}) results={results} → {repr(RESULT)}'})
    return RESULT


def _ocr_color_masked(
    frame: np.ndarray,
    x1: float, y1: float, x2: float, y2: float,
    target_color: tuple,
    tol_color: int = 80,
    upscale: int = 4,
    pad: int = 20,
    whitelist: str = '',
    psms: tuple = (7, 6, 8),
    debug_save_prefix: str = '',
) -> str:
    """OCR avec masque couleur : pixels proches de target_color → noir,
    reste → blanc (polarité Tesseract standard), upscale BICUBIC + pad.
    Vote sur les PSMs, retourne le résultat le plus fréquent."""
    h, w = frame.shape[:2]
    x1 = max(0, int(x1)); y1 = max(0, int(y1))
    x2 = min(w, int(x2)); y2 = min(h, int(y2))
    if x2 <= x1 or y2 <= y1:
        return ''
    sub = frame[y1:y2, x1:x2].astype(np.int16)
    target = np.array(target_color, dtype=np.int16)
    mask = (np.abs(sub - target).max(axis=2) <= tol_color)
    bw = np.where(mask, 0, 255).astype(np.uint8)
    pil = Image.fromarray(bw).resize(
        (bw.shape[1] * upscale, bw.shape[0] * upscale), Image.BICUBIC
    )
    pil = ImageOps.expand(pil, border=pad, fill=255).convert('RGB')

    if debug_save_prefix:
        try:
            STAMP = int(time.time() * 1000)
            BASE = os.path.expanduser(f'~/Downloads/{debug_save_prefix}{STAMP}')
            Image.fromarray(frame[y1:y2, x1:x2]).save(f'{BASE}_0orig.png')
            pil.save(f'{BASE}_1mask.png')
        except Exception:
            pass

    cfg_wl = f' -c "tessedit_char_whitelist={whitelist}"' if whitelist else ''
    FILTER_PATTERN = re.compile(f'[^{re.escape(whitelist)}]') if whitelist else None
    results = []
    for psm in psms:
        try:
            txt = pytesseract.image_to_string(
                pil, config=f'--psm {psm}{cfg_wl}'
            ).replace('\r', '').replace('\n', '').strip()
            if FILTER_PATTERN:
                txt = FILTER_PATTERN.sub('', txt)
            results.append(txt)
        except Exception:
            results.append('')
    NON_EMPTY = [r for r in results if r]
    RESULT = _most_frequent(NON_EMPTY) if NON_EMPTY else ''
    #_emit({'log': f'[OCR/mask] region=({x1},{y1})-({x2},{y2}) target={target_color} results={results} → {repr(RESULT)}'})
    return RESULT


# ---------------------------------------------------------------------------
# Frame type detection — mirrors detect* functions from the TypeScript service
# ---------------------------------------------------------------------------

def _identify_offset(frame: np.ndarray, identify: list, tol_pos: int = 10, tol_color: int = 20):
    """
    Cherche l'offset (dx, dy) auquel les pixels d'identification matchent dans le frame.
    Pour chaque (x, y, colors), scanne une zone (2*tol_pos+1)² autour de (x, y) et
    note le centroïde des pixels matchant l'une des couleurs autorisées (tol_color
    par canal). Si tous les points matchent, retourne la moyenne des décalages — un
    seul (dx, dy) qui représente le glissement global du HUD.

    Retourne None si au moins un point d'identify ne matche aucune couleur dans sa zone.
    """
    h, w = frame.shape[:2]
    offsets = []
    for (x, y, colors) in identify:
        x = int(x); y = int(y)
        x1 = max(0, x - tol_pos)
        x2 = min(w, x + tol_pos + 1)
        y1 = max(0, y - tol_pos)
        y2 = min(h, y + tol_pos + 1)
        roi = frame[y1:y2, x1:x2].astype(np.int16)
        matched = False
        for c in colors:
            target = np.array(c, dtype=np.int16)
            mask = (np.abs(roi - target) <= tol_color).all(axis=2)
            if mask.any():
                ys, xs = np.where(mask)
                # Centroïde des pixels matchants → position absolue dans le frame
                cx = xs.mean() + x1
                cy = ys.mean() + y1
                offsets.append((cx - x, cy - y))
                matched = True
                break
        if not matched:
            return None
    if not offsets:
        return None
    dx = sum(o[0] for o in offsets) / len(offsets)
    dy = sum(o[1] for o in offsets) / len(offsets)
    return (dx, dy)


def _shift_box(box, dx, dy):
    """Translate une région ((x1,y1), (x2,y2)) par (dx, dy)."""
    (x1, y1), (x2, y2) = box
    return ((x1 + dx, y1 + dy), (x2 + dx, y2 + dy))


def _find_text_border(frame: np.ndarray, colors: list, search_region, tol_color: int = 20, min_pixels: int = 50, inset: int = 0):
    """
    Trouve le bounding box des pixels matchant une des couleurs dans search_region.
    Cas d'usage : un texte est entouré d'une bordure colorée (ex: bouton orange autour
    d'un nom d'équipe). On masque les pixels de la couleur de bordure, on prend le
    bbox englobant, on rentre de inset px pour ne pas inclure le bord lui-même.

    Retourne ((x1, y1), (x2, y2)) ou None si pas assez de pixels matchent.
    """
    h, w = frame.shape[:2]
    (sx1, sy1), (sx2, sy2) = search_region
    sx1 = max(0, int(sx1)); sy1 = max(0, int(sy1))
    sx2 = min(w, int(sx2)); sy2 = min(h, int(sy2))
    if sx1 >= sx2 or sy1 >= sy2:
        return None
    sub = frame[sy1:sy2, sx1:sx2].astype(np.int16)
    mask = np.zeros(sub.shape[:2], dtype=bool)
    for c in colors:
        target = np.array(c, dtype=np.int16)
        mask |= (np.abs(sub - target) <= tol_color).all(axis=2)
    if mask.sum() < min_pixels:
        return None
    ys, xs = np.where(mask)
    # inset positif = rentre vers l'intérieur (utile quand la couleur cible est
    # une BORDURE entourant le texte). inset négatif = élargit autour (utile
    # quand la couleur cible est le TEXTE lui-même, ex: chiffres colorés du score).
    # On clamp aux bornes du frame pour éviter de sortir de l'image.
    x1 = max(0, int(xs.min()) + sx1 + inset)
    y1 = max(0, int(ys.min()) + sy1 + inset)
    x2 = min(w, int(xs.max()) + sx1 + 1 - inset)
    y2 = min(h, int(ys.max()) + sy1 + 1 - inset)
    if x2 <= x1 or y2 <= y1:
        return None
    return ((x1, y1), (x2, y2))


def _pick_dominant_color(frame: np.ndarray, search_region, candidates: list, tol_color: int = 20, min_pixels: int = 30):
    """
    Parmi une liste de couleurs candidates, retourne celle qui matche le plus
    de pixels dans search_region (ou None si aucune ne dépasse min_pixels).
    Utilisé pour verrouiller la couleur d'équipe réellement présente dans la
    partie courante (TEAM_ORANGE et TEAM_BLUE listent plusieurs valeurs possibles).
    """
    h, w = frame.shape[:2]
    (sx1, sy1), (sx2, sy2) = search_region
    sx1 = max(0, int(sx1)); sy1 = max(0, int(sy1))
    sx2 = min(w, int(sx2)); sy2 = min(h, int(sy2))
    if sx1 >= sx2 or sy1 >= sy2:
        return None
    sub = frame[sy1:sy2, sx1:sx2].astype(np.int16)
    best = None
    best_count = 0
    for c in candidates:
        target = np.array(c, dtype=np.int16)
        count = int(((np.abs(sub - target) <= tol_color).all(axis=2)).sum())
        if count > best_count:
            best_count = count
            best = c
    return best if best_count >= min_pixels else None


def _resolve_team_colors(frame: np.ndarray, mode_index: int):
    """
    Détermine la couleur effective de chaque équipe sur la frame courante en
    comptant les pixels matchant chaque candidat dans la search region du score
    HUD. Retourne (orange_rgb, blue_rgb) — chaque élément peut être None si
    la zone n'est pas assez peuplée (frame de transition, etc.).
    """
    GF = MODES[mode_index]['gameFrame']
    return (
        _pick_dominant_color(frame, GF['orangeScore']['search'], TEAM_ORANGE),
        _pick_dominant_color(frame, GF['blueScore']['search'], TEAM_BLUE),
    )


def _validate_kill_row(frame: np.ndarray, bbox, kf_spec: dict) -> bool:
    """
    Vérifie qu'une bbox candidate est bien une ligne de kill en inspectant le
    BORD DROIT du bbox — l'extrémité arrondie de la box noire de la victime,
    quasi 100 % noir sur un vrai kill quel que soit le contexte (map, gameplay).

    Pourquoi pas la moitié droite entière : le bbox détecté à l'étape 1 peut
    être plus court que la box visuelle réelle (couleur du killer atténuée par
    un fond transparent → cluster tronqué) et l'extension verticale peut leak
    dans le gap entre 2 kills empilés → on inclurait du décor non-noir, ratio
    s'effondre, vrai kill rejeté.

    Le bord droit (15 derniers px) est lui toujours dans la box noire, et avec
    un pad_y minimal il reste centré sur la bande de texte → mesure stable.

    Retourne True si black_ratio ≥ minEdgeBlackRatio.
    """
    (_, y1), (x2, y2) = bbox
    h, w = frame.shape[:2]
    pad_y = kf_spec.get('edgePadY', 5)
    edge  = kf_spec.get('edgePx', 15)
    y1e = max(0, int(y1) - pad_y)
    y2e = min(h, int(y2) + pad_y)
    xa  = max(0, int(x2) - edge)
    xb  = min(w, int(x2))
    if y1e >= y2e or xa >= xb:
        return False

    sub = frame[y1e:y2e, xa:xb]
    total = sub.shape[0] * sub.shape[1]
    if total == 0:
        return False

    black_max = kf_spec.get('blackMaxChannel', 60)
    sub_max = sub.max(axis=2)
    black_ratio = int((sub_max <= black_max).sum()) / total
    return black_ratio >= kf_spec.get('minEdgeBlackRatio', 0.30)


def _split_kill_row(frame: np.ndarray, bbox,
                    hue_threshold: int = 30, min_brightness: int = 100):
    """
    Découpe une bbox de kill row en killer / weapon / victim en localisant les
    colonnes ayant des pixels orange-ish / blue-ish par dominance de hue. Le
    killer et la victime ont chacun leur cluster (couleurs distinctes — kill
    cross-team obligatoire), le picto arme tient entre les deux.

    On NE peut PAS se fier aux pixels near-white pour localiser le picto : si
    le killer a un mur blanc derrière sa box transparente, tout le côté killer
    matche near-white et le picto "fuit" sur toute la bbox.

    On utilise la dominance de hue plutôt qu'un match RGB exact car le texte
    du killer (fond transparent) est alpha-blendé avec le décor : un pixel
    orange peut s'afficher (225,154,100) sur un mur gris au lieu de
    (238,120,12), |B-12|=88 hors tol_color=40 → match raté. Mais R reste
    largement supérieur à B donc la dominance R-over-B subsiste. La couleur
    exacte d'équipe (RESOLVED_ORANGE/BLUE) n'est donc pas utilisée ici.

    Retourne dict {'killer': {'box', 'team'}, 'weapon': {'box'}, 'victim':
    {'box', 'team'}} ou None si :
      - une seule couleur d'équipe présente (pas un kill cross-team)
      - les clusters orange/bleu s'overlap (pas de zone picto fiable)
    """
    (x1, y1), (x2, y2) = bbox
    sub = frame[y1:y2, x1:x2].astype(np.int16)
    R, G, B = sub[:, :, 0], sub[:, :, 1], sub[:, :, 2]

    # Dominance de hue + brightness mini pour ignorer les pixels sombres parasites.
    m_o = (R > B + hue_threshold) & (R > G) & (R >= min_brightness)
    m_b = (B > R + hue_threshold) & (B > G) & (B >= min_brightness)

    # ≥ 2 px par col : un pixel isolé (artéfact de scenery, anti-aliasing) ne
    # compte pas comme une col du cluster.
    n_o_per_col = m_o.sum(axis=0)
    n_b_per_col = m_b.sum(axis=0)
    cols_o = np.where(n_o_per_col >= 2)[0]
    cols_b = np.where(n_b_per_col >= 2)[0]
    if len(cols_o) < 4 or len(cols_b) < 4:
        return None

    def _largest_block(cols, max_gap: int = 5):
        """Plus gros bloc contigu de cols (gaps ≤ max_gap tolérés)."""
        if len(cols) == 0:
            return None
        s = np.sort(cols)
        blocks = []
        cur_start = cur_end = int(s[0])
        for c in s[1:]:
            c = int(c)
            if c - cur_end <= max_gap:
                cur_end = c
            else:
                blocks.append((cur_start, cur_end))
                cur_start = cur_end = c
        blocks.append((cur_start, cur_end))
        return max(blocks, key=lambda b: b[1] - b[0])

    # Plus gros bloc contigu pour chaque couleur. Les pixels parasites isolés
    # (scenery dont la couleur ressemble à une équipe, p.ex. champ d'énergie
    # bleu derrière un kill row) forment des petits blocs ignorés.
    block_o = _largest_block(cols_o)
    block_b = _largest_block(cols_b)
    if block_o is None or block_b is None:
        return None

    # Killer = bloc dont le centre est le plus à gauche.
    center_o = (block_o[0] + block_o[1]) / 2
    center_b = (block_b[0] + block_b[1]) / 2
    if center_o < center_b:
        killer_team, victim_team = 'orange', 'blue'
        killer_block, victim_block = block_o, block_b
    else:
        killer_team, victim_team = 'blue', 'orange'
        killer_block, victim_block = block_b, block_o

    killer_right = killer_block[1] + 1
    victim_left  = victim_block[0]
    if victim_left <= killer_right:
        # Blocs s'overlap : split non fiable.
        return None

    return {
        'killer': {'box': ((x1,                y1), (x1 + killer_right, y2)), 'team': killer_team},
        'weapon': {'box': ((x1 + killer_right, y1), (x1 + victim_left,  y2))},
        'victim': {'box': ((x1 + victim_left,  y1), (x2,                y2)), 'team': victim_team},
    }


def _ocr_kill_name(frame: np.ndarray, box, target_color,
                   tol_color: int = 80, pad: int = 20,
                   y_extend: int = 3, user_words_path: str = None) -> list:
    """
    OCR un nom de joueur dans une bbox killfeed. Masque par couleur d'équipe
    (texte couleur cible → noir, fond → blanc, polarité standard Tesseract),
    upscale BICUBIC et pad pour Tesseract qui aime ~32+ px de hauteur de glyph.

    `y_extend` étend la bbox verticalement (haut + bas) pour capter les
    descendants ("j", "y", "p") et ascendants ("h", "k") des glyphes — la
    bbox détectée à l'étape 1 borne le cluster des pixels couleur d'équipe,
    qui correspond au CORPS du glyph, pas aux pleins/déliés. Sans ça, "junior"
    est cropped au "lurior" (le j perd son crochet).

    Retourne une LISTE de candidats OCR (multi-PSM × multi-upscale). En
    cas de fade-in où l'image est légèrement dégradée, certaines combinaisons
    upscale/PSM échouent là où d'autres réussissent (vu en debug : 4x PSM6
    sort "Thyhi" sur un Myki en fade-in alors que 8x PSM8 sort "Myki").
    Le caller (`_match_player`) prend le meilleur match roster sur la liste.
    """
    (x1, y1), (x2, y2) = box
    h, w = frame.shape[:2]
    x1 = max(0, int(x1)); y1 = max(0, int(y1) - y_extend)
    x2 = min(w, int(x2)); y2 = min(h, int(y2) + y_extend)
    if x2 <= x1 or y2 <= y1:
        return []
    sub = frame[y1:y2, x1:x2].astype(np.int16)
    target = np.array(target_color, dtype=np.int16)
    mask = (np.abs(sub - target).max(axis=2) <= tol_color)
    bw = np.where(mask, 0, 255).astype(np.uint8)

    cfg = '-c tessedit_char_whitelist=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    if user_words_path:
        cfg += f' -c user_words_file={user_words_path}'

    candidates = []
    # 4x BICUBIC × {PSM 6, 7, 8} est notre cheval de bataille (cas stable).
    # 8x BICUBIC + PSM 8 (single word) rattrape spécifiquement les fade-ins :
    # l'LSTM tesseract est sensible à la résolution sur les pixels semi-
    # saturés du fade-in, et le PSM 8 (mot unique) tolère mieux la
    # ségmentation de lettres qu'un PSM 6 (block) sur ces conditions.
    pil4 = Image.fromarray(bw).resize(
        (bw.shape[1] * 4, bw.shape[0] * 4), Image.BICUBIC
    )
    pil4 = ImageOps.expand(pil4, border=pad, fill=255).convert('RGB')
    for psm in (6, 7, 8):
        try:
            txt = pytesseract.image_to_string(
                pil4, config=f'--psm {psm} {cfg}'
            ).replace('\r', '').replace('\n', '').strip()
            if txt:
                candidates.append(txt)
        except Exception:
            pass
    pil8 = Image.fromarray(bw).resize(
        (bw.shape[1] * 8, bw.shape[0] * 8), Image.BICUBIC
    )
    pil8 = ImageOps.expand(pil8, border=pad, fill=255).convert('RGB')
    try:
        txt = pytesseract.image_to_string(
            pil8, config=f'--psm 8 {cfg}'
        ).replace('\r', '').replace('\n', '').strip()
        if txt:
            candidates.append(txt)
    except Exception:
        pass
    return candidates


def _load_template_image(path: str):
    """
    Charge un PNG template (RGBA, RGB, P palette ou grayscale) en (gray, mask)
    où :
      - gray : intensité (0=noir, 255=icône claire)
      - mask : alpha si présent, sinon = pixels non-noirs (luminance > 30)

    Le mask sert à `cv2.matchTemplate(..., mask=...)` pour ignorer les pixels
    de fond (transparents ou noirs) lors du score — seule la silhouette de
    l'icône compte. Robuste aux fonds semi-transparents du killfeed.
    """
    pil = Image.open(path).convert('RGBA')
    arr = np.array(pil)
    rgb = arr[:, :, :3]
    alpha = arr[:, :, 3]
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    if alpha.max() == 0:
        # Pas de canal alpha utile (PNG sans transparence) → fallback sur la
        # luminance : tout pixel non-noir compte comme silhouette.
        mask = (gray > 30).astype(np.uint8) * 255
    else:
        mask = alpha
    return gray, mask


def _resize_template_to_height(gray: np.ndarray, mask: np.ndarray, target_h: int):
    """Redimensionne un template à `target_h` en hauteur, ratio préservé.
    Le killfeed affiche les icônes à hauteur ~13 px ; les templates source
    peuvent être à des résolutions variées (12-29 px), on les ramène tous
    à la même échelle pour comparer."""
    h, w = gray.shape
    if h == target_h:
        return gray, mask
    new_w = max(1, int(round(w * target_h / h)))
    interp = cv2.INTER_AREA if target_h < h else cv2.INTER_CUBIC
    g = cv2.resize(gray, (new_w, target_h), interpolation=interp)
    m = cv2.resize(mask, (new_w, target_h), interpolation=interp)
    return g, m


def _load_weapon_templates(template_dir: str, target_h: int = 13) -> dict:
    """
    Charge tous les PNG du dossier `weapons/` comme templates {name: (gray, mask)},
    redimensionnés à `target_h` px de haut (= hauteur typique d'une kill row).
    `name` = stem du fichier (m12.png → "m12").

    Retourne {} si le dossier n'existe pas — désactive proprement la détection
    d'arme sans casser le pipeline killfeed.
    """
    out = {}
    weapons_dir = os.path.join(template_dir, 'weapons')
    if not os.path.isdir(weapons_dir):
        return out
    for fname in sorted(os.listdir(weapons_dir)):
        if not fname.lower().endswith('.png'):
            continue
        name = os.path.splitext(fname)[0]
        try:
            gray, mask = _load_template_image(os.path.join(weapons_dir, fname))
            gray, mask = _resize_template_to_height(gray, mask, target_h)
            out[name] = (gray, mask)
        except Exception:
            continue
    return out


def _load_headshot_template(template_dir: str):
    """Charge le template headshot à sa résolution native (l'icône ⊕ dans le
    killfeed est rendue à ~17-18 px de haut, plus grande que le glyph de texte
    13 px — ne pas la resize au target_h des armes)."""
    path = os.path.join(template_dir, 'headshot.png')
    if not os.path.isfile(path):
        return None
    try:
        return _load_template_image(path)
    except Exception:
        return None


def _match_template_score(target_gray: np.ndarray, tpl_gray: np.ndarray, tpl_mask: np.ndarray,
                           target_thresh: int = 100, tpl_thresh: int = 100):
    """
    Score de match IoU (Intersection-over-Union) sur images binarisées en
    glissant le template (x et y) sur le target. Sert au headshot detection
    où le template a une taille proche de l'icône réelle (pas de slide
    important).

    Pour matcher des armes de tailles très différentes, voir
    `_match_template_to_icon` qui crop d'abord la bbox de l'icône.
    """
    th, tw = tpl_gray.shape
    H, W = target_gray.shape
    if th > H or tw > W:
        return None, -1
    target_bin = target_gray > target_thresh
    tpl_bin = (tpl_mask > 0) & (tpl_gray > tpl_thresh)
    if not tpl_bin.any():
        return None, -1
    best_score = -1.0
    best_x = 0
    for yo in range(H - th + 1):
        for xo in range(W - tw + 1):
            win = target_bin[yo:yo + th, xo:xo + tw]
            inter = int(np.logical_and(win, tpl_bin).sum())
            uni = int(np.logical_or(win, tpl_bin).sum())
            if uni == 0:
                continue
            iou = inter / uni
            if iou > best_score:
                best_score = iou
                best_x = xo
    return float(best_score), int(best_x)


def _match_template_to_icon(target_gray: np.ndarray, tpl_gray: np.ndarray, tpl_mask: np.ndarray,
                             target_thresh: int = 100, tpl_thresh: int = 100):
    """
    Score IoU template vs icône, à HAUTEUR commune (aspect ratio préservé).

    Étapes :
      1. Bbox des pixels actifs dans le target → l'icône réelle (h_icon × w_icon).
      2. Resize le template À LA HAUTEUR h_icon (en préservant son aspect ratio
         → w_tpl_resized).
      3. Centrer le template dans une zone de largeur max(w_icon, w_tpl_resized).
         Idem pour l'icône (centrer dans la même zone).
      4. IoU sur cette zone commune.

    Pourquoi pas le full-stretch (largeur ET hauteur sans aspect) : ça
    permettait à un template compact (admin, grenade) d'être étiré en
    horizontal pour "fitter" la bbox d'un AR long → faux positifs systé-
    matiques. En préservant l'aspect ratio, un template trop court vs un AR
    long laisse de l'icône non-matchée à droite/gauche → IoU faible.

    Retourne (score, bbox) avec bbox = (x0, y0, x1, y1) de l'icône détectée.
    """
    target_bin = (target_gray > target_thresh)
    if not target_bin.any():
        return None, None
    rows = np.any(target_bin, axis=1)
    cols = np.any(target_bin, axis=0)
    y0, y1 = int(np.argmax(rows)), int(len(rows) - 1 - np.argmax(rows[::-1]))
    x0, x1 = int(np.argmax(cols)), int(len(cols) - 1 - np.argmax(cols[::-1]))
    icon = target_bin[y0:y1 + 1, x0:x1 + 1]
    h_icon, w_icon = icon.shape
    if h_icon < 3 or w_icon < 3:
        return None, None
    tpl_bin = ((tpl_mask > 0) & (tpl_gray > tpl_thresh)).astype(np.uint8)
    if tpl_bin.sum() == 0:
        return None, None
    h_tpl, w_tpl = tpl_bin.shape
    # Resize template à la hauteur h_icon, aspect ratio préservé.
    new_w = max(1, int(round(w_tpl * h_icon / h_tpl)))
    tpl_resized = cv2.resize(tpl_bin, (new_w, h_icon), interpolation=cv2.INTER_NEAREST).astype(bool)
    # Zone commune : largeur = max(w_icon, new_w), centrer chaque image dedans.
    canvas_w = max(w_icon, new_w)
    canvas_icon = np.zeros((h_icon, canvas_w), dtype=bool)
    canvas_tpl = np.zeros((h_icon, canvas_w), dtype=bool)
    icon_off = (canvas_w - w_icon) // 2
    tpl_off = (canvas_w - new_w) // 2
    canvas_icon[:, icon_off:icon_off + w_icon] = icon
    canvas_tpl[:, tpl_off:tpl_off + new_w] = tpl_resized
    inter = int(np.logical_and(canvas_icon, canvas_tpl).sum())
    uni = int(np.logical_or(canvas_icon, canvas_tpl).sum())
    if uni == 0:
        return None, None
    return float(inter / uni), (x0, y0, x1, y1)


def _identify_weapon(frame: np.ndarray, weapon_box, weapon_templates: dict,
                      headshot_template, min_score: float = 0.45,
                      headshot_min_score: float = 0.5):
    """
    Identifie l'arme dans la weapon_box d'un kill row. Retourne (name, headshot,
    score) où :
      - name = nom du template gagnant ou None si aucun ne dépasse min_score
      - headshot = bool, True si l'icône headshot est détectée à droite de l'arme
      - score = IoU best match (debug)

    Stratégie en 2 passes :
      1. CHERCHER LE HEADSHOT D'ABORD dans la moitié droite de la zone (là où
         il est toujours, à côté du nom de la victime). Sa silhouette ronde
         (cible + croix) ressemble à certains templates d'armes (skull admin,
         etc.) → si on cherche l'arme avant, le template arme matche le ⊕.
      2. MATCHER LES ARMES en restreignant la recherche À GAUCHE du headshot
         si trouvé, sinon sur toute la zone. Le template au meilleur IoU gagne.

    Pourquoi pas l'inverse (arme puis headshot) : essayé, le template skull
    "admin" gagnait sur toutes les frames headshot car sa silhouette ronde
    matche le ⊕.
    """
    if not weapon_templates:
        return None, False, 0.0
    (x1, y1), (x2, y2) = weapon_box
    h, w = frame.shape[:2]
    # Padding vertical généreux : l'icône headshot ⊕ est rendue à ~17 px (vs
    # ~13 px pour le glyph de texte du killfeed) → la weapon_box (~13 px) ne
    # la contient pas verticalement. On élargit pour la capter en entier.
    pad_y = 6
    y1e = max(0, int(y1) - pad_y); y2e = min(h, int(y2) + pad_y)
    x1e = max(0, int(x1)); x2e = min(w, int(x2))
    if x2e <= x1e or y2e <= y1e:
        return None, False, 0.0
    crop = frame[y1e:y2e, x1e:x2e]
    target_gray = cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY)
    W = target_gray.shape[1]

    # --- Passe 1 : headshot ? ---
    # On cherche dans la moitié droite (là où le ⊕ apparaît systématiquement,
    # collé au nom de la victime). Si trouvé, on note où il commence pour
    # restreindre la recherche d'arme.
    headshot = False
    weapon_x_max = W  # par défaut, l'arme peut occuper toute la zone
    if headshot_template is not None:
        hs_g, hs_m = headshot_template
        # Recherche bornée à la moitié droite du target.
        search_left = max(0, W // 2)
        right_region = target_gray[:, search_left:]
        if right_region.shape[1] >= hs_g.shape[1] and right_region.shape[0] >= hs_g.shape[0]:
            hs_score, hs_x_local = _match_template_score(right_region, hs_g, hs_m)
            if hs_score is not None and hs_score >= headshot_min_score:
                headshot = True
                # Position absolue du début du headshot dans target_gray.
                # On exclut la zone du headshot (et 2 px de marge) du match arme.
                weapon_x_max = max(0, search_left + hs_x_local - 2)

    # --- Passe 2 : arme dans [0, weapon_x_max] ---
    target_for_weapon = target_gray[:, :weapon_x_max] if weapon_x_max < W else target_gray
    if target_for_weapon.shape[1] == 0:
        return None, headshot, 0.0

    best_name = None
    best_score = -1.0
    for name, (tpl_g, tpl_m) in weapon_templates.items():
        score, _ = _match_template_to_icon(target_for_weapon, tpl_g, tpl_m)
        if score is None:
            continue
        if score > best_score:
            best_score = score
            best_name = name

    weapon = best_name if best_score >= min_score else None
    return weapon, headshot, best_score


def _levenshtein(a: str, b: str) -> int:
    """Distance d'édition standard (DP en O(n*m)). Pure Python."""
    if len(a) < len(b):
        a, b = b, a
    if len(b) == 0:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a):
        curr = [i + 1]
        for j, cb in enumerate(b):
            ins = prev[j + 1] + 1
            del_ = curr[j] + 1
            sub = prev[j] + (0 if ca == cb else 1)
            curr.append(min(ins, del_, sub))
        prev = curr
    return prev[-1]


def _match_player(raws, roster_names: list, cutoff: float = 0.5,
                  with_ratio: bool = False):
    """
    Fuzzy-match contre une liste de pseudos roster (case-insensitive).
    Accepte un raw OCR (str) OU une liste de candidats (cas multi-PSM ×
    multi-upscale dans `_ocr_kill_name`). Retourne le nom canonique du
    meilleur match toutes-variantes-confondues, ou None si aucun candidat
    n'atteint le cutoff.

    Si `with_ratio=True`, retourne (name, ratio) ou (None, 0.0). Le ratio
    permet au dédup respawn de pondérer le vote sur le killer par la
    qualité du match plutôt que par le simple compte de frames — une frame
    qui matche "Myki" à 1.0 vaut plus qu'une frame qui matche "Thibs" à 0.6.

    Utilise Levenshtein (edit distance) plutôt que `difflib` (LCS) : le LCS
    bonus les préfixes communs, ce qui fait matcher "Thki" → "Thibs" au lieu
    de "Myki" alors qu'on est à 2 edits de Myki vs 3 de Thibs. Levenshtein
    pénalise correctement par longueur.

    cutoff 0.5 : laisse passer "Myhi"/"Myki" (ratio 0.75) tout en filtrant
    les misreads complets (`Thyhi` → ratio 0.0 vs Myki). Couplé au multi-
    candidat, on récupère le meilleur OCR sans baisser le seuil.
    """
    if not roster_names:
        return (None, 0.0) if with_ratio else None
    candidates = [raws] if isinstance(raws, str) else (raws or [])
    candidates = [c for c in candidates if c]
    if not candidates:
        return (None, 0.0) if with_ratio else None
    best_name = None
    best_ratio = 0.0
    for raw in candidates:
        raw_up = raw.upper()
        for n in roster_names:
            n_up = n.upper()
            max_len = max(len(raw_up), len(n_up))
            if max_len == 0:
                continue
            ratio = 1 - _levenshtein(raw_up, n_up) / max_len
            if ratio > best_ratio:
                best_ratio = ratio
                best_name = n
    if with_ratio:
        return (best_name, best_ratio) if best_ratio >= cutoff else (None, 0.0)
    return best_name if best_ratio >= cutoff else None


def _dedup_kills(observations: dict, window: int = 6, min_observations: int = 1,
                 respawn_window: int = 15) -> list:
    """
    Dédup multi-frame des observations killfeed. Un kill reste 5 s à l'écran ×
    sampling 1 Hz = ~5 observations par event. On veut un seul event par kill,
    daté à l'elapsed le plus tôt vu.

    Étape 1 — Cluster par paire (killer, victim) :
        au sein d'une paire, cluster les elapseds avec un gap max de `window` s.
        Chaque cluster = un event candidat (count = nb d'observations).

    Étape 2 — Dédup par victime (règle de respawn) :
        en EVA, un joueur tué a ~20 s avant respawn — il ne peut pas mourir 2×
        dans un délai court. Si deux events candidats ont la même victime à
        moins de `respawn_window` s d'écart, c'est forcément le même kill avec
        une OCR du killer ratée sur certaines frames (typiquement Myki↔Thibs).
        Vote majoritaire : on garde le killer avec le plus d'observations,
        on garde l'elapsed le plus tôt observé toutes paires confondues.

    Retourne [{'elapsed', 'killer', 'victim'}, ...] trié par elapsed. Format
    liste (et pas dict keyé par elapsed) pour préserver les kills simultanés :
    deux paires distinctes peuvent partager le même cluster start (kills à la
    même seconde) — un dict perdrait le premier au profit du second.
    """
    # --- Étape 1 : cluster par paire (killer, victim), avec score pondéré ---
    # Le score d'un cluster = somme des fuzzy match ratios (killer × victim).
    # Une frame qui matche fortement (1.0) compte plus qu'une frame qui
    # matche faiblement (0.6) — sert au vote respawn pour départager
    # killer correct vs misread quand les counts sont proches.
    # On collecte aussi weapon et headshot par observation pour propager au
    # final dedup (vote majoritaire arme, OR sur headshot).
    by_pair = {}
    for elapsed, obs_list in observations.items():
        for obs in obs_list:
            key = (obs['killer'], obs['victim'])
            kr = obs.get('killer_ratio', 1.0)
            vr = obs.get('victim_ratio', 1.0)
            by_pair.setdefault(key, []).append({
                'elapsed': int(elapsed),
                'score': kr * vr,
                'weapon': obs.get('weapon'),
                'headshot': bool(obs.get('headshot', False)),
            })

    def _finalize_cluster(cluster):
        weapons = [c['weapon'] for c in cluster if c['weapon']]
        weapon = None
        if weapons:
            # Vote majoritaire sur les frames qui ont matché une arme. Tie-break
            # arbitraire (premier ordre d'apparition) — peu d'impact en pratique.
            weapon = Counter(weapons).most_common(1)[0][0]
        # Headshot : vote majoritaire (≥50% des frames votent True). `any()`
        # explosait les FP : 1 frame avec un faux match du template ⊕ → kill
        # tagué headshot. Un vrai headshot apparaît sur la quasi-totalité des
        # frames d'affichage (~5 frames), donc > 50% est naturel.
        n_hs = sum(1 for c in cluster if c['headshot'])
        return {
            'count': len(cluster),
            'score': sum(c['score'] for c in cluster),
            'weapon': weapon,
            'headshot': n_hs * 2 > len(cluster),
        }

    candidates = []
    for (killer, victim), entries in by_pair.items():
        entries.sort(key=lambda x: x['elapsed'])
        if not entries:
            continue
        cluster = [entries[0]]
        for e in entries[1:]:
            if e['elapsed'] - cluster[-1]['elapsed'] > window:
                if len(cluster) >= min_observations:
                    fin = _finalize_cluster(cluster)
                    candidates.append({
                        'elapsed': cluster[0]['elapsed'], 'killer': killer, 'victim': victim,
                        **fin,
                    })
                cluster = [e]
            else:
                cluster.append(e)
        if len(cluster) >= min_observations:
            fin = _finalize_cluster(cluster)
            candidates.append({
                'elapsed': cluster[0]['elapsed'], 'killer': killer, 'victim': victim,
                **fin,
            })

    # --- Étape 2 : dédup par victime sur la fenêtre de respawn ---
    candidates.sort(key=lambda c: c['elapsed'])
    by_victim = {}
    for c in candidates:
        by_victim.setdefault(c['victim'], []).append(c)

    final = []
    for victim, group in by_victim.items():
        # Regroupe les events de cette victime qui sont à < respawn_window s
        # → ils représentent le même kill physique malgré des OCR de killer
        # potentiellement divergents.
        i = 0
        while i < len(group):
            j = i
            cluster_events = [group[i]]
            while j + 1 < len(group) and group[j + 1]['elapsed'] - group[i]['elapsed'] < respawn_window:
                cluster_events.append(group[j + 1])
                j += 1
            # Vote sur le killer : celui avec le score pondéré le plus haut
            # gagne (= somme des ratios fuzzy match killer × victim sur les
            # frames du cluster). Tie-break sur l'event le plus tôt.
            best = max(cluster_events, key=lambda c: (c['score'], -c['elapsed']))
            earliest = min(c['elapsed'] for c in cluster_events)
            # L'arme et le headshot sortent du cluster gagnant (= celui qui a
            # le plus de signal pour ce kill). Si le gagnant n'a pas d'arme
            # identifiée, fallback sur n'importe quel event du cluster.
            weapon = best['weapon']
            if weapon is None:
                for c in cluster_events:
                    if c['weapon']:
                        weapon = c['weapon']; break
            # Headshot final : majorité des events (eux-mêmes déjà vote-majo
            # frame-level dans _finalize_cluster).
            n_hs = sum(1 for c in cluster_events if c['headshot'])
            headshot = n_hs * 2 > len(cluster_events)
            # Format V3 positional : [elapsed, killer, victim, weapon, headshot].
            # ~3× plus compact en JSON que la version dict, ordre figé. Voir
            # KillsTimelineV3 côté front (game-analysis.model.ts) pour la doc
            # de l'ordre des champs.
            final.append([earliest, best['killer'], victim, weapon, headshot])
            i = j + 1

    final.sort(key=lambda k: k[0])
    return final


def _detect_kill_rows(frame: np.ndarray, kf_spec: dict, orange_color, blue_color,
                      tol_color: int = 40, white_min_channel: int = 150,
                      white_chan_diff: int = 25) -> list:
    """
    Row-scan du killfeed : on cluster les rows ayant du texte couleur d'équipe
    (avec tolérance de petits gaps au sein d'un cluster, le picto arme peut
    "manger" 1-2 rows de couleur), puis on valide chaque cluster en vérifiant
    qu'il contient assez de pixels near-white cumulés (= le picto arme).

    Le picto arme n'est PAS blanc pur (anti-aliasing → gris ~200,200,200), donc
    on détecte les pixels grayscale (max-min ≤ chan_diff) ET brillants (min ≥
    white_min_channel) plutôt qu'une simple proximité de (255,255,255).

    Retourne la liste des bbox de chaque bande de texte détectée, en coords
    absolues frame : [((x1, y1), (x2, y2)), ...]. Pas de vérif anti-faux-positif
    ici (étape 2). Si une couleur d'équipe est None, retourne [].
    """
    if orange_color is None or blue_color is None:
        return []

    (rx1, ry1), (rx2, ry2) = kf_spec['region']
    h, w = frame.shape[:2]
    rx1 = max(0, int(rx1)); ry1 = max(0, int(ry1))
    rx2 = min(w, int(rx2)); ry2 = min(h, int(ry2))
    if rx1 >= rx2 or ry1 >= ry2:
        return []

    sub = frame[ry1:ry2, rx1:rx2].astype(np.int16)

    m_orange = (np.abs(sub - np.array(orange_color, dtype=np.int16)) <= tol_color).all(axis=2)
    m_blue   = (np.abs(sub - np.array(blue_color,   dtype=np.int16)) <= tol_color).all(axis=2)

    sub_max = sub.max(axis=2)
    sub_min = sub.min(axis=2)
    m_white = (sub_min >= white_min_channel) & ((sub_max - sub_min) <= white_chan_diff)

    n_orange = m_orange.sum(axis=1)
    n_blue   = m_blue.sum(axis=1)
    n_white  = m_white.sum(axis=1)

    min_team        = kf_spec.get('minTextPixels', 4)
    max_gap         = kf_spec.get('rowGap', 3)
    min_total_white = kf_spec.get('minTotalWhitePixels', 20)
    target_h        = kf_spec.get('textHeight', 11)
    tol_h           = kf_spec.get('textHeightTol', 5)
    min_width       = kf_spec.get('minWidth', 80)

    is_text_row = (n_orange >= min_team) | (n_blue >= min_team)

    # Cluster avec tolérance de gap. Quand on dépasse max_gap rows consécutives
    # sans signal, on ferme le cluster en excluant les gap rows trailing.
    clusters = []
    in_cluster = False
    g_start = 0
    last_true = -1
    gap = 0
    for y in range(len(is_text_row)):
        if is_text_row[y]:
            if not in_cluster:
                in_cluster = True
                g_start = y
            last_true = y
            gap = 0
        elif in_cluster:
            gap += 1
            if gap > max_gap:
                clusters.append((g_start, last_true + 1))
                in_cluster = False
                gap = 0
    if in_cluster:
        clusters.append((g_start, last_true + 1))

    min_white_per_row = kf_spec.get('minWhitePerRow', 3)

    bboxes = []
    for (g_start, g_end) in clusters:
        # Trim cluster aux rows où le picto blanc est présent. Sans ça, un décor
        # de la couleur d'une équipe (ex : champ d'énergie bleu) prolonge le
        # cluster bien au-delà de la bande de texte → height check fail.
        # La bande de texte est exactement où le picto est visible.
        white_rows = np.where(n_white[g_start:g_end] >= min_white_per_row)[0]
        if len(white_rows) == 0:
            continue
        t_start = g_start + int(white_rows.min())
        t_end   = g_start + int(white_rows.max()) + 1

        height = t_end - t_start
        if abs(height - target_h) > tol_h:
            continue
        if int(n_white[t_start:t_end].sum()) < min_total_white:
            continue
        slab_o = m_orange[t_start:t_end]
        slab_b = m_blue[t_start:t_end]
        slab_w = m_white[t_start:t_end]
        cols = np.where(slab_o.any(axis=0) | slab_b.any(axis=0) | slab_w.any(axis=0))[0]
        if len(cols) == 0:
            continue
        width = int(cols.max()) - int(cols.min()) + 1
        if width < min_width:
            continue
        bbox_x1 = rx1 + int(cols.min())
        bbox_x2 = rx1 + int(cols.max()) + 1
        bbox_y1 = ry1 + t_start
        bbox_y2 = ry1 + t_end

        # Extension dynamique vers la gauche pour les pseudos killer longs.
        # La row a été détectée par la VICTIME (fond noir, dans la zone
        # conservatrice x≥1690). Le killer (fond transparent) peut s'étendre
        # bien plus à gauche. On scanne col par col vers la gauche tant qu'il
        # y a du signal team-color sur la y-band, jusqu'à `leftExtendLimit`.
        left_limit = kf_spec.get('leftExtendLimit')
        if left_limit is not None and bbox_x1 > left_limit:
            ext_max_gap = kf_spec.get('leftExtendMaxGap', 8)
            ext_x1 = max(0, int(left_limit))
            ext_x2 = bbox_x1
            ext_sub = frame[bbox_y1:bbox_y2, ext_x1:ext_x2].astype(np.int16)
            ext_o = (np.abs(ext_sub - np.array(orange_color, dtype=np.int16)) <= tol_color).all(axis=2)
            ext_b = (np.abs(ext_sub - np.array(blue_color,   dtype=np.int16)) <= tol_color).all(axis=2)
            ext_team = (ext_o.any(axis=0) | ext_b.any(axis=0))
            # Parcours de droite à gauche : on s'arrête au 1er gap de N cols
            # consécutives sans team-color (= espace entre killer et HUD vide).
            gap_run = 0
            new_x1 = bbox_x1
            for c in range(ext_team.shape[0] - 1, -1, -1):
                if ext_team[c]:
                    gap_run = 0
                    new_x1 = ext_x1 + c
                else:
                    gap_run += 1
                    if gap_run >= ext_max_gap:
                        break
            bbox_x1 = new_x1

        bbox = ((bbox_x1, bbox_y1), (bbox_x2, bbox_y2))
        if not _validate_kill_row(frame, bbox, kf_spec):
            continue
        bboxes.append(bbox)

    return bboxes


def _resolve_region(spec, frame: np.ndarray, dx: float = 0, dy: float = 0):
    """
    Résout un spec de région en box absolu ((x1,y1),(x2,y2)).
    - spec tuple ((x1,y1),(x2,y2)) → région statique, on applique le shift HUD (dx, dy).
    - spec dict {'colors', 'search', 'inset'} → région dynamique, on cherche la bordure colorée.
    Retourne None si la détection dynamique échoue.
    """
    if isinstance(spec, dict):
        return _find_text_border(
            frame, spec['colors'], spec['search'],
            tol_color=spec.get('tol_color', 20),
            min_pixels=spec.get('min_pixels', 50),
            inset=spec.get('inset', 0),
        )
    return _shift_box(spec, dx, dy)


def _detect_game_score_frame(frame: np.ndarray):
    """
    Détecte un écran de score final (tableau des scores entre les équipes).
    Retourne (mode_index, dx, dy) si détecté, (-1, 0.0, 0.0) sinon.
    (dx, dy) = décalage du HUD à appliquer aux régions OCR pour recadrer correctement.
    """
    for i, mode in enumerate(MODES):
        offset = _identify_offset(frame, mode['scoreFrame']['identify'])
        if offset is not None:
            return (i, offset[0], offset[1])
    return (-1, 0.0, 0.0)


def _detect_game_end_frame(frame: np.ndarray) -> bool:
    """
    Détecte l'écran de fin de partie (résumé post-match avec les deux côtés colorés orange/bleu).
    Miroir de detectGameEndFrame() en TypeScript.
    """
    return (
        _color_similar(_get_pixel(frame, 387, 417), (251, 209, 0)) and
        _color_similar(_get_pixel(frame, 481, 472), (252, 205, 4)) and
        _color_similar(_get_pixel(frame, 1498, 437), (46, 144, 242)) and
        _color_similar(_get_pixel(frame, 1630, 486), (46, 136, 226))
    )


def _detect_game_loading_frame(frame: np.ndarray, mode_index: int) -> bool:
    """
    Détecte l'écran de chargement (logo EVA blanc sur fond noir) pour un mode donné.
    Teste chaque variante de position de logo définie dans loadingFrames du mode.
    Miroir de detectGameLoadingFrame() en TypeScript.
    """
    for LF in MODES[mode_index]['loadingFrames']:
        if (_color_similar(_get_pixel(frame, LF['logoTop'][0],    LF['logoTop'][1]),    (255, 255, 255)) and
                _color_similar(_get_pixel(frame, LF['logoLeft'][0],   LF['logoLeft'][1]),   (255, 255, 255)) and
                _color_similar(_get_pixel(frame, LF['logoRight'][0],  LF['logoRight'][1]),  (255, 255, 255)) and
                _color_similar(_get_pixel(frame, LF['logoMiddle'][0], LF['logoMiddle'][1]), (255, 255, 255)) and
                _color_similar(_get_pixel(frame, LF['logoBlack1'][0], LF['logoBlack1'][1]), (0, 0, 0)) and
                _color_similar(_get_pixel(frame, LF['logoBlack2'][0], LF['logoBlack2'][1]), (0, 0, 0)) and
                _color_similar(_get_pixel(frame, LF['logoBlack3'][0], LF['logoBlack3'][1]), (0, 0, 0)) and
                _color_similar(_get_pixel(frame, LF['logoBlack4'][0], LF['logoBlack4'][1]), (0, 0, 0))):
            return True
    return False


def _detect_game_intro(frame: np.ndarray) -> bool:
    """
    Détecte l'écran d'introduction de map (lettre 'B' du logo EVA en bas à droite).
    Miroir de detectGameIntro() en TypeScript.
    """
    for PATTERN in _A_PATTERNS:
        if all(_color_similar(_get_pixel(frame, p[0], p[1]), (p[2], p[2], p[2]), p[3])
               for p in PATTERN):
            return True
    return False


def _detect_game_playing(frame: np.ndarray) -> bool:
    """
    Détecte un frame de jeu en cours via les pixels d'identify du playingFrame.
    """
    for mode in MODES:
        if _identify_offset(frame, mode['playingFrame']['identify']) is not None:
            return True
    return False

# ---------------------------------------------------------------------------
# Video utilities
# ---------------------------------------------------------------------------

def _get_video_duration(cap: cv2.VideoCapture) -> float:
    """Retourne la durée en secondes via la capture OpenCV déjà ouverte."""
    FPS = cap.get(cv2.CAP_PROP_FPS)
    FRAMES = cap.get(cv2.CAP_PROP_FRAME_COUNT)
    if FPS > 0 and FRAMES > 0:
        return FRAMES / FPS
    return 0.0


def _get_frame(cap: cv2.VideoCapture, timestamp: float):
    """
    Seek à *timestamp* et décode une frame via la capture OpenCV déjà ouverte.
    Pas de spawn de processus — équivalent à video.currentTime du navigateur.
    La frame est retournée en RGB (conversion depuis BGR d'OpenCV).
    """
    cap.set(cv2.CAP_PROP_POS_MSEC, max(0.0, timestamp) * 1000)
    RET, FRAME_BGR = cap.read()
    if not RET or FRAME_BGR is None:
        return None
    return cv2.cvtColor(FRAME_BGR, cv2.COLOR_BGR2RGB)

# ---------------------------------------------------------------------------
# Game dict factory
# ---------------------------------------------------------------------------

def _new_game(mode: int, orange_override: str, blue_override: str) -> dict:
    """
    Crée et retourne un dict représentant un nouveau jeu en cours de détection.
    orange_override / blue_override : noms d'équipe forcés par les settings utilisateur (peuvent être vides).
    __jumped__ : flag interne indiquant que le saut de timer a déjà été effectué pour ce jeu.
    """
    return {
        'mode': mode,
        'start': -1,
        'end': -1,
        'map': '',
        'mapImage': None,
        '__jumped__': False,
        'orangeTeam': {
            'name': orange_override.upper() if orange_override else '',
            'score': 0,
            'nameImage': None,
            'scoreImage': None,
        },
        'blueTeam': {
            'name': blue_override.upper() if blue_override else '',
            'score': 0,
            'nameImage': None,
            'scoreImage': None,
        },
    }


def _set_score(game: dict, team: str, raw: str) -> None:
    """Affecte le score OCR raw au dict team de game si la valeur est un entier valide (0–100)."""
    try:
        V = int(raw)
        if 0 <= V <= 100:
            #_emit({'log': team + ' score : ' + raw})
            game[team]['score'] = V
    except Exception:
        pass

# ---------------------------------------------------------------------------
# Backward analysis — mirrors videoTimeUpdate() from the TypeScript component
# ---------------------------------------------------------------------------

def _analyze(
    video_path: str,
    ffmpeg_path: str,
    orange_override: str,
    blue_override: str,
    max_time_per_game: int = 10,
) -> None:
    """
    Analyse la vidéo en sens inverse (de la fin vers le début) pour détecter les jeux.
    Miroir exact de videoTimeUpdate() dans replay_cutter.component.ts.

    Algorithme :
      - Démarre à TIMESTAMP = durée totale, recule de 1 s à chaque itération.
      - Score frame  → crée CURRENT avec end = TIMESTAMP, OCR scores/noms.
      - End frame    → idem (écran post-match alternatif).
      - Loading/Intro → ferme CURRENT avec start = TIMESTAMP + 2.
      - Playing frame → OCR map + noms d'équipes ; une fois les 3 collectés,
                        lit le timer OCR et saute en arrière de
                        (max_time - M) * 60 - S - 20 secondes pour éviter
                        de parcourir toute la durée du jeu seconde par seconde.
    """
    # Hardware-accelerated decode : VideoToolbox sur macOS, D3D11 sur Windows.
    # Fallback sur CAP_FFMPEG (software) si le backend natif échoue.
    if sys.platform == 'darwin':
        CAP = cv2.VideoCapture(video_path, cv2.CAP_AVFOUNDATION)
    else:
        CAP = cv2.VideoCapture(video_path, cv2.CAP_FFMPEG)
        CAP.set(cv2.CAP_PROP_HW_ACCELERATION, cv2.VIDEO_ACCELERATION_D3D11)
    if not CAP.isOpened():
        CAP = cv2.VideoCapture(video_path, cv2.CAP_FFMPEG)
    if not CAP.isOpened():
        _emit({'type': 'error', 'message': f'Cannot open video: {video_path}'})
        return
    DURATION = _get_video_duration(CAP)

    GAMES: list = []   # completed games (index 0 = most recent, same as TS unshift)
    CURRENT: dict = None   # game with end set, start still pending
    TIMESTAMP: float = DURATION
    JUST_JUMPED: bool = False

    LAST_SEND_PERCENT: int = -1
    LAST_SEND_COMPLETED_COUNT: int = -1

    while TIMESTAMP > 0:
        PERCENT = int((1.0 - TIMESTAMP / DURATION) * 100) if DURATION > 0 else 0

        COMPLETED_COUNT = sum(1 for g in GAMES if g['start'] != -1)
        if PERCENT != LAST_SEND_PERCENT or COMPLETED_COUNT != LAST_SEND_COMPLETED_COUNT:
            _emit({'type': 'progress', 'percent': PERCENT, 'nbGames': COMPLETED_COUNT, 'time': TIMESTAMP})
            LAST_SEND_PERCENT = PERCENT
            LAST_SEND_COMPLETED_COUNT = COMPLETED_COUNT

        FRAME = _get_frame(CAP, TIMESTAMP)
        if FRAME is None:
            TIMESTAMP -= 1.0
            continue

        FOUND = False

        # ── Score frame ────────────────────────────────────────────────────
        # Only create a new game when there is no pending one (start == -1).
        if not FOUND and (CURRENT is None or CURRENT['start'] != -1):
            SCORE_MODE, SF_DX, SF_DY = _detect_game_score_frame(FRAME)
            if SCORE_MODE >= 0:
                #_emit({'log': f'Score frame found {SCORE_MODE} (HUD offset dx={SF_DX:+.1f}, dy={SF_DY:+.1f})'})
                FOUND = True
                JUST_JUMPED = False
                GAME = _new_game(SCORE_MODE, orange_override, blue_override)
                GAME['end'] = TIMESTAMP - 1
                _SF_RAW = MODES[SCORE_MODE]['scoreFrame']
                # Noms d'équipe : bbox dynamique trouvé via la bordure colorée.
                # Scores : bbox statique, juste translaté de l'offset HUD identifié.
                ON = _resolve_region(_SF_RAW['orangeName'], FRAME, SF_DX, SF_DY)
                BN = _resolve_region(_SF_RAW['blueName'],   FRAME, SF_DX, SF_DY)
                OS = _resolve_region(_SF_RAW['orangeScore'], FRAME, SF_DX, SF_DY)
                BS = _resolve_region(_SF_RAW['blueScore'],   FRAME, SF_DX, SF_DY)
                #for label, box in (('orange name', ON), ('blue name', BN), ('orange score', OS), ('blue score', BS)):
                    #if box is not None:
                        #_emit({'log': f'{label} border: {box}'})
                    #else:
                        #_emit({'log': f'[border] {label} not found in search region'})

                if ON is not None and not GAME['orangeTeam']['name']:
                    T = _ocr_region(
                        FRAME,
                        ON[0][0], ON[0][1], ON[1][0], ON[1][1],
                        psm=7,
                        whitelist='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
                        luminance=100, apply_filter=True,
                    )
                    if T and len(T) >= 2:
                        #_emit({'log': 'Orange team name : '+T.upper()})
                        GAME['orangeTeam']['name'] = T.upper()

                if OS is not None:
                    _set_score(GAME, 'orangeTeam', _ocr_region(
                        FRAME,
                        OS[0][0], OS[0][1], OS[1][0], OS[1][1],
                        psm=7, extra_psms=[8], whitelist='0123456789%', luminance=100, apply_filter=True, lang='evadigits',
                        checker=_score_checker,
                    ))

                if BN is not None and not GAME['blueTeam']['name']:
                    T = _ocr_region(
                        FRAME,
                        BN[0][0], BN[0][1], BN[1][0], BN[1][1],
                        psm=7,
                        whitelist='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
                        luminance=100, apply_filter=True,
                    )
                    if T and len(T) >= 2:
                        #_emit({'log': 'Blue team name : '+T.upper()})
                        GAME['blueTeam']['name'] = T.upper()

                if BS is not None:
                    _set_score(GAME, 'blueTeam', _ocr_region(
                        FRAME,
                        BS[0][0], BS[0][1], BS[1][0], BS[1][1],
                        psm=7, extra_psms=[8], whitelist='0123456789%', luminance=100, apply_filter=True, lang='evadigits',
                        checker=_score_checker,
                    ))

                if ON is not None:
                    GAME['orangeTeam']['nameImage']  = _region_to_base64(FRAME, ON[0][0], ON[0][1], ON[1][0], ON[1][1])
                if OS is not None:
                    GAME['orangeTeam']['scoreImage'] = _region_to_base64(FRAME, OS[0][0], OS[0][1], OS[1][0], OS[1][1])
                if BN is not None:
                    GAME['blueTeam']['nameImage']    = _region_to_base64(FRAME, BN[0][0], BN[0][1], BN[1][0], BN[1][1])
                if BS is not None:
                    GAME['blueTeam']['scoreImage']   = _region_to_base64(FRAME, BS[0][0], BS[0][1], BS[1][0], BS[1][1])

                GAMES.insert(0, GAME)
                CURRENT = GAME

        # ── End frame ──────────────────────────────────────────────────────
        if not FOUND and (CURRENT is None or CURRENT['start'] != -1):
            if _detect_game_end_frame(FRAME):
                #_emit({'log': 'End frame found'})
                FOUND = True
                JUST_JUMPED = False
                GAME = _new_game(1, orange_override, blue_override)
                GAME['end'] = TIMESTAMP
                EF = MODES[1]['endFrame']
                _set_score(GAME, 'orangeTeam', _ocr_region(
                    FRAME,
                    EF['orangeScore'][0][0], EF['orangeScore'][0][1],
                    EF['orangeScore'][1][0], EF['orangeScore'][1][1],
                    psm=7, whitelist='0123456789%', checker=_score_checker,
                ))
                _set_score(GAME, 'blueTeam', _ocr_region(
                    FRAME,
                    EF['blueScore'][0][0], EF['blueScore'][0][1],
                    EF['blueScore'][1][0], EF['blueScore'][1][1],
                    psm=7, whitelist='0123456789%', checker=_score_checker,
                ))
                GAMES.insert(0, GAME)
                CURRENT = GAME

        # ── Game start: loading screen ──────────────────────────────────────
        if not FOUND and CURRENT is not None and CURRENT['start'] == -1:
            if _detect_game_loading_frame(FRAME, CURRENT['mode']):
                #_emit({'log': 'Loading frame found'})
                FOUND = True
                JUST_JUMPED = False
                # Scan forward to find the first actual gameplay frame.
                PROBE = TIMESTAMP + 1
                GAME_START = TIMESTAMP
                while PROBE <= TIMESTAMP + 30:
                    PROBE_FRAME = _get_frame(CAP, PROBE)
                    if PROBE_FRAME is not None and _detect_game_playing(PROBE_FRAME):
                        GAME_START = PROBE
                        break
                    #_emit({'log': 's'})
                    PROBE += 0.5
                CURRENT['start'] = GAME_START
                #_emit({'log': f'First game frame detected at {GAME_START:.1f}s'})
                _emit({'type': 'game', 'game': CURRENT})
                CURRENT = None   # game complete

        # ── Game start: map introduction ────────────────────────────────────
        if not FOUND and CURRENT is not None and CURRENT['start'] == -1:
            if _detect_game_intro(FRAME):
                #_emit({'log': 'Game intro frame found'})
                FOUND = True
                JUST_JUMPED = False
                # Scan forward to find the first actual gameplay frame.
                PROBE = TIMESTAMP + 1
                GAME_START = TIMESTAMP
                while PROBE <= TIMESTAMP + 30:
                    PROBE_FRAME = _get_frame(CAP, PROBE)
                    if PROBE_FRAME is not None and _detect_game_playing(PROBE_FRAME):
                        GAME_START = PROBE
                        break
                    PROBE += 0.5
                CURRENT['start'] = GAME_START
                #_emit({'log': f'First game frame detected at {GAME_START:.1f}s'})
                _emit({'type': 'game', 'game': CURRENT})
                CURRENT = None

        # ── Playing frame: OCR map / team names + timer jump ────────────────
        if not FOUND and CURRENT is not None and CURRENT['start'] == -1:
            if _detect_game_playing(FRAME):
                FOUND = True
                #_emit({'log': 'Playing frame found'})

                GF        = MODES[CURRENT['mode']]['gameFrame']
                MAP_BOX   = GF['map']
                ON_BOX    = GF['orangeName']
                BN_BOX    = GF['blueName']
                TIMER_BOX = GF['timer']

                if not CURRENT['map']:
                    T = _ocr_color_masked(
                        FRAME,
                        MAP_BOX[0][0], MAP_BOX[0][1], MAP_BOX[1][0], MAP_BOX[1][1],
                        target_color=(255, 255, 255),
                        whitelist='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz ',
                        tol_color=35
                    )
                    if T:
                        MAP_NAME = _get_map_by_name(T)
                        if MAP_NAME:
                            #_emit({'log': 'map name : ' + MAP_NAME})
                            CURRENT['map'] = MAP_NAME
                            CURRENT['mapImage'] = _region_to_base64(
                                FRAME,
                                MAP_BOX[0][0], MAP_BOX[0][1], MAP_BOX[1][0], MAP_BOX[1][1],
                            )
                        else:
                            _emit({"Can't find map name": T})

                if not CURRENT['orangeTeam']['name']:
                    T = _ocr_region(
                        FRAME,
                        ON_BOX[0][0], ON_BOX[0][1], ON_BOX[1][0], ON_BOX[1][1],
                        psm=6,
                        whitelist='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
                    )
                    if T and len(T) >= 2:
                        #_emit({'log': 'orange team name : ' + T.upper()})
                        CURRENT['orangeTeam']['name'] = T.upper()

                if not CURRENT['blueTeam']['name']:
                    T = _ocr_region(
                        FRAME,
                        BN_BOX[0][0], BN_BOX[0][1], BN_BOX[1][0], BN_BOX[1][1],
                        psm=6,
                        whitelist='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
                    )
                    if T and len(T) >= 2:
                        #_emit({'log': 'blue team name : ' + T.upper()})
                        CURRENT['blueTeam']['name'] = T.upper()

                # Timer jump — mirrors the TS optimization exactly.
                # When all game metadata is collected, read the game timer and
                # jump backward to just before the game start to find loading/intro
                # faster, skipping the bulk of the gameplay footage.
                if (CURRENT['map']
                        and CURRENT['orangeTeam']['name']
                        and CURRENT['blueTeam']['name']
                        and not CURRENT['__jumped__']
                        and not JUST_JUMPED):
                    TIMER = _ocr_region(
                        FRAME,
                        TIMER_BOX[0][0], TIMER_BOX[0][1], TIMER_BOX[1][0], TIMER_BOX[1][1],
                        psm=7, extra_psms=[8], whitelist='0123456789:',
                        luminance=100, apply_filter=True, lang='evadigits',
                        #debug_save_bw='timer_',
                    )
                    if TIMER:
                        #_emit({'log': 'timer : ' + TIMER})
                        # Tesseract loupe parfois le ":" → "0205" au lieu de "02:05".
                        # On accepte 4 ou 5 caractères et on reconstruit MM:SS.
                        PARTS = None
                        if len(TIMER) == 5 and ':' in TIMER:
                            PARTS = TIMER.split(':')
                        elif len(TIMER) == 4 and TIMER.isdigit():
                            PARTS = [TIMER[:2], TIMER[2:]]
                        if PARTS and len(PARTS) == 2:
                            try:
                                M, S = int(PARTS[0]), int(PARTS[1])
                                # Sanity-check OCR : un timer valide a M ∈ [0, max_time_per_game]
                                # et S ∈ [0, 59]. Sans ça un OCR foireux comme "0:3228"
                                # produit un DIFF négatif → TIMESTAMP saute en avant
                                # dans la vidéo et l'algo backward boucle indéfiniment.
                                VALID = 0 <= M <= max_time_per_game and 0 <= S < 60
                                #_emit({'log': f'timer parsed m={M} s={S} valid={VALID} max_time_per_game={max_time_per_game}'})
                                if VALID:
                                    SECURITY = 20
                                    DIFF = (max_time_per_game - M) * 60 - S - SECURITY
                                    if DIFF > 0:
                                        #_emit({'log': "Try to jump " + str(DIFF)})
                                        CURRENT['__jumped__'] = True
                                        JUST_JUMPED = True
                                        TIMESTAMP -= DIFF
                                        continue   # skip TIMESTAMP -= STEP
                            except Exception as e:
                                print(e)
                                pass
        #if not FOUND:
            #_emit({'log': "Can't identify frame"})

        # Après un timer jump on est près du début du jeu → STEP=1 pour ne pas
        # rater l'écran de chargement. Dans toutes les autres zones (post-game,
        # stats, etc.) STEP=2 divise par 2 le nombre de seeks inutiles.
        STEP = 1.0 if JUST_JUMPED else 2.0
        TIMESTAMP -= STEP

    CAP.release()

    if len(GAMES) == 1:
        _emit({'type': 'game', 'game': CURRENT})

    _emit({'type': 'done'})

#region Chunk analysis — phase 2 : score timeline indexée par le timer in-game

def _parse_timer_text(timer_text: str):
    """
    Parse une chaîne timer ('MM:SS' ou 'MMSS' si Tesseract loupe le ':')
    et retourne le tuple (M, S), ou None si non parsable.
    Aucune validation de bornes — l'appelant valide selon son contexte
    (en phase 2, la borne max dépend du max_time_per_game auto-détecté).
    """
    if not timer_text:
        return None
    PARTS = None
    if len(timer_text) == 5 and ':' in timer_text:
        PARTS = timer_text.split(':')
    elif len(timer_text) == 4 and timer_text.isdigit():
        PARTS = [timer_text[:2], timer_text[2:]]
    if not PARTS or len(PARTS) != 2:
        return None
    try:
        return (int(PARTS[0]), int(PARTS[1]))
    except Exception:
        return None


def _reconstruct_field(raw_obs: dict, field: str, max_score, max_rate: int = MAX_SCORE_RATE_PER_SECOND) -> dict:
    """
    Reconstruction globale de la timeline d'un champ (orange/blue) à partir
    des lectures OCR brutes via programmation dynamique.

    Cherche f: elapsed → score, monotone non-décroissante, avec
    f(K) - f(K-1) ∈ [0, max_rate] et 0 ≤ f(K) ≤ max_score, qui MAXIMISE
    l'accord avec les observations (= minimise le nombre de lectures OCR
    en désaccord avec f). C'est la solution optimale au sens du nombre
    d'observations honorées sous les contraintes physiques.

    Complexité O(T * V * max_rate) ; pour T~600s et V~100, instantané.

    Avantages vs validation à l'insertion :
    - Une hallucination isolée (1-2 frames) est dominée par le consensus
      des frames voisines, sans pouvoir polluer la suite par cascade de
      rejets monotones.
    - Pas de seuil arbitraire (fenêtre, tolérance) : seules les contraintes
      physiques du jeu (monotonie, rate cap, bornes) interviennent.
    - Décision globale plutôt que séquentielle : un point ambigu en début
      de chunk peut être tranché par les observations qui le suivent.

    raw_obs : {elapsed: {'orange': [v1, ...], 'blue': [v1, ...]}}
    Retourne : {elapsed: value} pour les K avec au moins une observation.
    """
    if max_score is None:
        max_score = 100
    V_MAX = int(max_score)
    if V_MAX < 0:
        return {}

    OBS_COUNTS = {}
    for K, FIELDS in raw_obs.items():
        VALUES = FIELDS.get(field) or []
        if VALUES:
            OBS_COUNTS[K] = Counter(VALUES)
    if not OBS_COUNTS:
        return {}

    T_MIN = min(OBS_COUNTS)
    T_MAX = max(OBS_COUNTS)
    T_LEN = T_MAX - T_MIN + 1

    INF = float('inf')
    DP = [[INF] * (V_MAX + 1) for _ in range(T_LEN)]
    PARENT = [[-1] * (V_MAX + 1) for _ in range(T_LEN)]

    # Init : aucune contrainte amont, coût = mismatchs à T_MIN.
    COUNTS_0 = OBS_COUNTS.get(T_MIN, Counter())
    TOTAL_0 = sum(COUNTS_0.values())
    for v in range(V_MAX + 1):
        DP[0][v] = TOTAL_0 - COUNTS_0.get(v, 0)

    for OFF in range(1, T_LEN):
        K = T_MIN + OFF
        COUNTS = OBS_COUNTS.get(K, Counter())
        TOTAL = sum(COUNTS.values())
        for v in range(V_MAX + 1):
            MISMATCH = TOTAL - COUNTS.get(v, 0)
            BEST_COST = INF
            BEST_PREV = -1
            for DELTA in range(0, max_rate + 1):
                PREV_V = v - DELTA
                if PREV_V < 0:
                    break
                if DP[OFF - 1][PREV_V] < BEST_COST:
                    BEST_COST = DP[OFF - 1][PREV_V]
                    BEST_PREV = PREV_V
            if BEST_COST < INF:
                DP[OFF][v] = BEST_COST + MISMATCH
                PARENT[OFF][v] = BEST_PREV

    LAST_OFF = T_LEN - 1
    BEST_V = 0
    BEST_COST = INF
    for v in range(V_MAX + 1):
        if DP[LAST_OFF][v] < BEST_COST:
            BEST_COST = DP[LAST_OFF][v]
            BEST_V = v
    if BEST_COST == INF:
        return {}

    PATH = [0] * T_LEN
    v = BEST_V
    for OFF in range(T_LEN - 1, -1, -1):
        PATH[OFF] = v
        if OFF > 0:
            v = PARENT[OFF][v]
            if v < 0:
                break

    return {T_MIN + OFF: PATH[OFF] for OFF in range(T_LEN) if (T_MIN + OFF) in OBS_COUNTS}


def _color_isolated_bw(frame: np.ndarray, box, colors: list, tol: int = 50) -> Image.Image:
    """
    Crée une image PIL N&B isolant les pixels matchant `colors` dans la région `box`
    du frame. Pixels matchants → noir (texte), tout le reste → blanc (fond).
    Élimine les ombres, fonds et artefacts qui parasitent un seuil de luminance
    générique. La signature visuelle d'un score EVA, c'est sa couleur d'équipe.
    """
    X1, Y1 = int(box[0][0]), int(box[0][1])
    X2, Y2 = int(box[1][0]), int(box[1][1])
    REGION = frame[Y1:Y2, X1:X2].astype(np.int16)
    MASK = np.zeros(REGION.shape[:2], dtype=bool)
    for C in colors:
        TARGET = np.array(C, dtype=np.int16)
        MASK |= (np.abs(REGION - TARGET) <= tol).all(axis=2)
    BW = np.full(REGION.shape[:2], 255, dtype=np.uint8)
    BW[MASK] = 0
    return Image.fromarray(BW, mode='L').convert('RGB')


def _ocr_timer_fast(frame: np.ndarray, box, text_color=(10, 10, 10), tol_color: int = 50) -> str:
    """
    Fast-path timer OCR : sélection du texte par MATCH COULEUR (texte ~rgb(10,10,10)
    sur fond ~rgb(137,137,137)) plutôt que par luminance. Évite que la pure
    silhouette d'un glyph anti-aliasé borderline soit reconstruite à tort
    (ex : un "0" dont le seuillage casse la boucle → lu "3").

    Polarité conservée : pixels texte → blanc, fond → noir. lang='evadigits' a
    été entraîné sur cette polarité.
    """
    x1, y1 = int(box[0][0]), int(box[0][1])
    x2, y2 = int(box[1][0]), int(box[1][1])
    SUB = frame[y1:y2, x1:x2].astype(np.int16)
    DIFF = np.abs(SUB - np.array(text_color, dtype=np.int16)).max(axis=2)
    MASK = DIFF <= tol_color
    BW = np.where(MASK, 255, 0).astype(np.uint8)
    try:
        TEXT = pytesseract.image_to_string(
            Image.fromarray(BW).convert('RGB'),
            lang='evadigits',
            config='--psm 7 -c tessedit_char_whitelist=0123456789:',
        ).replace('\r', '').replace('\n', '').strip()
        return re.sub(r'[^0-9:]', '', TEXT)
    except Exception:
        return ''


def _ocr_score_at(frame: np.ndarray, spec: dict, colors: list, max_score: int = None) -> int:
    """
    OCR un score in-game et retourne un int 0-100, ou None si invalide.
    Pré-traitement par masque couleur : seuls les pixels matchant `colors` sont
    rendus noirs, le reste blanc. Élimine les artefacts.
    `max_score` (optionnel) : borne supérieure connue (score final de la game).
    Tout résultat OCR > max_score est traité comme hallucination → None.

    DEBUG : tout cas qui retourne None dump une image dans ~/Downloads/train pour
    inspection. Préfixe de fichier distinct selon la cause :
      - score_nobox_*  : pas assez de pixels colorés détectés (bbox introuvable)
      - score_fail_*   : OCR n'a rien retourné de valide
      - score_max_*    : OCR a retourné une valeur > max_score (hallucination)
    """
    BOX = _resolve_region(spec, frame)
    if BOX is None:
        return None
    BW = _color_isolated_bw(frame, BOX, colors)
    WHITELIST = '0123456789%'
    FILTER_PATTERN = re.compile(f'[^{re.escape(WHITELIST)}]')
    # PSM 7 seul (single line) : suffit dans la quasi-totalité des cas avec
    # le pré-masque couleur. Fallback PSM 8 (single word) seulement si PSM 7
    # n'a rien retourné de valide → divise par 2 le coût scores en nominal.
    RESULTS = []
    for PSM in (7, 8):
        try:
            TEXT = pytesseract.image_to_string(
                BW, lang='evadigits',
                config=f'--psm {PSM} -c tessedit_char_whitelist={WHITELIST}',
            ).replace('\r', '').replace('\n', '').strip()
            TEXT = FILTER_PATTERN.sub('', TEXT)
            CHECKED = _score_checker(TEXT)
            if CHECKED:
                RESULTS.append(CHECKED)
        except Exception:
            pass
        if RESULTS:
            break
    V = None
    if RESULTS:
        try:
            CANDIDATE = int(_most_frequent(RESULTS))
            if 0 <= CANDIDATE <= 100:
                V = CANDIDATE
        except Exception:
            pass
    REJECTED_BY_MAX = (V is not None and max_score is not None and V > max_score)
    if REJECTED_BY_MAX:
        V = None
    return V


def _open_video(video_path: str):
    """Ouvre la vidéo avec accélération hardware si disponible. Retourne None si KO."""
    if sys.platform == 'darwin':
        CAP = cv2.VideoCapture(video_path, cv2.CAP_AVFOUNDATION)
    else:
        CAP = cv2.VideoCapture(video_path, cv2.CAP_FFMPEG)
        CAP.set(cv2.CAP_PROP_HW_ACCELERATION, cv2.VIDEO_ACCELERATION_D3D11)
    if not CAP.isOpened():
        CAP = cv2.VideoCapture(video_path, cv2.CAP_FFMPEG)
    if not CAP.isOpened():
        return None
    return CAP


def _analyze_chunks(video_path: str, settings: dict) -> None:
    """
    Phase 2 : analyse approfondie de chunks pré-identifiés. Pour chaque chunk,
    on seek seconde par seconde sur [start, end], on OCR (timer, scoreOrange,
    scoreBlue), on convertit le timer en temps écoulé in-game, puis on insère
    dans samples[elapsed] si :
      - le timer parse en (M, S) valide
      - les deux scores parsent en int ∈ [0, 100]
      - cette seconde de jeu n'a pas déjà été collectée (first OCR wins)
      - l'insertion respecte la monotonie globale du dict

    Auto-détection de la durée totale : la première lecture timer valide
    fixe MAX_TIME du chunk via ceil((M*60+S)/60). Pas besoin de configurer
    maxTimePerGame côté Site — le HUD dit la vérité (même heuristique que
    le timer jump de la phase 1 : première lecture valide gagne).
    """
    CHUNKS = settings.get('chunks', []) or []
    # Plafond connu de la durée d'une game (10 min en EVA standard). Sert à
    # rejeter les OCR aberrants sur la 1ère frame du chunk : si le timer est
    # OCR'd "13:00" alors que la vraie valeur est "10:00", sans cap on
    # initialise MAX_TIME=13 et toute la timeline est shiftée. Avec cap, on
    # rejette et on attend une lecture cohérente.
    MAX_TIME_CAP = int(settings.get('maxTimePerGame', 10))
    #_emit({'log': f'[_analyze_chunks] {settings}'})

    if not CHUNKS:
        #_emit({'percent': 100, 'results': []})
        return

    CAP = _open_video(video_path)
    if CAP is None:
        #_emit({'percent': 0, 'results': [], 'error': f'Cannot open video: {video_path}'})
        return

    TOTAL_SECONDS = sum(max(0, int(c['endSeconds']) - int(c['startSeconds'])) for c in CHUNKS)
    PROCESSED_SECONDS = 0
    LAST_PERCENT = -1

    # Sizing adaptatif machine. WINDOW = nombre de frames in-flight ; chaque
    # frame consomme jusqu'à 3 workers (timer + 2 scores). Sur 4 cœurs ou moins
    # (laptop type client), WINDOW=1 et pool=3 → comportement strictement
    # identique à l'avant-pipeline (pas de régression). Sur des machines plus
    # grosses, WINDOW monte pour saturer les cœurs. Cap à 4 pour limiter la
    # mémoire (chaque frame ≈ 6 MB) et le coût des forks Tesseract simultanés.
    CPU = os.cpu_count() or 4
    WINDOW = max(1, min(CPU // 4, 4))
    MAX_WORKERS = max(3, WINDOW * 3)
    EXECUTOR = ThreadPoolExecutor(max_workers=MAX_WORKERS)
    #_emit({'log': f'[_analyze_chunks] cpu={CPU} window={WINDOW} workers={MAX_WORKERS}'})

    # Templates pour identifier l'arme et le headshot icon dans chaque kill row.
    # Chargés une seule fois en début de run. Le dossier `templates/` est résolu
    # depuis le PYINSTALLER bundle (sys._MEIPASS) ou le répertoire du script.
    TEMPLATE_BASE = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
    TEMPLATE_DIR = os.path.join(TEMPLATE_BASE, 'templates')
    WEAPON_TEMPLATES = _load_weapon_templates(TEMPLATE_DIR)
    HEADSHOT_TEMPLATE = _load_headshot_template(TEMPLATE_DIR)
    #_emit({'log': f'[_analyze_chunks] loaded {len(WEAPON_TEMPLATES)} weapon templates, headshot={HEADSHOT_TEMPLATE is not None}'})

    for CHUNK in CHUNKS:
        GAME_ID = CHUNK['gameID']
        START = int(CHUNK['startSeconds'])
        END = int(CHUNK['endSeconds'])
        MODE_INDEX = int(CHUNK.get('mode', 0))
        # Bornes supérieures : score final connu de la game (issu du scoreFrame
        # détecté en phase 1). Un OCR in-game ne peut PHYSIQUEMENT pas dépasser
        # le score final — sinon c'est une hallucination.
        MAX_ORANGE = CHUNK.get('orangeScore')
        MAX_BLUE = CHUNK.get('blueScore')

        # Rosters trustés issus de l'API /games/identify (appelée AVANT phase 2
        # par le client). Format : [{name, K, D}, ...]. Sera utilisé à l'étape 4
        # comme référence pour le fuzzy match des pseudos OCR du killfeed. Si
        # la game n'a pas matché côté back, listes vides → fallback OCR-only.
        ORANGE_ROSTER = CHUNK.get('orangePlayers') or []
        BLUE_ROSTER = CHUNK.get('bluePlayers') or []
        #if ORANGE_ROSTER or BLUE_ROSTER:
            #_emit({'log': f'[_analyze_chunks] {GAME_ID} roster orange=' + str([p.get('name') for p in ORANGE_ROSTER]) + ' blue=' + str([p.get('name') for p in BLUE_ROSTER])})

        # Fichier user_words pour Tesseract : biaise (faiblement) le LM vers
        # les pseudos roster connus. Effet modeste (~+1 kill / 80 sur LE TEST)
        # car PSM 7/8 + whitelist court-circuite le LM, mais c'est gratuit.
        # On stocke en /tmp avec un nom déterministe par chunk.
        USER_WORDS_PATH = None
        if ORANGE_ROSTER or BLUE_ROSTER:
            USER_WORDS_PATH = os.path.join('/tmp', f'eva_user_words_{GAME_ID}.txt')
            ALL_NAMES = set()
            for p in ORANGE_ROSTER + BLUE_ROSTER:
                n = p.get('name')
                if n:
                    ALL_NAMES.add(n)
                    ALL_NAMES.add(n.upper())
                    ALL_NAMES.add(n.lower())
            try:
                with open(USER_WORDS_PATH, 'w') as f:
                    f.write('\n'.join(ALL_NAMES) + '\n')
            except Exception:
                USER_WORDS_PATH = None

        GF = MODES[MODE_INDEX]['gameFrame']
        TIMER_BOX = GF['timer']
        ORANGE_SCORE_SPEC = GF['orangeScore']
        BLUE_SCORE_SPEC = GF['blueScore']

        # Toutes les lectures OCR brutes (orange/blue) indexées par elapsed.
        # Pas de filtrage à l'insertion : c'est `_reconstruct_field` qui tranche
        # en fin de chunk via DP global sous contraintes physiques (monotonie,
        # rate cap, bornes). Une hallucination isolée se fait dominer par le
        # consensus des voisines, sans cascade de rejets.
        RAW_OBSERVATIONS = {}   # {elapsed_s: {'orange': [v, ...], 'blue': [v, ...]}}
        # Observations brutes de killfeed : chaque elapsed peut avoir plusieurs
        # observations (kill affiché 5 s × sampling 1 Hz = ~5 frames par kill).
        # Le dédup post-process tranche pour ne garder qu'un kill par paire
        # (killer, victim) sur la fenêtre de 5-10 s.
        KILL_OBSERVATIONS = {}   # {elapsed_s: [{'killer': str, 'victim': str, 'killer_raw': str, 'victim_raw': str}, ...]}
        MAX_TIME = None   # auto-détecté à la première lecture timer valide

        # Couleur effectivement utilisée par chaque équipe dans cette partie.
        # TEAM_ORANGE et TEAM_BLUE listent plusieurs valeurs possibles (orange/vert
        # fluo, bleu/violet) ; on verrouille la couleur réelle sur la 1ère frame
        # de gameplay du chunk pour éviter les faux positifs en aval (killfeed,
        # masquage OCR). Reste None si la 1ère frame ne donne pas assez de pixels.
        RESOLVED_ORANGE = None
        RESOLVED_BLUE = None

        # Garde-fou anti-pollution timer : un timer OCR foireux (ex: "09:43" lu
        # "03:43") génère un ELAPSED aberrant qui décale toute la timeline.
        # Stratégie : borne dynamique sur ELAPSED, avec adoption d'un nouveau
        # référentiel si N timers consécutifs forment une progression linéaire
        # (cas d'une vraie coupe vidéo dans le chunk).
        TIMELINE_OFFSET = 0   # in-game elapsed - video elapsed, mis à jour aux coupes
        SUSPECT_BUFFER = []   # [(ts, raw_elapsed, orange_raw, blue_raw), ...]
        SUSPECT_TOLERANCE = 5      # secondes de marge sur la borne dynamique
        SUSPECT_CONFIRM_LEN = 5    # samples consécutifs requis pour confirmer une coupe
        SUSPECT_DRIFT_TOL = 2      # |Δelapsed - Δts| toléré pour "linéaire"

        # Pipeline : on garde WINDOW frames en vol simultanées dans le pool.
        # `_submit_frame` décode + lance les 3 OCR speculatif ; `_process_ocr_item`
        # drain les futures en ordre FIFO (critique pour MAX_TIME et la borne
        # dynamique du SUSPECT_BUFFER qui dépendent du temps croissant).
        # Coût du speculative work amplifié : avec WINDOW=4, jusqu'à 12 OCR
        # peuvent tourner en parallèle pour une frame qui sera finalement jetée.
        # Sur CPU pur c'est OK ; sur PC à la traîne WINDOW=1 garde l'ancien
        # comportement bit-pour-bit (cf. sizing plus haut).
        def _submit_frame(ts):
            nonlocal RESOLVED_ORANGE, RESOLVED_BLUE
            FRAME = _get_frame(CAP, ts)
            if FRAME is None or not _detect_game_playing(FRAME):
                return ('skip', ts)

            # Verrouille la couleur d'équipe sur la 1ère frame exploitable du
            # chunk. On le fait ICI (avant les submit OCR) plutôt que dans
            # `_process_ocr_item` pour que le pipeline OCR du score utilise
            # directement la couleur résolue (et pas la liste complète qui
            # contient des candidats "pro league" tels que jaune fluo / cyan
            # qui matchent du HUD parasite et faussent la détection du bbox).
            if RESOLVED_ORANGE is None or RESOLVED_BLUE is None:
                ORG, BLU = _resolve_team_colors(FRAME, MODE_INDEX)
                if RESOLVED_ORANGE is None and ORG is not None:
                    RESOLVED_ORANGE = ORG
                if RESOLVED_BLUE is None and BLU is not None:
                    RESOLVED_BLUE = BLU
                #if RESOLVED_ORANGE is not None and RESOLVED_BLUE is not None:
                    #_emit({'log': f'[_analyze_chunks] {GAME_ID} resolved colors: orange={RESOLVED_ORANGE} blue={RESOLVED_BLUE}'})

            # Spec dérivée avec la couleur résolue (override `colors` du spec
            # statique). Si la résolution n'a pas encore réussi, on retombe
            # sur la liste complète — comportement identique à l'ancien code.
            #
            # tol_color = 40 (au lieu du défaut 20) car avec UNE seule couleur
            # candidate (résolue), beaucoup moins de pixels du chiffre matchent
            # à 20 que quand on avait 2-3 candidats en union. Compense la perte
            # de couverture en élargissant la tolérance par couleur.
            O_COLORS = [RESOLVED_ORANGE] if RESOLVED_ORANGE else TEAM_ORANGE
            B_COLORS = [RESOLVED_BLUE]   if RESOLVED_BLUE   else TEAM_BLUE
            O_SPEC = {**ORANGE_SCORE_SPEC, 'colors': O_COLORS, 'tol_color': 40}
            B_SPEC = {**BLUE_SCORE_SPEC,   'colors': B_COLORS, 'tol_color': 40}

            return ('ocr', ts, FRAME,
                    EXECUTOR.submit(_ocr_timer_fast, FRAME, TIMER_BOX),
                    EXECUTOR.submit(_ocr_score_at, FRAME, O_SPEC, O_COLORS, MAX_ORANGE),
                    EXECUTOR.submit(_ocr_score_at, FRAME, B_SPEC, B_COLORS, MAX_BLUE))

        def _record_raw(elapsed, orange_raw, blue_raw, timer_text=''):
            #_emit({'log': f'[_analyze_chunks] --------> {timer_text}: orange={orange_raw} blue={blue_raw}'})
            if orange_raw is None and blue_raw is None:
                return
            BUCKET = RAW_OBSERVATIONS.setdefault(elapsed, {'orange': [], 'blue': []})
            if orange_raw is not None:
                BUCKET['orange'].append(orange_raw)
            if blue_raw is not None:
                BUCKET['blue'].append(blue_raw)

        def _is_linear_progression(buf):
            # Vraie coupe vidéo : in-game time avance ~1s/frame comme le temps vidéo.
            # Hallucination Tesseract isolée ou répétée : pas cette structure.
            for i in range(1, len(buf)):
                TS_PREV, E_PREV, _, _ = buf[i - 1]
                TS_CURR, E_CURR, _, _ = buf[i]
                DTS = TS_CURR - TS_PREV
                DE = E_CURR - E_PREV
                if DE < 0:
                    return False
                if abs(DE - DTS) > SUSPECT_DRIFT_TOL:
                    return False
            return True

        def _process_ocr_item(item):
            nonlocal MAX_TIME, TIMELINE_OFFSET
            _, ts, frame, fut_timer, fut_orange, fut_blue = item
            TIMER_TEXT = fut_timer.result()
            ORANGE_RAW = fut_orange.result()
            BLUE_RAW = fut_blue.result()

            MS = _parse_timer_text(TIMER_TEXT)
            if MS is None:
                # Fast-path KO : pipeline OCR complet (4 calls) en séquentiel.
                TIMER_TEXT = _ocr_region(
                    frame,
                    TIMER_BOX[0][0], TIMER_BOX[0][1], TIMER_BOX[1][0], TIMER_BOX[1][1],
                    psm=7, whitelist='0123456789:',
                    luminance=100, apply_filter=True, lang='evadigits',
                )
                MS = _parse_timer_text(TIMER_TEXT)
            if MS is None:
                return
            M, S = MS
            if not (0 <= S < 60):
                return
            if MAX_TIME is None:
                # Cap dur sur M : un OCR foireux qui lit "13:00" au lieu de
                # "10:00" verrouillerait MAX_TIME à 13 et shifterait toute la
                # timeline de 180 s. On attend une lecture ≤ MAX_TIME_CAP.
                if not (0 <= M <= MAX_TIME_CAP):
                    return
                REMAINING = M * 60 + S
                if REMAINING <= 0:
                    return
                MAX_TIME = -(-REMAINING // 60)
            elif M > MAX_TIME:
                return
            RAW_ELAPSED = MAX_TIME * 60 - (M * 60 + S)
            if RAW_ELAPSED < 0:
                return

            # Borne dynamique : in-game elapsed ne peut pas dépasser
            # (temps vidéo écoulé) + offset déjà adopté + tolérance.
            VIDEO_ELAPSED = ts - START
            EXPECTED_MAX = VIDEO_ELAPSED + TIMELINE_OFFSET + SUSPECT_TOLERANCE

            if RAW_ELAPSED > EXPECTED_MAX:
                SUSPECT_BUFFER.append((ts, RAW_ELAPSED, ORANGE_RAW, BLUE_RAW))
                #_emit({'log': f'[_analyze_chunks] SUSPECT {TIMER_TEXT}: ELAPSED={RAW_ELAPSED}s @ vid={VIDEO_ELAPSED:.0f}s (buffer {len(SUSPECT_BUFFER)}/{SUSPECT_CONFIRM_LEN})'})
                if len(SUSPECT_BUFFER) >= SUSPECT_CONFIRM_LEN:
                    if _is_linear_progression(SUSPECT_BUFFER):
                        FIRST_TS, FIRST_RAW, _, _ = SUSPECT_BUFFER[0]
                        OLD_OFFSET = TIMELINE_OFFSET
                        TIMELINE_OFFSET = FIRST_RAW - (FIRST_TS - START)
                        #_emit({'log': f'[_analyze_chunks] COUPE confirmée : offset {OLD_OFFSET}s → {TIMELINE_OFFSET}s, flush {len(SUSPECT_BUFFER)} samples'})
                        for _, B_RAW, B_O, B_B in SUSPECT_BUFFER:
                            _record_raw(B_RAW, B_O, B_B, '(flush)')
                        SUSPECT_BUFFER.clear()
                    else:
                        DROPPED = SUSPECT_BUFFER.pop(0)
                        #_emit({'log': f'[_analyze_chunks] SUSPECT drop @ ts={DROPPED[0]:.0f}s (non-linéaire)'})
                return

            # Sample dans la borne : tout suspect en attente était une hallucination isolée.
            if SUSPECT_BUFFER:
                #_emit({'log': f'[_analyze_chunks] SUSPECT clear ({len(SUSPECT_BUFFER)} samples invalidés par sample normal)'})
                SUSPECT_BUFFER.clear()

            _record_raw(RAW_ELAPSED, ORANGE_RAW, BLUE_RAW, TIMER_TEXT)

            # Killfeed : detect → split → OCR killer/victim → fuzzy match contre
            # le roster de l'équipe correspondante. Multi-frame consensus (kill
            # affiché 5 s) compense les misreads isolés. Skipped si rosters vides
            # (chunk non matché côté back) — on pourrait fallback sur OCR brut
            # mais sans validation roster c'est trop risqué de faux positifs.
            if RESOLVED_ORANGE is not None and RESOLVED_BLUE is not None and (ORANGE_ROSTER or BLUE_ROSTER):
                ROSTER_O_NAMES = [p['name'] for p in ORANGE_ROSTER if p.get('name')]
                ROSTER_B_NAMES = [p['name'] for p in BLUE_ROSTER if p.get('name')]
                # Slot mapping : orange[0..3] → 1..4, blue[0..3] → 6..9 (5 réservé).
                # L'API /games/identify retourne les rosters dans le bon ordre slot.
                for KILL_BBOX in _detect_kill_rows(frame, GF['killFeed'], RESOLVED_ORANGE, RESOLVED_BLUE):
                    SPLIT = _split_kill_row(frame, KILL_BBOX)
                    if SPLIT is None:
                        continue
                    KT, VT = SPLIT['killer']['team'], SPLIT['victim']['team']
                    KT_COLOR = RESOLVED_ORANGE if KT == 'orange' else RESOLVED_BLUE
                    VT_COLOR = RESOLVED_ORANGE if VT == 'orange' else RESOLVED_BLUE
                    KRAW = _ocr_kill_name(frame, SPLIT['killer']['box'], KT_COLOR, user_words_path=USER_WORDS_PATH)
                    VRAW = _ocr_kill_name(frame, SPLIT['victim']['box'], VT_COLOR, user_words_path=USER_WORDS_PATH)
                    K_ROSTER = ROSTER_O_NAMES if KT == 'orange' else ROSTER_B_NAMES
                    V_ROSTER = ROSTER_O_NAMES if VT == 'orange' else ROSTER_B_NAMES
                    KMATCH, KRATIO = _match_player(KRAW, K_ROSTER, with_ratio=True)
                    VMATCH, VRATIO = _match_player(VRAW, V_ROSTER, with_ratio=True)
                    if KMATCH and VMATCH:
                        K_SLOT = K_ROSTER.index(KMATCH) + (1 if KT == 'orange' else 6)
                        V_SLOT = V_ROSTER.index(VMATCH) + (1 if VT == 'orange' else 6)
                        # Identifie l'arme et le headshot via template matching.
                        # Stocké par observation (= par frame) pour que le dédup
                        # puisse voter sur l'arme la plus fréquemment matchée
                        # sur les ~5 frames d'affichage du kill.
                        WEAPON, HEADSHOT, _ = _identify_weapon(
                            frame, SPLIT['weapon']['box'],
                            WEAPON_TEMPLATES, HEADSHOT_TEMPLATE,
                        )
                        KILL_OBSERVATIONS.setdefault(RAW_ELAPSED, []).append({
                            'killer': K_SLOT, 'victim': V_SLOT,
                            'killer_raw': KRAW, 'victim_raw': VRAW,
                            'killer_ratio': KRATIO, 'victim_ratio': VRATIO,
                            'weapon': WEAPON, 'headshot': HEADSHOT,
                        })

        TIMESTAMP = float(START)
        INFLIGHT = deque()

        # Remplissage initial de la fenêtre : on submit jusqu'à WINDOW frames
        # avant de commencer à drainer.
        while len(INFLIGHT) < WINDOW and TIMESTAMP <= END:
            INFLIGHT.append(_submit_frame(TIMESTAMP))
            TIMESTAMP += 1.0

        # Roulement : drain le plus vieux, refill par le plus jeune.
        while INFLIGHT:
            ITEM = INFLIGHT.popleft()
            PROCESSED_SECONDS += 1
            if ITEM[0] == 'ocr':
                _process_ocr_item(ITEM)

            if TIMESTAMP <= END:
                INFLIGHT.append(_submit_frame(TIMESTAMP))
                TIMESTAMP += 1.0

            PERCENT = int(100 * PROCESSED_SECONDS / TOTAL_SECONDS) if TOTAL_SECONDS > 0 else 0
            if PERCENT != LAST_PERCENT and PERCENT < 100:
                _emit({'percent': PERCENT, 'results': []})
                LAST_PERCENT = PERCENT

        # Reconstruction globale par DP : à partir de toutes les lectures OCR
        # brutes, on trouve la trajectoire monotone (par champ, indépendamment)
        # qui maximise l'accord avec les observations sous contraintes physiques.
        ORANGE_TL = _reconstruct_field(RAW_OBSERVATIONS, 'orange', MAX_ORANGE)
        BLUE_TL = _reconstruct_field(RAW_OBSERVATIONS, 'blue', MAX_BLUE)
        #_emit({'log': f'[_analyze_chunks] reconstruction: {len(ORANGE_TL)} pts orange, {len(BLUE_TL)} pts blue (sur {len(RAW_OBSERVATIONS)} elapsed observés)'})

        # Format V2 : { "<sec>": [orange, blue] }. On forward-fill côté
        # producteur (chaque ligne contient l'état complet à cette seconde),
        # et on n'émet QUE si le couple [orange, blue] a changé depuis la
        # dernière ligne émise. Avantages vs V1 named-keys :
        #   - JSON 2-3× plus compact (pas de "orange"/"blue" répétés)
        #   - sparse en pratique (atlantis ~480 secs → ~50 lignes)
        #   - sémantique simple : chaque ligne = snapshot complet
        # Trade-off : on perd la distinction "0 par défaut" vs "OCR a raté",
        # mais ça n'a pas de valeur métier (le score à 0 au début est implicite).
        SCORE_TIMELINE = {}
        last_o = 0
        last_b = 0
        prev_pair = None
        all_keys = sorted(set(ORANGE_TL) | set(BLUE_TL))
        for K in all_keys:
            if K in ORANGE_TL:
                last_o = ORANGE_TL[K]
            if K in BLUE_TL:
                last_b = BLUE_TL[K]
            pair = [last_o, last_b]
            if pair != prev_pair:
                SCORE_TIMELINE[str(K)] = pair
                prev_pair = pair
        # Killfeed : dédup multi-frame (un kill reste 5 s à l'écran → ~5 obs).
        # Sortie = un event par kill, daté à l'elapsed le plus tôt observé.
        KILLS_OUT = _dedup_kills(KILL_OBSERVATIONS)

        # Trailer non-gameplay : à la fin du chunk, l'écran de score final
        # s'affiche jusqu'à ~15 s (ou moins si la vidéo a été pré-coupée). On
        # remonte le chunk seconde par seconde depuis END, jusqu'à 20 s max,
        # et on compte les secondes consécutives où `_detect_game_playing`
        # est False. Le client peut s'en servir pour découper proprement.
        END_NON_GAMEPLAY = 0
        for OFFSET in range(1, 21):
            TS = END - OFFSET
            if TS < START:
                break
            FRAME_END = _get_frame(CAP, TS)
            if FRAME_END is None:
                break
            if _detect_game_playing(FRAME_END):
                break
            END_NON_GAMEPLAY = OFFSET

        CHUNK_PERCENT = int(100 * PROCESSED_SECONDS / TOTAL_SECONDS) if TOTAL_SECONDS > 0 else 100
        _emit({
            'percent': CHUNK_PERCENT,
            'results': [{
                'gameID': GAME_ID,
                'payload': {
                    'score_timeline': SCORE_TIMELINE,
                    'kills': KILLS_OUT,
                    'end_non_gameplay_seconds': END_NON_GAMEPLAY,
                },
            }],
        })
        LAST_PERCENT = CHUNK_PERCENT

    EXECUTOR.shutdown()
    CAP.release()

    if LAST_PERCENT < 100:
        _emit({'percent': 100, 'results': []})

#endregion

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def _get_bundled_tessdata() -> str:
    """Retourne le chemin du tessdata embarqué (s'il contient des .traineddata), ou ''.
    Appelé indépendamment du binaire tesseract : sur Linux on bundle uniquement
    les .traineddata (eng + evadigits), pas le binaire."""
    BASE = getattr(sys, '_MEIPASS', '')
    if not BASE:
        return ''
    TESSDATA_DIR = os.path.join(BASE, 'tesseract', 'tessdata')
    if os.path.isdir(TESSDATA_DIR) and any(f.endswith('.traineddata') for f in os.listdir(TESSDATA_DIR)):
        return TESSDATA_DIR
    return ''


def _get_bundled_tesseract() -> str:
    """Renvoie le chemin vers le tesseract embarqué par PyInstaller, ou ''."""
    BASE = getattr(sys, '_MEIPASS', '')
    if not BASE:
        return ''
    EXE_NAME = 'tesseract.exe' if sys.platform == 'win32' else 'tesseract'
    CANDIDATE = os.path.join(BASE, 'tesseract', EXE_NAME)
    if not os.path.isfile(CANDIDATE):
        return ''
    return CANDIDATE


def _tesseract_works(cmd: str) -> bool:
    """Smoke-test : lance `cmd --version` et retourne True si exit code == 0."""
    import subprocess
    try:
        R = subprocess.run([cmd, '--version'], capture_output=True, timeout=5)
        return R.returncode == 0
    except Exception:
        return False


def _find_system_tesseract() -> str:
    """Cherche un tesseract installé hors du bundle (Homebrew, PATH)."""
    import shutil
    for c in ('/opt/homebrew/bin/tesseract', '/usr/local/bin/tesseract', '/usr/bin/tesseract'):
        if os.path.isfile(c):
            return c
    FOUND = shutil.which('tesseract')
    return FOUND or ''


def main() -> None:
    """
    Point d'entrée du binaire.

    Sous-commandes :
      detect <video> <ffmpeg> [tess] [settings_json]
        → phase 1 : détection inverse des games dans la vidéo.
          settings : { orangeTeamName?, blueTeamName?, maxTimePerGame? }
          stdout   : { type: 'progress'|'game'|'done'|'error', ... }
      chunks <video> <ffmpeg> [tess] [settings_json]
        → phase 2 : analyse approfondie des chunks pré-identifiés.
          settings : { maxTimePerGame?, chunks: [{startSeconds, endSeconds, gameID, mode}] }
          stdout   : { percent, results: [{gameID, generated_by, payload}] }

    Rétro-compat : si argv[1] n'est pas une sous-commande connue, on assume
    'detect' et on shift les arguments — l'invocation historique
    `analyze_video <video> <ffmpeg> ...` continue de marcher.
    """
    if len(sys.argv) < 2:
        _emit({'type': 'error', 'message': 'Usage: analyze_video <detect|chunks> <video_path> <ffmpeg_path> [tesseract_cmd] [settings_json]'})
        sys.exit(1)

    if sys.argv[1] in ('detect', 'chunks'):
        SUBCOMMAND = sys.argv[1]
        OFFSET = 2
    else:
        SUBCOMMAND = 'detect'
        OFFSET = 1

    if len(sys.argv) < OFFSET + 2:
        _emit({'type': 'error', 'message': 'Usage: analyze_video <detect|chunks> <video_path> <ffmpeg_path> [tesseract_cmd] [settings_json]'})
        sys.exit(1)

    VIDEO_PATH  = sys.argv[OFFSET]
    FFMPEG_PATH = sys.argv[OFFSET + 1]

    # Pointe TESSDATA_PREFIX vers le tessdata bundlé (eng + evadigits) si présent.
    # Fait avant le choix du binaire car ça s'applique aussi au tesseract système
    # (cas Linux où on bundle uniquement les data, ou fallback macOS).
    BUNDLED_TESSDATA = _get_bundled_tessdata()
    if BUNDLED_TESSDATA:
        BUNDLED_HAS_REQUIRED = all(
            os.path.isfile(os.path.join(BUNDLED_TESSDATA, f))
            for f in ('eng.traineddata', 'evadigits.traineddata')
        )
        if BUNDLED_HAS_REQUIRED:
            os.environ['TESSDATA_PREFIX'] = BUNDLED_TESSDATA

    TESSERACT_CMD = sys.argv[OFFSET + 2] if len(sys.argv) > OFFSET + 2 else ''
    if not TESSERACT_CMD:
        TESSERACT_CMD = _get_bundled_tesseract()
    # Si le binaire bundlé est tué par macOS (signature ad-hoc + hardened runtime
    # sur certaines machines), on bascule sur le tesseract système.
    if TESSERACT_CMD and not _tesseract_works(TESSERACT_CMD):
        FALLBACK = _find_system_tesseract()
        if FALLBACK and _tesseract_works(FALLBACK):
            #_emit({'log': f'[tesseract] bundled SIGKILL → fallback to {FALLBACK}'})
            TESSERACT_CMD = FALLBACK
    if TESSERACT_CMD:
        pytesseract.pytesseract.tesseract_cmd = TESSERACT_CMD

    SETTINGS: dict = {}
    if len(sys.argv) > OFFSET + 3:
        try:
            SETTINGS = json.loads(sys.argv[OFFSET + 3])
        except Exception:
            pass

    START = time.time()
    if SUBCOMMAND == 'detect':
        ORANGE   = SETTINGS.get('orangeTeamName', '').strip()
        BLUE     = SETTINGS.get('blueTeamName', '').strip()
        MAX_TIME = int(SETTINGS.get('maxTimePerGame', 10))
        try:
            _analyze(VIDEO_PATH, FFMPEG_PATH, ORANGE, BLUE, MAX_TIME)
        except Exception as EXC:
            _emit({'type': 'error', 'message': str(EXC)})
            sys.exit(1)
    else:
        try:
            _analyze_chunks(VIDEO_PATH, SETTINGS)
        except Exception as EXC:
            _emit({'percent': 0, 'results': [], 'error': str(EXC)})
            sys.exit(1)
    ELAPSED = int(time.time() - START)
    _emit({'log': f'[{SUBCOMMAND}] done in {ELAPSED // 60:02d}:{ELAPSED % 60:02d}'})


if __name__ == '__main__':
    main()
