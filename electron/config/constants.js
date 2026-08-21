// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

const os = require('os');
const path = require('node:path');
const fs = require('fs');
const { default: getPort } = require('get-port');
const { app } = require('electron');
const COMPONENTS = require('./components.json');

/**
 * Application constants and configuration values
 * @module constants
 */

//#region Functions

/**
 * Dossier d'extraction d'un composant archivé, dérivé du nom de son asset : le
 * dépôt distant et le disque local restent ainsi le miroir l'un de l'autre.
 * @param {string} asset Asset file name.
 * @returns {string} Directory name, without the archive extension.
 */
function componentDirectory(asset) {
    return asset.replace(/\.zip$/, '');
}

/**
 * Get the path to a component downloaded at runtime (see component-service).
 * The path is derivable before the file exists: only its presence is
 * conditional, so the call sites keep using a plain constant.
 *
 * Un composant dont l'entrée porte `exec` est une archive : son exécutable vit
 * à l'intérieur du dossier extrait. Sans `exec`, l'asset EST l'exécutable.
 * @param {string} name Component name, as keyed in components.json.
 * @returns {string} Path to the component's executable.
 */
function getComponentPath(name) {
    const ENTRY = COMPONENTS[name]?.[COMPONENT_PLATFORM_KEY];

    if (!ENTRY) {
        throw new Error(
            `No "${name}" component published for ${COMPONENT_PLATFORM_KEY}`
        );
    }

    if (ENTRY.exec) {
        return path.join(
            COMPONENTS_DIR,
            componentDirectory(ENTRY.asset),
            ENTRY.exec
        );
    }

    return path.join(COMPONENTS_DIR, ENTRY.asset);
}

//#endregion

const EBP_DOMAIN = 'evabattleplan.com';

const IS_DEV_MODE = process.env.NODE_ENV !== 'production';
const ROOT_PATH = IS_DEV_MODE ? path.dirname(__dirname) : process.resourcesPath;
const OS_PLATFORM = os.platform();
// Clé de plateforme des composants téléchargés : macOS publie un binaire par
// architecture, les autres plateformes un seul.
const COMPONENT_PLATFORM_KEY =
    OS_PLATFORM === 'darwin' ? `darwin-${process.arch}` : OS_PLATFORM;
const COMPONENTS_DIR = path.join(app.getPath('userData'), 'components');
const FFMPEG_PATH = getComponentPath('ffmpeg');
const ANALYZER_PATH = getComponentPath('analyzer');
const PERMANENT_SETTINGS_PATH = path.join(
    app.getPath('userData'),
    'settings.json'
);
const TEMPORARY_SETTINGS_PATH = path.join(ROOT_PATH, 'temporary_settings.json');
const BROWSER_PATH = path.join(ROOT_PATH, 'browser');
const PROTOCOL_NAME = 'tools';

//#region Window Constants

const WINDOW_WIDTH = 900;
const WINDOW_HEIGHT = 800;
const WINDOW_DEV_PANEL_WIDTH = 540;

//#endregion

//#region Video Processing Constants

const DEFAULT_VIDEO_WIDTH = 1920;
const DEFAULT_VIDEO_HEIGHT = 1080;

//#endregion

//#region Port Management

let PORT = null;

/**
 * Initialize and return an available port
 * @returns {Promise<number>} Available port number
 */
async function initializePort() {
    if (PORT === null) {
        // `host` confine la SONDE de disponibilité à la boucle locale. Sans lui,
        // get-port ouvre un socket d'écoute sur « toutes interfaces » puis sur
        // chaque adresse réseau de la machine pour tester le port — ce qui
        // déclenche l'alerte du pare-feu Windows au premier lancement, alors
        // même que le serveur Express qui suivra est déjà lié à 127.0.0.1.
        //
        // L'IHM n'a aucune raison d'être joignable depuis le réseau : elle est
        // servie à l'application elle-même, sur cette machine, et rien d'autre.
        PORT = await getPort({ host: '127.0.0.1' });
    }
    return PORT;
}

/**
 * Get the current port (may be null if not initialized)
 * @returns {number|null} Current port number or null
 */
function getCurrentPort() {
    return PORT;
}

//#endregion

//#region Export

module.exports = {
    EBP_DOMAIN,

    IS_DEV_MODE,
    ROOT_PATH,

    FFMPEG_PATH,
    ANALYZER_PATH,

    COMPONENTS,
    COMPONENTS_DIR,
    COMPONENT_PLATFORM_KEY,
    getComponentPath,
    componentDirectory,

    PERMANENT_SETTINGS_PATH,
    TEMPORARY_SETTINGS_PATH,
    BROWSER_PATH,
    PROTOCOL_NAME,

    initializePort,
    getCurrentPort,

    WINDOW_WIDTH,
    WINDOW_HEIGHT,
    WINDOW_DEV_PANEL_WIDTH,

    DEFAULT_VIDEO_WIDTH,
    DEFAULT_VIDEO_HEIGHT
};

//#endregion
