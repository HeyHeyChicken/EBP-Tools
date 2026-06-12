# Copyright (c) 2026, Antoine Duval
# This file is part of a source-visible project.
# See LICENSE for terms. Unauthorized use is prohibited.

import sys
import os
import json
import io
import re
import base64
import statistics
import time
import numpy as np
import cv2
from collections import deque, Counter
from concurrent.futures import ThreadPoolExecutor
from PIL import Image, ImageOps, ImageEnhance
import pytesseract
from scipy.optimize import linear_sum_assignment as scipy_linear_sum_assignment
from typing import Optional

import minimap as _minimap
import blob_detector as _blob_detector
import digit_classifier as _digit_classifier
import map_metadata as _map_metadata

# ---------------------------------------------------------------------------
# MODES
# All positions are in 1920×1080 coordinate space.
# ---------------------------------------------------------------------------

# Couleurs des équipes — partagées entre l'identify (matching pixel) et la
# détection de bordure (find_text_border). Une seule source de vérité par couleur.
TEAM_ORANGE = [
    (255, 128, 0),   # Classic
    (170, 220, 80),  # Pro League
    (255, 220, 0),   # Challenger League
    (40, 255, 120),  # Local League
    (51, 188, 255),  # Summit
]
TEAM_BLUE = [
    (51, 151, 254),  # Classic
    (55, 190, 220),  # Pro League
    (50, 185, 255),  # Challenger League
    (180, 0, 245),   # Local League
    (179, 0, 243),   # Summit
]

DEBUG = False

MODES = [
    #region Mode 0
    {
        'scoreFrame': [
            # Variante 0 : score frame classique
            {
                # Détection par silhouette des pills (templates/score/classic.png).
                # Robuste aux couleurs d'équipe (Classic, Pro, Local League,
                # Summit) et au décodeur vidéo (D3D11 décale les RGB sur Windows,
                # ce qui cassait l'ancienne détection par pixels colorés).
                # anchor = position (x, y) attendue du coin top-left du
                # template dans le frame quand le HUD n'est pas décalé.
                'template': {
                    'name': 'score/classic.png',
                    'anchor': (72, 390),
                },
                # Le SCORE est lui-même coloré (chiffres en couleur de l'équipe). On
                # cherche tous les pixels colorés, le bbox englobant = bbox des chiffres.
                # On élargit de 3 px (inset négatif) pour donner du padding à l'OCR.
                'orangeScore': {
                    'colors': TEAM_ORANGE,
                    'search': ((30, 410), (358, 528)),
                    'inset': -10,
                },
                'blueScore': {
                    'colors': TEAM_BLUE,
                    'search': ((30, 599), (358, 731)),
                    'inset': -10,
                },
            },
            # Variante 1 : score frame compétitive
            {
                # Détection par silhouette des pills (templates/score/pro_league.png).
                # Layout horizontal : pill orange à gauche, pill bleu à droite,
                # avec "EVA PRO LEAGUE" branding au centre. Couleurs d'équipe
                # tournoi (vert/teal) → seuils HSV plus permissifs car V<150.
                'template': {
                    'name': 'score/pro_league.png',
                    'anchor': (323, 455),
                    # Le branding "EVA PRO LEAGUE" au centre est gris/blanc
                    # (saturation faible). On binarise par luminance V seule
                    # (sat_min=0) pour capter à la fois les pills colorés et
                    # le texte clair. La zone de recherche restreinte
                    # (anchor ± max_shift) limite les faux positifs.
                    'sat_min': 0,
                    'val_min': 100,
                    # Score seuil élevé et scales limités : vrais matchs à
                    # 0.97 scale=1.0, faux positifs à 0.82-0.89 scales 0.95/1.05.
                    'min_score': 0.93,
                    'scales': (0.98, 1.0, 1.02),
                    'max_shift': 15,
                    # Layout horizontal (pills gauche/droite, pas top/bottom)
                    # → la validation pill_top/middle/pill_bot ne s'applique pas.
                    'skip_post_validation': True,
                    # Validation par régions sur la saturation HSV. Un vrai
                    # score frame pro_league a :
                    # - left pill colorée (sat >= 100 dans >50% de la zone)
                    # - right pill colorée (sat >= 100 dans >40% de la zone)
                    # - texte EVA PRO LEAGUE gris/blanc (sat >= 100 dans <45%)
                    # Coords (x1, y1, x2, y2, sat_min, min_ratio, max_ratio).
                    'validate_regions': [
                        (5, 0, 106, 34, 100, 0.4, 1.0),       # left pill saturated
                        (1166, 135, 1267, 168, 100, 0.4, 1.0),  # right pill saturated
                        # Plafond à 0.45 (et non 0.3) : le logo "EVA PRO LEAGUE" est
                        # semi-transparent, le fond de map transparaît derrière. Sur
                        # les maps à fond coloré (ex. The Cliff, paroi orange) la zone
                        # monte à ~0.36, alors que les pills colorés restent à
                        # 0.88-0.97 → la marge de discrimination reste nette.
                        (556, 64, 717, 104, 100, 0.0, 0.45),   # EVA text gray
                    ],
                },
                # Le SCORE est lui-même coloré (chiffres en couleur de l'équipe). On
                # cherche tous les pixels colorés, le bbox englobant = bbox des chiffres.
                # On élargit de 3 px (inset négatif) pour donner du padding à l'OCR.
                'orangeScore': {
                    'colors': TEAM_ORANGE,
                    'search': ((631, 501), (847, 573)),
                    'inset': -10,
                },
                'blueScore': {
                    'colors': TEAM_BLUE,
                    'search': ((1082, 502), (1297, 574)),
                    'inset': -10,
                },
            },
        ],
        'endFrame': {
            'orangeScore': ((636, 545), (903, 648)),
            'blueScore': ((996, 545), (1257, 648)),
        },
        'gameFrame': {
            'timer': ((916, 50), (1004, 88)),
            'playersY': [[732, 755], [814, 838], [898, 921], [980, 1004]],
            # Killfeed top-right : on détecte des bandes de texte (couleur équipe
            # + picto arme blanc) par row-scan vertical. textHeight = hauteur de
            # la bande de texte coloré (≠ hauteur de la box visuelle ~30 px,
            # le reste est du fond noir non discriminant).
            'killFeed': {
                # Région de détection conservatrice : la victime (texte coloré
                # sur fond noir) et le picto arme sont toujours dans cette
                # zone même pour les pseudos très longs. La détection de row
                # ne génère donc pas de faux positifs ici.
                'region': ((1690, 140), (1920, 480)),
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

# Pour chaque map : `aliases` = mots OCR reconnus (incluant erreurs fréquentes),
# `points` = nombre attendu de capture points (garde-fou anti-FP dans
# `_detect_capture_points_for_map`), `respawn` = délai de respawn en secondes
# (sert au death lockout de `_smooth_hp_timeline`). Une map sans clé `respawn`
# (ex. The Rock, ou une future map) retombe sur DEFAULT_RESPAWN (15 s).
_MAPS = {
    'Artefact':       {'aliases': ['artefact'], 'points': 1, 'respawn': 18},
    'Atlantis':       {'aliases': ['atlantis'], 'points': 3, 'respawn': 17},
    'Ceres':          {'aliases': ['ceres'], 'points': 1, 'respawn': 17},
    'Engine':         {'aliases': ['engine', 'enaine'], 'points': 3, 'respawn': 17},
    'Helios Station': {'aliases': ['helios', 'station', 'hheliosstation', 'rheliosstation', 'heliosstation'], 'points': 3, 'respawn': 17},
    'Lunar Outpost':  {'aliases': ['lunar', 'outpost', 'lunaroutpost'], 'points': 3, 'respawn': 17},
    'Outlaw':         {'aliases': ['outlaw', 'qutlaw'], 'points': 5, 'respawn': 15},
    'Polaris':        {'aliases': ['polaris', 'polarkg', 'polarg'], 'points': 1, 'respawn': 17},
    'Silva':          {'aliases': ['silva'], 'points': 1, 'respawn': 17},
    'The Cliff':      {'aliases': ['cliff', 'citt', 'clit', 'cltt', 'cit', 'ciitt', 'theclife', 'the clife', 'theclifen'], 'points': 1, 'respawn': 17},
    'The Rock':       {'aliases': ['rock', 'therock'], 'points': 1},
    'Horizon':        {'aliases': ['horizon'], 'points': 2, 'respawn': 15},
}

# Délai de respawn par défaut (s) pour les maps sans clé `respawn` dans _MAPS.
DEFAULT_RESPAWN = 15

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
    for MAP_NAME, info in _MAPS.items():
        if any(w in info['aliases'] for w in words):
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
                if DEBUG:
                    _emit({'log': f'[OCR][ERROR] lang={lang!r} cfg={cfg!r} cmd={pytesseract.pytesseract.tesseract_cmd!r} tessdata={os.environ.get("TESSDATA_PREFIX", "<unset>")} exc={type(EXC).__name__}: {EXC}'})
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
    if DEBUG:
        _emit({'log': f'[OCR] region=({x1},{y1})-({x2},{y2}) results={results} → {repr(RESULT)}'})
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
    if DEBUG:
        _emit({'log': f'[OCR/mask] region=({x1},{y1})-({x2},{y2}) target={target_color} results={results} → {repr(RESULT)}'})
    return RESULT


# ---------------------------------------------------------------------------
# Frame type detection — mirrors detect* functions from the TypeScript service
# ---------------------------------------------------------------------------

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

    On ne prend pas le bbox brut de tous les pixels matchant : sur l'écran de
    score, le bandeau du nom d'équipe (ex: "ALLIANCE") est dans la même couleur
    que les chiffres et tombe dans la search region → le bbox engloberait les
    deux et l'OCR retournerait un mélange (les I/L de "ALLIANCE" lus comme des
    1 par Tesseract en whitelist digits). On part donc de la plus grosse
    composante connexe (forcément un chiffre, bien plus haut/épais que n'importe
    quelle lettre du bandeau), puis on étend aux composantes qui chevauchent
    verticalement (autres chiffres + %), ce qui exclut tout ce qui est sur une
    autre bande y.

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

    n_labels, _, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
    if n_labels <= 1:
        return None
    # stats[0] = background, on ignore. Colonnes : LEFT, TOP, WIDTH, HEIGHT, AREA.
    comp = stats[1:]
    largest = int(np.argmax(comp[:, cv2.CC_STAT_AREA]))
    ly = comp[largest, cv2.CC_STAT_TOP]
    lh = comp[largest, cv2.CC_STAT_HEIGHT]
    l_y1, l_y2 = ly, ly + lh

    # On garde les composantes dont l'intervalle vertical chevauche la plus
    # grosse → même bande de texte. Les autres bandes (nom d'équipe au-dessus,
    # éventuels artefacts en-dessous) sont écartées.
    cy1 = comp[:, cv2.CC_STAT_TOP]
    cy2 = cy1 + comp[:, cv2.CC_STAT_HEIGHT]
    keep = (cy2 > l_y1) & (cy1 < l_y2)
    kept = comp[keep]
    if kept.size == 0:
        return None

    bx1 = int(kept[:, cv2.CC_STAT_LEFT].min())
    by1 = int(kept[:, cv2.CC_STAT_TOP].min())
    bx2 = int((kept[:, cv2.CC_STAT_LEFT] + kept[:, cv2.CC_STAT_WIDTH]).max())
    by2 = int((kept[:, cv2.CC_STAT_TOP] + kept[:, cv2.CC_STAT_HEIGHT]).max())

    # inset positif = rentre vers l'intérieur (utile quand la couleur cible est
    # une BORDURE entourant le texte). inset négatif = élargit autour (utile
    # quand la couleur cible est le TEXTE lui-même, ex: chiffres colorés du score).
    # On clamp aux bornes du frame pour éviter de sortir de l'image.
    x1 = max(0, bx1 + sx1 + inset)
    y1 = max(0, by1 + sy1 + inset)
    x2 = min(w, bx2 + sx1 - inset)
    y2 = min(h, by2 + sy1 - inset)
    if x2 <= x1 or y2 <= y1:
        return None
    return ((x1, y1), (x2, y2))


def _color_match_counts(frame: np.ndarray, search_region, candidates: list, tol_color: int = 20):
    """
    Compte, pour chaque couleur candidate, le nombre de pixels de search_region
    à <= tol_color (distance L-inf RGB). Retourne une liste d'entiers alignée
    sur `candidates`.

    Sert à résoudre la couleur d'équipe : TEAM_ORANGE[i] et TEAM_BLUE[i] forment
    la paire du thème i, et l'appelant choisit le thème en scorant les deux côtés
    ENSEMBLE (cf. `_resolve_team_colors`), plutôt que par un argmax indépendant
    par côté — ce qui évite qu'un thème au color quasi-identique sur un seul côté
    ne vole le slot.
    """
    h, w = frame.shape[:2]
    (sx1, sy1), (sx2, sy2) = search_region
    sx1 = max(0, int(sx1)); sy1 = max(0, int(sy1))
    sx2 = min(w, int(sx2)); sy2 = min(h, int(sy2))
    if sx1 >= sx2 or sy1 >= sy2:
        return [0] * len(candidates)
    sub = frame[sy1:sy2, sx1:sx2].astype(np.int16)
    counts = []
    for c in candidates:
        target = np.array(c, dtype=np.int16)
        counts.append(int(((np.abs(sub - target) <= tol_color).all(axis=2)).sum()))
    return counts


def _resolve_team_colors(frame: np.ndarray, anchor=None):
    """
    Détermine la couleur effective de chaque équipe sur la frame courante en
    comptant les pixels matchant chaque candidat sur les CARTES DE VIE des
    joueurs (`_find_team_card_box`) : leur fond est un aplat plein de la couleur
    d'équipe quand le joueur est full life, donc proche des valeurs canoniques.
    On évite ainsi les chiffres de score, alpha-blendés sur le HUD sombre, dont
    la couleur dérive vers le gris (échec du match à tol serrée) — et les pills
    de score centraux, absents/peu fiables selon les vidéos.

    Retourne (orange_rgb, blue_rgb) — chaque élément peut être None si la zone
    n'est pas assez peuplée.
    """
    if anchor is None:
        anchor = _find_playing_top_anchor(frame)
    o_box = _find_team_card_box(anchor, 'left')
    b_box = _find_team_card_box(anchor, 'right')
    if o_box is None or b_box is None:
        return (None, None)
    o_counts = _color_match_counts(frame, o_box, TEAM_ORANGE)
    b_counts = _color_match_counts(frame, b_box, TEAM_BLUE)
    # TEAM_ORANGE[i] et TEAM_BLUE[i] forment la paire du thème i (un seul thème
    # est actif). On retient le thème qui maximise orange_count[i] + blue_count[i],
    # À CONDITION que les deux couleurs soient présentes (>= MIN_PIXELS).
    #
    # Scorer la PAIRE (et non un argmax indépendant par côté + garde-fou
    # o_idx==b_idx) évite qu'un thème au color quasi-identique sur UN seul côté
    # vole le slot : p.ex. le bleu Local League (180,0,245) ≈ Summit (179,0,243)
    # à (1,0,2) près — le bleu seul ne tranche pas, mais l'orange (Local vert vs
    # Summit cyan, distincts) fait clairement pencher le score combiné.
    #
    # Note : ce critère retourne le même slot que l'ancien appairage quand
    # celui-ci réussissait (si l'argmax de chaque côté tombe sur k, alors k
    # maximise aussi la somme) — donc pas de régression, seulement des cas en
    # plus qui se résolvent.
    MIN_PIXELS = 30
    best_i, best_score = -1, -1
    for i in range(len(TEAM_ORANGE)):
        if o_counts[i] < MIN_PIXELS or b_counts[i] < MIN_PIXELS:
            continue
        score = o_counts[i] + b_counts[i]
        if score > best_score:
            best_score, best_i = score, i
    if best_i < 0:
        return (None, None)
    return (TEAM_ORANGE[best_i], TEAM_BLUE[best_i])


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


def _split_kill_row(frame: np.ndarray, bbox, orange_color, blue_color,
                    cos_thresh: float = 0.75, min_chroma: float = 25.0,
                    min_brightness: int = 100):
    """
    Découpe une bbox de kill row en killer / weapon / victim en localisant les
    colonnes ayant des pixels matchant la couleur orange-team ou blue-team
    résolue. Le killer et la victime ont chacun leur cluster (couleurs
    distinctes — kill cross-team obligatoire), le picto arme tient entre les
    deux.

    On NE peut PAS se fier aux pixels near-white pour localiser le picto : si
    le killer a un mur blanc derrière sa box transparente, tout le côté killer
    matche near-white et le picto "fuit" sur toute la bbox.

    On match par DIRECTION DE CHROMA (= couleur - moyenne RGB) plutôt que par
    tol RGB stricte, car le texte du killer (fond transparent) est alpha-blendé
    avec le décor : un pixel orange peut s'afficher (225,154,100) sur un mur
    gris au lieu de (238,120,12), |B-12|=88 hors tol_color=40 → match raté.
    Mais sa direction de chroma (R dominant, B le plus bas) reste alignée avec
    celle de la cible quel que soit le niveau d'alpha. Cette formulation marche
    aussi pour les palettes fluo (vert/violet) et pro-league (jaune/cyan) qui
    ne respectent PAS la dominance R-vs-B implicite de la palette standard.

    Retourne dict {'killer': {'box', 'team'}, 'weapon': {'box'}, 'victim':
    {'box', 'team'}} ou None si :
      - une seule couleur d'équipe présente (pas un kill cross-team)
      - les clusters orange/bleu s'overlap (pas de zone picto fiable)
    """
    (x1, y1), (x2, y2) = bbox
    sub = frame[y1:y2, x1:x2].astype(np.int16)
    sub_f = sub.astype(np.float32)
    sub_mean = sub_f.mean(axis=2, keepdims=True)
    sub_chroma = sub_f - sub_mean
    sub_chroma_norm = np.linalg.norm(sub_chroma, axis=2)
    sub_bright = sub.max(axis=2) >= min_brightness

    def _chroma_mask(target_rgb):
        target = np.array(target_rgb, dtype=np.float32)
        t_chroma = target - target.mean()
        t_norm = float(np.linalg.norm(t_chroma)) + 1e-6
        dot = (sub_chroma * t_chroma).sum(axis=2)
        cos_sim = dot / (sub_chroma_norm * t_norm + 1e-6)
        return (cos_sim >= cos_thresh) & (sub_chroma_norm >= min_chroma) & sub_bright

    m_o = _chroma_mask(orange_color)
    m_b = _chroma_mask(blue_color)

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
                   y_extend: int = 3, user_words_path: str = None,
                   whitelist: str = None) -> list:
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

    if whitelist is None:
        whitelist = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    cfg = f'-c tessedit_char_whitelist={whitelist}'
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


def _load_weapon_templates(template_dir: str) -> dict:
    """
    Charge tous les PNG du dossier `weapons/` comme templates {name: (gray, mask)},
    à leur résolution native. `name` = stem du fichier (m12.png → "m12").

    Pas de resize à l'init : `_match_template_to_icon` resize ensuite à la
    hauteur exacte de l'icône détectée dans la frame (scale-invariant), ratio
    préservé. Resizer 2 fois (init + match) dégrade les détails sur les
    sources fines (ex : admin 29 px → 13 px → 13 px).

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
            out[name] = _load_template_image(os.path.join(weapons_dir, fname))
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
            # Combine strict tol match (catches pure-color text pixels) avec
            # direction de chroma (capture les pixels alpha-blendés où le strict
            # rate). Le killer text est sur fond TRANSPARENT (décor visible
            # derrière) ; sur palette fluo/pro ou décor coloré, beaucoup de
            # pixels du killer text sortent du tol RGB strict mais conservent
            # leur direction de chroma — sans cette extension on tronque le
            # bbox killer et l'OCR ne lit que les dernières lettres.
            ext_sub_f = ext_sub.astype(np.float32)
            ext_sub_mean = ext_sub_f.mean(axis=2, keepdims=True)
            ext_sub_chroma = ext_sub_f - ext_sub_mean
            ext_sub_chroma_norm = np.linalg.norm(ext_sub_chroma, axis=2)
            ext_sub_bright = ext_sub.max(axis=2) >= 100
            def _ext_mask(target_rgb):
                t_i = np.array(target_rgb, dtype=np.int16)
                strict = (np.abs(ext_sub - t_i) <= tol_color).all(axis=2)
                t_f = t_i.astype(np.float32)
                t_chroma = t_f - t_f.mean()
                t_norm = float(np.linalg.norm(t_chroma)) + 1e-6
                dot = (ext_sub_chroma * t_chroma).sum(axis=2)
                cos_sim = dot / (ext_sub_chroma_norm * t_norm + 1e-6)
                chroma = (cos_sim >= 0.85) & (ext_sub_chroma_norm >= 40) & ext_sub_bright
                return strict | chroma
            ext_o = _ext_mask(orange_color)
            ext_b = _ext_mask(blue_color)
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
    - spec dict {'colors', 'search', 'inset'} → on cherche le bbox des pixels
      colorés dans `search`, on applique l'inset. Si `search` est None
      (cas où une box dynamique n'a pas été trouvée en amont), retourne None.
    Retourne None si la détection dynamique échoue.
    """
    if isinstance(spec, dict):
        search = spec.get('search')
        if search is None:
            return None
        return _find_text_border(
            frame, spec['colors'], search,
            tol_color=spec.get('tol_color', 20),
            min_pixels=spec.get('min_pixels', 50),
            inset=spec.get('inset', 0),
        )
    return _shift_box(spec, dx, dy)


_SCORE_FRAME_TEMPLATE_CACHE: dict = {}


def _get_score_frame_template(name: str):
    """Charge (et cache) un template score frame depuis `templates/{name}`.
    Le PNG doit être RGBA : pixels opaques = silhouette des éléments d'équipe
    à matcher (saturés dans le frame), pixels transparents = ignorés (zone où
    le contenu peut varier — texte de score, fond, etc.). La distance entre
    les éléments opaques sert d'ancre géométrique anti-faux-positif.

    Retourne (tpl_bw, mask) en uint8, ou (None, None) si pas trouvé.
    """
    if name in _SCORE_FRAME_TEMPLATE_CACHE:
        return _SCORE_FRAME_TEMPLATE_CACHE[name]
    base = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
    path = os.path.join(base, 'templates', name)
    img = cv2.imread(path, cv2.IMREAD_UNCHANGED) if os.path.isfile(path) else None
    if img is None or img.ndim != 3 or img.shape[2] != 4:
        _SCORE_FRAME_TEMPLATE_CACHE[name] = (None, None)
        return (None, None)
    alpha = img[:, :, 3]
    opaque = alpha > 100
    tpl_bw = np.where(opaque, 255, 0).astype(np.uint8)
    mask = opaque.astype(np.uint8) * 255
    _SCORE_FRAME_TEMPLATE_CACHE[name] = (tpl_bw, mask)
    return (tpl_bw, mask)


def _frame_to_saturation_bw(frame: np.ndarray, sat_min: int = 150, val_min: int = 150) -> np.ndarray:
    """Binarise un frame RGB : pixels saturés (= couleurs d'équipe) → blanc,
    fond sombre / neutre → noir. Indépendant de la teinte → robuste aux
    variations de couleurs entre ligues (Classic orange, Local League violet,
    Summit pink, …) et aux décalages YUV→RGB des décodeurs (D3D11 vs AVFoundation).

    Seuils ajustés pour rejeter les fonds de map saturés (cyan d'Artefact,
    teintes vives diverses). Les pills d'équipe ont S>=200 et V>=240, donc
    150/150 garde un large marge tout en excluant les backgrounds typiques.
    """
    hsv = cv2.cvtColor(frame, cv2.COLOR_RGB2HSV)
    s = hsv[:, :, 1]
    v = hsv[:, :, 2]
    return np.where((s >= sat_min) & (v >= val_min), 255, 0).astype(np.uint8)


def _match_score_frame_template(frame: np.ndarray, name: str,
                                anchor=None, max_shift: int = 30,
                                scales=(0.95, 0.98, 1.0, 1.02, 1.05),
                                min_score: float = 0.82,
                                sat_min: int = 150, val_min: int = 150,
                                skip_post_validation: bool = False,
                                validate_regions=None):
    """Cherche le template score frame dans le frame via matchTemplate masqué.
    Le frame est binarisé par saturation HSV (couleur indépendante). Le
    template fournit (silhouette, mask) — le mask cantonne le calcul aux
    pixels opaques (pills d'équipe uniquement), ignorant tout ce qu'il y a
    entre les pills (chiffres de score, fond, etc.).

    `anchor` (x, y) : position canonique attendue du coin top-left du
    template dans le frame quand le HUD est aligné. `max_shift` borne le
    décalage HUD acceptable — un match plus loin qu'`anchor ± max_shift`
    indique un faux positif (autre zone saturée du gameplay).

    On exige aussi que le match ne soit pas collé au bord de la fenêtre de
    recherche : un match au bord signale souvent que le vrai pic est hors
    fenêtre (signal de faux positif fuyant).

    Retourne (match_x, match_y, best_score, best_scale) ou None.
    """
    tpl_bw, mask = _get_score_frame_template(name)
    if tpl_bw is None:
        return None
    frame_bw = _frame_to_saturation_bw(frame, sat_min=sat_min, val_min=val_min)
    fh, fw = frame_bw.shape

    if anchor is None:
        return None  # template matching sans ancre = risque trop élevé de FP
    ax, ay = anchor
    # On élargit la fenêtre de search de quelques px au-delà de max_shift pour
    # détecter (et rejeter) les matchs collés au bord.
    border = 5
    pad = max_shift + border
    sx1 = max(0, int(ax - pad))
    sy1 = max(0, int(ay - pad))
    sx2 = min(fw, int(ax + pad + tpl_bw.shape[1]))
    sy2 = min(fh, int(ay + pad + tpl_bw.shape[0]))
    if sx2 <= sx1 or sy2 <= sy1:
        return None
    sub = frame_bw[sy1:sy2, sx1:sx2]

    best_score = -1.0
    best_loc = None
    best_scale = None
    for scale in scales:
        th = int(tpl_bw.shape[0] * scale)
        tw = int(tpl_bw.shape[1] * scale)
        if th < 10 or tw < 10 or th >= sub.shape[0] or tw >= sub.shape[1]:
            continue
        rtpl = cv2.resize(tpl_bw, (tw, th), interpolation=cv2.INTER_NEAREST)
        rmask = cv2.resize(mask, (tw, th), interpolation=cv2.INTER_NEAREST)
        try:
            res = cv2.matchTemplate(sub, rtpl, cv2.TM_CCORR_NORMED, mask=rmask)
        except cv2.error:
            continue
        res = np.nan_to_num(res, nan=-1.0, posinf=-1.0, neginf=-1.0)
        _, mx, _, loc = cv2.minMaxLoc(res)
        if mx > best_score:
            best_score = mx
            best_loc = loc
            best_scale = scale
    if best_score < min_score or best_loc is None:
        return None
    abs_x = best_loc[0] + sx1
    abs_y = best_loc[1] + sy1
    # Rejette si décalage hors max_shift (le match a fui dans la zone de bordure)
    if abs(abs_x - ax) > max_shift or abs(abs_y - ay) > max_shift:
        return None
    # Validation post-match : un vrai score frame a une saturation MODÉRÉE et
    # UNIFORME (~0.20-0.40) dans les 3 bandes : pill_top, milieu (chiffres),
    # pill_bot. Un faux positif (élément HUD saturé qui matche par hasard la
    # silhouette des pills) montre une saturation extrême (>0.55 ou <0.10)
    # dans au moins une bande. Skip si demandé (templates dont le layout
    # n'a pas la structure pill_top/middle/pill_bot — ex. pro_league
    # horizontal au lieu de vertical).
    if not skip_post_validation:
        s_scale = best_scale
        th = int(tpl_bw.shape[0] * s_scale)
        tw = int(tpl_bw.shape[1] * s_scale)
        pill_h = int(34 * s_scale)
        bbox = frame_bw[abs_y:abs_y + th, abs_x:abs_x + tw]
        if bbox.shape[0] < th or bbox.shape[1] < tw:
            return None
        band_top = bbox[:pill_h]
        band_bot = bbox[th - pill_h:]
        band_mid = bbox[pill_h:th - pill_h]
        if band_top.size == 0 or band_bot.size == 0 or band_mid.size == 0:
            return None
        r_top = (band_top > 0).mean()
        r_bot = (band_bot > 0).mean()
        r_mid = (band_mid > 0).mean()
        SAT_MIN, SAT_MAX = 0.10, 0.55
        if not (SAT_MIN <= r_top <= SAT_MAX and
                SAT_MIN <= r_bot <= SAT_MAX and
                SAT_MIN <= r_mid <= SAT_MAX):
            return None
    # Validation par régions (ex: pro_league — pills doivent être colorés,
    # texte EVA doit être gris). Chaque règle = (x1, y1, x2, y2, s_min, s_max,
    # min_ratio, max_ratio) en coordonnées template. La fenêtre est rescalée
    # par best_scale et offset par le match. On binarise avec saturation
    # (cv2.COLOR_RGB2HSV.S) et on compare le ratio.
    if validate_regions:
        hsv = cv2.cvtColor(frame, cv2.COLOR_RGB2HSV)
        for x1, y1, x2, y2, s_min_r, min_ratio, max_ratio in validate_regions:
            rx1 = abs_x + int(x1 * best_scale)
            ry1 = abs_y + int(y1 * best_scale)
            rx2 = abs_x + int(x2 * best_scale)
            ry2 = abs_y + int(y2 * best_scale)
            if rx2 > hsv.shape[1] or ry2 > hsv.shape[0] or rx1 < 0 or ry1 < 0:
                return None
            region = hsv[ry1:ry2, rx1:rx2]
            sat_ratio = (region[:, :, 1] >= s_min_r).mean()
            if not (min_ratio <= sat_ratio <= max_ratio):
                return None
    return (abs_x, abs_y, float(best_score), float(best_scale))


def _detect_game_score_frame(frame: np.ndarray):
    """
    Détecte un écran de score final (tableau des scores entre les équipes).
    Retourne (mode_index, variant_index, dx, dy) si détecté, (-1, -1, 0.0, 0.0) sinon.
    Chaque mode peut déclarer plusieurs variantes de score frame (classique,
    competition, …) ; on les essaie dans l'ordre et on retourne la première qui matche.
    (dx, dy) = décalage du HUD à appliquer aux régions OCR pour recadrer correctement.

    Détection par matchTemplate masqué sur la silhouette des pills d'équipe
    (cf. `_match_score_frame_template`) — robuste aux couleurs d'équipe
    et au décodeur vidéo.
    """
    for i, mode in enumerate(MODES):
        for j, variant in enumerate(mode['scoreFrame']):
            tpl_cfg = variant['template']
            kwargs = dict(
                anchor=tpl_cfg.get('anchor'),
                sat_min=tpl_cfg.get('sat_min', 150),
                val_min=tpl_cfg.get('val_min', 150),
                skip_post_validation=tpl_cfg.get('skip_post_validation', False),
            )
            if 'min_score' in tpl_cfg: kwargs['min_score'] = tpl_cfg['min_score']
            if 'scales' in tpl_cfg: kwargs['scales'] = tpl_cfg['scales']
            if 'max_shift' in tpl_cfg: kwargs['max_shift'] = tpl_cfg['max_shift']
            if 'validate_regions' in tpl_cfg: kwargs['validate_regions'] = tpl_cfg['validate_regions']
            match = _match_score_frame_template(frame, tpl_cfg['name'], **kwargs)
            if match is not None:
                mx, my, score, scale = match
                ax, ay = tpl_cfg['anchor']
                if DEBUG:
                    _emit({'log': f'[score_frame] template={tpl_cfg["name"]} match=({mx},{my}) score={score:.3f} scale={scale}'})
                return (i, j, mx - ax, my - ay)
    return (-1, -1, 0.0, 0.0)


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


_LOADING_LOGO_CACHE = None  # tuple (gray template) ou (None,) si pas chargeable

def _get_loading_logo_template():
    """Charge (et cache) le template grayscale du logo A de l'écran de loading.
    L'image source `templates/loading_logo.png` est déjà cropée pour ne contenir
    que le A (sans la barre de progression dont le point bouge), sur un large
    fond noir qui pénalise les matchs sur autre fond (ex. menu post-game)."""
    global _LOADING_LOGO_CACHE
    if _LOADING_LOGO_CACHE is not None:
        return _LOADING_LOGO_CACHE[0]
    base = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
    path = os.path.join(base, 'templates', 'loading_logo.png')
    bgr = cv2.imread(path) if os.path.isfile(path) else None
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY) if bgr is not None else None
    _LOADING_LOGO_CACHE = (gray,)
    return gray


def _detect_game_loading_frame(frame: np.ndarray) -> bool:
    """
    Détecte l'écran de loading (logo EVA centré sur fond noir) via template
    matching multi-scale du logo A. Robuste aux variations de cadrage et de
    taille de logo entre les différents formats de capture.
    """
    tpl = _get_loading_logo_template()
    if tpl is None:
        return False
    gray = cv2.cvtColor(frame, cv2.COLOR_RGB2GRAY)
    # Recherche dans une zone centrale large.
    sub = gray[80:1000, 200:1720]
    best = 0.0
    for scale in (0.7, 0.85, 1.0, 1.15, 1.3):
        th = int(tpl.shape[0] * scale); tw = int(tpl.shape[1] * scale)
        if th >= sub.shape[0] or tw >= sub.shape[1]:
            continue
        resized = cv2.resize(tpl, (tw, th), interpolation=cv2.INTER_AREA)
        res = cv2.matchTemplate(sub, resized, cv2.TM_CCOEFF_NORMED)
        _, mx, _, _ = cv2.minMaxLoc(res)
        if mx > best:
            best = mx
    return best > 0.8


_PLAYING_TOP_CACHE = None  # tuple (gray template) ou (None,) si pas chargeable

def _get_playing_top_template():
    """Charge (et cache) le template grayscale de la barre HUD haute (deux pills
    de team name reliées). Sert d'ancre dynamique pour localiser le nom de map
    en-dessous, sans dépendre du cadrage exact de la vidéo."""
    global _PLAYING_TOP_CACHE
    if _PLAYING_TOP_CACHE is not None:
        return _PLAYING_TOP_CACHE[0]
    base = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
    path = os.path.join(base, 'templates', 'playing_top.png')
    bgr = cv2.imread(path) if os.path.isfile(path) else None
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY) if bgr is not None else None
    _PLAYING_TOP_CACHE = (gray,)
    return gray


def _find_playing_top_anchor(frame: np.ndarray):
    """Localise la barre HUD haute (template `playing_top.png`) via template
    matching multi-scale. Retourne (x, y, h, w) — coordonnées et dimensions
    du match — ou None si la barre n'est pas trouvée.

    Sert d'ancre commune aux dérivés (map name, timer) qui se positionnent
    relativement à la barre, sans dépendre de coordonnées HUD codées en dur.
    """
    tpl = _get_playing_top_template()
    if tpl is None:
        return None
    gray = cv2.cvtColor(frame, cv2.COLOR_RGB2GRAY)
    sub = gray[:250, :]   # la barre est toujours dans la bande haute
    best = -1.0
    best_loc = None
    best_size = None
    for scale in (0.7, 0.85, 1.0, 1.15, 1.3):
        th = int(tpl.shape[0] * scale); tw = int(tpl.shape[1] * scale)
        if th >= sub.shape[0] or tw >= sub.shape[1]:
            continue
        resized = cv2.resize(tpl, (tw, th), interpolation=cv2.INTER_AREA)
        res = cv2.matchTemplate(sub, resized, cv2.TM_CCOEFF_NORMED)
        _, mx, _, loc = cv2.minMaxLoc(res)
        if mx > best:
            best = mx; best_loc = loc; best_size = (th, tw)
    # Seuil bas (0.4) : sur certaines frames le pill droit est occulté
    # (kill cam, notification) et le score chute à ~0.45, mais la
    # localisation reste correcte (le pill gauche guide le match).
    if best < 0.4 or best_loc is None:
        return None
    th, tw = best_size
    x, y = best_loc
    return (x, y, th, tw)


def _find_hud_anchor_safely(cap: cv2.VideoCapture, start_ts: float, max_back: int = 60):
    """Localise l'ancre HUD à partir d'une frame qu'on sait être du gameplay.
    Part de `start_ts` (typiquement game.end - 30, soit ~30 s avant la fin
    de game donc bien avant l'écran VICTOIRE/DEFAITE) et recule de 1 s
    jusqu'à trouver un anchor valide ou épuiser `max_back` tentatives.

    Pourquoi : sur les frames de transition (VICTOIRE, intro), le template
    `playing_top.png` matche parfois ~0.4 à un mauvais emplacement (un seul
    pill visible, le template trouve un demi-match aléatoire). Une fois
    cet anchor erroné caché, toutes les boxes dérivées (map, timer, score)
    sont décalées pour tout le reste du run. En cherchant sur une frame
    de gameplay confirmée, on garantit un anchor correct."""
    for OFFSET in range(max_back + 1):
        TS = max(0.0, start_ts - OFFSET)
        FRAME = _get_frame(cap, TS)
        if FRAME is not None:
            ANCHOR = _find_playing_top_anchor(FRAME)
            if ANCHOR is not None:
                if DEBUG:
                    _emit({'log': f'[hud_anchor] locked at ts={TS:.1f}s (offset=-{OFFSET}s from start_ts={start_ts:.1f}s)'})
                return ANCHOR
        if TS <= 0:
            break
    if DEBUG:
        _emit({'log': f'[hud_anchor] not found within {max_back}s of start_ts={start_ts:.1f}s'})
    return None


def _find_map_box(frame: np.ndarray, anchor=None):
    """Boîte OCR du nom de map, ancrée sur la barre HUD haute. Le nom est
    centré horizontalement sur le centre X de la barre, juste sous la barre,
    hauteur = 0.6× hauteur de la barre, largeur = 0.5× largeur de la barre.
    Si `anchor` (tuple x,y,h,w) est fourni, on saute le matchTemplate.
    Retourne None si pas d'ancre."""
    if anchor is None:
        anchor = _find_playing_top_anchor(frame)
    if anchor is None:
        return None
    x, y, th, tw = anchor
    cx = x + tw / 2
    map_y1 = y + th
    map_y2 = map_y1 + int(th * 0.6)
    map_w = int(tw * 0.5)
    map_x1 = int(cx - map_w / 2)
    map_x2 = int(cx + map_w / 2)
    return ((map_x1, map_y1), (map_x2, map_y2))


def _find_timer_box(frame: np.ndarray, anchor=None):
    """Boîte OCR du timer in-game, ancrée sur la barre HUD haute. Le timer
    est centré horizontalement et placé DANS la barre : Y1 = 12 % de la
    hauteur, Y2 = 55 %. Largeur ≈ 0.16× largeur de la barre. Si `anchor`
    (tuple x,y,h,w) est fourni, on saute le matchTemplate."""
    if anchor is None:
        anchor = _find_playing_top_anchor(frame)
    if anchor is None:
        return None
    x, y, th, tw = anchor
    cx = x + tw / 2
    timer_y1 = y + int(th * 0.12)
    timer_y2 = y + int(th * 0.55)
    timer_w = int(tw * 0.16)
    timer_x1 = int(cx - timer_w / 2)
    timer_x2 = int(cx + timer_w / 2)
    return ((timer_x1, timer_y1), (timer_x2, timer_y2))


# Score in-game : symétriques autour du centre de la barre HUD haute.
# Y1 = 31 %, Y2 = 75 % de la hauteur. Centre offset = ±16.5 % de la largeur,
# largeur de chaque score = 14 % (dérivé des positions historiques).
_SCORE_Y1_RATIO     = 0.31
_SCORE_Y2_RATIO     = 0.75
_SCORE_CX_OFFSET    = 0.165  # distance du centre, en fraction de largeur du template
_SCORE_WIDTH_RATIO  = 0.14


def _find_score_box(anchor, side: str):
    """Boîte de recherche du score in-game (orange = side 'left', bleu = 'right'),
    dérivée de la barre HUD haute. Retourne ((x1,y1),(x2,y2)) ou None."""
    if anchor is None:
        return None
    x, y, th, tw = anchor
    cx = x + tw / 2
    sign = -1 if side == 'left' else 1
    score_cx = cx + sign * tw * _SCORE_CX_OFFSET
    score_w = int(tw * _SCORE_WIDTH_RATIO)
    score_y1 = y + int(th * _SCORE_Y1_RATIO)
    score_y2 = y + int(th * _SCORE_Y2_RATIO)
    score_x1 = int(score_cx - score_w / 2)
    score_x2 = int(score_cx + score_w / 2)
    return ((score_x1, score_y1), (score_x2, score_y2))


# Bornes Y des cartes de vie, en fraction de la hauteur de `playing_top` (mesuré
# sur le HUD haut). De -12 % (les cartes débordent un peu au-dessus de la barre)
# à +110 % (elles descendent un peu en-dessous).
_CARD_Y1_RATIO = -0.12
_CARD_Y2_RATIO = 1.10


def _find_team_card_box(anchor, side: str):
    """Boîte de recherche de la couleur d'équipe sur les CARTES DE VIE des
    joueurs (et non les chiffres de score). Quand un joueur est full life, le
    fond de sa carte est un aplat plein de la couleur d'équipe — bien plus
    fiable que les chiffres de score, qui sont alpha-blendés sur la barre HUD
    sombre : leur couleur est tirée vers le gris (canal B remonté pour le jaune,
    descendu pour le cyan) → hors tolérance, et deux thèmes aux teintes proches
    (Challenger vs Pro League sur le bleu) deviennent indiscernables.

    Layout : cartes orange à GAUCHE du HUD haut, cartes bleues à DROITE. Bornes
    Y dérivées de `playing_top` (_CARD_Y*_RATIO). Bornes X = tout le côté hors du
    HUD : le décor n'étant pas team-coloré, l'élargissement est sans risque et ça
    exclut au passage les pills de score centraux (eux aussi colorés).

    Retourne ((x1, y1), (x2, y2)) ou None si l'ancre est absente.
    """
    if anchor is None:
        return None
    x, y, th, tw = anchor
    y1 = max(0, int(y + th * _CARD_Y1_RATIO))
    y2 = int(y + th * _CARD_Y2_RATIO)
    if side == 'left':   # cartes orange, à gauche du HUD
        x1, x2 = 0, int(x)
    else:                # cartes bleues, à droite du HUD
        x1, x2 = int(x + tw), WIDTH
    if x2 <= x1 or y2 <= y1:
        return None
    return ((x1, y1), (x2, y2))


def _find_orange_score_box(frame: np.ndarray, anchor=None):
    """Boîte du score orange (côté gauche du HUD haut). Si `anchor` est fourni,
    saute le matchTemplate."""
    if anchor is None:
        anchor = _find_playing_top_anchor(frame)
    return _find_score_box(anchor, 'left')


def _find_blue_score_box(frame: np.ndarray, anchor=None):
    """Boîte du score bleu (côté droit du HUD haut). Si `anchor` est fourni,
    saute le matchTemplate."""
    if anchor is None:
        anchor = _find_playing_top_anchor(frame)
    return _find_score_box(anchor, 'right')


_POINT_TEMPLATE_CACHE = None  # tuple (gray, alpha_mask) ou (None, None)

# Largeur native de `playing_top.png` à 1920×1080. Sert à dériver l'échelle
# du template `point.png` proportionnellement à la taille du HUD détecté.
_HUD_NATIVE_W = 553


def _get_point_template():
    """Charge (et cache) le template du point de capture en (gray, alpha).
    Le canal alpha sert de mask pour `cv2.matchTemplate` : on ignore le centre
    transparent (qui se remplit en couleur d'équipe pendant la capture) et on
    matche uniquement le contour blanc circulaire."""
    global _POINT_TEMPLATE_CACHE
    if _POINT_TEMPLATE_CACHE is not None:
        return _POINT_TEMPLATE_CACHE
    base = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
    path = os.path.join(base, 'templates', 'point.png')
    if not os.path.isfile(path):
        _POINT_TEMPLATE_CACHE = (None, None)
        return _POINT_TEMPLATE_CACHE
    rgba = np.array(Image.open(path).convert('RGBA'))
    gray = cv2.cvtColor(rgba[:, :, :3], cv2.COLOR_RGB2GRAY)
    alpha = rgba[:, :, 3]
    _POINT_TEMPLATE_CACHE = (gray, alpha)
    return _POINT_TEMPLATE_CACHE


def _ocr_point_letter(frame: np.ndarray, x: int, y: int, w: int, h: int) -> str:
    """OCR la lettre identifiant un point de capture (A, B, C, ...).

    La lettre est blanche, centrée dans le cercle, et bien lisible quand
    le point est VIDE (état de début de game : fond transparent montrant
    le HUD sombre). On crop l'intérieur, seuille en luminance, upscale,
    puis vote sur PSMs × seuils. Whitelist A-E : éviter 'O' empêche la
    confusion D↔O.

    Note : appelé une seule fois par game depuis `_analyze_chunks`
    (positions/lettres verrouillées sur la 1ère frame exploitable). Pas
    d'OCR par seconde — seul le fill couleur est recalculé par frame.
    """
    WHITELIST = 'ABCDE'
    votes = Counter()
    for inset in (5, 6):
        x1 = x + inset; y1 = y + inset
        x2 = x + w - inset; y2 = y + h - inset
        if x2 <= x1 or y2 <= y1: continue
        crop = frame[y1:y2, x1:x2]
        if crop.size == 0: continue
        gray = cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY)
        for thr in (80, 90, 100):
            bw = np.where(gray >= thr, 0, 255).astype(np.uint8)
            pil = Image.fromarray(bw).resize(
                (bw.shape[1] * 8, bw.shape[0] * 8), Image.BICUBIC)
            pil = ImageOps.expand(pil, border=20, fill=255).convert('RGB')
            for psm in (10, 8, 7, 6):
                try:
                    txt = pytesseract.image_to_string(
                        pil, config=f'--psm {psm} -c "tessedit_char_whitelist={WHITELIST}"'
                    ).strip()
                except Exception:
                    txt = ''
                first = next((c for c in txt if c.isalpha()), '')
                if first:
                    votes[first] += 1
    return votes.most_common(1)[0][0] if votes else ''


def _detect_capture_points(frame: np.ndarray, anchor=None,
                           threshold: float = 0.93) -> list:
    """Localise les points de capture (cercles A/B/C/...) sous le nom de map
    via template matching de `point.png`. Retourne une liste de dicts
    `{'x','y','w','h','score'}` triés de gauche à droite, ou `[]` si rien
    n'est trouvé. `anchor` = barre HUD (`_find_playing_top_anchor`) ; si
    None, recalculé.

    Algo :
      1. Restreint la recherche à une bande étroite sous le nom de map
         (centrée sur l'ancre HUD, ~45 % de sa largeur, ~1.6×–2.8× sa hauteur
         en y). Filtre la quasi-totalité des faux positifs venant du décor.
      2. Template matching multi-échelle (±8 % autour de l'échelle dérivée
         de la largeur HUD), avec mask alpha pour ignorer le remplissage.
      3. NMS par distance des centres.
      4. Sélection de la row : on prend le détecteur le plus fort comme
         ancre y, on garde tous les voisins dans ±2.5 px (les points sont
         alignés au pixel près sur la même row).
      5. Trim des extrémités si le gap au voisin > 1.5× la médiane des gaps
         (élimine un faux positif latéral qui aurait passé l'étape 4).
    """
    tpl_gray, tpl_mask = _get_point_template()
    if tpl_gray is None:
        return []
    if anchor is None:
        anchor = _find_playing_top_anchor(frame)
    if anchor is None:
        return []
    x, y, h, w = anchor
    cx = x + w / 2.0
    sy1 = y + int(h * 1.6)
    sy2 = y + int(h * 2.8)
    sw  = int(w * 0.45)
    sx1 = max(0, int(cx - sw / 2))
    sx2 = min(frame.shape[1], int(cx + sw / 2))
    if sy2 <= sy1 or sx2 <= sx1:
        return []
    gray = cv2.cvtColor(frame, cv2.COLOR_RGB2GRAY)
    sub = gray[sy1:sy2, sx1:sx2]

    base_scale = w / float(_HUD_NATIVE_W)
    detections = []
    for s in (base_scale * 0.92, base_scale * 1.00, base_scale * 1.08):
        h_t = int(round(tpl_gray.shape[0] * s))
        w_t = int(round(tpl_gray.shape[1] * s))
        if h_t < 8 or w_t < 8 or h_t >= sub.shape[0] or w_t >= sub.shape[1]:
            continue
        rs_t = cv2.resize(tpl_gray, (w_t, h_t), interpolation=cv2.INTER_AREA)
        rs_m = cv2.resize(tpl_mask, (w_t, h_t), interpolation=cv2.INTER_AREA)
        try:
            res = cv2.matchTemplate(sub, rs_t, cv2.TM_CCORR_NORMED, mask=rs_m)
        except cv2.error:
            continue
        res = np.where(np.isfinite(res), res, 0)
        ys, xs = np.where(res >= threshold)
        for px, py in zip(xs, ys):
            detections.append((float(res[py, px]),
                               px + sx1 + w_t / 2.0,
                               py + sy1 + h_t / 2.0,
                               w_t, h_t))
    if not detections:
        return []

    detections.sort(key=lambda d: -d[0])
    nms = []
    for sc, dcx, dcy, dw, dh in detections:
        if any(abs(dcx - kx) < dw * 0.7 and abs(dcy - ky) < dh * 0.7
               for _, kx, ky, _, _ in nms):
            continue
        nms.append((sc, dcx, dcy, dw, dh))

    # Rejet des faux positifs sombres : TM_CCORR_NORMED est invariant à la
    # luminosité, donc un anneau sombre (décor 3D) peut scorer ≥ threshold.
    # Un vrai point de capture est toujours visible (blanc, orange, ou bleu) ;
    # la luminosité moyenne de ses pixels d'anneau est toujours ≥ 80.
    bright_nms = []
    for sc, dcx, dcy, dw, dh in nms:
        px0 = max(0, int(round(dcx - dw / 2)))
        py0 = max(0, int(round(dcy - dh / 2)))
        px1 = min(gray.shape[1], px0 + int(dw))
        py1 = min(gray.shape[0], py0 + int(dh))
        ring_crop = gray[py0:py1, px0:px1]
        m = cv2.resize(tpl_mask, (ring_crop.shape[1], ring_crop.shape[0]),
                       interpolation=cv2.INTER_NEAREST)
        ring_px = ring_crop[m > 200]
        if len(ring_px) > 0 and ring_px.mean() >= 80:
            bright_nms.append((sc, dcx, dcy, dw, dh))
    if not bright_nms:
        return []
    nms = bright_nms

    anchor_y = max(nms, key=lambda d: d[0])[2]
    keep = [d for d in nms if abs(d[2] - anchor_y) <= 2.5]
    keep.sort(key=lambda d: d[1])

    while len(keep) >= 3:
        gaps = [keep[i + 1][1] - keep[i][1] for i in range(len(keep) - 1)]
        med = sorted(gaps)[len(gaps) // 2]
        if gaps[0] > med * 1.5:
            keep.pop(0); continue
        if gaps[-1] > med * 1.5:
            keep.pop(); continue
        break

    out = []
    for sc, dcx, dcy, dw, dh in keep:
        px = int(round(dcx - dw / 2))
        py = int(round(dcy - dh / 2))
        letter = _ocr_point_letter(frame, px, py, int(dw), int(dh))
        # Filtre anti-FP : durant une frame de gameplay, le template peut matcher
        # des cercles décoratifs du décor 3D. Un faux positif n'a pas de lettre
        # A-E centrée → letter='' → on l'écarte.
        if not letter:
            continue
        out.append({
            'x': px,
            'y': py,
            'w': int(dw),
            'h': int(dh),
            'score': round(sc, 3),
            'letter': letter,
        })

    # Contrainte EVA : pour N points, le set des lettres = {A, ..., N-ième}
    # exactement. L'ordre VISUEL gauche→droite peut varier (ex. HELIOS = B-A-C),
    # mais l'ensemble est toujours {A..N}. On corrige donc les lettres OCR
    # invalides (hors plage attendue) ou dupliquées en réassignant les lettres
    # manquantes en x-order. Ex. 3 points OCR = A-B-E → A-B-C (E remplacé par
    # C, la lettre manquante du set attendu).
    out.sort(key=lambda p: p['x'])
    n = len(out)
    if n > 0:
        expected = {chr(ord('A') + i) for i in range(n)}
        used: set = set()
        for p in out:
            if p['letter'] in expected and p['letter'] not in used:
                used.add(p['letter'])
            else:
                p['letter'] = ''   # marqueur de réassignation
        remaining = sorted(expected - used)
        for p in out:
            if not p['letter']:
                p['letter'] = remaining.pop(0)
    return out


def _detect_capture_points_for_map(cap: cv2.VideoCapture, hud_anchor,
                                   game_start_ts: float,
                                   map_name: str = '') -> list:
    """Garde-fou anti-FP basé sur le nombre attendu de points pour la map.

    Démarre le scan à `game_start_ts + 30s` (le HUD est stabilisé à ce moment,
    transitions d'intro / animations terminées) puis avance par pas de 10 s
    jusqu'à `+120s`. Retourne la première détection dont
    `len(points) == _MAPS[map_name]['points']`. Si aucun essai ne matche,
    retourne `[]` (le résultat est forcément faux — mieux vaut pas de points
    que des FPs réassignés A/B/C qui pollueront la suite du pipeline).

    Si `map_name` est inconnu ou absent de `_MAPS`, retourne la détection à
    `game_start_ts + 30s` sans contrainte (compat. ascendante).
    """
    expected = _MAPS[map_name]['points'] if map_name in _MAPS else None
    for offset in range(30, 130, 10):
        frame = _get_frame(cap, game_start_ts + offset)
        if frame is None:
            continue
        attempt = _detect_capture_points(frame, anchor=hud_anchor)
        if expected is None:
            return attempt
        if len(attempt) == expected:
            return attempt
    return []


def _compute_point_fill(frame: np.ndarray, point: dict,
                        orange_color=(238, 120, 12),
                        blue_color=(43, 137, 237),
                        tol: int = 40) -> tuple:
    """Renvoie (orange_pct, blue_pct) — le taux de remplissage par équipe d'un
    point donné, exprimé en pourcentage de hauteur (le point se remplit comme
    un verre, l'orange descendant depuis le haut et le bleu montant depuis le
    bas, ou inversement).

    Logique :
      - Restreint le matching aux pixels de la BORDURE du point (canal alpha
        du template `point.png` > 200). Le centre est transparent : sur les
        maps avec arrière-plan coloré (Atlantis = eau bleue), l'intérieur
        donnait des faux positifs bleus permanents. La bordure, elle, est
        toujours opaque côté jeu — elle est blanche si neutre, ou prend la
        couleur d'équipe au prorata de la capture. Aucun pixel de décor ne
        peut la traverser.
      - Match RGB par distance L∞ sur les couleurs RÉSOLUES de l'équipe (passées
        par l'appelant via `RESOLVED_ORANGE` / `RESOLVED_BLUE`). Robuste aux
        variantes pro league (vert fluo, violet, jaune, etc.).
      - Pour chaque ligne, on compte les pixels orange vs bleus dans la bordure ;
        majorité ⇒ ligne orange / ligne bleue (sinon ligne vide / blanche). Le
        ratio par hauteur correspond à la jauge perceptuelle (% par volume du
        verre).
    """
    x1 = point['x']; y1 = point['y']
    x2 = x1 + point['w']; y2 = y1 + point['h']
    if x2 <= x1 or y2 <= y1:
        return 0, 0
    sub = frame[y1:y2, x1:x2]
    if sub.size == 0:
        return 0, 0
    # Border mask via alpha du template. Resize si la box détectée n'est pas
    # à la résolution native (ex. HUD à un scale ≠ 1.0).
    _, tpl_alpha = _get_point_template()
    if tpl_alpha is None:
        return 0, 0
    if tpl_alpha.shape != sub.shape[:2]:
        tpl_alpha = cv2.resize(
            tpl_alpha, (sub.shape[1], sub.shape[0]),
            interpolation=cv2.INTER_NEAREST,
        )
    border_mask = tpl_alpha > 200
    sub_i = sub.astype(np.int16)
    org_target = np.array(orange_color, dtype=np.int16)
    blu_target = np.array(blue_color, dtype=np.int16)
    wht_target = np.array((255, 255, 255), dtype=np.int16)
    org_mask = (np.abs(sub_i - org_target).max(axis=2) <= tol) & border_mask
    blu_mask = (np.abs(sub_i - blu_target).max(axis=2) <= tol) & border_mask
    # Bordure blanche = zone non capturée. Permet de distinguer une row
    # partiellement capturée (border orange + border blanche) d'une row
    # anti-aliasée pure aux extrémités de l'hex (ni couleur ni blanc).
    wht_mask = (np.abs(sub_i - wht_target).max(axis=2) <= tol) & border_mask
    # Normalisation par les rows qui contribuent VRAIMENT au signal :
    #   - row sans bordure (alpha 0 partout, bbox rectangulaire vs hex) → skip
    #   - row avec bordure mais ni couleur d'équipe ni blanc (anti-aliasing pur
    #     aux extrémités de l'hex, lettre A/B/C qui masque la bordure) → skip
    #   - row avec bordure blanche = zone non capturée → compte dans total_rows
    #     mais pas dans o_rows/b_rows (vraie partial fill du verre)
    #   - row avec bordure colorée → compte dans la bonne équipe
    # Sans le 2e filtrage, un point 100 % capturé plafonnait à 92-96 % (et
    # le smoother Domination ne lockait jamais owned_team). Sans la détection
    # blanc, un point partial à 95 % renvoyait 100 % au lieu de 95 %.
    rows = sub.shape[0]
    o_rows = b_rows = total_rows = 0
    for r in range(rows):
        if not border_mask[r].any():
            continue
        no = int(org_mask[r].sum()); nb = int(blu_mask[r].sum())
        nw = int(wht_mask[r].sum())
        if no + nb + nw < 1:
            continue
        total_rows += 1
        if no > nb and no >= nw:
            o_rows += 1
        elif nb > no and nb >= nw:
            b_rows += 1
    if total_rows == 0:
        return 0, 0
    o_pct = int(round(o_rows / total_rows * 100))
    b_pct = int(round(b_rows / total_rows * 100))
    # Normalisation base 100 : quand les deux équipes sont présentes sur le
    # point, on rescale pour que orange + blue = 100. Les rangées "vides"
    # (intérieur transparent montrant le décor) n'ont pas de sens propre —
    # elles correspondent juste à la lettre / l'anti-aliasing — donc on les
    # absorbe en proportion. Si une seule équipe est présente, on laisse :
    # un point 50 %/0 % reste à 50 (point en cours de capture, le reste est
    # vide). 0/0 = point neutre.
    if o_pct > 0 and b_pct > 0:
        total = o_pct + b_pct
        o_norm = int(round(o_pct / total * 100))
        b_norm = 100 - o_norm
        return o_norm, b_norm
    return o_pct, b_pct


_HARDPOINT_MAPS = {'Outlaw'}


def _smooth_points_timeline_atlantis(timeline: dict) -> dict:
    """Filtre Atlantis-spécifique : rotation des points par phases.

    Atlantis est la seule map avec rotation des points. Mécanique :
      - Phase 1, elapsed [0, 95)   : seul A actif (B et C lockés à 0/0).
      - Phase 2, elapsed [95, 155) : seuls B et C actifs (A locké à 0/0).
      - Phase 3, elapsed [155, ∞)  : tous actifs.

    Un point inactif a son meter affiché à 0/0 — toute autre lecture est
    du bruit OCR → drop. En phase 2 on injecte explicitement [0,0] sur A
    si A avait été capturé en phase 1, sinon le forward-fill propagerait
    cette ownership à tort sur la zone phase 2 + 3.

    À appliquer AVANT _smooth_points_timeline_domination : sinon une
    fausse capture en phase 1 sur B/C lock owned_team chez le smoother
    Domination et corrompt tout le reste de la timeline.
    """
    PHASE_1_END = 95
    PHASE_2_END = 155
    out = {}
    for letter, tl in timeline.items():
        if letter not in ('A', 'B', 'C'):
            out[letter] = dict(tl)
            continue
        cleaned = {}
        last_phase_1 = [0, 0]
        for k_str, pair in tl.items():
            k = int(k_str)
            if k < PHASE_1_END:
                if letter in ('B', 'C'):
                    if pair == [0, 0]:
                        cleaned[k_str] = pair
                    continue
                # A actif en phase 1
                cleaned[k_str] = pair
                last_phase_1 = pair
            elif k < PHASE_2_END:
                if letter == 'A':
                    continue   # locké à 0/0, [0,0] sera injecté à sec=95
                cleaned[k_str] = pair
            else:
                cleaned[k_str] = pair
        if letter == 'A' and last_phase_1 != [0, 0]:
            cleaned[str(PHASE_1_END)] = [0, 0]
        out[letter] = cleaned
    return out


def _smooth_points_timeline_domination(timeline: dict) -> dict:
    """Filtre le bruit OCR sur le points_timeline en mode Domination.

    Règle EVA Domination : un point peut décroître seul TANT QUE personne ne l'a
    capturé à 100 %. Une fois qu'une équipe atteint 100 %, le point est "owned"
    par cette équipe et ne peut plus que :
      - rester owned (100/0 ou 0/100)
      - être contesté par l'autre équipe (orange ET bleu présents simultanément)
      - être reset (0/0, ex. fin de round)
      - basculer chez l'adversaire (après contest complet)

    Donc une fois owned, une transition `[100, 0] → [80, 0]` (décroissance solo
    sans contest) est nécessairement du bruit OCR — on l'ignore et le state owned
    persiste via la nature sparse du timeline (l'absence d'entrée = forward-fill).

    Renvoie un nouveau dict {letter: {sec_str: [o, b]}} avec les entrées bruitées
    supprimées. À NE PAS appliquer sur Outlaw (Hardpoint) où la décroissance solo
    est physique : un joueur quitte le point, le score arrête de monter et le
    point se vide selon la mécanique Hardpoint.
    """
    out = {}
    for letter, tl in timeline.items():
        owned_team = None  # 'orange' | 'blue' | None
        cleaned = {}
        last = None        # dernière entrée acceptée (o, b) ou None
        keys = sorted(tl.keys(), key=lambda s: int(s))
        for k in keys:
            o, b = tl[k]
            full_orange = (o == 100 and b == 0)
            full_blue = (o == 0 and b == 100)
            both = (o > 0 and b > 0)
            empty = (o == 0 and b == 0)
            if owned_team is None:
                # Phase de capture initiale (jamais atteint 100 %) : tout passe.
                cleaned[k] = [o, b]
                last = (o, b)
                if full_orange:
                    owned_team = 'orange'
                elif full_blue:
                    owned_team = 'blue'
                continue
            # Owned : transitions valides
            if both:
                # Contest en cours : OK, owned_team reste valide.
                cleaned[k] = [o, b]; last = (o, b)
            elif empty:
                # Reset (fin de round, etc.).
                cleaned[k] = [o, b]; last = (o, b); owned_team = None
            elif full_orange and owned_team == 'orange':
                cleaned[k] = [o, b]; last = (o, b)   # stay owned
            elif full_blue and owned_team == 'blue':
                cleaned[k] = [o, b]; last = (o, b)   # stay owned
            elif full_orange or full_blue:
                # Swap demandé : valide UNIQUEMENT si la dernière entrée
                # acceptée était un contest (présence simultanée des deux
                # équipes). Sinon = swap direct impossible → bruit, on droppe
                # et on conserve l'état owned précédent.
                if last is not None and last[0] > 0 and last[1] > 0:
                    cleaned[k] = [o, b]; last = (o, b)
                    owned_team = 'orange' if full_orange else 'blue'
                # else : drop silencieux (impossible physiquement)
            # else : décroissance solo (100/0 → 80/0) → bruit, drop.
        out[letter] = cleaned
    return out


# Player HP cartouches in HUD top — pixel coords for a 1920×1080 frame.
# Layout: orange[0..N-1] aligned left from x=8, blue[0..N-1] aligned right
# to x=1908. Width depends only on team size N (linear extrapolation outside
# 4/5). Each cart has rounded corners and a colored border (visible even at
# 0% HP), so we measure on a narrow band offset 15 px from the right edge —
# inside the avatar-free, icon-free zone — and trim 4/5 corner rows.
_PLAYER_CART_W              = {4: 147, 5: 130}
_PLAYER_CART_H              = 96
# Cart Y is derived from the playing_top anchor (not hardcoded): the carts
# sit `anchor.h * 0.12` px above the anchor's top. Resolution can vary
# slightly across stream encodings, so anchoring it keeps the band stable.
_PLAYER_CART_Y_ANCHOR_RATIO = 0.12
_PLAYER_CART_X_FIRST_ORANGE = 8
_PLAYER_CART_X_LAST_BLUE_RIGHT = 1908
_PLAYER_CART_GAP            = 4
_HP_BAND_OFFSET             = 15
_HP_BAND_WIDTH              = 10
_HP_TOP_SKIP, _HP_BOT_SKIP  = 4, 5
_HP_TOL                     = 40
_HP_THRESHOLD               = 0.3


def _player_cart_w(max_team_size: int) -> int:
    """All carts on the HUD share the same width, set by the larger team
    (e.g. in 4v5 every cart — including the 4-player team's — uses the 5v5
    width). Falls back to a linear interpolation outside the calibrated set."""
    return _PLAYER_CART_W.get(max_team_size, 215 - 17 * max_team_size)


def _player_cart_x_left(team: str, idx: int, n_team: int, max_team_size: int) -> int:
    w = _player_cart_w(max_team_size)
    if team == 'orange':
        return _PLAYER_CART_X_FIRST_ORANGE + idx * (w + _PLAYER_CART_GAP)
    return _PLAYER_CART_X_LAST_BLUE_RIGHT - w - (n_team - 1 - idx) * (w + _PLAYER_CART_GAP)


def _player_cart_y(anchor) -> int:
    """Top y of the player carts. Anchored to the playing_top template (which
    `_find_playing_top_anchor` returns as (x, y, h, w)) so the band stays
    locked when stream encodings shift the HUD by a few pixels."""
    if anchor is None:
        return 33   # last-known reasonable fallback
    _x, y, h, _w = anchor
    return int(round(y - h * _PLAYER_CART_Y_ANCHOR_RATIO))


def _measure_cart_hp(frame: np.ndarray, x: int, w: int, color, cart_y: int) -> int:
    bx = x + w - _HP_BAND_OFFSET - _HP_BAND_WIDTH
    band = frame[cart_y:cart_y + _PLAYER_CART_H,
                 bx:bx + _HP_BAND_WIDTH].astype(int)
    d = np.abs(band - np.array(color)).sum(axis=2)
    row_frac = (d < _HP_TOL * 3).sum(axis=1) / _HP_BAND_WIDTH
    usable = row_frac[_HP_TOP_SKIP:_PLAYER_CART_H - _HP_BOT_SKIP]
    fill = int((usable >= _HP_THRESHOLD).sum())
    pct = int(round(fill / len(usable) * 100))
    # Snap near-full readings to 100: the rounded-corner top of the cart costs
    # us a few rows even at full HP, so genuine 100% reads as 90–99. Clamping
    # ≥ 90 → 100 also makes the smoother's RESPAWN_MIN test reliable.
    return 100 if pct >= 90 else pct


def _compute_player_hp(frame: np.ndarray, n_orange: int, n_blue: int,
                       resolved_orange, resolved_blue, anchor=None) -> dict:
    """Returns {'orange': [hp1, hp2, ...], 'blue': [...]}, each hp ∈ [0, 100].
    A team with unresolved color or zero size yields []."""
    cart_y = _player_cart_y(anchor)
    max_n  = max(n_orange, n_blue)
    w      = _player_cart_w(max_n)
    out = {'orange': [], 'blue': []}
    if resolved_orange is not None and n_orange > 0:
        for i in range(n_orange):
            x = _player_cart_x_left('orange', i, n_orange, max_n)
            out['orange'].append(_measure_cart_hp(frame, x, w, resolved_orange, cart_y))
    if resolved_blue is not None and n_blue > 0:
        for i in range(n_blue):
            x = _player_cart_x_left('blue', i, n_blue, max_n)
            out['blue'].append(_measure_cart_hp(frame, x, w, resolved_blue, cart_y))
    return out


# Pseudo banner inside each cart: light-grey text on a darker translucent
# strip, hugging the top edge of the cart but starting a few px below the
# rounded corner (which would otherwise be picked up as letter-like noise
# by Tesseract). Both Y offset and height scale with the playing_top anchor
# so the band tracks resolution variations.
_PLAYER_PSEUDO_Y_OFFSET_RATIO = 0.05
_PLAYER_PSEUDO_HEIGHT_RATIO   = 0.25


def _player_pseudo_band(anchor) -> tuple:
    """(y1, y2) of the pseudo band for the given playing_top anchor."""
    cart_y = _player_cart_y(anchor)
    if anchor is not None:
        offset = int(round(anchor[2] * _PLAYER_PSEUDO_Y_OFFSET_RATIO))
        h      = int(round(anchor[2] * _PLAYER_PSEUDO_HEIGHT_RATIO))
    else:
        offset, h = 6, 16   # fallback if the anchor wasn't located
    y1 = cart_y + offset
    return y1, y1 + h


def _ocr_cart_pseudo(frame: np.ndarray, cart_x: int, cart_w: int,
                     anchor, whitelist: str = None) -> list:
    """OCR the player pseudo printed at the top of a cart. The text is light
    grey (~150 luminance) on a darker translucent strip (~50), NOT pure white,
    so a fixed colour mask whiffs. We use Otsu thresholding on the grayscale
    band (auto-pick a per-band threshold), then upscale 4× BICUBIC and OCR
    with multi-PSM. `whitelist` restricts Tesseract to roster characters.
    Returns a list of candidate strings — `_match_player` picks the best fit."""
    y1, y2 = _player_pseudo_band(anchor)
    sub = frame[y1:y2, cart_x:cart_x + cart_w]
    gray = cv2.cvtColor(sub, cv2.COLOR_RGB2GRAY)
    _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    # Force Tesseract polarity: text=black (minority), bg=white. Otsu picks
    # an optimal threshold but doesn't know which side is text — on team
    # colours brighter than the text (pro-league cyan/green) it would
    # produce the inverse without this fix.
    if (bw == 0).sum() > (bw == 255).sum():
        bw = 255 - bw
    pil = Image.fromarray(bw).resize(
        (bw.shape[1] * 4, bw.shape[0] * 4), Image.BICUBIC
    )
    pil = ImageOps.expand(pil, border=20, fill=255).convert('RGB')
    if whitelist is None:
        whitelist = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    cfg = f'-c tessedit_char_whitelist={whitelist}'
    candidates = []
    for psm in (7, 8):
        try:
            txt = pytesseract.image_to_string(
                pil, config=f'--psm {psm} {cfg}', lang='evapseudos',
            )
            txt = txt.replace('\r', '').replace('\n', '').strip()
            if txt:
                candidates.append(txt)
        except Exception:
            pass
    return candidates


def _player_slot(team: str, idx: int) -> int:
    """Slot encoding shared with kill rows: orange[0..4] → 1..5,
    blue[0..3] → 6..9, blue[4] → 0 (10 wraps to 0 to keep slots single-digit).
    `null` (None) means "unknown" for cart_assignment; never returned here."""
    if team == 'orange':
        return idx + 1
    return idx + 6 if idx < 4 else 0


def _identify_carts(frame: np.ndarray,
                    n_orange: int, n_blue: int,
                    orange_roster: list, blue_roster: list,
                    anchor=None) -> dict:
    """Match each on-screen cart to a roster slot via top-banner OCR + fuzzy
    match. Returns {'orange': [slot_at_cart_0, slot_at_cart_1, ...],
                    'blue':   [...]}. Slot encoding matches kill rows (see
    `_player_slot`); `null` when a cart could not be confidently identified.
    Returning slots (not pseudos) keeps the assignment stable when a roster
    pseudo is renamed without re-processing the video."""
    out = {'orange': [], 'blue': []}
    max_n = max(n_orange, n_blue)
    w     = _player_cart_w(max_n)
    for team, n, roster in (('orange', n_orange, orange_roster),
                            ('blue',   n_blue,  blue_roster)):
        if n <= 0 or not roster:
            continue
        names = [p.get('name') if isinstance(p, dict) else p for p in roster]
        names = [n_ for n_ in names if n_]
        if not names:
            out[team] = [None] * n
            continue
        # Cart pseudos are always rendered uppercase. Build a whitelist of
        # only the characters present in this team's roster (uppercased) —
        # cuts Tesseract confusion like 0↔O, 8↔B, 1↔I.
        chars = set()
        for n_ in names:
            chars.update(n_.upper())
        whitelist = ''.join(sorted(chars))
        # Build a cart × roster cost matrix from the best fuzzy ratio of
        # each cart's OCR candidates against each roster name. We solve it
        # globally with the Hungarian algorithm so a single pseudo cannot
        # be assigned to two carts (greedy local matching would duplicate
        # close-but-wrong reads, e.g. `lululh` matched twice when the
        # second cart's OCR was garbled).
        cost = np.zeros((n, len(names)), dtype=float)
        for i in range(n):
            x = _player_cart_x_left(team, i, n, max_n)
            raws = _ocr_cart_pseudo(frame, x, w, anchor, whitelist=whitelist)
            for j, name in enumerate(names):
                # Hungarian minimises, so invert ratio (higher ratio → lower cost).
                _, ratio = _match_player(raws, [name], with_ratio=True)
                cost[i, j] = 1.0 - ratio
        rows, cols = scipy_linear_sum_assignment(cost)
        # `assignment[i]` = roster index (0..len(names)-1) picked for cart i,
        # or -1 if rejected by the fuzzy cutoff.
        assignment = [-1] * n
        for i, j in zip(rows, cols):
            # 0.5 fuzzy ratio = `_match_player`'s cutoff; reject below that.
            if cost[i, j] <= 0.5:
                assignment[i] = int(j)
        # Single-missing inference: if exactly one cart is unassigned AND
        # exactly one roster name wasn't picked, the missing cart must be
        # that name (no ambiguity possible).
        empties = [i for i, j in enumerate(assignment) if j < 0]
        used = set(j for j in assignment if j >= 0)
        unused = [j for j in range(len(names)) if j not in used]
        if len(empties) == 1 and len(unused) == 1:
            assignment[empties[0]] = unused[0]
        out[team] = [_player_slot(team, j) if j >= 0 else None
                     for j in assignment]
    return out


def _smooth_hp_timeline(timeline_sparse: dict, regen_window: int = 7,
                        respawn: int = DEFAULT_RESPAWN) -> dict:
    """Patche les faux "mort" en HP=1.

    `respawn` = délai de respawn de la map (s), résolu depuis _MAPS par
    l'appelant. Pilote la fenêtre de death lockout ci-dessous.

    Règle EVA :
      - regen passive après 5 s sans dégâts (1 HP → remonte)
      - respawn 15–18 s après mort selon la map

    Si un joueur est détecté HP=0 puis remonte > 0 dans les `regen_window` sec
    (par défaut 7 s = 5 s regen + 2 s marge), il n'était pas vraiment mort —
    c'était un misread où 1 HP a été lu comme 0. On force la valeur à 1
    (vivant minimum) pour que le calcul d'avantage numérique côté front ne
    compte pas une mort fantôme. Le HP exact est perdu mais la sémantique
    vivant/mort est conservée.

    Le timeline d'entrée est sparse (change-only), on le ré-émet pareil
    après correction.
    """
    if not timeline_sparse:
        return timeline_sparse
    secs = sorted(int(k) for k in timeline_sparse)
    pairs = [timeline_sparse[str(s)] for s in secs]
    # Au timer in-game 10:00 (elapsed=0) tout le monde a 100 HP par construction
    # (frame du go avant le 1er kill). On force l'entrée pour absorber le
    # bruit des toutes premières frames (couleurs pas encore résolues, OCR
    # du timer en cours de stabilisation, animation d'intro).
    n_o = max((len(p.get('orange') or []) for p in pairs), default=0)
    n_b = max((len(p.get('blue') or []) for p in pairs), default=0)
    initial = {'orange': [100] * n_o, 'blue': [100] * n_b}
    if secs[0] == 0:
        pairs[0] = initial
    else:
        secs.insert(0, 0)
        pairs.insert(0, initial)
    for team in ('orange', 'blue'):
        n_players = max((len(p.get(team) or []) for p in pairs), default=0)
        for i in range(n_players):
            for idx, s in enumerate(secs):
                team_hps = pairs[idx].get(team) or []
                if i >= len(team_hps) or team_hps[i] != 0:
                    continue
                # Look ahead up to regen_window seconds (sparse-safe).
                # Patch only if the look-ahead value is in (0, 50]: a respawn
                # lands at full HP (read as 90–100 depending on the fade-in
                # animation timing), while passive regen accrues at ~1 HP/s
                # and tops out around 5–7 HP within a 7 s window. Threshold
                # 50 cleanly separates the two — anything above is a respawn,
                # which the lockout phase below handles.
                cutoff = s + regen_window
                for jdx in range(idx + 1, len(secs)):
                    if secs[jdx] > cutoff:
                        break
                    next_hps = pairs[jdx].get(team) or []
                    if i < len(next_hps) and 0 < next_hps[i] <= 50:
                        pairs[idx] = dict(pairs[idx])
                        pairs[idx][team] = list(team_hps)
                        pairs[idx][team][i] = 1
                        break
    # Death lockout: a confirmed dead player (HP=0 not regen-patched above)
    # cannot revive before le délai de respawn de la map (`respawn`, 15–18 s
    # selon la map — résolu depuis _MAPS par l'appelant). Auparavant on figeait
    # ce plancher à 15 s pour toutes les maps : sur les maps à 17-18 s, la
    # fenêtre 15→respawn n'était plus protégée et un misread y faisait
    # réapparaître le joueur jusqu'à 3 s trop tôt. La valeur per-map supprime ce
    # décalage. Any HP>0 reading inside that window is a misread → forced back to 0.
    # We exit the lockout early on a "real respawn" reading (HP ≥ 85), but ONLY
    # if enough time has elapsed since the death for a respawn to be possible
    # (>= MIN_RESPAWN_ELAPSED). A full-HP reading that lands too soon after the
    # death is physically impossible as a respawn (respawn needs `respawn` s) —
    # it proves the HP=0 was itself a misread, so we ERASE the death (and any 0s
    # forced since) back to alive instead of treating it as a respawn. Sans ça,
    # un 100→0→100 sur une seule frame restait une fausse mort : le patch regen
    # l'ignore (recovery > 50) et l'early-exit le prenait pour un respawn.
    # Threshold 85 (rather than 96 or 90) absorbs the fade-in animation. Certains
    # slots de carts (observé sur le 4e cart orange/Ceres) rendent à 87-89 % le
    # premier instant du respawn — quelques rangées du haut ne matchent pas
    # encore la couleur d'équipe à cause d'un overlay UI ou de l'opacité de
    # l'animation. À 90, on rate ces respawns et le lockout se ré-étend à
    # chaque nouvelle lecture HP=0, bloquant la timeline. À 85, on capte.
    # Les misreads pendant lockout sont typiquement entre 30 et 60 — bien sous
    # 85 — donc on garde la robustesse anti-misread.
    DEATH_LOCKOUT = respawn
    RESPAWN_MIN = 85
    # Délai minimal avant qu'un respawn soit plausible. Une lecture pleine vie
    # qui arrive moins de MIN_RESPAWN_ELAPSED s après la mort ne peut pas être un
    # respawn → c'est la mort qui était un misread, on l'efface. On le dérive de
    # DEATH_LOCKOUT (marge de 2 s sous le plancher) pour qu'il suive toute
    # modif du lockout : la bande [MIN_RESPAWN_ELAPSED, DEATH_LOCKOUT) absorbe un
    # respawn lu un poil tôt (fade-in / timer légèrement décalé / mort détectée
    # en retard) sans le confondre avec un misread à effacer.
    MIN_RESPAWN_ELAPSED = DEATH_LOCKOUT - 2
    for team in ('orange', 'blue'):
        n_players = max((len(p.get(team) or []) for p in pairs), default=0)
        for i in range(n_players):
            lockout_until = -1
            death_idx = -1
            death_s = -1
            n_death_reads = 0   # nb de lectures HP=0 dans la mort EN COURS
            forced = []   # idx des entrées réécrites à 0 pendant ce lockout
            for idx, s in enumerate(secs):
                team_hps = pairs[idx].get(team) or []
                if i >= len(team_hps):
                    continue
                val = team_hps[i]
                if val == 0:
                    # On ancre death_s/idx sur le PREMIER 0 de la mort seulement.
                    # Les 0 suivants (mort soutenue) ne ré-ancrent PAS : sinon
                    # l'écart mort→respawn se mesure depuis le DERNIER 0 lu, et une
                    # vraie mort de plusieurs secondes suivie d'un faux respawn
                    # passe pour un simple blip juste avant ce respawn → la branche
                    # d'effacement ci-dessous se déclenchait à tort.
                    # Cas réel : orange/1 à 3m07 — mort à 186, HP=0 soutenu jusqu'à
                    # 191, faux 100 à 193. Avec ré-ancrage, 193 semblait à 2 s du 0
                    # de 191 → mort effacée → joueur « vivant » 12 s trop tôt.
                    if n_death_reads == 0:
                        death_idx = idx
                        death_s = s
                        forced = []
                    n_death_reads += 1
                    lockout_until = s + DEATH_LOCKOUT
                elif s < lockout_until:
                    if val >= RESPAWN_MIN and s - death_s >= MIN_RESPAWN_ELAPSED:
                        lockout_until = -1   # real respawn
                        n_death_reads = 0
                    elif val >= RESPAWN_MIN and n_death_reads <= 1:
                        # Mort NON confirmée (un seul 0 transitoire) + pleine vie
                        # juste après = misread 100→0→100. On efface la mort et les
                        # 0 forcés depuis, en restaurant la pleine vie mesurée.
                        for fidx in [death_idx] + forced:
                            fhps = pairs[fidx].get(team) or []
                            if i < len(fhps):
                                pairs[fidx] = dict(pairs[fidx])
                                pairs[fidx][team] = list(fhps)
                                pairs[fidx][team][i] = val
                        lockout_until = -1
                        death_idx = -1
                        n_death_reads = 0
                        forced = []
                    else:
                        # Soit mort CONFIRMÉE (>= 2 lectures 0) + pleine vie trop
                        # tôt = c'est le 100 qui est le misread (respawn impossible
                        # avant `respawn` s) ; soit misread < 85 dans la fenêtre.
                        # Dans les deux cas on écrase à 0, le lockout continue.
                        pairs[idx] = dict(pairs[idx])
                        pairs[idx][team] = list(team_hps)
                        pairs[idx][team][i] = 0
                        forced.append(idx)
                else:
                    # Vivant hors de la fenêtre de lockout → la mort courante est
                    # terminée ; un futur 0 ré-ancrera une nouvelle mort.
                    n_death_reads = 0
    # Re-sparse: collapse consecutive identical pairs.
    out = {}
    prev = None
    for s, p in zip(secs, pairs):
        if p != prev:
            out[str(s)] = p
            prev = p
    return out


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


def _detect_game_playing(frame: np.ndarray, anchor=None, ncc_thresh: float = 0.4) -> bool:
    """
    Détecte un frame de jeu en cours via la barre HUD haute (template
    `playing_top.png`). Si `anchor` est fourni (cachée par le chunks loop pour
    tout le chunk), on fait un NCC à position FIXE sur ~553×73 px (~1-3 ms,
    ~30× plus rapide que la recherche multi-scale). Sinon on retombe sur la
    recherche complète via `_find_playing_top_anchor` (~50-100 ms).

    Pourquoi pas un check single-pixel : le bandeau gris central du HUD
    contient une barre de progression orange + bleu qui grandit avec le %
    de capture des points. À mid-game cette barre couvre la zone "gris stable"
    → un check pixel à position fixe vire False sur les vidéos Domination
    (cliff/cliff2/...). Un NCC sur le template entier capture la STRUCTURE du
    HUD (boxes + timer + map name) qui reste invariante, indépendamment des
    valeurs de score/capture.

    Présent pendant TOUT le gameplay — normal, intro, et spectator (joueur
    enregistreur mort en cours de partie, la game continue côté serveur).
    Bascule sur autre layout au score screen / menu → NCC s'effondre.

    Variante historique : check des pixels d'identify du panel player en bas-
    droit. Abandonnée car ce panel disparaît dès que le joueur meurt, alors que
    la game et le killfeed continuent — on perdait jusqu'à 30s de gameplay
    spectator par partie.
    """
    if anchor is None:
        anchor = _find_playing_top_anchor(frame)
        if anchor is None:
            return False
        # _find_playing_top_anchor a fait son propre seuil interne (≥0.4),
        # donc trouver une ancre = déjà valider le gameplay.
        return True

    ax, ay, ah, aw = anchor
    h, w = frame.shape[:2]
    if ay < 0 or ax < 0 or ay + ah > h or ax + aw > w:
        return False

    tpl = _get_playing_top_template()
    if tpl is None:
        return False
    if tpl.shape[0] != ah or tpl.shape[1] != aw:
        tpl = cv2.resize(tpl, (aw, ah), interpolation=cv2.INTER_AREA)

    region_gray = cv2.cvtColor(frame[ay:ay + ah, ax:ax + aw], cv2.COLOR_RGB2GRAY)
    if region_gray.shape != tpl.shape:
        return False
    # Same-size inputs → matchTemplate retourne un scalaire 1×1.
    score = float(cv2.matchTemplate(region_gray, tpl, cv2.TM_CCOEFF_NORMED)[0, 0])
    return score >= ncc_thresh

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


# ─── Player tracking (Layer 1+2+3) ─────────────────────────────────────────

# Singleton ONNX classifier : chargé 1× au premier appel et réutilisé pour
# tous les chunks. Évite de payer le coût d'initialisation onnxruntime
# (~50 ms) à chaque chunk.
_DIGIT_CLASSIFIER = None


def _get_digit_classifier():
    """Lazy-load le classifier ONNX. Retourne None si le modèle est absent
    (deployement minimal, ou rebuild en cours)."""
    global _DIGIT_CLASSIFIER
    if _DIGIT_CLASSIFIER is None:
        try:
            _DIGIT_CLASSIFIER = _digit_classifier.DigitClassifier()
        except Exception as exc:
            if DEBUG:
                _emit({'log': f'[player_tracking] classifier load failed: {exc}'})
            return None
    return _DIGIT_CLASSIFIER


def _sample_team_colors_from_spawns(roi_bgr: np.ndarray, map_meta: dict,
                                     scale, scale_y: Optional[float] = None):
    """Échantillonne les couleurs d'équipe depuis les polygones de spawn.

    Beaucoup plus fiable que de sampler depuis le HUD (où le score est sur
    un gradient orange/jaune dont la couleur dominante diverge de la team
    color réelle de la pastille). On prend la médiane de hue (sat≥80, val≥80)
    dans chaque polygone spawn.

    Args:
        scale: scale_x si scale_y est fourni. Sinon scale uniforme.
        scale_y: scale Y independant (cas minimap etiree en Y). None →
                 utilise `scale` pour les deux axes.

    Returns (orange_rgb, blue_rgb), avec None pour une équipe si pas assez
    de pixels saturés.
    """
    sx = float(scale)
    sy = float(scale_y) if scale_y is not None else sx
    h, w = roi_bgr.shape[:2]
    hsv = cv2.cvtColor(roi_bgr, cv2.COLOR_BGR2HSV)
    hue, sat, val = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    bright = (sat >= 80) & (val >= 80)

    def _sample_polygon(spawn_list):
        if not spawn_list:
            return None
        mask = np.zeros((h, w), dtype=np.uint8)
        for sp in spawn_list:
            poly = sp.get('polygon')
            if not poly:
                continue
            arr = np.array(poly, dtype=np.float32)
            arr[:, 0] *= sx
            arr[:, 1] *= sy
            pts = arr.astype(np.int32)
            cv2.fillPoly(mask, [pts], 255)
        sel = bright & (mask > 0)
        if int(sel.sum()) < 50:
            return None
        h_med = int(np.median(hue[sel]))
        hsv_px = np.uint8([[[h_med, 255, 220]]])
        bgr_px = cv2.cvtColor(hsv_px, cv2.COLOR_HSV2BGR)[0, 0]
        return (int(bgr_px[2]), int(bgr_px[1]), int(bgr_px[0]))

    return (_sample_polygon(map_meta['spawns'].get('orange', [])),
            _sample_polygon(map_meta['spawns'].get('blue', [])))


# Échantillonnage temporel de la passe joueurs.
_PLAYER_TRACK_FPS = 10


def _valid_numbers_from_roster(n_orange: int, n_blue: int) -> dict:
    """Convertit les tailles de roster en sets de numéros valides EVA.

    EVA standard :
      - Orange : numéros 1..n_orange
      - Blue   : 6..9 (4 joueurs), ou {0, 6..9} (5 joueurs)
    """
    valid = {'orange': set(), 'blue': set()}
    if n_orange > 0:
        valid['orange'] = set(range(1, min(n_orange, 5) + 1))
    if n_blue > 0:
        if n_blue >= 5:
            valid['blue'] = {0, 6, 7, 8, 9}
        else:
            valid['blue'] = set(range(10 - n_blue, 10))
    return valid


def _blue_slot_to_number(slot_idx: int, n_blue: int) -> int:
    """Mapping index slot blue → numéro affiché (EVA standard)."""
    if n_blue >= 5 and slot_idx == 4:
        return 0
    return 6 + slot_idx


def _build_dead_lookup(hp_timeline: dict, n_orange: int, n_blue: int):
    """Précompute un lookup (sorted_ts, dead_per_ts) pour les joueurs morts
    à chaque ts du hp_timeline (chunk-relative).

    Retourne None si hp_timeline est vide. `dead_per_ts[i]` = set de (team, num)
    morts à `sorted_ts[i]`. Le forward-fill se fait à l'intérieur.
    """
    if not hp_timeline:
        return None
    sorted_keys = sorted(hp_timeline.keys(), key=lambda k: float(k))
    sorted_ts = [int(float(k)) for k in sorted_keys]
    cur_orange = [100] * max(n_orange, 1)
    cur_blue = [100] * max(n_blue, 1)
    dead_per_ts = []
    for k in sorted_keys:
        entry = hp_timeline.get(k, {})
        if 'orange' in entry:
            cur_orange = entry['orange']
        if 'blue' in entry:
            cur_blue = entry['blue']
        dead = set()
        for i, hp in enumerate(cur_orange):
            if hp <= 0:
                dead.add(('orange', i + 1))
        for i, hp in enumerate(cur_blue):
            if hp <= 0:
                dead.add(('blue', _blue_slot_to_number(i, n_blue)))
        dead_per_ts.append(dead)
    return (sorted_ts, dead_per_ts)


def _dead_at(lookup, elapsed_s: float) -> set:
    """Retourne le set de (team, num) morts à l'instant elapsed_s."""
    if lookup is None:
        return set()
    sorted_ts, dead_per_ts = lookup
    import bisect
    idx = bisect.bisect_right(sorted_ts, elapsed_s) - 1
    if idx < 0:
        return set()
    return dead_per_ts[idx]


def _compute_death_times(hp_timeline: dict, n_orange: int, n_blue: int) -> dict:
    """Pour chaque (team, num), liste triée des instants (s, chunk-relative) où le
    HP transite de >0 à ≤0 = mort confirmée.

    Convention EVA standard (identique à `_build_dead_lookup` et à la convention
    appliquée côté front pour les jetons live) :
      orange num=1..5 → orange[num-1]
      blue   num=6..9 → blue[num-6]
      blue   num=0 (5v5) → blue[n_blue-1]
    Retourne {} si `hp_timeline` est vide.
    """
    if not hp_timeline:
        return {}
    sorted_keys = sorted(hp_timeline.keys(), key=lambda k: float(k))
    deaths: dict = {}
    prev_orange: list = []
    prev_blue: list = []
    for k in sorted_keys:
        t = float(k)
        entry = hp_timeline.get(k, {})
        cur_orange = entry.get('orange', prev_orange)
        cur_blue = entry.get('blue', prev_blue)
        for i, hp in enumerate(cur_orange):
            if i < len(prev_orange) and prev_orange[i] > 0 and hp <= 0:
                deaths.setdefault(('orange', i + 1), []).append(t)
        for i, hp in enumerate(cur_blue):
            if i < len(prev_blue) and prev_blue[i] > 0 and hp <= 0:
                deaths.setdefault(('blue', _blue_slot_to_number(i, n_blue)), []).append(t)
        prev_orange = list(cur_orange)
        prev_blue = list(cur_blue)
    return deaths


def _split_history_into_lives(history: list, deaths: list) -> list:
    """Découpe `history` (triée par t) aux instants `deaths` (triés).

    Une vie = sous-liste contigüe de `history` dont tous les t sont ≤ au prochain
    deathTime. Le point au temps exact de la mort reste dans la vie qui meurt
    (mirror du front : la frame qui touche t_death conclut la vie).
    `died=True` ssi un deathTime est passé après le dernier point de la vie
    (au moins une mort à attribuer).
    Vies vides (deathTime sans détection préalable) sautées.

    Retourne `[{'history': [...], 'died': bool}, ...]`.
    """
    if not history:
        return []
    deaths_sorted = sorted(deaths)
    lives = []
    cur: list = []
    deaths_iter = iter(deaths_sorted)
    next_death = next(deaths_iter, None)
    for entry in history:
        t = entry[0]
        while next_death is not None and next_death < t:
            if cur:
                lives.append({'history': cur, 'died': True})
                cur = []
            next_death = next(deaths_iter, None)
        cur.append(entry)
    if cur:
        lives.append({'history': cur, 'died': next_death is not None})
    return lives


# Vitesse max plausible d'un joueur (fraction de map / seconde).
# Calibré pour rejeter les détections aberrantes (CNN qui hallucine sur un
# X de mort en attendant que hp_timeline confirme HP=0) sans toucher aux
# sprints (~20 %/s) ni aux TPs courts. Un saut au-dessus n'est gardé que
# s'il est confirmé par un voisin temporel proche.
_OUTLIER_MAX_SPEED_PER_S = 0.50
# Demi-fenêtre TEMPORELLE (secondes) pour chercher un voisin cohérent.
# Fenêtre en TEMPS (pas en index) : quand le joueur est obscurci/mort qq
# secondes, la sequence devient sparse → une fenêtre par index couvre plusieurs
# secondes, dt explose, le seuil de vitesse (d ≤ 0.5·dt) devient trivial et les
# outliers survivent. En temps, le seuil reste strict (max 0.5·0.5=0.25 de map)
# quelle que soit la densité de détections.
_OUTLIER_NEIGHBOR_WINDOW_S = 0.5
# Durée max (s) qu'un "run aberrant" peut avoir pour être supprimé. Au-delà,
# on considère que c'est un vrai changement de trajectoire (TP réel suivi
# d'un retour, sprint long) et on laisse intact, même si la trajectoire
# revient ensuite à l'ancienne position. Calibré sur les vrais clusters
# observés (1-3 frames consécutives à 10 FPS = 0.1-0.3s) avec marge ×3.
# Un round-trip légitime en jeu (sortie → action → retour) prend > 1s.
_OUTLIER_MAX_RUN_DURATION_S = 1.0
# Vitesse au-dessus de laquelle un PAS cohérent isolé devient suspect.
# Sert au Fix D : quand un seul pas à haute vitesse mène vers une position
# dont la trajectoire ne suit pas (resync forcé), on considère ce pas comme
# une fausse détection « tout juste sous la barre des 0.5/s ». Les vrais
# mouvements rapides (sprints) tiennent plusieurs pas consécutifs → streak ≥ 2
# → le filtre ne se déclenche pas. Calibré sur les vrais mouvements observés
# dans les replays EVA (la plupart sous 0.3/s).
_OUTLIER_HIGH_SPEED_PER_S = 0.35

# ── Tracker de sélection (Layer 2 MOT léger) ───────────────────────────────
# À chaque frame, le CNN peut classifier PLUSIEURS blobs comme le même
# (team, number) — typiquement le vrai marqueur + un faux (autre marqueur
# misclassé), TOUS à conf 1.00. L'ancien dédup « la plus haute confidence
# gagne » tranchait alors au hasard. Le tracker tranche par COHÉRENCE DE
# TRAJECTOIRE : parmi les candidats, on prend le plus proche de la dernière
# position connue du joueur (gate de vitesse, élargi aux téléporteurs).
_TRK_DT_CAP = 0.6          # cap du dt pour le gate (évite qu'un long trou ouvre tout)
_TRK_GATE_MARGIN = 0.05    # tolérance jitter (fraction de map)
_TRK_CLUSTER_R = 0.10      # rayon pour considérer 2 candidats « au même endroit »
# Un cluster lointain STABLE qui persiste ce délai SANS qu'un candidat
# atteignable ne réapparaisse = vrai déplacement (le joueur a quitté l'ancienne
# position) → on ré-acquiert. Distingue un vrai déplacement (la nouvelle
# position persiste, l'ancienne ne réapparaît plus) d'un flicker d'identité
# (le vrai marqueur réapparaît sans cesse entre les faux) : ce dernier
# re-verrouille le track avant d'atteindre ce seuil.
_TRK_REACQUIRE_S = 1.0
_TRK_HARD_TIMEOUT = 2.5    # sans aucune détection acceptée depuis ce délai → ré-acquiert le meilleur conf
_TRK_TP_RADIUS = 0.05      # rayon autour d'une extrémité de téléporteur (fraction de map)


def _track_select(trk, cands: list, t_rel: float, tp_pairs: list):
    """Choisit LA détection à retenir parmi `cands` (liste de (conf, x, y)) pour
    un (team, number) à l'instant `t_rel`, par cohérence de trajectoire.

    `trk` = état précédent {'x','y','t','pend'} ou None (track neuf).
    Retourne (conf, x, y) à accepter, ou None pour COASTER (rien cette frame).
    Mute `trk['pend']` pendant le coasting pour suivre un éventuel cluster
    lointain stable (= vrai déplacement à ré-acquérir).

    Règle :
      - track neuf → meilleur conf (acquisition).
      - candidat(s) ATTEIGNABLE(s) depuis la dernière position (gate de vitesse,
        ou via une paire de téléporteurs) → le plus proche. C'est lui qui filtre
        les faux : un marqueur misclassé à l'autre bout de la carte n'est pas
        atteignable → ignoré au profit du vrai, proche.
      - aucun atteignable : on COASTE, sauf si un même cluster lointain persiste
        ≥ `_TRK_REACQUIRE_S` (vrai déplacement : l'ancienne position ne réapparaît
        plus) ou trou > `_TRK_HARD_TIMEOUT` → ré-acquisition.
    """
    if not cands:
        return None
    if trk is None:
        return max(cands, key=lambda c: c[0])
    dt = t_rel - trk['t']
    allowed = _OUTLIER_MAX_SPEED_PER_S * min(dt, _TRK_DT_CAP) + _TRK_GATE_MARGIN
    tx, ty = trk['x'], trk['y']

    def _tp_ok(cx, cy):
        r2 = _TRK_TP_RADIUS * _TRK_TP_RADIUS
        for (ax, ay), (bx, by) in tp_pairs:
            if (((tx - ax) ** 2 + (ty - ay) ** 2 <= r2 and (cx - bx) ** 2 + (cy - by) ** 2 <= r2) or
                    ((tx - bx) ** 2 + (ty - by) ** 2 <= r2 and (cx - ax) ** 2 + (cy - ay) ** 2 <= r2)):
                return True
        return False

    reach = [c for c in cands
             if ((c[1] - tx) ** 2 + (c[2] - ty) ** 2) ** 0.5 <= allowed or _tp_ok(c[1], c[2])]
    if reach:
        trk['pend'] = None
        return min(reach, key=lambda c: (c[1] - tx) ** 2 + (c[2] - ty) ** 2)
    if dt > _TRK_HARD_TIMEOUT:
        trk['pend'] = None
        return max(cands, key=lambda c: c[0])
    best = max(cands, key=lambda c: c[0])
    pend = trk.get('pend')
    if pend is not None and ((best[1] - pend[0]) ** 2 + (best[2] - pend[1]) ** 2) ** 0.5 < _TRK_CLUSTER_R:
        if t_rel - pend[2] >= _TRK_REACQUIRE_S:
            trk['pend'] = None
            return best
    else:
        trk['pend'] = (best[1], best[2], t_rel)
    return None


_walkable_cache: dict = {}


def _load_walkable_mask(map_name: str, erode_px: int = 6):
    """Charge (et met en cache) le masque de traversabilité `walkable.png` de la
    map : noir (<128) = traversable, blanc = mur/décor.

    On DILATE la zone traversable de `erode_px` px : une détection ne compte
    « dans un mur » que si elle est à plus de `erode_px` d'une zone traversable.
    Cette marge absorbe la taille du marqueur joueur et l'imprécision du masque
    au ras des murs (calibré sur Polaris : ~0.1 % des vraies positions touchées
    à 6 px, tout en attrapant les faux profonds — ex. #9 à 0m20, 8.6 px dans le
    mur). Retourne un array uint8 (1 = ok, 0 = mur) aligné sur l'inner du
    template, ou None si la map n'a pas de masque.
    """
    if map_name in _walkable_cache:
        return _walkable_cache[map_name]
    res = None
    fn = _map_metadata._METADATA_FILES.get(map_name)
    if fn:
        slug = os.path.splitext(fn)[0]
        path = os.path.join(_map_metadata._TEMPLATES_DIR, slug, 'walkable.png')
        if os.path.isfile(path):
            g = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
            # On n'active le masque que s'il est réellement BINAIRE (≥97 % de
            # pixels noir ou blanc purs). Par défaut `walkable.png` est une copie
            # du minimap couleur (placeholder non peint) — l'appliquer rejetterait
            # des détections au hasard. Ce garde-fou ignore ces copies et
            # s'auto-active dès qu'une map est peinte en vrai masque.
            if g is not None and float(((g < 30) | (g > 225)).mean()) >= 0.97:
                walk = (g < 128).astype(np.uint8)
                if erode_px > 0:
                    walk = cv2.dilate(walk, cv2.getStructuringElement(
                        cv2.MORPH_ELLIPSE, (2 * erode_px + 1, 2 * erode_px + 1)))
                res = walk
    _walkable_cache[map_name] = res
    return res


def _is_walkable(mask, x_frac: float, y_frac: float) -> bool:
    """True si (x_frac, y_frac) est en zone traversable (ou si pas de masque)."""
    if mask is None:
        return True
    h, w = mask.shape
    px = min(w - 1, max(0, int(round(x_frac * (w - 1)))))
    py = min(h - 1, max(0, int(round(y_frac * (h - 1)))))
    return bool(mask[py, px])


def _template_px_to_inner_frac(x_tpl: float, y_tpl: float,
                                tpl_w: int, tpl_h: int,
                                margins: Optional[dict]) -> tuple:
    """Convertit une position template-px en fraction [0..1] de la zone INNER
    (zone jouable, marges transparentes du template exclues).

    Sans `margins`, équivaut à `x_tpl / tpl_w` (fraction du template entier).
    Avec margins {top, right, bottom, left}, normalise dans la zone interne :
        inner_w = tpl_w - left - right
        x_frac = (x_tpl - left) / inner_w   (clampé [0,1])
    Un joueur "débordant" dans la marge (centre dans la zone transparente) est
    clampé au bord de la zone jouable.
    """
    if not margins:
        return (max(0.0, min(1.0, x_tpl / tpl_w)),
                max(0.0, min(1.0, y_tpl / tpl_h)))
    left   = float(margins.get('left', 0))
    right  = float(margins.get('right', 0))
    top    = float(margins.get('top', 0))
    bottom = float(margins.get('bottom', 0))
    inner_w = max(1.0, tpl_w - left - right)
    inner_h = max(1.0, tpl_h - top - bottom)
    x_frac = (x_tpl - left) / inner_w
    y_frac = (y_tpl - top) / inner_h
    return (max(0.0, min(1.0, x_frac)),
            max(0.0, min(1.0, y_frac)))


def _find_aberrant_runs(seq: list) -> set:
    """Identifie les indices à supprimer : groupes contigus de points qui
    s'écartent de la trajectoire (vitesse > `_OUTLIER_MAX_SPEED_PER_S`) puis
    y reviennent en moins de `_OUTLIER_MAX_RUN_DURATION_S`.

    Algo "anchor" : on garde le dernier point cohérent (`anchor`). Quand
    `seq[i]` devient incohérent, on cherche en avant le 1er `j` tel que
    `seq[j]` redevient cohérent avec l'anchor. Trouvé → tout `[i..j-1]` est
    un run aberrant et est marqué pour suppression. Pas trouvé → 2 sous-cas :
      - **Fix C** : run atteint la fin de seq (`j >= n`). Les points en
        traîne sont une "vie qui s'arrête au mauvais endroit" (cluster de
        fausses détections juste avant la mort). On supprime tout le run.
      - **Fix D** : le pas qui a mené à l'anchor courant était à haute
        vitesse (> _OUTLIER_HIGH_SPEED_PER_S) ET solitaire (streak == 1).
        Un seul pas rapide qui ne mène nulle part est presque sûrement une
        fausse détection à peine sous la barre du seuil de cohérence. On
        rétrograde l'anchor. Un vrai sprint enchaîne plusieurs pas → streak
        ≥ 2 → Fix D ne se déclenche pas.
      - Sinon : vrai changement de trajectoire (TP, gap de tracking), on
        resynchronise l'anchor sans rien effacer.

    Couvre les *clusters* d'aberrations qui se validaient mutuellement et
    passaient à travers la logique « ≥ 1 voisin cohérent » historique.
    """
    n = len(seq)
    if n < 3:
        return set()
    to_remove: set = set()
    anchor = 0
    last_step_speed = 0.0   # vitesse réelle (non capée) du dernier pas cohérent
    high_speed_streak = 0   # nb de pas cohérents consécutifs à > _OUTLIER_HIGH_SPEED_PER_S
    i = 1
    while i < n:
        t_a, x_a, y_a = seq[anchor]
        t_i, x_i, y_i = seq[i]
        # On plafonne dt à `_OUTLIER_NEIGHBOR_WINDOW_S` AUSSI pour le check
        # anchor→i. Sans ça, après un long trou de tracking (ex. joueur perdu
        # pendant 3s), `max_speed * dt` devient si grand qu'un point situé
        # n'importe où sur la map passe pour "atteignable depuis l'anchor"
        # — une fausse détection de fin de vie au spawn se ferait absorber
        # comme nouvel anchor au lieu d'être flaggée. Avec le cap, le seuil
        # reste borné à 0.25 fraction de map dès que dt > 0.5s. Effet sur
        # les vrais sprints/TPs : ils tomberont dans la branche "pas de
        # retour" → resync anchor (rien retiré), comportement inchangé.
        dt_ai = t_i - t_a
        dt_ai_capped = max(min(dt_ai, _OUTLIER_NEIGHBOR_WINDOW_S), 1e-9)
        d = ((x_i - x_a) ** 2 + (y_i - y_a) ** 2) ** 0.5
        if d <= _OUTLIER_MAX_SPEED_PER_S * dt_ai_capped:
            # Pas cohérent : mémorise la vitesse réelle (non capée) pour Fix D.
            speed = d / max(dt_ai, 1e-9)
            if speed > _OUTLIER_HIGH_SPEED_PER_S:
                high_speed_streak += 1
            else:
                high_speed_streak = 0
            last_step_speed = speed
            anchor = i
            i += 1
            continue
        # seq[i] incohérent : on cherche un retour géométriquement proche de
        # l'anchor. Même cap sur dt_aj que ci-dessus, et pour la même raison.
        j = i + 1
        run_resolved = False
        while j < n and (seq[j][0] - t_i) <= _OUTLIER_MAX_RUN_DURATION_S:
            t_j, x_j, y_j = seq[j]
            dt_aj_capped = max(min(t_j - t_a, _OUTLIER_NEIGHBOR_WINDOW_S), 1e-9)
            d_aj = ((x_j - x_a) ** 2 + (y_j - y_a) ** 2) ** 0.5
            if d_aj <= _OUTLIER_MAX_SPEED_PER_S * dt_aj_capped:
                run_resolved = True
                break
            j += 1
        if run_resolved:
            for k in range(i, j):
                to_remove.add(k)
            anchor = j
            last_step_speed = 0.0
            high_speed_streak = 0
            i = j + 1
        else:
            # Fix C : run en traîne. Le run [i..fin] est aberrant si :
            #   - "loin" de l'anchor (saut significatif, pas juste un drift
            #     d'accélération qui passe juste la barre)
            #   - "majoritairement statique" — la majorité des points est
            #     tightly clusterée. On utilise la DISTANCE MÉDIANE au centroïde
            #     médian (pas le diamètre brut) pour rester robuste à 1-2 points
            #     de transition divergents (ex : J6 vie 4 = 1 frame à (0.92,0.40)
            #     en transit + 70 frames statiques à (0.96,0.58)) ou à plusieurs
            #     mini-clusters trailing (ex : J2 vie 0 = cluster A + cluster B
            #     dont le plus gros emporte la médiane). Un vrai TP avec
            #     walking-around ferait diverger la médiane.
            if i < n:
                first_d = ((seq[i][1] - x_a) ** 2 + (seq[i][2] - y_a) ** 2) ** 0.5
                xs = [seq[k][1] for k in range(i, n)]
                ys = [seq[k][2] for k in range(i, n)]
                cx = statistics.median(xs)
                cy = statistics.median(ys)
                dists = [((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
                         for x, y in zip(xs, ys)]
                median_dist = statistics.median(dists)
                jump_threshold = _OUTLIER_NEIGHBOR_WINDOW_S * _OUTLIER_MAX_SPEED_PER_S
                if first_d > jump_threshold and median_dist < 0.005:
                    for k in range(i, n):
                        to_remove.add(k)
                    break
            # Fix D : le pas qui a porté l'anchor à sa position actuelle était
            # solitaire ET à haute vitesse. Le fait qu'on doive resync (rien
            # ne suit cet anchor) prouve qu'il ne tenait qu'à un fil — c'est
            # la fausse détection « à peine sous la barre des 0.5/s ».
            if high_speed_streak == 1 and last_step_speed > _OUTLIER_HIGH_SPEED_PER_S:
                to_remove.add(anchor)
            # Pas de retour : vrai changement de trajectoire. On resynchronise
            # sur seq[i] pour ne pas marquer toute la suite comme incohérente.
            anchor = i
            last_step_speed = 0.0
            high_speed_streak = 0
            i += 1
    return to_remove


def _find_leading_aberration(seq: list) -> set:
    """Détecte un cluster aberrant en TÊTE de seq : peu de points (≤ 5) très
    rapprochés (diamètre < 0.05) suivis d'un saut significatif (> 0.25 de map)
    vers une trajectoire principale beaucoup plus longue.

    Cas typique : un joueur respawne au spawn mais les premières détections de
    la vie atterrissent sur une fausse position (autre cart en mouvement
    misclassé) avant de "snap" sur la vraie position au spawn.

    Miroir temporel de Fix C (run en traîne), mais sans `max_run_duration` :
    on n'a pas de "retour à l'ancre" à attendre, la trajectoire principale
    est par définition celle qui suit le saut.
    """
    n = len(seq)
    if n < 6:
        return set()
    jump_threshold = _OUTLIER_NEIGHBOR_WINDOW_S * _OUTLIER_MAX_SPEED_PER_S
    for split in range(1, min(7, n)):  # premier saut potentiel en position 1..6
        t_prev, x_prev, y_prev = seq[split - 1]
        t_cur, x_cur, y_cur = seq[split]
        dt = max(t_cur - t_prev, 1e-9)
        dt_capped = min(dt, _OUTLIER_NEIGHBOR_WINDOW_S)
        d_jump = ((x_cur - x_prev) ** 2 + (y_cur - y_prev) ** 2) ** 0.5
        if d_jump <= _OUTLIER_MAX_SPEED_PER_S * dt_capped:
            continue  # pas de saut ici, on continue dans le cluster initial
        # Saut trouvé. Le cluster initial = [0..split-1].
        if split > 5:
            return set()  # cluster initial trop long → probablement la vraie traj
        xs = [seq[k][1] for k in range(split)]
        ys = [seq[k][2] for k in range(split)]
        diameter = ((max(xs) - min(xs)) ** 2 + (max(ys) - min(ys)) ** 2) ** 0.5
        if diameter > 0.05:
            return set()  # le leading bouge trop, c'est une vraie trajectoire
        if d_jump <= jump_threshold:
            return set()  # saut pas assez grand → simple drift
        # Trajectoire principale doit être nettement plus longue que le leading
        # — sinon les deux pourraient être aussi suspects l'un que l'autre.
        if (n - split) < 3 * split:
            return set()
        # Si la trajectoire principale REPASSE par la position du leading
        # (≥ 2 points dans un rayon de 0.1 du centre du cluster), c'est un
        # vrai aller-retour (TP + activité + return). Sinon, le leading est
        # une zone que le joueur ne visite jamais ailleurs = aberrant.
        cx = sum(xs) / len(xs)
        cy = sum(ys) / len(ys)
        revisits = 0
        for k in range(split, n):
            dx = seq[k][1] - cx
            dy = seq[k][2] - cy
            if dx * dx + dy * dy < 0.01:  # < 0.1 de distance
                revisits += 1
                if revisits >= 2:
                    return set()  # vrai aller-retour
        return set(range(split))
    return set()


def _find_line_fit_outliers(seq: list,
                             residual_threshold: float = 0.1,
                             max_anchor_dist: float = 0.15) -> set:
    """Fix H : détecte les points qui s'écartent significativement de la ligne
    droite entre leur voisin avant et après — TANT QUE les deux voisins sont
    proches l'un de l'autre (sinon c'est une zone de mouvement rapide où
    "off-line" est normal).

    Couvre le cas du lone hop mid-trajectoire où chaque transition individuelle
    reste sous le seuil de cohérence (vitesse < 0.5/s pour un saut court) mais
    le point lui-même est manifestement hors trajectoire. Ex : J9 vie 2 à 2m24s
    où un saut isolé à (0.97, 0.48) entre deux points à (0.87, 0.36) et
    (0.86, 0.27) — l'interpolation linéaire dit (0.86, 0.31), résiduel 0.20.
    """
    n = len(seq)
    if n < 3:
        return set()
    to_remove: set = set()
    for i in range(1, n - 1):
        t_a, x_a, y_a = seq[i - 1]
        t_i, x_i, y_i = seq[i]
        t_c, x_c, y_c = seq[i + 1]
        anchor_dist = ((x_c - x_a) ** 2 + (y_c - y_a) ** 2) ** 0.5
        if anchor_dist > max_anchor_dist:
            continue  # voisins trop éloignés → la "ligne" n'a pas de sens
        dt = t_c - t_a
        if dt <= 0:
            continue
        frac = (t_i - t_a) / dt
        expected_x = x_a + frac * (x_c - x_a)
        expected_y = y_a + frac * (y_c - y_a)
        residual = ((x_i - expected_x) ** 2 + (y_i - expected_y) ** 2) ** 0.5
        if residual > residual_threshold:
            to_remove.add(i)
    return to_remove


def _find_short_excursion(seq: list, max_window_s: float = 3.0,
                          max_anchor_dist: float = 0.15,
                          min_offset: float = 0.1) -> set:
    """Fix I : burst de fausses détections pendant un TROU de tracking, encadré
    par deux ancres PROCHES l'une de l'autre.

    Généralise Fix H (`_find_line_fit_outliers`, qui ne traite qu'UN point isolé)
    aux bursts de taille quelconque. Pendant un trou (joueur momentanément perdu),
    le détecteur peut pondre une rafale de positions FAUSSES dispersées partout
    sur la carte avant de ré-acquérir le joueur quasi là où il l'avait perdu —
    l'interpolation reliait ensuite ce garbage en un « tour » de carte.

    Cas réel orange/4 à 4m36 : entre (0.10,0.22) à t=276.0 et (0.12,0.21) à
    t=278.7 — deux ancres à 0.08 l'une de l'autre — ~12 faux points dispersés
    (bas-gauche, haut-droite, coin (0.98,0.0), bord gauche...). Ni Fix G (les
    points bougent), ni `_find_aberrant_runs` (le retour arrive > 1 s après, hors
    de sa fenêtre), ni Fix H (plusieurs points qui se cautionnent) ne couvraient
    ça. L'ancienne version de Fix I (bornée à 3 frames) non plus.

    Algo : pour chaque ancre `a = seq[i-1]`, on cherche en avant, dans une FENÊTRE
    TEMPORELLE `max_window_s`, la 1ʳᵉ ancre `b` telle que :
      - `b` est PROCHE de `a` (< `max_anchor_dist`) — la trajectoire revient là
        d'où elle est partie : le joueur n'a en fait pas bougé ;
      - TOUS les points entre `a` et `b` sont LOIN (> `min_offset`) des DEUX ancres.
    Si trouvé, on supprime tout l'intervalle. Borne TEMPORELLE (et non par nombre
    de frames) car un trou de tracking peut générer un burst arbitrairement long.

    Pourquoi c'est sûr (pas de faux positif sur un vrai déplacement) : un vrai
    joueur ne bouge que ~1-5 %/frame ; juste après avoir quitté `a`, sa 1ʳᵉ frame
    est donc à < `min_offset` de `a` → la condition « tous loin » échoue → on ne
    touche pas. Seul un burst qui SAUTE instantanément loin (> 10 % en 1 frame,
    physiquement impossible) puis revient satisfait la condition.
    """
    n = len(seq)
    if n < 3:
        return set()

    def _d(p, q):
        return ((p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2) ** 0.5

    to_remove: set = set()
    i = 1
    while i < n - 1:
        a = seq[i - 1]
        found = False
        j = i + 1
        while j < n and (seq[j][0] - a[0]) <= max_window_s:
            b = seq[j]
            if _d(a, b) <= max_anchor_dist and all(
                    _d(seq[k], a) > min_offset and _d(seq[k], b) > min_offset
                    for k in range(i, j)):
                for k in range(i, j):
                    to_remove.add(k)
                i = j
                found = True
                break
            j += 1
        if not found:
            i += 1
    return to_remove


def _find_isolated_outliers(seq: list) -> set:
    """Marque les points qui n'ont **aucun** voisin cohérent dans une fenêtre
    ±`_OUTLIER_NEIGHBOR_WINDOW_S`.

    Filet de sécurité après la passe par runs pour rattraper les blinks
    ponctuels dont la trajectoire reprend ailleurs (cas où aucun "retour"
    n'est attendu : fausse détection en bord de vraie mort par exemple).

    /!\\ Inclut le **premier et dernier** point de chaque vie. Le cas typique
    qu'on couvre : un joueur meurt loin du spawn, et la dernière détection
    de la vie atterrit accidentellement sur le spawn (autre joueur en
    respawn classifié comme étant celui qui meurt). Le dernier point est
    alors à 0.5+ de map du précédent — aucun voisin cohérent → supprimé.
    """
    n = len(seq)
    if n < 3:
        return set()
    to_remove: set = set()
    for i in range(n):
        t_i, x_i, y_i = seq[i]
        has_coherent_neighbor = False
        j = i - 1
        while j >= 0 and (t_i - seq[j][0]) <= _OUTLIER_NEIGHBOR_WINDOW_S:
            t_j, x_j, y_j = seq[j]
            dt = max(abs(t_j - t_i), 1e-9)
            d = ((x_i - x_j) ** 2 + (y_i - y_j) ** 2) ** 0.5
            if d <= _OUTLIER_MAX_SPEED_PER_S * dt:
                has_coherent_neighbor = True
                break
            j -= 1
        if not has_coherent_neighbor:
            j = i + 1
            while j < n and (seq[j][0] - t_i) <= _OUTLIER_NEIGHBOR_WINDOW_S:
                t_j, x_j, y_j = seq[j]
                dt = max(abs(t_j - t_i), 1e-9)
                d = ((x_i - x_j) ** 2 + (y_i - y_j) ** 2) ** 0.5
                if d <= _OUTLIER_MAX_SPEED_PER_S * dt:
                    has_coherent_neighbor = True
                    break
                j += 1
        if not has_coherent_neighbor:
            to_remove.add(i)
    return to_remove


def _find_mid_static_cluster(seq: list, min_run: int = 2,
                              max_diameter: float = 0.005,
                              min_jump: float = 0.1,
                              short_run_max: int = 2,
                              max_return_dist: float = 0.15) -> set:
    """Fix G : détecte un cluster STATIQUE en milieu de vie, encadré de jumps.

    Un joueur réel a toujours un peu de bruit sub-pixel dans la détection. Une
    séquence de >=2 frames à coords STRICTEMENT identiques (diamètre < 0.005)
    qui apparaît loin de la trajectoire pré-cluster (jump d'entrée > 0.1) ET
    repart loin (jump de sortie > 0.1) est forcément une fausse détection sur
    un élément d'UI fixe (icône, score, etc.) — pas un vrai joueur immobile.

    `min_run=2` : ce n'est PAS la longueur du run qui discrimine, c'est la
    conjonction (a) coords strictement identiques au pixel près (diamètre ~0)
    et (b) double saut > 0.1 de map (= > 1.0/s, soit 2× la vitesse plausible
    max) à l'entrée ET à la sortie. Un vrai joueur n'apparaît jamais en
    téléportant sur 2 frames figées puis en téléportant ailleurs ; quand il
    s'immobilise, ses voisins sont proches (pas de double saut). Mesuré sur un
    match complet, min_run=2 ne retire que des artefacts au BORD de la minimap
    (x≈0.05 / 0.96), zéro point en milieu de carte.

    GARDE-FOU runs courts (run_len <= `short_run_max`, soit 2 frames) :
    `min_jump` est une DISTANCE, pas une vitesse — donc après un trou de
    tracking un VRAI joueur peut légitimement avoir bougé > 0.1 entre deux
    détections espacées. Risque théorique de faux positif : joueur perdu →
    réapparaît figé 2 frames → reperdu → réapparaît AILLEURS (A→B→C). Pour ne
    retirer que le vrai artefact (téléport aller-retour A→B→A), on exige en plus,
    sur ces runs courts, que le point AVANT et le point APRÈS le cluster soient
    proches (< `max_return_dist`) : la trajectoire revient là d'où elle est
    partie. Un déplacement légitime à travers des trous progresse (A→B→C) et ne
    satisfait pas cette condition → il est préservé. Les runs longs
    (>= 3 frames) gardent l'ancien comportement (pas de check de retour) : leur
    longueur + diamètre nul suffit déjà à les disqualifier comme vrai joueur.

    Cas typiques observés :
      - 15 frames à exactly (0.9583, 0.6617) pendant 1.4s en milieu de vie
        blue/6, encadrées de transitions à 0.13 de map.
      - 2-3 frames à exactly (0.959, 0.483) en milieu de vie blue/9 (~1m22s),
        encadrées de sauts de 0.85 de map (le nb de frames brutes de la fausse
        détection varie 2↔3 d'un run à l'autre). Trop court pour les filtres de
        points isolés (les frames se cautionnent mutuellement) et son
        aller-retour est trop lent (> _OUTLIER_MAX_RUN_DURATION_S) pour
        `_find_aberrant_runs` → seul ce filtre statique le capte. before/after
        à 0.09 de map (retour à l'origine) → passe le garde-fou.
    """
    n = len(seq)
    if n < min_run + 2:
        return set()
    to_remove: set = set()
    i = 1  # commence à 1 pour avoir un point "avant" à comparer
    while i < n - min_run:
        # Étend un run de coords ~identiques à partir de seq[i]
        j = i + 1
        ref_x, ref_y = seq[i][1], seq[i][2]
        while j < n:
            dx = seq[j][1] - ref_x
            dy = seq[j][2] - ref_y
            if (dx * dx + dy * dy) > max_diameter * max_diameter:
                break
            j += 1
        run_len = j - i
        if run_len >= min_run and j < n:
            # Vérifie les jumps d'entrée et de sortie
            dx_in = seq[i][1] - seq[i - 1][1]
            dy_in = seq[i][2] - seq[i - 1][2]
            entry_jump = (dx_in * dx_in + dy_in * dy_in) ** 0.5
            dx_out = seq[j][1] - seq[j - 1][1]
            dy_out = seq[j][2] - seq[j - 1][2]
            exit_jump = (dx_out * dx_out + dy_out * dy_out) ** 0.5
            if entry_jump > min_jump and exit_jump > min_jump:
                # Garde-fou runs courts : sur un run de <= short_run_max frames,
                # n'efface que si la trajectoire REVIENT près de son point de
                # départ (avant ≈ après). Évite de virer un vrai joueur qui a
                # bougé > 0.1 à travers un trou de tracking (A→B→C, before/after
                # éloignés). Les runs longs sont déjà sûrs → pas de check.
                ok_to_remove = True
                if run_len <= short_run_max:
                    dx_ret = seq[i - 1][1] - seq[j][1]
                    dy_ret = seq[i - 1][2] - seq[j][2]
                    return_dist = (dx_ret * dx_ret + dy_ret * dy_ret) ** 0.5
                    if return_dist > max_return_dist:
                        ok_to_remove = False
                if ok_to_remove:
                    for k in range(i, j):
                        to_remove.add(k)
            i = j  # avance après le run quoi qu'il arrive
        else:
            i += 1
    return to_remove


def _point_near_any_spawn(x: float, y: float, spawn_polys: list, tol: float = 0.0) -> bool:
    """`spawn_polys`: liste de np.ndarray shape (N, 1, 2) en inner-fraction.
    Retourne True si (x, y) est à l'intérieur d'un des polygones ou à moins
    de `tol` de fraction-de-map de son bord.
    """
    for poly in spawn_polys:
        d = cv2.pointPolygonTest(poly, (float(x), float(y)), True)
        if d >= -tol:
            return True
    return False


def _find_leading_off_spawn(seq: list, spawn_polys: list,
                             max_lead_seconds: float = 5.0,
                             spawn_tol: float = 0.10) -> set:
    """Fix F : si la vie démarre LOIN du spawn et qu'on trouve un point AU spawn
    dans la première fenêtre de la vie, on supprime tous les points avant.

    Invariant physique : un joueur qui respawn APPARAÎT TOUJOURS au spawn. Donc,
    au début d'une vie, toute détection AVANT la première arrivée au spawn est
    nécessairement fausse (le joueur n'est pas encore sur la map). On scanne donc
    le début de la vie jusqu'à la 1ʳᵉ frame au spawn et on coupe tout l'amont.

    Couvre deux cas :
      - 1ers frames mal classés (autre cart en mouvement pris pour ce joueur)
        avant que le tracker "snap" sur la vraie position au spawn. Fix E ne
        s'applique pas si ce leading fait > 5 frames OU bouge (diamètre > 0.05).
      - Death lockout HP raté : `hp_timeline` peut manquer la fenêtre de mort
        d'un joueur autour d'un respawn (HP affiché vivant alors qu'il est mort),
        si bien que le lockout `_dead_at` ne rejette pas les détections fausses
        en tête de vie. Ex. orange/4 à ~2m41 : ~12 frames fausses à (0.29, 0.18)
        en plein milieu, le vrai spawn (0.02, 0.41) n'arrivant qu'à t+2.1s. Fix F
        étant indépendant de l'HP, il rattrape ce que le lockout a laissé passer.

    Borne TEMPORELLE plutôt que par index (`max_lead_seconds`, 5 s) : la séquence
    est sparse (détections seulement quand qqch est vu), donc un cap par index
    (ancien `max_check=10`) couvrait < 1 s de jeu et ratait un leading faux un peu
    long — c'est ce qui laissait passer le cas orange/4 (spawn à l'indice ~12).
    On scanne jusqu'au 1er spawn tant qu'on reste dans les 5 premières secondes
    de la vie. Au-delà sans spawn trouvé : vie qui démarre vraiment hors spawn
    (rare/exotique) → on ne touche à rien pour ne pas massacrer un cas légitime.

    `spawn_tol = 0.10` (~10 % de map) : tolérance autour du polygone. Élargie de
    0.05 → 0.10 car la 1ʳᵉ détection au spawn est parfois ratée et le joueur
    n'est ré-acquis qu'un peu plus loin (ex. orange/1 ~5m00 : faux départ à
    (0.76, 0.52), puis le joueur n'est détecté qu'à 0.073 du spawn — au-delà de
    0.05, donc Fix F abandonnait et le faux départ survivait). La tolérance ne
    sert qu'à reconnaître « assez près du spawn pour être le vrai départ » ; un
    vrai respawn matérialise toujours dans/au bord du polygone.
    """
    if not spawn_polys or len(seq) < 2:
        return set()
    # Si le 1er point est déjà au spawn, rien à corriger.
    if _point_near_any_spawn(seq[0][1], seq[0][2], spawn_polys, spawn_tol):
        return set()
    t0 = seq[0][0]
    # Cherche le 1er point AU spawn dans la fenêtre [t0, t0 + max_lead_seconds].
    for k in range(1, len(seq)):
        if seq[k][0] - t0 > max_lead_seconds:
            break  # hors fenêtre → cas légitime hors spawn, on ne touche pas
        if _point_near_any_spawn(seq[k][1], seq[k][2], spawn_polys, spawn_tol):
            return set(range(k))
    return set()


def _is_teleporter_jump(ax: float, ay: float, bx: float, by: float,
                        tp_pairs: list, radius: float = 0.12) -> bool:
    """True si le segment (a → b) relie deux extrémités APPARIÉES d'un téléporteur
    (a près de l'une, b près de l'autre, dans un sens ou l'autre). Sert à ne pas
    interpoler un trou qui est en fait un vrai TP (sinon on trace un trait entre
    l'entrée et la sortie du téléporteur)."""
    if not tp_pairs:
        return False
    r2 = radius * radius
    for (px, py), (qx, qy) in tp_pairs:
        if (((ax - px) ** 2 + (ay - py) ** 2 <= r2 and (bx - qx) ** 2 + (by - qy) ** 2 <= r2) or
                ((ax - qx) ** 2 + (ay - qy) ** 2 <= r2 and (bx - px) ** 2 + (by - py) ** 2 <= r2)):
            return True
    return False


def _collapse_tp_spans(history: list, tp_pairs: list,
                       radius: float = 0.12, max_window: float = 5.0) -> int:
    """Supprime les détections parasites APPARUES PENDANT un téléporteur.

    Pendant l'animation de TP le joueur est invisible : toute détection entre
    l'entrée (près d'une extrémité) et la sortie (près de l'extrémité APPARIÉE)
    est forcément fausse (autre marqueur, effet de TP…). Le tracker peut en
    accepter une (son gate s'élargit après un trou), ce qui casse le trou de TP
    en deux et empêche le step-fill. On scanne donc : pour chaque point i près
    d'une extrémité, on cherche en avant (≤ `max_window`) le 1er point j près de
    l'extrémité appariée, et on retire tout i+1..j-1. Modifie `history` en place,
    retourne le nb de points retirés.
    """
    if not tp_pairs or len(history) < 3:
        return 0
    n = len(history)
    keep = [True] * n
    removed = 0
    i = 0
    while i < n - 1:
        found = False
        j = i + 1
        while j < n and history[j][0] - history[i][0] <= max_window:
            if _is_teleporter_jump(history[i][1], history[i][2],
                                   history[j][1], history[j][2], tp_pairs, radius):
                # Garde-fou : ne collapser que si le joueur a VRAIMENT disparu
                # entre i et j (peu de points sur le span = TP, joueur invisible).
                # S'il est détecté en continu d'une extrémité à l'autre, c'est
                # une marche (rare, mais le TP existe justement pour l'éviter) →
                # on ne touche pas.
                span = history[j][0] - history[i][0]
                expected = span * _PLAYER_TRACK_FPS
                if (j - i) < 0.5 * expected:
                    for k in range(i + 1, j):
                        if keep[k]:
                            keep[k] = False
                            removed += 1
                    i = j
                    found = True
                break
            j += 1
        if not found:
            i += 1
    if removed:
        history[:] = [p for k, p in zip(keep, history) if k]
    return removed


def _interpolate_alive_gaps(history: list,
                             short_max_gap: float = 2.0,
                             long_max_gap: float = 10.0,
                             long_max_avg_speed: float = 0.05,
                             tp_pairs: list = None) -> int:
    """Injecte des points interpolés à 10 FPS pour combler les gaps de tracking
    dans une vie. Remplace l'interpolation historiquement faite côté front pour
    la centraliser ici (cohérence avec le split en vies déjà migré côté Python).

    Deux régimes :
      - gap ≤ `short_max_gap` (2s) : interpolation INCONDITIONNELLE. Au-dessus
        de l'ancien plafond front (1s) parce qu'on observe régulièrement des
        gaps 1-2s pendant un walking normal (0.06-0.10/s) que l'utilisateur
        attend visuellement comblés. Sur 2s à vitesse normale (~0.2/s), le
        bridge fait ~0.4 — la ligne droite reste une approximation visuelle
        acceptable (le joueur a effectivement traversé cette zone).
      - `short_max_gap` < gap ≤ `long_max_gap` (2-10s) : interpolation
        CONDITIONNELLE sur la VITESSE MOYENNE. Le joueur a été perdu par le
        blob detector / CNN pendant plusieurs secondes. Si bridge_distance / gap
        < `long_max_avg_speed` (5 %/s — soit quasi-immobile), on comble.
        Sinon il a bougé → on respecte le gap (pas de ligne artificielle à
        travers la map).

    On opère sur une seule vie (déjà splittée sur les morts de hp_timeline),
    donc le joueur est par construction alive pendant tout le seq — pas besoin
    de re-vérifier hp_timeline ici.

    Modifie `history` en place. Retourne nb de points injectés.
    """
    if len(history) < 2:
        return 0
    # Nettoie d'abord les faux points apparus pendant un TP (sinon ils cassent
    # le trou et empêchent le step-fill ci-dessous).
    _collapse_tp_spans(history, tp_pairs)
    min_gap = 1.0 / _PLAYER_TRACK_FPS  # 0.1s à 10 FPS — gap minimal à combler
    out = [history[0]]
    n_inserted = 0
    for i in range(1, len(history)):
        t_prev, x_prev, y_prev = history[i - 1]
        t_curr, x_curr, y_curr = history[i]
        gap = t_curr - t_prev
        is_tp = (min_gap < gap <= long_max_gap and
                 _is_teleporter_jump(x_prev, y_prev, x_curr, y_curr, tp_pairs))
        if is_tp:
            # Vrai téléporteur : le joueur disparaît pendant l'animation de TP.
            # On comble le trou en MARCHES (pas en trait diagonal) : 1ère moitié
            # du trou à l'entrée (TP1, dernière position connue), 2e moitié à la
            # sortie (TP2). Ex. trou de 2s → 1s figé au TP1 puis 1s au TP2.
            n_frames = max(int(round(gap * _PLAYER_TRACK_FPS)) - 1, 0)
            for k in range(1, n_frames + 1):
                frac = k / (n_frames + 1)
                t_interp = t_prev + gap * frac
                xi, yi = (x_prev, y_prev) if frac < 0.5 else (x_curr, y_curr)
                out.append((round(t_interp, 2), round(xi, 4), round(yi, 4)))
                n_inserted += 1
            out.append((t_curr, x_curr, y_curr))
            continue
        should_interp = False
        if min_gap < gap <= short_max_gap:
            should_interp = True
        elif short_max_gap < gap <= long_max_gap:
            bridge = ((x_curr - x_prev) ** 2 + (y_curr - y_prev) ** 2) ** 0.5
            avg_speed = bridge / gap
            if avg_speed < long_max_avg_speed:
                should_interp = True
        if should_interp:
            n_frames = max(int(round(gap * _PLAYER_TRACK_FPS)) - 1, 0)
            for k in range(1, n_frames + 1):
                frac = k / (n_frames + 1)
                t_interp = t_prev + gap * frac
                x_interp = x_prev + (x_curr - x_prev) * frac
                y_interp = y_prev + (y_curr - y_prev) * frac
                out.append((round(t_interp, 2),
                            round(x_interp, 4),
                            round(y_interp, 4)))
                n_inserted += 1
        out.append((t_curr, x_curr, y_curr))
    history[:] = out
    return n_inserted


def _filter_outliers(seq: list, spawn_polys: list = None) -> int:
    """Applique les passes Fix A/B/C/D/E/F/G sur une seq d'une vie.

      1. Passe par "runs" (`_find_aberrant_runs`) — clusters d'aberrations
         qui partent et reviennent (Fix A : cap dt) + traînes en fin de vie
         (Fix C : run en traîne tightly clustered) + sauts solo haute vitesse
         (Fix D : pas isolé > 0.35/s qui ne mène nulle part).
      2. Passe par "leading aberration" (`_find_leading_aberration`, Fix E) —
         miroir de Fix C en tête : cluster court et serré en début de vie
         disconnecté de la trajectoire principale qui suit.
      3. Passe par "leading off-spawn" (`_find_leading_off_spawn`, Fix F) —
         si le polygone spawn est fourni, vire les premières frames d'une vie
         qui n'atterrissent pas dans/près du spawn, jusqu'à atteindre une
         frame qui y est. Couvre le cas où le leading bouge (Fix E ne s'applique
         pas) mais est clairement hors zone de respawn.
      4. Passe par "mid-vie static cluster" (`_find_mid_static_cluster`, Fix G) —
         cluster de 2+ frames à coords exactement identiques au milieu de la
         vie, encadré de jumps. Forcément un misread sur un élément UI fixe.
      5. Passe par "line-fit" (`_find_line_fit_outliers`, Fix H) — point isolé
         hors de la ligne entre deux voisins proches.
      6. Passe par "short excursion" (`_find_short_excursion`, Fix I) — burst de
         fausses détections pendant un trou de tracking (taille quelconque, borné
         en temps), encadré par deux ancres proches (généralise Fix H).
      7. Passe par "voisin cohérent" (`_find_isolated_outliers`) — blinks
         isolés sans voisin cohérent, incluant premier et dernier point
         de la vie (Fix B).

    Modifie `seq` en place. Retourne nb retiré.
    """
    if len(seq) < 3:
        return 0
    n_removed = 0
    # Boucle Fix A/C/D jusqu'à stabilité : Fix C utilise `break` après le 1er
    # cluster trailing trouvé. Si une vie a PLUSIEURS clusters trailing (ex :
    # J2 vie 0 = (0.37,0.30) + (0.25,0.72) après mort), une seule passe ne
    # retire que le dernier. Re-passer attrape le suivant, et ainsi de suite.
    while True:
        to_remove = _find_aberrant_runs(seq)
        if not to_remove:
            break
        seq[:] = [e for k, e in enumerate(seq) if k not in to_remove]
        n_removed += len(to_remove)
    to_remove = _find_leading_aberration(seq)
    if to_remove:
        seq[:] = [e for k, e in enumerate(seq) if k not in to_remove]
        n_removed += len(to_remove)
    if spawn_polys:
        to_remove = _find_leading_off_spawn(seq, spawn_polys)
        if to_remove:
            seq[:] = [e for k, e in enumerate(seq) if k not in to_remove]
            n_removed += len(to_remove)
    to_remove = _find_mid_static_cluster(seq)
    if to_remove:
        seq[:] = [e for k, e in enumerate(seq) if k not in to_remove]
        n_removed += len(to_remove)
    to_remove = _find_line_fit_outliers(seq)
    if to_remove:
        seq[:] = [e for k, e in enumerate(seq) if k not in to_remove]
        n_removed += len(to_remove)
    to_remove = _find_short_excursion(seq)
    if to_remove:
        seq[:] = [e for k, e in enumerate(seq) if k not in to_remove]
        n_removed += len(to_remove)
    to_remove = _find_isolated_outliers(seq)
    if to_remove:
        seq[:] = [e for k, e in enumerate(seq) if k not in to_remove]
        n_removed += len(to_remove)
    return n_removed


def _remove_outlier_detections(histories: dict) -> int:
    """[backward-compat] Applique `_filter_outliers` à chaque seq d'un dict
    `{(team, num): [(t,x,y), ...]}`. Modifie en place. Retourne nb total retiré.

    NB : ne connaît pas le découpage en vies. Pour le filtrage sémantiquement
    correct (Fix C en fin de vie, pas en fin d'historique complet), passer par
    `_filter_outliers` directement après le split en vies.
    """
    return sum(_filter_outliers(seq) for seq in histories.values())


def _track_players_on_minimap(
    cap: cv2.VideoCapture,
    start_ts: float,
    end_ts: float,
    map_name: str,
    n_orange: int = 0,
    n_blue: int = 0,
    hp_timeline: Optional[dict] = None,
) -> list:
    """Détection per-frame des joueurs sur la minimap.

    Pipeline simple, sans smoothing temporel :
      1. Charge map_metadata (spawns + TPs + capture points)
      2. Localise la minimap sur une frame mid-chunk
      3. Sample les couleurs d'équipe depuis les polygones de spawn
      4. Loop 10 FPS : blob_detector → CNN classifier (min_conf=0.5)
      5. Agrège les détections par (team, number) → une history par joueur

    Pas de tracker, pas d'identification Layer 3 : on fait confiance au CNN
    pour identifier le digit à chaque frame, et chaque (team, number) reconnu
    devient un joueur indépendant. Sortie cohérente avec benchmark_tracking.py.

    Args:
        cap, start_ts, end_ts : VideoCapture et bornes du chunk en secondes vidéo.
        map_name              : nom canonique de la map.

    Returns:
        Tuple (tracks, minimap_position) :
          - tracks : liste de dicts sérialisables, un par (team, number) détecté :
              {team, id, slot, number, history: [[t, x_pct, y_pct], ...]}
            Vide si la map metadata est absente ou si la pipeline échoue.
          - minimap_position : [x1, y1, x2, y2] en fractions [0,1] du frame
            (WIDTH×HEIGHT), ou None si la localisation a échoué. Permet au
            front de positionner l'overlay minimap pile sur la zone détectée
            (le placement HUD varie d'une partie à l'autre même sur la même map).
    """
    md = _map_metadata.load(map_name)
    if md is None:
        _emit({'log': f'[player_tracking] no map_metadata for {map_name!r}, skipping'})
        return [], None

    classifier = _get_digit_classifier()
    if classifier is None:
        _emit({'log': '[player_tracking] no classifier available, skipping'})
        return [], None

    valid_numbers = _valid_numbers_from_roster(n_orange, n_blue) if (n_orange or n_blue) else None
    if valid_numbers:
        _emit({'log': f'[player_tracking] valid numbers: '
                      f'orange={sorted(valid_numbers["orange"])} '
                      f'blue={sorted(valid_numbers["blue"])}'})

    # 1+2. Localisation minimap + couleurs d'équipe, avec retry sur des seeds
    # multiples. Une seed peut échouer pour 3 raisons :
    #   (a) find_minimap_box ne trouve aucun match (filets de sécurité)
    #   (b) la box trouvée est valide mais les spawns ne contiennent pas
    #       assez de pixels saturés → couleurs None
    #   (c) la frame n'est pas lisible (scène coupée)
    # On essaie d'abord le milieu du chunk, puis on s'écarte par paliers.
    tpl_w, tpl_h = md['size']
    info = None
    orange_rgb = blue_rgb = None
    seed_bgr = None
    mid = (start_ts + end_ts) / 2.0
    span = end_ts - start_ts
    offsets = (0.0, -30.0, 30.0, -60.0, 60.0, -120.0, 120.0,
               -span * 0.25, span * 0.25, -span * 0.40, span * 0.40)
    tried = []
    for offset in offsets:
        seed_ts = mid + offset
        if seed_ts < start_ts or seed_ts > end_ts:
            continue
        rgb = _get_frame(cap, seed_ts)
        if rgb is None:
            continue
        bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        candidate = _minimap.find_minimap_box(bgr, map_name,  .0)
        if candidate is None:
            tried.append((seed_ts, 'no_box'))
            continue
        (cx1, cy1), (cx2, cy2) = candidate['box']
        # Clamp aux bornes de la frame : numpy traite les index negatifs
        # comme "depuis la fin", donc bgr[..., -2:461] est vide → crash.
        h, w = bgr.shape[:2]
        cx1c, cy1c = max(0, cx1), max(0, cy1)
        cx2c, cy2c = min(w, cx2), min(h, cy2)
        csx = float(candidate.get('scale_x', candidate.get('scale', 1.0))) or 1.0
        csy = float(candidate.get('scale_y', candidate.get('scale', 1.0))) or 1.0
        o, b = _sample_team_colors_from_spawns(
            bgr[cy1c:cy2c, cx1c:cx2c], md, csx, scale_y=csy)
        if o is None or b is None:
            tried.append((seed_ts, f'colors=({o},{b})'))
            continue
        info, orange_rgb, blue_rgb, seed_bgr = candidate, o, b, bgr
        break
    if info is None:
        _emit({'log': f'[player_tracking] minimap+colors unresolved after '
                      f'{len(tried)} seeds, skipping'})
        return [], None
    (x1, y1), (x2, y2) = info['box']
    sx = float(info.get('scale_x', info.get('scale', 1.0))) or 1.0
    sy = float(info.get('scale_y', info.get('scale', 1.0))) or 1.0
    # `info['box']` couvre le template COMPLET, marges transparentes incluses
    # (utile au tracker pour capter les joueurs qui débordent au bord). Pour le
    # front on veut la zone INNER visible : inset des marges × scale. Sans
    # marges déclarées, inset = 0 → fallback sur la box brute.
    _m = md.get('margins') or {}
    inner_x1 = x1 + float(_m.get('left',   0)) * sx
    inner_y1 = y1 + float(_m.get('top',    0)) * sy
    inner_x2 = x2 - float(_m.get('right',  0)) * sx
    inner_y2 = y2 - float(_m.get('bottom', 0)) * sy
    minimap_position = [inner_x1 / WIDTH, inner_y1 / HEIGHT,
                        inner_x2 / WIDTH, inner_y2 / HEIGHT]
    _emit({'log': f'[player_tracking] box=({x1},{y1})-({x2},{y2}) '
                  f'score={info["score"]:.2f} sx={sx:.3f} sy={sy:.3f}'})
    _emit({'log': f'[player_tracking] colors: orange={orange_rgb} '
                  f'blue={blue_rgb}'})

    # Marges transparentes du template (px). Si présentes, on normalise les
    # positions dans la zone INNER (jouable) plutôt que dans le template
    # entier — élimine le décalage quand un joueur s'approche du bord et
    # déborde dans la marge transparente.
    margins = md.get('margins')

    # Polygones spawn (par équipe) en coords inner-fraction — alimentent Fix F
    # dans `_filter_outliers` pour virer le leading hors-spawn.
    spawn_polys_per_team: dict = {'orange': [], 'blue': []}
    for team_name in ('orange', 'blue'):
        for sp in md.get('spawns', {}).get(team_name, []):
            inner_pts = [
                _template_px_to_inner_frac(p[0], p[1], tpl_w, tpl_h, margins)
                for p in sp.get('polygon', [])
            ]
            if len(inner_pts) >= 3:
                arr = np.array(inner_pts, dtype=np.float32).reshape(-1, 1, 2)
                spawn_polys_per_team[team_name].append(arr)

    # Paires de téléporteurs en coords inner-fraction — un saut entre deux
    # extrémités appariées est un déplacement LÉGITIME que le gate du tracker
    # doit autoriser (sinon un vrai TP serait rejeté comme aberration).
    tp_pairs: list = []
    _tp_by_id = {tp['id']: tp for tp in md.get('teleporters', [])}
    _tp_seen: set = set()
    for tp in md.get('teleporters', []):
        a = tp.get('id'); b = tp.get('paired_with')
        if not b or b not in _tp_by_id or (b, a) in _tp_seen:
            continue
        _tp_seen.add((a, b))
        pa = _template_px_to_inner_frac(tp['position'][0], tp['position'][1], tpl_w, tpl_h, margins)
        pb = _template_px_to_inner_frac(_tp_by_id[b]['position'][0], _tp_by_id[b]['position'][1], tpl_w, tpl_h, margins)
        tp_pairs.append((pa, pb))

    # Masque de traversabilité (optionnel, par map) : une détection en plein mur
    # est physiquement impossible → rejetée avant le tracker.
    walkable_mask = _load_walkable_mask(map_name)
    if walkable_mask is not None:
        _emit({'log': '[player_tracking] walkable mask actif'})

    # Précompute le lookup des joueurs morts par instant (forward-filled).
    # Si fourni, on rejette toute détection (team, num) pour un joueur HP=0
    # à ce ts — c'est forcément du bruit (le joueur n'est pas affiché).
    dead_lookup = _build_dead_lookup(hp_timeline, n_orange, n_blue)
    if dead_lookup is not None:
        _emit({'log': f'[player_tracking] hp_timeline avec '
                      f'{len(dead_lookup[0])} entries → filtre morts actif'})

    # 3. Loop 10 FPS : detect + classify, agrège par (team, number).
    # Lecture séquentielle quand FPS connu : 1 seul seek au début, puis read()
    # pour la frame samplée + grab() pour skip les intermédiaires (cheap : pas
    # de BGR convert). Évite N×6000 seeks coûteux sur Windows où chaque
    # cap.set(POS_MSEC) reseek-to-keyframe + decode-forward (~50-200 ms).
    # Fallback sur l'ancien comportement seek-per-frame si FPS indisponible.
    histories: dict = {}  # (team, number) → [(t_rel, x_frac, y_frac), ...]
    tracks: dict = {}     # (team, number) → {'x','y','t','pend'} état du tracker
    total = int((end_ts - start_ts) * _PLAYER_TRACK_FPS) + 1
    native_fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
    use_sequential = native_fps > 0
    if use_sequential:
        skip = max(1, int(round(native_fps / _PLAYER_TRACK_FPS)))
        cap.set(cv2.CAP_PROP_POS_MSEC, start_ts * 1000)
        _emit({'log': f'[player_tracking] sequential read: native_fps={native_fps:.2f} '
                      f'skip={skip} (effective={native_fps / skip:.2f} FPS)'})
    else:
        skip = 1
        _emit({'log': f'[player_tracking] seek-per-frame fallback (FPS unknown)'})

    last_pct = -1
    detections_total = 0
    detections_rejected_dead = 0
    detections_rejected_wall = 0
    processed = 0
    frame_idx = 0
    step = 1.0 / _PLAYER_TRACK_FPS

    while True:
        if use_sequential:
            ret, frame = cap.read()
            if not ret:
                break
            ts = start_ts + frame_idx / native_fps
            frame_idx += 1
        else:
            if processed >= total:
                break
            ts = start_ts + processed * step
            cap.set(cv2.CAP_PROP_POS_MSEC, ts * 1000)
            ret, frame = cap.read()
            if not ret:
                processed += 1
                continue

        if ts > end_ts:
            break

        blobs_raw = _blob_detector.detect_blobs(frame, info, orange_rgb, blue_rgb)
        # dedup=False : on récupère TOUS les candidats par (team, number) — le
        # tracker ci-dessous départage les doublons par cohérence de trajectoire
        # (et non par confidence, qui sature souvent à 1.00 sur le vrai ET le faux).
        filtered = classifier.filter_blobs(frame, info, blobs_raw, min_conf=0.5, map_meta=md,
                                            valid_numbers=valid_numbers, dedup=False)
        t_rel = ts - start_ts
        dead_set = _dead_at(dead_lookup, t_rel)

        # Regroupe les candidats de la frame par (team, number), en inner-frac.
        cands_by_key: dict = {}
        for team in ('orange', 'blue'):
            for b in filtered[team]:
                num = int(b['digit'])
                if (team, num) in dead_set:
                    detections_rejected_dead += 1
                    continue
                xf, yf = _template_px_to_inner_frac(float(b['x']), float(b['y']),
                                                    tpl_w, tpl_h, margins)
                if not _is_walkable(walkable_mask, xf, yf):
                    detections_rejected_wall += 1
                    continue  # détection en plein mur → impossible
                cands_by_key.setdefault((team, num), []).append((float(b['conf']), xf, yf))

        for key, cands in cands_by_key.items():
            chosen = _track_select(tracks.get(key), cands, t_rel, tp_pairs)
            if chosen is None:
                continue  # coasting : aucune détection acceptée cette frame
            _c, cx, cy = chosen
            tracks[key] = {'x': cx, 'y': cy, 't': t_rel, 'pend': None}
            histories.setdefault(key, []).append(
                (round(t_rel, 2), round(cx, 4), round(cy, 4)))
            detections_total += 1

        processed += 1

        # Skip les frames intermédiaires via grab() : décode mais saute la
        # conversion BGR→numpy (gain ~5-10 ms par frame skipée sur 1920×1080).
        if use_sequential and skip > 1:
            for _ in range(skip - 1):
                if cap.grab():
                    frame_idx += 1
                else:
                    break

        pct = int(100 * processed / total) if total > 0 else 0
        if pct != last_pct and pct % 10 == 0:
            _emit({'log': f'[player_tracking] {pct}% '
                          f'({processed}/{total} frames, {detections_total} dets)'})
            last_pct = pct

    # 4. Découpage en vies sur les transitions HP>0 → HP=0 de hp_timeline.
    # Le front consomme `lives` directement (plus de calcul des death times en
    # TS, plus de duplication de la convention EVA slot↔HP-column).
    deaths_per_player = _compute_death_times(hp_timeline or {}, n_orange, n_blue)

    # 5. Filtre des détections aberrantes PAR VIE. Découpée d'abord (étape 4)
    # parce que la passe par "runs" a besoin de connaître les bornes de la vie
    # (Fix C détecte les clusters en TRAÎNE — il faut que la fin du seq
    # corresponde à la fin d'une vie, pas au milieu du playthrough complet du
    # joueur). Après filtrage, on supprime les vies vidées.
    n_outliers = 0
    n_interpolated = 0
    cleaned_lives_per_player: dict = {}
    for key, hist in histories.items():
        team_name = key[0]
        spawn_polys = spawn_polys_per_team.get(team_name, [])
        deaths = deaths_per_player.get(key, [])
        lives = _split_history_into_lives(hist, deaths)
        for life in lives:
            n_outliers += _filter_outliers(life['history'], spawn_polys=spawn_polys)
            n_interpolated += _interpolate_alive_gaps(life['history'], tp_pairs=tp_pairs)
        cleaned_lives_per_player[key] = [l for l in lives if l['history']]
    if n_outliers or n_interpolated:
        _emit({'log': f'[player_tracking] retire {n_outliers} detections aberrantes, '
                      f'injecte {n_interpolated} points interpolés'})

    # 6. Format payload. id séquentiel ; slot 10 si number = 0 (Blue 5v5).
    out = []
    for next_id, (team, num) in enumerate(sorted(histories.keys())):
        slot = 10 if num == 0 else num
        out.append({
            'team':   team,
            'id':     next_id,
            'slot':   slot,
            'number': num,
            'lives':  cleaned_lives_per_player[(team, num)],
        })
    _emit({'log': f'[player_tracking] done: {len(out)} (team, number) tracks, '
                  f'{detections_total} total detections, '
                  f'{detections_rejected_dead} rejetees (joueur mort)'})
    return out, minimap_position


# Score à partir duquel on considère la localisation suffisamment fiable
# pour ne pas tester d'autres frames. La minimap étant statique pendant
# toute la partie, on peut sonder plusieurs frames jusqu'à dépasser ce seuil.
_MINIMAP_GOOD_SCORE = 0.55
# Probes additionnels (offsets en secondes autour de la frame courante)
# si la 1re tentative est faible. On reste dans la partie en cours (l'analyse
# est backward, donc des décalages négatifs nous gardent côté gameplay).
_MINIMAP_PROBE_OFFSETS = (-15.0, -45.0, -90.0, -180.0, 15.0, 45.0)


def _locate_minimap(cap, current_timestamp: float, map_name: str, frame_rgb):
    """Localise la minimap pour la partie courante.

    Stratégie : on tente d'abord la frame fournie. Si le score dépasse
    _MINIMAP_GOOD_SCORE on s'arrête. Sinon on sonde quelques frames
    voisines et on garde la meilleure (la minimap ne bouge pas, seule
    sa lisibilité change selon la scène derrière).
    """
    if not map_name:
        return None
    best = _minimap.find_minimap_box(
        cv2.cvtColor(frame_rgb, cv2.COLOR_RGB2BGR),
        map_name, min_score=0.0,
    )
    if best is not None and best['score'] >= _MINIMAP_GOOD_SCORE:
        return best
    for off in _MINIMAP_PROBE_OFFSETS:
        probe = _get_frame(cap, current_timestamp + off)
        if probe is None:
            continue
        res = _minimap.find_minimap_box(
            cv2.cvtColor(probe, cv2.COLOR_RGB2BGR),
            map_name, min_score=0.0,
        )
        if res is None:
            continue
        if best is None or res['score'] > best['score']:
            best = res
        if best['score'] >= _MINIMAP_GOOD_SCORE:
            break
    return best


# ---------------------------------------------------------------------------
# Game dict factory
# ---------------------------------------------------------------------------

def _new_game(mode: int) -> dict:
    """
    Crée et retourne un dict représentant un nouveau jeu en cours de détection.
    __jumped__ : flag interne indiquant que le saut de timer a déjà été effectué pour ce jeu.
    """
    return {
        'mode': mode,
        'start': -1,
        'end': -1,
        'map': '',
        'mapImage': None,
        'minimap': None,  # {'box': ((x1,y1),(x2,y2)), 'score': float, 'scale': float}
        'points': None,  # list of {x,y,w,h,score} — détecté à la 1ère frame de gameplay
        '__jumped__': False,
        'orangeTeam': {
            'score': 0,
            'scoreImage': None,
        },
        'blueTeam': {
            'score': 0,
            'scoreImage': None,
        },
    }


def _set_score(game: dict, team: str, raw: str) -> None:
    """Affecte le score OCR raw au dict team de game si la valeur est un entier valide (0–100)."""
    try:
        V = int(raw)
        if 0 <= V <= 100:
            if DEBUG:
                _emit({'log': team + ' score : ' + raw})
            game[team]['score'] = V
    except Exception:
        pass


def _refine_game_start_with_timer(cap, base_ts: float, timer_box,
                                  hud_anchor=None, max_search: int = 55) -> float:
    """
    Affine `game.start` en avançant seconde par seconde depuis `base_ts` et
    en lisant le timer in-game jusqu'à voir un décrément (M:S avec S > 0).
    Le start est alors back-computé : start = T - (60 - S) - 1, soit 2 secondes
    avant le premier tick du timer (M+1):00 → (M+1):59. Détail du -1 :
      - T - (60 - S)  = instant du dernier tick visible (timer (M+1):S)
      - + 1           = instant du tick (M+1):00 → (M+1):59 (= début gameplay)
      - - 2           = buffer de 2s pour capter le handshake / fin de loading
      → net : -1.
    La minute de départ est inconnue (10 par défaut, mais l'admin peut la
    régler de 4 à 13+) — on ne s'en sert pas, seul S compte. Tant qu'on voit
    M:00 (timer figé en attente du go) ou des lectures invalides, on continue.
    `new_start` est clampé à `base_ts` : une back-compute antérieure au start
    initial serait nécessairement un OCR erroné (le loading screen borne le
    début par le bas).
    """
    _emit({'log': f'[refine_start] START scan from base_ts={base_ts:.1f}s (max_search={max_search}s)'})
    for OFFSET in range(0, max_search + 1):
        TS = base_ts + OFFSET
        FRAME = _get_frame(cap, TS)
        if FRAME is None:
            _emit({'log': f'[refine_start] ts={TS:.1f}s offset=+{OFFSET}s → no frame (skip)'})
            continue
        DYN_BOX = _find_timer_box(FRAME, anchor=hud_anchor)
        TB = DYN_BOX if DYN_BOX is not None else timer_box
        BOX_KIND = 'dyn' if DYN_BOX is not None else 'static'
        TIMER_TEXT = _ocr_region(
            FRAME,
            TB[0][0], TB[0][1], TB[1][0], TB[1][1],
            psm=7, extra_psms=[8], whitelist='0123456789:',
            luminance=100, apply_filter=True, lang='evadigits',
        )
        MS = _parse_timer_text(TIMER_TEXT)
        if MS is None:
            _emit({'log': f'[refine_start] ts={TS:.1f}s offset=+{OFFSET}s box={BOX_KIND} ocr={TIMER_TEXT!r} → unparseable (skip)'})
            continue
        M, S = MS
        if S == 0:
            _emit({'log': f'[refine_start] ts={TS:.1f}s offset=+{OFFSET}s box={BOX_KIND} ocr={TIMER_TEXT!r} parsed={M}:{S:02d} → S=0, timer figé ou pile minute (skip)'})
            continue
        BACK = TS - (60 - S) - 1
        REFINED = max(base_ts, BACK)
        CLAMPED = ' [CLAMPED to base_ts]' if BACK < base_ts else ''
        _emit({'log': f'[refine_start] ts={TS:.1f}s offset=+{OFFSET}s box={BOX_KIND} ocr={TIMER_TEXT!r} parsed={M}:{S:02d} → back-compute={BACK:.1f}s (1st tick - 2s) → start={REFINED:.1f}s (from base_ts={base_ts:.1f}s){CLAMPED}'})
        return REFINED
    _emit({'log': f'[refine_start] DONE no decrement found within {max_search}s of {base_ts:.1f}s, keeping {base_ts:.1f}s'})
    return base_ts


# ---------------------------------------------------------------------------
# Backward analysis — mirrors videoTimeUpdate() from the TypeScript component
# ---------------------------------------------------------------------------

def _analyze(
    video_path: str,
    ffmpeg_path: str,
    max_time_per_game: int = 10,
) -> None:
    """
    Analyse la vidéo en sens inverse (de la fin vers le début) pour détecter les jeux.
    Miroir exact de videoTimeUpdate() dans replay_cutter.component.ts.

    Algorithme :
      - Démarre à TIMESTAMP = durée totale, recule de 1 s à chaque itération.
      - Score frame  → crée CURRENT avec end = TIMESTAMP, OCR scores.
      - End frame    → idem (écran post-match alternatif).
      - Loading/Intro → ferme CURRENT avec start = TIMESTAMP + 2.
      - Playing frame → OCR map ; une fois map collectée,
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
    # Position de la barre HUD haute (template `playing_top.png`). Trouvée à la
    # 1ère playing frame du run et réutilisée pour toutes les frames suivantes :
    # le HUD ne bouge pas dans une vidéo donnée même si plusieurs games s'y
    # succèdent. Évite ~32 ms × N frames de matchTemplate redondant.
    HUD_ANCHOR: tuple = None

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
            SCORE_MODE, SF_VARIANT, SF_DX, SF_DY = _detect_game_score_frame(FRAME)
            if SCORE_MODE >= 0:
                if DEBUG:
                    _emit({'log': f'Score frame found mode={SCORE_MODE} variant={SF_VARIANT} (HUD offset dx={SF_DX:+.1f}, dy={SF_DY:+.1f})'})
                FOUND = True
                JUST_JUMPED = False
                GAME = _new_game(SCORE_MODE)
                GAME['end'] = TIMESTAMP - 1
                _SF_RAW = MODES[SCORE_MODE]['scoreFrame'][SF_VARIANT]
                # Scores : bbox dynamique trouvé via les chiffres colorés,
                # translaté de l'offset HUD identifié.
                OS = _resolve_region(_SF_RAW['orangeScore'], FRAME, SF_DX, SF_DY)
                BS = _resolve_region(_SF_RAW['blueScore'],   FRAME, SF_DX, SF_DY)
                for label, box in (('orange score', OS), ('blue score', BS)):
                    if box is not None:
                        if DEBUG:
                            _emit({'log': f'{label} border: {box}'})
                    else:
                        if DEBUG:
                            _emit({'log': f'[border] {label} not found in search region'})

                if OS is not None:
                    _set_score(GAME, 'orangeTeam', _ocr_region(
                        FRAME,
                        OS[0][0], OS[0][1], OS[1][0], OS[1][1],
                        psm=7, extra_psms=[8], whitelist='0123456789%', luminance=100, apply_filter=True, lang='evadigits',
                        checker=_score_checker,
                    ))

                if BS is not None:
                    _set_score(GAME, 'blueTeam', _ocr_region(
                        FRAME,
                        BS[0][0], BS[0][1], BS[1][0], BS[1][1],
                        psm=7, extra_psms=[8], whitelist='0123456789%', luminance=100, apply_filter=True, lang='evadigits',
                        checker=_score_checker,
                    ))

                if OS is not None:
                    GAME['orangeTeam']['scoreImage'] = _region_to_base64(FRAME, OS[0][0], OS[0][1], OS[1][0], OS[1][1])
                if BS is not None:
                    GAME['blueTeam']['scoreImage']   = _region_to_base64(FRAME, BS[0][0], BS[0][1], BS[1][0], BS[1][1])

                GAMES.insert(0, GAME)
                CURRENT = GAME

        # ── End frame ──────────────────────────────────────────────────────
        if not FOUND and (CURRENT is None or CURRENT['start'] != -1):
            if _detect_game_end_frame(FRAME):
                if DEBUG:
                    _emit({'log': 'End frame found'})
                FOUND = True
                JUST_JUMPED = False
                GAME = _new_game(1)
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
            if _detect_game_loading_frame(FRAME):
                if DEBUG:
                    _emit({'log': 'Loading frame found'})
                FOUND = True
                JUST_JUMPED = False
                # Scan forward to find the first actual gameplay frame.
                PROBE = TIMESTAMP + 1
                GAME_START = TIMESTAMP
                FIRST_PLAYING_FRAME = None
                while PROBE <= TIMESTAMP + 30:
                    PROBE_FRAME = _get_frame(CAP, PROBE)
                    if PROBE_FRAME is not None and _detect_game_playing(PROBE_FRAME):
                        GAME_START = PROBE
                        FIRST_PLAYING_FRAME = PROBE_FRAME
                        break
                    if DEBUG:
                        _emit({'log': 's'})
                    PROBE += 0.5
                GAME_START = _refine_game_start_with_timer(
                    CAP, GAME_START,
                    MODES[CURRENT['mode']]['gameFrame']['timer'],
                    hud_anchor=HUD_ANCHOR,
                )
                CURRENT['start'] = GAME_START
                if FIRST_PLAYING_FRAME is not None:
                    CURRENT['points'] = _detect_capture_points(FIRST_PLAYING_FRAME, anchor=HUD_ANCHOR)
                    if DEBUG:
                        _emit({'log': f'Capture points detected: {len(CURRENT["points"])}'})
                if DEBUG:
                    _emit({'log': f'First game frame detected at {GAME_START:.1f}s'})
                _emit({'type': 'game', 'game': CURRENT})
                CURRENT = None   # game complete

        # ── Game start: map introduction ────────────────────────────────────
        if not FOUND and CURRENT is not None and CURRENT['start'] == -1:
            if _detect_game_intro(FRAME):
                if DEBUG:
                    _emit({'log': 'Game intro frame found'})
                FOUND = True
                JUST_JUMPED = False
                # Scan forward to find the first actual gameplay frame.
                PROBE = TIMESTAMP + 1
                GAME_START = TIMESTAMP
                FIRST_PLAYING_FRAME = None
                while PROBE <= TIMESTAMP + 30:
                    PROBE_FRAME = _get_frame(CAP, PROBE)
                    if PROBE_FRAME is not None and _detect_game_playing(PROBE_FRAME):
                        GAME_START = PROBE
                        FIRST_PLAYING_FRAME = PROBE_FRAME
                        break
                    PROBE += 0.5
                GAME_START = _refine_game_start_with_timer(
                    CAP, GAME_START,
                    MODES[CURRENT['mode']]['gameFrame']['timer'],
                    hud_anchor=HUD_ANCHOR,
                )
                CURRENT['start'] = GAME_START
                if FIRST_PLAYING_FRAME is not None:
                    CURRENT['points'] = _detect_capture_points(FIRST_PLAYING_FRAME, anchor=HUD_ANCHOR)
                    if DEBUG:
                        _emit({'log': f'Capture points detected: {len(CURRENT["points"])}'})
                if DEBUG:
                    _emit({'log': f'First game frame detected at {GAME_START:.1f}s'})
                _emit({'type': 'game', 'game': CURRENT})
                CURRENT = None

        # ── Playing frame: OCR map / team names + timer jump ────────────────
        if not FOUND and CURRENT is not None and CURRENT['start'] == -1:
            if _detect_game_playing(FRAME):
                FOUND = True
                if DEBUG:
                    _emit({'log': 'Playing frame found'})

                GF        = MODES[CURRENT['mode']]['gameFrame']
                TIMER_BOX = GF['timer']

                # Ancre HUD : une seule recherche par game, mise en cache.
                # On ne cherche PAS sur la FRAME courante (qui peut être une
                # transition VICTOIRE → match accidentel sur un mauvais
                # emplacement). On part de game.end - 30 s (~30 s avant la
                # fin de game = sûrement en gameplay) et on recule.
                if HUD_ANCHOR is None:
                    HUD_ANCHOR = _find_hud_anchor_safely(CAP, CURRENT['end'] - 30)

                if not CURRENT['map'] and HUD_ANCHOR is not None:
                    # Box du nom de map dérivée de la barre HUD (anchor sûr).
                    MB = _find_map_box(FRAME, anchor=HUD_ANCHOR)
                    T = _ocr_color_masked(
                        FRAME,
                        MB[0][0], MB[0][1], MB[1][0], MB[1][1],
                        target_color=(255, 255, 255),
                        whitelist='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz ',
                        tol_color=35,
                    )
                    if T:
                        MAP_NAME = _get_map_by_name(T)
                        if MAP_NAME:
                            if DEBUG:
                                _emit({'log': 'map name : ' + MAP_NAME})
                            CURRENT['map'] = MAP_NAME
                            CURRENT['mapImage'] = _region_to_base64(
                                FRAME,
                                MB[0][0], MB[0][1], MB[1][0], MB[1][1],
                            )
                            CURRENT['minimap'] = _locate_minimap(
                                CAP, TIMESTAMP, MAP_NAME, FRAME,
                            )
                            if DEBUG and CURRENT['minimap']:
                                MM = CURRENT['minimap']
                                _emit({'log': f'Minimap located: box={MM["box"]} '
                                               f'score={MM["score"]:.2f} scale={MM["scale"]:.2f}'})
                        else:
                            _emit({"Can't find map name": T})

                # Timer jump — mirrors the TS optimization exactly.
                # When the map is collected, read the game timer and
                # jump backward to just before the game start to find loading/intro
                # faster, skipping the bulk of the gameplay footage.
                if (CURRENT['map']
                        and not CURRENT['__jumped__']
                        and not JUST_JUMPED):
                    DYN_TIMER = _find_timer_box(FRAME, anchor=HUD_ANCHOR)
                    TB = DYN_TIMER if DYN_TIMER is not None else TIMER_BOX
                    TIMER = _ocr_region(
                        FRAME,
                        TB[0][0], TB[0][1], TB[1][0], TB[1][1],
                        psm=7, extra_psms=[8], whitelist='0123456789:',
                        luminance=100, apply_filter=True, lang='evadigits',
                    )
                    if TIMER:
                        if DEBUG:
                            _emit({'log': 'timer : ' + TIMER})
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
                                if DEBUG:
                                    _emit({'log': f'timer parsed m={M} s={S} valid={VALID} max_time_per_game={max_time_per_game}'})
                                if VALID:
                                    SECURITY = 20
                                    DIFF = (max_time_per_game - M) * 60 - S - SECURITY
                                    if DIFF > 0:
                                        if DEBUG:
                                            _emit({'log': "Try to jump " + str(DIFF)})
                                        CURRENT['__jumped__'] = True
                                        JUST_JUMPED = True
                                        TIMESTAMP -= DIFF
                                        continue   # skip TIMESTAMP -= STEP
                            except Exception as e:
                                print(e)
                                pass
        if not FOUND:
            if DEBUG:
                _emit({'log': "Can't identify frame"})

        # STEP=1 quand on cherche le début d'un game (CURRENT en attente de start)
        # ou juste après un timer jump : on ne peut pas se permettre de rater une
        # fenêtre de loading/intro étroite (~1-2 s). STEP=2 ailleurs (post-game,
        # entre 2 games sans CURRENT) pour diviser par 2 les seeks inutiles.
        SEARCHING_START = CURRENT is not None and CURRENT['start'] == -1
        STEP = 1.0 if (JUST_JUMPED or SEARCHING_START) else 2.0
        TIMESTAMP -= STEP

    # Fallback : pas de loading/intro screen détecté (vidéo déjà pré-coupée
    # par exemple). Le start "brut" devient 0, mais on tente quand même
    # d'affiner via le timer in-game à partir de t=0. CAP encore ouvert ici.
    if CURRENT is not None and CURRENT['start'] == -1:
        REFINED_START = _refine_game_start_with_timer(
            CAP, 0.0,
            MODES[CURRENT['mode']]['gameFrame']['timer'],
            hud_anchor=HUD_ANCHOR,
        )
        CURRENT['start'] = REFINED_START
        _emit({'type': 'game', 'game': CURRENT})

    CAP.release()

    _emit({'type': 'done'})

#region Chunk analysis — phase 2 : score timeline indexée par le timer in-game

def _parse_timer_text(timer_text: str):
    """
    Parse une chaîne timer ('MM:SS' ou 'MMSS' si Tesseract loupe le ':')
    et retourne le tuple (M, S), ou None si non parsable / hors bornes.

    Bornes : M ∈ [0, 99], S ∈ [0, 59]. Sans cette validation, un OCR bruité
    type "0969" (au lieu de "0959") produit S=69, ce qui mène à des back-compute
    aberrants (ex. start dans le futur) dans `_refine_game_start_with_timer`.

    Accepte aussi 5 chiffres sans colon ("10000" = "10:00" où le ":" a été
    interprété comme un "0" supplémentaire) : 2 premiers = M, 2 derniers = S.
    """
    if not timer_text:
        return None
    PARTS = None
    if len(timer_text) == 5 and ':' in timer_text:
        PARTS = timer_text.split(':')
    elif len(timer_text) == 4 and timer_text.isdigit():
        PARTS = [timer_text[:2], timer_text[2:]]
    elif len(timer_text) == 5 and timer_text.isdigit():
        PARTS = [timer_text[:2], timer_text[3:]]
    if not PARTS or len(PARTS) != 2:
        return None
    try:
        M, S = int(PARTS[0]), int(PARTS[1])
    except Exception:
        return None
    if not (0 <= M <= 99 and 0 <= S <= 59):
        return None
    return (M, S)


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
    if DEBUG:
        _emit({'log': f'[_analyze_chunks] {settings}'})

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
    if DEBUG:
        _emit({'log': f'[_analyze_chunks] cpu={CPU} window={WINDOW} workers={MAX_WORKERS}'})

    # Templates pour identifier l'arme et le headshot icon dans chaque kill row.
    # Chargés une seule fois en début de run. Le dossier `templates/` est résolu
    # depuis le PYINSTALLER bundle (sys._MEIPASS) ou le répertoire du script.
    TEMPLATE_BASE = getattr(sys, '_MEIPASS', os.path.dirname(os.path.abspath(__file__)))
    TEMPLATE_DIR = os.path.join(TEMPLATE_BASE, 'templates')
    WEAPON_TEMPLATES = _load_weapon_templates(TEMPLATE_DIR)
    HEADSHOT_TEMPLATE = _load_headshot_template(TEMPLATE_DIR)
    if DEBUG:
        _emit({'log': f'[_analyze_chunks] loaded {len(WEAPON_TEMPLATES)} weapon templates, headshot={HEADSHOT_TEMPLATE is not None}'})

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
        # Map name : sert à choisir entre règle Domination (lissage anti-bruit
        # une fois owned) et Hardpoint (toléré, le point se vide naturellement).
        # Outlaw = Hardpoint, le reste = Domination.
        MAP_NAME = CHUNK.get('map', '')
        IS_HARDPOINT = MAP_NAME in _HARDPOINT_MAPS

        # Rosters trustés issus de l'API /games/identify (appelée AVANT phase 2
        # par le client). Format : [{name, K, D}, ...]. Sera utilisé à l'étape 4
        # comme référence pour le fuzzy match des pseudos OCR du killfeed. Si
        # la game n'a pas matché côté back, listes vides → fallback OCR-only.
        ORANGE_ROSTER = CHUNK.get('orangePlayers') or []
        BLUE_ROSTER = CHUNK.get('bluePlayers') or []
        if ORANGE_ROSTER or BLUE_ROSTER:
            if DEBUG:
                _emit({'log': f'[_analyze_chunks] {GAME_ID} roster orange=' + str([p.get('name') for p in ORANGE_ROSTER]) + ' blue=' + str([p.get('name') for p in BLUE_ROSTER])})

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
        # Ancre HUD haute (template playing_top.png) trouvée à la 1ère frame
        # exploitable du chunk et réutilisée pour toutes les suivantes — le HUD
        # ne bouge pas dans une vidéo donnée. Sert à dériver dynamiquement les
        # boxes timer / scores au lieu des coordonnées en dur, robuste aux
        # variations de cadrage entre vidéos.
        HUD_ANCHOR = None

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
        # %HP par joueur lu sur les cartouches HUD haut. Une obs par frame
        # gameplay; agrégé par median (per-player) en fin de chunk pour
        # encaisser les frames de transition et les artefacts ponctuels.
        HP_OBSERVATIONS = {}    # {elapsed_s: [{'orange': [hp...], 'blue': [hp...]}, ...]}
        # Mapping cart-position → pseudo, calculé une seule fois par chunk
        # à la première frame exploitable (HUD anchor + couleurs résolus).
        # Format : {'orange': [name_at_cart_0, ...], 'blue': [...]}.
        CART_ASSIGNMENT = None
        MAX_TIME = None   # auto-détecté à la première lecture timer valide

        # Couleur effectivement utilisée par chaque équipe dans cette partie.
        # TEAM_ORANGE et TEAM_BLUE listent plusieurs valeurs possibles (orange/vert
        # fluo, bleu/violet) ; on verrouille la couleur réelle sur la 1ère frame
        # de gameplay du chunk pour éviter les faux positifs en aval (killfeed,
        # masquage OCR). Reste None si la 1ère frame ne donne pas assez de pixels.
        RESOLVED_ORANGE = None
        RESOLVED_BLUE = None

        # Points de capture verrouillés sur la 1ère frame exploitable du chunk
        # (positions fixes pendant toute la game). On detect une fois, puis à
        # chaque seconde on calcule juste le taux de remplissage par équipe.
        LOCKED_POINTS = None
        # {letter: {elapsed: [(orange_pct, blue_pct), ...]}}
        POINT_OBSERVATIONS = {}

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

        # Lecture séquentielle quand FPS connu : 1 seul seek au début du chunk
        # puis read() pour la frame samplée + grab() pour skip les intermédiaires
        # (cheap : décode sans BGR convert). Évite N seeks coûteux sur Windows
        # (chaque cap.set(POS_MSEC) reseek-to-keyframe + decode-forward ~50-200 ms).
        # Fallback sur _get_frame (seek) si FPS indisponible ou retour arrière.
        NATIVE_FPS = CAP.get(cv2.CAP_PROP_FPS) or 0.0
        USE_SEQ = NATIVE_FPS > 0
        NEXT_FRAME_IDX = 0   # nb de frames consommées depuis le seek initial
        if USE_SEQ:
            CAP.set(cv2.CAP_PROP_POS_MSEC, START * 1000)
            if DEBUG:
                _emit({'log': f'[_analyze_chunks] {GAME_ID} sequential read: native_fps={NATIVE_FPS:.2f}'})

        def _decode_for_ts(ts):
            """Décode la frame à l'approx ts (sec vidéo). Lecture séquentielle
            avec grab() pour avancer entre les ts échantillonnés ; fallback seek
            si NATIVE_FPS indisponible, retour arrière, ou si le compteur a été
            invalidé (sentinel < 0)."""
            nonlocal NEXT_FRAME_IDX
            if not USE_SEQ:
                return _get_frame(CAP, ts)
            target_idx = int(round((ts - START) * NATIVE_FPS))
            # Retour arrière ou compteur invalidé : seek explicite, reset compteur.
            # Ne devrait pas arriver dans la boucle principale (TIMESTAMP monotone)
            # mais couvre le cas où LOCKED_POINTS fallback a bougé le main CAP.
            if NEXT_FRAME_IDX < 0 or target_idx < NEXT_FRAME_IDX:
                FRAME = _get_frame(CAP, ts)
                if FRAME is None:
                    NEXT_FRAME_IDX = -1
                    return None
                # _get_frame a fait set+read → cap est positionné après target_idx
                NEXT_FRAME_IDX = target_idx + 1
                return FRAME
            # Skip vers target_idx via grab() (pas de BGR convert).
            while NEXT_FRAME_IDX < target_idx:
                if not CAP.grab():
                    NEXT_FRAME_IDX = -1
                    return None
                NEXT_FRAME_IDX += 1
            ret, frame_bgr = CAP.read()
            if not ret:
                NEXT_FRAME_IDX = -1
                return None
            NEXT_FRAME_IDX += 1
            return cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)

        # Pipeline : on garde WINDOW frames en vol simultanées dans le pool.
        # `_submit_frame` décode + lance les 3 OCR speculatif ; `_process_ocr_item`
        # drain les futures en ordre FIFO (critique pour MAX_TIME et la borne
        # dynamique du SUSPECT_BUFFER qui dépendent du temps croissant).
        # Coût du speculative work amplifié : avec WINDOW=4, jusqu'à 12 OCR
        # peuvent tourner en parallèle pour une frame qui sera finalement jetée.
        # Sur CPU pur c'est OK ; sur PC à la traîne WINDOW=1 garde l'ancien
        # comportement bit-pour-bit (cf. sizing plus haut).
        def _submit_frame(ts):
            nonlocal RESOLVED_ORANGE, RESOLVED_BLUE, HUD_ANCHOR, LOCKED_POINTS, NEXT_FRAME_IDX
            FRAME = _decode_for_ts(ts)
            if FRAME is None:
                return ('skip', ts)

            # Trouve l'ancre HUD une seule fois pour le chunk (matchTemplate
            # est le call le plus cher après l'OCR, ~32ms — on évite de le
            # refaire à chaque frame). L'ancre sert AUSSI au gate gameplay :
            # _detect_game_playing sample un pixel anchor-relative.
            if HUD_ANCHOR is None:
                HUD_ANCHOR = _find_playing_top_anchor(FRAME)
            if not _detect_game_playing(FRAME, anchor=HUD_ANCHOR):
                return ('skip', ts)

            # Verrouille les points de capture sur la 1ère frame exploitable
            # (les positions ne bougent pas pendant la game). Coût ponctuel
            # ≈ 1 matchTemplate + 1 OCR par point ; après ça, le calcul du
            # fill par seconde est gratuit (~400 ops par point).
            # IMPORTANT : on utilise un VideoCapture séparé pour le scan de
            # détection afin de ne pas déplacer la position du CAP principal.
            # Sur Windows (FFmpeg + D3D11), les seeks en arrière après un seek
            # en avant retournent systématiquement la première keyframe, ce qui
            # fait que toutes les frames suivantes ont RAW_ELAPSED=0 et la
            # points_timeline reste vide. Avec un CAP dédié au scan, le CAP
            # principal avance toujours en séquentiel et les seeks restent fiables.
            if LOCKED_POINTS is None and HUD_ANCHOR is not None:
                _scan_cap = _open_video(video_path)
                if _scan_cap is not None:
                    if DEBUG:
                        _emit({'log': f'[_analyze_chunks] {GAME_ID} detect_points via scan_cap (ts={ts:.0f})'})
                    PTS = _detect_capture_points_for_map(_scan_cap, HUD_ANCHOR, ts, MAP_NAME)
                    _scan_cap.release()
                else:
                    if DEBUG:
                        _emit({'log': f'[_analyze_chunks] {GAME_ID} detect_points via main CAP fallback (scan_cap KO, ts={ts:.0f})'})
                    PTS = _detect_capture_points_for_map(CAP, HUD_ANCHOR, ts, MAP_NAME)
                    # Le fallback a seek'd le main CAP : invalide le compteur
                    # pour forcer un re-seek au prochain _decode_for_ts.
                    NEXT_FRAME_IDX = -1
                if PTS:
                    LOCKED_POINTS = PTS
                    if DEBUG:
                        _emit({'log': f'[_analyze_chunks] {GAME_ID} locked {len(PTS)} points: ' + ' '.join(p['letter'] for p in PTS)})

            # Verrouille la couleur d'équipe sur la 1ère frame exploitable du
            # chunk. On le fait ICI (avant les submit OCR) plutôt que dans
            # `_process_ocr_item` pour que le pipeline OCR du score utilise
            # directement la couleur résolue (et pas la liste complète qui
            # contient des candidats "pro league" tels que jaune fluo / cyan
            # qui matchent du HUD parasite et faussent la détection du bbox).
            if RESOLVED_ORANGE is None or RESOLVED_BLUE is None:
                ORG, BLU = _resolve_team_colors(FRAME, anchor=HUD_ANCHOR)
                if RESOLVED_ORANGE is None and ORG is not None:
                    RESOLVED_ORANGE = ORG
                if RESOLVED_BLUE is None and BLU is not None:
                    RESOLVED_BLUE = BLU
                if RESOLVED_ORANGE is not None and RESOLVED_BLUE is not None:
                    if DEBUG:
                        _emit({'log': f'[_analyze_chunks] {GAME_ID} resolved colors: orange={RESOLVED_ORANGE} blue={RESOLVED_BLUE}'})

            # Boxes scores et timer dérivées dynamiquement de l'ancre HUD haute,
            # avec fallback sur la box statique si l'ancre n'est pas trouvée.
            O_BOX = _find_orange_score_box(FRAME, anchor=HUD_ANCHOR)
            B_BOX = _find_blue_score_box(FRAME, anchor=HUD_ANCHOR)
            T_BOX = _find_timer_box(FRAME, anchor=HUD_ANCHOR) or TIMER_BOX

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
            O_SPEC = {'colors': O_COLORS, 'search': O_BOX, 'inset': -10, 'tol_color': 40}
            B_SPEC = {'colors': B_COLORS, 'search': B_BOX, 'inset': -10, 'tol_color': 40}

            return ('ocr', ts, FRAME,
                    EXECUTOR.submit(_ocr_timer_fast, FRAME, T_BOX),
                    EXECUTOR.submit(_ocr_score_at, FRAME, O_SPEC, O_COLORS, MAX_ORANGE),
                    EXECUTOR.submit(_ocr_score_at, FRAME, B_SPEC, B_COLORS, MAX_BLUE))

        def _record_raw(elapsed, orange_raw, blue_raw, timer_text=''):
            if DEBUG:
                _emit({'log': f'[_analyze_chunks] --------> {timer_text}: orange={orange_raw} blue={blue_raw}'})
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
            nonlocal MAX_TIME, TIMELINE_OFFSET, CART_ASSIGNMENT
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
                if DEBUG:
                    _emit({'log': f'[_analyze_chunks] SUSPECT {TIMER_TEXT}: ELAPSED={RAW_ELAPSED}s @ vid={VIDEO_ELAPSED:.0f}s (buffer {len(SUSPECT_BUFFER)}/{SUSPECT_CONFIRM_LEN})'})
                if len(SUSPECT_BUFFER) >= SUSPECT_CONFIRM_LEN:
                    if _is_linear_progression(SUSPECT_BUFFER):
                        FIRST_TS, FIRST_RAW, _, _ = SUSPECT_BUFFER[0]
                        OLD_OFFSET = TIMELINE_OFFSET
                        TIMELINE_OFFSET = FIRST_RAW - (FIRST_TS - START)
                        if DEBUG:
                            _emit({'log': f'[_analyze_chunks] COUPE confirmée : offset {OLD_OFFSET}s → {TIMELINE_OFFSET}s, flush {len(SUSPECT_BUFFER)} samples'})
                        for _, B_RAW, B_O, B_B in SUSPECT_BUFFER:
                            _record_raw(B_RAW, B_O, B_B, '(flush)')
                        SUSPECT_BUFFER.clear()
                    else:
                        DROPPED = SUSPECT_BUFFER.pop(0)
                        if DEBUG:
                            _emit({'log': f'[_analyze_chunks] SUSPECT drop @ ts={DROPPED[0]:.0f}s (non-linéaire)'})
                return

            # Sample dans la borne : tout suspect en attente était une hallucination isolée.
            if SUSPECT_BUFFER:
                if DEBUG:
                    _emit({'log': f'[_analyze_chunks] SUSPECT clear ({len(SUSPECT_BUFFER)} samples invalidés par sample normal)'})
                SUSPECT_BUFFER.clear()

            _record_raw(RAW_ELAPSED, ORANGE_RAW, BLUE_RAW, TIMER_TEXT)

            # Taux de remplissage par équipe pour chaque point de capture
            # verrouillé. Couleurs résolues passées explicitement → robuste
            # aux variantes pro league (vert fluo, violet, etc.). Si la
            # résolution n'a pas encore réussi, fallback sur orange/bleu
            # standard (les valeurs par défaut de `_compute_point_fill`).
            if LOCKED_POINTS:
                ORG_C = RESOLVED_ORANGE if RESOLVED_ORANGE is not None else (238, 120, 12)
                BLU_C = RESOLVED_BLUE   if RESOLVED_BLUE   is not None else (43, 137, 237)
                for PT in LOCKED_POINTS:
                    O_PCT, B_PCT = _compute_point_fill(frame, PT, ORG_C, BLU_C)
                    POINT_OBSERVATIONS.setdefault(PT['letter'], {}) \
                        .setdefault(RAW_ELAPSED, []).append((O_PCT, B_PCT))

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
                    SPLIT = _split_kill_row(frame, KILL_BBOX, RESOLVED_ORANGE, RESOLVED_BLUE)
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
                        K_SLOT = _player_slot(KT, K_ROSTER.index(KMATCH))
                        V_SLOT = _player_slot(VT, V_ROSTER.index(VMATCH))
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

            # %HP des joueurs : pixel-only (pas d'OCR), une obs par frame.
            # Skip tant qu'une couleur d'équipe n'est pas résolue (sinon les
            # mesures de la team manquante seraient toutes biaisées).
            if RESOLVED_ORANGE is not None and RESOLVED_BLUE is not None:
                HP = _compute_player_hp(
                    frame, len(ORANGE_ROSTER), len(BLUE_ROSTER),
                    RESOLVED_ORANGE, RESOLVED_BLUE, anchor=HUD_ANCHOR,
                )
                HP_OBSERVATIONS.setdefault(RAW_ELAPSED, []).append(HP)
                # Identifier la cart→pseudo mapping une seule fois par chunk,
                # à la première frame exploitable (couleurs résolues = HUD
                # stabilisé). Utile au front pour interpréter hp_timeline
                # (qui est indexé par position de cart à l'écran, pas par
                # ordre du roster envoyé).
                if CART_ASSIGNMENT is None:
                    CART_ASSIGNMENT = _identify_carts(
                        frame, len(ORANGE_ROSTER), len(BLUE_ROSTER),
                        ORANGE_ROSTER, BLUE_ROSTER, anchor=HUD_ANCHOR,
                    )
                    if DEBUG:
                        _emit({'log': f'[_analyze_chunks] {GAME_ID} cart_assignment={CART_ASSIGNMENT}'})

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
        if DEBUG:
            _emit({'log': f'[_analyze_chunks] reconstruction: {len(ORANGE_TL)} pts orange, {len(BLUE_TL)} pts blue (sur {len(RAW_OBSERVATIONS)} elapsed observés)'})

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
        # Points de capture : pour chaque lettre verrouillée, on prend la
        # médiane des observations (orange, blue) à chaque seconde, puis on
        # forward-fill et on émet sparse (uniquement les changements). Format
        # mirror de score_timeline : { letter: { "<sec>": [orange, blue] } }.
        POINTS_TIMELINE = {}
        for LETTER, OBS in POINT_OBSERVATIONS.items():
            timeline = {}
            prev = None
            for K in sorted(OBS):
                vals = OBS[K]
                # Médiane indépendante par dimension : robuste à un OCR isolé
                # qui décalerait la teinte (ex. flash explosion → orange).
                o_med = sorted(v[0] for v in vals)[len(vals) // 2]
                b_med = sorted(v[1] for v in vals)[len(vals) // 2]
                pair = [o_med, b_med]
                if pair != prev:
                    timeline[str(K)] = pair
                    prev = pair
            POINTS_TIMELINE[LETTER] = timeline

        # Atlantis : rotation des points (A actif phase 1, B/C actifs phase 2).
        # À faire AVANT le lissage Domination — sinon une fausse capture en
        # phase 1 sur B/C lock owned_team chez le smoother et corrompt tout.
        if MAP_NAME == 'Atlantis' and POINTS_TIMELINE:
            POINTS_TIMELINE = _smooth_points_timeline_atlantis(POINTS_TIMELINE)

        # Lissage Domination : une fois owned (100 %), un point ne peut décroître
        # que par contest (orange ET bleu) ou reset à 0/0. Toute décroissance solo
        # observée ensuite est du bruit OCR → drop. Skippé sur Outlaw (Hardpoint)
        # où la décroissance solo est physique.
        if not IS_HARDPOINT and POINTS_TIMELINE:
            POINTS_TIMELINE = _smooth_points_timeline_domination(POINTS_TIMELINE)

        # Killfeed : dédup multi-frame (un kill reste 5 s à l'écran → ~5 obs).
        # Sortie = un event par kill, daté à l'elapsed le plus tôt observé.
        KILLS_OUT = _dedup_kills(KILL_OBSERVATIONS)

        # %HP par joueur : médiane des observations par seconde, par joueur.
        # Sparse comme score_timeline : on émet uniquement les sec où la
        # paire (orange, blue) change. Le front forward-fill côté UI.
        def _median_per_player(obs_list, team):
            n = max(len(o[team]) for o in obs_list)
            out = []
            for i in range(n):
                vals = sorted(o[team][i] for o in obs_list if i < len(o[team]))
                out.append(vals[len(vals) // 2])
            return out

        HP_TIMELINE = {}
        prev_hp = None
        for K in sorted(HP_OBSERVATIONS):
            obs_list = HP_OBSERVATIONS[K]
            pair = {
                'orange': _median_per_player(obs_list, 'orange'),
                'blue':   _median_per_player(obs_list, 'blue'),
            }
            if pair != prev_hp:
                HP_TIMELINE[str(K)] = pair
                prev_hp = pair
        # Faux "mort" détectés (HP=0 mais joueur en regen) → forcés à 1.
        # Le death lockout est calé sur le délai de respawn de la map.
        RESPAWN = _MAPS.get(MAP_NAME, {}).get('respawn', DEFAULT_RESPAWN)
        HP_TIMELINE = _smooth_hp_timeline(HP_TIMELINE, respawn=RESPAWN)

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

        # Player tracking sur la minimap (Layer 1 blob detection + Layer 2 MOT
        # + Layer 3 identification via hp_timeline). Bornée à
        # [START, END - END_NON_GAMEPLAY] pour éviter de scanner l'écran de
        # score final. Encapsulée dans try/except : si ça plante, on continue
        # l'analyse OCR (player_tracks reste vide dans le payload).
        try:
            PLAYER_TRACKS, MINIMAP_POSITION = _track_players_on_minimap(
                CAP, float(START), float(END - END_NON_GAMEPLAY),
                MAP_NAME,
                n_orange=len(ORANGE_ROSTER),
                n_blue=len(BLUE_ROSTER),
                hp_timeline=HP_TIMELINE,
            )
        except Exception as exc:
            _emit({'log': f'[player_tracking] FAILED: {exc}'})
            PLAYER_TRACKS = []
            MINIMAP_POSITION = None

        CHUNK_PERCENT = int(100 * PROCESSED_SECONDS / TOTAL_SECONDS) if TOTAL_SECONDS > 0 else 100
        _emit({
            'percent': CHUNK_PERCENT,
            'results': [{
                'gameID': GAME_ID,
                'payload': {
                    'score_timeline': SCORE_TIMELINE,
                    'points_timeline': POINTS_TIMELINE,
                    'hp_timeline': HP_TIMELINE,
                    'cart_assignment': CART_ASSIGNMENT,
                    'kills': KILLS_OUT,
                    'end_non_gameplay_seconds': END_NON_GAMEPLAY,
                    'orange_color': list(RESOLVED_ORANGE) if RESOLVED_ORANGE else None,
                    'blue_color': list(RESOLVED_BLUE) if RESOLVED_BLUE else None,
                    'players_tracks': PLAYER_TRACKS,
                    'minimap_position': MINIMAP_POSITION,
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
          settings : { maxTimePerGame? }
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
            for f in ('eng.traineddata', 'evadigits.traineddata',
                      'evapseudos.traineddata')
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
            if DEBUG:
                _emit({'log': f'[tesseract] bundled SIGKILL → fallback to {FALLBACK}'})
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
        MAX_TIME = int(SETTINGS.get('maxTimePerGame', 10))
        try:
            _analyze(VIDEO_PATH, FFMPEG_PATH, MAX_TIME)
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
