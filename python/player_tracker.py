# Copyright (c) 2026, Antoine Duval
# This file is part of a source-visible project.
# See LICENSE for terms. Unauthorized use is prohibited.

"""Tracker temporel pour suivre les joueurs entre frames.

Étape 2.4 : agrège les détections par-frame de `players.find_players`
en tracks stables. Bénéfices :

  - Lisse les erreurs ponctuelles d'identification : un track vu 28 fois
    "9" et 2 fois "0" reste "9" (vote majoritaire).
  - Persiste un joueur qui disparaît temporairement (passe derrière un
    mur ou sortie momentanée du modèle).
  - Permet d'extraire des trajectoires (positions au cours du temps),
    nécessaires aux analyses dérivées (heatmap, distance parcourue, etc.).

Algorithme :
  1. À chaque frame, on reçoit les détections {team, number, x_pct, y_pct}.
  2. Pour chaque détection :
       a. Cherche un track existant de MÊME équipe ET MÊME numéro à
          distance < _MATCH_DIST_SAME (large : ~ déplacement max par
          frame). Si trouvé → association.
       b. Sinon, cherche un track de même équipe (peu importe son numéro
          dominant) à distance < _MATCH_DIST_PROX (étroit : doit être
          quasi à la même position) → association (vote pour le nouveau
          numéro, qui pourrait corriger une erreur passée).
       c. Sinon → nouveau track.
  3. Update du track : position lissée (EMA), vote pour le numéro,
     compteur de frames vues, dernier timestamp.
  4. Tracks non vus depuis > _MAX_FRAMES_UNSEEN → archivés (toujours
     accessibles via `archived_tracks`).

API :
    tracker = PlayerTracker(box_w, box_h)
    for frame_idx, frame in enumerate(...):
        detections = players.find_players(frame, ...)
        active_players = tracker.update(detections, t=frame_idx)
"""

from collections import Counter
from typing import List, Optional


# Distance max (px de la box minimap) pour associer une détection à un
# track DE MÊME numéro. Permet à un joueur de bouger jusqu'à ~30 px
# entre deux frames consécutives (typique : course rapide).
_MATCH_DIST_SAME = 30.0
# Distance max pour associer à un track de même équipe MAIS numéro
# différent (ex : modèle a flanché et lu "0" au lieu de "9"). Plus
# étroit : on exige une quasi-superposition pour faire confiance au
# match d'équipe seul.
_MATCH_DIST_PROX = 12.0
# Nombre de frames sans détection avant de considérer un track comme
# "perdu" et de l'archiver.
_MAX_FRAMES_UNSEEN = 60
# Fraction du nouveau (x, y) dans la position lissée. 0.3 → réactif sans
# chasing du bruit, 0.5 → plus de réactivité, 0.1 → très lisse.
_EMA_ALPHA = 0.4
# Fraction min de votes pour considérer l'identité "stable" (utile pour
# les consommateurs qui veulent ignorer les tracks ambigus).
_STABLE_IDENTITY_FRAC = 0.6


class PlayerTracker:
    """Tracker à mémoire courte, sans dépendance externe."""

    def __init__(self, box_w: float, box_h: float,
                  match_dist_same: float = _MATCH_DIST_SAME,
                  match_dist_prox: float = _MATCH_DIST_PROX,
                  max_frames_unseen: int = _MAX_FRAMES_UNSEEN,
                  ema_alpha: float = _EMA_ALPHA):
        self.box_w = float(box_w)
        self.box_h = float(box_h)
        self.match_dist_same = match_dist_same
        self.match_dist_prox = match_dist_prox
        self.max_frames_unseen = max_frames_unseen
        self.ema_alpha = ema_alpha

        self.tracks: list = []          # tracks actifs
        self.archived_tracks: list = [] # tracks perdus (≥ max_frames_unseen)
        self._next_id: int = 0

    # ─── Internals ─────────────────────────────────────────────────────

    def _new_track(self, det: dict, t) -> dict:
        x = det['x_pct'] * self.box_w
        y = det['y_pct'] * self.box_h
        tr = {
            'id':            self._next_id,
            'team':          det['team'],
            'number_votes':  Counter([det['number']]),
            'x_px':          x,
            'y_px':          y,
            'first_seen':    t,
            'last_seen':     t,
            'frames_seen':   1,
            'conf_sum':      det['confidence'],
            'history':       [(t, x, y, det['number'])],
        }
        self._next_id += 1
        self.tracks.append(tr)
        return tr

    def _update_track(self, tr: dict, det: dict, t) -> None:
        x = det['x_pct'] * self.box_w
        y = det['y_pct'] * self.box_h
        a = self.ema_alpha
        tr['x_px'] = (1 - a) * tr['x_px'] + a * x
        tr['y_px'] = (1 - a) * tr['y_px'] + a * y
        tr['number_votes'][det['number']] += 1
        tr['last_seen'] = t
        tr['frames_seen'] += 1
        tr['conf_sum'] += det['confidence']
        tr['history'].append((t, x, y, det['number']))

    def _find_match(self, det: dict) -> Optional[dict]:
        """Cherche le track existant le mieux assorti à det (None sinon)."""
        x = det['x_pct'] * self.box_w
        y = det['y_pct'] * self.box_h
        team = det['team']
        number = det['number']

        # Priorité 1 : même équipe + même numéro déjà voté, dans rayon large.
        best_same: Optional[dict] = None
        best_same_d2 = self.match_dist_same ** 2
        for tr in self.tracks:
            if tr['team'] != team:
                continue
            if number not in tr['number_votes']:
                continue
            d2 = (tr['x_px'] - x) ** 2 + (tr['y_px'] - y) ** 2
            if d2 < best_same_d2:
                best_same_d2 = d2
                best_same = tr
        if best_same is not None:
            return best_same

        # Priorité 2 : même équipe (numéro différent), rayon étroit.
        # Permet de corriger les erreurs : modèle lit "0" au lieu de "9"
        # → si le track le plus proche reste à <12 px, on l'associe et
        # on ajoute le vote (le "9" reste majoritaire).
        best_prox: Optional[dict] = None
        best_prox_d2 = self.match_dist_prox ** 2
        for tr in self.tracks:
            if tr['team'] != team:
                continue
            d2 = (tr['x_px'] - x) ** 2 + (tr['y_px'] - y) ** 2
            if d2 < best_prox_d2:
                best_prox_d2 = d2
                best_prox = tr
        return best_prox

    def _archive_stale(self, t) -> None:
        still_active = []
        for tr in self.tracks:
            if (t - tr['last_seen']) > self.max_frames_unseen:
                self.archived_tracks.append(tr)
            else:
                still_active.append(tr)
        self.tracks = still_active

    def _merge_duplicates(self) -> None:
        """Fusionne les tracks actifs partageant un (team, number) dominant.

        Hypothèse forte du jeu : un (team, number) identifie UN unique
        joueur pour toute la partie. Donc tout track partageant (team,
        number) avec un autre est forcément un doublon (erreur de
        détection, faux positif éphémère, etc.).

        Stratégie : on garde le track le plus actif (frames_seen max)
        comme principal et on lui transfère les votes des autres. Les
        tracks absorbés sont déplacés vers `archived_tracks` (utile pour
        debug). La position du principal est conservée — c'est la plus
        représentative puisqu'il a accumulé le plus de samples.
        """
        groups: dict = {}
        for tr in self.tracks:
            number = tr['number_votes'].most_common(1)[0][0]
            key = (tr['team'], number)
            groups.setdefault(key, []).append(tr)
        survivors = []
        for group in groups.values():
            if len(group) == 1:
                survivors.append(group[0])
                continue
            group.sort(key=lambda t: -t['frames_seen'])
            main, others = group[0], group[1:]
            for tr in others:
                for num, count in tr['number_votes'].items():
                    main['number_votes'][num] += count
                main['frames_seen'] += tr['frames_seen']
                main['conf_sum'] += tr['conf_sum']
                # last_seen conserve le max — un doublon récent prolonge
                # la "vivacité" du principal.
                if tr['last_seen'] > main['last_seen']:
                    main['last_seen'] = tr['last_seen']
                self.archived_tracks.append(tr)
            survivors.append(main)
        self.tracks = survivors

    # ─── Public API ────────────────────────────────────────────────────

    def update(self, detections: List[dict], t) -> List[dict]:
        """Intègre les détections de la frame t et renvoie l'état stable.

        Args:
            detections: liste de dicts {team, number, x_pct, y_pct, confidence}
                        — sortie typique de players.find_players.
            t:          identifiant temporel (entier de frame ou float secondes).

        Returns:
            Liste de dicts par track actif :
              { 'id', 'team', 'number', 'x_pct', 'y_pct',
                'identity_strength', 'frames_seen', 'conf_avg', 'last_seen' }
        """
        for det in detections:
            tr = self._find_match(det)
            if tr is None:
                self._new_track(det, t)
            else:
                self._update_track(tr, det, t)
        self._archive_stale(t)
        self._merge_duplicates()
        return self.get_active_state()

    def get_active_state(self) -> List[dict]:
        out = []
        for tr in self.tracks:
            number, votes = tr['number_votes'].most_common(1)[0]
            total = sum(tr['number_votes'].values())
            out.append({
                'id':                tr['id'],
                'team':              tr['team'],
                'number':            number,
                'x_pct':             tr['x_px'] / self.box_w,
                'y_pct':             tr['y_px'] / self.box_h,
                'identity_strength': votes / total,
                'frames_seen':       tr['frames_seen'],
                'conf_avg':          tr['conf_sum'] / tr['frames_seen'],
                'last_seen':         tr['last_seen'],
                'is_stable':         (votes / total) >= _STABLE_IDENTITY_FRAC,
            })
        return out
