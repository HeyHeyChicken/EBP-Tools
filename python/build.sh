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

echo "Fixing Tesseract dylib paths for bundled binary..."
BUNDLED_TESS="../binaries/analyzer/darwin/_internal/tesseract/tesseract"
# Récupère les chemins absolus Homebrew référencés dans le binaire original
TESS_DYLIB=$(otool -L "${TESS_BIN}" | grep libtesseract | head -1 | awk '{print $1}')
LEPT_DYLIB=$(otool -L "${TESS_BIN}" | grep liblept | head -1 | awk '{print $1}')
# Réécrit ces chemins en chemins relatifs (@loader_path) pour que le subprocess
# trouve les dylibs embarquées dans _internal/tesseract/ sans dépendre de Homebrew
if [ -n "$TESS_DYLIB" ]; then
    install_name_tool -change "${TESS_DYLIB}" "@loader_path/$(basename ${TESS_DYLIB})" "${BUNDLED_TESS}"
    echo "  Rewritten: ${TESS_DYLIB} → @loader_path/$(basename ${TESS_DYLIB})"
fi
if [ -n "$LEPT_DYLIB" ]; then
    install_name_tool -change "${LEPT_DYLIB}" "@loader_path/$(basename ${LEPT_DYLIB})" "${BUNDLED_TESS}"
    echo "  Rewritten: ${LEPT_DYLIB} → @loader_path/$(basename ${LEPT_DYLIB})"
fi

echo "Cleaning up PyInstaller artifacts..."
rm -rf build dist darwin.spec

echo "Done! Binary at ../binaries/analyzer/darwin"
