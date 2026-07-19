#!/bin/bash
# Copyright (c) 2026, Antoine Duval
# This file is part of a source-visible project.
# See LICENSE for terms. Unauthorized use is prohibited.
#
# DEV — Mode salle : remplit le spool du pipeline arène à partir d'un VOD,
# sans attendre la captation réelle. Découpe le VOD en segments de 5 min
# (stream-copy, sans audio comme la captation réelle) nommés/datés comme la
# brique de captation, antidatés pour que le dernier se termine "maintenant".
#
# Usage : ./scripts/dev_fill_spool.sh <vod.mp4> [dossier_spool]
# Puis : mode salle actif + captation ARRÊTÉE → le round de rattrapage (≤60 s)
# analyse tout. Redémarrer Tools après dépôt si une session tournait déjà
# (le watermark en mémoire pourrait ignorer les segments antidatés).

set -euo pipefail

VOD="${1:?usage: dev_fill_spool.sh <vod> [spool_dir]}"
SPOOL="${2:-$HOME/EBP-Tools-Arena/spool}"
SEGMENT_S=300

FFMPEG="$(dirname "$0")/../binaries/ffmpeg/darwin-arm64"
[ -x "$FFMPEG" ] || FFMPEG=ffmpeg

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Découpe de $VOD en segments de ${SEGMENT_S}s..."
"$FFMPEG" -hide_banner -loglevel error -i "$VOD" \
    -an -c copy \
    -f segment -segment_time "$SEGMENT_S" -reset_timestamps 1 \
    "$TMP/seg_%03d.mkv"

mkdir -p "$SPOOL"
N=$(ls "$TMP"/seg_*.mkv | wc -l | tr -d ' ')
NOW=$(date +%s)
i=0
for f in "$TMP"/seg_*.mkv; do
    EPOCH=$((NOW - (N - i) * SEGMENT_S))
    if date -r "$EPOCH" +%Y%m%d-%H%M%S >/dev/null 2>&1; then
        STAMP=$(date -r "$EPOCH" +%Y%m%d-%H%M%S)   # macOS
    else
        STAMP=$(date -d "@$EPOCH" +%Y%m%d-%H%M%S)  # Linux
    fi
    mv "$f" "$SPOOL/rec_$STAMP.mkv"
    i=$((i + 1))
done

echo "$N segment(s) déposés dans $SPOOL :"
ls -la "$SPOOL"/rec_*.mkv
