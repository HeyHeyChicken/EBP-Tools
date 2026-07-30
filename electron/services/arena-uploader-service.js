// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const fs = require('fs');
const path = require('node:path');
const chokidar = require('chokidar');
const arenaModeService = require('./arena-mode-service');
const arenaPipelineService = require('./arena-pipeline-service');
const {
    requestArenaUploadUrl,
    depositArenaGame,
    uploadFileToPresignedUrl
} = require('./tools-api-client');

//#endregion

// Mode salle — UPLOADER. Consomme les games découpées par le pipeline
// (dossier `games/`). Une game n'est uploadée que porteuse de son gameId EVA :
// upload S3 `arena/pending/` sous un nom PORTANT le gameId (matching exact à
// l'import), dépôt SANS payload. Fichier + sidecar supprimés une fois les deux
// faits — reprise après crash garantie par le re-scan + l'upsert idempotent.
//
// V1 : plus d'analyse phase 2 (killfeed) sur le PC de salle. Le but n'est plus
// l'analyse mais que les games soient uploadées et rattachées ; le hook
// d'import EVA attache la vidéo par (gameId, terrain), les joueurs sont déjà
// connus côté serveur. Le killfeed pourra être rebranché plus tard.
//
// ⚠️ Gate gameId EN ATTENTE DE SERVICE : la pile locale du poller EVA a été
// supprimée (EvaBattlePlan est désormais la source de référence des games). Le
// service qui raccroche une game découpée à son gameId reste à écrire ; d'ici
// là `resolveEvaGameId` renvoie null et TOUTE game est DÉFÉRÉE : elle reste
// découpée dans `games/`, retentée toutes les 2 min, jamais déplacée ni
// supprimée.
//
// Résilience réseau : upload + dépôt ont chacun une boucle de retry
// PERSISTANTE (URL présignée fraîche à chaque tentative, backoff 30 s → 10 min,
// à l'infini). Sérialisé : une seule game traitée à la fois (protection CPU).

// Nom PROVISOIRE écrit par le pipeline (sans gameId — inconnu à l'extraction) :
// {roomId}_{arenaId}_{SafeMap}_{start}_{end}_{scores}.mp4
const GAME_FILE_RE = /^(\d+)_(\d+)_([A-Za-z0-9-]+)_(\d+)_(\d+)_([^_]+)\.mp4$/;
const RETRY_BASE_DELAY_MS = 30 * 1000;
const RETRY_MAX_DELAY_MS = 10 * 60 * 1000;
// Re-scan périodique de games/ : rattrape les games déférées (en attente de
// leur gameId EVA) que chokidar ne ré-émet pas.
const RETRY_SCAN_MS = 2 * 60 * 1000;

let watcher = null;
let retryTimer = null;
let workerRunning = false;
let stopRequested = false;
const QUEUE = [];
let currentFile = null;
let uploadedCount = 0;
let deferredCount = 0;
let lastError = null;

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function getGamesDir() {
    return arenaPipelineService.getStatus().gamesFolder;
}

function getFailedDir() {
    return path.join(path.dirname(getGamesDir()), 'failed');
}

/** Lit le sidecar `<video>.json` du pipeline (mode, map, bornes). Null si absent. */
function readSidecar(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath + '.json', 'utf8'));
    } catch (_) {
        return null;
    }
}

/** Déplace la game + son sidecar vers failed/ (analyse impossible). */
function moveToFailed(filePath) {
    const FAILED = getFailedDir();
    if (!fs.existsSync(FAILED)) fs.mkdirSync(FAILED, { recursive: true });
    for (const SRC of [filePath, filePath + '.json']) {
        if (!fs.existsSync(SRC)) continue;
        try {
            fs.renameSync(SRC, path.join(FAILED, path.basename(SRC)));
        } catch (e) {
            console.error('[arena-uploader] move to failed failed:', SRC, e.message);
        }
    }
}

/**
 * Insère le gameId EVA dans le nom provisoire pour produire le nom S3 :
 * {roomId}_{arenaId}_{gameId}_{SafeMap}_{start}_{end}_{scores}.mp4
 */
function buildS3FileName(provisionalName, gameId) {
    const M = provisionalName.match(GAME_FILE_RE);
    if (!M) return null;
    const [, roomId, arenaId, map, start, end, scores] = M;
    return `${roomId}_${arenaId}_${gameId}_${map}_${start}_${end}_${scores}.mp4`;
}

/** Upload S3 avec retry persistant. `s3FileName` = nom PORTANT le gameId. */
async function uploadWithPersistentRetry(filePath, s3FileName, ids, token) {
    let delay = RETRY_BASE_DELAY_MS;
    for (;;) {
        if (stopRequested) throw new Error('uploader stopped');
        try {
            const UPLOAD = await requestArenaUploadUrl(
                { roomId: ids.roomId, arenaId: ids.arenaId, fileName: s3FileName },
                token
            );
            await uploadFileToPresignedUrl(UPLOAD.url, filePath, {
                contentType: 'video/mp4'
            });
            return;
        } catch (e) {
            lastError = e.message;
            console.warn(
                `[arena-uploader] upload failed (${e.message}), retry in ${delay / 1000}s`
            );
            await sleep(delay);
            delay = Math.min(delay * 2, RETRY_MAX_DELAY_MS);
        }
    }
}

/** Dépôt du payload, même politique de retry persistant. */
async function depositWithPersistentRetry(s3FileName, ids, token, payload) {
    let delay = RETRY_BASE_DELAY_MS;
    for (;;) {
        if (stopRequested) throw new Error('uploader stopped');
        try {
            await depositArenaGame(
                {
                    roomId: ids.roomId,
                    arenaId: ids.arenaId,
                    fileName: s3FileName,
                    payload,
                    noRosters: false
                },
                token
            );
            return;
        } catch (e) {
            lastError = e.message;
            console.warn(
                `[arena-uploader] deposit failed (${e.message}), retry in ${delay / 1000}s`
            );
            await sleep(delay);
            delay = Math.min(delay * 2, RETRY_MAX_DELAY_MS);
        }
    }
}

/**
 * gameId EVA d'une game découpée, ou null si on ne le connaît pas (encore).
 *
 * TODO — service à écrire : le raccrochage doit interroger EvaBattlePlan, seule
 * source de référence des games (il les obtient par le push du poller, son
 * propre poller et les imports d'équipe). Tant que ce service n'existe pas,
 * cette fonction renvoie null et aucune game n'est uploadée : elles restent
 * découpées dans `games/`.
 * @param {string} mapName map détectée par la phase 1.
 * @param {number} endEpochSec fin de la game (secondes).
 * @returns {Promise<string|null>}
 */
async function resolveEvaGameId(mapName, endEpochSec) {
    console.log(
        `[arena-uploader] no EVA game id (resolver not implemented) map=${mapName} end=${endEpochSec}`
    );
    return null;
}

/**
 * Traite une game. Renvoie 'done' | 'deferred' | 'failed'.
 * @returns {Promise<'done'|'deferred'|'failed'>}
 */
async function processGame(filePath) {
    const STATE = arenaModeService.getState();
    const TOKEN = arenaModeService.getArenaToken();
    if (!STATE.registered || !TOKEN) {
        throw new Error('arena mode not registered');
    }
    const IDS = { roomId: STATE.roomId, arenaId: STATE.arenaId };
    const NAME = path.basename(filePath);

    const M = NAME.match(GAME_FILE_RE);
    const META = readSidecar(filePath);
    if (!M || !META) {
        console.warn('[arena-uploader] unparseable / no sidecar →', NAME);
        moveToFailed(filePath);
        return 'failed';
    }
    const END_EPOCH = parseInt(M[5], 10);

    // Gate gameId : jamais d'upload sans identité EVA (décision Antoine).
    const GAME_ID = await resolveEvaGameId(META.map || '', END_EPOCH);
    if (GAME_ID == null) {
        console.log(`[arena-uploader] deferring ${NAME}`);
        return 'deferred';
    }

    console.log(`[arena-uploader] processing ${NAME} → EVA game ${GAME_ID}`);
    const S3_NAME = buildS3FileName(NAME, GAME_ID);

    // V1 : dépôt sans payload d'analyse. Le hook d'import EVA rattache la vidéo
    // par (gameId, terrain) ; il n'upsert une analyse que si le payload est
    // présent (cf. wiki/arena_mode_api.md §5).
    await uploadWithPersistentRetry(filePath, S3_NAME, IDS, TOKEN);
    await depositWithPersistentRetry(S3_NAME, IDS, TOKEN, null);
    // Game rattachée côté serveur : on libère le disque.
    for (const P of [filePath, filePath + '.json']) {
        try {
            if (fs.existsSync(P)) fs.unlinkSync(P);
        } catch (e) {
            console.error('[arena-uploader] cleanup failed:', P, e.message);
        }
    }
    uploadedCount++;
    lastError = null;
    console.log('[arena-uploader] done', NAME);
    return 'done';
}

async function workerLoop() {
    if (workerRunning) return;
    workerRunning = true;
    try {
        while (!stopRequested && QUEUE.length > 0) {
            const NEXT = QUEUE[0];
            if (!fs.existsSync(NEXT)) {
                QUEUE.shift();
                continue;
            }
            currentFile = NEXT;
            try {
                const RESULT = await processGame(NEXT);
                if (RESULT === 'deferred') deferredCount++;
                // 'deferred' : on retire de la queue active — le re-scan
                // périodique la ré-enfilera.
                QUEUE.shift();
            } catch (e) {
                console.error(
                    '[arena-uploader] processing failed for',
                    NEXT,
                    e.message
                );
                lastError = e.message;
                QUEUE.shift();
            } finally {
                currentFile = null;
            }
        }
    } finally {
        workerRunning = false;
    }
}

function enqueue(filePath) {
    if (QUEUE.includes(filePath) || filePath === currentFile) return;
    QUEUE.push(filePath);
    workerLoop().catch((e) =>
        console.error('[arena-uploader] worker crashed', e)
    );
}

/** Re-scan de games/ : ré-enfile les games déférées (hors sous-dossiers). */
function rescanGames() {
    const DIR = getGamesDir();
    let entries;
    try {
        entries = fs.readdirSync(DIR);
    } catch (_) {
        return;
    }
    for (const NAME of entries) {
        if (GAME_FILE_RE.test(NAME)) enqueue(path.join(DIR, NAME));
    }
}

/**
 * Démarre l'uploader sur `games/`. Re-scan initial (chokidar ignoreInitial:
 * false) + re-scan périodique pour les games déférées.
 */
function start() {
    if (watcher) return;
    stopRequested = false;

    const GAMES_DIR = getGamesDir();
    if (!fs.existsSync(GAMES_DIR)) fs.mkdirSync(GAMES_DIR, { recursive: true });

    watcher = chokidar.watch(GAMES_DIR, {
        persistent: true,
        ignoreInitial: false,
        depth: 0,
        awaitWriteFinish: { stabilityThreshold: 3000, pollInterval: 500 }
    });
    watcher.on('add', (p) => {
        if (GAME_FILE_RE.test(path.basename(p))) enqueue(p);
    });
    watcher.on('error', (e) =>
        console.error('[arena-uploader] watcher error', e)
    );
    retryTimer = setInterval(rescanGames, RETRY_SCAN_MS);

    console.log('[arena-uploader] watching', GAMES_DIR);
}

function stop() {
    stopRequested = true;
    if (watcher) {
        watcher.close();
        watcher = null;
    }
    if (retryTimer) {
        clearInterval(retryTimer);
        retryTimer = null;
    }
}

function getStatus() {
    return {
        active: !!watcher,
        queued: QUEUE.length,
        currentFile: currentFile ? path.basename(currentFile) : null,
        uploadedCount,
        deferredCount,
        lastError
    };
}

module.exports = { start, stop, getStatus };
