#!/usr/bin/env python3
# Copyright (c) 2026, Antoine Duval
# Collect Tesseract dylib dependencies recursively and run PyInstaller.
# Called by build.sh — must be run from the python/ directory with the venv active.

import os
import subprocess

import PyInstaller.__main__

TESS_BIN = "/opt/homebrew/bin/tesseract"
TESS_DATA = "/opt/homebrew/share/tessdata"


def collect_dylibs(binary_path: str) -> list:
    """
    Recursively collect all non-system (Homebrew) dylib dependencies of a binary.
    Deduplicates by resolved (real) path. Returns original (possibly symlink) paths.
    """
    seen_real: set = set()
    result: list = []

    def recurse(path: str) -> None:
        real = os.path.realpath(path)
        if real in seen_real:
            return
        seen_real.add(real)

        try:
            output = subprocess.check_output(["otool", "-L", path], text=True)
        except subprocess.CalledProcessError:
            return

        for line in output.splitlines()[1:]:
            line = line.strip()
            if not line:
                continue
            dep = line.split()[0]
            if not dep.startswith(("/opt/homebrew/", "/usr/local/")):
                continue
            if not os.path.isfile(dep):
                continue
            real_dep = os.path.realpath(dep)
            if real_dep not in seen_real:
                result.append(dep)
                recurse(dep)

    recurse(binary_path)
    return result


def main() -> None:
    print("Collecting Tesseract dylib dependencies recursively...")
    dylibs = collect_dylibs(TESS_BIN)
    for lib in dylibs:
        print(f"  + {os.path.basename(lib)}")
    print(f"  {len(dylibs)} dylib(s) collected.")

    args = [
        "--onedir",
        "--name", "darwin",
        # --onedir instead of --onefile: all files (Python.framework, dylibs) are
        # extracted at build time into a directory, so they can be individually
        # code-signed before packaging. --onefile extracts to /tmp at runtime,
        # making pre-signing impossible.
        "--add-data", f"{TESS_BIN}:tesseract",
        "--add-data", f"{TESS_DATA}/eng.traineddata:tesseract/tessdata",
    ]
    for dylib in dylibs:
        args += ["--add-binary", f"{dylib}:tesseract"]
    args.append("analyze_video.py")

    print("Running PyInstaller...")
    PyInstaller.__main__.run(args)


if __name__ == "__main__":
    main()
