#!/bin/bash
# Rejoue une vidéo de soirée dans le spool du mode salle : découpe en segments
# de 5 min nommés comme la captation réelle (rec_%Y%m%d-%H%M%S.mkv, heure LOCALE).
#
#   ./temp_repool.sh <video> ["YYYY-MM-DD HH:MM:SS"] [spool]
#
# Le 2e argument est l'heure d'horloge correspondant à la PREMIÈRE IMAGE de la
# vidéo (pas au début de la 1re game). C'est cette ancre qui doit être juste à
# moins de 3 min, sinon `/arena/games/resolve` ne retrouvera pas les games.
#
# Pourquoi ne pas utiliser -strftime : il nomme les segments avec l'heure
# COURANTE, pas l'heure vidéo — un stream-copy s'exécutant en quelques secondes,
# tous les segments porteraient la même minute.
set -euo pipefail

SRC="${1:?usage: temp_repool.sh <video> [\"YYYY-MM-DD HH:MM:SS\"] [spool]}"
BASE_LOCAL="${2:-2026-07-29 22:48:00}"
SPOOL="${3:-$HOME/EBP-Tools-Arena/spool}"
SEGMENT_SECONDS=300

# Le ffmpeg embarqué du repo (même binaire que celui utilisé par Tools).
REPO="$(cd "$(dirname "$0")" && pwd)"
FFMPEG="$REPO/binaries/ffmpeg/darwin-$(uname -m | sed 's/x86_64/x64/')"
[ -x "$FFMPEG" ] || FFMPEG="$(command -v ffmpeg)"

# --- 1. Contrôles préalables ------------------------------------------------
echo "== Source : $SRC"
"$FFMPEG" -hide_banner -i "$SRC" 2>&1 | grep -E "Duration|Stream #.*Video" || true

RES="$("$FFMPEG" -hide_banner -i "$SRC" 2>&1 | grep -oE '[0-9]{3,4}x[0-9]{3,4}' | head -1)"
if [ "$RES" != "1920x1080" ]; then
    echo "!! Résolution $RES : l'analyseur travaille en coordonnées 1080p ABSOLUES."
    echo "!! La détection échouera. Abandon."
    exit 1
fi

BASE_EPOCH="$(date -j -f "%Y-%m-%d %H:%M:%S" "$BASE_LOCAL" +%s)"
echo "== Ancre : $BASE_LOCAL (epoch $BASE_EPOCH)"

# --- 2. Découpe stream-copy + liste des offsets réels -----------------------
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
echo "== Découpe en segments de ${SEGMENT_SECONDS}s (stream-copy)…"
"$FFMPEG" -hide_banner -v error \
    -i "$SRC" -c copy -f segment \
    -segment_time "$SEGMENT_SECONDS" -reset_timestamps 1 \
    -segment_list "$WORK/list.csv" -segment_list_type csv \
    "$WORK/part_%03d.mkv"

# --- 3. Renommage d'après les offsets réels ---------------------------------
# En stream-copy les coupes tombent sur les keyframes : les segments ne font pas
# exactement 300 s. On prend donc le start RÉEL de chaque segment (colonne 2 du
# CSV) plutôt que i × 300.
mkdir -p "$SPOOL"
echo "== Segments écrits dans $SPOOL :"
while IFS=, read -r FILE START END; do
    OFFSET="${START%.*}"
    NAME="rec_$(date -r "$((BASE_EPOCH + OFFSET))" +%Y%m%d-%H%M%S).mkv"
    mv "$WORK/$(basename "$FILE")" "$SPOOL/$NAME"
    printf '   %s  (offset %6ss → %s)\n' "$NAME" "$OFFSET" "$(date -r "$((BASE_EPOCH + OFFSET))" '+%H:%M:%S')"
done < "$WORK/list.csv"

echo
echo "== Prêt. Démarre Tools (mode salle enregistré) : le pipeline lance un round"
echo "   immédiatement, la captation ne démarre pas en dev donc TOUS les segments"
echo "   sont considérés fermés."
