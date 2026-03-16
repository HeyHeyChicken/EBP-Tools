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

# Collect all non-system (Homebrew) dylib dependencies of a binary recursively.
# Uses a temp file as a "seen" set to avoid infinite loops and duplicates.
# Outputs one absolute resolved path per line.
SEEN_FILE=$(mktemp)
DYLIB_LIST_FILE=$(mktemp)

collect_dylibs() {
    local lib="$1"
    # Resolve symlinks so canonical path is used for dedup
    local real
    real=$(python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$lib" 2>/dev/null) || real="$lib"
    grep -qF "$real" "$SEEN_FILE" 2>/dev/null && return
    echo "$real" >> "$SEEN_FILE"

    otool -L "$lib" 2>/dev/null | tail -n +2 | awk '{print $1}' | while read -r dep; do
        case "$dep" in
            /opt/homebrew/*|/usr/local/*)
                [ -f "$dep" ] || continue
                local real_dep
                real_dep=$(python3 -c "import os,sys; print(os.path.realpath(sys.argv[1]))" "$dep" 2>/dev/null) || real_dep="$dep"
                if ! grep -qF "$real_dep" "$DYLIB_LIST_FILE" 2>/dev/null; then
                    echo "$dep" >> "$DYLIB_LIST_FILE"
                fi
                collect_dylibs "$dep"
                ;;
        esac
    done
}

echo "Collecting Tesseract dylib dependencies recursively..."
collect_dylibs "$TESS_BIN"

# Build the --add-binary arguments array from collected dylibs
EXTRA_BINARY_ARGS=()
while IFS= read -r dylib; do
    echo "  + $(basename "$dylib")"
    EXTRA_BINARY_ARGS+=("--add-binary" "${dylib}:tesseract")
done < "$DYLIB_LIST_FILE"

rm -f "$SEEN_FILE" "$DYLIB_LIST_FILE"

echo "Building macOS binary with PyInstaller (embedding Tesseract)..."
# --onedir instead of --onefile: all files (Python.framework, dylibs) are extracted
# at build time into a directory, so they can be individually code-signed before
# packaging. --onefile extracts to /tmp at runtime, making pre-signing impossible.
python3 -m PyInstaller --onedir --name darwin \
  --add-data "${TESS_BIN}:tesseract" \
  --add-data "${TESS_DATA}/eng.traineddata:tesseract/tessdata" \
  "${EXTRA_BINARY_ARGS[@]}" \
  analyze_video.py

deactivate

echo "Moving binary to binaries/analyzer/darwin..."
mkdir -p ../binaries/analyzer
rm -rf ../binaries/analyzer/darwin
mv dist/darwin ../binaries/analyzer/darwin
chmod +x ../binaries/analyzer/darwin/darwin

echo "Fixing dylib paths in bundled Tesseract binary and dylibs..."
TESS_BUNDLE_DIR="../binaries/analyzer/darwin/_internal/tesseract"
BUNDLED_TESS="${TESS_BUNDLE_DIR}/tesseract"

# Rewrite all Homebrew paths in the bundled tesseract binary itself
otool -L "${BUNDLED_TESS}" | tail -n +2 | awk '{print $1}' | while read -r dep; do
    case "$dep" in
        /opt/homebrew/*|/usr/local/*)
            install_name_tool -change "${dep}" "@loader_path/$(basename "${dep}")" "${BUNDLED_TESS}"
            echo "  [tesseract] ${dep} → @loader_path/$(basename "${dep}")"
            ;;
    esac
done

# Rewrite all Homebrew paths inside each bundled dylib so peers find each other
find "${TESS_BUNDLE_DIR}" -name "*.dylib" | while read -r lib; do
    otool -L "${lib}" | tail -n +2 | awk '{print $1}' | while read -r dep; do
        case "$dep" in
            /opt/homebrew/*|/usr/local/*)
                install_name_tool -change "${dep}" "@loader_path/$(basename "${dep}")" "${lib}"
                echo "  [$(basename "$lib")] ${dep} → @loader_path/$(basename "${dep}")"
                ;;
        esac
    done
done

echo "Cleaning up PyInstaller artifacts..."
rm -rf build dist darwin.spec

echo "Done! Binary at ../binaries/analyzer/darwin"
