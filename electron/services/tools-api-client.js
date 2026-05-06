// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const https = require('https');
const fs = require('fs');
const { URL } = require('url');
const { EBP_DOMAIN } = require('../config/constants');
// `getMainWindow` est lazy-loaded dans `getAuthCookie` pour casser le cycle
// d'imports window-manager → watch-folder-service → tools-api-client → window-manager.

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
 * Reads the Express `auth` cookie from the main window's session. This cookie
 * is set by EBP-Site after Discord/TV-code login and is the only token format
 * the back's `auth.middleware.ts` accepts.
 * @returns {Promise<string|null>} cookie value, or null if absent / window destroyed.
 */
async function getAuthCookie() {
    const { getMainWindow } = require('../core/window-manager');
    const WINDOW = getMainWindow();
    if (!WINDOW || WINDOW.isDestroyed()) return null;
    const COOKIES = await WINDOW.webContents.session.cookies.get({
        url: `https://${EBP_DOMAIN}`,
        name: 'auth'
    });
    return COOKIES.length > 0 ? COOKIES[0].value : null;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Performs an HTTPS request and resolves with `{ status, body }`.
 */
function httpsRequest(options, bodyBuffer = null) {
    return new Promise((resolve, reject) => {
        const REQ = https.request(options, (res) => {
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
 */
async function apiRequest(
    method,
    apiPath,
    body,
    { retries = DEFAULT_RETRIES, baseDelayMs = DEFAULT_BASE_DELAY_MS } = {}
) {
    const COOKIE = await getAuthCookie();
    if (!COOKIE) throw new NotAuthenticatedError();

    const PAYLOAD = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const OPTIONS = {
        hostname: EBP_DOMAIN,
        port: 443,
        path: API_BASE_PATH + apiPath,
        method,
        headers: {
            Cookie: `auth=${COOKIE}`,
            Accept: 'application/json'
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
 * @param {object} payload { sourceFilename?, segments: [{ tempId, startSeconds, endSeconds, mode, mapName, blueScore, orangeScore, ... }] }
 * @returns {Promise<{ matches: Array<{tempId, gameID, hasVideo, orangePlayers: Array<{name, K, D}>, bluePlayers: Array<{name, K, D}>}>, unmatched: Array<string> }>}
 *   `hasVideo` indique qu'une vidéo est déjà attachée à la game côté serveur :
 *   le client doit alors skip découpage / réencodage / upload pour ce segment.
 */
function identifyGames(payload) {
    return apiRequest('POST', '/games/identify', payload);
}

/**
 * POST /api/tools/games/persist-analysis
 * Seconde étape : persiste les analyses approfondies de phase 2 pour les games
 * matchées via `/identify`. Le client envoie directement les `gameID` (pas de
 * re-matching côté back). Ownership re-vérifiée par game.
 *
 * @param {object} payload { analyses: [{ gameID, payload }] }
 * @returns {Promise<{ persisted: Array<string>, failed: Array<{gameID, reason}> }>}
 */
function persistAnalysis(payload) {
    return apiRequest('POST', '/games/persist-analysis', payload);
}

/**
 * POST /api/tools/games/:gameID/upload-url
 * @returns {Promise<{ url, key, expiresAt }>}
 */
function requestUploadUrl(gameID) {
    return apiRequest('POST', `/games/${encodeURIComponent(gameID)}/upload-url`, {});
}

/**
 * POST /api/tools/games/:gameID/confirm-upload
 */
function confirmUpload(gameID, payload) {
    return apiRequest(
        'POST',
        `/games/${encodeURIComponent(gameID)}/confirm-upload`,
        payload
    );
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
        contentType = 'video/mp4'
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
    persistAnalysis,
    requestUploadUrl,
    confirmUpload,
    uploadFileToPresignedUrl,
    getAuthCookie,
    NotAuthenticatedError,
    ApiError
};
