// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const https = require('https');
const fs = require('fs');
const os = require('os');
const { version } = require('../../package.json');
const { app, dialog, autoUpdater: NATIVE } = require('electron');
const path = require('node:path');
const { spawn } = require('child_process');
const {
    getMainWindow,
    createFloatingWindow,
    deleteFloatingWindow
} = require('../core/window-manager');
const {
    IS_DEV_MODE,
    UPDATE_REPOSITORY,
    UPDATE_FEED_URL
} = require('../config/constants');
const telemetryService = require('./telemetry-service');

//#endregion

// Cadence des vérifications quand l'app tourne. Assez espacé pour être
// invisible, assez fréquent pour qu'un poste allumé toute la journée reçoive
// une version publiée le matin.
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

// Nombre d'échecs consécutifs du chemin natif avant de basculer sur le flux
// maison. Un incident ponctuel — réseau qui cligne, stockage momentanément
// indisponible — ne doit pas condamner le chemin léger et faire retélécharger
// 148 Mo. À la cadence de quatre heures, trois échecs représentent une
// demi-journée : c'est une panne, plus un incident.
const NATIVE_FAILURE_LIMIT = 3;

class UpdateService {
    githubVersion = '';
    // L'updater natif a-t-il déjà été câblé, et a-t-il échoué ? Un échec fait
    // repasser définitivement ce poste sur le flux maison : mieux vaut le
    // chemin lent que plus de chemin du tout.
    #nativeReady = false;
    #nativeFailed = false;
    // Version téléchargée et prête, en attente du prochain démarrage. Sert au
    // menu du tray : sans elle, rien n'indique qu'une mise à jour attend.
    pendingVersion = undefined;
    #checkTimer = null;
    // Une vérification Squirrel est-elle en cours ? Sans ce garde, deux appels
    // rapprochés se marchent dessus et le second échoue.
    #checking = false;
    #nativeFailures = 0;

    constructor() {
        this.localVersion = version;
    }

    /**
     * Mise à jour Windows par Squirrel, le mécanisme natif de l'installeur.
     *
     * On ne demande JAMAIS `quitAndInstall` : Squirrel dépose la nouvelle
     * version dans un dossier versionné à côté, et le lanceur la prend au
     * démarrage suivant. Ne pas forcer le redémarrage supprime toute modale et
     * n'interrompt jamais une analyse en cours — c'est le comportement qu'on
     * envie à Discord, et c'est aussi le moins risqué.
     *
     * Le succès n'est pas signalé : c'est l'événement `launch` suivant, portant
     * la nouvelle version, qui le prouve mieux qu'un événement émis d'avance.
     */
    #checkNative() {
        if (!this.#nativeReady) {
            // Squirrel.Mac attend un manifeste JSON et veut qu'on le dise ;
            // Squirrel.Windows attend un dossier dans lequel il cherche
            // RELEASES lui-même.
            NATIVE.setFeedURL(
                os.platform() === 'darwin'
                    ? { url: UPDATE_FEED_URL, serverType: 'json' }
                    : { url: UPDATE_FEED_URL }
            );

            NATIVE.on('checking-for-update', () => {
                console.log(`[update] native: checking ${UPDATE_FEED_URL}`);
            });

            NATIVE.on('update-not-available', () => {
                this.#checking = false;
                this.#nativeFailures = 0;
                console.log(
                    `[update] native: up to date (${this.localVersion})`
                );
            });

            NATIVE.on('update-available', () => {
                console.log('[update] native: update available, downloading');
                telemetryService.reportUpdate('update_available', {
                    feed: UPDATE_FEED_URL
                });
            });

            // Sous Windows, `releaseName` porte la version. Sans elle, le log
            // ne dirait pas CE QUI attend, ce qui est justement l'information
            // utile quand une mise à jour ne s'applique pas.
            NATIVE.on(
                'update-downloaded',
                (event, releaseNotes, releaseName) => {
                    this.#checking = false;
                    this.#nativeFailures = 0;
                    this.pendingVersion = releaseName || 'inconnue';
                    console.log(
                        `[update] native: ${this.pendingVersion} installée, ` +
                            'sera appliquée au prochain démarrage'
                    );
                }
            );

            NATIVE.on('error', (error) => {
                this.#checking = false;

                // Squirrel refuse une vérification quand la précédente tourne
                // encore. Ce n'est pas une panne : c'est notre propre appel
                // concurrent. Le compter comme un échec ferait basculer le
                // poste sur le flux maison — donc retélécharger l'installeur
                // entier — alors que le téléchargement en cours va aboutir.
                if (/already running/i.test(error.message)) {
                    console.log(
                        '[update] native: check already in progress, ignored'
                    );
                    return;
                }

                this.#nativeFailures += 1;
                console.error(
                    `[update] native failed (${this.#nativeFailures}/${NATIVE_FAILURE_LIMIT}):`,
                    error.message
                );
                telemetryService.reportUpdate('update_failed', {
                    reason: `native: ${error.message}`
                });

                // Repli seulement après plusieurs échecs consécutifs : un poste
                // ne doit jamais rester sans chemin de mise à jour, mais un
                // incident ponctuel ne justifie pas d'abandonner le chemin léger.
                if (this.#nativeFailures >= NATIVE_FAILURE_LIMIT) {
                    this.#nativeFailed = true;
                    console.error('[update] native abandoned, falling back');
                    this.autoUpdate(true);
                }
            });

            this.#nativeReady = true;
        }

        if (this.#checking) {
            console.log('[update] native: check already in progress, skipped');
            return;
        }

        this.#checking = true;
        NATIVE.checkForUpdates();
    }

    //#region Functions

    /**
     * Mode salle : mise à jour FORCÉE, sans aucun dialogue ni UI — ordonnée
     * par un admin via le heartbeat, à exécuter immédiatement (le PC de salle
     * tourne sans humain ; sous Windows l'installeur Squirrel est silencieux
     * et relance l'app tout seul). No-op si déjà à jour ou en dev.
     */
    forceUpdate() {
        if (IS_DEV_MODE || this.localVersion.startsWith('0')) return;
        this.getProjectLatestVersion(() => {
            if (!this.githubVersion || this.githubVersion === this.localVersion) {
                return;
            }
            const NAMES = this.#assetNames();
            if (!NAMES) return;
            console.log(
                `[update] forced update ${this.localVersion} → ${this.githubVersion}`
            );
            telemetryService.reportUpdate('update_available', {
                target: this.githubVersion,
                forced: true
            });
            this.#downloadAndInstall(NAMES);
        });
    }

    /**
     * Noms de l'asset GitHub et du fichier local d'installation pour la
     * plateforme courante. Null si plateforme non gérée.
     */
    #assetNames() {
        switch (os.platform()) {
            case 'win32':
                return {
                    githubFileName: `EBP-Tools-${this.githubVersion}.exe`,
                    localFileName: 'update.exe'
                };
            case 'darwin': {
                const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
                return {
                    githubFileName: `EBP-Tools-${this.githubVersion}-${ARCH}.dmg`,
                    localFileName: 'update.dmg'
                };
            }
        }
        return null;
    }

    /**
     * Télécharge l'installeur de `githubVersion` puis le lance et quitte
     * l'app. Partagé entre le flux interactif (autoUpdate) et le flux forcé
     * du mode salle.
     */
    #downloadAndInstall({ githubFileName, localFileName }) {
        const FILE_URL = `https://github.com/${UPDATE_REPOSITORY}/releases/download/${this.githubVersion}/${githubFileName}`;
        const DESTINATION_PATH = path.join(
            app.getPath('userData'),
            localFileName
        );
        telemetryService.reportUpdate('update_started', {
            target: this.githubVersion
        });

        const ON_ERROR = (reason) => {
            console.error(`[update] download failed: ${reason}`);
            telemetryService.reportUpdate('update_failed', {
                target: this.githubVersion,
                reason
            });
        };

        this.#download(FILE_URL, DESTINATION_PATH, () => {
            switch (os.platform()) {
                case 'win32':
                    spawn(DESTINATION_PATH, {
                        detached: true,
                        stdio: 'ignore'
                    }).unref();
                    break;
                case 'darwin':
                    spawn('open', [DESTINATION_PATH], {
                        detached: true,
                        stdio: 'ignore'
                    }).unref();
                    break;
            }
            app.quit();
        }, ON_ERROR);
    }

    /**
     * Automatically updates the application.
     * @param {boolean} invisible Should we hide the graphical update elements?
     */
    autoUpdate(invisible) {
        if (IS_DEV_MODE || this.localVersion.startsWith('0')) {
            return;
        }

        // Windows et macOS passent par Squirrel, qui télécharge et installe en
        // tâche de fond sans rien demander. Le flux maison reste le repli, et
        // demeure le seul chemin sous Linux, que Squirrel ne couvre pas.
        const NATIVE_PLATFORMS = ['win32', 'darwin'];
        if (NATIVE_PLATFORMS.includes(os.platform()) && !this.#nativeFailed) {
            this.#checkNative();
            return;
        }

        this.getProjectLatestVersion(async () => {
            if (this.githubVersion) {
                if (this.githubVersion != this.localVersion) {
                    let githubFileName = '';
                    let localFileName = '';
                    switch (os.platform()) {
                        case 'win32':
                            githubFileName = `EBP-Tools-${this.githubVersion}.exe`;
                            localFileName = `update.exe`;
                            break;
                        case 'darwin':
                            // Starting with the multi-arch release, macOS
                            // DMGs are published with an arch suffix
                            // (`-arm64` for Apple Silicon, `-x64` for
                            // Intel). `process.arch` reports the arch of
                            // the currently running Electron binary, which
                            // is what we want: an arm64 build running
                            // under Rosetta on an Intel Mac should keep
                            // pulling the arm64 DMG.
                            const ARCH =
                                process.arch === 'arm64' ? 'arm64' : 'x64';
                            githubFileName = `EBP-Tools-${this.githubVersion}-${ARCH}.dmg`;
                            localFileName = `update.dmg`;
                            break;
                    }

                    if (githubFileName && localFileName) {
                        telemetryService.reportUpdate('update_available', {
                            target: this.githubVersion
                        });

                        const { response } = await dialog.showMessageBox(
                            getMainWindow(),
                            {
                                type: 'question',
                                buttons: ['Update', 'Later'],
                                defaultId: 0,
                                cancelId: 1,
                                title: 'Update available',
                                message: `A new version (${this.githubVersion}) is available. Do you want to install it now?`
                            }
                        );
                        if (response !== 0) {
                            return;
                        }

                        getMainWindow().webContents.send(
                            'global-message',
                            'common.updatingInProgress'
                        );

                        if (invisible === false) {
                            getMainWindow()?.hide();

                            createFloatingWindow(
                                450,
                                150,
                                JSON.stringify({
                                    percent: 0,
                                    leftRounded: true,
                                    infinite: false,
                                    icon: undefined,
                                    text: '.common.updatingInProgress',
                                    state: 'info'
                                })
                            );
                        }

                        this.#downloadAndInstall({
                            githubFileName,
                            localFileName
                        });
                    }
                }
            }
        });
    }

    /**
     * Vérifie au démarrage, puis toutes les quatre heures.
     *
     * La vérification était auparavant accrochée à l'AFFICHAGE de la fenêtre,
     * ce qui produisait deux défauts opposés : un poste lancé au démarrage de
     * session garde sa fenêtre masquée et ne vérifiait donc JAMAIS, tandis
     * qu'ouvrir et fermer la fenêtre relançait une vérification à chaque fois.
     * La découpler de l'interface corrige les deux.
     *
     * Idempotent : un second appel ne crée pas un second minuteur.
     */
    startPeriodicCheck() {
        if (this.#checkTimer) {
            return;
        }

        this.autoUpdate(true);
        this.#checkTimer = setInterval(
            () => this.autoUpdate(true),
            CHECK_INTERVAL_MS
        );
    }

    /**
     * Applique une mise à jour déjà téléchargée, à la demande de l'utilisateur.
     *
     * `app.relaunch()` ne conviendrait pas : il relance `process.execPath`,
     * donc l'exécutable de la version COURANTE — l'ancienne redémarrerait.
     * Seul `quitAndInstall` passe par le lanceur Squirrel, qui bascule sur la
     * nouvelle version. On ne l'appelle donc que sur action explicite, jamais
     * de sa propre initiative.
     */
    applyPendingUpdate() {
        if (!this.pendingVersion) {
            return;
        }
        console.log(`[update] applying ${this.pendingVersion} on user request`);

        // La fenêtre principale intercepte sa fermeture pour se CACHER au lieu
        // de quitter (`event.preventDefault()` dans window-manager). Or
        // `quitAndInstall` appelle `app.quit()`, qui déclenche cette fermeture,
        // se fait annuler, et renonce : l'app masquait donc sa fenêtre en
        // restant sur l'ancienne version, sans rien signaler.
        //
        // On détruit la fenêtre d'abord — `destroy()` court-circuite le
        // gestionnaire de fermeture —, exactement comme le fait l'entrée
        // « Quit » du tray, qui est la seule à fonctionner pour cette raison.
        const WINDOW = getMainWindow();
        if (WINDOW && !WINDOW.isDestroyed()) {
            WINDOW.destroy();
        }

        NATIVE.quitAndInstall();
    }

    /**
     * Retrieves the number of the latest published version of the project.
     * @param {Function} callback (Optional) Return function.
     */
    getProjectLatestVersion(callback) {
        const OPTIONS = {
            hostname: 'api.github.com',
            path: `/repos/${UPDATE_REPOSITORY}/releases`,
            method: 'GET',
            headers: { 'User-Agent': '' }
        };

        const REQUEST = https.request(OPTIONS, (res) => {
            let data = '';

            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
                try {
                    const DATA = JSON.parse(data);
                    const RELEASE = DATA.find(
                        (r) => r.tag_name && !r.tag_name.startsWith('0')
                    );
                    this.githubVersion = RELEASE ? RELEASE.tag_name : undefined;

                    if (typeof callback !== 'undefined') {
                        callback();
                    }
                } catch (err) {}
            });
        });

        REQUEST.on('error', (err) => console.error(err));
        REQUEST.end();
    }

    /**
     * Downloads a file.
     * @param {String} url URL of the file to download.
     * @param {String} dest Path to place the file.
     * @param {Function} callback Callback function.
     */
    #download(url, dest, callback, onError) {
        const REQUEST = https.get(url, (res) => {
            // Redirection
            if (
                (res.statusCode === 301 || res.statusCode === 302) &&
                res.headers.location
            ) {
                return this.#download(
                    res.headers.location,
                    dest,
                    callback,
                    onError
                );
            }

            if (res.statusCode !== 200) {
                res.resume();
                onError?.(`HTTP ${res.statusCode}`);
                return;
            }

            const TOTAL = Number.parseInt(res.headers['content-length'], 10);
            let downloaded = 0;
            let lastPercent = 0;

            const FILE = fs.createWriteStream(dest);

            res.on('data', (chunk) => {
                downloaded += chunk.length;

                const WINDOW = getMainWindow();
                if (TOTAL && WINDOW && !WINDOW.isDestroyed()) {
                    const PERCENT = Math.round((downloaded / TOTAL) * 100);
                    if (PERCENT > lastPercent) {
                        lastPercent = PERCENT;
                        WINDOW.webContents.send(
                            'set-notification-data',
                            {
                                percent: PERCENT,
                                infinite: PERCENT == 100,
                                icon:
                                    PERCENT == 100
                                        ? 'fa-sharp fa-solid fa-download'
                                        : undefined,
                                text: '.common.updatingInProgress',
                                leftRounded: true,
                                state: 'info'
                            }
                        );
                    }
                }
            });

            res.pipe(FILE);

            FILE.on('error', (err) => onError?.(err.message));

            FILE.on('finish', () => {
                FILE.close(() => {
                    // On Windows, the OS may not release the file handle immediately after close(), causing EBUSY when trying to spawn the installer.
                    // A short delay ensures the kernel has fully released the file.
                    if (os.platform() === 'win32') {
                        setTimeout(() => callback?.(), 500);
                    } else {
                        callback?.();
                    }
                });
            });
        });

        // Sans cet écouteur, une coupure réseau émet un 'error' non géré, ce
        // qui fait planter le processus principal au lieu d'échouer proprement.
        REQUEST.on('error', (err) => onError?.(err.message));
    }

    //#endregion
}

module.exports = UpdateService;
