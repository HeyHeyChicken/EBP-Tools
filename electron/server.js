// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const {
    app,
    BrowserWindow,
    ipcMain,
    session,
    dialog,
    shell
} = require('electron');

//#region Configure auto-updater

/**
 * I can't get Electron's automatic update system to work, so I disable it and create a homemade auto updater.
 */

//const { autoUpdater } = require('electron-updater');
//autoUpdater.autoDownload = true;
//autoUpdater.autoInstallOnAppQuit = true;
//autoUpdater.disableDifferentialDownload = true; // Disable differential downloads (blockmap not available with Electron Forge)

//#endregion

// When in installation mode, close the application.
if (require('electron-squirrel-startup')) {
    app.quit();
}

const path = require('node:path');
const os = require('os');
const { exec, execFile, spawn } = require('child_process');
const https = require('https');
const http = require('http');
const fs = require('fs');
const ExcelJS = require('exceljs');
require('./discord-rpc');
const {
    extractPublicPseudoGames,
    extractPrivatePseudoGames
} = require('./puppeteer.js');
const util = require('util');
const execAsync = util.promisify(exec);
const {
    EBP_DOMAIN,
    IS_DEV_MODE,
    ROOT_PATH,
    DEFAULT_VIDEO_HEIGHT,
    FFMPEG_PATH,
    ANALYZER_PATH,
    PROTOCOL_NAME,
    PUPPETEER_USER_DATA_PATH,
    getCurrentPort
} = require('./config/constants');
const {
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
} = require('./core/window-manager');
const StorageManager = require('./core/storage-manager');
const socketEmit = require('./services/socket-service');
const { checkJwtToken, logout } = require('./services/auth-service');
const { setupExpressServer } = require('./express/express-server');
const {
    changeVideoResolution,
    removeBorders,
    fixForBrowser
} = require('./services/video-service');
const { unlinkSync } = require('./services/global-service');
const UpdateService = require('./services/update-service');
const ytDlpService = require('./services/ytdlp-service');
const watchFolderService = require('./services/watch-folder-service');

//#endregion

// Initialize debug mode
setDebugMode(IS_DEV_MODE);

//#region tools://

if (process.defaultApp) {
    if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient(PROTOCOL_NAME, process.execPath, [
            path.resolve(process.argv[1])
        ]);
    }
} else {
    app.setAsDefaultProtocolClient(PROTOCOL_NAME);
}

//#endregion

const UPDATE_SERVICE = new UpdateService();
const APP_GOT_THE_LOCK = app.requestSingleInstanceLock();

if (!APP_GOT_THE_LOCK) {
    // Another instance is already launched => we quit.
    app.quit();
}

(async () => {
    const NUMBER_OF_OPENINGS_KEY = 'numberOfOpenings';
    const NUMBER_OF_OPENINGS = StorageManager.getTemporarySettingsValue(
        NUMBER_OF_OPENINGS_KEY,
        0
    );
    StorageManager.setTemporarySettingsValue(
        NUMBER_OF_OPENINGS_KEY,
        NUMBER_OF_OPENINGS + 1
    );

    if (NUMBER_OF_OPENINGS === 0) {
        app.relaunch();
        destroyMainWindow();
        app.quit();
        return;
    }

    //#region Express Server Setup

    await setupExpressServer();

    //#endregion

    /**
     * Handle deep link URL (ebp://...)
     * @param {string} url The deep link URL to handle
     */
    async function handleDeepLink(url) {
        console.log('[DEEP-LINK] Received URL:', url);

        if (!url || !url.startsWith(`${PROTOCOL_NAME}://`)) {
            return;
        }

        // Remove protocol prefix (ebp://)
        const PATH = url.replace(`${PROTOCOL_NAME}://`, '');
        console.log('[DEEP-LINK] Path:', PATH);

        // Parse the URL to extract action and parameters
        // Example: ebp://open-game/12345
        const PARTS = PATH.split('/');
        const ACTION = PARTS[0];
        const PARAMS = PARTS.slice(1);

        const DATA = JSON.parse(decodeURIComponent(PARAMS));

        handleDeepLinkData(ACTION, DATA);
    }

    /**
     * Handle deep link URL (ebp://...)
     * @param {string} action
     * @param {*} data
     */
    async function handleDeepLinkData(action, data) {
        console.log('[DEEP-LINK] Action:', action, 'Params:', data);

        StorageManager.setTemporarySettingsValue('deeplink', {
            action: action,
            data: data
        });

        switch (action) {
            case 'openFolder':
                openDirectory((directoryPath) => {
                    socketEmit(data.socket, 'openFolder', directoryPath);

                    StorageManager.setTemporarySettingsValue(
                        'deeplink',
                        undefined
                    );
                });
                break;
            case 'importGamesFromExcel':
                const EXCEL_FILES = await openFiles('xlsx');
                if (EXCEL_FILES.length == 1) {
                    const WORKBOOK = new ExcelJS.Workbook();
                    await WORKBOOK.xlsx.readFile(EXCEL_FILES[0]);

                    const GAMES = [];
                    const WORKSHEET = WORKBOOK.getWorksheet(1);
                    WORKSHEET.eachRow((ROW, ROW_NUMBER) => {
                        if (ROW_NUMBER >= 4) {
                            GAMES.push({
                                mode: ROW.getCell('A').value,
                                map: ROW.getCell('C').value,
                                date: ROW.getCell('D').value,
                                hour: ROW.getCell('E').value,
                                duration: ROW.getCell('G').value,
                                orangeTeam: {
                                    name: 'ALLIANCE',
                                    score: ROW.getCell('H').value,
                                    players: []
                                },
                                blueTeam: {
                                    name: 'REBELS',
                                    score: ROW.getCell('AR').value,
                                    players: []
                                }
                            });

                            const JUMP = 7;
                            for (let i = 9; i < 9 + JUMP * 5; i += JUMP) {
                                const PLAYER_NAME = ROW.getCell(i).value;
                                if (PLAYER_NAME !== null) {
                                    GAMES[
                                        GAMES.length - 1
                                    ].orangeTeam.players.push({
                                        name: PLAYER_NAME,
                                        kills: ROW.getCell(i + 1).value,
                                        deaths: ROW.getCell(i + 2).value,
                                        assists: ROW.getCell(i + 3).value,
                                        score: ROW.getCell(i + 4).value,
                                        inflictedDamage: ROW.getCell(i + 5)
                                            .value,
                                        bulletsFiredAccuracy: ROW.getCell(i + 6)
                                            .value
                                    });
                                }
                            }
                            for (let i = 45; i < 45 + JUMP * 5; i += JUMP) {
                                const PLAYER_NAME = ROW.getCell(i).value;
                                if (PLAYER_NAME !== null) {
                                    GAMES[
                                        GAMES.length - 1
                                    ].blueTeam.players.push({
                                        name: PLAYER_NAME,
                                        kills: ROW.getCell(i + 1).value,
                                        deaths: ROW.getCell(i + 2).value,
                                        assists: ROW.getCell(i + 3).value,
                                        score: ROW.getCell(i + 4).value,
                                        inflictedDamage: ROW.getCell(i + 5)
                                            .value,
                                        bulletsFiredAccuracy: ROW.getCell(i + 6)
                                            .value
                                    });
                                }
                            }
                        }
                    });

                    const CHUNK_SIZE = 200;
                    for (let i = 0; i < GAMES.length; i += CHUNK_SIZE) {
                        socketEmit(
                            data.socket,
                            'exportGames',
                            GAMES.slice(i, i + CHUNK_SIZE)
                        );
                    }
                    socketEmit(data.socket, 'exportGamesEnd', {
                        games: GAMES.length,
                        fromExcel: true
                    });
                }
                break;
            case 'encodeVideo':
                const FILES_TO_ENCODE_PATHS = await openFiles(
                    data.filesExtensions
                );
                if (FILES_TO_ENCODE_PATHS.length == 1) {
                    const NOTIFICATION_DATA = {
                        percent: 0,
                        leftRounded: true,
                        infinite: false,
                        icon: '',
                        text: '.common.encoding',
                        state: 'info'
                    };
                    createFloatingWindow(
                        450,
                        150,
                        JSON.stringify(NOTIFICATION_DATA)
                    );

                    const TMP_PATH = `${FILES_TO_ENCODE_PATHS[0]}.temp.mp4`;
                    const DURATION = await getVideoDuration(
                        FILES_TO_ENCODE_PATHS[0]
                    );
                    const ARGS = [
                        '-y',
                        '-i',
                        FILES_TO_ENCODE_PATHS[0],
                        '-vf',
                        'pad=ceil(iw/2)*2:ceil(ih/2)*2,fps=30',
                        '-c:v',
                        'libx264',
                        TMP_PATH
                    ];

                    console.log(`[FFMPEG] Encoding video...`);

                    const COMMAND = spawn(FFMPEG_PATH, ARGS);

                    COMMAND.stderr.on('data', (data) => {
                        const STR = data.toString();

                        const TIME_MATCH = STR.match(/time=(\d+:\d+:\d+\.\d+)/);
                        if (TIME_MATCH) {
                            const [h, m, s] = TIME_MATCH[1].split(':');
                            const CURRENT = +h * 3600 + +m * 60 + parseFloat(s);
                            const PERCENT = Math.min(
                                100,
                                Math.round((CURRENT / DURATION) * 100)
                            );

                            getMainWindow().webContents.send(
                                'set-notification-data',
                                {
                                    ...NOTIFICATION_DATA,
                                    ...{ percent: PERCENT }
                                }
                            );
                        }
                    });

                    COMMAND.on('close', (code) => {
                        if (code === 0) {
                            console.log(`[FFMPEG] Video encoded.`);

                            const OUTPUT = FILES_TO_ENCODE_PATHS[0].replace(
                                path.extname(FILES_TO_ENCODE_PATHS[0]),
                                '.mp4'
                            );

                            if (fs.existsSync(FILES_TO_ENCODE_PATHS[0])) {
                                unlinkSync(FILES_TO_ENCODE_PATHS[0]);
                            }

                            fs.renameSync(TMP_PATH, OUTPUT);

                            getMainWindow().webContents.send(
                                'set-notification-data',
                                {
                                    percent: 100,
                                    leftRounded: true,
                                    infinite: false,
                                    icon: 'fa-sharp fa-solid fa-check',
                                    text: '.common.encoded',
                                    state: 'success'
                                }
                            );

                            StorageManager.setTemporarySettingsValue(
                                'deeplink',
                                undefined
                            );

                            setTimeout(() => {
                                deleteFloatingWindow();
                            }, 5000);
                        } else {
                            deleteFloatingWindow();
                            StorageManager.setTemporarySettingsValue(
                                'deeplink',
                                undefined
                            );
                        }
                    });
                } else {
                    console.log(
                        `Error: ${FILES_TO_ENCODE_PATHS.length} file${FILES_TO_ENCODE_PATHS.length > 1 ? 's' : ''} selected.`
                    );
                    StorageManager.setTemporarySettingsValue(
                        'deeplink',
                        undefined
                    );
                }
                break;
            case 'exportGames':
                if (data.publicPseudo) {
                    extractPublicPseudoGames(
                        app,
                        data.publicPseudo,
                        data.nbPages,
                        data.seasonIndex,
                        data.timeToWait,
                        dialog,
                        getMainWindow(),
                        data.debug,
                        async (games) => {
                            console.log(
                                '################################################'
                            );
                            console.log(games);
                            console.log(
                                '################################################'
                            );

                            const CHUNK_SIZE = 200;
                            for (let i = 0; i < games.length; i += CHUNK_SIZE) {
                                socketEmit(
                                    data.socket,
                                    'exportGames',
                                    games.slice(i, i + CHUNK_SIZE)
                                );
                            }
                            socketEmit(data.socket, 'exportGamesEnd', {
                                games: games.length,
                                fromExcel: false
                            });

                            StorageManager.setTemporarySettingsValue(
                                'deeplink',
                                undefined
                            );

                            if (
                                games.length > 0 &&
                                data.excelDestinationFolder
                            ) {
                                exportGamesToExcel(
                                    games,
                                    data.publicPseudo.split('#')[0],
                                    data.excelDestinationFolder
                                );
                            }
                        }
                    );
                } else {
                    extractPrivatePseudoGames(
                        app,
                        data.nbPages,
                        data.seasonIndex,
                        data.timeToWait,
                        dialog,
                        getMainWindow(),
                        data.debug,
                        async (games) => {
                            console.log(
                                '################################################'
                            );
                            console.log(games);
                            console.log(
                                '################################################'
                            );
                            const CHUNK_SIZE = 200;
                            for (let i = 0; i < games.length; i += CHUNK_SIZE) {
                                socketEmit(
                                    data.socket,
                                    'exportGames',
                                    games.slice(i, i + CHUNK_SIZE)
                                );
                            }
                            socketEmit(data.socket, 'exportGamesEnd', {
                                games: games.length,
                                fromExcel: false
                            });

                            StorageManager.setTemporarySettingsValue(
                                'deeplink',
                                undefined
                            );

                            if (
                                games.length > 0 &&
                                data.excelDestinationFolder
                            ) {
                                exportGamesToExcel(
                                    games,
                                    'private',
                                    data.excelDestinationFolder
                                );
                            }
                        }
                    );
                }
                break;
            case 'analyzeVideoFile':
                const FILES_PATHS = await openFiles(data.filesExtensions, true);
                if (FILES_PATHS.length > 0) {
                    const MAX_TIME_PER_GAME = data.maxTime ?? 10;
                    const DURATIONS = await Promise.all(
                        FILES_PATHS.map((p) =>
                            getVideoDuration(p).catch(() => 0)
                        )
                    );
                    const TOTAL_SECONDS = DURATIONS.reduce((a, b) => a + b, 0);
                    socketEmit(data.socket, 'analyzeVideoFileGames', {
                        type: 'length',
                        value: TOTAL_SECONDS
                    });

                    const WATCH_FOLDER = watchFolderService.getWatchFolder();
                    if (!fs.existsSync(WATCH_FOLDER)) {
                        fs.mkdirSync(WATCH_FOLDER, { recursive: true });
                    }
                    for (const SRC of FILES_PATHS) {
                        const EXT = path.extname(SRC);
                        const BASE = path.basename(SRC, EXT);
                        const DEST = path.join(
                            WATCH_FOLDER,
                            `${BASE}__mtpg-${MAX_TIME_PER_GAME}${EXT}`
                        );
                        fs.copyFileSync(SRC, DEST);
                    }
                } else {
                    socketEmit(data.socket, 'analyzeVideoFileGames', {
                        type: 'length',
                        value: 0
                    });
                }

                StorageManager.setTemporarySettingsValue('deeplink', undefined);
                break;
            case 'analyzeChunks':
                if (
                    data.videoPath &&
                    Array.isArray(data.chunks) &&
                    data.chunks.length > 0
                ) {
                    runChunkAnalyzer(data.videoPath, data.socket, data.chunks);
                }
                StorageManager.setTemporarySettingsValue('deeplink', undefined);
                break;
            case 'clean_puppeteer_data':
                unlinkSync(PUPPETEER_USER_DATA_PATH);
                break;
        }
    }

    /**
     * This function allows you to wait for an HTTP:PORT address to respond.
     * @param {number} port Port of address to wait.
     * @param {string} host (optional) Host of address to wait.
     * @param {number} timeout (optional) Maximum time to wait before declaring a failure.
     * @param {number} interval (optional) Address presence check interval.
     * @returns
     */
    function waitForHttp(
        port,
        host = 'localhost',
        timeout = 60 * 1000,
        interval = 500
    ) {
        return new Promise((resolve, reject) => {
            const DEADLINE = Date.now() + timeout;

            const CHECK = () => {
                const REQUEST = http.get(
                    { hostname: host, port: port, path: '/', timeout: 2000 },
                    (res) => {
                        res.destroy();
                        resolve();
                    }
                );

                REQUEST.on('error', () => {
                    if (Date.now() > DEADLINE) {
                        reject(
                            new Error(
                                `Timeout waiting for HTTP server on port ${port}`
                            )
                        );
                    } else {
                        setTimeout(CHECK, interval);
                    }
                });
            };

            CHECK();
        });
    }

    async function openDirectory(callback) {
        const { canceled, filePaths } = await dialog.showOpenDialog({
            properties: ['openDirectory'],
            defaultPath: path.join(os.homedir(), 'Downloads')
        });
        if (!canceled && filePaths.length == 1) {
            callback(filePaths[0]);
        } else {
            callback(undefined);
        }
    }

    async function openFiles(extensions, multiple = false) {
        const PROPERTIES = ['openFile'];
        if (multiple) PROPERTIES.push('multiSelections');
        const { canceled, filePaths } = await dialog.showOpenDialog({
            properties: PROPERTIES,
            filters: [{ extensions: extensions }]
        });

        if (canceled || filePaths.length == 0) {
            return [];
        }

        const ALLOWED = new Set(extensions.map((e) => e.toLowerCase()));
        return filePaths.filter((p) =>
            ALLOWED.has(path.extname(p).slice(1).toLowerCase())
        );
    }

    /**
     * This function cuts out a part of a video to get one file per game.
     * @param {Game} game Game's data.
     * @param {string} videoPath Full video path.
     * @param {string} fileName (optional) File name.
     * @returns {string} Cutted video path.
     */
    function cutVideoFile(
        game,
        videoPath,
        fileName = undefined,
        customText = undefined
    ) {
        const EXTENSION = videoPath.split('.').pop().toLowerCase();
        // A unique number is added to the end of the file name to ensure that an existing file is not overwritten.
        const OUTPUT_FILE_PATH /* string */ = path.join(
            StorageManager.getPermanentSettingsValue(
                'videoCutterOutputPath',
                path.join(os.homedir(), 'Downloads')
            ),
            (fileName
                ? fileName
                : `EBP - ${
                      game.map
                  } ${customText ? '- ' + customText + ' ' : ''}${game.orangeTeam.score} vs ${game.blueTeam.score} (${new Date().getTime()})`) +
                `.${EXTENSION}`
        );
        unlinkSync(OUTPUT_FILE_PATH);

        const COMMAND /* string */ = `"${FFMPEG_PATH}" -ss ${
            game._start
        } -i "${videoPath}" -t ${
            game._end - game._start
        } -c copy "${OUTPUT_FILE_PATH}"`;

        console.log(`[FFMPEG] Cut Game - Executing: ${COMMAND}`);

        return new Promise((resolve, reject) => {
            exec(COMMAND, (error, stdout, stderr) => {
                if (error) {
                    console.error(
                        `[FFMPEG] Cut Game - Error: ${error.message}`
                    );
                    return reject(error);
                }

                if (stderr) {
                    console.log(`[[FFMPEG] Cut Game - Output: ${stderr}`);
                }

                if (stdout) {
                    console.log(`[[FFMPEG] Cut Game - Stdout: ${stdout}`);
                }

                console.log(
                    `[[FFMPEG] Cut Game - Completed successfully: ${OUTPUT_FILE_PATH}`
                );
                resolve(OUTPUT_FILE_PATH);
            });
        });
    }

    /**
     * Returns the video duration in seconds (float).
     */
    function getVideoDuration(videoPath) {
        return new Promise((resolve, reject) => {
            const COMMAND = spawn(FFMPEG_PATH, ['-i', videoPath]);

            let stderr = '';
            COMMAND.stderr.on('data', (d) => (stderr += d.toString()));
            COMMAND.on('error', reject);

            COMMAND.on('close', () => {
                // Duration: 00:01:23.45, start: 0.000000, bitrate: ...
                const MATCH = stderr.match(/Duration:\s(\d+):(\d+):(\d+\.\d+)/);
                if (!MATCH) return reject(new Error('Duration not found'));

                const [, h, m, s] = MATCH;
                const duration = +h * 3600 + +m * 60 + parseFloat(s);

                resolve(duration);
            });
        });
    }

    /**
     * This function uploads the video of a game's minimap to EBP's S3 server.
     * @param {*} url URL to upload the video to.
     * @param {*} videoPath Local path to the video file to upload.
     * @param {*} callback Callback function.
     */
    function uploadVideo(url, videoPath, callback) {
        const VIDEO_PATH = videoPath.normalize('NFC');
        const UPLOAD_URL = new URL(url);

        const UPLOAD_OPTIONS = {
            method: 'PUT',
            hostname: UPLOAD_URL.hostname,
            path: UPLOAD_URL.pathname + UPLOAD_URL.search,
            headers: {
                'Content-Type': 'video/mp4'
            }
        };

        const UPLOAD_REQUEST = https.request(UPLOAD_OPTIONS, (res) => {
            // This line This line is essential.
            // Without it, 'end' will never fire.
            res.on('data', () => {});

            res.on('end', () => {
                callback();
            });
        });

        UPLOAD_REQUEST.on('error', (err) => console.error('Error:', err));

        fs.createReadStream(VIDEO_PATH).pipe(UPLOAD_REQUEST);
    }

    /**
     * This function tells the EBP GPU server that a new video is ready to be analyzed.
     * @param {*} gameID ID of the game.
     * @param {*} callback Callback function.
     */
    function setVideoAsUploaded(
        gameID,
        sortedOrangePlayersNames,
        sortedBluePlayersNames,
        gameStart,
        cropPosition,
        margedCropPosition,
        callback
    ) {
        const URL_PARAMS = new URLSearchParams({
            r: 's3_uploaded',
            gameID: gameID,
            dev: !IS_DEV_MODE ? '0' : '1'
        });

        const OPTIONS = {
            hostname: EBP_DOMAIN,
            port: 443,
            path: `/back/api-tools/?${URL_PARAMS.toString()}`,
            method: 'PUT',
            headers: {
                Authorization: `Bearer ${StorageManager.permanentSettings['jwt'].access_token}`,
                'Content-Type': 'application/json'
            }
        };

        const REQUEST_BODY = JSON.stringify({
            orangePlayersNames: sortedOrangePlayersNames,
            bluePlayersNames: sortedBluePlayersNames,
            gameStart: gameStart,
            cropPosition: cropPosition,
            margedCropPosition: margedCropPosition
        });

        const REQUEST = https.request(OPTIONS, (res) => {
            let data = '';

            // This line This line is essential.
            // Without it, 'end' will never fire.
            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                callback();
            });
        });

        REQUEST.on('error', (e) => {
            console.error('Error:', e);
        });

        REQUEST.write(REQUEST_BODY);
        REQUEST.end();
    }

    function runAnalyzer(videoPath, socket, settings) {
        const HEADLESS = !socket;

        return new Promise((resolve, reject) => {
            const SETTINGS_JSON = JSON.stringify(settings || {});
            const ARGS = ['detect', videoPath, FFMPEG_PATH, '', SETTINGS_JSON];
            const SPAWN_OPTIONS = {
                stdio: ['ignore', 'pipe', 'pipe'],
                cwd: path.dirname(ANALYZER_PATH),
                windowsHide: true
            };
            const ANALYZER = spawn(ANALYZER_PATH, ARGS, SPAWN_OPTIONS);
            let BUFFER = '';
            const LINE_QUEUE = [];
            const GAMES = [];
            let SCHEDULED = false;
            let RESOLVED = false;

            const processQueue = () => {
                SCHEDULED = false;
                const WINDOW = getMainWindow();
                let percent = 0;
                let nbGames = 0;
                while (LINE_QUEUE.length > 0) {
                    const LINE = LINE_QUEUE.shift();
                    if (!LINE.trim()) continue;
                    try {
                        const MSG = JSON.parse(LINE);

                        if (MSG.type === 'game' && MSG.game) {
                            GAMES.push(MSG.game);
                        }

                        socketEmit(socket, 'analyzeVideoFileGames', MSG);

                        if (MSG.percent) {
                            percent = MSG.percent;
                        }
                        if (MSG.nbGames) {
                            nbGames = MSG.nbGames;
                        }

                        if (WINDOW && !WINDOW.isDestroyed()) {
                            WINDOW.webContents.send('analyzer-update', MSG);
                        }
                        if (
                            (MSG.type === 'done' || MSG.type === 'error') &&
                            !RESOLVED
                        ) {
                            if (!HEADLESS) deleteFloatingWindow(false);
                            RESOLVED = true;
                            resolve({ ...MSG, games: GAMES });
                        }
                    } catch (_) {}
                }
            };

            ANALYZER.stdout.on('data', (data) => {
                BUFFER += data.toString();
                const LINES = BUFFER.split('\n');
                BUFFER = LINES.pop();
                for (const LINE of LINES) {
                    LINE_QUEUE.push(LINE);
                }
                if (LINE_QUEUE.length > 0 && !SCHEDULED) {
                    SCHEDULED = true;
                    setImmediate(processQueue);
                }
            });

            ANALYZER.stderr.on('data', (data) => {
                console.error('[analyzer stderr]', data.toString());
            });

            ANALYZER.on('close', (code) => {
                if (BUFFER.trim()) {
                    LINE_QUEUE.push(BUFFER.trim());
                    if (!SCHEDULED) {
                        SCHEDULED = true;
                        setImmediate(processQueue);
                    }
                }
                setImmediate(() => {
                    if (!RESOLVED) {
                        RESOLVED = true;
                        resolve({ type: 'close', code, games: GAMES });
                    }
                });
            });

            ANALYZER.on('error', (err) => {
                const MSG = { type: 'error', message: err.message };
                if (!HEADLESS) {
                    const WINDOW = getMainWindow();
                    if (WINDOW && !WINDOW.isDestroyed()) {
                        WINDOW.webContents.send('analyzer-update', MSG);
                    }
                }
                reject(err);
            });
        });
    }

    /**
     * Phase 2 : analyse approfondie de chunks pré-identifiés (timer + scores in-game).
     * Stream les events JSON-lines du binaire Python sur le socket
     * `analyzeVideoFileChunkAnalysis` du front. Le payload émis a la forme
     * { percent, results: [{ gameID, generated_by, payload }] }.
     * @param {string} videoPath Chemin absolu vers la vidéo (déjà choisi en phase 1, propagé par le front).
     * @param {string} socket    Socket ID du front qui doit recevoir les events.
     * @param {Array}  chunks    [{startSeconds, endSeconds, gameID, mode}] — segments à analyser.
     */
    function runChunkAnalyzer(videoPath, socket, chunks, settings) {
        const HEADLESS = !socket;
        const NOTIFICATION_DATA = {
            percent: 0,
            leftRounded: true,
            infinite: true,
            icon: 'fa-sharp fa-solid fa-clapperboard-play',
            text: '.view.replay_cutter.videoStartsItsAnalysis',
            state: 'info'
        };
        if (!HEADLESS) {
            createFloatingWindow(500, 150, JSON.stringify(NOTIFICATION_DATA));
        }

        return new Promise((resolve, reject) => {
            const SETTINGS_JSON = JSON.stringify({
                ...(settings || {}),
                chunks: chunks
            });
            const ARGS = ['chunks', videoPath, FFMPEG_PATH, '', SETTINGS_JSON];
            const SPAWN_OPTIONS = {
                stdio: ['ignore', 'pipe', 'pipe'],
                cwd: path.dirname(ANALYZER_PATH),
                windowsHide: true
            };
            const ANALYZER = spawn(ANALYZER_PATH, ARGS, SPAWN_OPTIONS);
            let BUFFER = '';
            const LINE_QUEUE = [];
            const RESULTS = [];
            let LAST_ERROR = null;
            let SCHEDULED = false;
            let RESOLVED = false;

            const processQueue = () => {
                SCHEDULED = false;
                const WINDOW = HEADLESS ? null : getMainWindow();
                let percent = 0;
                while (LINE_QUEUE.length > 0) {
                    const LINE = LINE_QUEUE.shift();
                    if (!LINE.trim()) continue;
                    try {
                        const MSG = JSON.parse(LINE);

                        if (Array.isArray(MSG.results) && MSG.results.length) {
                            RESULTS.push(...MSG.results);
                        }
                        if (MSG.error) {
                            LAST_ERROR = MSG.error;
                        }

                        if (!HEADLESS) {
                            socketEmit(
                                socket,
                                'analyzeVideoFileChunkAnalysis',
                                MSG
                            );
                        }
                        console.log(MSG);

                        if (typeof MSG.percent === 'number') {
                            percent = MSG.percent;
                        }
                        if (WINDOW && !WINDOW.isDestroyed()) {
                            WINDOW.webContents.send('analyzer-update', MSG);
                            WINDOW.webContents.send('set-notification-data', {
                                ...NOTIFICATION_DATA,
                                ...{
                                    infinite: false,
                                    percent: percent,
                                    icon: undefined,
                                    text: '.view.replay_cutter.videoStartsItsAnalysis'
                                }
                            });
                        }
                        if ((MSG.error || percent >= 100) && !RESOLVED) {
                            if (!HEADLESS) deleteFloatingWindow();
                            RESOLVED = true;
                            resolve({
                                ...MSG,
                                results: RESULTS,
                                error: LAST_ERROR
                            });
                        }
                    } catch (_) {}
                }
            };

            ANALYZER.stdout.on('data', (data) => {
                BUFFER += data.toString();
                const LINES = BUFFER.split('\n');
                BUFFER = LINES.pop();
                for (const LINE of LINES) {
                    LINE_QUEUE.push(LINE);
                }
                if (LINE_QUEUE.length > 0 && !SCHEDULED) {
                    SCHEDULED = true;
                    setImmediate(processQueue);
                }
            });

            ANALYZER.stderr.on('data', (data) => {
                console.error('[chunk-analyzer stderr]', data.toString());
            });

            ANALYZER.on('close', (code) => {
                if (BUFFER.trim()) {
                    LINE_QUEUE.push(BUFFER.trim());
                    if (!SCHEDULED) {
                        SCHEDULED = true;
                        setImmediate(processQueue);
                    }
                }
                setImmediate(() => {
                    if (!RESOLVED) {
                        RESOLVED = true;
                        resolve({
                            type: 'close',
                            code,
                            results: RESULTS,
                            error: LAST_ERROR
                        });
                    }
                });
            });

            ANALYZER.on('error', (err) => {
                const MSG = { error: err.message };
                if (!HEADLESS) {
                    const WINDOW = getMainWindow();
                    if (WINDOW && !WINDOW.isDestroyed()) {
                        WINDOW.webContents.send('analyzer-update', MSG);
                    }
                }
                reject(err);
            });
        });
    }

    /**
     * This function allows you to retrieve an upload URL to the EBP S3 server.
     * @param {*} gameID ID of the game to attach the video to.
     * @param {*} callback Callback function.
     */
    function getVideoUploadURLs(gameID, callback) {
        const PARAMS = new URLSearchParams({
            r: 's3_create_video_url',
            gameID: gameID
        });

        const REQUEST_OPTIONS = {
            hostname: EBP_DOMAIN,
            port: 443,
            path: `/back/api-tools/?${PARAMS.toString()}`,
            method: 'GET',
            headers: {
                Authorization: `Bearer ${StorageManager.permanentSettings['jwt'].access_token}`,
                'Content-Type': 'application/json'
            }
        };

        const REQUEST = https.request(REQUEST_OPTIONS, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                try {
                    callback(JSON.parse(data));
                } catch (err) {
                    console.error(
                        'Failed to parse API response:',
                        err.message,
                        '| raw:',
                        data
                    );
                }
            });
        });

        REQUEST.on('error', (err) => {
            console.error('Error:', err);
        });

        REQUEST.end();
    }

    /**
     * Crops a video file to a specific rectangular region using FFmpeg and saves it with reduced framerate (10fps).
     * @param game Game object containing team names and map information for filename generation.
     * @param videoPath Path to the source video file to crop.
     * @param cropPosition Object with x1, y1, x2, y2 coordinates defining the crop area.
     * @param fileName Optional custom filename, otherwise auto-generated from game data.
     * @returns Promise that resolves to the output file path when cropping is complete.
     */
    function cropVideoFile(
        game,
        videoPath,
        cropPosition,
        fileName = undefined
    ) {
        const EXTENSION = videoPath.split('.').pop().toLowerCase();
        // If "fileName" is not set, a unique number is added to the end of the file name to ensure that an existing file is not overwritten.
        const OUTPUT_FILE_PATH /* string */ = path.join(
            StorageManager.getPermanentSettingsValue(
                'videoCutterOutputPath',
                path.join(os.homedir(), 'Downloads')
            ),
            (fileName
                ? fileName
                : `EBP - ${game.orangeTeam.name} vs ${game.blueTeam.name} - ${
                      game.map
                  } (${new Date().getTime()})`) + `.${EXTENSION}`
        );
        unlinkSync(OUTPUT_FILE_PATH);

        const COMMAND /* string */ = `"${FFMPEG_PATH}" -i "${videoPath}" -filter:v "crop=${cropPosition.x2 - cropPosition.x1}:${cropPosition.y2 - cropPosition.y1}:${cropPosition.x1}:${cropPosition.y1}" -r 10 -an "${OUTPUT_FILE_PATH}"`;

        console.log(`[FFMPEG] Crop - Executing: ${COMMAND}`);

        return new Promise((resolve, reject) => {
            exec(COMMAND, (error, stdout, stderr) => {
                if (error) {
                    console.error(`[FFMPEG] Crop - Error: ${error.message}`);
                    return reject(error);
                }

                if (stderr) {
                    console.log(`[FFMPEG] Crop - Output: ${stderr}`);
                }

                if (stdout) {
                    console.log(`[FFMPEG] Crop - Stdout: ${stdout}`);
                }

                console.log(
                    `[FFMPEG] Crop - Completed successfully: ${OUTPUT_FILE_PATH}`
                );
                resolve(OUTPUT_FILE_PATH);
            });
        });
    }

    /**
     * Converts a time string in HH:MM:SS format to total seconds.
     * @param {string} hms - Time string in format "HH:MM:SS".
     * @returns {number} Total number of seconds.
     */
    function hmsToSec(time) {
        const [HOURS, MINUTES, SECONDS] = time.split(':').map(Number);
        return HOURS * 3600 + MINUTES * 60 + SECONDS;
    }

    /**
     * Cut video into segments without re-encoding using FFmpeg.
     * Extracts only the chunks that are not marked for removal and concatenates them.
     * @param {string} input Path to the input video file
     * @param {string} output Path for the output video file
     * @param {Array} chunks Array of video chunks with start, end, and remove properties
     */
    async function cutWithoutReencode(input, output, chunks) {
        const KEEP = chunks
            .filter((c) => !c.remove)
            .sort((a, b) => a.start - b.start);
        const TEMP_FILES = [];

        for (let i = 0; i < KEEP.length; i++) {
            const TEMP_FILE = path.join(
                StorageManager.getPermanentSettingsValue(
                    'videoCutterOutputPath',
                    path.join(os.homedir(), 'Downloads')
                ),
                `ebp_temp_part_${i}.mp4`
            );
            TEMP_FILES.push(TEMP_FILE);

            await new Promise((resolve, reject) => {
                const ARGS = [
                    '-y',
                    '-i',
                    input,
                    '-ss',
                    KEEP[i].start.toString(),
                    '-to',
                    KEEP[i].end.toString(),
                    '-c',
                    'copy',
                    TEMP_FILE
                ];

                console.log(
                    `[FFMPEG] Cut without reencode - ${i + 1}/${KEEP.length} - Executing: ${FFMPEG_PATH} ${ARGS.join(' ')}`
                );

                const COMMAND = spawn(FFMPEG_PATH, ARGS);

                let result = '';
                COMMAND.stderr.on('data', (data) => {
                    const STR = data.toString();
                    result += STR;

                    // Log ffmpeg output
                    console.log(
                        `[FFMPEG] Cut without reencode - ${i + 1}/${KEEP.length} - ${STR.trim()}`
                    );

                    const TIME_MATCH = STR.match(/time=(\d+:\d+:\d+\.\d+)/);
                    if (TIME_MATCH) {
                        const currentSec = hmsToSec(TIME_MATCH[1]);
                        const PART_PERCENT = Math.max(
                            0,
                            Math.min(
                                100,
                                (currentSec - KEEP[i].start) /
                                    (KEEP[i].end - KEEP[i].start)
                            )
                        );
                        const PERCENT_PORTION = 100 / KEEP.length;
                        const GLOBAL_PERCENT = Math.round(
                            PERCENT_PORTION * i + PERCENT_PORTION * PART_PERCENT
                        );
                        getMainWindow().webContents.send(
                            'set-manual-cut-percent',
                            GLOBAL_PERCENT
                        );
                    }
                });

                COMMAND.on('close', (code) => {
                    console.log(result);
                    code === 0 ? resolve() : reject(new Error('FFMPEG error'));
                });
            });
        }

        const CONCAT_FILE = path.join(
            StorageManager.getPermanentSettingsValue(
                'videoCutterOutputPath',
                path.join(os.homedir(), 'Downloads')
            ),
            `ebp_temp_concat.txt`
        );
        fs.writeFileSync(
            CONCAT_FILE,
            TEMP_FILES.map((f) => `file '${f}'`).join('\n')
        );

        const CONCAT_COMMAND = `"${FFMPEG_PATH}" -f concat -safe 0 -i "${CONCAT_FILE}" -c copy "${output}"`;
        console.log(`[FFMPEG] - Concat - Executing: ${CONCAT_COMMAND}`);

        try {
            const result = await execAsync(CONCAT_COMMAND);
            console.log(
                `[[FFMPEG] - Concat - Completed successfully: ${output}`
            );
            if (result.stdout) {
                console.log(`[[FFMPEG] - Concat - Stdout: ${result.stdout}`);
            }
            if (result.stderr) {
                console.log(`[[FFMPEG] - Concat - Stderr: ${result.stderr}`);
            }
        } catch (error) {
            console.error(`[[FFMPEG] - Concat - Error: ${error.message}`);
            throw error;
        }

        unlinkSync(CONCAT_FILE);
        TEMP_FILES.forEach((f) => unlinkSync(f));
    }

    /**
     * Checks local YT-DLP version against the latest version available on GitHub
     */
    async function checkYTDLPVersion() {
        try {
            const LOCAL_VERSION = await ytDlpService.getLocalVersion();
            console.info('Local YT-DLP version:', LOCAL_VERSION);

            const LATEST_VERSION = await ytDlpService.getLatestVersion();
            console.info('GitHub YT-DLP version:', LATEST_VERSION);

            if (LOCAL_VERSION !== LATEST_VERSION) {
                console.info(
                    'YT-DLP update available. Will be updated on next download.'
                );
            } else {
                console.info('YT-DLP is up to date.');
            }
        } catch (error) {
            console.warn('Could not check YT-DLP version:', error.message);
        }
    }

    /**
     * Exports game statistics to an Excel file using a predefined template.
     * @param games Array of game objects containing match data to export.
     * @param playerName Name of the player being exported.
     * @param folderPath
     * @returns Promise that resolves when the Excel file has been generated and saved.
     */
    async function exportGamesToExcel(games, playerName, folderPath) {
        const WORKBOOK = new ExcelJS.Workbook();
        await WORKBOOK.xlsx.readFile(path.join(ROOT_PATH, 'template.xlsx'));

        const worksheet = WORKBOOK.getWorksheet(1);

        worksheet.getCell('A1').value = app.getLocale();

        let rowIndew = 3;
        games.forEach((game) => {
            if (
                game.orangeTeam.players.length <= 5 &&
                game.blueTeam.players.length <= 5
            ) {
                rowIndew++;

                worksheet.getCell(`A${rowIndew}`).value = game.mode; // Mode
                worksheet.getCell(`B${rowIndew}`).value =
                    game.orangeTeam.players.length +
                    game.blueTeam.players.length; // Nb players
                worksheet.getCell(`C${rowIndew}`).value = game.map; // Map
                worksheet.getCell(`D${rowIndew}`).value = game.date; // Date
                worksheet.getCell(`E${rowIndew}`).value = game.hour; // Hour
                worksheet.getCell(`F${rowIndew}`).value = `${Math.floor(
                    game.duration / 60
                )}m${game.duration % 60}s`; // Readable duration
                worksheet.getCell(`G${rowIndew}`).value = game.duration; // Duration
                worksheet.getCell(`H${rowIndew}`).value = game.orangeTeam.score; // Orange team score
                worksheet.getCell(`AR${rowIndew}`).value = game.blueTeam.score; // Blue team score

                let letters = [
                    ['I', 'J', 'K', 'L', 'M', 'N', 'O'],
                    ['P', 'Q', 'R', 'S', 'T', 'U', 'V'],
                    ['W', 'X', 'Y', 'Z', 'AA', 'AB', 'AC'],
                    ['AD', 'AE', 'AF', 'AG', 'AH', 'AI', 'AJ'],
                    ['AK', 'AL', 'AM', 'AN', 'AO', 'AP', 'AQ']
                ];
                for (let i = 0; i < game.orangeTeam.players.length; i++) {
                    worksheet.getCell(`${letters[i][0]}${rowIndew}`).value =
                        game.orangeTeam.players[i].name; // Name
                    worksheet.getCell(`${letters[i][1]}${rowIndew}`).value =
                        game.orangeTeam.players[i].kills; // Kills
                    worksheet.getCell(`${letters[i][2]}${rowIndew}`).value =
                        game.orangeTeam.players[i].deaths; // Deaths
                    worksheet.getCell(`${letters[i][3]}${rowIndew}`).value =
                        game.orangeTeam.players[i].assists; // Assists
                    worksheet.getCell(`${letters[i][4]}${rowIndew}`).value =
                        game.orangeTeam.players[i].score; // Score
                    worksheet.getCell(`${letters[i][5]}${rowIndew}`).value =
                        game.orangeTeam.players[i].inflictedDamage; // Inflicted damage
                    worksheet.getCell(`${letters[i][6]}${rowIndew}`).value =
                        game.orangeTeam.players[i].bulletsFiredAccuracy; // Bullets fired accuracy
                }

                letters = [
                    ['AS', 'AT', 'AU', 'AV', 'AW', 'AX', 'AY'],
                    ['AZ', 'BA', 'BB', 'BC', 'BD', 'BE', 'BF'],
                    ['BG', 'BH', 'BI', 'BJ', 'BK', 'BL', 'BM'],
                    ['BN', 'BO', 'BP', 'BQ', 'BR', 'BS', 'BT'],
                    ['BU', 'BV', 'BW', 'BX', 'BY', 'BZ', 'CA']
                ];
                for (let i = 0; i < game.blueTeam.players.length; i++) {
                    worksheet.getCell(`${letters[i][0]}${rowIndew}`).value =
                        game.blueTeam.players[i].name; // Name
                    worksheet.getCell(`${letters[i][1]}${rowIndew}`).value =
                        game.blueTeam.players[i].kills; // Kills
                    worksheet.getCell(`${letters[i][2]}${rowIndew}`).value =
                        game.blueTeam.players[i].deaths; // Deaths
                    worksheet.getCell(`${letters[i][3]}${rowIndew}`).value =
                        game.blueTeam.players[i].assists; // Assists
                    worksheet.getCell(`${letters[i][4]}${rowIndew}`).value =
                        game.blueTeam.players[i].score; // Score
                    worksheet.getCell(`${letters[i][5]}${rowIndew}`).value =
                        game.blueTeam.players[i].inflictedDamage; // Inflicted damage
                    worksheet.getCell(`${letters[i][6]}${rowIndew}`).value =
                        game.blueTeam.players[i].bulletsFiredAccuracy; // Bullets fired accuracy
                }
            }
        });

        const FILE_PATH = path.join(
            folderPath,
            `EBP - ${playerName} (${new Date().getTime()}).xlsx`
        );
        // Save to a new file
        await WORKBOOK.xlsx.writeFile(FILE_PATH);

        return FILE_PATH;
    }

    if (IS_DEV_MODE) {
        app.commandLine.appendSwitch('disable-web-security');
        app.commandLine.appendSwitch(
            'disable-features',
            'IsolateOrigins,site-per-process'
        );
    }

    // Handle deep link on macOS (when app is already open)
    app.on('open-url', (event, url) => {
        event.preventDefault();
        getMainWindow()?.hide();
        handleDeepLink(url);
    });

    // Handle deep link on Windows when app is first launched
    if (process.platform === 'win32') {
        const DEEP_LINK_URL = process.argv.find((arg) =>
            arg.startsWith(`${PROTOCOL_NAME}://`)
        );
        if (DEEP_LINK_URL) {
            // Store URL to handle it after window is ready
            app.once('browser-window-created', () => {
                setTimeout(() => handleDeepLink(DEEP_LINK_URL), 1000);
            });
        }
    }

    /**
     * This method will be called when Electron has finished initialization and is ready to create browser windows.
     */
    app.whenReady().then(() => {
        try {
            watchFolderService.start({ runAnalyzer, runChunkAnalyzer });
        } catch (e) {
            console.error('[watch-folder] failed to start', e);
        }

        if (IS_DEV_MODE) {
            // We wait until the Angular server is ready before creating the window that will contain the HMI.
            waitForHttp(4201).then(() => {
                createWindow(UPDATE_SERVICE);
            });
        } else {
            // Configure auto-updater logger
            /*
            autoUpdater.logger = console;

            // Auto-updater event handlers
            autoUpdater.on('checking-for-update', () => {
                console.log('[AUTO-UPDATER] Checking for update...');
            });

            autoUpdater.on('update-available', (info) => {
                console.log('[AUTO-UPDATER] Update available:', info);
                console.log(
                    '[AUTO-UPDATER] Downloading update automatically...'
                );
            });

            autoUpdater.on('update-not-available', (info) => {
                console.log('[AUTO-UPDATER] Update not available:', info);
            });

            autoUpdater.on('error', (err) => {
                console.error('[AUTO-UPDATER] Error:', err);
            });

            autoUpdater.on('download-progress', (progressObj) => {
                console.log(
                    `[AUTO-UPDATER] Download progress: ${progressObj.percent}%`
                );
            });

            autoUpdater.on('update-downloaded', (info) => {
                console.log('[AUTO-UPDATER] Update downloaded:', info);
                console.log(
                    '[AUTO-UPDATER] Restarting application to install update...'
                );
                // Use default parameters for better compatibility with Squirrel.Windows
                // The update will be installed when the app quits
                autoUpdater.quitAndInstall(true, true);
            });

            // Check for updates every 4 hours
            autoUpdater.checkForUpdatesAndNotify();
            setInterval(
                () => {
                    autoUpdater.checkForUpdatesAndNotify();
                },
                4 * 60 * 60 * 1000
            );
            */

            // We immediately create the window that will contain the HMI.
            createWindow(UPDATE_SERVICE);

            // If a second instance is launched, the first is displayed.
            app.on('second-instance', (event, commandLine) => {
                // Handle deep link on Windows when app is already running
                const DEEP_LINK_URL = commandLine.find((arg) =>
                    arg.startsWith(`${PROTOCOL_NAME}://`)
                );
                console.log(
                    '[INSTANCE] New instance detected, quitting current instance to be replaced'
                );
                destroyMainWindow();
                app.quit();
            });

            app.setLoginItemSettings({
                openAtLogin: true,
                path: app.getPath('exe'),
                args: ['--mode=startup']
            });
        }

        //#region Old deep link

        const OLD_DEEP_LINK =
            StorageManager.getTemporarySettingsValue('deeplink');
        if (OLD_DEEP_LINK) {
            //handleDeepLinkData(OLD_DEEP_LINK.action, OLD_DEEP_LINK.data);
        }

        //#endregion

        // The front-end asks the server to run the Python video analyzer.
        ipcMain.handle('run-analyzer', (event, videoPath, settingsJSON) => {
            runAnalyzer(videoPath);
        });

        // The front-end asks the server to enables/disables debug mode.
        ipcMain.handle('switch-debug-mode', switchDebugMode);

        // The front-end asks the server to show a notification.
        ipcMain.handle(
            'show-notification',
            (event, hideMainWindow, width, height, notificationData) => {
                createFloatingWindow(width, height, notificationData);
                if (hideMainWindow && !IS_DEV_MODE) {
                    hideMainWindow();
                }
            }
        );

        // The front-end asks the server to remove the notification.
        ipcMain.handle('remove-notification', (event, showMainWindow) => {
            deleteFloatingWindow(showMainWindow);
        });

        // The front-end asks the server to return the developer mode state.
        ipcMain.handle('is-dev-mode', () => {
            return IS_DEV_MODE;
        });

        // The front-end asks the server to resize the main frame;
        ipcMain.handle('set-window-size', (event, width, height) => {
            setWindowSize(width, height);
        });

        // The front-end asks the server to return the user's operating system.
        ipcMain.handle('get-os', () => {
            return os.platform();
        });

        // The front-end asks the server to send a socket message to the EBP socket server.
        ipcMain.handle('socket-emit', (event, socket, path, value) => {
            socketEmit(socket, path, value);
        });

        // The front-end asks the server to get available video formats for a URL.
        ipcMain.handle('get-video-formats', async (event, url) => {
            try {
                const YT_DLP_PATH = await ytDlpService.ensureYtDlp();
                const { stdout } = await execAsync(
                    `"${YT_DLP_PATH}" -J "${url}"`,
                    { timeout: 30000 }
                );
                const DATA = JSON.parse(stdout);

                // Filter and format the available formats
                const FORMATS = DATA.formats
                    .filter((f) => f.vcodec !== 'none' && f.height)
                    .map((f) => ({
                        id: f.format_id,
                        label: `${f.height}p${f.fps > 30 ? ' ' + f.fps + 'fps' : ''}`,
                        height: f.height,
                        fps: f.fps || 30
                    }))
                    .sort((a, b) => b.height - a.height || b.fps - a.fps);

                // Deduplicate by label (keep highest quality for each resolution)
                const UNIQUE = [
                    ...new Map(FORMATS.map((f) => [f.label, f])).values()
                ];
                return { success: true, formats: UNIQUE };
            } catch (error) {
                console.error('[get-video-formats] Error:', error.message);
                return { success: false, error: error.message };
            }
        });

        // The front-end asks the server to download a YouTube video.
        ipcMain.handle(
            'download-replay',
            async (event, url, platform, formatId) => {
                getMainWindow().webContents.send('global-message', ' ');
                hideMainWindow();

                // Ensure yt-dlp is available and up-to-date
                const YT_DLP_PATH = ytDlpService.getYtDlpPath();

                const NOTIFICATION_DATA = {
                    leftRounded: true,
                    percent: 0,
                    infinite: true,
                    icon: 'fa-sharp fa-solid fa-clapperboard-play',
                    text: '.view.notification.replay_downloader.fetching',
                    state: 'info'
                };
                createFloatingWindow(
                    500,
                    150,
                    JSON.stringify(NOTIFICATION_DATA)
                );

                let percent = 0;
                exec(
                    `"${YT_DLP_PATH}" --ffmpeg-location "${FFMPEG_PATH}" --get-title ${url}`,
                    (error, stdout, stderr) => {
                        if (error) {
                            console.error(error.message);
                            getMainWindow().webContents.send(
                                'global-message',
                                undefined
                            );
                            getMainWindow().webContents.send(
                                'set-notification-data',
                                {
                                    ...NOTIFICATION_DATA,
                                    ...{
                                        infinite: false,
                                        state: 'error',
                                        text: error.message
                                    }
                                }
                            );
                            setTimeout(() => {
                                deleteFloatingWindow(true);
                            }, 5000);
                            return;
                        }
                        if (stderr) console.error('Stderr :', stderr);

                        const VIDEO_TITLE = stdout.trim();
                        const TIMESTAMP = new Date().getTime();
                        const OUTPUT_DIR =
                            StorageManager.getPermanentSettingsValue(
                                'replayDownloaderOutputPath',
                                path.join(os.homedir(), 'Downloads')
                            );
                        // Clean temp path for yt-dlp (no special characters to avoid FFmpeg/OS issues on Windows)
                        const TEMP_DOWNLOAD_PATH = path.join(
                            OUTPUT_DIR,
                            `ebp_temp_${TIMESTAMP}.mp4`
                        );
                        // Sanitize title: remove characters illegal in Windows filenames (\ / : * ? " < > |)
                        const SANITIZED_TITLE = VIDEO_TITLE.replace(
                            /[\\/:*?"<>|]/g,
                            ''
                        ).trim();
                        // Final path with the video title (rename happens after all processing)
                        const OUTPUT_PATH = path.join(
                            OUTPUT_DIR,
                            `EBP - ${platform} - ${SANITIZED_TITLE} (${TIMESTAMP}).mp4`
                        );

                        let settings = [];
                        switch (platform) {
                            case 'youtube':
                                const YOUTUBE_FORMAT = formatId
                                    ? `${formatId}+bestaudio/best`
                                    : `bestvideo[height<=${DEFAULT_VIDEO_HEIGHT}][fps>30]+bestaudio/best`;
                                settings = [
                                    '--ffmpeg-location',
                                    FFMPEG_PATH,
                                    '-f',
                                    YOUTUBE_FORMAT,
                                    '--merge-output-format',
                                    'mp4',
                                    '-o',
                                    TEMP_DOWNLOAD_PATH,
                                    url
                                ];
                                break;
                            case 'twitch':
                                const TWITCH_FORMAT = formatId
                                    ? formatId
                                    : `best[height<=${DEFAULT_VIDEO_HEIGHT}]`;
                                settings = [
                                    `-f`,
                                    TWITCH_FORMAT,
                                    `-o`,
                                    TEMP_DOWNLOAD_PATH,
                                    url
                                ];
                                break;
                        }

                        const DL = spawn(YT_DLP_PATH, settings);

                        DL.stdout.on('data', (data) => {
                            const MATCH = data
                                .toString()
                                .match(/(\d{1,3}\.\d)%/); // extract the % (eg: 42.3%)
                            if (MATCH) {
                                const PERCENT = Number.parseInt(MATCH[1]);
                                if (
                                    PERCENT > percent ||
                                    (percent != PERCENT && percent == 100)
                                ) {
                                    console.log(PERCENT + '%');
                                    percent = PERCENT;

                                    getMainWindow().webContents.send(
                                        'set-notification-data',
                                        {
                                            ...NOTIFICATION_DATA,
                                            ...{
                                                text: '.view.notification.replay_downloader.downloading',
                                                infinite: PERCENT == 100,
                                                percent: PERCENT,
                                                icon:
                                                    PERCENT == 100
                                                        ? 'fa-sharp fa-solid fa-clapperboard-play'
                                                        : undefined
                                            }
                                        }
                                    );
                                }
                            }
                        });

                        DL.on('close', async (code) => {
                            if (code == 0) {
                                if (fs.existsSync(TEMP_DOWNLOAD_PATH)) {
                                    fs.utimesSync(
                                        TEMP_DOWNLOAD_PATH,
                                        new Date(),
                                        new Date()
                                    );
                                }

                                if (platform === 'twitch') {
                                    await fixForBrowser(TEMP_DOWNLOAD_PATH);
                                }

                                fs.renameSync(TEMP_DOWNLOAD_PATH, OUTPUT_PATH);

                                getMainWindow().webContents.send(
                                    'replay-downloader-success',
                                    OUTPUT_PATH
                                );

                                getMainWindow().webContents.send(
                                    'global-message',
                                    undefined
                                );

                                showMainWindow();

                                getMainWindow().webContents.send(
                                    'set-notification-data',
                                    {
                                        ...NOTIFICATION_DATA,
                                        ...{
                                            text: '.view.notification.replay_downloader.downloaded',
                                            infinite: false,
                                            percent: 100,
                                            icon: 'fa-sharp fa-solid fa-check',
                                            state: 'success'
                                        }
                                    }
                                );

                                setTimeout(() => {
                                    deleteFloatingWindow();
                                }, 5000);
                            }
                        });
                    }
                );
            }
        );

        // The front-end asks the server to open an url in the default browser.
        ipcMain.handle('open-url', (event, url) => {
            console.log(
                `Opening the URL in the user's default browser: ${url}`
            );
            shell.openExternal(url);
        });

        // The front-end asks the server to return the web server port.
        ipcMain.handle('get-express-port', () => {
            return getCurrentPort();
        });

        // The front-end asks the server to return the JWT token content.
        ipcMain.handle('get-jwt-access-token', () => {
            const JWT = StorageManager.permanentSettings['jwt'];
            if (JWT) {
                getMainWindow().webContents.send(
                    'set-jwt-access-token',
                    JWT.access_token
                );
            }

            return undefined;
        });

        // The front-end asks the server to return the project version.
        ipcMain.handle('get-version', () => {
            //#region Binaries versions

            execFile(FFMPEG_PATH, ['-version'], (error, stdout, stderr) => {
                if (error) {
                    console.error('FFMPEG error:\n', error);
                    return;
                }
                console.info('FFMPEG version:\n', stdout);
            });

            checkYTDLPVersion();

            //#endregion

            console.log('Number of openings', NUMBER_OF_OPENINGS);
            console.log({
                current: UPDATE_SERVICE.localVersion,
                last: UPDATE_SERVICE.githubVersion
            });

            return {
                current: UPDATE_SERVICE.localVersion,
                last: UPDATE_SERVICE.githubVersion
            };
        });

        // The front-end asks the server to edit the video cutter output path.
        ipcMain.handle('set-setting', async (event, setting) => {
            const PATH = StorageManager.getPermanentSettingsValue(
                'videoCutterOutputPath',
                path.join(os.homedir(), 'Downloads')
            );

            const { canceled, filePaths } = await dialog.showOpenDialog({
                properties: ['openDirectory'],
                defaultPath: PATH
            });
            if (!canceled && filePaths.length == 1) {
                const SETTINGS = StorageManager.permanentSettings;
                SETTINGS[setting] = filePaths[0];
                StorageManager.permanentSettings = SETTINGS;
                return filePaths[0];
            } else {
                return undefined;
            }
        });

        // The front-end asks the server to return the video cutter output path.
        ipcMain.handle('get-replay-downloader-output-path', () => {
            return StorageManager.getPermanentSettingsValue(
                'replayDownloaderOutputPath',
                path.join(os.homedir(), 'Downloads')
            );
        });

        // The front-end asks the server to return the video cutter output path.
        ipcMain.handle('get-video-cutter-output-path', () => {
            return StorageManager.getPermanentSettingsValue(
                'videoCutterOutputPath',
                path.join(os.homedir(), 'Downloads')
            );
        });

        // The front-end asks the server to return the user's login status.
        ipcMain.handle('get-login-state', () => {
            return session.defaultSession.cookies
                .get({ domain: EBP_DOMAIN })
                .then((cookies) => {
                    const WORDPRESS_COOKIE = cookies.find((c) =>
                        c.name.startsWith('wordpress_logged_in')
                    );
                    if (IS_DEV_MODE) {
                        return true;
                    }
                    return !!WORDPRESS_COOKIE;
                });
        });

        // The front-end asks the server to check JWT token.
        ipcMain.handle('check-jwt-token', () => {
            return new Promise((resolve) => {
                checkJwtToken(getMainWindow, false, () => {
                    resolve();
                });
            });
        });

        // The front-end asks the server to logout.
        ipcMain.handle('logout', () => {
            logout(getMainWindow);
        });

        // The front-end asks the server to save the current language.
        ipcMain.handle('set-language', async (event, language) => {
            const SETTINGS = StorageManager.permanentSettings;
            SETTINGS['language'] = language;
            StorageManager.permanentSettings = SETTINGS;
        });

        ipcMain.handle(
            'set-video-resolution',
            async (event, videoPath, width, height) => {
                const FILE_EXTENSION = videoPath.split('.').pop().toLowerCase();
                const VIDEO_DIR = path.dirname(videoPath);
                const VIDEO_NAME = path.basename(
                    videoPath,
                    `.${FILE_EXTENSION}`
                );
                const OUTPUT_PATH = path.join(
                    VIDEO_DIR,
                    `${VIDEO_NAME} - ${height}p.${FILE_EXTENSION}`
                );

                await changeVideoResolution(
                    videoPath,
                    OUTPUT_PATH,
                    width,
                    height,
                    (percent) => {
                        getMainWindow().webContents.send(
                            'set-upscale-percent',
                            percent
                        );
                    }
                );

                deleteFloatingWindow(false);

                return OUTPUT_PATH;
            }
        );

        // The front-end asks the server to cut a video file manualy edited.
        ipcMain.handle(
            'manual-cut-video-file',
            async (event, videoPath, chunks, notificationData) => {
                if (
                    getMainWindow() &&
                    !getMainWindow().isDestroyed() &&
                    !IS_DEV_MODE
                ) {
                    getMainWindow()?.hide();
                }

                await createFloatingWindow(450, 150, notificationData);
                const FILE_EXTENSION = videoPath.split('.').pop().toLowerCase();
                const VIDEO_DIR = path.dirname(videoPath);
                const VIDEO_NAME = path.basename(
                    videoPath,
                    `.${FILE_EXTENSION}`
                );
                const OUTPUT_FILE_PATH /* string */ = path.join(
                    VIDEO_DIR,
                    `${VIDEO_NAME} - manual cutted.${FILE_EXTENSION}`
                );

                if (fs.existsSync(OUTPUT_FILE_PATH)) {
                    unlinkSync(OUTPUT_FILE_PATH);
                }

                await cutWithoutReencode(videoPath, OUTPUT_FILE_PATH, chunks);

                return OUTPUT_FILE_PATH;
            }
        );

        // The front-end asks the server to ask the user to choose files with the computer explorer.
        ipcMain.handle('open-files', async (event, extensions) => {
            return openFiles(extensions);
        });

        // The front-end asks the server to cut a video file.
        ipcMain.handle(
            'cut-video-files',
            async (event, games, videoPath, customText) => {
                for (const game of games) {
                    await cutVideoFile(game, videoPath, undefined, customText);
                }
                return StorageManager.getPermanentSettingsValue(
                    'videoCutterOutputPath',
                    path.join(os.homedir(), 'Downloads')
                );
            }
        );

        // The front-end asks the server to cut a video file.
        ipcMain.handle(
            'cut-video-file',
            async (event, game, videoPath, customText) => {
                return await cutVideoFile(
                    game,
                    videoPath,
                    undefined,
                    customText
                );
            }
        );

        // The front-end asks the server to open a video file.
        ipcMain.handle('open-file', (event, path) => {
            const COMMAND =
                process.platform === 'win32'
                    ? `start "" "${path}"`
                    : process.platform === 'darwin'
                      ? `open "${path}"`
                      : `xdg-open "${path}"`;

            exec(COMMAND);
        });

        // The front-end asks the server to open a video file.
        ipcMain.handle(
            'upload-game-mini-map',
            (
                event,
                gameIndex,
                game,
                cropPosition,
                margedCropPosition,
                videoPath,
                gameID,
                orangeTeamInfosPosition,
                blueTeamInfosPosition,
                topInfosPosition,
                sortedOrangePlayersNames,
                sortedBluePlayersNames
            ) => {
                // We check that the user is logged in.
                checkJwtToken(getMainWindow, false, (isLoggedIn) => {
                    if (isLoggedIn) {
                        // We cut the video...
                        getMainWindow().webContents.send(
                            'global-message',
                            'view.replay_cutter.cuttingVideo'
                        );
                        cutVideoFile(game, videoPath, 'temp1').then(
                            (cuttedPath) => {
                                // We crop the minimap of the video...
                                getMainWindow().webContents.send(
                                    'global-message',
                                    'view.replay_cutter.croppingMap'
                                );
                                cropVideoFile(
                                    game,
                                    cuttedPath,
                                    margedCropPosition,
                                    'temp2'
                                ).then((croppedMapPath) => {
                                    // We crop the orange team infos of the video...
                                    getMainWindow().webContents.send(
                                        'global-message',
                                        'view.replay_cutter.croppingOrangeInfos'
                                    );
                                    cropVideoFile(
                                        game,
                                        cuttedPath,
                                        orangeTeamInfosPosition,
                                        'temp3'
                                    ).then((croppedOrangeInfosPath) => {
                                        // We crop the blue team infos of the video...
                                        getMainWindow().webContents.send(
                                            'global-message',
                                            'view.replay_cutter.croppingBlueInfos'
                                        );
                                        cropVideoFile(
                                            game,
                                            cuttedPath,
                                            blueTeamInfosPosition,
                                            'temp4'
                                        ).then((croppedBlueInfosPath) => {
                                            // We crop the top infos of the video...
                                            getMainWindow().webContents.send(
                                                'global-message',
                                                'view.replay_cutter.croppingTopInfos'
                                            );
                                            cropVideoFile(
                                                game,
                                                cuttedPath,
                                                topInfosPosition,
                                                'temp5'
                                            ).then((croppedTopInfosPath) => {
                                                // We delete the cut video.
                                                unlinkSync(cuttedPath);

                                                // We retrieve the link allowing the video to be uploaded.
                                                getVideoUploadURLs(
                                                    gameID,
                                                    (videoUploadURLs) => {
                                                        // We upload the minimap video...
                                                        getMainWindow().webContents.send(
                                                            'global-message',
                                                            'view.replay_cutter.uploadingMap'
                                                        );
                                                        uploadVideo(
                                                            videoUploadURLs[0],
                                                            croppedMapPath,
                                                            () => {
                                                                // We delete the cropped video.
                                                                unlinkSync(
                                                                    croppedMapPath
                                                                );

                                                                // We upload the orange infos video...
                                                                getMainWindow().webContents.send(
                                                                    'global-message',
                                                                    'view.replay_cutter.uploadingOrangeInfos'
                                                                );
                                                                uploadVideo(
                                                                    videoUploadURLs[1],
                                                                    croppedOrangeInfosPath,
                                                                    () => {
                                                                        // We delete the cropped video.
                                                                        unlinkSync(
                                                                            croppedOrangeInfosPath
                                                                        );

                                                                        // We upload the blue infos video...
                                                                        getMainWindow().webContents.send(
                                                                            'global-message',
                                                                            'view.replay_cutter.uploadingBlueInfos'
                                                                        );
                                                                        uploadVideo(
                                                                            videoUploadURLs[2],
                                                                            croppedBlueInfosPath,
                                                                            () => {
                                                                                // We delete the cropped video.
                                                                                unlinkSync(
                                                                                    croppedBlueInfosPath
                                                                                );

                                                                                // We upload the top infos video...
                                                                                getMainWindow().webContents.send(
                                                                                    'global-message',
                                                                                    'view.replay_cutter.uploadingTopInfos'
                                                                                );
                                                                                uploadVideo(
                                                                                    videoUploadURLs[3],
                                                                                    croppedTopInfosPath,
                                                                                    () => {
                                                                                        // We delete the cropped video.
                                                                                        unlinkSync(
                                                                                            croppedTopInfosPath
                                                                                        );

                                                                                        setVideoAsUploaded(
                                                                                            gameID,
                                                                                            sortedOrangePlayersNames,
                                                                                            sortedBluePlayersNames,
                                                                                            game._start *
                                                                                                1000,
                                                                                            cropPosition,
                                                                                            margedCropPosition,
                                                                                            () => {
                                                                                                getMainWindow().webContents.send(
                                                                                                    'game-is-uploaded',
                                                                                                    gameIndex
                                                                                                );
                                                                                            }
                                                                                        );
                                                                                    }
                                                                                );
                                                                            }
                                                                        );
                                                                    }
                                                                );
                                                            }
                                                        );
                                                    }
                                                );
                                            });
                                        });
                                    });
                                });
                            }
                        );
                    }
                });
            }
        );

        ipcMain.handle(
            'remove-borders',
            async (event, cropPosition, videoPath) => {
                await removeBorders(videoPath, cropPosition);

                getMainWindow().webContents.send('global-message', undefined);

                deleteFloatingWindow();

                if (getMainWindow() && !getMainWindow().isDestroyed()) {
                    getMainWindow().show();
                    getMainWindow().focus();
                }
            }
        );

        // The front-end asks the server to save console logs to a text file.
        ipcMain.handle('save-console-logs', async (event, logs) => {
            try {
                const FOLDER_PATH = StorageManager.getPermanentSettingsValue(
                    'videoCutterOutputPath',
                    path.join(os.homedir(), 'Downloads')
                );
                const FILE_PATH = path.join(
                    FOLDER_PATH,
                    `EBP - Console Logs - ${new Date().getTime()}.txt`
                );

                let content = `EBP - EVA Battle Plan Tools - Console Logs Export\n`;
                content += `Generated: ${new Date().toISOString()}\n`;
                content += `Total logs: ${logs.length}\n`;
                content += `${'='.repeat(80)}\n\n`;

                logs.forEach((log, index) => {
                    const timestamp = new Date(log.timestamp).toLocaleString();
                    content += `[${index + 1}] ${timestamp} [${log.level.toUpperCase()}] [${log.source}]\n`;
                    content += `${log.message}\n`;
                    content += `${'-'.repeat(40)}\n`;
                });

                fs.writeFileSync(FILE_PATH, content, 'utf-8');

                console.log(`[LOGS] Console logs saved to: ${FILE_PATH}`);
                return FOLDER_PATH;
            } catch (error) {
                console.error(
                    `[LOGS] Error saving console logs: ${error.message}`
                );
                throw error;
            }
        });

        app.on('activate', function () {
            // On macOS it's common to re-create a window in the app when the dock icon is clicked and there are no other windows open.
            if (BrowserWindow.getAllWindows().length === 0) {
                createWindow(UPDATE_SERVICE);
            }
        });
    });

    // Quit when all windows are closed, except on macOS.
    // There, it's common for applications and their menu bar to stay active until the user quits explicitly with Cmd + Q.
    app.on('window-all-closed', function () {
        if (process.platform !== 'darwin') app.quit();
    });
})();
