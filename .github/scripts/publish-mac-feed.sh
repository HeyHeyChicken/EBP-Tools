#!/usr/bin/env bash
# Copyright (c) 2026, Antoine Duval
# This file is part of a source-visible project.
# See LICENSE for terms. Unauthorized use is prohibited.
#
# Publie le flux Squirrel.Mac : l'archive de l'app, puis le manifeste.
#
# Un flux PAR ARCHITECTURE : sans ça un Mac Intel se verrait proposer une app
# Apple Silicon, qui ne démarrerait pas. Le nom de l'archive porte la version,
# elle est donc immuable ; RELEASES.json est au contraire réécrit à chaque
# publication, et jamais mis en cache.
set -euo pipefail

ARCH="$1"
PREFIX="tools/updates/${GITHUB_REPOSITORY}/darwin-${ARCH}"
SOURCE="out/make/zip/darwin/${ARCH}"

aws configure set default.s3.addressing_style path

# L'archive D'ABORD : le manifeste ne doit jamais désigner un fichier absent.
for FILE in "$SOURCE"/*.zip; do
    NAME="$(basename "$FILE")"
    # head-object plutôt qu'une requête HTTP : le nom contient des espaces, et
    # l'API S3 prend la clé littéralement, sans encodage à gérer.
    if aws s3api head-object --bucket "$S3_BUCKET" --key "${PREFIX}/${NAME}" \
        --endpoint-url "$S3_ENDPOINT" >/dev/null 2>&1; then
        echo "déjà publié : ${NAME}"
        continue
    fi
    echo "téléversement : ${NAME} ($(( $(wc -c < "$FILE") / 1048576 )) Mo)"
    aws s3 cp "$FILE" "s3://${S3_BUCKET}/${PREFIX}/${NAME}" \
        --endpoint-url "$S3_ENDPOINT" \
        --content-type application/zip \
        --cache-control "public, max-age=31536000, immutable"
done

echo "téléversement : RELEASES.json"
aws s3 cp "$SOURCE/RELEASES.json" "s3://${S3_BUCKET}/${PREFIX}/RELEASES.json" \
    --endpoint-url "$S3_ENDPOINT" \
    --content-type application/json \
    --cache-control "no-cache, must-revalidate"

echo "--- manifeste publié ---"
cat "$SOURCE/RELEASES.json"
