// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

const webpack = require('webpack');

// Dépôt interrogé pour les mises à jour, figé au moment de la construction.
// Non défini, il vaut la production : une build du banc d'essai le surcharge
// par TOOLS_UPDATE_REPOSITORY sans jamais toucher au code, car une valeur de
// test commitée puis fusionnée dans la prod dérouterait tous les clients
// installés vers un dépôt qu'ils ne peuvent pas lire.
const UPDATE_REPOSITORY =
    process.env.TOOLS_UPDATE_REPOSITORY || 'EBP-gg/Tools';

module.exports = {
    /**
     * This is the main entry point for your application, it's the first file
     * that runs in the main process.
     */
    entry: './electron/server.js',
    // Put your normal webpack config below here
    module: {
        rules: require('./webpack.rules')
    },
    plugins: [
        new webpack.DefinePlugin({
            'process.env.TOOLS_UPDATE_REPOSITORY':
                JSON.stringify(UPDATE_REPOSITORY)
        })
    ]
};
