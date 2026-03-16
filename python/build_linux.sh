#!/usr/bin/env bash
# Copyright (c) 2026, Antoine Duval
# Build the Python video analyzer for Linux using PyInstaller.
# Run from the python/ directory: bash build_linux.sh
# Tesseract is NOT bundled — it is declared as a .deb dependency and installed by apt.

set -e

echo "Creating isolated virtual environment..."
python3 -m venv .venv
source .venv/bin/activate

echo "Installing dependencies..."
pip3 install -r requirements.txt

echo "Building Linux binary with PyInstaller..."
python3 build_linux_pyi.py

deactivate

echo "Moving binary to binaries/analyzer/linux..."
mkdir -p ../binaries/analyzer
rm -rf ../binaries/analyzer/linux
mv dist/linux ../binaries/analyzer/linux
chmod +x ../binaries/analyzer/linux/linux

echo "Cleaning up PyInstaller artifacts..."
rm -rf build dist linux.spec

echo "Done! Binary at ../binaries/analyzer/linux"
