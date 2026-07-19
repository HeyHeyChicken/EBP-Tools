// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const StorageManager = require('../core/storage-manager');

//#endregion

// Tools ne se connecte plus lui-même : c'est le site qui lui transmet un jeton
// court (24 h) à chaque deeplink d'analyse. On garde le dernier reçu, donc un
// changement de compte côté site est répercuté au deeplink suivant, sans action
// de l'utilisateur.
//
// Le jeton stocké ici sert de repli : chaque vidéo emporte le sien dans son
// sidecar (l'identité qui a lancé l'analyse reste attachée à la vidéo même si
// le compte change entre-temps), et ce repli ne couvre que les vidéos arrivées
// sans jeton.
const SETTINGS_KEY = 'sessionToken';

/**
 * Jeton de repli pour les appels API sans jeton explicite.
 * @returns {string|null}
 */
function getToken() {
    return StorageManager.getPermanentSettingsValue(SETTINGS_KEY, null);
}

/**
 * Enregistre le jeton transmis par un deeplink. Sans jeton dans le payload
 * (deeplinks non-analyse), l'ancien est conservé.
 * @param {{token?: string}} data
 */
function setFromDeepLink(data) {
    if (!data || typeof data !== 'object') return;
    if (typeof data.token === 'string' && data.token) {
        StorageManager.setPermanentSettingsValue(SETTINGS_KEY, data.token);
    }
}

module.exports = {
    getToken,
    setFromDeepLink
};
