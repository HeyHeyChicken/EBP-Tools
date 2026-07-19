// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const http = require('http');
const https = require('https');
const fs = require('fs');
const { URL } = require('url');
const { EBP_DOMAIN } = require('../config/constants');
const sessionService = require('./session-service');

// Cible REST : en dev on tape le serveur EBP local (http://localhost:3005),
// comme le socket — sinon prod en HTTPS. Indispensable pour tester le live :
// c'est l'appel REST `analysis-status` qui déclenche le broadcast socket, donc
// il doit viser le même serveur que celui auquel le front est connecté.
// Le jeton vient du deeplink émis par le site de prod — le serveur dev doit
// partager le secret JWT pour le valider, et sa base contenir les games
// (pour /identify).
const IS_DEV_MODE = process.env.NODE_ENV !== 'production';
const API_HTTP = IS_DEV_MODE ? http : https;
const API_HOST = IS_DEV_MODE ? 'localhost' : EBP_DOMAIN;
const API_PORT = IS_DEV_MODE ? 3005 : 443;

//#endregion

const API_BASE_PATH = '/api/tools';
const DEFAULT_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1000;

class NotAuthenticatedError extends Error {
    constructor(detail = '') {
        super(detail ? `NotAuthenticated: ${detail}` : 'NotAuthenticated');
        this.name = 'NotAuthenticatedError';
        this.detail = detail;
    }
}

class ApiError extends Error {
    constructor(status, body, headers = {}) {
        const LOC = headers && headers.location ? ` (location=${headers.location})` : '';
        super(`API error ${status}${LOC}: ${body}`);
        this.name = 'ApiError';
        this.status = status;
        this.body = body;
        this.headers = headers;
    }
}

/**
 * Jeton signant les appels user. Tools ne se connecte plus : le jeton vient du
 * deeplink du site, soit attaché à la vidéo traitée (`explicitToken`), soit à
 * défaut le dernier reçu. Le back accepte ce format via `Authorization: Bearer`
 * (cf. `auth.middleware.ts`).
 * @param {string|undefined} explicitToken jeton de la vidéo en cours.
 * @returns {string|null}
 */
function resolveAuthToken(explicitToken) {
    return explicitToken || sessionService.getToken();
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Performs an HTTPS request and resolves with `{ status, body }`.
 */
function httpsRequest(options, bodyBuffer = null) {
    return new Promise((resolve, reject) => {
        const REQ = API_HTTP.request(options, (res) => {
            const CHUNKS = [];
            res.on('data', (c) => CHUNKS.push(c));
            res.on('end', () => {
                resolve({
                    status: res.statusCode,
                    body: Buffer.concat(CHUNKS).toString('utf8'),
                    headers: res.headers
                });
            });
        });
        REQ.on('error', reject);
        if (bodyBuffer) REQ.write(bodyBuffer);
        REQ.end();
    });
}

/**
 * JSON API call with Bearer auth and retry on network/5xx errors.
 * Throws NotAuthenticatedError immediately if no valid access token.
 * Throws ApiError on non-retryable HTTP errors (4xx other than 408/429).
 * `requireAuth: false` → pas de jeton exigé (endpoints du mode salle, dont le
 * credential est la clé de salle). `authToken` → jeton de la vidéo en cours,
 * sinon repli sur le dernier jeton reçu du site. `headers` → headers
 * additionnels (ex. X-Arena-Token).
 */
async function apiRequest(
    method,
    apiPath,
    body,
    {
        retries = DEFAULT_RETRIES,
        baseDelayMs = DEFAULT_BASE_DELAY_MS,
        headers = {},
        requireAuth = true,
        authToken = undefined
    } = {}
) {
    const TOKEN = requireAuth ? resolveAuthToken(authToken) : null;
    if (requireAuth && !TOKEN) throw new NotAuthenticatedError();

    const PAYLOAD = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const OPTIONS = {
        hostname: API_HOST,
        port: API_PORT,
        path: API_BASE_PATH + apiPath,
        method,
        headers: {
            ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
            Accept: 'application/json',
            ...headers
        }
    };
    if (PAYLOAD) {
        OPTIONS.headers['Content-Type'] = 'application/json';
        OPTIONS.headers['Content-Length'] = PAYLOAD.length;
    }

    let lastError = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const RES = await httpsRequest(OPTIONS, PAYLOAD);
            if (RES.status === 401 || RES.status === 403) {
                throw new NotAuthenticatedError(
                    `${method} ${apiPath} → ${RES.status} ${RES.body || ''}`
                );
            }
            if (RES.status >= 200 && RES.status < 300) {
                try {
                    return RES.body ? JSON.parse(RES.body) : null;
                } catch (e) {
                    throw new ApiError(RES.status, RES.body, RES.headers);
                }
            }
            const RETRYABLE =
                RES.status === 408 ||
                RES.status === 429 ||
                RES.status >= 500;
            if (!RETRYABLE) {
                throw new ApiError(RES.status, RES.body, RES.headers);
            }
            lastError = new ApiError(RES.status, RES.body, RES.headers);
        } catch (err) {
            if (
                err instanceof NotAuthenticatedError ||
                err instanceof ApiError
            ) {
                if (err instanceof ApiError) {
                    const RETRYABLE =
                        err.status === 408 ||
                        err.status === 429 ||
                        err.status >= 500;
                    if (!RETRYABLE) throw err;
                    lastError = err;
                } else {
                    throw err;
                }
            } else {
                lastError = err;
            }
        }

        if (attempt < retries) {
            await sleep(baseDelayMs * Math.pow(2, attempt - 1));
        }
    }
    throw lastError;
}

/**
 * POST /api/tools/games/identify
 * Première étape : matche les segments aux games BDD (LCS sur mapID + scores
 * ±1, sessions 4h) et retourne les rosters avec K/D pour pouvoir nourrir la
 * phase 2 d'analyse approfondie avec des pseudos full-confiance.
 *
 * @param {object} payload { sourceFilename?, teamId, segments: [{ tempId, startSeconds, endSeconds, mode, mapName, blueScore, orangeScore, ... }] }
 * @returns {Promise<{ matches: Array<{tempId, gameID, hasVideo, orangePlayers: Array<{name, K, D}>, bluePlayers: Array<{name, K, D}>}>, unmatched: Array<string> }>}
 *   `hasVideo` indique qu'une vidéo est déjà attachée à la game côté serveur :
 *   le client doit alors skip découpage / réencodage / upload pour ce segment.
 */
function identifyGames(payload, authToken) {
    return apiRequest('POST', '/games/identify', payload, { authToken });
}

/**
 * POST /api/tools/games/persist-analysis
 * Seconde étape : persiste les analyses approfondies de phase 2 pour les games
 * matchées via `/identify`. Le client envoie directement les `gameID` (pas de
 * re-matching côté back). Ownership re-vérifiée par game.
 *
 * @param {object} payload { analyses: [{ gameID, payload }], teamId }
 *   `teamId` = équipe-auteur des analyses (issue du deeplink du site) — OBLIGATOIRE,
 *   le serveur refuse (403) sans lui.
 * @returns {Promise<{ persisted: Array<string>, failed: Array<{gameID, reason}> }>}
 */
function persistAnalysis(payload, authToken) {
    return apiRequest('POST', '/games/persist-analysis', payload, { authToken });
}

/**
 * POST /api/tools/games/:gameID/upload-url
 * @param {string|number} gameID
 * @param {string|undefined} teamId  équipe-auteur de la vidéo (issue du deeplink du
 *   site) — OBLIGATOIRE, le serveur refuse (403) sans lui.
 * @returns {Promise<{ url, key, expiresAt }>}
 */
function requestUploadUrl(gameID, teamId, authToken) {
    return apiRequest(
        'POST',
        `/games/${encodeURIComponent(gameID)}/upload-url`,
        { teamId },
        { authToken }
    );
}

/**
 * POST /api/tools/games/:gameID/confirm-upload
 * @param {object} payload { guid, teamId } — même `teamId` que l'upload-url, pour
 *   que la vidéo atterrisse sur la même ligne d'analyse (game_id, author_team_id).
 */
function confirmUpload(gameID, payload, authToken) {
    return apiRequest(
        'POST',
        `/games/${encodeURIComponent(gameID)}/confirm-upload`,
        payload,
        { authToken }
    );
}

/**
 * POST /api/tools/arena/register
 * Mode salle : enregistre cette machine comme PC de streaming d'une arène.
 * Pas d'auth user (Tools n'ouvre plus de session) : le credential est la clé de
 * salle (T_EVA_Locations.tools_token, révocable en base, IP optionnellement
 * restreinte), validée côté serveur.
 * La clé elle-même sert de credential pour les futurs endpoints salle (header
 * `X-Arena-Token`). `arenaId` = ordinal de l'arène dans la salle (1 ou 2) ;
 * le serveur renvoie l'id du terrain réel pour le futur matching des games.
 * Erreurs : 404 salle/arène inconnue, 422 clé refusée (clé invalide, mode
 * désactivé ou mauvaise IP). Contrat : wiki/arena_mode_api.md.
 *
 * @param {{roomId:number, arenaId:number, key:string}} payload
 * @returns {Promise<{ roomName: string, terrainId: string, terrainName: string }>}
 */
function registerArena(payload) {
    return apiRequest('POST', '/arena/register', payload, {
        requireAuth: false
    });
}

/**
 * GET /api/tools/arena/locations
 * Salles activables (clé posée par un admin) avec leurs arènes — alimente les
 * listes déroulantes du formulaire mode salle. Pas d'auth user (comme le
 * register).
 * @returns {Promise<{id:string, name:string, country:string, terrains:{id:string, name:string}[]}[]>}
 */
function getArenaLocations() {
    return apiRequest('GET', '/arena/locations', null, { requireAuth: false });
}

/**
 * POST /api/tools/arena/heartbeat
 * Battement de présence du mode salle (toutes les 5 min) : la page admin du
 * site affiche l'arène "en ligne" tant que le dernier battement a moins de
 * 15 min. Authentifié par la clé de salle seule (header X-Arena-Token, pas de
 * cookie : doit fonctionner même session user expirée). Pas de retry — le
 * battement suivant rattrape un échec ponctuel.
 *
 * @param {{roomId:number, arenaId:number}} payload
 * @param {string} arenaToken  clé de salle stockée par arena-mode-service.
 */
function sendArenaHeartbeat(payload, arenaToken) {
    return apiRequest('POST', '/arena/heartbeat', payload, {
        retries: 1,
        requireAuth: false,
        headers: { 'X-Arena-Token': arenaToken }
    });
}

/**
 * POST /api/tools/arena/games/upload-url
 * URL présignée PUT vers `arena/pending/{roomId}/{arenaId}/{fileName}` pour
 * une game du pipeline salle. Auth par clé de salle seule (X-Arena-Token).
 * Pas de retry interne : l'uploader gère sa propre boucle persistante en
 * re-demandant une URL fraîche à chaque tentative.
 *
 * @param {{roomId:number, arenaId:number, fileName:string}} payload
 * @param {string} arenaToken
 * @returns {Promise<{url:string, key:string, expiresAt:number}>}
 */
function requestArenaUploadUrl(payload, arenaToken) {
    return apiRequest('POST', '/arena/games/upload-url', payload, {
        retries: 1,
        requireAuth: false,
        headers: { 'X-Arena-Token': arenaToken }
    });
}

/**
 * POST /api/tools/arena/games
 * Dépose le payload d'analyse d'une game pré-enregistrée (APRÈS l'upload de
 * la vidéo — le serveur vérifie sa présence en S3, 412 sinon). Upsert par
 * fileName : idempotent, un retry après crash est sans danger.
 *
 * @param {{roomId:number, arenaId:number, fileName:string, payload:object|null, noRosters:boolean}} payload
 * @param {string} arenaToken
 */
function depositArenaGame(payload, arenaToken) {
    return apiRequest('POST', '/arena/games', payload, {
        retries: 1,
        requireAuth: false,
        headers: { 'X-Arena-Token': arenaToken }
    });
}

/**
 * POST /api/tools/watcher/status
 * Push de l'état complet du watcher (queued/processing/failed). Le serveur
 * stamp `updatedAt` lui-même et broadcast aux sockets du user.
 *
 * Tolérant aux échecs : appelé à chaque transition du worker, on ne veut
 * surtout pas faire planter la pipeline si le back est momentanément down
 * ou si le user n'est pas (encore) authentifié.
 *
 * @param {{queued:Array<{name,path}>, processing:Array<{name,path}>, failed:Array<{name,path}>}} status
 */
async function pushWatcherStatus(status, authToken) {
    try {
        await apiRequest('POST', '/watcher/status', status, {
            retries: 1,
            authToken
        });
    } catch (e) {
        if (e instanceof NotAuthenticatedError) return;
        console.warn('[tools-api] pushWatcherStatus failed:', e.message);
    }
}

/**
 * POST /api/tools/games/:gameID/analysis-status
 * Push de l'état de progression d'UNE game (phase + percent sur l'échelle
 * unifiée 0-100). Le serveur persiste l'état et le broadcast aux sockets du
 * user (affichage live sur la ligne de la game côté site).
 *
 * Tolérant aux échecs comme `pushWatcherStatus` : appelé en continu pendant
 * la pipeline, il ne doit jamais la faire planter (back down / non authentifié).
 *
 * @param {string|number} gameID  vrai ID DB de la game (games matchées).
 * @param {{phase:'queued'|'analyzing'|'processing'|'done'|'failed', percent:number, teamId?:string}} status
 *   `teamId` = équipe de destination choisie dans Tools (informatif côté back).
 */
async function pushGameAnalysisStatus(gameID, status, authToken) {
    try {
        await apiRequest(
            'POST',
            `/games/${encodeURIComponent(gameID)}/analysis-status`,
            status,
            { retries: 1, authToken }
        );
    } catch (e) {
        if (e instanceof NotAuthenticatedError) return;
        console.warn('[tools-api] pushGameAnalysisStatus failed:', e.message);
    }
}

/**
 * POST /api/tools/games/analysis-issue
 * Remonte un problème d'analyse AU NIVEAU FICHIER (sans game), ex. "aucune game
 * détectée" — cas où /identify n'est jamais appelé. Tolérant aux échecs (comme
 * pushGameAnalysisStatus) pour ne pas perturber le worker.
 *
 * @param {{sourceFilename:string, teamId:string, reason:'no_games'}} payload
 */
async function reportAnalysisIssue(payload, authToken) {
    try {
        await apiRequest('POST', '/games/analysis-issue', payload, {
            retries: 1,
            authToken
        });
    } catch (e) {
        if (e instanceof NotAuthenticatedError) return;
        console.warn('[tools-api] reportAnalysisIssue failed:', e.message);
    }
}

/**
 * Uploads a local file via HTTP PUT to a presigned URL with retry on
 * network/5xx errors. Resolves on 2xx, throws otherwise.
 */
async function uploadFileToPresignedUrl(
    presignedUrl,
    filePath,
    {
        retries = DEFAULT_RETRIES,
        baseDelayMs = DEFAULT_BASE_DELAY_MS,
        contentType = 'video/mp4',
        onProgress /* (percent: 0-100) => void, optionnel */
    } = {}
) {
    const URL_OBJ = new URL(presignedUrl);
    const SIZE = fs.statSync(filePath).size;

    let lastError = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const STATUS = await new Promise((resolve, reject) => {
                const REQ = https.request(
                    {
                        hostname: URL_OBJ.hostname,
                        port: URL_OBJ.port || 443,
                        path: URL_OBJ.pathname + URL_OBJ.search,
                        method: 'PUT',
                        headers: {
                            'Content-Type': contentType,
                            'Content-Length': SIZE
                        }
                    },
                    (res) => {
                        const CHUNKS = [];
                        res.on('data', (c) => CHUNKS.push(c));
                        res.on('end', () => {
                            const BODY =
                                Buffer.concat(CHUNKS).toString('utf8');
                            if (
                                res.statusCode >= 200 &&
                                res.statusCode < 300
                            ) {
                                resolve(res.statusCode);
                            } else {
                                reject(new ApiError(res.statusCode, BODY));
                            }
                        });
                    }
                );
                REQ.on('error', reject);
                const STREAM = fs.createReadStream(filePath);
                STREAM.on('error', reject);
                // Compte les octets envoyés (le stream est paced par la
                // backpressure de la requête PUT, donc ~= débit réseau réel).
                if (onProgress && SIZE > 0) {
                    let uploaded = 0;
                    STREAM.on('data', (c) => {
                        uploaded += c.length;
                        onProgress(
                            Math.min(100, Math.ceil((uploaded / SIZE) * 100))
                        );
                    });
                }
                STREAM.pipe(REQ);
            });
            return STATUS;
        } catch (err) {
            const RETRYABLE =
                !(err instanceof ApiError) ||
                err.status === 408 ||
                err.status === 429 ||
                err.status >= 500;
            if (!RETRYABLE) throw err;
            lastError = err;
            if (attempt < retries) {
                await sleep(baseDelayMs * Math.pow(2, attempt - 1));
            }
        }
    }
    throw lastError;
}

module.exports = {
    identifyGames,
    registerArena,
    getArenaLocations,
    sendArenaHeartbeat,
    requestArenaUploadUrl,
    depositArenaGame,
    persistAnalysis,
    requestUploadUrl,
    confirmUpload,
    uploadFileToPresignedUrl,
    pushWatcherStatus,
    pushGameAnalysisStatus,
    reportAnalysisIssue,
    resolveAuthToken,
    NotAuthenticatedError,
    ApiError
};
