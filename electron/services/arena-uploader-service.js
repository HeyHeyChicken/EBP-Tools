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
// (dossier `games/`) : phase 2 d'analyse (même code que le watch-folder,
// injecté en dépendance), puis upload S3 `arena/pending/` et dépôt du payload
// au backend. Le fichier local (+ sidecar) n'est supprimé qu'une fois les
// DEUX faits — en cas de crash, le re-scan au boot rejoue tout, et l'upsert
// serveur + l'écrasement S3 rendent le retry idempotent.
//
// Résilience réseau (PC de salle sans surveillance) : boucle de retry
// PERSISTANTE — chaque tentative re-demande une URL présignée fraîche (les
// URLs expirent en 30 min), backoff 30 s → 10 min, à l'infini. La queue est
// sérialisée : sans réseau, rien ne passe de toute façon.
//
// Rosters : fournis par un provider optionnel (`setRosterProvider`) — branché
// sur l'API locale EVA quand elle sera intégrée. Sans provider, l'analyse
// tourne sans rosters (kills vides — cf. _match_kill_observations) et le
// dépôt est marqué `noRosters` pour que le backend sache la re-traiter.

const GAME_FILE_RE = /^(\d+)_(\d+)_[A-Za-z0-9-]+_\d+_\d+_[^_]+\.mp4$/;
const RETRY_BASE_DELAY_MS = 30 * 1000;
const RETRY_MAX_DELAY_MS = 10 * 60 * 1000;

let watcher = null;
let deps = null;
let workerRunning = false;
let stopRequested = false;
const QUEUE = [];
let currentFile = null;
let uploadedCount = 0;
let lastError = null;
// Provider async optionnel : (fileName, meta) => {orangePlayers, bluePlayers}
// ou null. Branché plus tard sur l'API locale EVA (réservations).
let rosterProvider = null;

function setRosterProvider(provider) {
    rosterProvider = provider;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * Lit le sidecar `<video>.json` écrit par le pipeline (mode, map, bornes de
 * la game dans le fichier découpé). Absent/illisible → null (fichier déposé
 * à la main : on ne peut pas analyser sans le mode, upload vidéo seule).
 */
function readSidecar(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath + '.json', 'utf8'));
    } catch (_) {
        return null;
    }
}

/**
 * Phase 2 sur la game découpée, avec les rosters du provider s'il y en a un.
 * @returns {{payload: object|null, noRosters: boolean}}
 */
async function analyzeGame(filePath, meta) {
    let orangePlayers = [];
    let bluePlayers = [];
    if (rosterProvider) {
        try {
            const ROSTERS = await rosterProvider(path.basename(filePath), meta);
            if (ROSTERS) {
                orangePlayers = ROSTERS.orangePlayers || [];
                bluePlayers = ROSTERS.bluePlayers || [];
            }
        } catch (e) {
            console.warn('[arena-uploader] roster provider failed:', e.message);
        }
    }
    const NO_ROSTERS = orangePlayers.length === 0 && bluePlayers.length === 0;

    const CHUNK = {
        startSeconds: meta.startSeconds,
        endSeconds: meta.endSeconds,
        gameID: path.basename(filePath),
        mode: meta.mode,
        map: meta.map || '',
        orangePlayers,
        bluePlayers
    };
    // Basse priorité OS : sur le PC de streaming, l'analyse prend les cycles
    // restants et ne fait jamais ramer l'usage principal.
    const RESULTS = await deps.runChunkAnalyzer(
        filePath,
        null,
        [CHUNK],
        {},
        undefined,
        true
    );
    if (RESULTS && RESULTS.error) {
        throw new Error(`Chunk analyzer failed: ${RESULTS.error}`);
    }
    const R = ((RESULTS && RESULTS.results) || []).find(
        (x) => x.gameID === CHUNK.gameID
    );
    return { payload: R ? R.payload : null, noRosters: NO_ROSTERS };
}

/**
 * Upload S3 avec boucle de retry persistante : URL présignée fraîche à chaque
 * tentative, backoff exponentiel plafonné, jusqu'au succès (ou stop du
 * service). L'écrasement d'un objet déjà uploadé est sans danger (même clé).
 */
async function uploadWithPersistentRetry(filePath, ids, token) {
    let delay = RETRY_BASE_DELAY_MS;
    for (;;) {
        if (stopRequested) throw new Error('uploader stopped');
        try {
            const UPLOAD = await requestArenaUploadUrl(
                {
                    roomId: ids.roomId,
                    arenaId: ids.arenaId,
                    fileName: path.basename(filePath)
                },
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

/** Dépôt du payload, même politique de retry persistant que l'upload. */
async function depositWithPersistentRetry(fileName, ids, token, payload, noRosters) {
    let delay = RETRY_BASE_DELAY_MS;
    for (;;) {
        if (stopRequested) throw new Error('uploader stopped');
        try {
            await depositArenaGame(
                {
                    roomId: ids.roomId,
                    arenaId: ids.arenaId,
                    fileName,
                    payload,
                    noRosters
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

async function processGame(filePath) {
    const STATE = arenaModeService.getState();
    const TOKEN = arenaModeService.getArenaToken();
    if (!STATE.registered || !TOKEN) {
        throw new Error('arena mode not registered');
    }
    const IDS = { roomId: STATE.roomId, arenaId: STATE.arenaId };

    console.log('[arena-uploader] processing', path.basename(filePath));

    // Phase 2 d'abord (CPU local, ne dépend pas du réseau) : si elle échoue,
    // on uploade quand même la vidéo — payload null, le backend saura.
    const META = readSidecar(filePath);
    let analysis = { payload: null, noRosters: true };
    if (META) {
        try {
            analysis = await analyzeGame(filePath, META);
        } catch (e) {
            console.error('[arena-uploader] analysis failed:', e.message);
        }
    } else {
        console.warn(
            '[arena-uploader] no sidecar for',
            path.basename(filePath),
            '— uploading video without analysis'
        );
    }

    await uploadWithPersistentRetry(filePath, IDS, TOKEN);
    await depositWithPersistentRetry(
        path.basename(filePath),
        IDS,
        TOKEN,
        analysis.payload,
        analysis.noRosters
    );

    // Tout est au chaud côté serveur : on libère le disque du PC de salle.
    for (const P of [filePath, filePath + '.json']) {
        try {
            if (fs.existsSync(P)) fs.unlinkSync(P);
        } catch (e) {
            console.error('[arena-uploader] cleanup failed:', P, e.message);
        }
    }
    uploadedCount++;
    lastError = null;
    console.log('[arena-uploader] done', path.basename(filePath));
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
                await processGame(NEXT);
                QUEUE.shift();
            } catch (e) {
                // Erreur non réseau (les erreurs réseau sont retry à l'infini
                // en amont) : on écarte le fichier de la queue mais on le
                // laisse sur disque — re-tenté au prochain boot.
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

/**
 * Démarre l'uploader sur le dossier `games/` du pipeline. Le re-scan initial
 * de chokidar (`ignoreInitial: false`) reconstruit la queue au boot — même
 * garantie de reprise après crash que le watch-folder.
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

    const GAMES_DIR = arenaPipelineService.getStatus().gamesFolder;
    if (!fs.existsSync(GAMES_DIR)) fs.mkdirSync(GAMES_DIR, { recursive: true });

    watcher = chokidar.watch(GAMES_DIR, {
        persistent: true,
        ignoreInitial: false,
        depth: 0,
        // Le pipeline écrit la découpe puis le sidecar : on attend la
        // stabilité pour ne pas partir sans le .json.
        awaitWriteFinish: { stabilityThreshold: 3000, pollInterval: 500 }
    });
    watcher.on('add', (p) => {
        if (!GAME_FILE_RE.test(path.basename(p))) return;
        if (QUEUE.includes(p)) return;
        QUEUE.push(p);
        workerLoop().catch((e) =>
            console.error('[arena-uploader] worker crashed', e)
        );
    });
    watcher.on('error', (e) =>
        console.error('[arena-uploader] watcher error', e)
    );

    console.log('[arena-uploader] watching', GAMES_DIR);
}

function stop() {
    stopRequested = true;
    if (watcher) {
        watcher.close();
        watcher = null;
    }
    deps = null;
}

function getStatus() {
    return {
        active: !!watcher,
        queued: QUEUE.length,
        currentFile: currentFile ? path.basename(currentFile) : null,
        uploadedCount,
        lastError
    };
}

module.exports = { start, stop, getStatus, setRosterProvider };
