#!/usr/bin/env bash
# Copyright (c) 2026, Antoine Duval
# Build the Python video analyzer for macOS using PyInstaller.
# Run from the python/ directory: bash build.sh

set -e

echo "Creating isolated virtual environment..."
python3 -m venv .venv
source .venv/bin/activate

echo "Installing dependencies..."
# tesserocr/cysignals compile from source on macOS. Pin the build to the host
# arch so a universal2 Python doesn't try to link the missing second-arch
# Homebrew libs (Intel brew ships x86_64-only leptonica). pkg-config (installed
# in CI) lets tesserocr discover the real lib name (-lleptonica, not legacy -llept).
export ARCHFLAGS="-arch $(uname -m)"
pip3 install -r requirements.txt

echo "Building macOS binary with PyInstaller (embedding Tesseract)..."
python3 build_macos_pyi.py

deactivate

echo "Moving binary to binaries/analyzer/darwin..."
mkdir -p ../binaries/analyzer
rm -rf ../binaries/analyzer/darwin
mv dist/darwin ../binaries/analyzer/darwin
chmod +x ../binaries/analyzer/darwin/darwin

echo "Fixing Tesseract rpath in bundled binary and dylibs..."
TESS_BUNDLE_DIR="../binaries/analyzer/darwin/_internal/tesseract"
BUNDLED_TESS="${TESS_BUNDLE_DIR}/tesseract"

# PyInstaller already rewrites absolute Homebrew paths to @rpath/... but sets
# rpath to @loader_path/.. (pointing to _internal/). Since tesseract and all its
# dylibs are in _internal/tesseract/, we add @loader_path so each file finds its
# peers in the same directory.
install_name_tool -add_rpath "@loader_path" "${BUNDLED_TESS}"
echo "  Added @loader_path rpath to tesseract"

find "${TESS_BUNDLE_DIR}" -name "*.dylib" | while read -r lib; do
    install_name_tool -add_rpath "@loader_path" "${lib}"
    echo "  Added @loader_path rpath to $(basename "$lib")"
done

echo "Cleaning up PyInstaller artifacts..."
rm -rf build dist darwin.spec

echo "Done! Binary at ../binaries/analyzer/darwin"
