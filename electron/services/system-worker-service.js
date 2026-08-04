// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const fs = require('fs');
const os = require('os');
const path = require('node:path');
const {
    fetchPreAnalysisBatch,
    submitPreAnalysis,
    downloadPresignedUrlToFile,
    ApiError
} = require('./tools-api-client');

//#endregion

// MODE SYSTÈME — PRÉ-ANALYSE DES VIDÉOS DE SALLE.
//
// Une salle capte ses games et les envoie à EBP, mais personne ne les analyse :
// le joueur qui rentre chez lui trouve une vidéo brute, pas des statistiques. Ce
// worker comble ce trou en analysant ces vidéos sur une machine dédiée, en amont,
// pour que l'analyse l'attende déjà à la maison.
//
// Il ne tourne QUE si `TOOLS_SYSTEM_KEY` est présente dans l'environnement : c'est
// à la fois le credential et l'interrupteur. Aucune UI, aucun réglage — c'est un
// mode d'exploitation, pas une fonctionnalité utilisateur.
//
// Le pipeline est celui du watch folder, amputé de ses deux étapes fragiles :
//   - pas de `/identify` : la game est désignée par le serveur (le nom de l'objet
//     S3 porte son guid), donc aucun risque d'attacher l'analyse à la mauvaise ;
//   - pas de découpe ni d'upload : la vidéo EST une game, et elle est déjà en S3.
// Reste : phase 1 (bornes réelles de la game dans le fichier) puis phase 2 (OCR +
// tracking), avec les rosters trustés fournis par le serveur.

const POLL_INTERVAL_MS = 5 * 60 * 1000;
// Une seule game à la fois : le serveur réserve pour une heure, et une réservation
// qui expire pendant qu'on analyse ferait re-servir la même vidéo à un autre tour.
const BATCH_SIZE = 1;
// Au-delà, la vidéo n'est pas une game de salle plausible — on ne lance pas une
// analyse de plusieurs heures sur un fichier aberrant.
const MAX_VIDEO_BYTES = 4 * 1024 * 1024 * 1024;

let running = false;
let timer = null;
let deps = null;

/** Dossier de travail des vidéos rapatriées, vidé au fil de l'eau. */
function workDir() {
    const DIR = path.join(os.tmpdir(), 'ebp-pre-analysis');
    fs.mkdirSync(DIR, { recursive: true });
    return DIR;
}

function removeQuietly(filePath) {
    try {
        fs.unlinkSync(filePath);
    } catch (_) {
        /* déjà parti */
    }
}

/**
 * Analyse une game servie par le serveur et remonte son payload.
 * @returns {Promise<boolean>} true si l'analyse a été acceptée par le serveur.
 */
async function processGame(game, systemKey) {
    const VIDEO_PATH = path.join(workDir(), `${game.guid}_${game.terrainId}.mp4`);
    try {
        await downloadPresignedUrlToFile(game.videoUrl, VIDEO_PATH);
        const SIZE = fs.statSync(VIDEO_PATH).size;
        if (SIZE === 0 || SIZE > MAX_VIDEO_BYTES) {
            console.warn(`[system-worker] ${game.gameId} : taille inattendue (${SIZE} o), ignorée`);
            return false;
        }

        // Phase 1 — bornes réelles de la game dans le fichier. La captation de salle
        // déborde de part et d'autre (pré-game, écran de score), et c'est aussi elle
        // qui détecte le mode : ces valeurs ne peuvent pas venir de la base.
        const DETECT = await deps.runAnalyzer(VIDEO_PATH, null, {}, false, true);
        if (DETECT.type === 'error') {
            console.warn(`[system-worker] ${game.gameId} : phase 1 en échec — ${DETECT.message}`);
            return false;
        }
        const DETECTED = DETECT.games || [];
        if (DETECTED.length === 0) {
            console.warn(`[system-worker] ${game.gameId} : aucune game détectée dans la vidéo`);
            return false;
        }
        // Une vidéo de salle = une game. Si la détection en voit plusieurs (bornes
        // douteuses), on garde la plus longue : c'est la game, les autres sont des
        // résidus de la game voisine.
        const MAIN = DETECTED.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));

        // Phase 2 — OCR + tracking. Le serveur fournit ce que le chemin client obtient
        // de /identify : rosters trustés (fuzzy match des pseudos du killfeed) et
        // scores officiels (bornes hautes de l'OCR in-game).
        const CHUNK = {
            startSeconds: MAIN.start,
            endSeconds: MAIN.end,
            gameID: String(game.gameId),
            mode: MAIN.mode,
            map: MAIN.map || game.map || '',
            orangeScore: game.orangeScore,
            blueScore: game.blueScore,
            orangePlayers: game.orangePlayers || [],
            bluePlayers: game.bluePlayers || []
        };
        // lowPriority : cette machine sert aussi à autre chose, la pré-analyse n'est
        // jamais urgente.
        const RESULTS = await deps.runChunkAnalyzer(VIDEO_PATH, null, [CHUNK], {}, null, true);
        if (RESULTS && RESULTS.error) {
            console.warn(`[system-worker] ${game.gameId} : phase 2 en échec — ${RESULTS.error}`);
            return false;
        }
        const ENTRY = (RESULTS.results || []).find((r) => String(r.gameID) === String(game.gameId));
        if (!ENTRY || ENTRY.payload === undefined) {
            console.warn(`[system-worker] ${game.gameId} : aucun payload produit`);
            return false;
        }

        await submitPreAnalysis({ gameId: String(game.gameId), payload: ENTRY.payload }, systemKey);
        console.log(
            `[system-worker] ${game.gameId} analysée (${game.map || 'map inconnue'}${game.hasPro ? ', abonné Statistics Pro' : ''})`
        );
        return true;
    } catch (e) {
        // 404 (vidéo disparue) et 422 (clé refusée, ou analyse sans kill) sont
        // définitifs : le serveur ne changera pas d'avis, on log et on passe.
        if (e instanceof ApiError && (e.status === 404 || e.status === 422)) {
            console.warn(`[system-worker] ${game.gameId} refusée par le serveur : ${e.body}`);
            return false;
        }
        console.error(`[system-worker] ${game.gameId} : échec`, e);
        return false;
    } finally {
        removeQuietly(VIDEO_PATH);
        removeQuietly(VIDEO_PATH + '.part');
    }
}

/**
 * Un tour de boucle : demande du travail, le traite, et enchaîne immédiatement tant
 * que le serveur en donne. File vide → on repasse dans POLL_INTERVAL_MS.
 */
async function tick(systemKey) {
    if (running) return;
    running = true;
    try {
        let batch = await fetchPreAnalysisBatch(BATCH_SIZE, systemKey);
        while (batch && Array.isArray(batch.games) && batch.games.length > 0) {
            for (const GAME of batch.games) {
                await processGame(GAME, systemKey);
            }
            batch = await fetchPreAnalysisBatch(BATCH_SIZE, systemKey);
        }
    } catch (e) {
        if (e instanceof ApiError && e.status === 422) {
            console.error('[system-worker] clé système refusée par le serveur — worker arrêté');
            stop();
            return;
        }
        console.error('[system-worker] tour en échec', e);
    } finally {
        running = false;
    }
}

/**
 * Démarre le worker si la clé système est configurée. No-op sinon : c'est le cas
 * normal sur toutes les installations de Tools sauf la machine dédiée.
 * @param {object} d { runAnalyzer, runChunkAnalyzer } — mêmes runners que le watch folder.
 */
function start(d) {
    const KEY = (process.env.TOOLS_SYSTEM_KEY || '').trim();
    if (!KEY) return;
    if (!d || !d.runAnalyzer || !d.runChunkAnalyzer) {
        throw new Error('system-worker-service.start: missing runAnalyzer/runChunkAnalyzer deps');
    }
    deps = d;
    console.log('[system-worker] mode système actif — pré-analyse des vidéos de salle');
    tick(KEY);
    timer = setInterval(() => tick(KEY), POLL_INTERVAL_MS);
}

function stop() {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}

module.exports = { start, stop };
