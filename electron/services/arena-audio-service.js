// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('node:path');

//#endregion

// Mode salle — piste AUDIO de la captation. Le son du PC est capté en loopback
// par le renderer (seule API disponible sans binaire natif) et arrive ici par
// IPC, en paquets irréguliers. On ne le transmet PAS tel quel à ffmpeg.
//
// Le flux est CADENCÉ SUR L'HORLOGE MURALE : à chaque tick on écrit exactement
// ce que le temps écoulé exige, en puisant dans la file et en complétant par du
// silence si le renderer est en retard. Deux propriétés en découlent, et elles
// sont toutes les deux indispensables :
//
//   1. La piste audio ne dérive pas de la vidéo, qui est encodée en CFR. Sans
//      ça, l'écart entre l'horloge du périphérique audio et celle du système
//      désynchroniserait le son après quelques heures de captation continue.
//   2. Un hoquet du renderer (page fermée, onglet gelé, GC) ne peut jamais
//      faire caler ffmpeg. C'est vital : ffmpeg attendrait des échantillons et
//      la captation VIDÉO s'arrêterait avec lui.
//
// ffmpeg lit le flux comme un fichier, sur un tube nommé (Windows) ou une
// socket unix (dev macOS).

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const BLOCK_ALIGN = CHANNELS * BYTES_PER_SAMPLE;
const BYTES_PER_SECOND = SAMPLE_RATE * BLOCK_ALIGN;
const TICK_MS = 100;
// Plafond de la file. Le renderer produit légèrement plus vite ou moins vite
// que l'horloge système (deux horloges distinctes) : sans plafond, un excédent
// s'accumulerait indéfiniment et le son prendrait du retard sur l'image. On
// jette le plus ANCIEN, pour rester au plus près du direct.
const MAX_BACKLOG_BYTES = BYTES_PER_SECOND;

const PIPE_PATH =
    process.platform === 'win32'
        ? '\\\\.\\pipe\\ebp-arena-audio'
        : path.join(os.tmpdir(), 'ebp-arena-audio.sock');

let server = null;
let client = null;
/** Paquets PCM en attente, plus l'offset de lecture du premier. */
let queue = [];
let queuedBytes = 0;
let queueHead = 0;
let writtenBytes = 0;
let pacedFrom = 0;
let timer = null;
let silenceBlock = Buffer.alloc(BYTES_PER_SECOND, 0);
let receivedBytes = 0;
// L'écriture n'est ARMÉE qu'à la première image vidéo. Les deux pistes sont
// horodatées à partir de leur premier échantillon : commencer à écrire du son
// dès l'ouverture du tube, alors que ffmpeg met encore quelques secondes à
// initialiser D3D11, le filtergraph et NVENC, plaçait le son en avance de tout
// ce temps de démarrage — mesuré à ~3 s sur un poste réel.
let pacing = false;

/**
 * Ouvre le tube. ffmpeg s'y connecte ensuite comme un lecteur de fichier ; le
 * serveur reste à l'écoute pour qu'un redémarrage de ffmpeg se reconnecte seul.
 */
function start() {
    if (server) return PIPE_PATH;
    if (process.platform !== 'win32' && fs.existsSync(PIPE_PATH)) {
        fs.unlinkSync(PIPE_PATH);
    }
    server = net.createServer((socket) => {
        // Un seul consommateur : si ffmpeg s'était mal terminé, on abandonne
        // l'ancienne socket au profit de la nouvelle.
        if (client) client.destroy();
        client = socket;
        socket.on('error', () => {});
        socket.on('close', () => {
            if (client === socket) client = null;
        });
    });
    server.on('error', (e) => {
        console.error('[arena-audio] pipe error:', e.message);
    });
    server.listen(PIPE_PATH);
    timer = setInterval(pump, TICK_MS);
    console.log(`[arena-audio] listening on ${PIPE_PATH}`);
    return PIPE_PATH;
}

/**
 * Arme l'écriture : appelé quand la captation confirme sa première image. La
 * file est vidée au passage — elle contient du son déjà ancien, qui serait
 * placé au tout début de l'enregistrement.
 */
function beginPacing() {
    if (pacing) return;
    resetPacing();
    pacing = true;
    console.log('[arena-audio] pacing armed on first video frame');
}

function resetPacing() {
    pacedFrom = Date.now();
    writtenBytes = 0;
    queue = [];
    queuedBytes = 0;
    queueHead = 0;
}

function stop() {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
    if (client) {
        client.destroy();
        client = null;
    }
    if (server) {
        server.close();
        server = null;
    }
    resetPacing();
    pacing = false;
    receivedBytes = 0;
    console.log('[arena-audio] stopped');
}

/**
 * PCM reçu du renderer (s16le, 48 kHz, stéréo entrelacé).
 * @param {Buffer|Uint8Array} chunk
 */
function writeChunk(chunk) {
    if (!server || !chunk || !chunk.length) return;
    receivedBytes += chunk.length;
    queue.push(Buffer.from(chunk));
    queuedBytes += chunk.length;
    while (queuedBytes > MAX_BACKLOG_BYTES && queue.length > 1) {
        const DROPPED = queue.shift();
        queuedBytes -= DROPPED.length - queueHead;
        queueHead = 0;
    }
}

/** Écrit ce que le temps écoulé exige, en complétant par du silence. */
function pump() {
    if (!client || !pacing) return;
    const ELAPSED_MS = Date.now() - pacedFrom;
    const TARGET =
        Math.floor((ELAPSED_MS / 1000) * BYTES_PER_SECOND / BLOCK_ALIGN) *
        BLOCK_ALIGN;
    let need = TARGET - writtenBytes;
    if (need <= 0) return;

    while (need > 0 && queue.length) {
        const HEAD = queue[0];
        const AVAILABLE = HEAD.length - queueHead;
        const TAKE = Math.min(AVAILABLE, need);
        client.write(HEAD.subarray(queueHead, queueHead + TAKE));
        queueHead += TAKE;
        queuedBytes -= TAKE;
        writtenBytes += TAKE;
        need -= TAKE;
        if (queueHead >= HEAD.length) {
            queue.shift();
            queueHead = 0;
        }
    }
    if (need > 0) {
        if (silenceBlock.length < need) silenceBlock = Buffer.alloc(need, 0);
        client.write(silenceBlock.subarray(0, need));
        writtenBytes += need;
    }
}

function getPipePath() {
    return PIPE_PATH;
}

/** Diagnostic : le renderer alimente-t-il réellement le tube ? */
function getStatus() {
    return {
        running: !!server,
        connected: !!client,
        receivedBytes,
        sampleRate: SAMPLE_RATE,
        channels: CHANNELS
    };
}

module.exports = {
    start,
    beginPacing,
    stop,
    writeChunk,
    getPipePath,
    getStatus,
    SAMPLE_RATE,
    CHANNELS
};
