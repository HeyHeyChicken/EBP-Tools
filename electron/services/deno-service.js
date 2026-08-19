// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

const os = require('os');
const path = require('node:path');
const fs = require('fs');
const https = require('https');
const { execFile } = require('child_process');
const { app } = require('electron');

/**
 * Service for managing the Deno binary (download, extraction, path resolution).
 * Deno is the JavaScript runtime yt-dlp needs to solve YouTube's player
 * challenges (EJS); without it, YouTube extraction fails or misses formats.
 */
class DenoService {
    constructor() {
        this.OS_PLATFORM = os.platform();
        this.OS_ARCH = os.arch();
    }

    /**
     * Get the path to the Deno binary in userData
     * @returns {string} Path to Deno executable
     */
    getDenoPath() {
        const FILENAME = this.OS_PLATFORM === 'win32' ? 'deno.exe' : 'deno';
        return path.join(app.getPath('userData'), FILENAME);
    }

    /**
     * Ensure Deno is available, downloading it on first use.
     * Unlike yt-dlp, Deno does not need to track YouTube changes, so no
     * update check is performed once the binary is present — seulement un
     * contrôle qu'il s'exécute.
     * @returns {Promise<string>} Path to the ready-to-use Deno binary
     */
    async ensureDeno() {
        const DENO_PATH = this.getDenoPath();

        if (fs.existsSync(DENO_PATH)) {
            if (await this._isUsable(DENO_PATH)) {
                return DENO_PATH;
            }
            console.warn('[DENO] Local binary unusable, downloading again.');
        } else {
            console.log('[DENO] Binary not found, downloading...');
        }

        await this.downloadDeno();
        console.log('[DENO] Download complete.');
        return DENO_PATH;
    }

    /**
     * Check that the binary in place actually runs. The atomic extraction
     * makes a truncated binary impossible to produce, but one left by a
     * version of the app that predates it would otherwise pass for valid,
     * `ensureDeno` testing only its presence.
     * @private
     * @param {string} denoPath Path to the Deno binary.
     * @returns {Promise<boolean>} True if the binary answers `--version`.
     */
    _isUsable(denoPath) {
        return new Promise((resolve) => {
            try {
                execFile(denoPath, ['--version'], { timeout: 10000 }, (error) =>
                    resolve(!error)
                );
            } catch (error) {
                // `spawn` échoue de façon synchrone quand le fichier n'est pas
                // un exécutable valide (ENOEXEC) — le cas même qu'on cherche à
                // détecter, donc il ne doit pas remonter.
                resolve(false);
            }
        });
    }

    /**
     * Download the latest Deno release zip from GitHub and extract the binary
     * into userData
     * @returns {Promise<void>}
     */
    async downloadDeno() {
        const DOWNLOAD_URL = `https://github.com/denoland/deno/releases/latest/download/${this._getAssetName()}`;
        const ZIP_PATH = path.join(app.getPath('userData'), 'deno.zip');
        const DENO_PATH = this.getDenoPath();
        // On extrait dans un dossier temporaire : le binaire n'apparaît à son
        // emplacement final qu'entier, par un renommage. Sans ça, une
        // extraction interrompue laisse un deno tronqué, que `ensureDeno`
        // considère comme valide puisqu'il ne teste que sa présence.
        const TEMPORARY_DIR = path.join(app.getPath('userData'), 'deno.part');

        console.log(`[DENO] Downloading from: ${DOWNLOAD_URL}`);

        try {
            fs.rmSync(TEMPORARY_DIR, { recursive: true, force: true });
            fs.mkdirSync(TEMPORARY_DIR, { recursive: true });

            await this._downloadFile(DOWNLOAD_URL, ZIP_PATH);
            await this._extractZip(ZIP_PATH, TEMPORARY_DIR);

            const EXTRACTED_PATH = path.join(
                TEMPORARY_DIR,
                path.basename(DENO_PATH)
            );
            if (!fs.existsSync(EXTRACTED_PATH)) {
                throw new Error('Deno binary missing after extraction');
            }
            if (this.OS_PLATFORM !== 'win32') {
                fs.chmodSync(EXTRACTED_PATH, 0o755);
            }
            fs.renameSync(EXTRACTED_PATH, DENO_PATH);
        } finally {
            fs.rmSync(ZIP_PATH, { force: true });
            fs.rmSync(TEMPORARY_DIR, { recursive: true, force: true });
        }
    }

    /**
     * Get the Deno release asset name for the current platform/architecture
     * @private
     * @returns {string} Asset file name
     */
    _getAssetName() {
        if (this.OS_PLATFORM === 'win32') {
            return 'deno-x86_64-pc-windows-msvc.zip';
        }
        const RUST_ARCH = this.OS_ARCH === 'arm64' ? 'aarch64' : 'x86_64';
        if (this.OS_PLATFORM === 'darwin') {
            return `deno-${RUST_ARCH}-apple-darwin.zip`;
        }
        return `deno-${RUST_ARCH}-unknown-linux-gnu.zip`;
    }

    /**
     * Download a file, following GitHub redirects
     * @private
     * @returns {Promise<void>}
     */
    _downloadFile(url, outputPath, redirectsLeft = 5) {
        return new Promise((resolve, reject) => {
            https
                .get(
                    url,
                    { headers: { 'User-Agent': 'EBP-Tools' } },
                    (response) => {
                        if (
                            response.statusCode >= 300 &&
                            response.statusCode < 400 &&
                            response.headers.location
                        ) {
                            response.resume();
                            if (redirectsLeft === 0) {
                                reject(new Error('Too many redirects'));
                                return;
                            }
                            resolve(
                                this._downloadFile(
                                    response.headers.location,
                                    outputPath,
                                    redirectsLeft - 1
                                )
                            );
                            return;
                        }
                        if (response.statusCode !== 200) {
                            response.resume();
                            reject(
                                new Error(
                                    `Failed to download Deno: HTTP ${response.statusCode}`
                                )
                            );
                            return;
                        }

                        const FILE = fs.createWriteStream(outputPath);
                        response.pipe(FILE);
                        FILE.on('finish', () => FILE.close(resolve));
                        FILE.on('error', (err) => {
                            FILE.close();
                            if (fs.existsSync(outputPath)) {
                                fs.unlinkSync(outputPath);
                            }
                            reject(err);
                        });
                    }
                )
                .on('error', reject);
        });
    }

    /**
     * Extract a zip archive using system tools: bsdtar handles zip files on
     * Windows 10+ and macOS; GNU tar does not, so unzip is used on Linux.
     * @private
     * @returns {Promise<void>}
     */
    _extractZip(zipPath, destDir) {
        const [COMMAND, ARGS] =
            this.OS_PLATFORM === 'linux'
                ? ['unzip', ['-o', zipPath, '-d', destDir]]
                : ['tar', ['-xf', zipPath, '-C', destDir]];
        return new Promise((resolve, reject) => {
            execFile(COMMAND, ARGS, (error) =>
                error ? reject(error) : resolve()
            );
        });
    }
}

module.exports = new DenoService();
