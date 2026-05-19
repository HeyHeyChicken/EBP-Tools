# Copyright (c) 2026, Antoine Duval
# This file is part of a source-visible project.
# See LICENSE for terms. Unauthorized use is prohibited.

"""Entraîne un petit CNN pour identifier les chiffres joueurs sur la minimap,
exporte le modèle au format ONNX (déploiement client sans dépendance PyTorch).

Pipeline :
  1. Charge les crops dans `training_data/digits/{0..9, _garbage}/`
  2. Normalise → 21×21 grayscale, valeurs [0, 1]
  3. Data augmentation : rotation ±3°, translation ±2 px, bruit, contraste
  4. Architecture : 2 conv layers + 2 FC, 11 classes (10 digits + garbage)
  5. Train avec early stopping, save best model
  6. Export ONNX → `models/digit_cnn.onnx`

Usage :
    python3 train_cnn.py
"""

import os
import sys
import random
from typing import List, Tuple

import cv2
import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import Dataset, DataLoader, random_split


HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, 'training_data', 'digits')
MODEL_DIR = os.path.join(HERE, 'models')
ONNX_PATH = os.path.join(MODEL_DIR, 'digit_cnn.onnx')

# Hyperparamètres
IMG_SIZE = 21
N_CLASSES = 11           # 0..9 + garbage (label 10)
GARBAGE_LABEL = 10
GARBAGE_CAP = 400         # downsample si user a labélisé énormément de garbage
AUG_PER_DIGIT = 30        # augmentations par sample digit (compense le low N)
AUG_PER_GARBAGE = 15      # idem garbage pour rester balanced avec les digits
AUG_PER_RARE = 80         # classes très petites (label 0 et 5)
RARE_THRESHOLD = 15       # < N samples = classe rare
BATCH_SIZE = 64
LR = 1e-3
EPOCHS = 40
PATIENCE = 8              # early stopping si pas d'amélioration val_loss
SEED = 42


# ─── Architecture CNN ──────────────────────────────────────────────────────

class DigitCNN(nn.Module):
    """CNN ~38k params. Conv 16 → Conv 32 → Conv 64 → FC 128 → FC 11.

    Capacité ~5× le précédent (8/16 → 16/32/64) pour absorber la diversité
    cross-map (Cliff + Artefact + Atlantis +) sans saturer.
    """
    def __init__(self):
        super().__init__()
        # Input: (B, 1, 21, 21)
        self.conv1 = nn.Conv2d(1, 16, kernel_size=3, padding=1)   # → (B, 16, 21, 21)
        self.pool1 = nn.MaxPool2d(2)                               # → (B, 16, 10, 10)
        self.conv2 = nn.Conv2d(16, 32, kernel_size=3, padding=1)   # → (B, 32, 10, 10)
        self.pool2 = nn.MaxPool2d(2)                               # → (B, 32, 5, 5)
        self.conv3 = nn.Conv2d(32, 64, kernel_size=3, padding=1)   # → (B, 64, 5, 5)
        self.fc1 = nn.Linear(64 * 5 * 5, 128)
        self.fc2 = nn.Linear(128, N_CLASSES)
        self.relu = nn.ReLU(inplace=True)
        self.dropout = nn.Dropout(0.3)

    def forward(self, x):
        x = self.pool1(self.relu(self.conv1(x)))
        x = self.pool2(self.relu(self.conv2(x)))
        x = self.relu(self.conv3(x))
        x = x.flatten(1)
        x = self.relu(self.fc1(x))
        x = self.dropout(x)
        return self.fc2(x)


# ─── Data loading + augmentation ───────────────────────────────────────────

def _load_crop(path: str) -> np.ndarray:
    """Lit un PNG (couleur) → grayscale 21×21 normalisé [0, 1]."""
    img = cv2.imread(path, cv2.IMREAD_COLOR)
    if img is None:
        return None
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    if gray.shape != (IMG_SIZE, IMG_SIZE):
        gray = cv2.resize(gray, (IMG_SIZE, IMG_SIZE),
                          interpolation=cv2.INTER_AREA)
    return gray.astype(np.float32) / 255.0


def _augment(img: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Augmentation aléatoire : rotation ±3°, translation ±2px, bruit, contraste."""
    h, w = img.shape
    tx = float(rng.integers(-2, 3))
    ty = float(rng.integers(-2, 3))
    angle = float(rng.uniform(-3.0, 3.0))
    M = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
    M[0, 2] += tx
    M[1, 2] += ty
    out = cv2.warpAffine(img, M, (w, h),
                         flags=cv2.INTER_LINEAR,
                         borderMode=cv2.BORDER_REPLICATE)
    # Contraste/luminance aléatoire (±15%) — robustesse aux variations d'exposition
    contrast = float(rng.uniform(0.85, 1.15))
    brightness = float(rng.uniform(-0.1, 0.1))
    out = np.clip(out * contrast + brightness, 0.0, 1.0)
    # Bruit gaussien faible
    noise = rng.normal(0, 0.02, out.shape).astype(np.float32)
    return np.clip(out + noise, 0.0, 1.0)


def build_dataset(seed: int = SEED) -> Tuple[np.ndarray, np.ndarray]:
    """Charge tous les crops, augmente, retourne (X, y) prêts pour training."""
    rng = np.random.default_rng(seed)
    label_dirs = {i: str(i) for i in range(10)}
    label_dirs[GARBAGE_LABEL] = 'garbage'

    X_list, y_list = [], []

    for label, dirname in label_dirs.items():
        d = os.path.join(DATA_DIR, dirname)
        if not os.path.isdir(d):
            print(f'!! missing dir: {d}')
            continue
        files = [f for f in os.listdir(d) if f.endswith('.png')]
        if not files:
            print(f'!! empty: {d}')
            continue

        # Garbage : downsample seulement si énormément de samples, sinon augmente
        # pour rester balanced avec les classes digit.
        if label == GARBAGE_LABEL and len(files) > GARBAGE_CAP:
            files = list(rng.choice(files, GARBAGE_CAP, replace=False))
            n_aug = AUG_PER_GARBAGE
        elif label == GARBAGE_LABEL:
            n_aug = AUG_PER_GARBAGE
        elif len(files) < RARE_THRESHOLD:
            n_aug = AUG_PER_RARE
        else:
            n_aug = AUG_PER_DIGIT

        added = 0
        for fn in files:
            img = _load_crop(os.path.join(d, fn))
            if img is None:
                continue
            X_list.append(img)
            y_list.append(label)
            added += 1
            for _ in range(n_aug):
                X_list.append(_augment(img, rng))
                y_list.append(label)
                added += 1
        print(f'  label={label:>2} ({dirname:>9}) : '
              f'{len(files):>4} files × ({n_aug + 1}) = {added} samples')

    X = np.stack(X_list).astype(np.float32)
    y = np.array(y_list, dtype=np.int64)
    print(f'\ntotal: {X.shape[0]} samples, shape {X.shape}')
    return X, y


class DigitDataset(Dataset):
    def __init__(self, X: np.ndarray, y: np.ndarray):
        self.X = torch.from_numpy(X).unsqueeze(1)  # add channel dim → (N, 1, 21, 21)
        self.y = torch.from_numpy(y)

    def __len__(self):
        return len(self.y)

    def __getitem__(self, i):
        return self.X[i], self.y[i]


# ─── Training loop ─────────────────────────────────────────────────────────

def train():
    os.makedirs(MODEL_DIR, exist_ok=True)
    torch.manual_seed(SEED)
    random.seed(SEED)
    np.random.seed(SEED)

    print('=== Building dataset ===')
    X, y = build_dataset()

    # Shuffle then split 85/15.
    rng = np.random.default_rng(SEED)
    perm = rng.permutation(len(y))
    X, y = X[perm], y[perm]
    n_val = max(1, int(0.15 * len(y)))
    X_tr, y_tr = X[n_val:], y[n_val:]
    X_val, y_val = X[:n_val], y[:n_val]
    print(f'train: {len(y_tr)}, val: {len(y_val)}')

    train_ds = DigitDataset(X_tr, y_tr)
    val_ds = DigitDataset(X_val, y_val)
    train_loader = DataLoader(train_ds, batch_size=BATCH_SIZE, shuffle=True)
    val_loader = DataLoader(val_ds, batch_size=BATCH_SIZE)

    model = DigitCNN()
    n_params = sum(p.numel() for p in model.parameters())
    print(f'\nmodel params: {n_params}')

    criterion = nn.CrossEntropyLoss()
    optimizer = optim.Adam(model.parameters(), lr=LR)
    scheduler = optim.lr_scheduler.ReduceLROnPlateau(
        optimizer, mode='min', factor=0.5, patience=3)

    print('\n=== Training ===')
    best_val_loss = float('inf')
    best_state = None
    no_improve_epochs = 0
    for epoch in range(1, EPOCHS + 1):
        model.train()
        train_loss = 0.0
        n_correct = 0
        for xb, yb in train_loader:
            optimizer.zero_grad()
            logits = model(xb)
            loss = criterion(logits, yb)
            loss.backward()
            optimizer.step()
            train_loss += loss.item() * xb.size(0)
            n_correct += (logits.argmax(1) == yb).sum().item()
        train_loss /= len(train_ds)
        train_acc = n_correct / len(train_ds)

        model.eval()
        val_loss = 0.0
        n_correct = 0
        with torch.no_grad():
            for xb, yb in val_loader:
                logits = model(xb)
                loss = criterion(logits, yb)
                val_loss += loss.item() * xb.size(0)
                n_correct += (logits.argmax(1) == yb).sum().item()
        val_loss /= len(val_ds)
        val_acc = n_correct / len(val_ds)
        scheduler.step(val_loss)

        marker = ''
        if val_loss < best_val_loss - 1e-4:
            best_val_loss = val_loss
            best_state = {k: v.clone() for k, v in model.state_dict().items()}
            no_improve_epochs = 0
            marker = ' ✓'
        else:
            no_improve_epochs += 1
        print(f'  epoch {epoch:>2}: '
              f'train_loss={train_loss:.4f} acc={train_acc:.3f}  '
              f'val_loss={val_loss:.4f} acc={val_acc:.3f}{marker}')
        if no_improve_epochs >= PATIENCE:
            print(f'  early stop (no improvement for {PATIENCE} epochs)')
            break

    if best_state is not None:
        model.load_state_dict(best_state)
    print(f'\nbest val_loss: {best_val_loss:.4f}')

    # Per-class accuracy on val
    print('\n=== Per-class val accuracy ===')
    model.eval()
    with torch.no_grad():
        preds = model(val_ds.X).argmax(1).numpy()
        targets = val_ds.y.numpy()
    for cls in range(N_CLASSES):
        mask = targets == cls
        if mask.sum() == 0:
            print(f'  class {cls}: no samples in val')
            continue
        acc = (preds[mask] == cls).mean()
        print(f'  class {cls}: {mask.sum()} samples, acc={acc:.3f}')

    # Export ONNX
    print(f'\n=== Exporting ONNX → {ONNX_PATH} ===')
    dummy = torch.zeros(1, 1, IMG_SIZE, IMG_SIZE)
    torch.onnx.export(
        model, dummy, ONNX_PATH,
        input_names=['input'], output_names=['logits'],
        dynamic_axes={'input': {0: 'batch'}, 'logits': {0: 'batch'}},
        opset_version=14,
    )
    sz = os.path.getsize(ONNX_PATH) / 1024
    print(f'saved {sz:.1f} KB')


if __name__ == '__main__':
    train()
