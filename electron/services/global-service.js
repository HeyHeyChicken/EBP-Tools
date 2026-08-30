// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const fs = require('fs');
const os = require('os');
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

/**
 * Passe un process enfant en priorité BELOW_NORMAL (cross-platform via
 * os.setPriority ; BELOW_NORMAL_PRIORITY_CLASS sous Windows). Utilisé par le
 * mode salle : sur le PC de streaming d'une salle, les traitements ne doivent
 * JAMAIS faire ramer les logiciels de prod — l'OS leur donne les cycles
 * restants, ils s'allongent seulement quand la machine est occupée. À noter :
 * ne baisse que la priorité CPU, pas les I/O disque.
 * @param {import('child_process').ChildProcess} child Process fraîchement spawn.
 * @param {string} label Préfixe de log en cas d'échec.
 */
function lowerProcessPriority(child, label) {
    try {
        os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch (e) {
        console.warn(`[${label}] setPriority failed:`, e.message);
    }
}

module.exports = {
    unlinkSync,
    safeMapName,
    lowerProcessPriority
};
