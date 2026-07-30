@echo off
setlocal
REM ============================================================================
REM Rejoue une video de soiree dans le spool du mode salle : decoupe en segments
REM de 5 min nommes comme la captation reelle (rec_AAAAMMJJ-HHMMSS.mkv, heure
REM LOCALE de la machine).
REM
REM   temp_repool.bat <video> ["AAAA-MM-JJ HH:MM:SS"] [spool]
REM
REM <video> peut etre un chemin complet OU le simple nom du fichier s'il est
REM deja dans le spool.
REM
REM Le 2e argument est l'heure d'horloge de la PREMIERE IMAGE de la video (pas
REM celle de la 1re game) : c'est l'ancre du recalage. Elle doit etre juste a
REM moins de 3 min, sinon /arena/games/resolve ne retrouvera pas les games.
REM
REM Pourquoi pas -strftime : il nomme les segments avec l'heure COURANTE, pas
REM l'heure video. Un stream-copy durant quelques secondes, tous les segments
REM porteraient la meme minute.
REM ============================================================================

if "%~1"=="" (
    echo usage: temp_repool.bat ^<video^> ["AAAA-MM-JJ HH:MM:SS"] [spool]
    exit /b 1
)

set "SRC=%~1"
set "BASE_LOCAL=%~2"
if "%BASE_LOCAL%"=="" set "BASE_LOCAL=2026-07-29 22:48:00"
set "SPOOL=%~3"
if "%SPOOL%"=="" set "SPOOL=%USERPROFILE%\EBP-Tools-Arena\spool"
set "SEGMENT_SECONDS=300"

REM ffmpeg embarque du repo (meme binaire que celui utilise par Tools).
set "FFMPEG=%~dp0binaries\ffmpeg\win32.exe"
if not exist "%FFMPEG%" set "FFMPEG=ffmpeg"

REM Video donnee par son seul nom : on la cherche dans le spool.
if not exist "%SRC%" if exist "%SPOOL%\%SRC%" set "SRC=%SPOOL%\%SRC%"
if not exist "%SRC%" (
    echo !! Video introuvable : %SRC%
    exit /b 1
)

REM --- 1. Controles prealables ------------------------------------------------
echo == Source : %SRC%
"%FFMPEG%" -hide_banner -i "%SRC%" 2>&1 | findstr /C:"Duration" /C:"Video:"

"%FFMPEG%" -hide_banner -i "%SRC%" 2>&1 | findstr /C:"1920x1080" >nul
if errorlevel 1 (
    echo.
    echo !! La source n'est pas en 1920x1080. L'analyseur travaille en
    echo !! coordonnees 1080p ABSOLUES : la detection echouerait. Abandon.
    exit /b 1
)

echo == Ancre : %BASE_LOCAL%

REM --- 2. Decoupe stream-copy + liste des offsets reels -----------------------
set "WORK=%TEMP%\repool_%RANDOM%%RANDOM%"
mkdir "%WORK%" || exit /b 1

echo == Decoupe en segments de %SEGMENT_SECONDS%s (stream-copy)...
"%FFMPEG%" -hide_banner -v error -i "%SRC%" -c copy -f segment ^
    -segment_time %SEGMENT_SECONDS% -reset_timestamps 1 ^
    -segment_list "%WORK%\list.csv" -segment_list_type csv ^
    "%WORK%\part_%%03d.mkv"
if errorlevel 1 (
    echo !! ffmpeg a echoue.
    rd /s /q "%WORK%"
    exit /b 1
)

REM --- 3. Renommage d'apres les offsets reels ---------------------------------
REM En stream-copy les coupes tombent sur les keyframes : les segments ne font
REM pas exactement 300 s. On lit donc le start REEL de chaque segment (colonne 2
REM du CSV) plutot que i x 300. Les lignes du CSV sont dans l'ordre de sortie,
REM donc la ligne N correspond a part_00N.
if not exist "%SPOOL%" mkdir "%SPOOL%"
set /a IDX=-1
echo == Segments ecrits dans %SPOOL% :
for /f "usebackq tokens=2 delims=," %%s in ("%WORK%\list.csv") do call :emit "%%s"

rd /s /q "%WORK%"
echo.
echo == Pret. Demarre Tools (mode salle enregistre) : le pipeline lance un round
echo    immediatement. La video source reste dans le spool mais est IGNOREE par
echo    le pipeline (son nom ne correspond pas a rec_*.mkv) : tu peux la
echo    supprimer, elle occupe juste de la place.
exit /b 0

REM ---------------------------------------------------------------------------
:emit
set /a IDX+=1
set "PAD=00%IDX%"
set "PAD=%PAD:~-3%"
set "PART=%WORK%\part_%PAD%.mkv"
if not exist "%PART%" (
    echo    !! segment attendu manquant : %PART%
    goto :eof
)
REM Offset entier (le CSV donne des secondes decimales).
for /f "tokens=1 delims=." %%x in ("%~1") do set "OFFSET=%%x"
if "%OFFSET%"=="" set "OFFSET=0"
REM Arithmetique de dates : PowerShell, en culture invariante pour que le format
REM de l'ancre soit lu pareil quelle que soit la locale de la machine.
for /f "usebackq delims=" %%d in (`powershell -NoProfile -Command "[datetime]::ParseExact('%BASE_LOCAL%','yyyy-MM-dd HH:mm:ss',[cultureinfo]::InvariantCulture).AddSeconds(%OFFSET%).ToString('yyyyMMdd-HHmmss')"`) do set "STAMP=%%d"
if "%STAMP%"=="" (
    echo    !! calcul de date echoue pour l'offset %OFFSET%s
    goto :eof
)
move "%PART%" "%SPOOL%\rec_%STAMP%.mkv" >nul
echo    rec_%STAMP%.mkv  ^(offset %OFFSET%s^)
goto :eof
