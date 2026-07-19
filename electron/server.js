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
    fixForBrowser,
    remuxToForAnalysis,
    appendImageTail,
    renderTeamScoreImage
} = require('./services/video-service');
const { unlinkSync } = require('./services/global-service');
const UpdateService = require('./services/update-service');
const ytDlpService = require('./services/ytdlp-service');
const denoService = require('./services/deno-service');
const watchFolderService = require('./services/watch-folder-service');
const arenaModeService = require('./services/arena-mode-service');
const arenaCaptureService = require('./services/arena-capture-service');
const arenaPipelineService = require('./services/arena-pipeline-service');
const arenaUploaderService = require('./services/arena-uploader-service');
const arenaRosterService = require('./services/arena-roster-service');
// Rosters de la phase 2 mode salle : mock fixe pour l'instant, à remplacer
// par l'API locale EVA (cf. arena-roster-service).
arenaUploaderService.setRosterProvider(arenaRosterService.getRosters);
// Mise à jour ordonnée par un admin (via la réponse du heartbeat) : arrêt
// propre de la captation (segment finalisé) puis update forcée sans dialogue —
// l'installeur Squirrel relance l'app, qui reprend tout au boot.
arenaModeService.setUpdateHandler(() => {
    arenaCaptureService.stopCapture();
    UPDATE_SERVICE.forceUpdate();
});
const {
    NotAuthenticatedError,
    ApiError
} = require('./services/tools-api-client');

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

        switch (action) {
            case 'openFolder':
                openDirectory((directoryPath) => {
                    socketEmit(data.socket, 'openFolder', directoryPath);
                });
                break;
            case 'importGamesFromExcel':
                const EXCEL_FILES = await openFiles(['xlsx']);
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

                            setTimeout(() => {
                                deleteFloatingWindow();
                            }, 5000);
                        } else {
                            deleteFloatingWindow();
                        }
                    });
                } else {
                    console.log(
                        `Error: ${FILES_TO_ENCODE_PATHS.length} file${FILES_TO_ENCODE_PATHS.length > 1 ? 's' : ''} selected.`
                    );
                }
                break;
            case 'reencodeVideoFile': {
                // Réencode une vidéo sélectionnée comme on le fait après un téléchargement
                // Twitch (remux `fixForBrowser`), pour la rendre analysable par Tools.
                const FILES_TO_FIX = await openFiles(data.filesExtensions);
                if (FILES_TO_FIX.length == 1) {
                    const NOTIFICATION_DATA = {
                        percent: 0,
                        leftRounded: true,
                        infinite: true,
                        icon: '',
                        text: '.common.encoding',
                        state: 'info'
                    };
                    await createFloatingWindow(
                        450,
                        150,
                        JSON.stringify(NOTIFICATION_DATA)
                    );

                    try {
                        await fixForBrowser(FILES_TO_FIX[0]);

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

                        setTimeout(() => {
                            deleteFloatingWindow();
                        }, 5000);
                    } catch (error) {
                        console.error(
                            '[REENCODE] fixForBrowser failed:',
                            error
                        );
                        deleteFloatingWindow();
                    }
                }
                break;
            }
            case 'exportHudVideo': {
                // Export "vue HUD-only" (HUD en haut + minimap en dessous) demandé depuis le
                // lecteur web. On reçoit l'URL S3 présignée de la vidéo source (lue directement
                // par ffmpeg, pas de ré-auth), les deux bbox en fractions [x1,y1,x2,y2] de la
                // frame source et la largeur pixel native `vw`. On recadre les deux régions, on
                // les scale à une largeur commune puis on les empile (vstack) — même filtre que
                // l'aperçu écran. L'encodage tourne ici, sur la machine de l'utilisateur.
                const isBbox = (b) =>
                    Array.isArray(b) &&
                    b.length === 4 &&
                    b.every((n) => typeof n === 'number' && n >= 0 && n <= 1) &&
                    b[2] > b[0] &&
                    b[3] > b[1];
                if (
                    typeof data.url !== 'string' ||
                    !isBbox(data.hud) ||
                    !isBbox(data.mm) ||
                    typeof data.vw !== 'number' ||
                    data.vw <= 0
                ) {
                    console.error('[HUD-EXPORT] Invalid payload', data);
                    break;
                }

                const { canceled, filePath: OUTPUT_FILE_PATH } =
                    await dialog.showSaveDialog({
                        defaultPath: path.join(
                            StorageManager.getPermanentSettingsValue(
                                'videoCutterOutputPath',
                                path.join(os.homedir(), 'Downloads')
                            ),
                            data.filename || 'EBP-hud.mp4'
                        ),
                        filters: [{ name: 'MP4', extensions: ['mp4'] }]
                    });
                if (canceled || !OUTPUT_FILE_PATH) {
                    break;
                }

                // Largeur de sortie commune = plus large des deux crops, plafonnée à 720p (1280 px)
                // et arrondie au pair (requis par yuv420p). Crops exprimés en `iw`/`ih` ; seul `W`
                // a besoin d'être concret car `scale` ne peut pas référencer une autre branche.
                const MAX_OUTPUT_WIDTH = 1280;
                const RAW_W =
                    Math.max(data.hud[2] - data.hud[0], data.mm[2] - data.mm[0]) *
                    data.vw;
                const W = Math.max(
                    2,
                    Math.round(Math.min(RAW_W, MAX_OUTPUT_WIDTH) / 2) * 2
                );
                const crop = (b) =>
                    `crop=iw*${(b[2] - b[0]).toFixed(6)}:ih*${(b[3] - b[1]).toFixed(6)}:iw*${b[0].toFixed(6)}:ih*${b[1].toFixed(6)}`;
                const FILTER =
                    `[0:v]${crop(data.hud)},scale=${W}:-2,setsar=1[hud];` +
                    `[0:v]${crop(data.mm)},scale=${W}:-2,setsar=1[mm];` +
                    `[hud][mm]vstack=inputs=2[v]`;

                const NOTIFICATION_DATA = {
                    percent: 0,
                    leftRounded: true,
                    infinite: false,
                    icon: '',
                    text: '.common.encoding',
                    state: 'info'
                };
                await createFloatingWindow(
                    450,
                    150,
                    JSON.stringify(NOTIFICATION_DATA)
                );

                // Durée pour la progression (ffmpeg lit l'URL présignée directement). En cas
                // d'échec de sondage, on retombe sur une barre indéterminée.
                let DURATION = 0;
                try {
                    DURATION = await getVideoDuration(data.url);
                } catch (error) {
                    console.warn('[HUD-EXPORT] duration probe failed:', error);
                }

                if (fs.existsSync(OUTPUT_FILE_PATH)) {
                    unlinkSync(OUTPUT_FILE_PATH);
                }

                const ARGS = [
                    '-y',
                    '-i',
                    data.url,
                    '-filter_complex',
                    FILTER,
                    '-map',
                    '[v]',
                    '-map',
                    '0:a?',
                    '-c:v',
                    'libx264',
                    '-crf',
                    '20',
                    '-pix_fmt',
                    'yuv420p',
                    '-c:a',
                    'aac',
                    OUTPUT_FILE_PATH
                ];

                console.log('[FFMPEG] Exporting HUD view...');
                const COMMAND = spawn(FFMPEG_PATH, ARGS);

                let ffmpegStderr = '';
                COMMAND.stderr.on('data', (chunk) => {
                    const STR = chunk.toString();
                    ffmpegStderr += STR;

                    const TIME_MATCH = STR.match(/time=(\d+:\d+:\d+\.\d+)/);
                    if (TIME_MATCH && DURATION > 0) {
                        const [h, m, s] = TIME_MATCH[1].split(':');
                        const CURRENT = +h * 3600 + +m * 60 + parseFloat(s);
                        const PERCENT = Math.min(
                            100,
                            Math.round((CURRENT / DURATION) * 100)
                        );
                        getMainWindow().webContents.send('set-notification-data', {
                            ...NOTIFICATION_DATA,
                            ...{ percent: PERCENT, infinite: DURATION <= 0 }
                        });
                    }
                });

                COMMAND.on('error', (error) => {
                    console.error('[HUD-EXPORT] ffmpeg spawn error:', error);
                    deleteFloatingWindow();
                });

                COMMAND.on('close', (code) => {
                    if (code === 0) {
                        console.log('[FFMPEG] HUD view exported.');
                        getMainWindow().webContents.send('set-notification-data', {
                            percent: 100,
                            leftRounded: true,
                            infinite: false,
                            icon: 'fa-sharp fa-solid fa-check',
                            text: '.common.encoded',
                            state: 'success'
                        });
                        // Ouvre le dossier de destination avec le fichier sélectionné.
                        shell.showItemInFolder(OUTPUT_FILE_PATH);
                        setTimeout(() => {
                            deleteFloatingWindow();
                        }, 5000);
                    } else {
                        console.error(
                            `[HUD-EXPORT] ffmpeg exited with code ${code}: ${ffmpegStderr.trim()}`
                        );
                        deleteFloatingWindow();
                    }
                });
                break;
            }
            case 'analyzeVideoFile':
                const FILES_PATHS = await openFiles(data.filesExtensions, true);
                if (FILES_PATHS.length > 0) {
                    await ingestFilesForAnalysis(FILES_PATHS, data);
                } else {
                    socketEmit(data.socket, 'analyzeVideoFileGames', {
                        type: 'length',
                        value: 0
                    });
                }
                break;
            case 'analyzeVideoUrl': {
                const VIDEO_URL =
                    typeof data.url === 'string' ? data.url.trim() : '';
                const PLATFORM = isYouTubeUrl(VIDEO_URL)
                    ? 'youtube'
                    : isTwitchUrl(VIDEO_URL)
                      ? 'twitch'
                      : undefined;
                if (!PLATFORM) {
                    socketEmit(data.socket, 'analyzeVideoFileGames', {
                        type: 'unavailable'
                    });
                    break;
                }

                const NOTIFICATION_DATA = {
                    leftRounded: true,
                    percent: 0,
                    infinite: true,
                    icon: 'fa-sharp fa-solid fa-clapperboard-play',
                    text: '.view.notification.replay_downloader.fetching',
                    state: 'info'
                };
                await createFloatingWindow(
                    500,
                    150,
                    JSON.stringify(NOTIFICATION_DATA)
                );

                const TEMP_DOWNLOAD_PATH = path.join(
                    os.tmpdir(),
                    `ebp_analyze_${new Date().getTime()}.mp4`
                );

                try {
                    const YT_DLP_PATH = await ytDlpService.ensureYtDlp();
                    // yt-dlp exige un runtime JavaScript (EJS) pour extraire
                    // les formats YouTube : sans lui, l'extraction échoue.
                    const DENO_PATH = await denoService.ensureDeno();

                    // Ne télécharger que si la source propose du 1080p (ou mieux) :
                    // sinon l'analyse n'est pas fiable. Sonde les formats via yt-dlp.
                    const { stdout } = await execAsync(
                        `"${YT_DLP_PATH}" --js-runtimes "deno:${DENO_PATH}" -J "${VIDEO_URL}"`,
                        { timeout: 30000, maxBuffer: 100 * 1024 * 1024 }
                    );
                    const INFO = JSON.parse(stdout);
                    const HAS_1080P = (INFO.formats ?? []).some(
                        (f) => f.vcodec !== 'none' && f.height >= 1080
                    );
                    if (!HAS_1080P) {
                        socketEmit(data.socket, 'analyzeVideoFileGames', {
                            type: 'unavailable'
                        });
                        // Flux lancé depuis le navigateur : ne pas ramener Tools au
                        // premier plan (pas de showMainWindow), juste fermer la fenêtre.
                        deleteFloatingWindow();
                        break;
                    }

                    // Cap à 1080p (la source a au moins du 1080p, on évite de
                    // télécharger inutilement du 1440p/4K).
                    const FORMAT =
                        PLATFORM === 'youtube'
                            ? 'bestvideo[height<=1080]+bestaudio/best'
                            : 'best[height<=1080]';
                    const SETTINGS = [
                        '--js-runtimes',
                        `deno:${DENO_PATH}`,
                        '--ffmpeg-location',
                        FFMPEG_PATH,
                        '-f',
                        FORMAT,
                        '--merge-output-format',
                        'mp4',
                        '--retries',
                        'infinite',
                        '--fragment-retries',
                        'infinite',
                        '--retry-sleep',
                        '5',
                        '--socket-timeout',
                        '30',
                        '-o',
                        TEMP_DOWNLOAD_PATH,
                        VIDEO_URL
                    ];

                    let percent = 0;
                    await new Promise((resolve, reject) => {
                        const DL = spawn(YT_DLP_PATH, SETTINGS);
                        DL.stdout.on('data', (chunk) => {
                            const MATCH = chunk
                                .toString()
                                .match(/(\d{1,3}\.\d)%/);
                            if (MATCH) {
                                const PERCENT = Number.parseInt(MATCH[1]);
                                if (PERCENT > percent) {
                                    percent = PERCENT;
                                    getMainWindow().webContents.send(
                                        'set-notification-data',
                                        {
                                            ...NOTIFICATION_DATA,
                                            text: '.view.notification.replay_downloader.downloading',
                                            infinite: PERCENT === 100,
                                            percent: PERCENT
                                        }
                                    );
                                }
                            }
                        });
                        DL.on('error', reject);
                        DL.on('close', (code) =>
                            code === 0
                                ? resolve()
                                : reject(
                                      new Error(`yt-dlp exited with code ${code}`)
                                  )
                        );
                    });

                    // Twitch : remux navigateur, comme pour un téléchargement Twitch.
                    if (PLATFORM === 'twitch') {
                        await fixForBrowser(TEMP_DOWNLOAD_PATH);
                    }

                    // Ingestion (durée + remux vers le watch folder) : à partir d'ici,
                    // le flux est identique à `analyzeVideoFile`.
                    await ingestFilesForAnalysis([TEMP_DOWNLOAD_PATH], data);

                    if (fs.existsSync(TEMP_DOWNLOAD_PATH)) {
                        fs.unlinkSync(TEMP_DOWNLOAD_PATH);
                    }
                    deleteFloatingWindow();
                } catch (error) {
                    console.error('[analyzeVideoUrl] Error:', error.message);
                    if (fs.existsSync(TEMP_DOWNLOAD_PATH)) {
                        fs.unlinkSync(TEMP_DOWNLOAD_PATH);
                    }
                    socketEmit(data.socket, 'analyzeVideoFileGames', {
                        type: 'unavailable'
                    });
                    // Idem : ne pas forcer Tools au premier plan en cas d'échec.
                    deleteFloatingWindow();
                }

                break;
            }
            case 'openFiles': {
                const PICKED_FILES = await openFiles(
                    data.filesExtensions ?? [],
                    data.multiple ?? false
                );
                socketEmit(data.socket, 'openFiles', {
                    paths: PICKED_FILES,
                    port: getCurrentPort()
                });
                break;
            }
            case 'manualCutVideoFile':
                if (data.path && Array.isArray(data.chunks)) {
                    const NOTIFICATION_DATA = {
                        percent: 0,
                        leftRounded: true,
                        infinite: true,
                        icon: 'fa-sharp fa-solid fa-scissors',
                        text: '.view.replay_cutter.cuttingVideo',
                        state: 'info'
                    };
                    await createFloatingWindow(
                        450,
                        150,
                        JSON.stringify(NOTIFICATION_DATA)
                    );

                    const FILE_EXTENSION = data.path
                        .split('.')
                        .pop()
                        .toLowerCase();
                    const VIDEO_DIR = path.dirname(data.path);
                    const VIDEO_NAME = path.basename(
                        data.path,
                        `.${FILE_EXTENSION}`
                    );
                    const OUTPUT_FILE_PATH = path.join(
                        VIDEO_DIR,
                        `${VIDEO_NAME} - manual cutted.${FILE_EXTENSION}`
                    );

                    if (fs.existsSync(OUTPUT_FILE_PATH)) {
                        unlinkSync(OUTPUT_FILE_PATH);
                    }

                    await cutWithoutReencode(
                        data.path,
                        OUTPUT_FILE_PATH,
                        data.chunks
                    );

                    deleteFloatingWindow(false);

                    // Ouvre le fichier découpé avec l'application par défaut du système.
                    shell.openPath(OUTPUT_FILE_PATH);
                }
                break;
            case 'analyzeChunks':
                if (
                    data.videoPath &&
                    Array.isArray(data.chunks) &&
                    data.chunks.length > 0
                ) {
                    runChunkAnalyzer(data.videoPath, data.socket, data.chunks);
                }
                break;
            case 'readScoreboard': {
                // L'utilisateur choisit une image de scoreboard de fin de game ;
                // le binaire Python la lit (OCR) et renvoie au client les infos
                // ET le crop base64 de chaque zone lue, pour vérification /
                // correction ultérieure côté Angular.
                const SCOREBOARD_IMAGES = await openFiles([
                    'png',
                    'jpg',
                    'jpeg'
                ]);
                if (SCOREBOARD_IMAGES.length !== 1) {
                    socketEmit(data.socket, 'readScoreboard', {
                        error: 'no-file'
                    });
                    break;
                }
                try {
                    const RESULT = await runScoreboardReader(
                        SCOREBOARD_IMAGES[0]
                    );
                    socketEmit(data.socket, 'readScoreboard', RESULT);
                } catch (error) {
                    console.error('[readScoreboard] failed:', error);
                    socketEmit(data.socket, 'readScoreboard', {
                        error: error.message
                    });
                }
                break;
            }
            case 'addTeamScore': {
                // Crée artificiellement l'écran de score de fin de game en
                // ajoutant 5 secondes d'image (background.jpg) en fin de vidéo,
                // pour que l'analyse puisse borner la game. Les scores fournis
                // (orangeScore/blueScore) seront écrits sur l'image plus tard.
                const FILES_TO_SCORE = await openFiles(data.filesExtensions);
                if (FILES_TO_SCORE.length == 1) {
                    const SRC = FILES_TO_SCORE[0];
                    const EXT = path.extname(SRC);
                    const OUTPUT_FILE_PATH = path.join(
                        path.dirname(SRC),
                        `${path.basename(SRC, EXT)} - with score${EXT}`
                    );
                    const TEAM_SCORE_DIR = path.join(
                        ROOT_PATH,
                        'assets',
                        'team-score'
                    );
                    const BACKGROUND_PATH = path.join(
                        TEAM_SCORE_DIR,
                        'background.jpg'
                    );
                    // Image composée (fond + scores) rendue dans un fichier temporaire,
                    // utilisée comme image de fin de vidéo puis supprimée.
                    const SCORE_IMAGE_PATH = path.join(
                        os.tmpdir(),
                        `ebp-team-score-${getCurrentPort()}.png`
                    );

                    const NOTIFICATION_DATA = {
                        percent: 0,
                        leftRounded: true,
                        infinite: false,
                        icon: '',
                        text: '.common.encoding',
                        state: 'info'
                    };
                    await createFloatingWindow(
                        450,
                        150,
                        JSON.stringify(NOTIFICATION_DATA)
                    );

                    try {
                        await renderTeamScoreImage(
                            BACKGROUND_PATH,
                            TEAM_SCORE_DIR,
                            data.orangeScore ?? 0,
                            data.blueScore ?? 0,
                            SCORE_IMAGE_PATH
                        );

                        await appendImageTail(
                            SRC,
                            OUTPUT_FILE_PATH,
                            SCORE_IMAGE_PATH,
                            5,
                            (percent) => {
                                getMainWindow().webContents.send(
                                    'set-notification-data',
                                    { ...NOTIFICATION_DATA, percent }
                                );
                            }
                        );

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

                        shell.showItemInFolder(OUTPUT_FILE_PATH);

                        setTimeout(() => {
                            deleteFloatingWindow();
                        }, 5000);
                    } catch (error) {
                        console.error(
                            '[ADD-TEAM-SCORE] failed:',
                            error
                        );
                        deleteFloatingWindow();
                    } finally {
                        if (fs.existsSync(SCORE_IMAGE_PATH)) {
                            unlinkSync(SCORE_IMAGE_PATH);
                        }
                    }
                }
                break;
            }
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
     * Ingest local video files into the watch folder for analysis: emits the total
     * duration (length) on the socket, then remuxes each file into the watch folder
     * with the analysis parameters encoded in its name (max time/games, forced
     * scores, team id). Shared by `analyzeVideoFile` and `analyzeVideoUrl`.
     * @param {string[]} filesPaths Local paths of the source videos.
     * @param {*} data Deep link payload (socket, maxTime, maxGames, forced scores, teamId).
     */
    async function ingestFilesForAnalysis(filesPaths, data) {
        const NOTIFICATION_DATA = {
            percent: 0,
            leftRounded: true,
            infinite: true,
            icon: 'fa-sharp fa-solid fa-clapperboard-play',
            text: '.view.notification.identifying_games',
            state: 'info'
        };
        createFloatingWindow(500, 150, JSON.stringify(NOTIFICATION_DATA));

        const MAX_TIME_PER_GAME = data.maxTime ?? 10;
        const MAX_GAMES_AT_SAME_TIME = data.maxGames ?? 3;
        // Scores forcés (panneau "association") : on ne les encode que si LES DEUX
        // sont des entiers 0-100. Sinon on ignore (analyse normale, OCR).
        const isValidScore = (v) => Number.isInteger(v) && v >= 0 && v <= 100;
        const FORCED_SCORES =
            isValidScore(data.forcedOrangeScore) &&
            isValidScore(data.forcedBlueScore)
                ? `__fos-${data.forcedOrangeScore}__fbs-${data.forcedBlueScore}`
                : '';
        // Équipe ciblée pour le matching serveur (/identify). ID numérique uniquement.
        const TEAM_ID =
            typeof data.teamId === 'string' && /^\d+$/.test(data.teamId)
                ? `__tid-${data.teamId}`
                : '';
        // Games ciblées (action groupée « Analyser » côté site) : /identify ne
        // matchera que ces guids. Trop longs pour être encodés dans le nom de
        // fichier (UUIDs, limite 255 chars) → sidecar JSON `<video>.json` écrit
        // à côté du fichier remuxé (voir parseMeta côté watch-folder-service).
        const GAME_GUIDS = Array.isArray(data.gameGuids)
            ? data.gameGuids
                  .filter(
                      (g) =>
                          typeof g === 'string' &&
                          /^[0-9a-fA-F-]{36}$/.test(g)
                  )
                  .slice(0, 500)
            : [];
        const DURATIONS = await Promise.all(
            filesPaths.map((p) => getVideoDuration(p).catch(() => 0))
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
        for (const SRC of filesPaths) {
            const EXT = path.extname(SRC);
            const BASE = path.basename(SRC, EXT);
            const DEST = path.join(
                WATCH_FOLDER,
                `${BASE}__mtpg-${MAX_TIME_PER_GAME}__mgast-${MAX_GAMES_AT_SAME_TIME}${FORCED_SCORES}${TEAM_ID}${EXT}`
            );
            // Sidecar écrit AVANT le remux : la vidéo n'apparaît jamais dans le
            // watch folder sans son scope (le watcher n'enfile que les vidéos).
            if (GAME_GUIDS.length > 0) {
                fs.writeFileSync(
                    DEST + '.json',
                    JSON.stringify({ gameGuids: GAME_GUIDS })
                );
            }
            // Remux (stream copy + faststart) : tout fichier — Twitch, YouTube ou
            // capture — arrive dans le watch folder avec un conteneur propre.
            await remuxToForAnalysis(SRC, DEST);
        }
    }

    /** URL YouTube : watch, live ou youtu.be. Aligné sur le site (analyze_video.dialog). */
    function isYouTubeUrl(url) {
        return /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|live\/)|youtu\.be\/)[\w-]{11}([?&]\S*)?$/.test(
            url
        );
    }

    /** URL Twitch : VOD ou clip. Aligné sur le site (analyze_video.dialog). */
    function isTwitchUrl(url) {
        return /^(https?:\/\/)?(www\.)?twitch\.tv\/(videos\/\d+|[a-zA-Z0-9_]+\/video\/\d+|[a-zA-Z0-9_]+\/clip\/[a-zA-Z0-9_-]+)$/.test(
            url
        );
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
     * Passe un process enfant en priorité BELOW_NORMAL (cross-platform via
     * os.setPriority). Utilisé par le mode salle : sur le PC de streaming
     * d'une salle, l'analyse ne doit JAMAIS faire ramer l'usage principal —
     * l'OS lui donne les cycles restants, les traitements s'allongent
     * seulement quand la machine est occupée.
     */
    function lowerProcessPriority(child, label) {
        try {
            os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
        } catch (e) {
            console.warn(`[${label}] setPriority failed:`, e.message);
        }
    }

    function runAnalyzer(videoPath, socket, settings, showFloatingProgress, lowPriority) {
        const HEADLESS = !socket;

        // Floating window de progression pour la phase de détection. Utile au
        // flux headless (watch-folder) où aucune UI front ne suit l'avancement ;
        // le front interactif (socket) gère déjà sa propre barre via
        // `analyzer-update`, donc on ne l'active que sur demande explicite.
        const NOTIFICATION_DATA = {
            percent: 0,
            leftRounded: true,
            infinite: true,
            icon: 'fa-sharp fa-solid fa-clapperboard-play',
            text: '.view.notification.identifying_games',
            state: 'info'
        };
        if (showFloatingProgress) {
            createFloatingWindow(500, 150, JSON.stringify(NOTIFICATION_DATA));
        }

        return new Promise((resolve, reject) => {
            const SETTINGS_JSON = JSON.stringify(settings || {});
            const ARGS = ['detect', videoPath, FFMPEG_PATH, '', SETTINGS_JSON];
            const SPAWN_OPTIONS = {
                stdio: ['ignore', 'pipe', 'pipe'],
                cwd: path.dirname(ANALYZER_PATH),
                windowsHide: true
            };
            const ANALYZER = spawn(ANALYZER_PATH, ARGS, SPAWN_OPTIONS);
            if (lowPriority) lowerProcessPriority(ANALYZER, 'analyzer');
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
                            // Met à jour la floating window de détection (relayée
                            // au composant notification via BroadcastChannel).
                            if (
                                showFloatingProgress &&
                                typeof MSG.percent === 'number'
                            ) {
                                WINDOW.webContents.send('set-notification-data', {
                                    ...NOTIFICATION_DATA,
                                    infinite: false,
                                    percent: MSG.percent,
                                    icon: undefined
                                });
                            }
                        }
                        if (
                            (MSG.type === 'done' || MSG.type === 'error') &&
                            !RESOLVED
                        ) {
                            if (!HEADLESS || showFloatingProgress)
                                deleteFloatingWindow(false);
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
                        // Filet : le process s'est fermé sans event done/error,
                        // on ne laisse pas la floating window de détection orpheline.
                        if (showFloatingProgress) deleteFloatingWindow(false);
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
                if (showFloatingProgress) deleteFloatingWindow(false);
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
     * @param {object} settings  Réglages d'analyse propagés à Python.
     * @param {(p:{gameID:string, percent:number})=>void} [onProgress] Callback appelé
     *   à chaque tick de progression PAR GAME (les MSG taggés `gameID`). Utilisé en
     *   mode headless (watch-folder) pour remonter l'état par game au backend.
     */
    function runChunkAnalyzer(videoPath, socket, chunks, settings, onProgress, lowPriority) {
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
            if (lowPriority) lowerProcessPriority(ANALYZER, 'chunk-analyzer');
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
                            // Progression PAR GAME (MSG taggé gameID) → callback
                            // headless. Le tick global de fin (sans gameID) est
                            // ignoré ici, c'est un signal fichier.
                            if (MSG.gameID != null && onProgress) {
                                try {
                                    onProgress({
                                        gameID: MSG.gameID,
                                        percent: MSG.percent
                                    });
                                } catch (_) {}
                            }
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
     * Runs the packaged Python analyzer in `scoreboard` mode on a single image
     * and resolves the OCR result: the read info plus a base64 PNG crop of every
     * zone the OCR looked at (map, team %, and per player name/score/k/d/a), for
     * client-side verification. Rejects on spawn error or if the process ends
     * without emitting a `scoreboard` result.
     * @param {string} imagePath Absolute path to the scoreboard frame (png/jpg).
     * @returns {Promise<object>} `read_frame(..., with_zone_images=True)` output.
     */
    function runScoreboardReader(imagePath) {
        return new Promise((resolve, reject) => {
            const ARGS = ['scoreboard', imagePath];
            const SPAWN_OPTIONS = {
                stdio: ['ignore', 'pipe', 'pipe'],
                cwd: path.dirname(ANALYZER_PATH),
                windowsHide: true
            };
            const ANALYZER = spawn(ANALYZER_PATH, ARGS, SPAWN_OPTIONS);
            let BUFFER = '';
            let RESULT = null;
            let ERROR = null;

            const handleLine = (line) => {
                if (!line.trim()) return;
                try {
                    const MSG = JSON.parse(line);
                    if (MSG.type === 'scoreboard') {
                        RESULT = MSG.result;
                    } else if (MSG.type === 'error') {
                        ERROR = MSG.message;
                    }
                } catch (_) {}
            };

            ANALYZER.stdout.on('data', (chunk) => {
                BUFFER += chunk.toString();
                const LINES = BUFFER.split('\n');
                BUFFER = LINES.pop();
                for (const LINE of LINES) {
                    handleLine(LINE);
                }
            });

            ANALYZER.stderr.on('data', (data) => {
                console.error('[scoreboard stderr]', data.toString());
            });

            ANALYZER.on('error', reject);

            ANALYZER.on('close', () => {
                if (BUFFER.trim()) {
                    handleLine(BUFFER.trim());
                }
                if (RESULT) {
                    resolve(RESULT);
                } else {
                    reject(
                        new Error(
                            ERROR || 'scoreboard reader produced no result'
                        )
                    );
                }
            });
        });
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

        // Mode salle : battement de présence périodique vers le backend (no-op
        // si le mode n'est pas actif sur cette machine), reprise de la
        // captation si un périphérique est configuré, et consommateur du spool
        // (segments → games découpées).
        arenaModeService.startHeartbeat();
        if (arenaModeService.getState().registered) {
            arenaCaptureService.autoStart();
            try {
                arenaPipelineService.start({ runAnalyzer });
                arenaUploaderService.start({ runChunkAnalyzer });
            } catch (e) {
                console.error('[arena-pipeline] failed to start', e);
            }
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
                console.log(
                    '[INSTANCE] New instance detected, focusing existing window'
                );

                // Restore and bring the existing window to the foreground.
                const WINDOW = getMainWindow();
                if (WINDOW && !WINDOW.isDestroyed() && WINDOW.isMinimized()) {
                    WINDOW.restore();
                }

                // Handle deep link on Windows when app is already running.
                const DEEP_LINK_URL = commandLine.find((arg) =>
                    arg.startsWith(`${PROTOCOL_NAME}://`)
                );
                if (DEEP_LINK_URL) {
                    handleDeepLink(DEEP_LINK_URL);
                }
                else{
                    showMainWindow();
                }
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
            let settings = {};
            try {
                settings = settingsJSON ? JSON.parse(settingsJSON) : {};
            } catch (_) {}
            runAnalyzer(videoPath, undefined, settings);
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
                const DENO_PATH = await denoService.ensureDeno();
                const { stdout } = await execAsync(
                    `"${YT_DLP_PATH}" --js-runtimes "deno:${DENO_PATH}" -J "${url}"`,
                    { timeout: 30000, maxBuffer: 100 * 1024 * 1024 }
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
                const DENO_PATH = await denoService.ensureDeno();

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
                    `"${YT_DLP_PATH}" --js-runtimes "deno:${DENO_PATH}" --ffmpeg-location "${FFMPEG_PATH}" --get-title ${url}`,
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
                                    '--js-runtimes',
                                    `deno:${DENO_PATH}`,
                                    '--ffmpeg-location',
                                    FFMPEG_PATH,
                                    '-f',
                                    YOUTUBE_FORMAT,
                                    '--merge-output-format',
                                    'mp4',
                                    // Survive temporary connection losses: keep
                                    // retrying instead of aborting, so the
                                    // download resumes when the network returns.
                                    '--retries',
                                    'infinite',
                                    '--fragment-retries',
                                    'infinite',
                                    '--retry-sleep',
                                    '5',
                                    '--socket-timeout',
                                    '30',
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
                                    // Survive temporary connection losses: keep
                                    // retrying instead of aborting, so the
                                    // download resumes when the network returns.
                                    '--retries',
                                    'infinite',
                                    '--fragment-retries',
                                    'infinite',
                                    '--retry-sleep',
                                    '5',
                                    '--socket-timeout',
                                    '30',
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
        ipcMain.handle('get-jwt-access-token', async () => {
            // Authentication actually relies on the EBP domain's session
            // cookies (the JWT is not persisted). We therefore query the
            // backend with those cookies to retrieve the user's information.
            try {
                const COOKIES =
                    await getMainWindow().webContents.session.cookies.get({
                        url: `https://${EBP_DOMAIN}`
                    });
                const COOKIES_HEADER = COOKIES.map(
                    (c) => `${c.name}=${c.value}`
                ).join('; ');

                const DATA = await new Promise((resolve, reject) => {
                    const REQUEST = https.request(
                        {
                            hostname: EBP_DOMAIN,
                            port: 443,
                            path: '/back/api/?c=user&r=token',
                            method: 'GET',
                            headers: {
                                Cookie: COOKIES_HEADER,
                                Accept: 'application/json'
                            }
                        },
                        (res) => {
                            let body = '';
                            res.on('data', (chunk) => (body += chunk));
                            res.on('end', () => resolve(body));
                        }
                    );
                    REQUEST.on('error', reject);
                    REQUEST.end();
                });

                const PARSED = JSON.parse(DATA);

                if (PARSED.access_token) {
                    const PAYLOAD = JSON.parse(
                        Buffer.from(
                            PARSED.access_token.split('.')[1],
                            'base64'
                        ).toString()
                    );
                    if(PAYLOAD.email) {
                        console.log('[USER] User\'s email:', PAYLOAD.email);
                    }
                }
            } catch (e) {
                console.error('[USER] Could not retrieve user:', e.message);
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

        // The front-end asks the server to return the arena (salle) mode state.
        ipcMain.handle('arena-mode-get-state', () => {
            return arenaModeService.getState();
        });

        // The front-end asks the server to register this machine as the
        // streaming PC of an arena (salle). Errors are mapped to i18n keys of
        // `view.arena_mode.errors.*` so the front only has to toast them.
        ipcMain.handle(
            'arena-mode-register',
            async (event, roomId, arenaId, key) => {
                try {
                    const STATE = await arenaModeService.register({
                        roomId,
                        arenaId,
                        key
                    });
                    // La salle vient d'être activée : consommateur du spool et
                    // uploader démarrent (idempotents si déjà actifs).
                    arenaPipelineService.start({ runAnalyzer });
                    arenaUploaderService.start({ runChunkAnalyzer });
                    return { success: true, state: STATE };
                } catch (e) {
                    console.error('[arena-mode] register failed:', e.message);
                    let error = 'network';
                    if (e instanceof NotAuthenticatedError) {
                        error = 'notAuthenticated';
                    } else if (e instanceof ApiError) {
                        if (e.status === 404) error = 'unknownArena';
                        else if (e.status === 422) error = 'invalidKey';
                    }
                    return { success: false, error };
                }
            }
        );

        // The front-end asks the server to unregister the arena (salle) mode.
        ipcMain.handle('arena-mode-unregister', () => {
            arenaCaptureService.stopCapture();
            arenaPipelineService.stop();
            arenaUploaderService.stop();
            return arenaModeService.unregister();
        });

        // The front-end asks the server to list video capture devices.
        ipcMain.handle('arena-capture-list-devices', () => {
            return arenaCaptureService.listVideoDevices();
        });

        // The front-end asks the server to return the capture status.
        ipcMain.handle('arena-capture-get-status', () => {
            return arenaCaptureService.getStatus();
        });

        // The front-end asks the server to select a device and start capturing.
        ipcMain.handle('arena-capture-set-device', (event, device) => {
            return arenaCaptureService.setDeviceAndRestart(device);
        });

        // The front-end asks the server to open the arena working folder
        // (parent of spool/, work/ and games/) in the file explorer.
        ipcMain.handle('arena-open-folder', () => {
            const ROOT = path.dirname(
                arenaCaptureService.getStatus().spoolFolder
            );
            if (!fs.existsSync(ROOT)) fs.mkdirSync(ROOT, { recursive: true });
            shell.openPath(ROOT);
        });

        // The front-end asks the server to start/stop the capture.
        ipcMain.handle('arena-capture-start', () => {
            return arenaCaptureService.startCapture();
        });
        ipcMain.handle('arena-capture-stop', () => {
            return arenaCaptureService.stopCapture();
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
