// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const {
    app,
    BrowserWindow,
    screen,
    ipcMain,
    session,
    dialog,
    shell
} = require('electron');

// When in installation mode, close the application.
if (require('electron-squirrel-startup')) {
    app.quit();
}

const path = require('node:path');
const express = require('express');
const os = require('os');
const { exec, spawn, execSync } = require('child_process');
const { default: getPort } = require('get-port');
const { version } = require('../package.json');
const https = require('https');
const http = require('http');
const fs = require('fs');
const ExcelJS = require('exceljs');
require('./discord-rpc');
const {
    extractPublicPseudoGames,
    extractPrivatePseudoGames
} = require('./puppeteer.js');

//#endregion

let isProd = process.env.NODE_ENV === 'production';
const ROOT_PATH = isProd ? process.resourcesPath : __dirname;

//#region Binaries paths

const FFMPEG_PATH = path.join(
    ROOT_PATH,
    isProd ? 'ffmpeg' : '../binaries/ffmpeg',
    os.platform() + (os.platform() == 'win32' ? '.exe' : '')
);
const YTDLP_PATH = path.join(
    ROOT_PATH,
    isProd ? 'yt-dlp' : '../binaries/yt-dlp',
    os.platform() + (os.platform() == 'win32' ? '.exe' : '')
);

//#endregion

const EBP_DOMAIN = 'evabattleplan.com';
const SETTINGS_PATH = path.join(ROOT_PATH, 'settings.json');
const WINDOW_WIDTH = 900;
const WINDOW_DEV_PANEL_WIDTH = 540;
const WINDOW_HEIGHT = 800;
let mainWindow;
let projectLatestVersion /* string */ = '';

(async () => {
    //#region Express

    // A port is randomly generated from the ports available on the machine.
    const PORT = await getPort();
    const APP = express();
    if (!isProd) {
        APP.set('env', 'development');
    }
    if (isProd) {
        APP.use(express.static(path.join(ROOT_PATH, 'browser')));
    }

    APP.get('/', (request, response) => {
        if (isProd) {
            response.sendFile(path.join(ROOT_PATH, 'browser', 'index.html'));
        } else {
            response.redirect('http://localhost:4200');
        }
    });

    // Allows the application's front-end to access local files on the user's device.
    APP.get('/file', (req, res) => {
        const FILE_PATH = req.query.path;
        if (!FILE_PATH) {
            return res.status(400).send('Missing path');
        }
        res.sendFile(FILE_PATH);
    });

    APP.listen(PORT, () => {
        console.log(`[EXPRESS] Listening on http://localhost:${PORT}.`);
    });

    //#endregion

    //#region Puppeteer

    getProjectLatestVersion((version) => {
        projectLatestVersion = version;
    });

    //#endregion

    /**
     * This function returns the value of a path in the settings.
     * @param {*} name Settings key.
     * @param {*} defaultPath Default value.
     * @returns
     */
    function getOutputPath(name, defaultPath) {
        const SETTINGS = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
        return SETTINGS[name] ?? defaultPath;
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
            getOutputPath(
                'videoCutterOutputPath',
                path.join(os.homedir(), 'Downloads')
            ),
            (fileName
                ? fileName
                : `EBP - ${game.orangeTeam.name} vs ${game.blueTeam.name} - ${
                      game.map
                  } ${customText ? '- ' + customText + ' ' : ''}(${new Date().getTime()})`) +
                `.${EXTENSION}`
        );
        unlinkSync(OUTPUT_FILE_PATH);

        const COMMAND /* string */ = `"${FFMPEG_PATH}" -ss ${
            game._start
        } -i "${videoPath}" -t ${
            game._end - game._start
        } -c copy "${OUTPUT_FILE_PATH}"`;

        return new Promise((resolve, reject) => {
            exec(COMMAND, (error, stdout, stderr) => {
                if (error) return reject(error);
                resolve(OUTPUT_FILE_PATH);
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
        callback
    ) {
        const SETTINGS = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));

        const URL_PARAMS = new URLSearchParams({
            r: 's3_uploaded',
            gameID: gameID
        });

        const OPTIONS = {
            hostname: EBP_DOMAIN,
            port: 443,
            path: `/back/api-tools/?${URL_PARAMS.toString()}`,
            method: 'PUT',
            headers: {
                Authorization: `Bearer ${SETTINGS['jwt'].access_token}`,
                'Content-Type': 'application/json'
            }
        };

        const REQUEST_BODY = JSON.stringify({
            orangePlayersNames: sortedOrangePlayersNames,
            bluePlayersNames: sortedBluePlayersNames,
            gameStart: gameStart
        });

        const REQUEST = https.request(OPTIONS, (res) => {
            // This line This line is essential.
            // Without it, 'end' will never fire.
            res.on('data', () => {});

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

    /**
     * This function allows you to retrieve an upload URL to the EBP S3 server.
     * @param {*} gameID ID of the game to attach the video to.
     * @param {*} callback Callback function.
     */
    function getVideoUploadURLs(gameID, callback) {
        const SETTINGS = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));

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
                Authorization: `Bearer ${SETTINGS['jwt'].access_token}`,
                'Content-Type': 'application/json'
            }
        };

        const REQUEST = https.request(REQUEST_OPTIONS, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                callback(JSON.parse(data));
            });
        });

        REQUEST.on('error', (err) => {
            console.error('Error:', err);
        });

        REQUEST.end();
    }

    /**
     * Safely deletes a file/folder if it exists, with Unicode normalization for proper file path handling.
     * @param path The file/folder path to delete.
     */
    function unlinkSync(path) {
        const NORMALIZED_CUT_PATH = path.normalize('NFC');
        if (fs.existsSync(NORMALIZED_CUT_PATH)) {
            fs.unlinkSync(NORMALIZED_CUT_PATH);
        }
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
            getOutputPath(
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

        return new Promise((resolve, reject) => {
            exec(COMMAND, (error, stdout, stderr) => {
                if (error) return reject(error);
                resolve(OUTPUT_FILE_PATH);
            });
        });
    }

    /**
     * Resize the main window to specified dimensions or fullscreen.
     * Automatically retries if the initial resize fails.
     * @param {number} width Target width (0 for fullscreen width, undefined for default)
     * @param {number} height Target height (0 for fullscreen height, undefined for default)
     */
    function setWindowSize(width, height) {
        const PRIMARY_DISPLAY = screen.getPrimaryDisplay();
        let targetWidth = 0;
        let targetHeight = 0;

        // Reset to default size
        if (width === undefined || height === undefined) {
            targetWidth = Math.min(
                PRIMARY_DISPLAY.workAreaSize.width,
                WINDOW_WIDTH + (!isProd ? WINDOW_DEV_PANEL_WIDTH : 0)
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

        mainWindow.setSize(targetWidth, targetHeight);
        mainWindow.center();

        // Verify the resize was successful and retry if needed
        setTimeout(() => {
            const NEW_SIZE = mainWindow.getSize();
            const SUCCESS =
                NEW_SIZE[0] === targetWidth && NEW_SIZE[1] === targetHeight;
            if (!SUCCESS) {
                setWindowSize(width, height);
            }
        }, 100);
    }

    /**
     * Upscales a video to 1920x1080 resolution using FFmpeg with progress tracking.
     * Sends real-time progress updates to the main window.
     * @param inputPath Path to the source video file to upscale.
     * @param outputPath Path where the upscaled video will be saved.
     * @param callback Function called when the upscaling process is complete.
     */
    function upscaleVideo(
        inputPath /* string */,
        outputPath /* string */,
        callback /* Function */
    ) {
        if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
        }

        const FFMPEG = spawn(FFMPEG_PATH, [
            '-i',
            inputPath,
            '-vf',
            'scale=1920:1080:flags=lanczos',
            '-c:v',
            'libx264',
            '-preset',
            'ultrafast',
            '-crf',
            '18',
            '-c:a',
            'copy',
            outputPath
        ]);

        let duration = 0;

        // Retrieving duration + progress information
        FFMPEG.stderr.on('data', (data) => {
            const DATA = data.toString();

            // Total duration
            const DURATION_MATCH = DATA.match(
                /Duration: (\d+):(\d+):(\d+\.\d+)/
            );
            if (DURATION_MATCH) {
                const HOURS = parseInt(DURATION_MATCH[1]);
                const MINUTES = parseInt(DURATION_MATCH[2]);
                const SECONDES = parseFloat(DURATION_MATCH[3]);
                duration = HOURS * 3600 + MINUTES * 60 + SECONDES;
            }

            // Progress
            const TIME_MATCH = DATA.match(/time=(\d+):(\d+):(\d+\.\d+)/);
            if (TIME_MATCH && duration > 0) {
                const HOURS = parseInt(TIME_MATCH[1]);
                const MINUTES = parseInt(TIME_MATCH[2]);
                const SECONDES = parseFloat(TIME_MATCH[3]);
                const CURRENT = HOURS * 3600 + MINUTES * 60 + SECONDES;

                const PERCENT = Math.ceil((CURRENT / duration) * 100);
                mainWindow.webContents.send(
                    'global-message',
                    'view.replay_cutter.upscalePercent',
                    {
                        percent: PERCENT
                    }
                );
            }
        });

        FFMPEG.on('close', (code) => {
            callback();
        });
    }

    /**
     * This function retrieves the number of the latest published version of the project.
     * @param {Function} callback Callback function.
     */
    function getProjectLatestVersion(callback) {
        const OPTIONS = {
            hostname: 'api.github.com',
            path: '/repos/heyheychicken/EBP-EVA-Battle-Plan-Tools/releases/latest',
            method: 'GET',
            headers: { 'User-Agent': '' }
        };

        const REQUEST = https.request(OPTIONS, (res) => {
            let data = '';

            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
                try {
                    const DATA = JSON.parse(data);
                    callback(DATA.tag_name);
                } catch (err) {}
            });
        });

        REQUEST.on('error', (err) => callback(err));
        REQUEST.end();
    }

    /**
     * This function retrieves the resolution of a video file.
     * @param {string} videoPath Path of the video file.
     * @param {Function} callback Callback function with width and height information.
     */
    function getVideoResolution(videoPath, callback) {
        const COMMAND = `${FFMPEG_PATH} -i "${videoPath}" 2>&1`;
        exec(COMMAND, (err, stdout, stderr) => {
            const OUTPUT = stderr || stdout;
            const RESOLUTION = OUTPUT.match(/, (\d+)x(\d+)[ ,]/);
            if (!RESOLUTION) {
                console.error('Info not found');
                callback(0, 0);
            } else {
                const WIDTH = +RESOLUTION[1];
                const HEIGHT = +RESOLUTION[2];
                callback(WIDTH, HEIGHT);
            }
        });
    }

    /**
     * This function indicates whether the user's access token exists and is still valid.
     * @returns {boolean}
     */
    function isJwtAccessTokenOk() {
        const SETTINGS = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
        if (SETTINGS['jwt']) {
            if (Date.now() < SETTINGS['jwt'].access_expires_in) {
                return true;
            }
        }
        return false;
    }

    /**
     * This function indicates whether the user's refresh token exists and is still valid.
     * @returns {boolean}
     */
    function isJwtRefreshTokenOk() {
        const SETTINGS = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
        if (SETTINGS['jwt']) {
            if (Date.now() < SETTINGS['jwt'].refresh_expires_in) {
                return true;
            }
        }
        return false;
    }

    /**
     * This function checks that the user is logged in with a valid token.
     * @param {Function} callback Callback function with loggin in information.
     * @param {boolean} justLoggedFromWordpress
     */
    async function checkJwtToken(callback, justLoggedFromWordpress = false) {
        if (isJwtAccessTokenOk()) {
            if (callback) {
                callback(true);
            }
        } else {
            const IS_JWT_REFRESH_TOKEN_OK = isJwtRefreshTokenOk();
            if (IS_JWT_REFRESH_TOKEN_OK || justLoggedFromWordpress) {
                const SETTINGS = JSON.parse(
                    fs.readFileSync(SETTINGS_PATH, 'utf-8')
                );

                // We retrieve cookies from the main window.
                const COOKIES =
                    await mainWindow.webContents.session.cookies.get({
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
                            fs.writeFileSync(
                                SETTINGS_PATH,
                                JSON.stringify(SETTINGS, null, 2),
                                'utf-8'
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
     * Cut video into segments without re-encoding using FFmpeg.
     * Extracts only the chunks that are not marked for removal and concatenates them.
     * @param {string} input Path to the input video file
     * @param {string} output Path for the output video file
     * @param {Array} chunks Array of video chunks with start, end, and remove properties
     */
    function cutWithoutReencode(input, output, chunks) {
        const KEEP = chunks
            .filter((c) => !c.remove)
            .sort((a, b) => a.start - b.start);
        const TEMP_FILES = [];

        KEEP.forEach((c, i) => {
            const TEMP_FILE = `/tmp/part_${i}.mp4`;
            TEMP_FILES.push(TEMP_FILE);
            execSync(
                `"${FFMPEG_PATH}" -i "${input}" -ss ${c.start} -to ${c.end} -c copy "${TEMP_FILE}"`
            );
        });

        // Create concat file
        const CONCAT_FILE = '/tmp/concat.txt';
        const CONCAT_CONTENT = TEMP_FILES.map((f) => `file '${f}'`).join('\n');
        fs.writeFileSync(CONCAT_FILE, CONCAT_CONTENT);

        // Concatenate
        execSync(
            `"${FFMPEG_PATH}" -f concat -safe 0 -i "${CONCAT_FILE}" -c copy "${output}"`
        );

        // Clean
        fs.unlinkSync(CONCAT_FILE);
        TEMP_FILES.forEach((file) => fs.unlinkSync(file));
    }

    /**
     * This function initializes the front-end.
     */
    function createWindow() {
        const PRIMARY_DISPLAY = screen.getPrimaryDisplay();
        mainWindow = new BrowserWindow({
            width: Math.min(
                PRIMARY_DISPLAY.workAreaSize.width,
                WINDOW_WIDTH + (!isProd ? WINDOW_DEV_PANEL_WIDTH : 0)
            ),
            height: Math.min(
                PRIMARY_DISPLAY.workAreaSize.height,
                WINDOW_HEIGHT
            ),
            resizable: false,
            contextIsolation: true,
            webPreferences: {
                preload: isProd
                    ? MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY
                    : path.join(__dirname, 'preload.js')
            }
        });

        const HOME_URL = `http://localhost:${isProd ? PORT : '4200'}/`;

        mainWindow.webContents.on('did-navigate', async (event, url) => {
            if (url === HOME_URL) {
                checkJwtToken(undefined, true);
            }
        });

        // Hides the menu bar displayed in the top left corner on Windows.
        mainWindow.setMenuBarVisibility(false);

        if (!isProd) {
            mainWindow.webContents.openDevTools();
        }

        checkJwtToken((isLoggedIn) => {
            // Loads the application's index.html.
            mainWindow.loadURL(
                isLoggedIn
                    ? HOME_URL
                    : `https://${EBP_DOMAIN}/${app.getLocale()}/login?app=cutter&redirect_uri=${encodeURIComponent(
                          HOME_URL
                      )}`
            );
        });
    }

    /**
     * Exports game statistics to an Excel file using a predefined template.
     * @param games Array of game objects containing match data to export.
     * @param playerName Name of the player being exported.
     * @returns Promise that resolves when the Excel file has been generated and saved.
     */
    async function exportGamesToExcel(games, playerName) {
        const WORKBOOK = new ExcelJS.Workbook();
        await WORKBOOK.xlsx.readFile(path.join(ROOT_PATH, 'template.xlsx'));

        const worksheet = WORKBOOK.getWorksheet(1);

        worksheet.getCell('A1').value = app.getLocale();

        let rowIndew = 3;
        games.forEach((game) => {
            rowIndew++;

            worksheet.getCell(`A${rowIndew}`).value = game.mode; // Mode
            worksheet.getCell(`B${rowIndew}`).value =
                game.orangeTeam.players.length + game.blueTeam.players.length; // Nb players
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
        });

        const FILE_PATH = path.join(
            getOutputPath(
                'gameHistoryOutputPath',
                path.join(os.homedir(), 'Downloads')
            ),
            `EBP - ${playerName} (${new Date().getTime()}).xlsx`
        );
        // Save to a new file
        await WORKBOOK.xlsx.writeFile(FILE_PATH);

        return FILE_PATH;
    }

    if (!isProd) {
        app.commandLine.appendSwitch('disable-web-security');
        app.commandLine.appendSwitch(
            'disable-features',
            'IsolateOrigins,site-per-process'
        );
    }

    /**
     * This method will be called when Electron has finished initialization and is ready to create browser windows.
     */
    app.whenReady().then(() => {
        if (isProd) {
            // If we are in production, we immediately create the window that will contain the HMI.
            createWindow();
        } else {
            // If we are in dev, we wait until the Angular server is ready before creating the window that will contain the HMI.
            waitForHttp(4200).then(() => {
                createWindow();
            });
        }

        // The front-end asks the server to enables/disables debug mode.
        ipcMain.handle('debug-mode', async () => {
            isProd = !isProd;
            if (isProd) {
                mainWindow.webContents.closeDevTools();
            } else {
                mainWindow.webContents.openDevTools();
            }

            const PRIMARY_DISPLAY = screen.getPrimaryDisplay();
            mainWindow.setResizable(true);
            const DESIRED_WIDTH =
                WINDOW_WIDTH + (!isProd ? WINDOW_DEV_PANEL_WIDTH : 0);
            mainWindow.setSize(
                Math.min(PRIMARY_DISPLAY.workAreaSize.width, DESIRED_WIDTH),
                Math.min(PRIMARY_DISPLAY.workAreaSize.height, WINDOW_HEIGHT)
            );
            mainWindow.setResizable(false);
        });

        // The front-end asks the server to return the developer mode state.
        ipcMain.handle('is-dev-mode', () => {
            return !isProd;
        });

        // The front-end asks the server to resize the main frame;
        ipcMain.handle('set-window-size', (event, width, height) => {
            setWindowSize(width, height);
        });

        // The front-end asks the server to return the user's operating system.
        ipcMain.handle('get-os', () => {
            return os.platform();
        });

        // The front-end asks the server to download a YouTube video.
        ipcMain.handle('download-replay', (event, url, platform) => {
            let percent = 0;
            // We get the title of the video.
            exec(
                `${YTDLP_PATH} --ffmpeg-location ${FFMPEG_PATH} --get-title ${url}`,
                (error, stdout, stderr) => {
                    if (error) {
                        console.error(error.message);
                        mainWindow.webContents.send(
                            'replay-downloader-error',
                            error.message.split('ERROR: ')[1]
                        );
                        return;
                    }
                    if (stderr) console.error('Stderr :', stderr);

                    const VIDEO_TITLE = stdout.trim();
                    const OUTPUT_PATH = path.join(
                        getOutputPath(
                            'replayDownloaderOutputPath',
                            path.join(os.homedir(), 'Downloads')
                        ),
                        `EBP - ${platform} - ${VIDEO_TITLE} (${new Date().getTime()}).mp4`
                    );

                    let settings = [];
                    switch (platform) {
                        case 'youtube':
                            settings = [
                                `--ffmpeg-location`,
                                FFMPEG_PATH,
                                `-f`,
                                `bv[height<=1080]+ba`,
                                `--merge-output-format`,
                                `mp4`,
                                `-o`,
                                OUTPUT_PATH,
                                url
                            ];
                            break;
                        case 'twitch':
                            settings = [
                                `-f`,
                                `best[height<=1080]`,
                                `-o`,
                                OUTPUT_PATH,
                                url
                            ];
                            break;
                    }

                    const DL = spawn(YTDLP_PATH, settings);

                    DL.stdout.on('data', (data) => {
                        const MATCH = data.toString().match(/(\d{1,3}\.\d)%/); // extract the % (eg: 42.3%)
                        if (MATCH) {
                            const PERCENT = parseInt(MATCH[1]);
                            if (PERCENT > percent) {
                                percent = PERCENT;
                                mainWindow.webContents.send(
                                    'replay-downloader-percent',
                                    PERCENT
                                );
                            }
                        }
                    });

                    DL.stderr.on('data', (data) => {
                        console.error(data.toString());
                        mainWindow.webContents.send(
                            'replay-downloader-error',
                            data.toString().split('ERROR: ')[1]
                        );
                    });

                    DL.on('close', (code) => {
                        if (code == 0) {
                            const NORMALIZED_OUTPUT_PATH =
                                OUTPUT_PATH.normalize('NFC');
                            if (fs.existsSync(NORMALIZED_OUTPUT_PATH)) {
                                fs.utimesSync(
                                    NORMALIZED_OUTPUT_PATH,
                                    new Date(),
                                    new Date()
                                );
                            }
                            mainWindow.webContents.send(
                                'replay-downloader-success',
                                OUTPUT_PATH
                            );
                        }
                    });
                }
            );
        });

        // The front-end asks the server to open an url in the default browser.
        ipcMain.handle('open-url', (event, url) => {
            shell.openExternal(url);
        });

        // The front-end asks the server to return the web server port.
        ipcMain.handle('get-express-port', () => {
            return PORT;
        });

        // The front-end asks the server to return the JWT token content.
        ipcMain.handle('get-jwt-access-token', () => {
            const SETTINGS = JSON.parse(
                fs.readFileSync(SETTINGS_PATH, 'utf-8')
            );

            if (SETTINGS['jwt']) {
                return SETTINGS['jwt'].access_token;
            }

            return undefined;
        });

        // The front-end asks the server to return the project version.
        ipcMain.handle('get-version', () => {
            return {
                current: version,
                last: projectLatestVersion
            };
        });

        // The front-end asks the server to edit the video cutter output path.
        ipcMain.handle('set-setting', async (event, setting) => {
            const PATH = getOutputPath(
                'videoCutterOutputPath',
                path.join(os.homedir(), 'Downloads')
            );

            const { canceled, filePaths } = await dialog.showOpenDialog({
                properties: ['openDirectory'],
                defaultPath: PATH
            });
            if (!canceled && filePaths.length == 1) {
                const SETTINGS = JSON.parse(
                    fs.readFileSync(SETTINGS_PATH, 'utf-8')
                );
                SETTINGS[setting] = filePaths[0];

                fs.writeFileSync(
                    SETTINGS_PATH,
                    JSON.stringify(SETTINGS, null, 2),
                    'utf-8'
                );
                return filePaths[0];
            } else {
                return undefined;
            }
        });

        // The front-end asks the server to return the game-history output path.
        ipcMain.handle('get-game-history-output-path', () => {
            return getOutputPath(
                'gameHistoryOutputPath',
                path.join(os.homedir(), 'Downloads')
            );
        });

        // The front-end asks the server to return the video cutter output path.
        ipcMain.handle('get-replay-downloader-output-path', () => {
            return getOutputPath(
                'replayDownloaderOutputPath',
                path.join(os.homedir(), 'Downloads')
            );
        });

        // The front-end asks the server to return the video cutter output path.
        ipcMain.handle('get-video-cutter-output-path', () => {
            return getOutputPath(
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
                    if (!isProd) {
                        return true;
                    }
                    return !!WORDPRESS_COOKIE;
                });
        });

        // The front-end asks the server to check JWT token.
        ipcMain.handle('check-jwt-token', () => {
            return new Promise((resolve) => {
                checkJwtToken(() => {
                    resolve();
                });
            });
        });

        // The front-end asks the server to logout.
        ipcMain.handle('logout', () => {
            const SESSION = session.defaultSession;

            fs.writeFileSync(SETTINGS_PATH, '{}', 'utf-8');

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
                mainWindow.loadURL(
                    `https://${EBP_DOMAIN}/${app.getLocale()}/login?app=cutter&redirect_uri=${encodeURIComponent(
                        'http://localhost:' + PORT
                    )}`
                );
            });
        });

        // The front-end asks the server to extract the public player games.
        ipcMain.handle(
            'extract-private-pseudo-games',
            (event, nbPages, seasonIndex, skip, timeToWait) => {
                extractPrivatePseudoGames(
                    nbPages,
                    seasonIndex,
                    skip,
                    timeToWait,
                    dialog,
                    mainWindow,
                    async (games) => {
                        if (games.length > 0) {
                            const FILE_PATH = await exportGamesToExcel(
                                games,
                                'private'
                            );
                            mainWindow.webContents.send(
                                'games-are-exported',
                                FILE_PATH
                            );
                        } else {
                            mainWindow.webContents.send(
                                'games-are-exported',
                                undefined
                            );
                        }
                    }
                );
            }
        );

        // The front-end asks the server to extract the public player games.
        ipcMain.handle(
            'extract-public-pseudo-games',
            (event, tag, nbPages, seasonIndex, skip, timeToWait) => {
                if (tag) {
                    extractPublicPseudoGames(
                        tag,
                        nbPages,
                        seasonIndex,
                        skip,
                        timeToWait,
                        dialog,
                        mainWindow,
                        async (games) => {
                            if (games.length > 0) {
                                const FILE_PATH = await exportGamesToExcel(
                                    games,
                                    tag.split('#')[0]
                                );
                                mainWindow.webContents.send(
                                    'games-are-exported',
                                    FILE_PATH
                                );
                            } else {
                                mainWindow.webContents.send(
                                    'games-are-exported',
                                    undefined
                                );
                            }
                        }
                    );
                }
            }
        );

        // The front-end asks the server to cut a video file manualy edited.
        ipcMain.handle(
            'manual-cut-video-file',
            async (event, videoPath, chunks) => {
                const SPLIT = videoPath.split('.');
                const FILE_EXTENSION = SPLIT[SPLIT.length - 1];
                const OUTPUT_FILE_PATH /* string */ = path.join(
                    getOutputPath(
                        'videoCutterOutputPath',
                        path.join(os.homedir(), 'Downloads')
                    ),
                    `temp.${FILE_EXTENSION}`
                );
                unlinkSync(OUTPUT_FILE_PATH);

                cutWithoutReencode(videoPath, OUTPUT_FILE_PATH, chunks);

                console.log(OUTPUT_FILE_PATH);
                mainWindow.webContents.send('set-video-file', OUTPUT_FILE_PATH);
            }
        );

        // The front-end asks the server to ask the user to choose a video file.
        ipcMain.handle('open-video-file', async (event, videoPath) => {
            // If the user indicates that they want to upscale their video source...
            if (videoPath) {
                const OUTPUT_FOLDER_PATH = getOutputPath(
                    'videoCutterOutputPath',
                    path.join(os.homedir(), 'Downloads')
                );
                const SPLIT = videoPath.split('.');
                const FILE_EXTENSION = SPLIT[SPLIT.length - 1];
                const OUTPUT_PATH = path.join(
                    OUTPUT_FOLDER_PATH,
                    `ebp_tools_temp.${FILE_EXTENSION}`
                );
                upscaleVideo(videoPath, OUTPUT_PATH, () => {
                    mainWindow.webContents.send('set-video-file', OUTPUT_PATH);
                });
            } else {
                const { canceled, filePaths } = await dialog.showOpenDialog({
                    properties: ['openFile'],
                    filters: [{ name: 'EVA video', extensions: ['mp4', 'mkv'] }]
                });
                if (canceled) {
                    mainWindow.webContents.send('set-video-file', '');
                    mainWindow.webContents.send(
                        'error',
                        'view.replay_cutter.noFilesSelected'
                    );
                } else {
                    // Check that the video file resolution is correct.
                    getVideoResolution(
                        filePaths[0],
                        (width, height, duration) => {
                            const EXPECTED_HEIGHT /* number */ = 1080;
                            if (height == EXPECTED_HEIGHT) {
                                mainWindow.webContents.send(
                                    'set-video-file',
                                    filePaths[0]
                                );
                            } else if (height == 720) {
                                mainWindow.webContents.send(
                                    'replay_cutter_upscale',
                                    filePaths[0]
                                );
                            } else {
                                mainWindow.webContents.send(
                                    'error',
                                    'view.replay_cutter.wrongResolution',
                                    {
                                        expectedHeight: EXPECTED_HEIGHT,
                                        currentWidth: width,
                                        currentHeight: height
                                    }
                                );
                                mainWindow.webContents.send(
                                    'set-video-file',
                                    ''
                                );
                            }
                        }
                    );
                }
            }
        });

        // The front-end asks the server to cut a video file.
        ipcMain.handle(
            'cut-video-files',
            async (event, games, videoPath, customText) => {
                for (const game of games) {
                    await cutVideoFile(game, videoPath, undefined, customText);
                }
                return getOutputPath(
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
                game,
                cropPosition,
                videoPath,
                gameID,
                orangeTeamInfosPosition,
                blueTeamInfosPosition,
                topInfosPosition,
                sortedOrangePlayersNames,
                sortedBluePlayersNames
            ) => {
                // We check that the user is logged in.
                checkJwtToken((isLoggedIn) => {
                    if (isLoggedIn) {
                        // We cut the video...
                        mainWindow.webContents.send(
                            'global-message',
                            'view.replay_cutter.cuttingVideo'
                        );
                        cutVideoFile(game, videoPath, 'temp1').then(
                            (cuttedPath) => {
                                // We crop the minimap of the video...
                                mainWindow.webContents.send(
                                    'global-message',
                                    'view.replay_cutter.croppingMap'
                                );
                                cropVideoFile(
                                    game,
                                    cuttedPath,
                                    cropPosition,
                                    'temp2'
                                ).then((croppedMapPath) => {
                                    // We crop the orange team infos of the video...
                                    mainWindow.webContents.send(
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
                                        mainWindow.webContents.send(
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
                                            mainWindow.webContents.send(
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
                                                        mainWindow.webContents.send(
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
                                                                mainWindow.webContents.send(
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
                                                                        mainWindow.webContents.send(
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
                                                                                mainWindow.webContents.send(
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
                                                                                            () => {
                                                                                                mainWindow.webContents.send(
                                                                                                    'game-is-uploaded'
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

        app.on('activate', function () {
            // On macOS it's common to re-create a window in the app when the dock icon is clicked and there are no other windows open.
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
    });

    // Quit when all windows are closed, except on macOS.
    // There, it's common for applications and their menu bar to stay active until the user quits explicitly with Cmd + Q.
    app.on('window-all-closed', function () {
        if (process.platform !== 'darwin') app.quit();
    });
})();
