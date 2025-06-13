// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const rpc = require('discord-rpc');

//#endregion

const CLIENT_ID = '1383002798882291722';
const RPC = new rpc.Client({ transport: 'ipc' });

RPC.on('ready', () => {
    console.log('[DISCORD RPC] Connection successful.');
    RPC.setActivity({
        details: "Working on my strategies...",
        state: 'https://ebp.gg',
        startTimestamp: new Date(),
        largeImageKey: 'logo',
        largeImageText: 'EBP - Tools',
        smallImageText: 'EBP - Tools',
        instance: false,
    });
});

RPC.login({ clientId: CLIENT_ID }).catch(err => {
    console.error('[DISCORD RPC] Connection error:', err);
});
