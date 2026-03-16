#!/usr/bin/env python3
# Copyright (c) 2026, Antoine Duval
# Build the Python video analyzer for Linux using PyInstaller.
# Called by build_linux.sh — must be run from the python/ directory with the venv active.
# Tesseract is NOT bundled: it is declared as a .deb dependency and installed by apt.
# analyze_video.py falls back to the system tesseract when no bundled binary is found.

import PyInstaller.__main__


def main() -> None:
    args = [
        "--onedir",
        "--name", "linux",
        "analyze_video.py",
    ]
    print("Running PyInstaller...")
    PyInstaller.__main__.run(args)


if __name__ == "__main__":
    main()
