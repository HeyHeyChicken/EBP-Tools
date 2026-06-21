"""
OCR in-process via tesserocr — réutilise une PyTessBaseAPI résidente par
(lang, user_words) au lieu de spawner le binaire tesseract et de recharger le
modèle .traineddata à chaque appel (~50 ms d'overhead/appel mesurés).

Fallback transparent sur pytesseract (subprocess) si tesserocr n'est pas
disponible (ex. build Windows) ou en cas d'erreur runtime : la sortie est
identique, seulement plus lente. Un seul chemin de code côté appelants.

Thread-safety : une PyTessBaseAPI n'est PAS thread-safe. Le pool de threads
d'analyze_video parallélise les OCR timer/score ; on garde donc un cache
thread-local — chaque worker possède ses propres instances.
"""
import os
import threading

_IMPORT_ERROR = ''
try:
    from tesserocr import PyTessBaseAPI, PSM as _PSM
    _HAVE_TESSEROCR = True
except Exception as _exc:
    _HAVE_TESSEROCR = False
    _IMPORT_ERROR = f'{type(_exc).__name__}: {_exc}'

import sys
import pytesseract

_TL = threading.local()

# Diagnostic une seule fois (stderr) sous EVA_OCR_DEBUG=1 : quel backend OCR
# est réellement actif dans le binaire bundlé, et pourquoi le cas échéant.
_DEBUG = os.environ.get('EVA_OCR_DEBUG') == '1'
_DIAG_EMITTED = False


def _diag(runtime_error=''):
    global _DIAG_EMITTED
    if not _DEBUG or _DIAG_EMITTED:
        return
    _DIAG_EMITTED = True
    if _HAVE_TESSEROCR and not runtime_error:
        msg = '[eva_ocr] backend=tesserocr (in-process)'
    elif _HAVE_TESSEROCR and runtime_error:
        msg = f'[eva_ocr] backend=pytesseract FALLBACK (tesserocr runtime error: {runtime_error})'
    else:
        msg = f'[eva_ocr] backend=pytesseract FALLBACK (import failed: {_IMPORT_ERROR})'
    print(msg, file=sys.stderr, flush=True)

# PSM entier (config CLI tesseract) -> enum tesserocr.
_PSM_BY_INT = {}
if _HAVE_TESSEROCR:
    _PSM_BY_INT = {
        0: _PSM.OSD_ONLY, 1: _PSM.AUTO_OSD, 2: _PSM.AUTO_ONLY, 3: _PSM.AUTO,
        4: _PSM.SINGLE_COLUMN, 5: _PSM.SINGLE_BLOCK_VERT_TEXT,
        6: _PSM.SINGLE_BLOCK, 7: _PSM.SINGLE_LINE, 8: _PSM.SINGLE_WORD,
        9: _PSM.CIRCLE_WORD, 10: _PSM.SINGLE_CHAR, 11: _PSM.SPARSE_TEXT,
        12: _PSM.SPARSE_TEXT_OSD, 13: _PSM.RAW_LINE,
    }


def available() -> bool:
    """True si l'API in-process est utilisable (sinon on tombe sur subprocess)."""
    return _HAVE_TESSEROCR


def _tessdata_dir():
    """Répertoire tessdata pour tesserocr (= TESSDATA_PREFIX si défini, avec
    séparateur final). None → tesserocr utilise son chemin compilé par défaut,
    miroir du comportement de pytesseract qui lit la même variable."""
    p = (os.environ.get('TESSDATA_PREFIX', '') or '').strip()
    if not p:
        return None
    return p if p.endswith(os.sep) else p + os.sep


def _get_api(lang, user_words_file):
    cache = getattr(_TL, 'apis', None)
    if cache is None:
        cache = {}
        _TL.apis = cache
    key = (lang, user_words_file)
    api = cache.get(key)
    if api is None:
        kwargs = {'lang': lang, 'psm': _PSM.SINGLE_LINE}
        d = _tessdata_dir()
        if d:
            kwargs['path'] = d
        # user_words_file doit être chargé à l'init (load du dawg) — on le passe
        # en variable de construction et on clé le cache dessus.
        if user_words_file:
            kwargs['variables'] = {'user_words_file': user_words_file}
        api = PyTessBaseAPI(**kwargs)
        cache[key] = api
    return api


def recognize(image, lang='eng', psm=7, whitelist='', user_words_file=None) -> str:
    """OCR `image` (PIL.Image) et retourne le texte brut, newline final inclus
    comme pytesseract.image_to_string (les appelants strippent déjà).

    Réutilise une API résidente par (lang, user_words). Fallback subprocess si
    tesserocr indisponible ou sur erreur runtime."""
    if _HAVE_TESSEROCR:
        try:
            api = _get_api(lang, user_words_file)
            api.SetPageSegMode(_PSM_BY_INT.get(psm, _PSM.SINGLE_LINE))
            # Toujours réécrit (l'API est réutilisée entre appels de whitelists
            # différentes) ; '' = aucune restriction.
            api.SetVariable('tessedit_char_whitelist', whitelist or '')
            api.SetImage(image)
            out = api.GetUTF8Text()
            _diag()
            return out
        except Exception as exc:
            _diag(runtime_error=f'{type(exc).__name__}: {exc}')
            # bascule subprocess
    else:
        _diag()
    return _subprocess_recognize(image, lang, psm, whitelist, user_words_file)


def probe():
    """Diagnostic : OCR d'essai sur une image générée pour rapporter le backend
    RÉELLEMENT actif (import ET runtime). Un binaire bundlé peut importer
    tesserocr mais échouer à l'init PyTessBaseAPI si une DLL / cysignals manque —
    ce probe l'attrape là où `available()` (import seul) ne le verrait pas.
    Retourne (backend, detail). Aucune vidéo ni ffmpeg requis."""
    from PIL import Image
    img = Image.new('RGB', (120, 40), (255, 255, 255))
    if _HAVE_TESSEROCR:
        try:
            api = _get_api('eng', None)
            api.SetPageSegMode(_PSM.SINGLE_LINE)
            api.SetVariable('tessedit_char_whitelist', '')
            api.SetImage(img)
            api.GetUTF8Text()
            return ('tesserocr', 'in-process API OK')
        except Exception as exc:
            return ('pytesseract', f'tesserocr imported but runtime failed: {type(exc).__name__}: {exc}')
    return ('pytesseract', f'tesserocr import failed: {_IMPORT_ERROR}')


def _subprocess_recognize(image, lang, psm, whitelist, user_words_file) -> str:
    cfg = f'--psm {psm}'
    if whitelist:
        cfg += f' -c tessedit_char_whitelist={whitelist}'
    if user_words_file:
        cfg += f' -c user_words_file={user_words_file}'
    return pytesseract.image_to_string(image, lang=lang, config=cfg)
