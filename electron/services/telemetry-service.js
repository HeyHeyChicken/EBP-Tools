// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const crypto = require('crypto');
const os = require('os');
const StorageManager = require('../core/storage-manager');
const { sendTelemetry } = require('./tools-api-client');
const { version: TOOLS_VERSION } = require('../../package.json');

//#endregion

/**
 * Télémétrie technique minimale : quelle version tourne, et les mises à jour
 * aboutissent-elles. Sans elle, une version publiée avec un updater défaillant
 * bloquerait des postes sans que rien ne le signale — et il n'existe aucun
 * correctif à distance pour ce cas.
 *
 * Rien de personnel n'est envoyé : un identifiant d'installation tiré au sort,
 * la version, la plateforme et l'architecture. Désactivable depuis le menu du
 * tray (Settings), auquel cas plus rien ne part.
 */
const ENABLED_KEY = 'telemetryEnabled';
const INSTALL_ID_KEY = 'telemetryInstallId';

//#region Functions

/**
 * Is telemetry enabled? Activée par défaut, coupée dès que l'utilisateur a
 * explicitement décoché le réglage.
 * @returns {boolean} True if events may be sent.
 */
function isEnabled() {
    return StorageManager.getPermanentSettingsValue(ENABLED_KEY, true) !== false;
}

/**
 * Enables or disables telemetry.
 * @param {boolean} enabled Desired state.
 */
function setEnabled(enabled) {
    StorageManager.setPermanentSettingsValue(ENABLED_KEY, enabled === true);
    console.log(`[telemetry] ${enabled === true ? 'enabled' : 'disabled'}`);
}

/**
 * Identifiant d'installation, tiré au sort au premier envoi et conservé
 * ensuite. Il ne permet que de distinguer deux postes : sans lui, une même
 * version signalée mille fois serait indiscernable de mille postes.
 * @returns {string} Random installation identifier.
 */
function getInstallId() {
    let id = StorageManager.getPermanentSettingsValue(INSTALL_ID_KEY);

    if (!id) {
        id = crypto.randomUUID();
        StorageManager.setPermanentSettingsValue(INSTALL_ID_KEY, id);
    }

    return id;
}

/**
 * Sends one event. Tirer-et-oublier : ne bloque jamais l'appelant et n'échoue
 * jamais vers lui — la télémétrie ne doit pouvoir casser aucun autre flux.
 * @param {string} event Event name.
 * @param {object} [detail] Optional details (reason of a failure, versions...).
 */
function send(event, detail) {
    if (!isEnabled()) {
        return;
    }

    sendTelemetry({
        installId: getInstallId(),
        version: TOOLS_VERSION,
        platform: os.platform(),
        arch: process.arch,
        event,
        ...(detail ? { detail } : {})
    });
}

/**
 * Reports that the app has started. Ce seul événement remplace un battement
 * périodique : un poste bloqué sur une vieille version la signale à chaque
 * lancement, sans rien faire tourner en continu.
 */
function reportLaunch() {
    send('launch');
}

/**
 * Reports a step of the update flow.
 * @param {'update_available'|'update_started'|'update_failed'} event Step.
 * @param {object} [detail] Target version, failure reason...
 */
function reportUpdate(event, detail) {
    send(event, detail);
}

//#endregion

module.exports = {
    isEnabled,
    setEnabled,
    reportLaunch,
    reportUpdate
};
