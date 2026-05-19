# Copyright (c) 2026, Antoine Duval
# This file is part of a source-visible project.
# See LICENSE for terms. Unauthorized use is prohibited.

"""Tracker multi-objet contraint pour les blobs joueurs sur la minimap.

Maintient EXACTEMENT N_orange + N_blue tracks sur toute la game. Pas de
tracks fantômes (la contrainte dure absorbe le bruit du détecteur), pas de
tracks manquants (on conserve une position estimée pour chaque joueur).

Hypothèses fortes exploitées :
  - Nombre de joueurs par équipe connu à l'avance
  - Un (team, number) = unique joueur sur toute la game (l'identité ne change
    pas, gérée par Layer 3 séparément — ici on tracke des index anonymes)
  - Téléporteurs par paire : un saut > seuil de distance entre frames qui
    correspond à une paire connue est attribué au même track, pas un nouveau
  - Spawns = positions de départ + respawn (tracks init au centroïde)
  - Vitesse joueur bornée → un track non détecté UNE frame ne peut pas
    sauter loin entre temps (on prédit via vélocité au lieu de stagner)

Algorithme par frame :
  1. Pour chaque track, prédit sa position via la vélocité récente (EMA)
  2. Cost matrix (track × blob) basée sur la position PRÉDITE → Hungarian
     préfère assigner aux blobs cohérents avec le mouvement précédent
  3. TPs : un saut p→q expliqué par une paire connue est gratuit
  4. Tracks assignés → update position + recompute vélocité
  5. Tracks non assignés → glissent via vélocité (au lieu de figer) +
     incrémentent leur compteur `frames_since_match`
  6. État `LOST` après N frames sans match → rayon de matching élargi,
     vélocité décroît pour ne pas dériver indéfiniment

L'identité (team, number) n'est pas gérée ici. Sortie : tracks anonymes
indexés par (team, idx ∈ 0..N_team-1).
"""

import math
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

import cv2
import numpy as np
from scipy.optimize import linear_sum_assignment


# Distance max plausible track → blob entre 2 frames consécutives (en
# pixels du template minimap). À 10 FPS, joueur en course ~5 m/s → ~25 px.
# Marge confortable à 40 px.
_MAX_FRAME_JUMP = 40.0

# Rayon élargi pour les tracks LOST (= sans match depuis _LOST_AFTER frames).
# Permet la re-capture après une absence prolongée du blob.
_MAX_FRAME_JUMP_LOST = 80.0

# Nombre de frames consécutives sans match → état LOST.
_LOST_AFTER = 5

# Rayon de tolérance autour d'une icône TP : track proche d'un TP source ET
# blob proche du TP partenaire → saut gratuit.
_TP_RADIUS = 18.0

# Vélocité : EMA exponentielle, alpha = poids du sample courant.
# 0.4 → réactif sans suivre le bruit ; 0.2 → plus lisse mais lag.
_VEL_ALPHA = 0.4

# Décroissance de la vélocité d'un track LOST : à chaque frame sans match,
# vélocité *= ce coef. 0.85 → décroît à ~22 % après 10 frames sans match.
_LOST_VEL_DECAY = 0.85

# Sentinelle "pas de match possible" : assez grand pour que Hungarian
# préfère un track non assigné plutôt qu'un mauvais match.
_NO_MATCH_COST = 1e6


@dataclass
class Track:
    team: str
    idx: int
    x: float
    y: float
    vx: float = 0.0
    vy: float = 0.0
    # Timestamp précédent (pour calculer dt et v).
    last_t: Optional[float] = None
    # Nombre de frames consécutives sans match (0 = matché à la frame courante).
    frames_since_match: int = 0
    history: List[Tuple[float, float, float, bool]] = field(default_factory=list)
    # history entry = (t, x, y, matched) — `matched` permet à l'overlay
    # de distinguer position observée vs prédite.

    @property
    def is_lost(self) -> bool:
        return self.frames_since_match >= _LOST_AFTER

    def predict(self, t: float) -> Tuple[float, float]:
        """Position prédite à `t` via la dernière vélocité connue."""
        if self.last_t is None:
            return (self.x, self.y)
        dt = t - self.last_t
        return (self.x + self.vx * dt, self.y + self.vy * dt)

    def match(self, t: float, x: float, y: float) -> None:
        """Track matché à un blob : update position + recompute vélocité."""
        if self.last_t is not None:
            dt = t - self.last_t
            if dt > 1e-6:
                vx_new = (x - self.x) / dt
                vy_new = (y - self.y) / dt
                self.vx = (1 - _VEL_ALPHA) * self.vx + _VEL_ALPHA * vx_new
                self.vy = (1 - _VEL_ALPHA) * self.vy + _VEL_ALPHA * vy_new
        self.x = x
        self.y = y
        self.last_t = t
        self.frames_since_match = 0
        self.history.append((t, x, y, True))

    def skip(self, t: float) -> None:
        """Pas de match : glisse via vélocité + décroît vélocité si LOST."""
        if self.last_t is None:
            self.last_t = t
            self.history.append((t, self.x, self.y, False))
            self.frames_since_match += 1
            return
        dt = t - self.last_t
        # Position projetée — limitée à _MAX_FRAME_JUMP / frame pour éviter
        # qu'un track perdu ne dérive trop loin sur un grand dt.
        step = math.hypot(self.vx * dt, self.vy * dt)
        if step > _MAX_FRAME_JUMP_LOST:
            scale = _MAX_FRAME_JUMP_LOST / step
            self.x += self.vx * dt * scale
            self.y += self.vy * dt * scale
        else:
            self.x += self.vx * dt
            self.y += self.vy * dt
        self.last_t = t
        self.frames_since_match += 1
        if self.frames_since_match >= _LOST_AFTER:
            self.vx *= _LOST_VEL_DECAY
            self.vy *= _LOST_VEL_DECAY
        self.history.append((t, self.x, self.y, False))


def _spawn_centroid(spawn_list: list) -> Tuple[float, float]:
    """Centroïde du 1er spawn de la liste (cas multi-spawn : on prend
    le 1er ; tous les tracks démarrent au même point, le tracker
    dispatchera quand des blobs distincts apparaissent)."""
    if not spawn_list:
        return (0.0, 0.0)
    poly = spawn_list[0].get('polygon', [])
    if not poly:
        return (0.0, 0.0)
    xs = [float(p[0]) for p in poly]
    ys = [float(p[1]) for p in poly]
    return (sum(xs) / len(xs), sum(ys) / len(ys))


def _build_tp_partners(teleporters: list) -> dict:
    """{tp_id → position du partenaire (x, y)}. Cache de lookup."""
    by_id = {tp['id']: tp for tp in teleporters}
    out = {}
    for tp in teleporters:
        partner_id = tp.get('paired_with')
        if partner_id and partner_id in by_id:
            out[tp['id']] = tuple(by_id[partner_id]['position'])
    return out


def _explained_by_tp(p: Tuple[float, float], q: Tuple[float, float],
                      teleporters: list, tp_partners: dict) -> bool:
    """True si le saut p→q correspond à l'utilisation d'un TP connu.

    Critère : p à proximité d'un TP, q à proximité du TP partenaire.
    """
    for tp in teleporters:
        tp_pos = tuple(tp['position'])
        partner_pos = tp_partners.get(tp['id'])
        if partner_pos is None:
            continue
        if (math.hypot(p[0] - tp_pos[0], p[1] - tp_pos[1]) <= _TP_RADIUS and
                math.hypot(q[0] - partner_pos[0], q[1] - partner_pos[1]) <= _TP_RADIUS):
            return True
    return False


class PlayerTracker:
    """Multi-Object Tracker contraint à N_team tracks par équipe."""

    def __init__(self, n_orange: int, n_blue: int, map_meta: dict):
        self.n_orange = n_orange
        self.n_blue = n_blue
        self.map_meta = map_meta
        self.teleporters = map_meta.get('teleporters', [])
        self._tp_partners = _build_tp_partners(self.teleporters)

        # Init tracks au centroïde du spawn de chaque équipe.
        self.tracks: dict = {'orange': [], 'blue': []}
        for team, n in (('orange', n_orange), ('blue', n_blue)):
            cx, cy = _spawn_centroid(map_meta['spawns'][team])
            for i in range(n):
                self.tracks[team].append(Track(team=team, idx=i, x=cx, y=cy))

    # ─── Update ───────────────────────────────────────────────────────────

    def update(self, t: float, blobs: dict) -> None:
        """Intègre les détections de la frame `t` (template px coords)."""
        for team in ('orange', 'blue'):
            self._update_team(t, team, blobs.get(team, []))

    def _update_team(self, t: float, team: str, blobs: list) -> None:
        tracks = self.tracks[team]
        n_t = len(tracks)
        if n_t == 0:
            return
        if not blobs:
            for tr in tracks:
                tr.skip(t)
            return

        n_b = len(blobs)
        cost = np.full((n_t, n_b), _NO_MATCH_COST, dtype=np.float64)
        for i, tr in enumerate(tracks):
            # Position prédite via vélocité (cohérence du mouvement).
            px, py = tr.predict(t)
            max_jump = _MAX_FRAME_JUMP_LOST if tr.is_lost else _MAX_FRAME_JUMP
            for j, b in enumerate(blobs):
                qx, qy = b['x'], b['y']
                d = math.hypot(px - qx, py - qy)
                if d <= max_jump:
                    cost[i, j] = d
                elif _explained_by_tp((tr.x, tr.y), (qx, qy),
                                       self.teleporters, self._tp_partners):
                    cost[i, j] = 0.0
                # sinon : _NO_MATCH_COST

        row_ind, col_ind = linear_sum_assignment(cost)
        assigned = set()
        for i, j in zip(row_ind, col_ind):
            if cost[i, j] < _NO_MATCH_COST:
                tracks[i].match(t, blobs[j]['x'], blobs[j]['y'])
                assigned.add(i)
        for i, tr in enumerate(tracks):
            if i not in assigned:
                tr.skip(t)

    # ─── Export ───────────────────────────────────────────────────────────

    def export(self) -> dict:
        """Renvoie les trajectoires sérialisables.

        Sortie : { 'orange': [{idx, history:[(t, x, y, matched), ...]}, ...],
                   'blue':   [...] }
        `matched` est un bool indiquant si la position vient d'une détection
        (True) ou d'une prédiction par vélocité (False).
        """
        out = {'orange': [], 'blue': []}
        for team in ('orange', 'blue'):
            for tr in self.tracks[team]:
                out[team].append({
                    'idx': tr.idx,
                    'history': [
                        (round(t, 2), round(x, 2), round(y, 2), bool(m))
                        for t, x, y, m in tr.history
                    ],
                })
        return out
