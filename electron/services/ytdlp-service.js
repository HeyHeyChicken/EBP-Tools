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
 * Service for managing yt-dlp binary (download, update, path resolution)
 */
class YtDlpService {
    constructor() {
        this.OS_PLATFORM = os.platform();
        this.GITHUB_API_URL =
            'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest';
    }

    /**
     * Get the path to yt-dlp binary in userData
     * @returns {string} Path to yt-dlp executable
     */
    getYtDlpPath() {
        const FILENAME = this.OS_PLATFORM === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
        return path.join(app.getPath('userData'), FILENAME);
    }

    /**
     * Ensure yt-dlp is available and up-to-date
     * Downloads if not present, updates if outdated
     * @param {Function} onProgress - Progress callback (percent, message)
     * @returns {Promise<string>} Path to the ready-to-use yt-dlp binary
     */
    async ensureYtDlp(onProgress = () => {}) {
        const YT_DLP_PATH = this.getYtDlpPath();
        const EXISTS = fs.existsSync(YT_DLP_PATH);

        if (!EXISTS) {
            // Download yt-dlp for the first time
            console.log('[YT-DLP] Binary not found, downloading...');
            onProgress(0, 'downloading');

            const LATEST_VERSION = await this.getLatestVersion();
            await this.downloadYtDlp(LATEST_VERSION, onProgress);

            console.log('[YT-DLP] Download complete.');
            return YT_DLP_PATH;
        }

        // Le binaire présent est-il exploitable ? Un téléchargement interrompu
        // laisse un fichier tronqué, que la seule vérification d'existence
        // ci-dessus considère comme valide. On le remplace, au lieu de rendre
        // un chemin qui échouera à chaque usage.
        let localVersion;
        try {
            localVersion = await this.getLocalVersion();
        } catch (error) {
            console.warn(
                '[YT-DLP] Local binary unusable, downloading again:',
                error.message
            );
            onProgress(0, 'downloading');

            const LATEST_VERSION = await this.getLatestVersion();
            await this.downloadYtDlp(LATEST_VERSION, onProgress);

            return YT_DLP_PATH;
        }

        // Check for updates
        try {
            const LATEST_VERSION = await this.getLatestVersion();

            console.log(`[YT-DLP] Local version: ${localVersion}`);
            console.log(`[YT-DLP] Latest version: ${LATEST_VERSION}`);

            if (localVersion !== LATEST_VERSION) {
                console.log('[YT-DLP] Update available, downloading...');
                onProgress(0, 'updating');

                await this.downloadYtDlp(LATEST_VERSION, onProgress);

                console.log('[YT-DLP] Update complete.');
            } else {
                console.log('[YT-DLP] Already up to date.');
            }
        } catch (error) {
            console.warn(
                '[YT-DLP] Could not check for updates:',
                error.message
            );
            // Continue with existing binary if update check fails
        }

        return YT_DLP_PATH;
    }

    /**
     * Download yt-dlp binary from GitHub releases
     * @param {string} version - Version tag to download (e.g., "2024.12.23")
     * @param {Function} onProgress - Progress callback (percent, message)
     * @returns {Promise<void>}
     */
    async downloadYtDlp(version, onProgress = () => {}) {
        const ASSET_NAMES = {
            win32: 'yt-dlp.exe',
            darwin: 'yt-dlp_macos',
            linux: 'yt-dlp_linux'
        };
        const ASSET_NAME = ASSET_NAMES[this.OS_PLATFORM] || 'yt-dlp_linux';
        const DOWNLOAD_URL = `https://github.com/yt-dlp/yt-dlp/releases/download/${version}/${ASSET_NAME}`;
        const OUTPUT_PATH = this.getYtDlpPath();
        // Le binaire n'apparaît à son emplacement final qu'entier : on écrit
        // dans un temporaire et on renomme. Une interruption ne laisse alors
        // qu'un `.part` ignoré, jamais un yt-dlp tronqué.
        const TEMPORARY_PATH = `${OUTPUT_PATH}.part`;

        console.log(`[YT-DLP] Downloading from: ${DOWNLOAD_URL}`);

        return new Promise((resolve, reject) => {
            const FILE = fs.createWriteStream(TEMPORARY_PATH);

            const REQUEST = https.get(DOWNLOAD_URL, (response) => {
                // Handle redirects (GitHub uses redirects for releases)
                if (
                    response.statusCode >= 300 &&
                    response.statusCode < 400 &&
                    response.headers.location
                ) {
                    FILE.close();
                    if (fs.existsSync(TEMPORARY_PATH)) {
                        fs.unlinkSync(TEMPORARY_PATH);
                    }

                    // Create a new write stream for the redirected request
                    const REDIRECTED_FILE =
                        fs.createWriteStream(TEMPORARY_PATH);

                    https
                        .get(
                            response.headers.location,
                            (redirectedResponse) => {
                                this._handleDownloadResponse(
                                    redirectedResponse,
                                    REDIRECTED_FILE,
                                    TEMPORARY_PATH,
                                    OUTPUT_PATH,
                                    onProgress,
                                    resolve,
                                    reject
                                );
                            }
                        )
                        .on('error', (err) => {
                            REDIRECTED_FILE.close();
                            if (fs.existsSync(TEMPORARY_PATH)) {
                                fs.unlinkSync(TEMPORARY_PATH);
                            }
                            reject(err);
                        });
                    return;
                }

                this._handleDownloadResponse(
                    response,
                    FILE,
                    TEMPORARY_PATH,
                    OUTPUT_PATH,
                    onProgress,
                    resolve,
                    reject
                );
            });

            REQUEST.on('error', (err) => {
                FILE.close();
                if (fs.existsSync(TEMPORARY_PATH)) {
                    fs.unlinkSync(TEMPORARY_PATH);
                }
                reject(err);
            });
        });
    }

    /**
     * Handle the download response and write to file
     * @private
     */
    _handleDownloadResponse(
        response,
        file,
        temporaryPath,
        outputPath,
        onProgress,
        resolve,
        reject
    ) {
        if (response.statusCode !== 200) {
            file.close();
            if (fs.existsSync(temporaryPath)) {
                fs.unlinkSync(temporaryPath);
            }
            reject(
                new Error(
                    `Failed to download yt-dlp: HTTP ${response.statusCode}`
                )
            );
            return;
        }

        const TOTAL_SIZE = parseInt(response.headers['content-length'], 10);
        let downloadedSize = 0;

        response.on('data', (chunk) => {
            downloadedSize += chunk.length;
            if (TOTAL_SIZE) {
                const PERCENT = Math.round((downloadedSize / TOTAL_SIZE) * 100);
                onProgress(PERCENT, 'downloading');
            }
        });

        response.pipe(file);

        file.on('finish', () => {
            file.close(() => {
                // Make executable on macOS and Linux
                if (
                    this.OS_PLATFORM === 'darwin' ||
                    this.OS_PLATFORM === 'linux'
                ) {
                    try {
                        fs.chmodSync(temporaryPath, 0o755);
                        console.log('[YT-DLP] Made binary executable');
                    } catch (err) {
                        console.error(
                            '[YT-DLP] Failed to make binary executable:',
                            err
                        );
                    }
                }

                try {
                    // Remplace l'éventuel binaire précédent (mise à jour).
                    fs.renameSync(temporaryPath, outputPath);
                } catch (err) {
                    if (fs.existsSync(temporaryPath)) {
                        fs.unlinkSync(temporaryPath);
                    }
                    reject(err);
                    return;
                }

                resolve();
            });
        });

        file.on('error', (err) => {
            file.close();
            if (fs.existsSync(temporaryPath)) {
                fs.unlinkSync(temporaryPath);
            }
            reject(err);
        });
    }

    /**
     * Get the local yt-dlp version
     * @returns {Promise<string>} Version string (e.g., "2024.12.23")
     */
    getLocalVersion() {
        return new Promise((resolve, reject) => {
            const YT_DLP_PATH = this.getYtDlpPath();

            if (!fs.existsSync(YT_DLP_PATH)) {
                reject(new Error('yt-dlp binary not found'));
                return;
            }

            execFile(YT_DLP_PATH, ['--version'], (error, stdout, stderr) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(stdout.trim());
            });
        });
    }

    /**
     * Get the latest yt-dlp version from GitHub API
     * @returns {Promise<string>} Latest version tag (e.g., "2024.12.23")
     */
    getLatestVersion() {
        return new Promise((resolve, reject) => {
            https
                .get(
                    this.GITHUB_API_URL,
                    {
                        headers: { 'User-Agent': 'EBP-Tools' }
                    },
                    (res) => {
                        let data = '';

                        res.on('data', (chunk) => {
                            data += chunk;
                        });

                        res.on('end', () => {
                            try {
                                const RELEASE = JSON.parse(data);
                                if (RELEASE.tag_name) {
                                    resolve(RELEASE.tag_name);
                                } else {
                                    reject(
                                        new Error(
                                            'Could not find version in GitHub response'
                                        )
                                    );
                                }
                            } catch (err) {
                                reject(
                                    new Error(
                                        'Failed to parse GitHub API response'
                                    )
                                );
                            }
                        });
                    }
                )
                .on('error', reject);
        });
    }
}

module.exports = new YtDlpService();
