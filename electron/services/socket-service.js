// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const { io } = require('socket.io-client');

//#endregion

const IS_DEV_MODE = process.env.NODE_ENV !== 'production';
// Même bascule que le client REST : `EBP_TARGET=prod` vise la prod sans quitter
// le mode dev (cf. tools-api-client). Les deux doivent viser le MÊME serveur,
// sinon un appel REST déclenche un broadcast socket que ce front n'écoute pas.
const USE_PROD = !IS_DEV_MODE || process.env.EBP_TARGET === 'prod';

const SOCKET = io(
    USE_PROD ? 'https://evabattleplan.com/' : 'http://localhost:3005',
    {
        reconnection: true,
        transports: ['websocket']
    }
);

SOCKET.on('connect', () => {
    console.log('[SOCKET] Connected:', SOCKET.id);
});

SOCKET.on('connect_error', (err) => {
    console.error('[SOCKET] Connection error:', err.message);
});

function emit(sessionID, path, value) {
    if (sessionID) {
        SOCKET.emit('tools_to_client', {
            sessionID: sessionID,
            path: path,
            value: value
        });
    }
}

module.exports = emit;
