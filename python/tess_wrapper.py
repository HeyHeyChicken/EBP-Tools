# Copyright (c) 2026, Antoine Duval
# This file is part of a source-visible project.
# See LICENSE for terms. Unauthorized use is prohibited.

"""
In-process Tesseract OCR via ctypes + libtesseract C API.

Drop-in replacement for pytesseract.image_to_string() that eliminates
the per-call subprocess spawn overhead (~150-300 ms on Windows).
The tessdata model stays loaded in memory per thread.

Thread safety: one TessBaseAPI instance per (thread, language), stored
in threading.local(). ThreadPoolExecutor reuses threads, so the model
is initialized once per worker thread and reused for all subsequent calls.
"""

import ctypes
import os
import re
import sys
import threading
from typing import Optional

import numpy as np
from PIL import Image

_PSM_RE = re.compile(r'--psm\s+(\d+)')
# Matches both:  -c varname=value   and   -c "varname=value"
_VAR_RE = re.compile(r'-c\s+"?(\w+)=([^"\s]+)"?')


def find_libtesseract() -> Optional[str]:
    """Return the path to libtesseract DLL/SO, or None if not found."""
    if sys.platform == 'win32':
        candidates = []
        base = getattr(sys, '_MEIPASS', '')
        if base:
            candidates += [
                os.path.join(base, 'tesseract', 'libtesseract-5.dll'),
                os.path.join(base, 'libtesseract-5.dll'),
            ]
        candidates += [
            r'C:\Program Files\Tesseract-OCR\libtesseract-5.dll',
            r'C:\Program Files (x86)\Tesseract-OCR\libtesseract-5.dll',
        ]
        import shutil
        exe = shutil.which('tesseract')
        if exe:
            candidates.append(os.path.join(os.path.dirname(exe), 'libtesseract-5.dll'))
        for p in candidates:
            if p and os.path.isfile(p):
                return p
    elif sys.platform == 'darwin':
        for p in (
            '/opt/homebrew/lib/libtesseract.dylib',
            '/usr/local/lib/libtesseract.dylib',
        ):
            if os.path.isfile(p):
                return p
    else:
        import ctypes.util
        lib = ctypes.util.find_library('tesseract')
        if lib:
            return lib
    return None


class TessWrapper:
    """
    Thread-safe in-process Tesseract OCR via libtesseract C API.

    One TessBaseAPI per (thread, language). Model is loaded once per thread
    on first use and kept alive for the process lifetime.
    Compatible with pytesseract.image_to_string() signature.
    """

    def __init__(self, dll_path: str):
        if sys.platform == 'win32':
            dll_dir = os.path.dirname(dll_path)
            if dll_dir:
                os.add_dll_directory(dll_dir)
            dll = ctypes.WinDLL(dll_path)
        else:
            dll = ctypes.CDLL(dll_path)

        # Declare C API signatures once (global to the DLL object).
        dll.TessBaseAPICreate.restype = ctypes.c_void_p
        dll.TessBaseAPICreate.argtypes = []

        dll.TessBaseAPIInit3.restype = ctypes.c_int
        dll.TessBaseAPIInit3.argtypes = [
            ctypes.c_void_p, ctypes.c_char_p, ctypes.c_char_p]

        dll.TessBaseAPISetPageSegMode.restype = None
        dll.TessBaseAPISetPageSegMode.argtypes = [ctypes.c_void_p, ctypes.c_int]

        dll.TessBaseAPISetVariable.restype = ctypes.c_int
        dll.TessBaseAPISetVariable.argtypes = [
            ctypes.c_void_p, ctypes.c_char_p, ctypes.c_char_p]

        # imagedata is passed as a raw pointer (c_void_p) to avoid copies.
        dll.TessBaseAPISetImage.restype = None
        dll.TessBaseAPISetImage.argtypes = [
            ctypes.c_void_p,  # handle
            ctypes.c_void_p,  # imagedata
            ctypes.c_int,     # width
            ctypes.c_int,     # height
            ctypes.c_int,     # bytes_per_pixel
            ctypes.c_int,     # bytes_per_line
        ]

        # Return raw pointer so we can free it with TessDeleteText.
        dll.TessBaseAPIGetUTF8Text.restype = ctypes.c_void_p
        dll.TessBaseAPIGetUTF8Text.argtypes = [ctypes.c_void_p]

        dll.TessBaseAPIClear.restype = None
        dll.TessBaseAPIClear.argtypes = [ctypes.c_void_p]

        dll.TessBaseAPIDelete.restype = None
        dll.TessBaseAPIDelete.argtypes = [ctypes.c_void_p]

        dll.TessDeleteText.restype = None
        dll.TessDeleteText.argtypes = [ctypes.c_void_p]

        self._dll = dll
        self._local = threading.local()

    def _get_api(self, lang: str):
        """Return the thread-local TessBaseAPI for lang, creating it if needed.
        Failed inits are cached per thread so we don't retry on every call."""
        if not hasattr(self._local, 'apis'):
            self._local.apis = {}
            self._local.failed = set()
        if lang in self._local.failed:
            raise RuntimeError(f'TessBaseAPIInit3 already failed (lang={lang!r})')
        if lang not in self._local.apis:
            api = self._dll.TessBaseAPICreate()
            if not api:
                self._local.failed.add(lang)
                raise RuntimeError('TessBaseAPICreate returned NULL')
            tessdata_env = os.environ.get('TESSDATA_PREFIX', '')
            tessdata_b = tessdata_env.encode() if tessdata_env else None
            ret = self._dll.TessBaseAPIInit3(api, tessdata_b, lang.encode())
            if ret != 0:
                self._dll.TessBaseAPIDelete(api)
                self._local.failed.add(lang)
                raise RuntimeError(f'TessBaseAPIInit3 failed (lang={lang!r})')
            self._local.apis[lang] = api
        return self._local.apis[lang]

    def image_to_string(self, image, lang: str = 'eng', config: str = '') -> str:
        """
        Drop-in for pytesseract.image_to_string().
        Returns recognized text (stripped, CR/LF removed).
        image: PIL.Image or np.ndarray (grayscale or RGB).
        """
        api = self._get_api(lang)

        # PSM
        m = _PSM_RE.search(config)
        self._dll.TessBaseAPISetPageSegMode(api, int(m.group(1)) if m else 3)

        # Config variables — always reset whitelist so it doesn't bleed
        # between calls with different character sets.
        whitelist_set = False
        for m in _VAR_RE.finditer(config):
            k, v = m.group(1), m.group(2)
            self._dll.TessBaseAPISetVariable(api, k.encode(), v.encode())
            if k == 'tessedit_char_whitelist':
                whitelist_set = True
        if not whitelist_set:
            self._dll.TessBaseAPISetVariable(
                api, b'tessedit_char_whitelist', b'')

        # Convert image to a C-contiguous grayscale array.
        if isinstance(image, Image.Image):
            arr = np.asarray(image.convert('L'))
        elif isinstance(image, np.ndarray):
            if image.ndim == 3:
                arr = np.asarray(Image.fromarray(image).convert('L'))
            else:
                arr = image
        else:
            arr = np.asarray(image)

        if not arr.flags['C_CONTIGUOUS']:
            arr = np.ascontiguousarray(arr)

        h, w = arr.shape[:2]
        bpp = arr.shape[2] if arr.ndim == 3 else 1
        self._dll.TessBaseAPISetImage(
            api, arr.ctypes.data_as(ctypes.c_void_p), w, h, bpp, w * bpp)

        ptr = self._dll.TessBaseAPIGetUTF8Text(api)
        if ptr:
            text = ctypes.string_at(ptr).decode('utf-8', errors='replace')
            self._dll.TessDeleteText(ptr)
        else:
            text = ''

        self._dll.TessBaseAPIClear(api)
        return text.replace('\r', '').replace('\n', '').strip()


# ---------------------------------------------------------------------------
# Module-level singleton — initialized lazily on first use so that
# TESSDATA_PREFIX (set by main()) is already in the environment.
# ---------------------------------------------------------------------------

_wrapper: Optional[TessWrapper] = None
_wrapper_tried = False


def get_wrapper() -> Optional[TessWrapper]:
    """Return the global TessWrapper, initializing if needed. None on failure."""
    global _wrapper, _wrapper_tried
    if _wrapper_tried:
        return _wrapper
    _wrapper_tried = True
    dll_path = find_libtesseract()
    if not dll_path:
        return None
    try:
        _wrapper = TessWrapper(dll_path)
    except Exception:
        pass
    return _wrapper
