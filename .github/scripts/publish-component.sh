#!/usr/bin/env bash
# Copyright (c) 2026, Antoine Duval
# This file is part of a source-visible project.
# See LICENSE for terms. Unauthorized use is prohibited.
#
# Archive (si besoin), nomme par empreinte, téléverse et vérifie un composant.
# Usage : publish-component.sh <plateforme> <source> [exec-dans-l-archive]
#   <source> est un DOSSIER (composant archivé) ou un FICHIER (exécutable nu).
#   Le 3e argument, présent seulement pour un dossier, est le chemin de
#   l'exécutable À L'INTÉRIEUR de l'archive — c'est lui qui fait de l'entrée un
#   composant archive côté client (cf. component-service).
set -euo pipefail

PLATFORM="$1"
SOURCE_DIR="$2"
EXEC="${3:-}"

DATE="$(date -u +%Y%m%d)"

# État de la source dont ce binaire est issu. `git rev-parse HEAD:python` donne
# l'empreinte de l'arbre du dossier : elle change dès qu'un fichier suivi change,
# et ne change pas autrement. C'est ce qui permettra au workflow de release de
# refuser de livrer une version dont l'analyzer publié ne correspond plus au code.
PYTHON_SOURCE="$(git rev-parse HEAD:python | cut -c1-12)"

hash_of() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d' ' -f1
    else
        shasum -a 256 "$1" | cut -d' ' -f1
    fi
}

if [ -n "$EXEC" ]; then
    ARCHIVE="$(pwd)/component-payload.zip"
    rm -f "$ARCHIVE"
    case "$(uname -s)" in
        Darwin)
            # --norsrc --noextattr : sans eux ditto ajoute des fichiers
            # AppleDouble (._*) qui se retrouveraient extraits tels quels chez
            # l'utilisateur. La signature, elle, est embarquée dans le Mach-O et
            # survit à l'archivage.
            ditto -c -k --norsrc --noextattr --keepParent "$SOURCE_DIR" "$ARCHIVE"
            ;;
        *)
            (cd "$(dirname "$SOURCE_DIR")" && zip -q -r -X "$ARCHIVE" "$(basename "$SOURCE_DIR")")
            ;;
    esac
    PAYLOAD="$ARCHIVE"
    EXTENSION="zip"
else
    PAYLOAD="$SOURCE_DIR"
    EXTENSION="exe"
fi

SHA="$(hash_of "$PAYLOAD")"
ASSET="analyzer-${DATE}-${PLATFORM}-${SHA:0:12}.${EXTENSION}"
URL="${S3_ENDPOINT}/${S3_BUCKET}/${S3_PREFIX}/${ASSET}"

echo "plateforme : ${PLATFORM}"
echo "asset      : ${ASSET}"
echo "source     : ${PYTHON_SOURCE}"
echo "poids      : $(( $(wc -c < "$PAYLOAD") / 1048576 )) Mo"

# Le nom contenant l'empreinte, un objet déjà présent a forcément le même
# contenu : le repousser ne ferait que gaspiller une centaine de Mo.
if curl -sfI "$URL" >/dev/null 2>&1; then
    echo "déjà publié — rien à téléverser"
else
    aws configure set default.s3.addressing_style path
    aws s3 cp "$PAYLOAD" "s3://${S3_BUCKET}/${S3_PREFIX}/${ASSET}" \
        --endpoint-url "$S3_ENDPOINT" \
        --content-type application/octet-stream \
        --cache-control "public, max-age=31536000, immutable"

    # Relecture ANONYME et revérification de l'empreinte : c'est exactement ce
    # que fera le client. Un téléversement tronqué, ou un objet non lisible
    # publiquement, doit échouer ici plutôt que chez l'utilisateur.
    echo "vérification de bout en bout…"
    curl -sfS -o downloaded-check "$URL"
    DOWNLOADED="$(hash_of downloaded-check)"
    rm -f downloaded-check
    if [ "$DOWNLOADED" != "$SHA" ]; then
        echo "::error::L'objet publié ne correspond pas (attendu ${SHA}, obtenu ${DOWNLOADED})"
        exit 1
    fi
    echo "publié et vérifié"
fi

if [ -n "$EXEC" ]; then
    ENTRY="\"${PLATFORM}\": { \"asset\": \"${ASSET}\", \"sha256\": \"${SHA}\", \"exec\": \"${EXEC}\", \"source\": \"${PYTHON_SOURCE}\" },"
else
    ENTRY="\"${PLATFORM}\": { \"asset\": \"${ASSET}\", \"sha256\": \"${SHA}\", \"source\": \"${PYTHON_SOURCE}\" },"
fi

echo "entry=${ENTRY}" >> "$GITHUB_OUTPUT"
{
    echo "### ${PLATFORM}"
    echo '```json'
    echo "    ${ENTRY}"
    echo '```'
} >> "$GITHUB_STEP_SUMMARY"
