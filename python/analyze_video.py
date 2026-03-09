# Copyright (c) 2026, Antoine Duval
# This file is part of a source-visible project.
# See LICENSE for terms. Unauthorized use is prohibited.

import sys
import os
import json
import subprocess
import io
import re
import base64
import time

import numpy as np
import cv2
from PIL import Image, ImageOps, ImageEnhance
import pytesseract

# ---------------------------------------------------------------------------
# MODES — mirrored from angular/src/app/views/replay_cutter/models/mode.ts
# All positions are in 1920×1080 coordinate space.
# ---------------------------------------------------------------------------

MODES = [
    # ── Mode 0 ──────────────────────────────────────────────────────────────
    {
        'scoreFrame': {
            'orangeLogo': (325, 153),
            'blueLogo': (313, 613),
            'orangeName': ((390, 187), (620, 217)),
            'blueName': ((390, 637), (620, 667)),
            'orangeScore': ((530, 89), (620, 127)),
            'blueScore': ((1285, 89), (1384, 127)),
        },
        'endFrame': {
            'orangeScore': ((636, 545), (903, 648)),
            'blueScore': ((996, 545), (1257, 648)),
        },
        'gameFrame': {
            'playersX': [118, 1801],
            'map': ((825, 81), (1093, 102)),
            'orangeName': ((686, 22), (833, 68)),
            'blueName': ((1087, 22), (1226, 68)),
            'timer': ((935, 0), (985, 28)),
            'playersY': [[732, 755], [814, 838], [898, 921], [980, 1004]],
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
    # ── Mode 1 ──────────────────────────────────────────────────────────────
    {
        'scoreFrame': {
            'orangeLogo': (325, 123),
            'blueLogo': (313, 618),
            'orangeName': ((388, 159), (618, 189)),
            'blueName': ((390, 629), (620, 679)),
            'orangeScore': ((530, 54), (620, 92)),
            'blueScore': ((1286, 54), (1376, 93)),
        },
        'endFrame': {
            'orangeScore': ((636, 545), (903, 648)),
            'blueScore': ((996, 545), (1257, 648)),
        },
        'gameFrame': {
            'playersX': [118, 1801],
            'map': ((825, 89), (1093, 110)),
            'orangeName': ((686, 22), (833, 68)),
            'blueName': ((1087, 22), (1226, 68)),
            'timer': ((935, 0), (985, 28)),
            'playersY': [[703, 729], [793, 819], [883, 908], [973, 998]],
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
        ],
    },
    # ── Mode 2 ──────────────────────────────────────────────────────────────
    {
        'scoreFrame': {
            'orangeLogo': (325, 126),
            'blueLogo': (313, 618),
            'orangeName': ((388, 159), (620, 196)),
            'blueName': ((388, 641), (620, 677)),
            'orangeScore': ((530, 54), (620, 92)),
            'blueScore': ((1286, 54), (1376, 93)),
        },
        'endFrame': {
            'orangeScore': ((636, 545), (903, 648)),
            'blueScore': ((996, 545), (1257, 648)),
        },
        'gameFrame': {
            'playersX': [118, 1801],
            'map': ((825, 89), (1093, 110)),
            'orangeName': ((686, 22), (833, 68)),
            'blueName': ((1087, 22), (1226, 68)),
            'timer': ((935, 0), (985, 28)),
            'playersY': [[707, 732], [796, 821], [885, 909], [974, 998]],
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
        ],
    },
    # ── Mode 3 ──────────────────────────────────────────────────────────────
    {
        'scoreFrame': {
            'orangeLogo': (314, 157),
            'blueLogo': (299, 621),
            'orangeName': ((390, 187), (620, 217)),
            'blueName': ((390, 637), (620, 667)),
            'orangeScore': ((530, 89), (620, 127)),
            'blueScore': ((1285, 89), (1384, 127)),
        },
        'endFrame': {
            'orangeScore': ((636, 545), (903, 648)),
            'blueScore': ((996, 545), (1257, 648)),
        },
        'gameFrame': {
            'playersX': [118, 1801],
            'map': ((825, 79), (1093, 99)),
            'orangeName': ((686, 22), (833, 68)),
            'blueName': ((1087, 22), (1226, 68)),
            'timer': ((935, 0), (985, 28)),
            'playersY': [[732, 755], [814, 838], [898, 921], [980, 1004]],
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
        ],
    },
]

# B-letter patterns for game intro detection — from detectGameIntro() in the service
_B_PATTERNS = [
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
    'Engine': ['engine'],
    'Helios Station': ['helios', 'station', 'hheliosstation', 'rheliosstation', 'heliosstation'],
    'Lunar Outpost': ['lunar', 'outpost', 'lunaroutpost'],
    'Outlaw': ['outlaw', 'qutlaw'],
    'Polaris': ['polaris'],
    'Silva': ['silva'],
    'The Cliff': ['cliff', 'tnecltt', 'tnecitt'],
    'The Rock': ['rock'],
    'Horizon': ['horizon'],
}

WIDTH  = 1920
HEIGHT = 1080

# ---------------------------------------------------------------------------
# Low-level helpers
# ---------------------------------------------------------------------------

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
    whitelist: str = '',
    luminance: int = None,
    apply_filter: bool = False,
    checker=None,
) -> str:
    """
    Lance Tesseract sur la région (x1, y1)→(x2, y2) du frame avec plusieurs passes
    d'image (brute, N&B par seuil de luminance, inversion+contraste, niveaux de gris+contraste)
    et retourne le résultat le plus fréquent — miroir de getTextFromImage() en TypeScript.

    checker : fonction optionnelle appliquée à chaque résultat avant le vote (ex. _score_checker).
    """
    img = _region_to_pil(frame, x1, y1, x2, y2)
    CONFIG = f'--psm {psm}'
    if whitelist:
        CONFIG += f' -c tessedit_char_whitelist={whitelist}'

    def _recognize(i: Image.Image) -> str:
        try:
            return pytesseract.image_to_string(i, config=CONFIG).replace('\r', '').replace('\n', '').strip()
        except Exception as e:
            _emit({'log': f'[OCR ERROR] {e}'})
            return ''

    results = [_recognize(img)]

    if luminance is not None:
        BW = img.convert('L').point(lambda p: 255 if p > luminance else 0).convert('RGB')
        results.append(_recognize(BW))

    if apply_filter:
        try:
            F1 = ImageOps.invert(img.convert('RGB'))
            F1 = ImageEnhance.Contrast(F1).enhance(2.0)
            F1 = ImageEnhance.Brightness(F1).enhance(1.5)
            results.append(_recognize(F1))
        except Exception:
            pass
        try:
            F2 = img.convert('L').convert('RGB')
            F2 = ImageEnhance.Contrast(F2).enhance(3.0)
            F2 = ImageEnhance.Brightness(F2).enhance(1.5)
            results.append(_recognize(F2))
        except Exception:
            pass

    if checker:
        results = [checker(r) for r in results]

    NON_EMPTY = [r for r in results if r]
    if not NON_EMPTY:
        RESULT = ''
    elif checker:
        MAX_LEN = max(len(r) for r in NON_EMPTY)
        LONGEST = [r for r in NON_EMPTY if len(r) == MAX_LEN]
        RESULT = _most_frequent(LONGEST)
    else:
        RESULT = _most_frequent(NON_EMPTY)
    _emit({'log': f'[OCR] region=({x1},{y1})-({x2},{y2}) results={results} → {repr(RESULT)}'})
    return RESULT

# ---------------------------------------------------------------------------
# Frame type detection — mirrors detect* functions from the TypeScript service
# ---------------------------------------------------------------------------

def _detect_game_score_frame(frame: np.ndarray) -> int:
    """
    Détecte un écran de score final (tableau des scores entre les équipes).
    Retourne l'index du mode (0-3) si détecté, -1 sinon.
    Miroir de detectGameScoreFrame() en TypeScript.
    """
    for i, mode in enumerate(MODES):
        SF = mode['scoreFrame']
        OL = SF['orangeLogo']
        BL = SF['blueLogo']
        if (_color_similar(_get_pixel(frame, OL[0], OL[1]), (239, 203, 14)) and
                _color_similar(_get_pixel(frame, BL[0], BL[1]), (50, 138, 230))):
            return i
    return -1


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
    for PATTERN in _B_PATTERNS:
        if all(_color_similar(_get_pixel(frame, p[0], p[1]), (p[2], p[2], p[2]), p[3])
               for p in PATTERN):
            return True
    return False


def _detect_game_playing(frame: np.ndarray, mode_index: int) -> bool:
    """
    Détecte un frame de jeu en cours en vérifiant les barres de vie des joueurs
    (couleurs orange/bleu sur les colonnes gauche et droite du HUD).
    Miroir de detectGamePlayingFrame() en TypeScript.
    """
    GF  = MODES[mode_index]['gameFrame']
    PX  = GF['playersX']
    PY  = GF['playersY']
    ORANGE = (231, 123, 9)
    BLUE   = (30, 126, 242)
    BLACK  = (0, 0, 0)

    OP = [_get_pixel(frame, PX[0], (PY[i][0] + PY[i][1]) / 2) for i in range(4)]
    BP = [_get_pixel(frame, PX[1], (PY[i][0] + PY[i][1]) / 2) for i in range(4)]

    if not (any(_color_similar(p, ORANGE) for p in OP) and
            any(_color_similar(p, BLUE)   for p in BP)):
        return False

    for p in OP:
        if not (_color_similar(p, ORANGE) or _color_similar(p, BLACK, 50)):
            return False
    for p in BP:
        if not (_color_similar(p, BLUE) or _color_similar(p, BLACK, 50)):
            return False
    return True

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

    while TIMESTAMP > 0:
        PERCENT = int((1.0 - TIMESTAMP / DURATION) * 100) if DURATION > 0 else 0

        COMPLETED_COUNT = sum(1 for g in GAMES if g['start'] != -1)
        _emit({'type': 'progress', 'percent': PERCENT, 'games': COMPLETED_COUNT, 'time': TIMESTAMP})

        FRAME = _get_frame(CAP, TIMESTAMP)
        if FRAME is None:
            TIMESTAMP -= 1.0
            continue

        FOUND = False

        # ── Score frame ────────────────────────────────────────────────────
        # Only create a new game when there is no pending one (start == -1).
        if not FOUND and (CURRENT is None or CURRENT['start'] != -1):
            SCORE_MODE = _detect_game_score_frame(FRAME)
            if SCORE_MODE >= 0:
                _emit({'log': 'Score frame found ' + str(SCORE_MODE)})
                FOUND = True
                JUST_JUMPED = False
                GAME = _new_game(SCORE_MODE, orange_override, blue_override)
                GAME['end'] = TIMESTAMP - 1
                SF = MODES[SCORE_MODE]['scoreFrame']

                if not GAME['orangeTeam']['name']:
                    T = _ocr_region(
                        FRAME,
                        SF['orangeName'][0][0], SF['orangeName'][0][1],
                        SF['orangeName'][1][0], SF['orangeName'][1][1],
                        psm=7,
                        whitelist='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
                        luminance=225, apply_filter=True,
                    )
                    if T and len(T) >= 2:
                        _emit({'log': 'Orange team name : '+T.upper()})
                        GAME['orangeTeam']['name'] = T.upper()

                _set_score(GAME, 'orangeTeam', _ocr_region(
                    FRAME,
                    SF['orangeScore'][0][0], SF['orangeScore'][0][1],
                    SF['orangeScore'][1][0], SF['orangeScore'][1][1],
                    psm=7, whitelist='0123456789', luminance=200, apply_filter=True,
                    checker=_score_checker,
                ))

                if not GAME['blueTeam']['name']:
                    T = _ocr_region(
                        FRAME,
                        SF['blueName'][0][0], SF['blueName'][0][1],
                        SF['blueName'][1][0], SF['blueName'][1][1],
                        psm=7,
                        whitelist='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
                        luminance=225, apply_filter=True,
                    )
                    if T and len(T) >= 2:
                        _emit({'log': 'Blue team name : '+T.upper()})
                        GAME['blueTeam']['name'] = T.upper()

                _set_score(GAME, 'blueTeam', _ocr_region(
                    FRAME,
                    SF['blueScore'][0][0], SF['blueScore'][0][1],
                    SF['blueScore'][1][0], SF['blueScore'][1][1],
                    psm=7, whitelist='0123456789', luminance=200, apply_filter=True,
                    checker=_score_checker,
                ))

                GAME['orangeTeam']['nameImage']  = _region_to_base64(FRAME, SF['orangeName'][0][0],  SF['orangeName'][0][1],  SF['orangeName'][1][0],  SF['orangeName'][1][1])
                GAME['orangeTeam']['scoreImage'] = _region_to_base64(FRAME, SF['orangeScore'][0][0], SF['orangeScore'][0][1], SF['orangeScore'][1][0], SF['orangeScore'][1][1])
                GAME['blueTeam']['nameImage']    = _region_to_base64(FRAME, SF['blueName'][0][0],    SF['blueName'][0][1],    SF['blueName'][1][0],    SF['blueName'][1][1])
                GAME['blueTeam']['scoreImage']   = _region_to_base64(FRAME, SF['blueScore'][0][0],   SF['blueScore'][0][1],   SF['blueScore'][1][0],   SF['blueScore'][1][1])

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
                    psm=7, whitelist='0123456789', checker=_score_checker,
                ))
                _set_score(GAME, 'blueTeam', _ocr_region(
                    FRAME,
                    EF['blueScore'][0][0], EF['blueScore'][0][1],
                    EF['blueScore'][1][0], EF['blueScore'][1][1],
                    psm=7, whitelist='0123456789', checker=_score_checker,
                ))
                GAMES.insert(0, GAME)
                CURRENT = GAME

        # ── Game start: loading screen ──────────────────────────────────────
        if not FOUND and CURRENT is not None and CURRENT['start'] == -1:
            if _detect_game_loading_frame(FRAME, CURRENT['mode']):
                _emit({'log': 'Loading frame found'})
                FOUND = True
                JUST_JUMPED = False
                CURRENT['start'] = TIMESTAMP + 2
                CURRENT = None   # game complete

        # ── Game start: map introduction ────────────────────────────────────
        if not FOUND and CURRENT is not None and CURRENT['start'] == -1:
            if _detect_game_intro(FRAME):
                _emit({'log': 'Game intro frame found'})
                FOUND = True
                JUST_JUMPED = False
                CURRENT['start'] = TIMESTAMP + 2
                CURRENT = None

        # ── Playing frame: OCR map / team names + timer jump ────────────────
        if not FOUND and CURRENT is not None and CURRENT['start'] == -1:
            if _detect_game_playing(FRAME, CURRENT['mode']):
                FOUND = True
                _emit({'log': 'Playing frame found'})
                GF = MODES[CURRENT['mode']]['gameFrame']

                if not CURRENT['map']:
                    T = _ocr_region(
                        FRAME,
                        GF['map'][0][0], GF['map'][0][1],
                        GF['map'][1][0], GF['map'][1][1],
                        psm=7,
                        whitelist='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz ',
                        luminance=225, apply_filter=True,
                    )
                    if T:
                        MAP_NAME = _get_map_by_name(T)
                        if MAP_NAME:
                            _emit({'log': 'map name : ' + MAP_NAME})
                            CURRENT['map'] = MAP_NAME
                            CURRENT['mapImage'] = _region_to_base64(
                                FRAME,
                                GF['map'][0][0], GF['map'][0][1],
                                GF['map'][1][0], GF['map'][1][1],
                            )
                        else:
                            _emit({'WAZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA': T})

                if not CURRENT['orangeTeam']['name']:
                    T = _ocr_region(
                        FRAME,
                        GF['orangeName'][0][0], GF['orangeName'][0][1],
                        GF['orangeName'][1][0], GF['orangeName'][1][1],
                        psm=6,
                        whitelist='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
                    )
                    if T and len(T) >= 2:
                        _emit({'log': 'orange team name : ' + T.upper()})
                        CURRENT['orangeTeam']['name'] = T.upper()

                if not CURRENT['blueTeam']['name']:
                    T = _ocr_region(
                        FRAME,
                        GF['blueName'][0][0], GF['blueName'][0][1],
                        GF['blueName'][1][0], GF['blueName'][1][1],
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
                        GF['timer'][0][0], GF['timer'][0][1],
                        GF['timer'][1][0], GF['timer'][1][1],
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
        if not FOUND:
            _emit({'log': "Can't identify frame"})

        # Après un timer jump on est près du début du jeu → STEP=1 pour ne pas
        # rater l'écran de chargement. Dans toutes les autres zones (post-game,
        # stats, etc.) STEP=2 divise par 2 le nombre de seeks inutiles.
        STEP = 1.0 if JUST_JUMPED else 2.0
        TIMESTAMP -= STEP

    CAP.release()
    _emit({'type': 'done', 'games': GAMES})

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def _get_bundled_tesseract() -> str:
    """Renvoie le chemin vers le tesseract embarqué par PyInstaller, ou ''."""
    BASE = getattr(sys, '_MEIPASS', '')
    if not BASE:
        return ''
    EXE_NAME = 'tesseract.exe' if sys.platform == 'win32' else 'tesseract'
    CANDIDATE = os.path.join(BASE, 'tesseract', EXE_NAME)
    return CANDIDATE if os.path.isfile(CANDIDATE) else ''


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

    TESSERACT_CMD = sys.argv[3] if len(sys.argv) > 3 else ''
    if not TESSERACT_CMD:
        TESSERACT_CMD = _get_bundled_tesseract()
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
