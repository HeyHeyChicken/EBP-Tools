#!/usr/bin/env bash
# Copyright (c) 2026, Antoine Duval
# Build the Python video analyzer for macOS using PyInstaller.
# Run from the python/ directory: sh build.sh

set -e

echo "Creating isolated virtual environment..."
python3 -m venv .venv
source .venv/bin/activate

echo "Installing dependencies..."
pip3 install -r requirements.txt

TESS_BIN="/opt/homebrew/bin/tesseract"
TESS_DATA="/opt/homebrew/share/tessdata"
TESS_LIB="/opt/homebrew/lib"

echo "Building macOS binary with PyInstaller (embedding Tesseract)..."
# --onedir instead of --onefile: all files (Python.framework, dylibs) are extracted
# at build time into a directory, so they can be individually code-signed before
# packaging. --onefile extracts to /tmp at runtime, making pre-signing impossible.
python3 -m PyInstaller --onedir --name darwin \
  --add-data "${TESS_BIN}:tesseract" \
  --add-data "${TESS_DATA}/eng.traineddata:tesseract/tessdata" \
  --add-binary "${TESS_LIB}/libtesseract*.dylib:tesseract" \
  --add-binary "${TESS_LIB}/liblept*.dylib:tesseract" \
  analyze_video.py

deactivate

echo "Moving binary to binaries/analyzer/darwin..."
mkdir -p ../binaries/analyzer
rm -rf ../binaries/analyzer/darwin
mv dist/darwin ../binaries/analyzer/darwin
chmod +x ../binaries/analyzer/darwin/darwin

echo "Cleaning up PyInstaller artifacts..."
rm -rf build dist darwin.spec

echo "Done! Binary at ../binaries/analyzer/darwin"
