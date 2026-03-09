// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const {
    BrowserWindow,
    screen,
    app,
    Tray,
    Menu,
    nativeImage
} = require('electron');
const path = require('node:path');
const { setupConsoleRedirection } = require('./console-manager');
const {
    IS_DEV_MODE,
    ROOT_PATH,
    EBP_DOMAIN,
    WINDOW_WIDTH,
    WINDOW_DEV_PANEL_WIDTH,
    WINDOW_HEIGHT,
    getCurrentPort,
    PROTOCOL_NAME
} = require('../config/constants');
const { checkJwtToken } = require('../services/auth-service');
const StorageManager = require('./storage-manager');

//#endregion

/**
 * Window Manager - Handles all window creation and management.
 * This module manages the creation and configuration of both main and floating windows, including debug mode toggling, window sizing, and tray functionality.
 */

let mainWindow = null;
let floatingWindow = null;
let debugMode = false;

/**
 * Centers the main window on the primary display.
 */
function centerMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    const PRIMARY_DISPLAY = screen.getPrimaryDisplay();
    const [windowWidth, windowHeight] = mainWindow.getSize();

    const X =
        Math.floor((PRIMARY_DISPLAY.workAreaSize.width - windowWidth) / 2) +
        PRIMARY_DISPLAY.workArea.x;
    const Y =
        Math.floor((PRIMARY_DISPLAY.workAreaSize.height - windowHeight) / 2) +
        PRIMARY_DISPLAY.workArea.y;

    mainWindow.setPosition(X, Y);
}

/**
 * Sets the main window size based on provided dimensions or defaults.
 * @param {number|undefined} width Target width.
 * @param {number|undefined} height Target height.
 */
function setWindowSize(width, height) {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    const PRIMARY_DISPLAY = screen.getPrimaryDisplay();
    let targetWidth = 0;
    let targetHeight = 0;

    // Reset to default size
    if (width === undefined || height === undefined) {
        targetWidth = Math.min(
            PRIMARY_DISPLAY.workAreaSize.width,
            WINDOW_WIDTH + (debugMode ? 0 : WINDOW_DEV_PANEL_WIDTH)
        );
        targetHeight = Math.min(
            PRIMARY_DISPLAY.workAreaSize.height,
            WINDOW_HEIGHT
        );
    }
    // Full screen
    else if (width == 0 && height == 0) {
        targetWidth = PRIMARY_DISPLAY.workAreaSize.width;
        targetHeight = PRIMARY_DISPLAY.workAreaSize.height;
    } else {
        targetWidth = width;
        targetHeight = height;
    }

    mainWindow.setResizable(true);
    mainWindow.setSize(targetWidth, targetHeight);
    mainWindow.setResizable(false);

    // Center the window after resizing
    centerMainWindow();
}

/**
 * Creates and configures a floating notification window.
 * @param {number} width Window width.
 * @param {number} height Window height.
 * @param {string} data Data to pass to the notification.
 */
function createFloatingWindow(width, height, data) {
    return new Promise((resolve) => {
        const PRIMARY_DISPLAY = screen.getPrimaryDisplay();
        const WIDTH = Math.min(PRIMARY_DISPLAY.workAreaSize.width, width);
        const HEIGHT = Math.min(PRIMARY_DISPLAY.workAreaSize.height, height);

        if (!floatingWindow) {
            floatingWindow = new BrowserWindow({
                width: WIDTH,
                height: HEIGHT,
                contextIsolation: true,
                resizable: false,
                webPreferences: {
                    preload:
                        process.env.NODE_ENV === 'production'
                            ? MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY
                            : path.join(__dirname, '..', 'preload.js')
                },
                frame: false,
                transparent: true,
                alwaysOnTop: true
            });

            // Position at the bottom right.
            floatingWindow.setBounds({
                x: PRIMARY_DISPLAY.workAreaSize.width - width,
                y: PRIMARY_DISPLAY.workAreaSize.height - height
            });
        }

        floatingWindow.setBounds({
            width: WIDTH,
            height: HEIGHT
        });

        floatingWindow.webContents.once('did-finish-load', () => {
            setTimeout(() => {
                resolve();
            }, 100);
        });

        const URL = `http://localhost:${IS_DEV_MODE ? '4201' : getCurrentPort()}/${StorageManager.permanentSettings['language'] ?? 'aa'}/notification?data=${encodeURIComponent(data)}`;

        floatingWindow.loadURL(URL);
    });
}

function deleteFloatingWindow(haveToShowMainWindow) {
    if (floatingWindow) {
        floatingWindow.close();
        floatingWindow = undefined;
    }
    if (haveToShowMainWindow) {
        showMainWindow();
    }
}

/**
 * Creates and configures the main application window.
 */
function createWindow(updateService) {
    console.log('createWindow');
    const PRIMARY_DISPLAY = screen.getPrimaryDisplay();
    const APP_ARGS = process.argv;

    // Check if launched via deep link (Windows)
    const HAS_DEEP_LINK = APP_ARGS.some((arg) =>
        arg.startsWith(`${PROTOCOL_NAME}://`)
    );
    const IS_STARTUP_MODE = APP_ARGS.includes('--mode=startup');

    let isJustUpdated = false;
    const JUST_UPDATED =
        StorageManager.getPermanentSettingsValue('justUpdated');
    if (JUST_UPDATED !== undefined) {
        isJustUpdated = true;
        StorageManager.setPermanentSettingsValue('justUpdated', undefined);
    }

    //StorageManager.getPermanentSettingsValue('justUpdated');

    mainWindow = new BrowserWindow({
        width: Math.min(PRIMARY_DISPLAY.workAreaSize.width, WINDOW_WIDTH),
        height: Math.min(PRIMARY_DISPLAY.workAreaSize.height, WINDOW_HEIGHT),
        show: !IS_STARTUP_MODE && !HAS_DEEP_LINK && !isJustUpdated,
        skipTaskbar: IS_STARTUP_MODE || HAS_DEEP_LINK,
        resizable: false,
        contextIsolation: true,
        webPreferences: {
            preload: IS_DEV_MODE
                ? path.join(__dirname, '..', 'preload.js')
                : MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY
        }
    });

    let language = StorageManager.permanentSettings['language'];
    if (!language) {
        language = app.getLocale();
    }

    const ROOT_URL = `http://localhost:${IS_DEV_MODE ? '4201' : getCurrentPort()}/`;
    const HOME_URL = `${ROOT_URL}${language}/`;

    // When the user clicks on the close cross, we hide the application.
    mainWindow.on('close', (event) => {
        event.preventDefault();
        hideMainWindow();
    });

    const TRAY = new Tray(path.join(ROOT_PATH, 'assets', 'favicon.png'));
    const CONTEXT_MENU = Menu.buildFromTemplate([
        {
            label: 'Open',
            icon: nativeImage
                .createFromPath(
                    path.join(ROOT_PATH, 'assets', 'context-menu', 'circle.png')
                )
                .resize({ width: 12, height: 12 }),
            click: () => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.show();
                    mainWindow.focus();
                }
            }
        },
        {
            label: 'Restart',
            icon: nativeImage
                .createFromPath(
                    path.join(
                        ROOT_PATH,
                        'assets',
                        'context-menu',
                        'arrow-circle-left.png'
                    )
                )
                .resize({ width: 12, height: 12 }),
            submenu: [
                {
                    label: 'Confirm restart',
                    click: () => {
                        app.relaunch();
                        if (mainWindow && !mainWindow.isDestroyed()) {
                            mainWindow.destroy();
                        }
                        app.quit();
                    }
                }
            ]
        },
        {
            label: 'Quit',
            icon: nativeImage
                .createFromPath(
                    path.join(ROOT_PATH, 'assets', 'context-menu', 'power.png')
                )
                .resize({ width: 12, height: 12 }),
            submenu: [
                {
                    label: 'Confirm quit',
                    click: () => {
                        if (mainWindow && !mainWindow.isDestroyed()) {
                            mainWindow.destroy();
                        }
                        app.quit();
                    }
                }
            ]
        },
        {
            label: `Check for update (${updateService.localVersion})`,
            icon: nativeImage
                .createFromPath(
                    path.join(ROOT_PATH, 'assets', 'context-menu', 'up.png')
                )
                .resize({ width: 12, height: 12 }),
            click: () => {
                updateService.autoUpdate(false);
            }
        }
    ]);

    TRAY.setToolTip('EBP - Tools');
    TRAY.setContextMenu(CONTEXT_MENU);

    // Double-click on the icon to reopen the window.
    TRAY.on('double-click', () => {
        mainWindow.show();
        mainWindow.setSkipTaskbar(false);
    });

    mainWindow.webContents.on('did-navigate', async (event, url) => {
        if (url.startsWith(ROOT_URL)) {
            checkJwtToken(getMainWindow, true);
        } else {
            console.log(`Main window > did-navigate : ${url} - ${HOME_URL}`);
        }
    });

    // Hides the menu bar displayed in the top left corner on Windows.
    mainWindow.setMenuBarVisibility(false);

    // Setup console log redirection to frontend
    setupConsoleRedirection(mainWindow);

    checkJwtToken(getMainWindow, false, (isLoggedIn) => {
        // Loads the application's index.html.
        mainWindow.loadURL(
            isLoggedIn
                ? HOME_URL
                : `https://${EBP_DOMAIN}/${language}/login?app=cutter&redirect_uri=${encodeURIComponent(
                      HOME_URL
                  )}`
        );
    });

    if (isJustUpdated) {
        updateService.showUpdatedNotification();
    }
}

function hideMainWindow() {
    if (getMainWindow() && !getMainWindow().isDestroyed()) {
        getMainWindow()?.hide();
    }
}

function showMainWindow() {
    if (getMainWindow() && !getMainWindow().isDestroyed()) {
        getMainWindow().show();
        getMainWindow().focus();
    }
}

/**
 * Toggles the debug mode on/off. When enabled, closes DevTools and adjusts window size.
 * When disabled, opens DevTools and expands window width to accommodate the dev panel.
 */
function switchDebugMode() {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    debugMode = !debugMode;

    // Opens/closes DevTools
    if (debugMode) {
        mainWindow.webContents.closeDevTools();
    } else {
        mainWindow.webContents.openDevTools();
    }

    // Set window width
    const PRIMARY_DISPLAY = screen.getPrimaryDisplay();
    mainWindow.setResizable(true);
    const DESIRED_WIDTH =
        WINDOW_WIDTH + (!debugMode ? WINDOW_DEV_PANEL_WIDTH : 0);
    mainWindow.setSize(
        Math.min(PRIMARY_DISPLAY.workAreaSize.width, DESIRED_WIDTH),
        Math.min(PRIMARY_DISPLAY.workAreaSize.height, WINDOW_HEIGHT)
    );
    mainWindow.setResizable(false);

    // Center the window after resizing
    centerMainWindow();
}

/**
 * Gets the current main window instance
 * @returns {BrowserWindow|null} The main window instance
 */
function getMainWindow() {
    return mainWindow;
}

function destroyMainWindow() {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.destroy();
    }
}

/**
 * Sets the debug mode state
 * @param {boolean} mode Debug mode state to set
 */
function setDebugMode(mode) {
    debugMode = mode;
}

module.exports = {
    setWindowSize,
    createFloatingWindow,
    deleteFloatingWindow,
    createWindow,
    switchDebugMode,
    getMainWindow,
    setDebugMode,
    destroyMainWindow,
    hideMainWindow,
    showMainWindow
};
