#!/usr/bin/env python3
# Copyright (c) 2026, Antoine Duval
# Build the Python video analyzer for Linux using PyInstaller.
# Called by build_linux.sh — must be run from the python/ directory with the venv active.
# Tesseract binary is NOT bundled: it is declared as a .deb dependency and installed by apt.
# But we DO bundle traineddata (eng + evadigits) so the system tesseract can find them
# via TESSDATA_PREFIX set at runtime by analyze_video.py.

import os

import PyInstaller.__main__


def _find_system_eng_traineddata() -> str:
    """Locate eng.traineddata installed by apt (tesseract-ocr-eng)."""
    for c in (
        "/usr/share/tesseract-ocr/4.00/tessdata/eng.traineddata",
        "/usr/share/tesseract-ocr/5/tessdata/eng.traineddata",
        "/usr/share/tessdata/eng.traineddata",
        "/usr/share/tesseract-ocr/tessdata/eng.traineddata",
    ):
        if os.path.isfile(c):
            return c
    raise FileNotFoundError(
        "eng.traineddata not found. Install with `apt install tesseract-ocr-eng`."
    )


def main() -> None:
    eng = _find_system_eng_traineddata()
    repo_tessdata = os.path.join(os.path.dirname(__file__), "tessdata")
    repo_templates = os.path.join(os.path.dirname(__file__), "templates")
    repo_models = os.path.join(os.path.dirname(__file__), "models")
    args = [
        "--onedir",
        "--name", "linux",
        # onnxruntime : utilisé par digit_classifier.py via une session
        # `InferenceSession(digit_cnn.onnx)`. Collect-all pour bundler
        # les libs natives chargées dynamiquement au runtime.
        "--collect-all", "onnxruntime",
        # Exclusions : torch/torchvision uniquement pour train_cnn.py
        # (training dev). Évite ~275 MB de PyTorch dans le bundle.
        "--exclude-module", "torch",
        "--exclude-module", "torchvision",
        "--add-data", f"{eng}:tesseract/tessdata",
        "--add-data", f"{repo_tessdata}/evadigits.traineddata:tesseract/tessdata",
        "--add-data", f"{repo_tessdata}/evapseudos.traineddata:tesseract/tessdata",
        # Templates : détection d'arme + headshot (killfeed),
        # loading_logo (écran de loading), playing_top (ancre HUD haute),
        # minimaps (templates + JSON metadata par map).
        "--add-data", f"{repo_templates}:templates",
        # Modèles ML : digit_cnn.onnx pour la classification des chiffres
        # joueurs sur la minimap (player tracking).
        "--add-data", f"{repo_models}:models",
        "analyze_video.py",
    ]
    print("Running PyInstaller...")
    PyInstaller.__main__.run(args)


if __name__ == "__main__":
    main()
