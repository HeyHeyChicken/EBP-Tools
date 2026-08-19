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
 * Get the path to a component downloaded at runtime (see component-service).
 * The path is derivable before the file exists: only its presence is
 * conditional, so the call sites keep using a plain constant.
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

    return path.join(COMPONENTS_DIR, ENTRY.asset);
}

/**
 * Get the path to the Python video analyzer binary
 * @returns {string} Path to analyzer executable
 */
function getAnalyzerPath(osPlatform, isDevMode, rootPath) {
    const DIRECTORY = isDevMode ? '../binaries/analyzer' : 'analyzer';
    if (osPlatform === 'win32') {
        return path.join(rootPath, DIRECTORY, 'win32.exe');
    }
    // macOS/Linux: PyInstaller --onedir produces a directory named after the platform.
    // The executable lives inside that directory with the same name.
    return path.join(rootPath, DIRECTORY, osPlatform, osPlatform);
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
const ANALYZER_PATH = getAnalyzerPath(OS_PLATFORM, IS_DEV_MODE, ROOT_PATH);
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
        PORT = await getPort();
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
