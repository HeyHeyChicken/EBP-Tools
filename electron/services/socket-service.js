// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const { io } = require('socket.io-client');

//#endregion

const IS_DEV_MODE = process.env.NODE_ENV !== 'production';

const SOCKET = io(
    IS_DEV_MODE ? 'http://localhost:3005' : 'https://evabattleplan.com/',
    {
        reconnection: true
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
