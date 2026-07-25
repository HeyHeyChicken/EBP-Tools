// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const fs = require('fs');
const path = require('node:path');
const https = require('https');
const { safeMapName } = require('./global-service');
const arenaModeService = require('./arena-mode-service');
const arenaCaptureService = require('./arena-capture-service');
const { ingestArenaGames } = require('./tools-api-client');

//#endregion

// Mode salle — POLLER EVA. Interroge en tâche de fond l'API GraphQL publique
// d'EVA (api.eva.gg, PAS d'auth) pour récupérer les parties finies sur notre
// arène : rosters (pseudos + équipes), gameId, map, mode, scores officiels.
// Alimente une PILE locale persistée, dédupliquée par gameId — les games s'y
// accumulent doucement, sans jamais brusquer l'API (poll calé sur la cadence
// de la TV EVA, 90 s). L'uploader lit dans cette pile (jamais d'appel réseau
// au moment de l'analyse) via `findGame(map, endEpoch)`.
//
// L'endpoint est public : on recopie les headers `eva-client-app-name: spa-tv`
// / origin / referer de la TV EVA pour passer pour un client légitime.

const EVA_HOST = 'api.eva.gg';
const EVA_PATH = '/graphql';
const POLL_INTERVAL_MS = 90 * 1000;
const POLL_BACKOFF_MAX_MS = 15 * 60 * 1000;
// On garde une game dans la pile 6 h : une game est toujours matchée dans les
// ~30 min suivant sa fin (extraction + file d'analyse), 6 h est ultra-large.
const PILE_TTL_MS = 6 * 60 * 60 * 1000;
// Fenêtre de matching endedAt ↔ endEpoch : absorbe le décalage entre l'horloge
// du PC de salle et l'horloge serveur EVA. Large, car la map lève l'ambiguïté.
const MATCH_WINDOW_S = 10 * 60;
const FETCH_LIMIT = 10;

// Requête COMPLÈTE (upsertable) : identique à celle du poller serveur EBP
// (eva.service `ARENA_GQL_QUERY`). En plus de la pile (`toPileEntry` n'en lit
// qu'un sous-ensemble), on renvoie les nœuds bruts à EBP (`/games/ingest`) pour
// qu'il les upsert dans T_Games via `toFullGame` + `upsertEVAGames`.
const GQL_QUERY =
    'query($terrainIds:[Int!],$limit:Int){' +
    'listLastGamesAtLocation(terrainIds:$terrainIds,limit:$limit){' +
    'gameId endedAt terrainId battleArena{' +
    'data{duration teamOne{name score}teamTwo{name score}}' +
    'players{id userId data{niceName team outcome score kills deaths assists inflictedDamage firedAccuracy}}' +
    'map{id name identifier maxPlayerCount}mode{id identifier category}' +
    'terrain{id name location{id name department identifier country language}}}}}';

let pollTimer = null;
let stopped = true;
let pollDelayMs = POLL_INTERVAL_MS;
// Pile en mémoire : Map<gameId(string), entry>. Miroir du fichier disque.
let pile = new Map();
let lastPollAt = null;
let lastError = null;

function getPileFile() {
    const ROOT = path.dirname(arenaCaptureService.getStatus().spoolFolder);
    return path.join(ROOT, 'eva-pile.json');
}

function loadPile() {
    try {
        const RAW = fs.readFileSync(getPileFile(), 'utf8');
        const ARR = JSON.parse(RAW);
        pile = new Map(ARR.map((g) => [String(g.gameId), g]));
    } catch (_) {
        pile = new Map();
    }
}

function persistPile() {
    try {
        const FILE = getPileFile();
        const DIR = path.dirname(FILE);
        if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
        fs.writeFileSync(FILE, JSON.stringify([...pile.values()]), 'utf8');
    } catch (e) {
        console.error('[arena-eva-poller] persist failed:', e.message);
    }
}

/**
 * POST GraphQL à api.eva.gg. Résout avec le tableau `listLastGamesAtLocation`,
 * rejette sur erreur réseau / HTTP non-2xx / GraphQL errors.
 */
function fetchGames(terrainId) {
    const BODY = JSON.stringify({
        operationName: null,
        variables: { terrainIds: [terrainId], limit: FETCH_LIMIT },
        query: GQL_QUERY
    });
    const OPTIONS = {
        hostname: EVA_HOST,
        port: 443,
        path: EVA_PATH,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(BODY),
            Accept: '*/*',
            'eva-client-app-name': 'spa-tv',
            Origin: 'https://tv.eva.gg',
            Referer: 'https://tv.eva.gg/'
        }
    };
    return new Promise((resolve, reject) => {
        const REQ = https.request(OPTIONS, (res) => {
            const CHUNKS = [];
            res.on('data', (c) => CHUNKS.push(c));
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(`EVA HTTP ${res.statusCode}`));
                    return;
                }
                try {
                    const JSON_RES = JSON.parse(Buffer.concat(CHUNKS).toString('utf8'));
                    if (JSON_RES.errors) {
                        reject(new Error('EVA GraphQL error'));
                        return;
                    }
                    resolve(JSON_RES.data?.listLastGamesAtLocation || []);
                } catch (e) {
                    reject(e);
                }
            });
        });
        REQ.on('error', reject);
        REQ.write(BODY);
        REQ.end();
    });
}

/**
 * Normalise une game EVA en entrée de pile. Ignore les parties non-battleArena
 * (colorChaos = jeu de peinture, hors périmètre EBP) → null.
 */
function toPileEntry(g) {
    const BA = g.battleArena;
    if (!BA || !BA.data) return null;
    return {
        gameId: String(g.gameId),
        // endedAt EVA est en MILLISECONDES → on stocke en secondes (comme endEpoch).
        endedAtSec: Math.floor(g.endedAt / 1000),
        mapName: BA.map ? BA.map.name : '',
        mapIdentifier: BA.map ? BA.map.identifier : '',
        mode: BA.mode ? BA.mode.identifier : '',
        players: (BA.players || []).map((p) => ({
            name: p.data.niceName,
            team: p.data.team
        })),
        fetchedAtMs: null, // rempli à l'insertion
        consumed: false
    };
}

async function pollOnce() {
    const STATE = arenaModeService.getState();
    if (!STATE.registered || STATE.arenaId == null) return;
    const GAMES = await fetchGames(STATE.arenaId);
    // Ajout des nouvelles games seulement (dédup par gameId) : la pile grossit
    // comme une pile, sans jamais réécrire une entrée déjà connue (ni son flag
    // `consumed`).
    let added = 0;
    // Nœuds bruts des NOUVELLES games (pour le push EBP). Seuls ceux ayant une
    // entrée de pile valide (battleArena) — les colorChaos sont écartés.
    const NEW_RAW = [];
    for (const G of GAMES) {
        const ENTRY = toPileEntry(G);
        if (!ENTRY) continue;
        if (pile.has(ENTRY.gameId)) continue;
        ENTRY.fetchedAtMs = lastPollNowMs();
        pile.set(ENTRY.gameId, ENTRY);
        NEW_RAW.push(G);
        added++;
    }
    // Éviction des vieilles entrées (par âge de fetch).
    const CUTOFF = lastPollNowMs() - PILE_TTL_MS;
    for (const [ID, G] of pile) {
        if (G.fetchedAtMs != null && G.fetchedAtMs < CUTOFF) pile.delete(ID);
    }
    if (added > 0) persistPile();
    else persistPile(); // persiste aussi les évictions

    // Push best-effort des nouvelles games vers EBP (upsert T_Games) : rend les
    // games de la salle dispo sans attendre le poll serveur ni un import
    // d'équipe. Un échec n'interrompt pas le poll — le poller serveur EBP est le
    // filet.
    if (NEW_RAW.length > 0) {
        pushNewGames(STATE, NEW_RAW);
    }
}

/** Envoie (fire-and-forget) les nœuds bruts des nouvelles games à EBP. */
function pushNewGames(state, rawGames) {
    const TOKEN = arenaModeService.getArenaToken();
    if (!TOKEN) return;
    ingestArenaGames(
        { roomId: state.roomId, arenaId: state.arenaId, games: rawGames },
        TOKEN
    ).catch((e) =>
        console.warn('[arena-eva-poller] ingest push failed:', e.message)
    );
}

// Horloge injectable-friendly (un seul point d'accès à Date.now()).
function lastPollNowMs() {
    return Date.now();
}

function scheduleNext() {
    if (stopped) return;
    pollTimer = setTimeout(async () => {
        try {
            await pollOnce();
            lastPollAt = Date.now();
            lastError = null;
            pollDelayMs = POLL_INTERVAL_MS;
        } catch (e) {
            lastError = e.message;
            console.warn('[arena-eva-poller] poll failed:', e.message);
            // Backoff progressif si l'API répond mal / nous bloque.
            pollDelayMs = Math.min(pollDelayMs * 2, POLL_BACKOFF_MAX_MS);
        }
        scheduleNext();
    }, pollDelayMs);
}

/**
 * Cherche dans la pile la game correspondant à une game extraite localement.
 * Match par map (discriminant fort, lève l'ambiguïté d'horloge) + fenêtre
 * temporelle autour de endEpoch ; ignore les games déjà consommées. Renvoie
 * l'entrée (avec rosters + gameId) ou null.
 * @param {string} mapName  map détectée par la phase 1 (nom brut).
 * @param {number} endEpochSec  fin de la game (secondes).
 */
function findGame(mapName, endEpochSec) {
    const SAFE = safeMapName(mapName);
    const CANDIDATES = [...pile.values()].filter(
        (g) =>
            !g.consumed &&
            Math.abs(g.endedAtSec - endEpochSec) <= MATCH_WINDOW_S
    );
    if (CANDIDATES.length === 0) return null;
    // Priorité aux games dont la map correspond ; sinon on retombe sur la
    // proximité temporelle seule (détection de map ratée côté OCR).
    const MAP_MATCHES = CANDIDATES.filter(
        (g) => safeMapName(g.mapName) === SAFE
    );
    const POOL = MAP_MATCHES.length > 0 ? MAP_MATCHES : CANDIDATES;
    POOL.sort(
        (a, b) =>
            Math.abs(a.endedAtSec - endEpochSec) -
            Math.abs(b.endedAtSec - endEpochSec)
    );
    return POOL[0];
}

/** Marque une game consommée (après dépôt réussi) pour ne pas la re-matcher. */
function markConsumed(gameId) {
    const G = pile.get(String(gameId));
    if (G) {
        G.consumed = true;
        persistPile();
    }
}

function start() {
    if (!stopped) return;
    stopped = false;
    pollDelayMs = POLL_INTERVAL_MS;
    loadPile();
    // Premier poll immédiat, puis cadence.
    pollTimer = setTimeout(async () => {
        try {
            await pollOnce();
            lastPollAt = Date.now();
            lastError = null;
        } catch (e) {
            lastError = e.message;
            console.warn('[arena-eva-poller] initial poll failed:', e.message);
        }
        scheduleNext();
    }, 0);
    console.log('[arena-eva-poller] started');
}

function stop() {
    stopped = true;
    if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
    }
}

function getStatus() {
    return {
        active: !stopped,
        pileSize: pile.size,
        lastPollAt,
        lastError
    };
}

module.exports = {
    start,
    stop,
    findGame,
    markConsumed,
    getStatus
};
