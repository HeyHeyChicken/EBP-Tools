# Copyright (c) 2026, Antoine Duval
# This file is part of a source-visible project.
# See LICENSE for terms. Unauthorized use is prohibited.

"""Identification des tracks anonymes via les événements de mort de hp_timeline.

Layer 3 du pipeline player tracking. Prend les tracks anonymes produits par
`PlayerTracker.export()` et leur assigne une identité (team, number) en
exploitant les événements de mort connus avec certitude grâce au pipeline OCR
(hp_timeline + cart_assignment).

Principe :
  - Chaque transition HP > 0 → HP = 0 dans hp_timeline = un joueur précis meurt
    à un instant précis (on connaît son slot via cart_assignment).
  - Visuellement, ce joueur devient un X marker statique sur la minimap.
  - Le track anonyme qui devient le plus stable juste après cet instant
    (et qui était actif juste avant) EST ce joueur. Identification verrouillée.
  - L'identité est appliquée à TOUT l'historique du track (rétro-propagation).
  - Élimination logique : si N-1 joueurs d'une équipe sont identifiés, le
    Nème track restant est forcément le joueur restant.

Convergence : en ~20-30 morts sur une game (typique 10 min EVA), tous les
joueurs sont identifiés. Une erreur ponctuelle du CNN (1 frame mal classée)
ne casse pas l'identification — c'est l'event de mort qui anchor.

Output format :
  {
    'orange': [{idx, slot, number, history: [(t, x, y, matched), ...]}, ...],
    'blue':   [...]
  }
  Tracks non identifiés : slot=None, number=None.
"""

import math
from typing import List, Optional


# Fenêtre temporelle (in-game elapsed_s) pour évaluer la stabilité d'un
# track après une mort. Le X marker reste affiché ~le temps du respawn
# (~15s) mais sa position est déjà figée dès t=0+ε après la mort.
_STABILITY_WINDOW_S = 3.0
# Distance max parcourue sur la fenêtre stability → "le track est figé".
_STABILITY_MAX_DISTANCE_PX = 6.0
# Track doit avoir été actif (= bougé sur la fenêtre pré-mort) pour être
# candidate. Élimine les tracks "à la traîne" qui ne suivent personne.
_ACTIVITY_WINDOW_S = 2.0
_ACTIVITY_MIN_DISTANCE_PX = 5.0


# ─── Death events extraction ───────────────────────────────────────────────

def _build_death_events(hp_timeline: dict, cart_assignment: dict) -> List[dict]:
    """Extrait les events de mort depuis hp_timeline + cart_assignment.

    Une mort = transition HP > 0 → HP = 0 entre 2 keys consécutives.
    Retourne une liste triée par elapsed_s :
      [{elapsed_s, team, cart_idx, slot}, ...]
    """
    if not hp_timeline or not cart_assignment:
        return []
    sorted_keys = sorted(int(k) for k in hp_timeline.keys() if k.isdigit() or
                          (k.startswith('-') and k[1:].isdigit()))
    deaths = []
    prev_state = None
    for k in sorted_keys:
        cur_state = hp_timeline[str(k)]
        if prev_state is not None:
            for team in ('orange', 'blue'):
                prev_hps = prev_state.get(team) or []
                cur_hps = cur_state.get(team) or []
                n = min(len(prev_hps), len(cur_hps))
                team_slots = cart_assignment.get(team) or []
                for cart_idx in range(n):
                    if (prev_hps[cart_idx] > 0
                            and cur_hps[cart_idx] == 0
                            and cart_idx < len(team_slots)):
                        slot = team_slots[cart_idx]
                        if slot is None:
                            continue
                        deaths.append({
                            'elapsed_s': float(k),
                            'team': team,
                            'cart_idx': cart_idx,
                            'slot': int(slot),
                        })
        prev_state = cur_state
    deaths.sort(key=lambda d: d['elapsed_s'])
    return deaths


# ─── Track movement helpers ────────────────────────────────────────────────

def _track_movement(history: list, t_start: float, t_end: float) -> float:
    """Distance totale parcourue par le track entre t_start et t_end (inclus).

    history = [(t, x, y, matched), ...] sortie de PlayerTracker.export.
    """
    pts = [(t, x, y) for (t, x, y, *_rest) in history
           if t_start <= t <= t_end]
    if len(pts) < 2:
        return 0.0
    total = 0.0
    for i in range(1, len(pts)):
        dx = pts[i][1] - pts[i-1][1]
        dy = pts[i][2] - pts[i-1][2]
        total += math.hypot(dx, dy)
    return total


# ─── Slot → minimap number mapping ─────────────────────────────────────────

def slot_to_number(slot: Optional[int]) -> Optional[int]:
    """Convertit slot interne (1-10) en numéro affiché sur la minimap.

    Convention EVA :
      - Orange : slots 1-5  → numbers 1-5
      - Blue   : slots 6-9  → numbers 6-9
      - Blue   : slot 10    → number 0 (5v5 only)
    """
    if slot is None:
        return None
    if 1 <= slot <= 9:
        return slot
    if slot == 10:
        return 0
    return None


# ─── Main identification ────────────────────────────────────────────────────

def identify(tracks: dict, hp_timeline: dict, cart_assignment: dict,
              chunk_start_ts: float = 0.0) -> dict:
    """Identifie les tracks anonymes via les morts de hp_timeline.

    Args:
        tracks:          sortie de PlayerTracker.export(), dict
                         {'orange': [{idx, history}, ...], 'blue': [...]}.
        hp_timeline:     {elapsed_str: {team: [hp_per_cart, ...]}}.
        cart_assignment: {team: [slot_per_cart, ...]}.
        chunk_start_ts:  début du chunk en secondes vidéo (mappe elapsed_s
                         in-game → temps vidéo des tracks).

    Returns:
        dict {
          'orange': [{idx, slot, number, history}, ...],
          'blue':   [...]
        }
        Tracks non identifiables (pas d'event de mort + élimination
        logique inconcluante) ont slot=None, number=None.
    """
    deaths = _build_death_events(hp_timeline, cart_assignment)

    # (team, track_idx) → slot
    identified: dict = {}
    available: dict = {team: list(range(len(tracks.get(team, []))))
                       for team in ('orange', 'blue')}

    for death in deaths:
        team = death['team']
        t_death_video = chunk_start_ts + death['elapsed_s']
        candidates = []
        for track_idx in available[team]:
            tr = tracks[team][track_idx]
            history = tr['history']
            activity = _track_movement(
                history, t_death_video - _ACTIVITY_WINDOW_S, t_death_video)
            stability = _track_movement(
                history, t_death_video, t_death_video + _STABILITY_WINDOW_S)
            if (activity >= _ACTIVITY_MIN_DISTANCE_PX
                    and stability <= _STABILITY_MAX_DISTANCE_PX):
                candidates.append((track_idx, stability))
        if not candidates:
            continue
        # Plus le track est statique (faible movement), meilleur le match.
        candidates.sort(key=lambda c: c[1])
        track_idx = candidates[0][0]
        identified[(team, track_idx)] = death['slot']
        available[team].remove(track_idx)

    # Élimination logique : un seul track restant + un seul slot restant
    # → match déterministe.
    for team in ('orange', 'blue'):
        if len(available[team]) == 1:
            assigned_slots = {
                slot for (t, _), slot in identified.items() if t == team
            }
            all_slots = {int(s) for s in (cart_assignment.get(team) or [])
                         if s is not None}
            remaining = all_slots - assigned_slots
            if len(remaining) == 1:
                slot = next(iter(remaining))
                track_idx = available[team][0]
                identified[(team, track_idx)] = slot

    out = {'orange': [], 'blue': []}
    for team in ('orange', 'blue'):
        for track_idx, tr in enumerate(tracks.get(team, [])):
            slot = identified.get((team, track_idx))
            out[team].append({
                'idx': tr['idx'],
                'slot': slot,
                'number': slot_to_number(slot),
                'history': tr['history'],
            })
    return out


# ─── CLI test ──────────────────────────────────────────────────────────────

def main():
    """Test rapide : fait tourner l'identification sur un payload JSON."""
    import json
    import sys

    if len(sys.argv) < 2:
        print('Usage: player_identifier.py <payload.json>')
        print('  payload.json must contain {tracks, hp_timeline, cart_assignment, chunk_start_ts?}')
        sys.exit(1)
    with open(sys.argv[1]) as f:
        payload = json.load(f)
    out = identify(
        payload['tracks'],
        payload['hp_timeline'],
        payload['cart_assignment'],
        payload.get('chunk_start_ts', 0.0),
    )
    for team in ('orange', 'blue'):
        print(f'=== {team} ===')
        for tr in out[team]:
            n_frames = len(tr['history'])
            n_matched = sum(1 for h in tr['history'] if len(h) > 3 and h[3])
            print(f'  idx={tr["idx"]:>2} → slot={tr["slot"]} number={tr["number"]} '
                  f'frames={n_frames} matched={n_matched}')


if __name__ == '__main__':
    main()
