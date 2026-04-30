// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const fs = require('fs');
const os = require('os');
const path = require('node:path');
const chokidar = require('chokidar');
const { Notification } = require('electron');
const StorageManager = require('../core/storage-manager');
const { unlinkSync } = require('./global-service');
const { cutAndEncodeGame } = require('./video-service');
const {
    matchGames,
    requestUploadUrl,
    confirmUpload,
    uploadFileToPresignedUrl,
    getAuthCookie,
    NotAuthenticatedError,
    ApiError
} = require('./tools-api-client');

//#endregion

const SETTINGS_KEY_FOLDER = 'replayWatchFolder';
const SUPPORTED_EXT = new Set(['.mp4', '.mkv', '.mov', '.avi', '.webm']);
const AUTH_RETRY_INTERVAL_MS = 30 * 1000;

let watcher = null;
let workerRunning = false;
let stopRequested = false;
const QUEUE = [];
let CURRENT_PATH = null;

function getDefaultFolder() {
    return path.join(os.homedir(), 'EBP-Tools-Replays');
}

function getWatchFolder() {
    return StorageManager.getPermanentSettingsValue(
        SETTINGS_KEY_FOLDER,
        getDefaultFolder()
    );
}

function ensureSubfolders(root) {
    for (const sub of ['failed', '.tmp']) {
        const P = path.join(root, sub);
        if (!fs.existsSync(P)) fs.mkdirSync(P, { recursive: true });
    }
}

/**
 * Ensures the watch root and its subfolders exist on disk. Idempotent and
 * cheap — call from `start()` or before opening any of these folders from
 * the tray menu so users always land on a real folder.
 */
function ensureFolders() {
    const ROOT = getWatchFolder();
    if (!fs.existsSync(ROOT)) fs.mkdirSync(ROOT, { recursive: true });
    ensureSubfolders(ROOT);
}

function isSupportedVideo(filePath) {
    const EXT = path.extname(filePath).toLowerCase();
    return SUPPORTED_EXT.has(EXT);
}

function isInsideWatchRoot(filePath, root) {
    const REL = path.relative(root, filePath);
    if (REL.startsWith('..') || path.isAbsolute(REL)) return false;
    const FIRST_SEG = REL.split(path.sep)[0];
    return !['failed', '.tmp'].includes(FIRST_SEG);
}

//#region In-memory queue
//
// Pas de persistance : au boot, chokidar (`ignoreInitial: false`) re-scanne
// le dossier surveillé et ré-émet `add` pour chaque fichier présent, ce qui
// reconstruit la queue à l'identique. La purge de `.tmp/` au boot garantit
// qu'on repart d'un état propre.

function enqueue(filePath) {
    if (QUEUE.includes(filePath)) return;
    QUEUE.push(filePath);
}

function dequeue(filePath) {
    const I = QUEUE.indexOf(filePath);
    if (I !== -1) QUEUE.splice(I, 1);
}

function peekNext() {
    return QUEUE[0] ?? null;
}

//#endregion

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function moveTo(srcPath, destDir) {
    if (!fs.existsSync(srcPath)) return;
    if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
    const DEST = path.join(destDir, path.basename(srcPath));
    fs.renameSync(srcPath, DEST);
    return DEST;
}

function safeUnlink(filePath) {
    try {
        if (fs.existsSync(filePath)) unlinkSync(filePath);
    } catch (e) {
        console.error('[watch-folder] unlink error', filePath, e.message);
    }
}

function notifyQueueEmpty(processedCount) {
    if (!Notification.isSupported()) return;
    try {
        new Notification({
            title: 'EBP - Tools',
            body: `${processedCount === 1 ? 'Replay' : `${processedCount} replays`} processed — queue is empty.`
        }).show();
    } catch (e) {
        console.error('[watch-folder] notification error', e.message);
    }
}

/**
 * Builds the segments payload for /games/match from analyzer-detected games.
 */
function toMatchSegments(games, analysisByTempId) {
    return games.map((g, i) => {
        const TEMP_ID = `temp-${i}`;
        return {
            tempId: TEMP_ID,
            startSeconds: g.start,
            endSeconds: g.end,
            mode: g.mode,
            mapName: g.map,
            mapImage: g.mapImage,
            blueScore: g.blueTeam ? g.blueTeam.score : null,
            orangeScore: g.orangeTeam ? g.orangeTeam.score : null,
            blueTeam: g.blueTeam,
            orangeTeam: g.orangeTeam,
            analysis: analysisByTempId[TEMP_ID] || null
        };
    });
}

/**
 * Processes a single video: detect → analyze chunks → match → cut → upload.
 * Throws NotAuthenticatedError if auth lost mid-pipeline (caller pauses).
 */
async function processVideo(videoPath, deps) {
    const ROOT = getWatchFolder();
    const TMP_DIR = path.join(ROOT, '.tmp');
    const FAILED_DIR = path.join(ROOT, 'failed');
    ensureSubfolders(ROOT);

    console.log('[watch-folder] processing', videoPath);

    // Phase 1: detect games
    const DETECT = await deps.runAnalyzer(videoPath, null);
    if (DETECT.type === 'error') {
        throw new Error(`Analyzer failed: ${DETECT.message}`);
    }
    const GAMES = DETECT.games || [];
    if (GAMES.length === 0) {
        const DEST = moveTo(videoPath, FAILED_DIR);
        console.log('[watch-folder] no games detected →', DEST);
        return;
    }

    // Phase 2: deep analysis on all detected games
    const CHUNKS = GAMES.map((g, i) => ({
        startSeconds: g.start,
        endSeconds: g.end,
        gameID: `temp-${i}`,
        mode: g.mode
    }));
    const CHUNK_RES = await deps.runChunkAnalyzer(videoPath, null, CHUNKS);
    if (CHUNK_RES.error) {
        throw new Error(`Chunk analyzer failed: ${CHUNK_RES.error}`);
    }
    const ANALYSIS_BY_TEMP = {};
    for (const r of CHUNK_RES.results || []) {
        ANALYSIS_BY_TEMP[r.gameID] = {
            generated_by: r.generated_by,
            payload: r.payload
        };
    }
    console.log(ANALYSIS_BY_TEMP);

    // Phase 3: ask back to match + persist analysis
    const MATCH_RES = await matchGames({
        sourceFilename: path.basename(videoPath),
        segments: toMatchSegments(GAMES, ANALYSIS_BY_TEMP)
    });
    const MATCHES = MATCH_RES.matches || [];
    const MATCH_BY_TEMP = new Map(
        MATCHES.map((m) => [m.tempId, { gameID: m.gameID, hasVideo: !!m.hasVideo }])
    );

    // Phase 4: cut every detected game into its own file (skip those qui ont déjà
    // une vidéo côté serveur — pas de découpage, pas de réencodage).
    const VIDEO_BASENAME = path.basename(videoPath, path.extname(videoPath));
    const CUT_FILES = [];
    for (let i = 0; i < GAMES.length; i++) {
        const G = GAMES[i];
        const TEMP_ID = `temp-${i}`;
        const M = MATCH_BY_TEMP.get(TEMP_ID);
        if (M && M.hasVideo) {
            console.log(
                `[watch-folder] skipped cut/upload for game ${M.gameID} (tempId=${TEMP_ID}) — video already uploaded`
            );
            continue;
        }
        const SAFE_MAP = (G.map || 'unknown')
            .replace(/[^a-zA-Z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
        const BLUE_SCORE = G.blueTeam ? G.blueTeam.score : '?';
        const ORANGE_SCORE = G.orangeTeam ? G.orangeTeam.score : '?';
        const OUT = path.join(
            TMP_DIR,
            `${VIDEO_BASENAME}___${SAFE_MAP}-${ORANGE_SCORE}-${BLUE_SCORE}__${i}-${Date.now()}.mp4`
        );
        try {
            await cutAndEncodeGame(videoPath, OUT, G.start, G.end);
            CUT_FILES.push({ tempId: TEMP_ID, file: OUT, game: G, index: i });
        } catch (e) {
            console.error(
                `[watch-folder] cut failed for game ${i} of ${videoPath}:`,
                e.message
            );
        }
    }

    // Phase 5: upload matched games, move unmatched and failed uploads to failed/
    for (const CUT of CUT_FILES) {
        const M = MATCH_BY_TEMP.get(CUT.tempId);
        const GAME_ID = M ? M.gameID : null;
        if (!GAME_ID) {
            const DEST = moveTo(CUT.file, FAILED_DIR);
            console.log('[watch-folder] unmatched →', DEST);
            continue;
        }
        try {
            const UPLOAD = await requestUploadUrl(GAME_ID);
            await uploadFileToPresignedUrl(UPLOAD.url, CUT.file);
            await confirmUpload(GAME_ID, { guid: UPLOAD.guid });
            safeUnlink(CUT.file);
            console.log(
                `[watch-folder] uploaded game ${GAME_ID} (tempId=${CUT.tempId})`
            );
        } catch (e) {
            if (e instanceof NotAuthenticatedError) throw e;
            // Filet de sécurité serveur : la game a déjà une vidéo (race ou flag
            // hasVideo manqué). On ne re-upload pas, on jette le cut local.
            if (e instanceof ApiError && e.status === 409) {
                console.log(
                    `[watch-folder] skipped upload for game ${GAME_ID} — already uploaded (409)`
                );
                safeUnlink(CUT.file);
                continue;
            }
            console.error(
                `[watch-folder] upload failed for game ${GAME_ID}:`,
                e.message
            );
            const DEST = moveTo(CUT.file, FAILED_DIR);
            console.log('[watch-folder] failed →', DEST);
        }
    }

    // Phase 6: source video deleted only once every cut has been uploaded or
    // moved to failed/. If we crash mid-pipeline, the source is still there
    // and chokidar re-enqueues it at next boot for a full retry.
    safeUnlink(videoPath);
}

async function workerLoop(deps) {
    if (workerRunning) return;
    workerRunning = true;
    let processedInSession = 0;
    try {
        while (!stopRequested) {
            const NEXT = peekNext();
            if (!NEXT) {
                if (processedInSession > 0) {
                    notifyQueueEmpty(processedInSession);
                }
                workerRunning = false;
                return;
            }
            if (!fs.existsSync(NEXT)) {
                dequeue(NEXT);
                continue;
            }
            if (!(await getAuthCookie())) {
                console.log('[watch-folder] not authenticated, pausing');
                await sleep(AUTH_RETRY_INTERVAL_MS);
                continue;
            }
            CURRENT_PATH = NEXT;
            try {
                await processVideo(NEXT, deps);
                dequeue(NEXT);
                processedInSession++;
            } catch (e) {
                if (e instanceof NotAuthenticatedError) {
                    console.log(
                        '[watch-folder] auth lost mid-pipeline, will retry —',
                        e.detail || e.message
                    );
                    // L'item reste en tête de queue, sera retry après pause.
                    await sleep(AUTH_RETRY_INTERVAL_MS);
                } else {
                    console.error(
                        `[watch-folder] processing failed for ${NEXT}:`,
                        e.message
                    );
                    const ROOT = getWatchFolder();
                    const FAILED_DIR = path.join(ROOT, 'failed');
                    if (fs.existsSync(NEXT)) {
                        try {
                            moveTo(NEXT, FAILED_DIR);
                        } catch (mvErr) {
                            console.error(
                                '[watch-folder] move-to-failed error:',
                                mvErr.message
                            );
                        }
                    }
                    dequeue(NEXT);
                    processedInSession++;
                }
            } finally {
                CURRENT_PATH = null;
            }
        }
    } finally {
        workerRunning = false;
    }
}

/**
 * Starts the watch-folder service.
 * @param {object} deps { runAnalyzer, runChunkAnalyzer } — analyzer runners.
 */
function start(deps) {
    if (watcher) return;
    if (!deps || !deps.runAnalyzer || !deps.runChunkAnalyzer) {
        throw new Error(
            'watch-folder-service.start: missing runAnalyzer/runChunkAnalyzer deps'
        );
    }

    ensureFolders();
    const ROOT = getWatchFolder();

    // Purge any orphan .tmp/ files left by a previous crashed run — the pipeline
    // restarts from scratch on retry, so leftovers are guaranteed to be unused.
    const TMP_DIR = path.join(ROOT, '.tmp');
    if (fs.existsSync(TMP_DIR)) {
        fs.rmSync(TMP_DIR, { recursive: true, force: true });
        fs.mkdirSync(TMP_DIR, { recursive: true });
    }

    stopRequested = false;
    watcher = chokidar.watch(ROOT, {
        ignored: (p) => {
            if (p === ROOT) return false;
            return !isInsideWatchRoot(p, ROOT);
        },
        persistent: true,
        ignoreInitial: false,
        depth: 0,
        awaitWriteFinish: {
            stabilityThreshold: 4000,
            pollInterval: 500
        }
    });

    const onAdd = (p) => {
        if (!isSupportedVideo(p)) return;
        if (!isInsideWatchRoot(p, ROOT)) return;
        console.log('[watch-folder] enqueue', p);
        enqueue(p);
        workerLoop(deps).catch((e) =>
            console.error('[watch-folder] worker crashed', e)
        );
    };

    watcher.on('add', onAdd);
    watcher.on('error', (e) =>
        console.error('[watch-folder] watcher error', e)
    );

    // Kick off the worker in case there are leftover items from a previous run.
    workerLoop(deps).catch((e) =>
        console.error('[watch-folder] worker crashed', e)
    );

    console.log('[watch-folder] watching', ROOT);
}

function stop() {
    stopRequested = true;
    if (watcher) {
        watcher.close();
        watcher = null;
    }
}

/**
 * @returns {{
 *   queued: { name: string, path: string }[],
 *   processing: { name: string, path: string }[],
 *   failed: { name: string, path: string }[]
 * }}
 */
function getStatus() {
    const toItem = (p) => ({ name: path.basename(p), path: p });
    const QUEUED = QUEUE.filter((p) => p !== CURRENT_PATH).map(toItem);
    const PROCESSING = CURRENT_PATH ? [toItem(CURRENT_PATH)] : [];

    const FAILED = [];
    try {
        const FAILED_DIR = path.join(getWatchFolder(), 'failed');
        if (fs.existsSync(FAILED_DIR)) {
            for (const f of fs.readdirSync(FAILED_DIR)) {
                if (isSupportedVideo(f)) {
                    FAILED.push({ name: f, path: path.join(FAILED_DIR, f) });
                }
            }
        }
    } catch (_) {}

    return { queued: QUEUED, processing: PROCESSING, failed: FAILED };
}

module.exports = {
    start,
    stop,
    getWatchFolder,
    getDefaultFolder,
    getStatus,
    ensureFolders
};
