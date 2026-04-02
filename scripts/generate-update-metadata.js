// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Generate metadata files for electron-updater
 */
function generateUpdateMetadata(version, platform) {
    const RELEASE_DIR = path.join(__dirname, '..', 'out', 'make');

    if (platform === 'darwin') {
        const DMG_FILE = `EBP-Tools-${version}.dmg`;
        const DMG_PATH = path.join(RELEASE_DIR, DMG_FILE);

        if (!fs.existsSync(DMG_PATH)) {
            console.error(`DMG file not found: ${DMG_PATH}`);
            return;
        }

        const FILE_STATS = fs.statSync(DMG_PATH);
        const FILE_BUFFER = fs.readFileSync(DMG_PATH);
        const SHA512 = crypto
            .createHash('sha512')
            .update(FILE_BUFFER)
            .digest('base64');

        const MAC_METADATA = {
            version: version,
            files: [
                {
                    url: `EBP-Tools-${version}.dmg`,
                    sha512: SHA512,
                    size: FILE_STATS.size
                }
            ],
            path: `EBP-Tools-${version}.dmg`,
            sha512: SHA512,
            releaseDate: new Date().toISOString()
        };

        const YAML_CONTENT = `version: ${MAC_METADATA.version}
files:
  - url: ${MAC_METADATA.files[0].url}
    sha512: ${MAC_METADATA.files[0].sha512}
    size: ${MAC_METADATA.files[0].size}
path: ${MAC_METADATA.path}
sha512: ${MAC_METADATA.sha512}
releaseDate: '${MAC_METADATA.releaseDate}'
`;

        const OUTPUT_PATH = path.join(RELEASE_DIR, 'latest-mac.yml');
        fs.writeFileSync(OUTPUT_PATH, YAML_CONTENT);
        console.log(`Generated: ${OUTPUT_PATH}`);
    } else if (platform === 'win32') {
        const RELEASES_PATH = path.join(
            RELEASE_DIR,
            'squirrel.windows',
            'x64',
            'RELEASES'
        );
        const NUPKG_PATTERN = /ebp_tools-.*\.nupkg/;

        if (!fs.existsSync(RELEASES_PATH)) {
            console.error(`RELEASES file not found: ${RELEASES_PATH}`);
            return;
        }

        const RELEASES_CONTENT = fs.readFileSync(RELEASES_PATH, 'utf-8');
        const NUPKG_MATCH = RELEASES_CONTENT.match(NUPKG_PATTERN);

        if (!NUPKG_MATCH) {
            console.error('Could not find nupkg filename in RELEASES file');
            return;
        }

        const NUPKG_FILE = NUPKG_MATCH[0];
        const NUPKG_PATH = path.join(
            RELEASE_DIR,
            'squirrel.windows',
            'x64',
            NUPKG_FILE
        );

        if (!fs.existsSync(NUPKG_PATH)) {
            console.error(`NUPKG file not found: ${NUPKG_PATH}`);
            return;
        }

        const FILE_STATS = fs.statSync(NUPKG_PATH);
        const FILE_BUFFER = fs.readFileSync(NUPKG_PATH);
        const SHA512 = crypto
            .createHash('sha512')
            .update(FILE_BUFFER)
            .digest('base64');

        const WIN_METADATA = {
            version: version,
            files: [
                {
                    url: NUPKG_FILE,
                    sha512: SHA512,
                    size: FILE_STATS.size
                }
            ],
            path: NUPKG_FILE,
            sha512: SHA512,
            releaseDate: new Date().toISOString()
        };

        const YAML_CONTENT = `version: ${WIN_METADATA.version}
files:
  - url: ${WIN_METADATA.files[0].url}
    sha512: ${WIN_METADATA.files[0].sha512}
    size: ${WIN_METADATA.files[0].size}
path: ${WIN_METADATA.path}
sha512: ${WIN_METADATA.sha512}
releaseDate: '${WIN_METADATA.releaseDate}'
`;

        const OUTPUT_PATH = path.join(
            RELEASE_DIR,
            'squirrel.windows',
            'x64',
            'latest.yml'
        );
        fs.writeFileSync(OUTPUT_PATH, YAML_CONTENT);
        console.log(`Generated: ${OUTPUT_PATH}`);
    }
}

// Parse command line arguments
const VERSION = process.argv[2];
const PLATFORM = process.argv[3];

if (!VERSION || !PLATFORM) {
    console.error(
        'Usage: node generate-update-metadata.js <version> <platform>'
    );
    console.error('Example: node generate-update-metadata.js 1.6.58 darwin');
    process.exit(1);
}

generateUpdateMetadata(VERSION, PLATFORM);
