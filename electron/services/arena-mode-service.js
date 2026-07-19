// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const StorageManager = require('../core/storage-manager');
const { registerArena, sendArenaHeartbeat } = require('./tools-api-client');
const { version: TOOLS_VERSION } = require('../../package.json');

//#endregion

// Mode salle : cette machine est le PC de streaming d'une arène EVA. L'état
// vit dans les settings permanents — attention, `logout()` (auth-service)
// vide TOUS les settings permanents, donc un logout user désenregistre aussi
// l'arène (à re-saisir). Contrat backend : wiki/arena_mode_api.md.
const SETTINGS_KEY = 'arenaMode';
// Battement de présence vers le backend (la page admin du site affiche
// l'arène "en ligne" si le dernier battement a moins de 15 min).
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
// Cooldown entre deux tentatives de mise à jour ordonnées par le serveur :
// le flag reste posé côté back tant que la version n'a pas changé, sans ce
// garde on relancerait un installeur défaillant à chaque battement.
const UPDATE_ATTEMPT_COOLDOWN_MS = 45 * 60 * 1000;

let heartbeatTimer = null;
let lastUpdateAttemptAt = 0;
// Callback d'exécution d'une mise à jour ordonnée par l'admin (posé par
// server.js : stop captation propre puis UpdateService.forceUpdate()).
let updateHandler = null;

function setUpdateHandler(handler) {
    updateHandler = handler;
}

/**
 * Envoie un battement si le mode salle est actif. Fire-and-forget : un échec
 * ponctuel (réseau, backend down) est loggé et rattrapé au battement suivant.
 * Monte la version de Tools (debug à distance) ; si la réponse porte un ordre
 * de mise à jour, il est exécuté IMMÉDIATEMENT (décision Antoine : l'admin
 * coordonne avec la salle par téléphone, pas de garde-fou côté Tools).
 */
function sendHeartbeat() {
    const STATE = StorageManager.getPermanentSettingsValue(SETTINGS_KEY);
    if (!STATE || !STATE.token) return;
    sendArenaHeartbeat(
        {
            roomId: STATE.roomId,
            arenaId: STATE.arenaId,
            version: TOOLS_VERSION
        },
        STATE.token
    )
        .then((res) => {
            if (!res || !res.update || !updateHandler) return;
            if (Date.now() - lastUpdateAttemptAt < UPDATE_ATTEMPT_COOLDOWN_MS) {
                return;
            }
            lastUpdateAttemptAt = Date.now();
            console.log('[arena-mode] update ordered by server — updating now');
            updateHandler();
        })
        .catch((e) =>
            console.warn('[arena-mode] heartbeat failed:', e.message)
        );
}

/**
 * Démarre le battement périodique (immédiat + toutes les 5 min). No-op si le
 * mode salle n'est pas actif. À appeler au boot de l'app et après un register
 * réussi. Idempotent.
 */
function startHeartbeat() {
    stopHeartbeat();
    const STATE = StorageManager.getPermanentSettingsValue(SETTINGS_KEY);
    if (!STATE || !STATE.token) return;
    sendHeartbeat();
    heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}

/**
 * @returns {{registered: boolean, roomId?: number, arenaId?: number, roomName?: string, terrainId?: string, terrainName?: string}}
 *   La clé (token) n'est jamais exposée au renderer — elle reste côté main process.
 */
function getState() {
    const STATE = StorageManager.getPermanentSettingsValue(SETTINGS_KEY);
    if (!STATE || !STATE.token) return { registered: false };
    return {
        registered: true,
        roomId: STATE.roomId,
        arenaId: STATE.arenaId,
        roomName: STATE.roomName,
        terrainId: STATE.terrainId,
        terrainName: STATE.terrainName
    };
}

/**
 * Token d'arène pour les futurs endpoints salle (header `X-Arena-Token`).
 * @returns {string|null}
 */
function getArenaToken() {
    const STATE = StorageManager.getPermanentSettingsValue(SETTINGS_KEY);
    return STATE && STATE.token ? STATE.token : null;
}

/**
 * Valide la clé de salle auprès du backend et la persiste : c'est elle qui
 * servira de credential (header `X-Arena-Token`) sur les endpoints salle.
 * @param {{roomId:number, arenaId:number, key:string}} payload
 * @returns {Promise<{registered: true, roomId: number, arenaId: number, roomName: string}>}
 * @throws NotAuthenticatedError / ApiError (404 salle/arène inconnue, 422 clé
 *   refusée — clé invalide, mode désactivé ou mauvaise IP) — remontées telles
 *   quelles au caller (server.js) qui les transforme en erreur i18n.
 */
async function register({ roomId, arenaId, key }) {
    const RES = await registerArena({ roomId, arenaId, key });
    StorageManager.setPermanentSettingsValue(SETTINGS_KEY, {
        roomId,
        arenaId,
        roomName: RES.roomName,
        terrainId: RES.terrainId,
        terrainName: RES.terrainName,
        token: key,
        registeredAt: Date.now()
    });
    startHeartbeat();
    return getState();
}

/**
 * Désenregistre localement (le token reste révocable côté serveur).
 */
function unregister() {
    stopHeartbeat();
    const SETTINGS = StorageManager.permanentSettings;
    delete SETTINGS[SETTINGS_KEY];
    StorageManager.permanentSettings = SETTINGS;
    return getState();
}

module.exports = {
    getState,
    getArenaToken,
    register,
    unregister,
    startHeartbeat,
    setUpdateHandler
};
