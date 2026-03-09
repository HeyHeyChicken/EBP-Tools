@echo off
REM Copyright (c) 2026, Antoine Duval
REM Build the Python video analyzer for Windows using PyInstaller.
REM Run from the python\ directory: build.bat

echo Creating isolated virtual environment...
python -m venv .venv
call .venv\Scripts\activate.bat

echo Installing dependencies...
pip install -r requirements.txt

set TESS_DIR=C:\Program Files\Tesseract-OCR

echo Building Windows binary with PyInstaller (embedding Tesseract)...
pyinstaller --onefile --name win32 ^
  --add-data "%TESS_DIR%\tesseract.exe;tesseract" ^
  --add-data "%TESS_DIR%\*.dll;tesseract" ^
  --add-data "%TESS_DIR%\tessdata\eng.traineddata;tesseract\tessdata" ^
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
