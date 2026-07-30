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
    confirmArenaUpload,
    uploadFileToPresignedUrl
} = require('./tools-api-client');

//#endregion

// Mode salle — UPLOADER. Consomme les games découpées par le pipeline
// (dossier `games/`) et déjà identifiées par arena-identify-service : le gameId
// EVA est dans le nom du fichier (7 champs), une game non identifiée en porte 6
// et reste invisible ici. Il n'y a donc AUCUNE gate à réévaluer.
//
// Un seul appel réseau par game : on demande une URL présignée pour ce gameId et
// on pousse le fichier. Le serveur écrit à l'emplacement DÉFINITIF des replays,
// `statistics/replays/{T_Games.guid}.mp4` — même nommage qu'une analyse locale.
// Rien à déposer ensuite : l'existence de l'objet EST la trace de l'upload, et
// le hook d'import s'en sert pour attacher la vidéo à l'équipe. Fichier +
// fichier local supprimé une fois l'upload confirmé.
//
// V1 : plus d'analyse phase 2 (killfeed) sur le PC de salle — les joueurs sont
// déjà connus côté serveur. Le killfeed pourra être rebranché plus tard.
//
// Résilience réseau : boucle de retry PERSISTANTE (URL fraîche à chaque
// tentative, backoff 30 s → 10 min, à l'infini). La clé S3 étant déterministe,
// un retry réécrit le même objet — aucun doublon possible. Sérialisé : une seule
// game à la fois (protection CPU).

// Nom d'une game IDENTIFIÉE (7 champs, gameId en 3e position) :
// {roomId}_{arenaId}_{gameId}_{SafeMap}_{start}_{end}_{scores}.mp4
const GAME_FILE_RE =
    /^(\d+)_(\d+)_(\d+)_([A-Za-z0-9-]+)_(\d+)_(\d+)_([^_]+)\.mp4$/;
const RETRY_BASE_DELAY_MS = 30 * 1000;
const RETRY_MAX_DELAY_MS = 10 * 60 * 1000;
// Re-scan périodique de games/ : rattrape les games identifiées par un simple
// renommage, que chokidar peut ne pas ré-émettre.
const RETRY_SCAN_MS = 2 * 60 * 1000;

let watcher = null;
let retryTimer = null;
let workerRunning = false;
let stopRequested = false;
const QUEUE = [];
let currentFile = null;
let uploadedCount = 0;
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

/** Déplace la game vers failed/ (fichier inexploitable). */
function moveToFailed(filePath) {
    const FAILED = getFailedDir();
    if (!fs.existsSync(FAILED)) fs.mkdirSync(FAILED, { recursive: true });
    try {
        fs.renameSync(filePath, path.join(FAILED, path.basename(filePath)));
    } catch (e) {
        console.error('[arena-uploader] move to failed failed:', filePath, e.message);
    }
}

/**
 * Upload S3 avec retry persistant. On envoie le `gameId` EVA : c'est le serveur
 * qui en déduit la clé (`statistics/replays/{T_Games.guid}.mp4`), Tools ne nomme
 * jamais l'objet. Clé déterministe → un retry réécrit le même objet.
 */
async function uploadWithPersistentRetry(filePath, gameId, ids, token) {
    let delay = RETRY_BASE_DELAY_MS;
    for (;;) {
        if (stopRequested) throw new Error('uploader stopped');
        try {
            const UPLOAD = await requestArenaUploadUrl(
                { roomId: ids.roomId, arenaId: ids.arenaId, gameId },
                token
            );
            await uploadFileToPresignedUrl(UPLOAD.url, filePath, {
                contentType: 'video/mp4'
            });
            // Confirme l'upload : le serveur vérifie l'objet en S3 puis indexe la
            // vidéo (T_Terrain_Videos). Best-effort — l'objet est déjà en S3, la
            // réconciliation serveur rattrape un échec de confirmation.
            try {
                await confirmArenaUpload(
                    { roomId: ids.roomId, arenaId: ids.arenaId, gameId },
                    token
                );
            } catch (e) {
                console.warn(`[arena-uploader] confirm-upload failed (${e.message}), serveur réconciliera`);
            }
            return UPLOAD.guid;
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

/**
 * Traite une game identifiée. Renvoie 'done' | 'failed'.
 * @returns {Promise<'done'|'failed'>}
 */
async function processGame(filePath) {
    const STATE = arenaModeService.getState();
    const TOKEN = arenaModeService.getArenaToken();
    if (!STATE.registered || !TOKEN) {
        throw new Error('arena mode not registered');
    }
    const IDS = { roomId: STATE.roomId, arenaId: STATE.arenaId };
    const NAME = path.basename(filePath);

    if (!GAME_FILE_RE.test(NAME)) {
        console.warn('[arena-uploader] unparseable name →', NAME);
        moveToFailed(filePath);
        return 'failed';
    }

    // gameId EVA, 3e champ du nom (posé par le service d'identification).
    const GAME_ID = NAME.match(GAME_FILE_RE)[3];
    console.log(`[arena-uploader] processing ${NAME} (EVA game ${GAME_ID})`);

    const GUID = await uploadWithPersistentRetry(filePath, GAME_ID, IDS, TOKEN);
    console.log(`[arena-uploader] uploaded as ${GUID}.mp4`);
    // La vidéo est en place à l'emplacement définitif : on libère le disque.
    try {
        fs.unlinkSync(filePath);
    } catch (e) {
        console.error('[arena-uploader] cleanup failed:', filePath, e.message);
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
                await processGame(NEXT);
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

/** Re-scan de games/ : ré-enfile les games identifiées (hors sous-dossiers). */
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
        lastError
    };
}

module.exports = { start, stop, getStatus };
