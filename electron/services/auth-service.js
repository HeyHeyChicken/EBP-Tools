// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const https = require('https');
const { app, session } = require('electron');
const { EBP_DOMAIN, getCurrentPort } = require('../config/constants');
const StorageManager = require('../core/storage-manager');

//#endregion

/**
 * This function indicates whether the user's access token exists and is still valid.
 * @returns {boolean}
 */
function isJwtAccessTokenOk() {
    console.log(`Checking access token...`);
    const JWT = StorageManager.permanentSettings['jwt'];
    if (JWT) {
        if (Date.now() < JWT.access_expires_in) {
            console.log('Access token is ok.');
            return true;
        }
    }
    console.log('Access token not ok.');
    return false;
}

/**
 * This function indicates whether the user's refresh token exists and is still valid.
 * @returns {boolean}
 */
function isJwtRefreshTokenOk() {
    console.log(`Checking refresh token...`);
    const JWT = StorageManager.permanentSettings['jwt'];
    if (JWT) {
        if (Date.now() < JWT.refresh_expires_in) {
            console.log('Refresh token is ok.');
            return true;
        }
    }
    console.log('Refresh token not ok.');
    return false;
}

/**
 * This function checks that the user is logged in with a valid token.
 * @param {boolean} justLoggedFromWordpress
 * @param {Function|undefined} callback Callback function with loggin in information.
 */
async function checkJwtToken(getMainWindow, justLoggedFromWordpress, callback) {
    console.log(
        `Checking JWT token... (justLoggedFromWordpress: ${justLoggedFromWordpress})`
    );
    if (isJwtAccessTokenOk()) {
        if (callback) {
            callback(true);
        }
    } else {
        const IS_JWT_REFRESH_TOKEN_OK = isJwtRefreshTokenOk();
        if (IS_JWT_REFRESH_TOKEN_OK || justLoggedFromWordpress) {
            const SETTINGS = StorageManager.permanentSettings;

            // We retrieve cookies from the main window.
            const COOKIES =
                await getMainWindow().webContents.session.cookies.get({
                    url: `https://${EBP_DOMAIN}`
                });

            // We transform cookies into headers.
            const COOKIES_HEADER = COOKIES.map(
                (c) => `${c.name}=${c.value}`
            ).join('; ');

            let path = '/back/api/?c=user&r=token';
            if (IS_JWT_REFRESH_TOKEN_OK) {
                path += '&refresh=' + SETTINGS['jwt'].refresh_token;
            }
            const REQUEST_OPTIONS = {
                hostname: EBP_DOMAIN,
                port: 443,
                path: path,
                method: 'GET',
                headers: {
                    Cookie: COOKIES_HEADER,
                    Accept: 'application/json'
                }
            };

            const REQUEST = https.request(REQUEST_OPTIONS, (res) => {
                let data = '';

                res.on('data', (chunk) => {
                    data += chunk;
                });

                res.on('end', () => {
                    try {
                        const DATA = JSON.parse(data);
                        DATA.access_expires_in =
                            DATA.access_expires_in * 1000 + Date.now();
                        DATA.refresh_expires_in =
                            DATA.refresh_expires_in * 1000 + Date.now();

                        SETTINGS['jwt'] = DATA;
                        StorageManager.permanentSettings = SETTINGS;

                        getMainWindow().webContents.send(
                            'set-jwt-access-token',
                            SETTINGS['jwt'].access_token
                        );

                        if (callback) {
                            callback(true);
                        }
                    } catch (e) {
                        console.error(`Error: ${e.message}`);
                        if (callback) {
                            callback(false);
                        }
                    }
                });
            });

            REQUEST.on('error', (e) => {
                console.error(`Error: ${e.message}`);
                if (callback) {
                    callback(false);
                }
            });

            REQUEST.end();
        } else {
            if (callback) {
                callback(false);
            }
        }
    }
}

/**
 * Logs out the user by clearing JWT tokens and session data.
 * @param {number} port Express server port.
 */
function logout(getMainWindow) {
    const SESSION = session.defaultSession;

    StorageManager.permanentSettings = {};

    Promise.all([
        SESSION.clearStorageData({
            storages: [
                'cookies',
                'localstorage',
                'indexdb',
                'websql',
                'serviceworkers'
            ]
        }),
        SESSION.clearCache()
    ]).then(() => {
        getMainWindow().loadURL(
            `https://${EBP_DOMAIN}/${app.getLocale()}/login?app=cutter&redirect_uri=${encodeURIComponent(
                `http://localhost:${getCurrentPort()}`
            )}`
        );
    });
}

module.exports = {
    checkJwtToken,
    logout,
    isJwtAccessTokenOk
};
