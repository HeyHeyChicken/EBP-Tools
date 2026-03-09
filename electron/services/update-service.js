// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const https = require('https');
const fs = require('fs');
const os = require('os');
const { version } = require('../../package.json');
const { app } = require('electron');
const path = require('node:path');
const { spawn } = require('child_process');
const {
    getMainWindow,
    createFloatingWindow,
    deleteFloatingWindow
} = require('../core/window-manager');
const StorageManager = require('../core/storage-manager');
const { IS_DEV_MODE } = require('../config/constants');

//#endregion

class UpdateService {
    githubVersion = '';

    constructor() {
        this.localVersion = version;

        setInterval(
            () => {
                this.autoUpdate(true);
            },
            1000 * 60 * 60
        );
    }

    //#region Functions

    /**
     * Displays the "Up to date" notification.
     */
    showUpdatedNotification() {
        getMainWindow()?.hide();

        createFloatingWindow(
            450,
            150,
            JSON.stringify({
                percent: 0,
                leftRounded: true,
                infinite: true,
                icon: 'fa-sharp fa-solid fa-check',
                text: '.common.upToDate',
                state: 'info'
            })
        );

        setTimeout(() => {
            deleteFloatingWindow(false);
        }, 5000);
    }

    /**
     * Automatically updates the application.
     * @param {boolean} invisible Should we hide the graphical update elements?
     */
    autoUpdate(invisible) {
        if (!IS_DEV_MODE && !this.localVersion.startsWith('0')) {
            this.getProjectLatestVersion(() => {
                if (this.githubVersion) {
                    if (this.githubVersion != this.localVersion) {
                        let githubFileName = '';
                        let localFileName = '';
                        switch (os.platform()) {
                            case 'win32':
                                githubFileName = `EBP-Tools-${this.githubVersion}.exe`;
                                localFileName = `update.exe`;
                                break;
                            case 'darwin':
                                githubFileName = `EBP-Tools-${this.githubVersion}.dmg`;
                                localFileName = `update.dmg`;
                                break;
                        }

                        if (githubFileName && localFileName) {
                            getMainWindow().webContents.send(
                                'global-message',
                                'common.updatingInProgress'
                            );

                            const FILE_URL = `https://github.com/HeyHeyChicken/EBP-Tools/releases/download/${this.githubVersion}/${githubFileName}`;
                            const DESTINATION_PATH = path.join(
                                app.getPath('userData'),
                                localFileName
                            );

                            if (invisible === false) {
                                getMainWindow()?.hide();

                                createFloatingWindow(
                                    450,
                                    150,
                                    JSON.stringify({
                                        percent: 0,
                                        leftRounded: true,
                                        infinite: false,
                                        icon: undefined,
                                        text: '.common.updatingInProgress',
                                        state: 'info'
                                    })
                                );
                            }

                            this.#download(FILE_URL, DESTINATION_PATH, () => {
                                StorageManager.setPermanentSettingsValue(
                                    'justUpdated',
                                    'true'
                                );
                                switch (os.platform()) {
                                    case 'win32':
                                        spawn(DESTINATION_PATH, {
                                            detached: true,
                                            stdio: 'ignore'
                                        }).unref();
                                        break;
                                    case 'darwin':
                                        spawn('open', [DESTINATION_PATH], {
                                            detached: true,
                                            stdio: 'ignore'
                                        }).unref();
                                        break;
                                }
                                app.quit();
                            });
                        }
                    } else {
                        if (invisible === false) {
                            this.showUpdatedNotification();
                        }
                    }
                }
            });
        }
    }

    /**
     * Retrieves the number of the latest published version of the project.
     * @param {Function} callback (Optional) Return function.
     */
    getProjectLatestVersion(callback) {
        const OPTIONS = {
            hostname: 'api.github.com',
            path: '/repos/heyheychicken/EBP-Tools/releases',
            method: 'GET',
            headers: { 'User-Agent': '' }
        };

        const REQUEST = https.request(OPTIONS, (res) => {
            let data = '';

            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
                try {
                    const DATA = JSON.parse(data);
                    const RELEASE = DATA.find(
                        (r) => r.tag_name && !r.tag_name.startsWith('0')
                    );
                    this.githubVersion = RELEASE ? RELEASE.tag_name : undefined;

                    if (typeof callback !== 'undefined') {
                        callback();
                    }
                } catch (err) {}
            });
        });

        REQUEST.on('error', (err) => console.error(err));
        REQUEST.end();
    }

    /**
     * Downloads a file.
     * @param {String} url URL of the file to download.
     * @param {String} dest Path to place the file.
     * @param {Function} callback Callback function.
     */
    #download(url, dest, callback) {
        https.get(url, (res) => {
            // Redirection
            if (
                (res.statusCode === 301 || res.statusCode === 302) &&
                res.headers.location
            ) {
                return this.#download(res.headers.location, dest, callback);
            }

            if (res.statusCode !== 200) {
                console.error('Erreur:', res.statusCode);
                return;
            }

            const TOTAL = Number.parseInt(res.headers['content-length'], 10);
            let downloaded = 0;
            let lastPercent = 0;

            const FILE = fs.createWriteStream(dest);

            res.on('data', (chunk) => {
                downloaded += chunk.length;

                if (TOTAL) {
                    const PERCENT = Math.round((downloaded / TOTAL) * 100);
                    if (PERCENT > lastPercent) {
                        lastPercent = PERCENT;
                        getMainWindow().webContents.send(
                            'set-notification-data',
                            {
                                percent: PERCENT,
                                infinite: PERCENT == 100,
                                icon:
                                    PERCENT == 100
                                        ? 'fa-sharp fa-solid fa-download'
                                        : undefined,
                                text: '.common.updatingInProgress',
                                leftRounded: true,
                                state: 'info'
                            }
                        );
                    }
                }
            });

            res.pipe(FILE);

            FILE.on('finish', () => {
                FILE.close(() => {
                    // On Windows, the OS may not release the file handle immediately after close(), causing EBUSY when trying to spawn the installer.
                    // A short delay ensures the kernel has fully released the file.
                    if (os.platform() === 'win32') {
                        setTimeout(() => callback?.(), 500);
                    } else {
                        callback?.();
                    }
                });
            });
        });
    }

    //#endregion
}

module.exports = UpdateService;
