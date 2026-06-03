// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const fs = require('fs');
const os = require('os');
const path = require('node:path');
const chokidar = require('chokidar');
const { Notification, app } = require('electron');
const StorageManager = require('../core/storage-manager');
const { unlinkSync } = require('./global-service');
const { cutAndEncodeGame } = require('./video-service');
const {
    identifyGames,
    persistAnalysis,
    requestUploadUrl,
    confirmUpload,
    uploadFileToPresignedUrl,
    pushWatcherStatus,
    getAuthCookie,
    NotAuthenticatedError,
    ApiError
} = require('./tools-api-client');

//#endregion

const SETTINGS_KEY_FOLDER = 'replayWatchFolder';
const SUPPORTED_EXT = new Set(['.mp4', '.mkv', '.mov', '.avi', '.webm']);
const AUTH_RETRY_INTERVAL_MS = 30 * 1000;
const MTPG_RE = /__mtpg-(\d+)/;
const MGAST_RE = /__mgast-(\d+)/;
// Scores forcés (panneau "association" côté front) : présents uniquement quand
// l'utilisateur force l'association d'une game pré-découpée. Les deux toujours
// ensemble (validés côté front + server.js avant encodage).
const FOS_RE = /__fos-(\d+)/;
const FBS_RE = /__fbs-(\d+)/;
// Nombre de games analysées en profondeur en parallèle (un process Python par
// game). Ajuster selon les retours terrain : plus on monte, plus on sature CPU
// / mémoire (chaque process recharge tesseract, templates, ouvre sa propre
// VideoCapture). 1 = comportement séquentiel d'avant. Surchargeable par fichier
// via le suffixe `__mgast-N` (voir parseMeta).
const DEEP_ANALYSIS_CONCURRENCY = 3;

/**
 * Extrait les valeurs `maxTimePerGame` et `maxGamesAtSameTime` encodées dans le
 * nom du fichier par `analyzeVideoFile` (suffixes `__mtpg-N` et `__mgast-M`
 * avant l'extension), et renvoie un basename "propre" pour l'aval (cut
 * filenames, sourceFilename API). Si un suffixe est absent (fichier déposé
 * manuellement), la valeur correspondante est undefined → fallback sur la
 * valeur par défaut côté Python / DEEP_ANALYSIS_CONCURRENCY.
 */
function parseMeta(filePath) {
    const EXT = path.extname(filePath);
    const BASE = path.basename(filePath, EXT);
    const MTPG = BASE.match(MTPG_RE);
    const MGAST = BASE.match(MGAST_RE);
    const FOS = BASE.match(FOS_RE);
    const FBS = BASE.match(FBS_RE);
    if (!MTPG && !MGAST && !FOS && !FBS) {
        return {
            cleanBasename: BASE,
            maxTimePerGame: undefined,
            maxGamesAtSameTime: undefined,
            forcedOrangeScore: undefined,
            forcedBlueScore: undefined
        };
    }
    const FIRST_IDX = Math.min(
        MTPG ? MTPG.index : Infinity,
        MGAST ? MGAST.index : Infinity,
        FOS ? FOS.index : Infinity,
        FBS ? FBS.index : Infinity
    );
    return {
        cleanBasename: BASE.slice(0, FIRST_IDX),
        maxTimePerGame: MTPG ? parseInt(MTPG[1], 10) : undefined,
        maxGamesAtSameTime: MGAST ? parseInt(MGAST[1], 10) : undefined,
        forcedOrangeScore: FOS ? parseInt(FOS[1], 10) : undefined,
        forcedBlueScore: FBS ? parseInt(FBS[1], 10) : undefined
    };
}

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

function getFallbackFolder() {
    return path.join(app.getPath('userData'), 'EBP-Tools-Replays');
}

function tryEnsure(root) {
    if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
    ensureSubfolders(root);
}

/**
 * Ensures the watch root and its subfolders exist on disk. Idempotent and
 * cheap — call from `start()` or before opening any of these folders from
 * the tray menu so users always land on a real folder.
 *
 * On Windows, the default location under the user profile can be blocked by
 * Controlled Folder Access / antivirus (EPERM/EACCES). In that case we fall
 * back to `%APPDATA%\<app>\Replays`, persist it as the new setting, and
 * notify the user so the relocation is visible.
 */
function ensureFolders() {
    const ROOT = getWatchFolder();
    try {
        tryEnsure(ROOT);
    } catch (e) {
        if (e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
        const FALLBACK = getFallbackFolder();
        if (FALLBACK === ROOT) throw e;
        console.warn(
            `[watch-folder] cannot use ${ROOT} (${e.code}), falling back to ${FALLBACK}`
        );
        tryEnsure(FALLBACK);
        StorageManager.setPermanentSettingsValue(SETTINGS_KEY_FOLDER, FALLBACK);
    }
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

async function mapWithLimit(items, limit, fn) {
    const RESULTS = new Array(items.length);
    let next = 0;
    const WORKERS = Array.from(
        { length: Math.min(Math.max(1, limit), items.length) },
        async () => {
            while (true) {
                const IDX = next++;
                if (IDX >= items.length) return;
                RESULTS[IDX] = await fn(items[IDX], IDX);
            }
        }
    );
    await Promise.all(WORKERS);
    return RESULTS;
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
 * Push l'état courant au backend (qui broadcast aux sockets du user). Appelé
 * à chaque transition du worker — fire-and-forget : `pushWatcherStatus`
 * swallow toute erreur réseau / auth pour ne pas perturber la pipeline.
 */
function notifyStatusChange() {
    pushWatcherStatus(getStatus());
}

/**
 * Builds the segments payload for /games/identify from analyzer-detected games.
 * Pas de champ `analysis` ici : la phase 2 n'a pas encore tourné quand on appelle
 * identify (l'idée justement c'est de récupérer les rosters AVANT phase 2 pour
 * pouvoir les injecter dans l'OCR du killfeed).
 */
function toIdentifySegments(games, forcedScores) {
    // Scores forcés (game pré-découpée + association forcée) : ils remplacent les
    // scores OCR. Le caller ne les passe que lorsqu'une seule game est détectée
    // (sinon `null`), donc l'override ne s'applique de fait qu'à cette game.
    const FORCED =
        forcedScores &&
        forcedScores.orange !== undefined &&
        forcedScores.blue !== undefined;
    return games.map((g, i) => ({
        tempId: `temp-${i}`,
        startSeconds: g.start,
        endSeconds: g.end,
        mode: g.mode,
        mapName: g.map,
        mapImage: g.mapImage,
        blueScore: FORCED
            ? forcedScores.blue
            : g.blueTeam
              ? g.blueTeam.score
              : null,
        orangeScore: FORCED
            ? forcedScores.orange
            : g.orangeTeam
              ? g.orangeTeam.score
              : null,
        blueTeam: g.blueTeam,
        orangeTeam: g.orangeTeam
    }));
}

/**
 * Processes a single video: detect → identify → analyze chunks (with rosters) →
 * persist analyses → cut → upload. Throws NotAuthenticatedError if auth lost
 * mid-pipeline (caller pauses).
 */
async function processVideo(videoPath, deps) {
    const ROOT = getWatchFolder();
    const TMP_DIR = path.join(ROOT, '.tmp');
    const FAILED_DIR = path.join(ROOT, 'failed');
    ensureSubfolders(ROOT);

    const META = parseMeta(videoPath);
    const SETTINGS =
        META.maxTimePerGame !== undefined
            ? { maxTimePerGame: META.maxTimePerGame }
            : {};

    console.log('[watch-folder] processing', videoPath);

    // Phase 1: detect games
    const DETECT = await deps.runAnalyzer(videoPath, null, SETTINGS);
    if (DETECT.type === 'error') {
        throw new Error(`Analyzer failed: ${DETECT.message}`);
    }
    const GAMES = DETECT.games || [];
    if (GAMES.length === 0) {
        const DEST = moveTo(videoPath, FAILED_DIR);
        console.log('[watch-folder] no games detected →', DEST);
        return;
    }

    // Scores forcés : valables uniquement sur une game pré-découpée isolée. Si
    // la détection en trouve plusieurs, on ne peut pas savoir à laquelle les
    // attribuer → on ignore le forçage et on retombe sur l'association OCR.
    const FORCED_SCORES =
        META.forcedOrangeScore !== undefined &&
        META.forcedBlueScore !== undefined;
    if (FORCED_SCORES && GAMES.length !== 1) {
        console.log(
            `[watch-folder] forced scores ignorés : ${GAMES.length} games détectées (1 attendue)`
        );
    }

    // Identify : on demande au back les rosters trustés AVANT la phase 2 pour
    // pouvoir les passer en argument à l'analyse approfondie (utile au fuzzy
    // match du killfeed OCR).
    const IDENTIFY_PAYLOAD = {
        sourceFilename: META.cleanBasename + path.extname(videoPath),
        segments: toIdentifySegments(
            GAMES,
            FORCED_SCORES && GAMES.length === 1
                ? { orange: META.forcedOrangeScore, blue: META.forcedBlueScore }
                : null
        )
    };
    console.log(
        '[watch-folder] identify payload:',
        JSON.stringify(IDENTIFY_PAYLOAD, null, 2)
    );
    const IDENTIFY_RES = await identifyGames(IDENTIFY_PAYLOAD);
    console.log(
        '[watch-folder] identify response:',
        JSON.stringify(IDENTIFY_RES, null, 2)
    );
    const MATCHES = IDENTIFY_RES.matches || [];
    const MATCH_BY_TEMP = new Map(
        MATCHES.map((m) => [
            m.tempId,
            {
                gameID: m.gameID,
                hasVideo: !!m.hasVideo,
                orangePlayers: m.orangePlayers || [],
                bluePlayers: m.bluePlayers || []
            }
        ])
    );

    // Phase 2: deep analysis on all detected games. On injecte les rosters de
    // l'identify dans chaque chunk — Python s'en sert comme liste de pseudos
    // trustés pour le fuzzy match du killfeed OCR. Pas de match côté back ?
    // tableaux vides → fallback OCR-only côté Python.
    const CHUNKS = GAMES.map((g, i) => {
        const TEMP_ID = `temp-${i}`;
        const M = MATCH_BY_TEMP.get(TEMP_ID);
        return {
            startSeconds: g.start,
            endSeconds: g.end,
            gameID: TEMP_ID,
            mode: g.mode,
            // Nom de map (ex. "Outlaw", "Helios Station") — Python s'en sert
            // pour appliquer la règle Domination/Hardpoint sur points_timeline
            // (Outlaw = Hardpoint, le reste = Domination).
            map: g.map || '',
            orangePlayers: M ? M.orangePlayers : [],
            bluePlayers: M ? M.bluePlayers : []
        };
    });
    // Un process Python par game, plafonné à CONCURRENCY en vol. Chaque process
    // est totalement indépendant (sa propre VideoCapture, son propre OCR) —
    // vraie parallélisation, pas de GIL. Si l'un crashe (`error`), on remonte
    // la première erreur rencontrée — semantics identiques au cas séquentiel
    // d'avant.
    const CONCURRENCY = META.maxGamesAtSameTime ?? DEEP_ANALYSIS_CONCURRENCY;
    const DEEP_T0 = Date.now();
    const CHUNK_RESULTS = await mapWithLimit(CHUNKS, CONCURRENCY, (chunk) =>
        deps.runChunkAnalyzer(videoPath, null, [chunk], SETTINGS)
    );
    const DEEP_ELAPSED_S = ((Date.now() - DEEP_T0) / 1000).toFixed(1);
    console.log(
        `[watch-folder] deep analysis for ${path.basename(videoPath)}: ${DEEP_ELAPSED_S}s (${CHUNKS.length} games, concurrency=${CONCURRENCY})`
    );
    const FIRST_ERROR = CHUNK_RESULTS.find((r) => r && r.error);
    if (FIRST_ERROR) {
        throw new Error(`Chunk analyzer failed: ${FIRST_ERROR.error}`);
    }
    const ANALYSIS_BY_TEMP = {};
    for (const RES of CHUNK_RESULTS) {
        for (const r of RES.results || []) {
            ANALYSIS_BY_TEMP[r.gameID] = { payload: r.payload };
        }
    }
    console.log(ANALYSIS_BY_TEMP);

    // Persist : on remonte au back les analyses approfondies pour les games
    // matchées par identify (les unmatched n'ont pas de gameID, on skip).
    const ANALYSES_TO_PERSIST = [];
    for (const M of MATCHES) {
        const A = ANALYSIS_BY_TEMP[M.tempId];
        if (!A || A.payload === undefined) continue;
        ANALYSES_TO_PERSIST.push({ gameID: M.gameID, payload: A.payload });
    }
    if (ANALYSES_TO_PERSIST.length > 0) {
        const PERSIST_RES = await persistAnalysis({
            analyses: ANALYSES_TO_PERSIST
        });
        if (PERSIST_RES.failed && PERSIST_RES.failed.length > 0) {
            console.log(
                '[watch-folder] persist-analysis partial failures:',
                PERSIST_RES.failed
            );
        }
    }

    // Phase 4: cut every detected game into its own file (skip those qui ont déjà
    // une vidéo côté serveur — pas de découpage, pas de réencodage).
    const VIDEO_BASENAME = META.cleanBasename;
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
                notifyStatusChange();
                workerRunning = false;
                return;
            }
            if (!fs.existsSync(NEXT)) {
                dequeue(NEXT);
                notifyStatusChange();
                continue;
            }
            if (!(await getAuthCookie())) {
                console.log('[watch-folder] not authenticated, pausing');
                await sleep(AUTH_RETRY_INTERVAL_MS);
                continue;
            }
            CURRENT_PATH = NEXT;
            notifyStatusChange();
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
                notifyStatusChange();
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
        notifyStatusChange();
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
