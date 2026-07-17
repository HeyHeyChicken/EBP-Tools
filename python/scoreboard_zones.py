#!/usr/bin/env python3
"""Localisation des zones OCR sur une frame de scoreboard de fin de partie.

Layout « standard » (replay joueur) : nom de map en haut à droite, % des deux
équipes à gauche, joueurs en deux rangées de 1 à 5 colonnes (4v4, 5v5, voire
4v5) avec nom / score / K / D / A par colonne.

La présence et la position de chaque colonne sont ancrées sur la rangée
d'icônes hexagonales K/D/A (`templates/scoreboard_kda.png`), indépendante de
la langue du jeu. Matching par parties : chaque icône est corrélée séparément
(TM_CCOEFF_NORMED, valeur signée) puis les 3 cartes sont alignées sur leurs
offsets relatifs et agrégées par médiane — la médiane tolère une icône
dégradée (ombre, glow de sélection) là où la somme échoue, et l'alignement
spatial + polarité commune écrasent les faux positifs (logos, webcam, chat).
La valeur absolue de la médiane couvre les deux polarités : les icônes du
joueur sélectionné sont colorées et peuvent être plus sombres que le fond.

Cas limite mesuré (icônes bleues sur sol clair texturé, lunar) : le match
icônes tombe sous le seuil ; la colonne est alors COMBLÉE par inférence
structurelle (cf. `_detect_row`) — les colonnes du HUD sont contiguës depuis
la gauche, donc un trou encadré par des colonnes détectées est une vraie
colonne ratée, reconstruite depuis le cy partagé de sa rangée. Aucun asset
supplémentaire, robuste à la langue. Les anchors suivent la grille quand elle
est décalée verticalement (±25 px observés). Toutes les zones d'une colonne
sont des offsets par rapport au centre « équivalent-label » de son ancre.

Positions nominales en espace 1920×1080 (convention analyze_video.py) ; la
frame est redimensionnée en interne, les zones retournées sont rescalées à la
résolution d'origine.

Le layout « cast » (matchs castés / ProLeague, ex. SK vs OG : logos d'équipe
latéraux, % au centre, photos des joueurs) est aussi zoné : mêmes offsets de
zones par colonne (mesurés identiques), seules les positions des colonnes et
des % diffèrent. Pas de nom de map à l'écran dans ce layout ('map': None).
Positions calibrées sur un match 4v4 ; un cast 5v5 n'est pas encore couvert.

Usage :
  python scoreboard_zones.py frame.png                  # JSON sur stdout
  python scoreboard_zones.py frame.png --debug out.png  # + overlay de contrôle
"""
import argparse
import json
import os
import sys

import cv2
import numpy as np

_TPL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'templates')
KDA_TEMPLATE_PATH = os.path.join(_TPL_DIR, 'scoreboard_kda.png')

MAP_ZONE = (1490, 45, 1885, 82)        # nom de la map, fallback statique
# Région de recherche du nom de map (il glisse verticalement comme la grille) :
# 1re bande de texte clair dans le coin haut-droit ; la 2e est le mode de jeu.
MAP_SEARCH = (1450, 0, 1900, 130)
MAP_TEXT_TH = 140
# Gros % d'équipe : zones fallback statiques ; en pratique localisés
# dynamiquement dans ces régions de recherche (le bloc glisse verticalement et
# le badge hexagonal avec l'acronyme d'équipe, au-dessus ou en dessous, doit
# rester hors zone pour ne pas perturber l'OCR). Le % est la bande de texte
# saturé la plus HAUTE de la région ; le badge est une bande fine.
TEAM1_PCT_ZONE = (25, 435, 370, 530)
TEAM2_PCT_ZONE = (25, 625, 370, 720)
PCT_SEARCH = {1: (25, 370, 370, 580), 2: (25, 595, 370, 790)}
PCT_MIN_COLS = 35   # colonnes saturées min. par rangée (gros chiffres)

# Grille des colonnes joueurs : centres à pas constant, le 5e slot s'ajoute à
# droite. Identique pour les deux rangées.
COL_X0 = 518.0
COL_PITCH = 247.5
MAX_COLS = 5

# Centre nominal du label SCORE par rangée, et fenêtre de recherche autour
# (la grille glisse verticalement de ±25 px selon les frames). Ces centres
# « équivalent-label » restent le référentiel des offsets de zones, même sans
# détecter le label lui-même.
LABEL_Y = {1: 429, 2: 891}
SEARCH_DX, SEARCH_DY = 70, 40

# Ancre principale : rangée d'icônes K/D/A. Le template couvre les 3 icônes ;
# chacune est découpée à ces bornes x et matchée séparément (cf. _find_kda).
KDA_ICON_SLICES = ((0, 40), (64, 104), (128, 169))
# Centre du template vs centre du label SCORE de la même colonne (mesuré sur
# outlaw : strip x=509 y=502, label x=515.5 y=429.5).
KDA_TO_LABEL_DX, KDA_TO_LABEL_DY = 6.5, -72.5
KDA_MIN_SCORE = 0.55    # mesuré : vraies colonnes >= 0.74, faux positifs <= 0.40

# Layout cast (ProLeague) : centres équivalents-label des colonnes (mesurés sur
# cliff3 : icônes K/D/A à y=410 / y=978, mêmes icônes et mêmes offsets de
# zones que le layout standard), rangée 1 = équipe du haut (photos).
CAST_LABEL_XS = {1: (806, 1054, 1302, 1550), 2: (367, 615, 863, 1111)}
CAST_LABEL_Y = {1: 337.5, 2: 905.5}
# Les % des deux équipes encadrent le logo EVA PRO LEAGUE au centre, localisés
# dynamiquement dans ces régions de recherche (comme le layout standard). Une
# zone statique décapitait le « 1 » de « 100 % » : le % team1 est aligné à
# droite vers le logo, donc « 100 » déborde à gauche là où « 64 » ne le fait
# pas. Fenêtres larges + bande saturée la plus haute = bbox serrée du nombre.
CAST_TEAM1_PCT_SEARCH = (600, 470, 940, 615)
CAST_TEAM2_PCT_SEARCH = (1050, 470, 1330, 615)
CAST_TEAM1_PCT_ZONE = (634, 490, 845, 595)   # fallback statique (mesuré)
CAST_TEAM2_PCT_ZONE = (1085, 490, 1252, 595)
CAST_PCT_MIN_COLS = 20   # les % castés sont plus petits que les standards (35)

# Zones d'une colonne, en offsets (dy1, dy2) vs centre du label, et
# (dx, demi-largeur) vs centre de colonne.
NAME_DY = (-56, -10)     # jusqu'à 2 lignes ; s'arrête au-dessus du label SCORE
NAME_HALF_W = 122
SCORE_DY = (12, 46)
SCORE_HALF_W = 68        # "1050" (4 chiffres) tient ; serré pour l'OCR
KDA_DY = (94, 132)       # les chiffres descendent à +128 sur atlantis
KDA_DX = (-77, -5, 58)   # centres des valeurs K / D / A
KDA_HALF_W = 26   # "13" (2 chiffres) tient ; à 32 les cellules D et A se touchent


def _scale_zone(zone, sx, sy):
    x1, y1, x2, y2 = zone
    return [int(round(x1 * sx)), int(round(y1 * sy)),
            int(round(x2 * sx)), int(round(y2 * sy))]


def _find_pct_zone(img, region, min_cols, fallback):
    """Zone du gros % d'équipe : bande de texte saturé la plus haute de la
    région (le badge hexagonal avec l'acronyme d'équipe forme une bande fine,
    les chiffres du % une bande de ~60-100 px). Fallback statique sinon."""
    x1, y1, x2, y2 = region
    crop = img[y1:y2, x1:x2].astype(np.int16)
    mx = crop.max(axis=2)
    sat = (mx > 150) & ((mx - crop.min(axis=2)) > 60)
    counts = sat.sum(axis=1)
    bands, start, hole = [], None, 0
    for i, c in enumerate(counts):
        if c >= min_cols:
            if start is None:
                start = i
            hole = 0
        elif start is not None:
            hole += 1
            if hole > 3:
                bands.append((start, i - hole + 1))
                start = None
    if start is not None:
        bands.append((start, len(counts)))
    bands = [b for b in bands if b[1] - b[0] >= 40]
    if not bands:
        return fallback
    b = max(bands, key=lambda b: b[1] - b[0])
    cols = np.where(sat[b[0]:b[1]].any(axis=0))[0]
    return (x1 + int(cols.min()) - 8, y1 + b[0] - 6,
            x1 + int(cols.max()) + 8, y1 + b[1] + 6)


def _find_map_zone(gray):
    """Zone du nom de map : 1re bande de texte clair du coin haut-droit.

    Le titre glisse verticalement avec la grille (±35 px observés) ; la ligne
    du dessous (mode de jeu) est ignorée. Fallback : MAP_ZONE statique."""
    x1, y1, x2, y2 = MAP_SEARCH
    reg = gray[y1:y2, x1:x2]
    bright = reg > MAP_TEXT_TH
    rows = bright.sum(axis=1)
    start = None
    for y, c in enumerate(rows):
        if c >= 4 and start is None:
            start = y
        elif c < 4 and start is not None:
            if 6 <= y - start <= 25:
                cols = np.where(bright[start:y].any(axis=0))[0]
                return (x1 + int(cols.min()) - 6, y1 + start - 4,
                        x1 + int(cols.max()) + 6, y1 + y + 4)
            start = None
    return MAP_ZONE




def _find_kda(gray, tpl, label_cx0, label_ly0):
    """Cherche la rangée d'icônes K/D/A du slot dont le label SCORE nominal
    est en (label_cx0, label_ly0). Matching de parties : corrélation signée
    par icône, cartes alignées sur les offsets du strip, médiane par position,
    maximum en valeur absolue (les icônes du joueur sélectionné peuvent être
    plus sombres que le fond).

    Retourne (score, cx, cy) — cx/cy exprimés en centre ÉQUIVALENT LABEL
    (position nominale du label SCORE) pour servir de référentiel commun aux
    offsets de zones."""
    th, tw = tpl.shape
    cx0 = label_cx0 - KDA_TO_LABEL_DX
    cy0 = label_ly0 - KDA_TO_LABEL_DY
    x1 = int(cx0 - tw / 2 - SEARCH_DX)
    y1 = int(cy0 - th / 2 - SEARCH_DY)
    win = gray[y1:y1 + th + 2 * SEARCH_DY, x1:x1 + tw + 2 * SEARCH_DX]
    if win.shape[0] < th or win.shape[1] < tw:
        return 0.0, cx0, cy0
    maps = [cv2.matchTemplate(win, tpl[:, a:b], cv2.TM_CCOEFF_NORMED)
            for a, b in KDA_ICON_SLICES]
    h = min(m.shape[0] for m in maps)
    xmax = min(m.shape[1] - a for m, (a, _) in zip(maps, KDA_ICON_SLICES))
    med = np.median(np.stack([m[:h, a:a + xmax]
                              for m, (a, _) in zip(maps, KDA_ICON_SLICES)]),
                    axis=0)
    _, mx, _, loc_mx = cv2.minMaxLoc(med)
    mn, _, loc_mn, _ = cv2.minMaxLoc(med)
    score, loc = (mx, loc_mx) if mx >= -mn else (-mn, loc_mn)
    icon_cx = x1 + loc[0] + tw / 2.0
    icon_cy = y1 + loc[1] + th / 2.0
    return score, icon_cx + KDA_TO_LABEL_DX, icon_cy + KDA_TO_LABEL_DY


def _detect_row(gray, tpl, slots):
    """Colonnes d'une rangée : (col, cx, cy) par colonne présente.

    Ancre par icônes K/D/A (indépendant de la langue). Une colonne dont le
    match échoue (mesuré : joueur sélectionné aux icônes colorées sur fond
    clair, lunar r2c1) est COMBLÉE par inférence structurelle : les colonnes
    du HUD sont contiguës depuis la gauche et la plus à droite est toujours
    lisible, donc tout trou d'indice ≤ au max détecté est une vraie colonne
    ratée, pas une colonne absente (celles-ci sont à droite). Le trou hérite
    du cy partagé de sa rangée (grille horizontale) et de son x nominal
    corrigé de l'offset moyen des colonnes détectées. Remplace l'ancien
    repli par template SCORE — aucun asset, robuste à la langue."""
    detected = {}
    for col, (cx0, ly0) in enumerate(slots):
        score, cx, cy = _find_kda(gray, tpl, cx0, ly0)
        if score >= KDA_MIN_SCORE:
            detected[col] = (cx, cy)
    if not detected:
        return []
    max_col = max(detected)
    cy_row = float(np.mean([cy for _, cy in detected.values()]))
    dx = float(np.mean([cx - slots[c][0] for c, (cx, _) in detected.items()]))
    out = []
    for col in range(max_col + 1):
        if col in detected:
            out.append((col, *detected[col]))
        else:
            out.append((col, slots[col][0] + dx, cy_row))
    return out


def zones_for_frame(img):
    """Calcule les zones OCR d'une frame BGR (toute résolution 16:9).

    Retourne un dict :
      {'layout': 'standard', 'cols': [n_row1, n_row2],
       'map': [x1,y1,x2,y2], 'team1_pct': [...], 'team2_pct': [...],
       'players': [{'row': 1, 'col': 1, 'name': [...], 'score': [...],
                    'k': [...], 'd': [...], 'a': [...]}, ...]}
    Joueurs listés rangée 1 (équipe du haut) de gauche à droite, puis
    rangée 2 — même ordre que les .txt d'annotation.
    """
    h, w = img.shape[:2]
    img_1080 = img if (w, h) == (1920, 1080) else cv2.resize(img, (1920, 1080))

    tpl_kda = cv2.imread(KDA_TEMPLATE_PATH, cv2.IMREAD_GRAYSCALE)
    if tpl_kda is None:
        raise FileNotFoundError(f'template manquant : {KDA_TEMPLATE_PATH}')
    gray = cv2.cvtColor(img_1080, cv2.COLOR_BGR2GRAY)

    # Layout déterminé par les ancres elles-mêmes : on matche les slots des
    # deux grilles (leurs fenêtres de recherche ne se recouvrent pas) et on
    # garde celle qui trouve le plus de colonnes. Découplé des zones de %,
    # dont le contenu varie trop (badges, logos, photos) pour discriminer.
    std_slots = {row: [(COL_X0 + COL_PITCH * col, LABEL_Y[row])
                       for col in range(MAX_COLS)] for row in (1, 2)}
    cast_slots = {row: [(x, CAST_LABEL_Y[row]) for x in CAST_LABEL_XS[row]]
                  for row in (1, 2)}
    found = {}
    for name, grid in (('standard', std_slots), ('cast', cast_slots)):
        hits = {row: _detect_row(gray, tpl_kda, grid[row]) for row in (1, 2)}
        found[name] = hits
    n_std = sum(len(v) for v in found['standard'].values())
    n_cast = sum(len(v) for v in found['cast'].values())
    if n_std == 0 and n_cast == 0:
        return {'layout': 'unknown', 'cols': None}
    layout = 'standard' if n_std >= n_cast else 'cast'
    hits = found[layout]

    sx, sy = w / 1920.0, h / 1080.0
    if layout == 'standard':
        out = {
            'layout': layout, 'cols': [0, 0],
            'map': _scale_zone(_find_map_zone(gray), sx, sy),
            'team1_pct': _scale_zone(_find_pct_zone(
                img_1080, PCT_SEARCH[1], PCT_MIN_COLS, TEAM1_PCT_ZONE), sx, sy),
            'team2_pct': _scale_zone(_find_pct_zone(
                img_1080, PCT_SEARCH[2], PCT_MIN_COLS, TEAM2_PCT_ZONE), sx, sy),
            'players': [],
        }
    else:  # cast : pas de nom de map à l'écran, % au centre
        out = {
            'layout': layout, 'cols': [0, 0],
            'map': None,
            'team1_pct': _scale_zone(_find_pct_zone(
                img_1080, CAST_TEAM1_PCT_SEARCH, CAST_PCT_MIN_COLS,
                CAST_TEAM1_PCT_ZONE), sx, sy),
            'team2_pct': _scale_zone(_find_pct_zone(
                img_1080, CAST_TEAM2_PCT_SEARCH, CAST_PCT_MIN_COLS,
                CAST_TEAM2_PCT_ZONE), sx, sy),
            'players': [],
        }
    for row in (1, 2):
        for col, cx, cy in hits[row]:
            out['cols'][row - 1] += 1
            p = {'row': row, 'col': col + 1,
                 'name': _scale_zone((cx - NAME_HALF_W, cy + NAME_DY[0],
                                      cx + NAME_HALF_W, cy + NAME_DY[1]),
                                     sx, sy),
                 'score': _scale_zone((cx - SCORE_HALF_W, cy + SCORE_DY[0],
                                       cx + SCORE_HALF_W, cy + SCORE_DY[1]),
                                      sx, sy)}
            for key, dx in zip(('k', 'd', 'a'), KDA_DX):
                p[key] = _scale_zone((cx + dx - KDA_HALF_W, cy + KDA_DY[0],
                                      cx + dx + KDA_HALF_W, cy + KDA_DY[1]),
                                     sx, sy)
            out['players'].append(p)
    return out


def draw_debug(img, zones):
    """Overlay des zones sur une copie de la frame (contrôle visuel)."""
    vis = img.copy()
    colors = {'map': (0, 255, 255), 'team1_pct': (0, 165, 255),
              'team2_pct': (255, 128, 0), 'name': (0, 255, 0),
              'score': (255, 255, 0), 'k': (0, 0, 255),
              'd': (0, 0, 255), 'a': (0, 0, 255)}
    for key in ('map', 'team1_pct', 'team2_pct'):
        if zones.get(key):
            x1, y1, x2, y2 = zones[key]
            cv2.rectangle(vis, (x1, y1), (x2, y2), colors[key], 2)
    for p in zones.get('players', []):
        for key in ('name', 'score', 'k', 'd', 'a'):
            x1, y1, x2, y2 = p[key]
            cv2.rectangle(vis, (x1, y1), (x2, y2), colors[key], 1)
    cv2.putText(vis, f"layout={zones['layout']} cols={zones['cols']}",
                (20, 40), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 255, 255), 2)
    return vis


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('frame', help='image de la frame (png/jpg)')
    ap.add_argument('--debug', metavar='OUT',
                    help='écrit une image overlay des zones')
    args = ap.parse_args()

    img = cv2.imread(args.frame)
    if img is None:
        print(f'lecture impossible : {args.frame}', file=sys.stderr)
        return 1
    zones = zones_for_frame(img)
    if args.debug:
        cv2.imwrite(args.debug, draw_debug(img, zones))
    print(json.dumps(zones))
    return 0


if __name__ == '__main__':
    sys.exit(main())
