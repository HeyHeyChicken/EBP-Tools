@echo off
REM Copyright (c) 2026, Antoine Duval
REM Build the Python video analyzer for Windows using PyInstaller.
REM Run from the python\ directory: build.bat

echo Creating isolated virtual environment...
python -m venv .venv
call .venv\Scripts\activate.bat

echo Installing dependencies...
pip install -r requirements.txt

REM In-process OCR (~3.65x). tesserocr can't compile from source on Windows, so
REM we install simonflueckiger's prebuilt wheel (cp312, bundles tesseract DLLs).
REM Requires the Python interpreter to be 3.12 (pinned in CI via setup-python).
echo Installing prebuilt tesserocr wheel...
pip install "https://github.com/simonflueckiger/tesserocr-windows_build/releases/download/tesserocr-v2.10.0-tesseract-5.5.2/tesserocr-2.10.0-cp312-cp312-win_amd64.whl"

REM Only bundle tesserocr if it imported successfully; otherwise the build still
REM works via eva_ocr's pytesseract fallback (no --collect-all on a missing module).
set "TESSEROCR_FLAG="
python -c "import tesserocr" 2>nul && set "TESSEROCR_FLAG=--collect-all tesserocr"

set TESS_DIR=C:\Program Files\Tesseract-OCR

echo Building Windows binary with PyInstaller (embedding Tesseract)...
pyinstaller --onefile --name win32 %TESSEROCR_FLAG% ^
  --collect-all onnxruntime ^
  --exclude-module torch ^
  --exclude-module torchvision ^
  --add-data "%TESS_DIR%\tesseract.exe;tesseract" ^
  --add-data "%TESS_DIR%\*.dll;tesseract" ^
  --add-data "%TESS_DIR%\tessdata\eng.traineddata;tesseract\tessdata" ^
  --add-data "tessdata\evadigits.traineddata;tesseract\tessdata" ^
  --add-data "tessdata\evapseudos.traineddata;tesseract\tessdata" ^
  --add-data "templates;templates" ^
  --add-data "models;models" ^
  analyze_video.py

call deactivate

echo Moving binary to binaries\analyzer\win32.exe...
if not exist "..\binaries\analyzer" mkdir "..\binaries\analyzer"
move dist\win32.exe ..\binaries\analyzer\win32.exe

echo Cleaning up PyInstaller artifacts...
rmdir /s /q build
rmdir /s /q dist
del win32.spec

echo Done! Binary at ..\binaries\analyzer\win32.exe
