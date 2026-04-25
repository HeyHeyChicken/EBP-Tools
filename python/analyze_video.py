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
from PIL import Image, ImageOps, ImageEnhance
import pytesseract

# ---------------------------------------------------------------------------
# MODES
# All positions are in 1920×1080 coordinate space.
# ---------------------------------------------------------------------------

MODES = [
    #region Mode 0
    {
        'scoreFrame': {
            'identify': [
                (78, 412, [(238, 120, 12)]),  # orange team circle
                (78, 745, [(43, 137, 237)]),  # blue team circle
            ],
            'orangeName': ((90, 402), (175, 422)),
            'blueName': ((90, 735), (175, 756)),
            'orangeScore': ((30, 435), (355, 530)),
            'blueScore': ((30, 627), (355, 722)),
        },
        'endFrame': {
            'orangeScore': ((636, 545), (903, 648)),
            'blueScore': ((996, 545), (1257, 648)),
        },
        'gameFrame': {
            'map': ((845, 119), (1072, 154)),
            'orangeName': ((704, 58), (796, 97)),
            'blueName': ((1121, 58), (1214, 97)),
            'timer': ((920, 53), (1000, 77)),
            'playersY': [[732, 755], [814, 838], [898, 921], [980, 1004]],
        },
        'playingFrame': {
            'identify': [
                (1731, 811, [(238, 241, 238)]),    # top blanc
                (1731, 990, [(238, 241, 238)]),  # bottom blanc
                (1858, 813, [(48, 152, 254), (250, 129, 4)]),  # player color
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
    'The Cliff': ['cliff', 'citt', 'clit', 'cltt', 'cit', 'ciitt'],
    'The Rock': ['rock', 'therock'],
    'Horizon': ['horizon'],
}

WIDTH  = 1920
HEIGHT = 1080

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
    checker=None,
    lang: str = 'eng',
) -> str:
    """
    Lance Tesseract sur la région (x1, y1)→(x2, y2) du frame avec plusieurs passes
    d'image (brute, N&B par seuil de luminance, inversion+contraste, niveaux de gris+contraste)
    et retourne le résultat le plus fréquent — miroir de getTextFromImage() en TypeScript.

    extra_psms : liste optionnelle de PSMs supplémentaires à essayer en plus de psm.
                 Utile pour les scores où PSM 8 (single word) complète PSM 7 (single line).
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
                _emit({'log': f'[OCR][ERROR] lang={lang!r} cfg={cfg!r} cmd={pytesseract.pytesseract.tesseract_cmd!r} tessdata={os.environ.get("TESSDATA_PREFIX", "<unset>")} exc={type(EXC).__name__}: {EXC}'})
                out.append('')
        return out

    results = list(_recognize(img))
    BW = None

    if luminance is not None:
        BW = img.convert('L').point(lambda p: 255 if p < luminance else 0).convert('RGB')
        results.extend(_recognize(BW))

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
    try:
        STAMP = int(time.time() * 1000)
        BASE = os.path.expanduser(f'~/Downloads/ocr_{int(x1)}_{int(y1)}_{int(x2)}_{int(y2)}_{STAMP}')
        img.save(f'{BASE}_0orig.png')
        if BW is not None:
            BW.save(f'{BASE}_1bw.png')
        if F1 is not None:
            F1.save(f'{BASE}_2inv.png')
        if F2 is not None:
            F2.save(f'{BASE}_3gray.png')
    except Exception:
        pass
    _emit({'log': f'[OCR] region=({x1},{y1})-({x2},{y2}) results={results} → {repr(RESULT)}'})
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


def _detect_game_playing(frame: np.ndarray):
    """
    Détecte un frame de jeu en cours.
    Retourne (matched, dx, dy). dx/dy = décalage du HUD à appliquer aux régions OCR.
    """
    for mode in MODES:
        offset = _identify_offset(frame, mode['playingFrame']['identify'])
        if offset is not None:
            return (True, offset[0], offset[1])
    return (False, 0.0, 0.0)

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
            _emit({'log': team + ' score : ' + raw})
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
                _emit({'log': f'Score frame found {SCORE_MODE} (HUD offset dx={SF_DX:+.1f}, dy={SF_DY:+.1f})'})
                FOUND = True
                JUST_JUMPED = False
                GAME = _new_game(SCORE_MODE, orange_override, blue_override)
                GAME['end'] = TIMESTAMP - 1
                _SF_RAW = MODES[SCORE_MODE]['scoreFrame']
                # Décale chaque région OCR de l'offset HUD détecté.
                ON = _shift_box(_SF_RAW['orangeName'], SF_DX, SF_DY)
                BN = _shift_box(_SF_RAW['blueName'],   SF_DX, SF_DY)
                OS = _shift_box(_SF_RAW['orangeScore'], SF_DX, SF_DY)
                BS = _shift_box(_SF_RAW['blueScore'],   SF_DX, SF_DY)

                if not GAME['orangeTeam']['name']:
                    T = _ocr_region(
                        FRAME,
                        ON[0][0], ON[0][1], ON[1][0], ON[1][1],
                        psm=7,
                        whitelist='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
                        luminance=100, apply_filter=True,
                    )
                    if T and len(T) >= 2:
                        _emit({'log': 'Orange team name : '+T.upper()})
                        GAME['orangeTeam']['name'] = T.upper()

                _set_score(GAME, 'orangeTeam', _ocr_region(
                    FRAME,
                    OS[0][0], OS[0][1], OS[1][0], OS[1][1],
                    psm=7, extra_psms=[8], whitelist='0123456789%', luminance=100, apply_filter=True, lang='evadigits',
                    checker=_score_checker,
                ))

                if not GAME['blueTeam']['name']:
                    T = _ocr_region(
                        FRAME,
                        BN[0][0], BN[0][1], BN[1][0], BN[1][1],
                        psm=7,
                        whitelist='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
                        luminance=100, apply_filter=True,
                    )
                    if T and len(T) >= 2:
                        _emit({'log': 'Blue team name : '+T.upper()})
                        GAME['blueTeam']['name'] = T.upper()

                _set_score(GAME, 'blueTeam', _ocr_region(
                    FRAME,
                    BS[0][0], BS[0][1], BS[1][0], BS[1][1],
                    psm=7, extra_psms=[8], whitelist='0123456789%', luminance=100, apply_filter=True, lang='evadigits',
                    checker=_score_checker,
                ))

                GAME['orangeTeam']['nameImage']  = _region_to_base64(FRAME, ON[0][0], ON[0][1], ON[1][0], ON[1][1])
                GAME['orangeTeam']['scoreImage'] = _region_to_base64(FRAME, OS[0][0], OS[0][1], OS[1][0], OS[1][1])
                GAME['blueTeam']['nameImage']    = _region_to_base64(FRAME, BN[0][0], BN[0][1], BN[1][0], BN[1][1])
                GAME['blueTeam']['scoreImage']   = _region_to_base64(FRAME, BS[0][0], BS[0][1], BS[1][0], BS[1][1])

                GAMES.insert(0, GAME)
                CURRENT = GAME

        # ── End frame ──────────────────────────────────────────────────────
        if not FOUND and (CURRENT is None or CURRENT['start'] != -1):
            if _detect_game_end_frame(FRAME):
                _emit({'log': 'End frame found'})
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
                _emit({'log': 'Loading frame found'})
                FOUND = True
                JUST_JUMPED = False
                # Scan forward to find the first actual gameplay frame.
                PROBE = TIMESTAMP + 1
                GAME_START = TIMESTAMP
                while PROBE <= TIMESTAMP + 30:
                    PROBE_FRAME = _get_frame(CAP, PROBE)
                    if PROBE_FRAME is not None and _detect_game_playing(PROBE_FRAME)[0]:
                        GAME_START = PROBE
                        break
                    _emit({'log': 's'})
                    PROBE += 0.5
                CURRENT['start'] = GAME_START
                _emit({'log': f'First game frame detected at {GAME_START:.1f}s'})
                _emit({'type': 'game', 'game': CURRENT})
                CURRENT = None   # game complete

        # ── Game start: map introduction ────────────────────────────────────
        if not FOUND and CURRENT is not None and CURRENT['start'] == -1:
            if _detect_game_intro(FRAME):
                _emit({'log': 'Game intro frame found'})
                FOUND = True
                JUST_JUMPED = False
                # Scan forward to find the first actual gameplay frame.
                PROBE = TIMESTAMP + 1
                GAME_START = TIMESTAMP
                while PROBE <= TIMESTAMP + 30:
                    PROBE_FRAME = _get_frame(CAP, PROBE)
                    if PROBE_FRAME is not None and _detect_game_playing(PROBE_FRAME)[0]:
                        GAME_START = PROBE
                        break
                    PROBE += 0.5
                CURRENT['start'] = GAME_START
                _emit({'log': f'First game frame detected at {GAME_START:.1f}s'})
                _emit({'type': 'game', 'game': CURRENT})
                CURRENT = None

        # ── Playing frame: OCR map / team names + timer jump ────────────────
        if not FOUND and CURRENT is not None and CURRENT['start'] == -1:
            PLAYING, _, _ = _detect_game_playing(FRAME)
            if PLAYING:
                FOUND = True
                _emit({'log': 'Playing frame found'})

                # NOTE : on n'applique PAS d'offset HUD ici. Les pixels
                # d'identify du playingFrame sont dans des zones blanches étendues
                # (bandeau bas-droite) qui rendent le centroïde bruité ; et la map
                # / les noms d'équipe en haut-centre ne sont pas corrélés au shift
                # de cette zone. Si un jour tu veux corriger un drift en jeu,
                # ajoute des anchors d'identify proches de chaque région OCR.
                GF        = MODES[CURRENT['mode']]['gameFrame']
                MAP_BOX   = GF['map']
                ON_BOX    = GF['orangeName']
                BN_BOX    = GF['blueName']
                TIMER_BOX = GF['timer']

                if not CURRENT['map']:
                    T = _ocr_region(
                        FRAME,
                        MAP_BOX[0][0], MAP_BOX[0][1], MAP_BOX[1][0], MAP_BOX[1][1],
                        psm=7,
                        whitelist='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz ',
                        luminance=100, apply_filter=True,
                    )
                    if T:
                        MAP_NAME = _get_map_by_name(T)
                        if MAP_NAME:
                            _emit({'log': 'map name : ' + MAP_NAME})
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
                        _emit({'log': 'orange team name : ' + T.upper()})
                        CURRENT['orangeTeam']['name'] = T.upper()

                if not CURRENT['blueTeam']['name']:
                    T = _ocr_region(
                        FRAME,
                        BN_BOX[0][0], BN_BOX[0][1], BN_BOX[1][0], BN_BOX[1][1],
                        psm=6,
                        whitelist='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
                    )
                    if T and len(T) >= 2:
                        _emit({'log': 'blue team name : ' + T.upper()})
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
                        psm=7, whitelist='0123456789:',
                    )
                    if TIMER:
                        _emit({'log': 'timer : ' + TIMER})
                        PARTS = TIMER.split(':')
                        if len(PARTS) == 2:
                            try:
                                M, S = int(PARTS[0]), int(PARTS[1])
                                _emit({'log': max_time_per_game, 'm': M, 's': S})
                                if M <= max_time_per_game:
                                    DIFF = (max_time_per_game - M) * 60 - S - 20

                                    _emit({'log': "Try to jump " + str(DIFF)})
                                    CURRENT['__jumped__'] = True
                                    JUST_JUMPED = True
                                    TIMESTAMP -= DIFF
                                    continue   # skip TIMESTAMP -= STEP
                            except Exception as e:
                                print(e)
                                pass
        #if not FOUND:
            _emit({'log': "Can't identify frame"})

        # Après un timer jump on est près du début du jeu → STEP=1 pour ne pas
        # rater l'écran de chargement. Dans toutes les autres zones (post-game,
        # stats, etc.) STEP=2 divise par 2 le nombre de seeks inutiles.
        STEP = 1.0 if JUST_JUMPED else 2.0
        TIMESTAMP -= STEP

    CAP.release()

    if len(GAMES) == 1:
        _emit({'type': 'game', 'game': CURRENT})

    _emit({'type': 'done'})

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
    Arguments positionnels :
      1  video_path    — chemin absolu vers la vidéo à analyser
      2  ffmpeg_path   — chemin vers le binaire ffmpeg bundlé
      3  tesseract_cmd — (optionnel) chemin vers le binaire Tesseract bundlé
      4  settings_json — (optionnel) JSON avec orangeTeamName, blueTeamName, maxTimePerGame
    Toutes les sorties sont des JSON lines sur stdout (progress / done / error).
    """
    if len(sys.argv) < 3:
        _emit({'type': 'error', 'message': 'Usage: analyze_video <video_path> <ffmpeg_path> [tesseract_cmd] [settings_json]'})
        sys.exit(1)

    VIDEO_PATH  = sys.argv[1]
    FFMPEG_PATH = sys.argv[2]

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

    TESSERACT_CMD = sys.argv[3] if len(sys.argv) > 3 else ''
    if not TESSERACT_CMD:
        TESSERACT_CMD = _get_bundled_tesseract()
    # Si le binaire bundlé est tué par macOS (signature ad-hoc + hardened runtime
    # sur certaines machines), on bascule sur le tesseract système.
    if TESSERACT_CMD and not _tesseract_works(TESSERACT_CMD):
        FALLBACK = _find_system_tesseract()
        if FALLBACK and _tesseract_works(FALLBACK):
            _emit({'log': f'[tesseract] bundled SIGKILL → fallback to {FALLBACK}'})
            TESSERACT_CMD = FALLBACK
    if TESSERACT_CMD:
        pytesseract.pytesseract.tesseract_cmd = TESSERACT_CMD

    SETTINGS: dict = {}
    if len(sys.argv) > 4:
        try:
            SETTINGS = json.loads(sys.argv[4])
        except Exception:
            pass

    ORANGE   = SETTINGS.get('orangeTeamName', '').strip()
    BLUE     = SETTINGS.get('blueTeamName', '').strip()
    MAX_TIME = int(SETTINGS.get('maxTimePerGame', 10))

    START = time.time()
    try:
        _analyze(VIDEO_PATH, FFMPEG_PATH, ORANGE, BLUE, MAX_TIME)
    except Exception as EXC:
        _emit({'type': 'error', 'message': str(EXC)})
        sys.exit(1)
    ELAPSED = int(time.time() - START)
    _emit({'log': f'Durée : {ELAPSED // 60:02d}:{ELAPSED % 60:02d}'})


if __name__ == '__main__':
    main()
