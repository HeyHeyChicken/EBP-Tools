// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const fs = require('fs');
const path = require('node:path');

//#endregion

/**
 * Safely deletes a file/folder if it exists, with Unicode normalization for proper file path handling.
 * @param path The file/folder path to delete.
 */
function unlinkSync(path) {
    const NORMALIZED_CUT_PATH = path.normalize('NFC');
    if (fs.existsSync(NORMALIZED_CUT_PATH)) {
        const STAT = fs.statSync(NORMALIZED_CUT_PATH);
        if (STAT.isDirectory()) {
            fs.rmSync(NORMALIZED_CUT_PATH, { recursive: true });
        } else {
            fs.unlinkSync(NORMALIZED_CUT_PATH);
        }
    }
}

/**
 * Sanitizes a map name for use in a filename: non-alphanumerics collapsed to
 * dashes, trimmed. Shared by the watch-folder cuts and the arena pipeline
 * (S3 filename convention: no underscores inside values).
 * @param {string} mapName Raw map name ('' or nullish → 'unknown').
 */
function safeMapName(mapName) {
    return (mapName || 'unknown')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

module.exports = {
    unlinkSync,
    safeMapName
};
