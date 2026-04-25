cd "$(dirname "$0")"
gmake training MODEL_NAME=evadigits \
    START_MODEL=eng \
    TESSDATA=$(pwd)/data \
    MAX_ITERATIONS=10000
