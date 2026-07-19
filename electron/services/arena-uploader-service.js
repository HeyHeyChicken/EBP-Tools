// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const fs = require('fs');
const path = require('node:path');
const chokidar = require('chokidar');
const arenaModeService = require('./arena-mode-service');
const arenaPipelineService = require('./arena-pipeline-service');
const arenaEvaPoller = require('./arena-eva-poller-service');
const {
    requestArenaUploadUrl,
    depositArenaGame,
    uploadFileToPresignedUrl
} = require('./tools-api-client');

//#endregion

// Mode salle — UPLOADER. Consomme les games découpées par le pipeline
// (dossier `games/`). Chaque game est d'abord MATCHÉE contre la pile EVA
// (arena-eva-poller) : on n'analyse une game que quand on a récupéré ses
// rosters + son gameId depuis l'API EVA. Ensuite : phase 2 (rosters trustés),
// upload S3 `arena/pending/` sous un nom PORTANT le gameId (matching exact à
// l'import), dépôt du payload. Fichier + sidecar supprimés une fois les deux
// faits — reprise après crash garantie par le re-scan + l'upsert idempotent.
//
// Gate roster : si la game n'est pas encore dans la pile, on la DÉFÈRE (elle
// reste dans games/, retentée toutes les 2 min). Au-delà d'1 h sans match
// (EVA n'a jamais publié la game), on la déplace en `failed/` (ni analyse ni
// upload) — décision Antoine : jamais d'analyse sans rosters.
//
// Résilience réseau : upload + dépôt ont chacun une boucle de retry
// PERSISTANTE (URL présignée fraîche à chaque tentative, backoff 30 s → 10 min,
// à l'infini). Sérialisé : une seule game traitée à la fois (protection CPU).

// Nom PROVISOIRE écrit par le pipeline (sans gameId — inconnu à l'extraction) :
// {roomId}_{arenaId}_{SafeMap}_{start}_{end}_{scores}.mp4
const GAME_FILE_RE = /^(\d+)_(\d+)_([A-Za-z0-9-]+)_(\d+)_(\d+)_([^_]+)\.mp4$/;
const RETRY_BASE_DELAY_MS = 30 * 1000;
const RETRY_MAX_DELAY_MS = 10 * 60 * 1000;
// Re-scan périodique de games/ : rattrape les games déférées (en attente de la
// pile EVA) que chokidar ne ré-émet pas.
const RETRY_SCAN_MS = 2 * 60 * 1000;
// Au-delà de ce délai sans match dans la pile → failed/ (EVA n'a jamais
// publié la game).
const ROSTER_BACKSTOP_MS = 60 * 60 * 1000;

let watcher = null;
let retryTimer = null;
let deps = null;
let workerRunning = false;
let stopRequested = false;
const QUEUE = [];
let currentFile = null;
let uploadedCount = 0;
let deferredCount = 0;
let lastError = null;
// Première fois qu'une game a été vue sans match pile : base du backstop 1 h.
const firstSeen = new Map();

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

/**
 * Phase 2 sur la game découpée avec les rosters trustés de la pile EVA.
 * @returns {object|null} payload d'analyse.
 */
async function analyzeGame(filePath, meta, rosters) {
    const CHUNK = {
        startSeconds: meta.startSeconds,
        endSeconds: meta.endSeconds,
        gameID: path.basename(filePath),
        mode: meta.mode,
        map: meta.map || '',
        orangePlayers: rosters.orangePlayers || [],
        bluePlayers: rosters.bluePlayers || []
    };
    // Priorité normale : dépriorisée, la phase 2 devenait interminable sur le
    // PC de salle (constaté le 2026-07-19). Protection CPU = sérialisation.
    const RESULTS = await deps.runChunkAnalyzer(filePath, null, [CHUNK], {});
    if (RESULTS && RESULTS.error) {
        throw new Error(`Chunk analyzer failed: ${RESULTS.error}`);
    }
    const R = ((RESULTS && RESULTS.results) || []).find(
        (x) => x.gameID === CHUNK.gameID
    );
    return R ? R.payload : null;
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

    // Gate roster : la game doit être dans la pile EVA (rosters + gameId).
    const ENTRY = arenaEvaPoller.findGame(META.map || '', END_EPOCH);
    if (!ENTRY) {
        const FIRST = firstSeen.get(filePath) ?? Date.now();
        firstSeen.set(filePath, FIRST);
        if (Date.now() - FIRST > ROSTER_BACKSTOP_MS) {
            console.warn(
                `[arena-uploader] no EVA match after backstop → failed/ ${NAME}`
            );
            firstSeen.delete(filePath);
            moveToFailed(filePath);
            return 'failed';
        }
        console.log(`[arena-uploader] no EVA match yet, deferring ${NAME}`);
        return 'deferred';
    }

    console.log(
        `[arena-uploader] processing ${NAME} → EVA game ${ENTRY.gameId}`
    );
    const ROSTERS = arenaEvaPoller.buildRosters(ENTRY);
    const S3_NAME = buildS3FileName(NAME, ENTRY.gameId);

    const PAYLOAD = await analyzeGame(filePath, META, ROSTERS);

    await uploadWithPersistentRetry(filePath, S3_NAME, IDS, TOKEN);
    await depositWithPersistentRetry(S3_NAME, IDS, TOKEN, PAYLOAD);
    // Game rattachée côté serveur : on ne la re-matchera plus, on libère le disque.
    arenaEvaPoller.markConsumed(ENTRY.gameId);
    for (const P of [filePath, filePath + '.json']) {
        try {
            if (fs.existsSync(P)) fs.unlinkSync(P);
        } catch (e) {
            console.error('[arena-uploader] cleanup failed:', P, e.message);
        }
    }
    firstSeen.delete(filePath);
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
                firstSeen.delete(NEXT);
                continue;
            }
            currentFile = NEXT;
            try {
                const RESULT = await processGame(NEXT);
                if (RESULT === 'deferred') deferredCount++;
                // 'deferred' : on retire de la queue active — le re-scan
                // périodique la ré-enfilera quand la pile l'aura.
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
 * @param {{runChunkAnalyzer: Function}} dependencies
 */
function start(dependencies) {
    if (watcher) return;
    if (!dependencies || !dependencies.runChunkAnalyzer) {
        throw new Error(
            'arena-uploader-service.start: missing runChunkAnalyzer dep'
        );
    }
    deps = dependencies;
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
    deps = null;
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
