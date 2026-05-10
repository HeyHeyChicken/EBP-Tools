# Copyright (c) 2026, Antoine Duval
# This file is part of a source-visible project.
# See LICENSE for terms. Unauthorized use is prohibited.

"""Entraîne un MLP scikit-learn pour identifier les chiffres joueurs.

Pipeline :
  1. Charge les crops sortis dans `training_data/digits/{0..9, _garbage}/`.
     Chaque crop est en 84×84 (upscale ×4 du natif 21×21).
  2. Downscale → 21×21 grayscale, normalise [0,1].
  3. Augmente : translations ±2px, rotations ±3°, bruit gaussien.
  4. Entraîne un MLP `441 → 128 → 64 → 11` (10 chiffres + garbage).
  5. Évalue avec stratified k-fold split.
  6. Sauvegarde `models/digit_mlp.pkl` (joblib) avec le scaler intégré.

Usage :
    python3 train_digits.py
"""

import os
import sys
import joblib
import numpy as np
import cv2
from sklearn.neural_network import MLPClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report, confusion_matrix

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, 'training_data', 'digits')
MODEL_DIR = os.path.join(HERE, 'models')
MODEL_PATH = os.path.join(MODEL_DIR, 'digit_mlp.pkl')

# Taille de l'image que le modèle voit. Les crops sont stockés en 84×84
# (upscale ×4 pour faciliter le tri humain) ; on downscale à 21×21 (taille
# native) pour l'entraînement, équilibre signal vs nombre de features.
IMG_SIZE = 21
N_FEATURES = IMG_SIZE * IMG_SIZE  # 441

# Étiquettes : 0..9 = chiffres, 10 = garbage. La classe garbage permet au
# modèle de "rejeter" un crop qui n'est pas un chiffre.
GARBAGE_LABEL = 10
LABELS = list(range(10)) + [GARBAGE_LABEL]
LABEL_DIRS = {i: str(i) for i in range(10)}
LABEL_DIRS[GARBAGE_LABEL] = '_garbage'

# Augmentation : combien de variantes par image originale (par classe).
# Plus pour les classes minoritaires, moins pour le garbage qui est déjà
# sur-représenté.
AUG_PER_DIGIT_DEFAULT = 15
AUG_PER_DIGIT_RARE = 60   # pour les classes avec < 15 samples (typiquement 0 et 5)
AUG_PER_GARBAGE = 5
GARBAGE_SAMPLE_CAP = 400   # tirage aléatoire dans _garbage avant augmentation


def _load_crop(path: str) -> np.ndarray:
    """Lit une image, la convertit en grayscale 21×21 normalisé [0,1]."""
    img = cv2.imread(path, cv2.IMREAD_COLOR)
    if img is None:
        return None
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    if gray.shape != (IMG_SIZE, IMG_SIZE):
        gray = cv2.resize(gray, (IMG_SIZE, IMG_SIZE),
                          interpolation=cv2.INTER_AREA)
    return gray.astype(np.float32) / 255.0


def _augment(img: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Applique une augmentation aléatoire (translation + rotation + bruit)."""
    h, w = img.shape
    # Translation aléatoire ± 2 px.
    tx = rng.integers(-2, 3)
    ty = rng.integers(-2, 3)
    # Rotation aléatoire ± 3°.
    angle = rng.uniform(-3.0, 3.0)
    M = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
    M[0, 2] += tx
    M[1, 2] += ty
    out = cv2.warpAffine(img, M, (w, h),
                         flags=cv2.INTER_LINEAR,
                         borderMode=cv2.BORDER_REPLICATE)
    # Bruit gaussien faible.
    noise = rng.normal(0, 0.02, out.shape).astype(np.float32)
    out = np.clip(out + noise, 0.0, 1.0)
    return out


def build_dataset() -> tuple:
    """Charge et augmente. Retourne (X, y) prêts pour train_test_split."""
    rng = np.random.default_rng(42)
    X, y = [], []

    for label in LABELS:
        d = os.path.join(DATA_DIR, LABEL_DIRS[label])
        if not os.path.isdir(d):
            print(f'!! missing dir: {d}')
            continue
        files = [f for f in os.listdir(d) if f.endswith('.png')]
        if not files:
            print(f'!! empty: {d}')
            continue

        if label == GARBAGE_LABEL:
            # Sous-échantillonnage pour limiter le déséquilibre.
            if len(files) > GARBAGE_SAMPLE_CAP:
                files = list(rng.choice(files, GARBAGE_SAMPLE_CAP,
                                         replace=False))
            n_aug = AUG_PER_GARBAGE
        else:
            n_aug = (AUG_PER_DIGIT_RARE if len(files) < 15
                     else AUG_PER_DIGIT_DEFAULT)

        added = 0
        for fn in files:
            img = _load_crop(os.path.join(d, fn))
            if img is None:
                continue
            X.append(img.flatten())
            y.append(label)
            added += 1
            for _ in range(n_aug):
                X.append(_augment(img, rng).flatten())
                y.append(label)
                added += 1
        print(f'  label={label:>2} ({LABEL_DIRS[label]:>9}) : '
              f'{len(files):>4} files × ({n_aug + 1}) → {added} samples')

    X = np.array(X, dtype=np.float32)
    y = np.array(y, dtype=np.int32)
    print(f'\ntotal: {X.shape[0]} samples, {N_FEATURES} features')
    return X, y


def main():
    os.makedirs(MODEL_DIR, exist_ok=True)
    print('=== Building dataset (load + augment) ===')
    X, y = build_dataset()

    print('\n=== Train/test split ===')
    X_tr, X_te, y_tr, y_te = train_test_split(
        X, y, test_size=0.15, random_state=42, stratify=y,
    )
    print(f'train: {X_tr.shape[0]}  test: {X_te.shape[0]}')

    print('\n=== Training MLP (441→128→64→11) ===')
    pipe = Pipeline([
        ('scaler', StandardScaler()),
        ('mlp', MLPClassifier(
            hidden_layer_sizes=(128, 64),
            activation='relu',
            solver='adam',
            alpha=1e-4,
            batch_size=64,
            learning_rate_init=1e-3,
            max_iter=200,
            early_stopping=True,
            validation_fraction=0.1,
            n_iter_no_change=15,
            random_state=42,
            verbose=False,
        )),
    ])
    pipe.fit(X_tr, y_tr)
    n_iter = pipe.named_steps['mlp'].n_iter_
    print(f'converged in {n_iter} epochs')

    print('\n=== Evaluation on held-out test set ===')
    y_pred = pipe.predict(X_te)
    target_names = [LABEL_DIRS[l] for l in LABELS]
    print(classification_report(y_te, y_pred, target_names=target_names,
                                 labels=LABELS, zero_division=0))
    print('Confusion matrix (rows=true, cols=predicted):')
    cm = confusion_matrix(y_te, y_pred, labels=LABELS)
    header = '       ' + ' '.join(f'{n:>4}' for n in target_names)
    print(header)
    for name, row in zip(target_names, cm):
        print(f'{name:>9} ' + ' '.join(f'{v:>4}' for v in row))

    print(f'\n=== Saving model → {MODEL_PATH} ===')
    joblib.dump(pipe, MODEL_PATH, compress=3)
    sz = os.path.getsize(MODEL_PATH) / 1024
    print(f'saved {sz:.0f} KB')


if __name__ == '__main__':
    main()
