// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

const os = require('os');
const path = require('node:path');
const fs = require('fs');
const { execSync } = require('child_process');
const { default: getPort } = require('get-port');
const { app } = require('electron');

/**
 * Application constants and configuration values
 * @module constants
 */

//#region Functions

/**
 * Get the path to the FFmpeg binary based on the current platform and environment
 * @returns {string} Path to FFmpeg executable
 */
function getFFmpegPath(osPlatform, isDevMode, rootPath) {
    if (osPlatform === 'linux') {
        try {
            return execSync('which ffmpeg').toString().trim();
        } catch (error) {
            console.error('FFmpeg not found in PATH on Linux');
            throw new Error('FFmpeg binary not found');
        }
    }

    const DIRECTORY = isDevMode ? '../binaries/ffmpeg' : 'ffmpeg';

    return path.join(
        rootPath,
        DIRECTORY,
        osPlatform === 'win32' ? 'win32.exe' : osPlatform
    );
}

/**
 * Get the path to the Python video analyzer binary
 * @returns {string} Path to analyzer executable
 */
function getAnalyzerPath(osPlatform, isDevMode, rootPath) {
    const DIRECTORY = isDevMode ? '../binaries/analyzer' : 'analyzer';
    return path.join(
        rootPath,
        DIRECTORY,
        osPlatform === 'win32' ? 'win32.exe' : osPlatform
    );
}

//#endregion

const EBP_DOMAIN = 'evabattleplan.com';

const IS_DEV_MODE = process.env.NODE_ENV !== 'production';
const ROOT_PATH = IS_DEV_MODE ? path.dirname(__dirname) : process.resourcesPath;
const OS_PLATFORM = os.platform();
const FFMPEG_PATH = getFFmpegPath(OS_PLATFORM, IS_DEV_MODE, ROOT_PATH);
const ANALYZER_PATH = getAnalyzerPath(OS_PLATFORM, IS_DEV_MODE, ROOT_PATH);
const PERMANENT_SETTINGS_PATH = path.join(
    app.getPath('userData'),
    'settings.json'
);
const TEMPORARY_SETTINGS_PATH = path.join(ROOT_PATH, 'temporary_settings.json');
const BROWSER_PATH = path.join(ROOT_PATH, 'browser');
const PUPPETEER_USER_DATA_PATH = path.join(
    app.getPath('userData'),
    'puppeteer-data'
);
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

    PERMANENT_SETTINGS_PATH,
    TEMPORARY_SETTINGS_PATH,
    BROWSER_PATH,
    PUPPETEER_USER_DATA_PATH,
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
