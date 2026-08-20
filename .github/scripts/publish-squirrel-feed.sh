#!/usr/bin/env bash
# Copyright (c) 2026, Antoine Duval
# This file is part of a source-visible project.
# See LICENSE for terms. Unauthorized use is prohibited.
#
# Publie le flux Squirrel.Windows : les paquets, puis l'index RELEASES.
#
# Les deux n'ont pas la même nature. Un .nupkg porte sa version dans son nom et
# ne change jamais : on ne le republie pas et on le laisse en cache un an.
# RELEASES est au contraire un index MUTABLE — c'est lui qui énumère les
# versions disponibles — donc réécrit à chaque publication et jamais mis en cache.
set -euo pipefail

SOURCE="out/make/squirrel.windows/x64"
FEED_URL="${S3_ENDPOINT}/${S3_BUCKET}/${FEED_PREFIX}"

aws configure set default.s3.addressing_style path

# Les paquets D'ABORD : RELEASES ne doit jamais désigner un paquet absent, ce
# qui laisserait un client incapable de se mettre à jour le temps du décalage.
for FILE in "$SOURCE"/*.nupkg; do
    NAME="$(basename "$FILE")"
    if curl -sfI "${FEED_URL}/${NAME}" >/dev/null 2>&1; then
        echo "déjà publié : ${NAME}"
        continue
    fi
    echo "téléversement : ${NAME} ($(( $(wc -c < "$FILE") / 1048576 )) Mo)"
    aws s3 cp "$FILE" "s3://${S3_BUCKET}/${FEED_PREFIX}/${NAME}" \
        --endpoint-url "$S3_ENDPOINT" \
        --content-type application/octet-stream \
        --cache-control "public, max-age=31536000, immutable"
done

echo "téléversement : RELEASES"
aws s3 cp "$SOURCE/RELEASES" "s3://${S3_BUCKET}/${FEED_PREFIX}/RELEASES" \
    --endpoint-url "$S3_ENDPOINT" \
    --content-type text/plain \
    --cache-control "no-cache, must-revalidate"

echo "--- flux publié ---"
cat "$SOURCE/RELEASES"
