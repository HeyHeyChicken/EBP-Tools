// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const fs = require('fs');
const os = require('os');
const path = require('node:path');
const { spawn, spawnSync } = require('child_process');
const { screen } = require('electron');
const { FFMPEG_PATH } = require('../config/constants');
const StorageManager = require('../core/storage-manager');

//#endregion

// Mode salle — brique de CAPTATION. Contrat : lit un périphérique vidéo (la
// caméra virtuelle qui reçoit le flux du jeu) et écrit des segments vidéo dans
// le dossier spool. Le reste du pipeline (détection loading/score frame,
// découpe, analyse, upload) ne consomme QUE ce dossier : si la source change
// demain (enregistrement OBS local, carte de capture), seule cette brique est
// remplacée.
//
// Enregistrement en segments mkv (crash-safe : un mkv tronqué reste lisible,
// contrairement à un mp4 sans moov) de SEGMENT_SECONDS. Une game à cheval sur
// deux segments sera recollée par le pipeline (ffmpeg concat demuxer,
// stream-copy). ffmpeg est relancé automatiquement s'il meurt : PC de salle
// sans surveillance.

const SETTINGS_KEY_DEVICE = 'arenaCaptureDevice';
const SETTINGS_KEY_SPOOL = 'arenaSpoolFolder';
const SEGMENT_SECONDS = 300;
// Réglages d'encodage : à ajuster sur le matériel réel des salles (NVENC si
// GPU NVIDIA). videotoolbox = encodage matériel macOS (dev), libx264
// veryfast = fallback logiciel portable.
// Encodage WEB-READY dès la source : H.264 + GOP de 1 s (une keyframe par
// seconde, comme `cutAndEncodeGame`) pour que la découpe des games soit un
// simple stream-copy/remux mp4 — zéro réencodage, zéro CPU, zéro perte. Les
// I-frames rapprochées coûtent ~15-20 % de bitrate à qualité égale : compensé
// par le bitrate (stockage accepté).
//
// Encodeur : détecté automatiquement au premier démarrage — les PC de salle
// sont toujours des Windows mais aux configs variées (dev = Mac). Chaque
// candidat est VALIDÉ par un encodage à blanc (un GPU absent ou un driver
// cassé fait passer au suivant), libx264 (CPU) en dernier recours. Priorité
// aux encodeurs matériels : la captation tourne 24/7 sur un PC qui stream.
const ENCODER_CANDIDATES =
    process.platform === 'darwin'
        ? [
              { name: 'h264_videotoolbox', args: ['-c:v', 'h264_videotoolbox', '-b:v', '10M'] },
              { name: 'libx264', args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20'] }
          ]
        : [
              { name: 'h264_nvenc', args: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-b:v', '10M'] },
              { name: 'h264_qsv', args: ['-c:v', 'h264_qsv', '-b:v', '10M'] },
              { name: 'h264_amf', args: ['-c:v', 'h264_amf', '-b:v', '10M'] },
              { name: 'libx264', args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20'] }
          ];

let resolvedEncoder = null;

/**
 * Premier encodeur candidat qui encode réellement (1 s de noir → null muxer).
 * Résolu une fois par session (~1-3 s au premier démarrage de la captation).
 */
function resolveEncoder() {
    if (resolvedEncoder) return resolvedEncoder;
    for (const CANDIDATE of ENCODER_CANDIDATES) {
        const RES = spawnSync(
            FFMPEG_PATH,
            [
                '-hide_banner', '-v', 'error',
                '-f', 'lavfi', '-i', 'color=black:s=1920x1080:r=30',
                '-frames:v', '30',
                ...CANDIDATE.args,
                '-f', 'null', '-'
            ],
            { encoding: 'utf8', timeout: 20000 }
        );
        if (RES.status === 0) {
            console.log(`[arena-capture] encoder: ${CANDIDATE.name}`);
            resolvedEncoder = CANDIDATE;
            return CANDIDATE;
        }
        console.log(
            `[arena-capture] encoder ${CANDIDATE.name} unavailable:`,
            (RES.stderr || '').split('\n')[0]
        );
    }
    // Tous les probes ont échoué (improbable) : libx264 en aveugle.
    resolvedEncoder = ENCODER_CANDIDATES[ENCODER_CANDIDATES.length - 1];
    return resolvedEncoder;
}
// Framerate de SORTIE (CFR). L'entrée reste au rythme imposé par le
// périphérique (avfoundation exige le mode exact, ex. 60 fps) ; on jette les
// images excédentaires à l'encodage : à bitrate égal, 30 fps = plus de qualité
// par image (meilleur OCR) et moitié moins de charge encodeur.
const OUTPUT_FPS = 30;
const RESTART_BASE_DELAY_MS = 5 * 1000;
const RESTART_MAX_DELAY_MS = 60 * 1000;

let ffmpegProcess = null;
let stopRequested = false;
let restartTimer = null;
let restartDelayMs = RESTART_BASE_DELAY_MS;
let startedAt = null;
let lastError = null;
// Dernières lignes stderr de ffmpeg : en cas d'échec au démarrage (device
// invalide, framerate non supporté…), c'est le seul diagnostic utile.
let stderrTail = [];
// Mode imposé par le périphérique (avfoundation exige un framerate/taille
// EXACTEMENT supportés — ex. OBS Virtual Camera = 1920x1080@60 uniquement).
// Détecté en parsant le "Supported modes:" que ffmpeg logge quand le mode
// demandé est refusé, puis réessayé aussitôt. Réinitialisé au changement de
// périphérique.
let detectedMode = null;
// Résolution refusée : l'analyseur travaille en coordonnées 1920×1080
// absolues, donc la captation exige une source 1080p — pas d'upscale filet de
// sécurité (décision Antoine), on refuse et on affiche l'erreur. Ce flag
// bloque le redémarrage automatique : relancer en boucle sur une source 720p
// ne la transformera pas en 1080p.
let resolutionRejected = false;

/**
 * Extrait les modes supportés ("1920x1080@[15.000000 60.000000]fps") du stderr
 * d'un ffmpeg qui a refusé le mode demandé, et renvoie le mode 1920×1080 s'il
 * existe (fps = max de la plage), sinon le premier de la liste (que le caller
 * rejettera : la captation exige du 1080p). Null si aucun mode listé.
 */
function parseSupportedMode(lines) {
    const MODES = [];
    for (const LINE of lines) {
        const RE = /(\d{3,4})x(\d{3,4})@\[([\d. ]+)\]/g;
        let m;
        while ((m = RE.exec(LINE)) !== null) {
            const FPS_LIST = m[3].trim().split(/\s+/).map(parseFloat);
            MODES.push({
                width: parseInt(m[1], 10),
                height: parseInt(m[2], 10),
                fps: Math.round(Math.max(...FPS_LIST))
            });
        }
    }
    if (MODES.length === 0) return null;
    return (
        MODES.find((x) => x.width === 1920 && x.height === 1080) || MODES[0]
    );
}

function getSpoolFolder() {
    return StorageManager.getPermanentSettingsValue(
        SETTINGS_KEY_SPOOL,
        path.join(os.homedir(), 'EBP-Tools-Arena', 'spool')
    );
}

/**
 * Change l'emplacement du spool (déplacement du dossier EBP-Tools-Arena par
 * l'utilisateur). L'appelant (server.js) est responsable d'avoir arrêté la
 * captation et déplacé les fichiers AVANT.
 */
function setSpoolFolder(spoolPath) {
    StorageManager.setPermanentSettingsValue(SETTINGS_KEY_SPOOL, spoolPath);
}

function getDevice() {
    return StorageManager.getPermanentSettingsValue(SETTINGS_KEY_DEVICE);
}

function setDevice(device) {
    StorageManager.setPermanentSettingsValue(SETTINGS_KEY_DEVICE, device);
}

/**
 * Liste les périphériques vidéo via ffmpeg (avfoundation sur macOS, dshow sur
 * Windows). ffmpeg sort la liste sur stderr et se termine en erreur : c'est le
 * comportement attendu, on parse quoi qu'il arrive.
 * Sépare les écrans (avfoundation les expose comme des caméras) des caméras
 * virtuelles.
 * @returns {{screens: object[], cameras: object[]}}  id = index avfoundation ou chemin dshow.
 */
function listCaptureDevices() {
    const IS_MAC = process.platform === 'darwin';
    const ARGS = IS_MAC
        ? ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', '']
        : ['-hide_banner', '-f', 'dshow', '-list_devices', 'true', '-i', 'dummy'];
    const RES = spawnSync(FFMPEG_PATH, ARGS, { encoding: 'utf8' });
    const OUT = (RES.stderr || '') + (RES.stdout || '');
    const DEVICES = [];
    if (IS_MAC) {
        // Bloc "AVFoundation video devices:" → lignes `[N] Nom`, jusqu'au bloc audio.
        let inVideoBlock = false;
        for (const LINE of OUT.split('\n')) {
            if (/AVFoundation video devices/.test(LINE)) {
                inVideoBlock = true;
                continue;
            }
            if (/AVFoundation audio devices/.test(LINE)) break;
            const M = inVideoBlock && LINE.match(/\[(\d+)\]\s+(.+)$/);
            if (M) DEVICES.push({ id: M[1], name: M[2].trim() });
        }
    } else {
        // Lignes `"Nom" (video)` suivies d'une ligne `Alternative name "@device_pnp_…"`.
        // Deux caméras du même modèle ont un nom IDENTIQUE mais un chemin
        // (alternative name) UNIQUE → on l'utilise comme id pour les
        // distinguer (dropdown sans clés dupliquées, sélection, adressage
        // ffmpeg de la bonne caméra). Fallback sur le nom si le chemin manque.
        const LINES = OUT.split('\n');
        for (let i = 0; i < LINES.length; i++) {
            const M = LINES[i].match(/"([^"]+)"\s+\((video)\)/);
            if (!M) continue;
            const NAME = M[1];
            const ALT = (LINES[i + 1] || '').match(
                /Alternative name\s+"([^"]+)"/
            );
            DEVICES.push({ id: ALT ? ALT[1] : NAME, name: NAME });
        }
    }
    // avfoundation expose les écrans comme des périphériques vidéo : ils sont
    // sortis de la liste des caméras et rejoignent les écrans (dev macOS).
    const IS_SCREEN = /capture screen/i;
    const SCREENS = IS_MAC
        ? DEVICES.filter((d) => IS_SCREEN.test(d.name)).map((d) => ({
              id: d.id,
              name: d.name,
              kind: 'screen'
          }))
        : [];
    // Le pipeline salle ne capte QUE des caméras VIRTUELLES (le flux du jeu via
    // OBS Virtual Camera & co) : la source doit être un rendu 1080p, pas une
    // webcam physique. Les webcams physiques sont de toute façon exclusives
    // sous Windows (impossible à prévisualiser pendant qu'on les enregistre),
    // donc on les retire de la liste. Filtre par nom — à étendre si d'autres
    // logiciels de caméra virtuelle sont utilisés en salle.
    const IS_VIRTUAL = /virtual|obs|vcam|streamlabs|xsplit|manycam|\bndi\b/i;
    const CAMERAS = DEVICES.filter(
        (d) => !IS_SCREEN.test(d.name) && IS_VIRTUAL.test(d.name)
    ).map((d) => ({ id: d.id, name: d.name, kind: 'camera' }));
    return { screens: SCREENS, cameras: CAMERAS };
}

/**
 * Écrans capturables sous Windows. La capture passe par `ddagrab`, qui adresse
 * les sorties par INDEX DXGI : on suppose que cet index suit l'ordre des
 * écrans rapporté par Electron, ce qui est le cas courant mais n'est garanti
 * par rien. Une inversion se voit immédiatement dans l'aperçu, et se corrige
 * en choisissant l'autre entrée — d'où le libellé qui porte la résolution.
 * @returns {{id: string, name: string, kind: string, outputIndex: number, width: number, height: number}[]}
 */
function listWindowsScreens() {
    return screen.getAllDisplays().map((display, index) => {
        // `size` est en pixels indépendants du périphérique : ddagrab capture
        // des pixels PHYSIQUES. Sans le facteur d'échelle, un écran 1440p en
        // affichage à 150 % serait annoncé en 1707×960 et refusé à tort.
        const WIDTH = Math.round(display.size.width * display.scaleFactor);
        const HEIGHT = Math.round(display.size.height * display.scaleFactor);
        return {
            id: String(display.id),
            name: `Écran ${index + 1} (${WIDTH}×${HEIGHT})`,
            kind: 'screen',
            outputIndex: index,
            width: WIDTH,
            height: HEIGHT
        };
    });
}

/**
 * Sources sélectionnables : écrans d'abord (la cible du mode salle depuis
 * qu'on capte le logiciel de jeu directement), caméras virtuelles ensuite
 * (montages existants encore en service).
 */
function listVideoDevices() {
    const { screens, cameras } = listCaptureDevices();
    const SCREENS =
        process.platform === 'darwin' ? screens : listWindowsScreens();
    return [...SCREENS, ...cameras];
}

function buildFfmpegArgs(device) {
    const IS_MAC = process.platform === 'darwin';
    const SPOOL = getSpoolFolder();
    const IS_SCREEN = device.kind === 'screen';
    // Pas d'audio : ni la caméra virtuelle ni ddagrab n'en transportent. Le son
    // fera l'objet d'une entrée séparée (capture par processus).
    let inputArgs;
    if (IS_SCREEN && !IS_MAC) {
        // Windows : Desktop Duplication côté GPU. ddagrab est une SOURCE de
        // filtergraph, pas un format d'entrée — il n'y a donc aucun `-i`, et
        // c'est `-filter_complex` qui produit le flux.
        //
        // `hwdownload` ramène les frames en RAM. C'est un coût réel (BGRA
        // 1080p30 ≈ 240 Mo/s sur le bus) mais c'est le SEUL chemin qui marche
        // avec les quatre encodeurs candidats. Le chemin zéro-copie vers NVENC
        // est une optimisation à faire une fois qu'on aura mesuré sur un PC de
        // salle — pas à deviner d'ici.
        const FILTERS = [
            `ddagrab=output_idx=${device.outputIndex || 0}:framerate=${OUTPUT_FPS}`,
            'hwdownload',
            'format=bgra'
        ];
        // L'analyseur travaille en coordonnées 1920×1080 absolues. Un écran
        // plus grand est réduit ; un écran plus petit est refusé en amont
        // (startCapture) — pas d'upscale, décision Antoine.
        if (device.width !== 1920 || device.height !== 1080) {
            FILTERS.push('scale=1920:1080');
        }
        inputArgs = [
            '-init_hw_device', 'd3d11va',
            '-filter_complex', `${FILTERS.join(',')}[v]`,
            '-map', '[v]'
        ];
    } else if (IS_SCREEN) {
        // macOS (dev) : avfoundation expose les écrans comme des
        // périphériques. Pas de contrôle de format ici — sur un écran qui
        // n'est pas en 16/9 (les portables Apple sont en 16/10), l'image sera
        // déformée. Acceptable pour du dev, refusé sous Windows.
        inputArgs = [
            '-f', 'avfoundation',
            '-framerate', String(OUTPUT_FPS),
            '-i', `${device.id}:none`,
            '-vf', 'scale=1920:1080'
        ];
    } else if (IS_MAC) {
        inputArgs = [
            '-f', 'avfoundation',
            '-framerate', String(detectedMode ? detectedMode.fps : 30),
            ...(detectedMode
                ? ['-video_size', `${detectedMode.width}x${detectedMode.height}`]
                : []),
            '-i', `${device.id}:none`
        ];
    } else {
        inputArgs = [
            '-f', 'dshow',
            '-rtbufsize', '512M',
            '-i', `video=${device.id}`
        ];
    }
    const ENCODER_ARGS = resolveEncoder().args;
    // Sortie en CFR : les caméras (surtout virtuelles) livrent des timestamps
    // irréguliers qui, sans ça, produisent un temps média ≠ temps réel (fps
    // annoncés délirants, frames dupliquées) — ce qui fausse la durée des
    // segments (le muxer segmente sur le temps média) et tout le mapping
    // temporel du pipeline.
    return [
        '-hide_banner',
        ...inputArgs,
        ...ENCODER_ARGS,
        '-fps_mode', 'cfr',
        '-r', String(OUTPUT_FPS),
        // GOP = 1 s (cf. ENCODER_ARGS) : keyframe à chaque seconde pour un
        // seek fluide côté web ET une découpe stream-copy précise à ±1 s.
        '-g', String(OUTPUT_FPS),
        '-pix_fmt', 'yuv420p',
        '-f', 'segment',
        '-segment_time', String(SEGMENT_SECONDS),
        '-reset_timestamps', '1',
        '-strftime', '1',
        path.join(SPOOL, 'rec_%Y%m%d-%H%M%S.mkv')
    ];
}

/**
 * Démarre la captation sur le périphérique configuré. No-op si déjà en cours
 * ou si aucun périphérique n'est configuré.
 */
function startCapture() {
    if (ffmpegProcess) return getStatus();
    const DEVICE = getDevice();
    if (!DEVICE || !DEVICE.id) {
        lastError = 'no_device';
        return getStatus();
    }

    const SPOOL = getSpoolFolder();
    if (!fs.existsSync(SPOOL)) fs.mkdirSync(SPOOL, { recursive: true });

    stopRequested = false;
    lastError = null;
    stderrTail = [];
    resolutionRejected = false;

    // Les index avfoundation ne sont PAS stables (un iPhone en continuité ou
    // une webcam débranchée décale tout) : on re-résout l'index par le NOM à
    // chaque démarrage. Windows/dshow adresse déjà par nom, rien à faire.
    let resolvedDevice = DEVICE;
    if (process.platform === 'darwin') {
        const MATCH = listVideoDevices().find((d) => d.name === DEVICE.name);
        if (!MATCH) {
            lastError = `device_not_found: ${DEVICE.name}`;
            console.error('[arena-capture]', lastError);
            return getStatus();
        }
        resolvedDevice = MATCH;
    } else if (DEVICE.kind === 'screen') {
        // L'index de sortie et la définition d'un écran changent au gré des
        // branchements : on les relit au démarrage plutôt que de faire
        // confiance à ce qui a été enregistré dans les settings.
        const MATCH = listWindowsScreens().find((s) => s.id === DEVICE.id);
        if (!MATCH) {
            lastError = `screen_not_found: ${DEVICE.name}`;
            console.error('[arena-capture]', lastError);
            return getStatus();
        }
        resolvedDevice = MATCH;
    }

    // Pas d'upscale (décision Antoine) : un écran plus petit que 1080p ne peut
    // pas alimenter l'analyseur, qui raisonne en coordonnées 1920×1080.
    // Le format doit aussi être du 16/9 : réduire un écran 16/10 vers 1080p
    // déformerait l'image, et l'ajouter en letterbox décalerait toutes les
    // coordonnées de l'analyseur. Les deux cassent l'analyse en silence, donc
    // on refuse plutôt que de produire des vidéos inexploitables.
    if (resolvedDevice.kind === 'screen' && resolvedDevice.width) {
        const { width: WIDTH, height: HEIGHT } = resolvedDevice;
        if (WIDTH < 1920 || HEIGHT < 1080) {
            resolutionRejected = true;
            lastError = `not_1080p: écran ${WIDTH}x${HEIGHT} (1920x1080 minimum requis)`;
        } else if (Math.abs(WIDTH / HEIGHT - 16 / 9) > 0.01) {
            resolutionRejected = true;
            lastError = `not_16_9: écran ${WIDTH}x${HEIGHT} (format 16/9 requis)`;
        }
        if (resolutionRejected) {
            console.error('[arena-capture]', lastError);
            return getStatus();
        }
    }

    const ARGS = buildFfmpegArgs(resolvedDevice);
    console.log(`[arena-capture] starting: ${FFMPEG_PATH} ${ARGS.join(' ')}`);
    const PROC = spawn(FFMPEG_PATH, ARGS, { stdio: ['pipe', 'ignore', 'pipe'] });
    ffmpegProcess = PROC;
    startedAt = Date.now();

    let resolutionChecked = false;
    PROC.stderr.on('data', (d) => {
        const LINE = d.toString().trim();
        if (!LINE) return;
        stderrTail.push(LINE);
        if (stderrTail.length > 20) stderrTail.shift();
        // Contrôle strict 1080p sur la première ligne de stream vidéo (l'input
        // apparaît avant l'output dans le banner ffmpeg) : source ≠ 1920×1080
        // → arrêt immédiat avec erreur, sans redémarrage automatique. Sans
        // objet pour un écran : sa définition est validée avant le démarrage,
        // et la mise à l'échelle vers 1080p est délibérée.
        if (!resolutionChecked && resolvedDevice.kind !== 'screen') {
            const M = LINE.match(/Video:.*?(\d{3,4})x(\d{3,4})/);
            if (M) {
                resolutionChecked = true;
                if (M[1] !== '1920' || M[2] !== '1080') {
                    resolutionRejected = true;
                    lastError = `not_1080p: source ${M[1]}x${M[2]} (1920x1080 requis)`;
                    console.error('[arena-capture]', lastError);
                    PROC.kill('SIGINT');
                }
            }
        }
    });

    PROC.on('error', (e) => {
        console.error('[arena-capture] spawn error:', e.message);
        lastError = e.message;
    });

    PROC.on('close', (code) => {
        if (ffmpegProcess !== PROC) return;
        ffmpegProcess = null;
        startedAt = null;
        if (stopRequested) {
            console.log('[arena-capture] stopped');
            return;
        }
        // Source refusée (≠ 1080p) : pas de redémarrage automatique — l'erreur
        // reste affichée jusqu'à ce que la source soit corrigée et la captation
        // relancée manuellement.
        if (resolutionRejected) return;
        // Mode refusé par le périphérique : ffmpeg vient de logger la liste des
        // modes supportés → on adopte le premier S'IL est en 1080p et on
        // relance immédiatement (une seule fois par mode pour ne pas boucler).
        // Un périphérique qui ne propose pas de 1080p est refusé net.
        const SUPPORTED = parseSupportedMode(stderrTail);
        if (SUPPORTED && (SUPPORTED.width !== 1920 || SUPPORTED.height !== 1080)) {
            resolutionRejected = true;
            lastError = `not_1080p: le périphérique propose ${SUPPORTED.width}x${SUPPORTED.height} (1920x1080 requis)`;
            console.error('[arena-capture]', lastError);
            return;
        }
        if (
            SUPPORTED &&
            (!detectedMode || detectedMode.fps !== SUPPORTED.fps)
        ) {
            detectedMode = SUPPORTED;
            console.log(
                `[arena-capture] device imposes ${SUPPORTED.width}x${SUPPORTED.height}@${SUPPORTED.fps} — restarting with it`
            );
            startCapture();
            return;
        }
        // Mort inattendue (device débranché, erreur d'encodage…) : on garde le
        // diagnostic et on relance avec backoff — la captation d'une salle ne
        // doit jamais rester morte en silence.
        lastError = stderrTail.slice(-3).join(' | ') || `ffmpeg exited (${code})`;
        console.error(
            `[arena-capture] ffmpeg died (code ${code}), restart in ${restartDelayMs / 1000}s —`,
            lastError
        );
        restartTimer = setTimeout(() => {
            restartTimer = null;
            restartDelayMs = Math.min(restartDelayMs * 2, RESTART_MAX_DELAY_MS);
            startCapture();
        }, restartDelayMs);
    });

    // Un run sain depuis > 2 min réarme le backoff.
    setTimeout(() => {
        if (ffmpegProcess === PROC) restartDelayMs = RESTART_BASE_DELAY_MS;
    }, 2 * 60 * 1000);

    return getStatus();
}

/**
 * Arrête proprement la captation ('q' sur stdin → ffmpeg finalise le segment
 * en cours), et annule tout redémarrage programmé.
 */
function stopCapture() {
    stopRequested = true;
    if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
    }
    restartDelayMs = RESTART_BASE_DELAY_MS;
    if (ffmpegProcess) {
        try {
            ffmpegProcess.stdin.write('q');
        } catch (_) {
            ffmpegProcess.kill('SIGINT');
        }
    }
    return getStatus();
}

/**
 * Sélectionne le périphérique. Ne démarre PAS la captation de lui-même : le
 * simple choix d'une source ne sert qu'à la prévisualisation. En revanche, si
 * une captation est déjà en cours, on bascule dessus sans interruption voulue
 * par l'utilisateur.
 * @param {{id: string, name: string}} device
 */
function setDeviceAndRestart(device) {
    setDevice(device);
    detectedMode = null;
    if (ffmpegProcess) {
        // Redémarrage sur le nouveau périphérique une fois l'ancien arrêté.
        const OLD = ffmpegProcess;
        stopCapture();
        OLD.on('close', () => startCapture());
    }
    return getStatus();
}

/**
 * À appeler au boot : reprend la captation si un périphérique est configuré et
 * que le mode salle est actif (l'appelant vérifie ce dernier point).
 */
function autoStart() {
    if (getDevice()) startCapture();
}

function getStatus() {
    const DEVICE = getDevice();
    return {
        running: !!ffmpegProcess,
        deviceId: DEVICE ? DEVICE.id : null,
        deviceName: DEVICE ? DEVICE.name : null,
        // L'aperçu du renderer n'ouvre pas une source écran comme une caméra.
        deviceKind: DEVICE ? DEVICE.kind || 'camera' : null,
        encoder: resolvedEncoder ? resolvedEncoder.name : null,
        startedAt,
        lastError,
        spoolFolder: getSpoolFolder(),
        segmentSeconds: SEGMENT_SECONDS
    };
}

module.exports = {
    listVideoDevices,
    startCapture,
    stopCapture,
    setDeviceAndRestart,
    autoStart,
    getStatus,
    setSpoolFolder
};
