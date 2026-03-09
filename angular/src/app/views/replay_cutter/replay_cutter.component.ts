// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { CommonModule } from '@angular/common';
import {
  Component,
  ElementRef,
  HostListener,
  isDevMode,
  NgZone,
  OnDestroy,
  OnInit,
  ViewChild
} from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { MatTooltipModule } from '@angular/material/tooltip';
import { GridModule } from '../../shared/grid/grid.module';
import { LoaderComponent } from '../../shared/loader/loader.component';
import Tesseract, { createWorker, PSM } from 'tesseract.js';
import { ToastrService } from 'ngx-toastr';
import { Map } from './models/map';
import { Game } from './models/game';
import { RGB } from './models/rgb';
import { GlobalService } from '../../core/services/global.service';
import { MatInputModule } from '@angular/material/input';
import { OpenCVService } from '../../core/services/open-cv.service';
import { MatDialog } from '@angular/material/dialog';
import { ReplayCutterCropDialog } from './dialogs/crop/crop.dialog';
import { CropperPosition } from 'ngx-image-cropper';
import { APIRestService } from '../../core/services/api-rest.service';
import { RestGame } from './models/rest-game';
import { IdentityService } from '../../core/services/identity/identity.service';
import { ReplayCutterSettingsDialog } from './dialogs/settings/settings.dialog';
import { Settings } from './models/settings';
import { ReplayCutterUpscaleConfirmationDialog } from './dialogs/upscale-confirmation/upscale-confirmation.dialog';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { FormsModule } from '@angular/forms';
import { MODES } from './models/mode';
import { ReplayCutterEditTeamScoreDialog } from './dialogs/edit-score/edit-score.dialog';
import { ReplayCutterAttachGameDialog } from './dialogs/attach-game/attach-game.dialog';
import { ReplayCutterEditTeamNameDialog } from './dialogs/edit-team/edit-team.dialog';
import { distance } from 'fastest-levenshtein';
import { ReplayCutterCheckPlayersOrderDialog } from './dialogs/check-players-order/check-players-order.dialog';
import { ReplayCutterReplayUploadedDialog } from './dialogs/replay-uploaded/replay-uploaded.dialog';
import { ReplayCutterManualVideoCutDialog } from './dialogs/manual-video-cut/manual-video-cut.dialog';
import { VideoChunk } from './models/video-chunk';
import { KillFeedService } from './services/kill-feed.service';
import { ReplayCutterEditMapDialog } from './dialogs/edit-map/edit-map.dialog';
import { NotificationService } from '../notification/services/notification.service';
import { HeaderService } from '../../shared/header/services/header.service';
import { CropperPositionAndFrame } from './models/CropperPosition';
import { ReplayCutterBeforeRemovingBordersDialog } from './dialogs/before-removing-borders/before-removing-borders.dialog';
import { ReplayCutterService } from './services/replay-cutter.service';

//#endregion
@Component({
  selector: 'view-replay_cutter',
  templateUrl: './replay_cutter.component.html',
  styleUrls: ['./replay_cutter.component.scss'],
  standalone: true,
  imports: [
    GridModule,
    MatTooltipModule,
    CommonModule,
    TranslateModule,
    LoaderComponent,
    MatInputModule,
    MatCheckboxModule,
    FormsModule
  ]
})
export class ReplayCutterComponent implements OnInit, OnDestroy {
  //#region Attributes

  @ViewChild('debug') debug?: ElementRef<HTMLDivElement>;
  protected debugMode: boolean = false;
  public debugPause: boolean = false;
  private settings: Settings = new Settings();

  private creatingAGame: number | undefined;

  protected percent: number = -1;
  protected inputFileDisabled: boolean = true;
  private lastDetectedGamePlayingFrame?: number;
  private pythonAnalysisRunning: boolean = false;

  private _videoPath: string | undefined;
  public set videoPath(value: string | undefined) {
    if (value) {
      this.percent = 0;
      this.globalService.loading = '';
      console.log(`The user defined this video path: "${value}"`);
      this.translateService
        .get('view.replay_cutter.videoIsBeingAnalyzed', {
          games: this._games.length
        })
        .subscribe((translated: string) => {
          window.electronAPI.showNotification(
            true,
            500,
            150,
            JSON.stringify({
              percent: 0,
              infinite: false,
              icon: undefined,
              text: translated,
              leftRounded: true
            })
          );
        });
    }
    this._videoPath = value;
  }
  public get videoPath(): string | undefined {
    return this._videoPath;
  }

  private _games: Game[] = [];
  public get games(): Game[] {
    return this._games;
  }

  private justJumped: boolean = false;
  private videoOldTime: number | undefined = undefined;
  private start: number = 0;

  private tesseractWorker_basic: Tesseract.Worker | undefined;
  private tesseractWorker_number: Tesseract.Worker | undefined;
  private tesseractWorker_letter: Tesseract.Worker | undefined;
  private tesseractWorker_time: Tesseract.Worker | undefined;

  private training: boolean | undefined;

  private miniMapPositionsByMap: {
    [mapName: string]: [CropperPosition, CropperPosition];
  } = {};

  protected maps: Map[] = [
    new Map('Artefact', ['artefact'], [4, 1, 6, 1], [38, 18, 390, 223]), // v
    new Map('Atlantis', ['atlantis'], [3, 2, 3, 2], [13, 21, 433, 228]), // v
    new Map('Ceres', ['ceres'], [3, 2, 3, 2], [20, 25, 420, 212]), // v
    new Map('Engine', ['engine'], [3, 2, 3, 2], [6, 12, 442, 225]), // v
    new Map(
      'Helios Station',
      ['helios', 'station'],
      [3, 2, 3, 2],
      [14, 23, 432, 217]
    ),
    new Map(
      'Lunar Outpost',
      ['lunar', 'outpost'],
      [3, 2, 3, 2],
      [18, 38, 593, 301]
    ),
    new Map('Outlaw', ['outlaw', 'qutlaw'], [3, 5, 5, 3], [4, 5, 269, 270]),
    new Map('Polaris', ['polaris'], [3, 2, 3, 2], [16, 18, 428, 237]), // v
    new Map('Silva', ['silva'], [3, 2, 3, 2], [29, 18, 310, 237]), // v
    new Map('The Cliff', ['cliff'], [3, 3, 3, 3]), // v
    new Map('The Rock', ['rock'], [3, 2, 3, 2], [14, 22, 432, 217]),
    new Map('Horizon', ['horizon'], [3, 2, 3, 2], [19, 29, 327, 209]) // v
  ];

  //#endregion

  constructor(
    protected readonly identityService: IdentityService,
    protected readonly globalService: GlobalService,
    protected readonly killFeedService: KillFeedService,
    private readonly toastrService: ToastrService,
    private readonly ngZone: NgZone,
    private readonly translateService: TranslateService,
    private readonly openCVService: OpenCVService,
    private readonly dialogService: MatDialog,
    private readonly apiRestService: APIRestService,
    private readonly notificationService: NotificationService,
    private readonly headerService: HeaderService
  ) {}

  //#region Functions

  ngOnInit(): void {
    this.videoPath = undefined;
    window.electronAPI.removeNotification(false);

    this.initServices();

    this.visibilityChangeHandler = this.visibilityChangeHandler.bind(this);
    document.addEventListener('visibilitychange', this.visibilityChangeHandler);

    window.electronAPI.gameIsUploaded((gameIndex) => {
      this.ngZone.run(() => {
        this.games[gameIndex].sentForAnalysis = true;
        this.globalService.loading = undefined;
        this.dialogService.open(ReplayCutterReplayUploadedDialog);
        this.apiRestService.getMyCoins().subscribe((coins: number) => {
          this.identityService.coins = coins;
        });
      });
    });

    window.electronAPI.analyzeVideoFile(
      (
        socket: string,
        filePath: string,
        forcedTraining: boolean | undefined
      ) => {
        this.ngZone.run(() => {
          let training = forcedTraining;
          if (!forcedTraining) {
            training = this.training;
          }
          if (training) {
            this.analyzeVideoFile(training, filePath);
          }
        });
      }
    );

    // The server send the upscaling process percent to the font-end.
    window.electronAPI.setUpscalePercent((percent: number) => {
      this.ngZone.run(() => {
        this.globalService.loading = '';

        this.translateService
          .get('view.notification.upscaling.description')
          .subscribe((translated: string) => {
            this.notificationService.sendMessage({
              percent: percent,
              infinite: false,
              icon: undefined,
              text: translated,
              leftRounded: true,
              state: 'info'
            });
          });
      });
    });

    // The server send the border removing process percent to the font-end.
    window.electronAPI.setRemoveBordersPercent((percent: number) => {
      this.ngZone.run(() => {
        this.globalService.loading = '';

        this.translateService
          .get('view.notification.removing-border.description')
          .subscribe((translated: string) => {
            this.notificationService.sendMessage({
              percent: percent,
              infinite: false,
              icon: undefined,
              text: translated,
              leftRounded: true,
              state: 'info'
            });
          });
      });
    });

    // The server send the manual cut process percent to the font-end.
    window.electronAPI.setManualCutPercent((percent: number) => {
      this.ngZone.run(() => {
        this.globalService.loading = '';

        this.translateService
          .get('view.notification.manual-cutting.description')
          .subscribe((translated: string) => {
            this.notificationService.sendMessage({
              percent: percent,
              infinite: percent == 100,
              icon:
                percent == 100 ? 'fa-sharp fa-solid fa-scissors' : undefined,
              text: translated,
              leftRounded: true,
              state: 'info'
            });
          });
      });
    });

    // The server gives the path of the video file selected by the user.
    window.electronAPI.setVideoFile((path: string) => {
      window.electronAPI.removeNotification(false);
      this.ngZone.run(() => {
        if (this.training) {
          if (path) {
            this.videoPath = encodeURIComponent(path);
          }
        } else {
          if (path) {
            this.training = true;
            const URL = encodeURIComponent(path);
            const DIALOG_WIDTH = 'calc(100vw - 12px * 4)';
            this.dialogService
              .open(ReplayCutterManualVideoCutDialog, {
                autoFocus: false,
                data: URL,
                width: DIALOG_WIDTH,
                maxWidth: DIALOG_WIDTH
              })
              .afterClosed()
              .subscribe((response: VideoChunk[] | undefined) => {
                window.electronAPI.setWindowSize();
                if (response) {
                  this.globalService.loading = '';

                  setTimeout(() => {
                    this.translateService
                      .get('view.notification.manual-cutting.description')
                      .subscribe((translated: string) => {
                        window.electronAPI.manualCutVideoFile(
                          path,
                          response,
                          JSON.stringify({
                            percent: 0,
                            infinite: true,
                            icon: 'fa-sharp fa-solid fa-scissors',
                            text: translated
                          })
                        );
                      });
                  }, 1000);
                } else {
                  this.globalService.loading = undefined;
                }
              });
          }
        }
        if (!path) {
          this.globalService.loading = undefined;
        }
        this.miniMapPositionsByMap = {};
      });
    });

    // Receive progress / result updates from the Python analyzer binary.
    window.electronAPI.onAnalyzerUpdate((msg) => {
      this.ngZone.run(() => {
        if (msg.type === 'progress') {
          this.percent = msg.percent ?? this.percent;
          console.log(this.percent);
          const GAMES_COUNT =
            typeof msg.games === 'number'
              ? msg.games
              : (msg.games?.length ?? this._games.length);
          this.translateService
            .get('view.replay_cutter.videoIsBeingAnalyzed', {
              games: GAMES_COUNT
            })
            .subscribe((translated: string) => {
              this.notificationService.sendMessage({
                percent: this.percent,
                infinite: false,
                icon: undefined,
                text: translated,
                leftRounded: true,
                state: 'info'
              });
            });
        } else if (msg.type === 'done') {
          console.log('[analyzer] done payload:', JSON.stringify(msg.games));
          this.pythonAnalysisRunning = false;
          const GAMES_LIST = Array.isArray(msg.games) ? msg.games : [];
          this._games = GAMES_LIST.map((g) => this.createGameFromJSON(g));
          this.onVideoEnded(this._games);
        } else if (msg.type === 'error') {
          console.error('[analyzer] error:', msg.message);
          this.pythonAnalysisRunning = false;
          this.onVideoEnded(this._games);
        } else if (msg.log) {
          console.log('[analyzer]', msg.log);
        }
      });
    });
  }

  ngOnDestroy(): void {
    document.removeEventListener(
      'visibilitychange',
      this.visibilityChangeHandler
    );
  }

  @HostListener('document:mousedown', ['$event'])
  onDocumentClick(event: MouseEvent) {
    this.visibilityChangeHandler();
  }

  /**
   * Determines whether the upload button should be disabled based on video path and map configuration.
   * The button is disabled if no video is loaded or if the map has no configured margins.
   * @param mapName The name of the map to check for margin configuration.
   * @returns True if the upload button should be disabled, false otherwise.
   */
  protected disableUploadButton(mapName: string): boolean {
    return (
      !this._videoPath || !ReplayCutterService.getMapByName(mapName)?.mapMargins
    );
  }

  /**
   * Returns true if all games in the list are checked.
   * Used to determine the checked state of the master checkbox in the table header.
   * @returns true if there are games and all are checked, false otherwise.
   */
  protected get allGamesChecked(): boolean {
    return this._games.length > 0 && this._games.every((game) => game.checked);
  }

  /**
   * Returns true if at least one game in the list is checked.
   * Used to determine the indeterminate state of the master checkbox in the table header.
   * @returns true if any game is checked, false if no games are checked.
   */
  protected get someGamesChecked(): boolean {
    return this._games.some((game) => game.checked);
  }

  /**
   * Toggles the checked state of all games in the list.
   * If all games are currently checked, it will uncheck them all.
   * If not all games are checked, it will check them all.
   * Triggered by clicking the master checkbox in the table header.
   */
  protected toggleAllGames(): void {
    const SHOULD_CHECK = !this.allGamesChecked;
    this._games.forEach((game) => (game.checked = SHOULD_CHECK));
  }

  /**
   * Returns true if the application is running in development mode.
   * @returns true if in development mode, false otherwise.
   */
  protected get isDevMode(): boolean {
    return isDevMode();
  }

  /**
   * Toggles the debug mode between play and pause states during gameplay analysis.
   */
  protected playPauseDebug(): void {
    this.debugPause = !this.debugPause;
  }

  /**
   * Initializes the required services for the replay cutter component.
   * This includes initializing Tesseract for OCR functionality and setting up OpenCV with proper error handling.
   * Once OpenCV is successfully loaded, enables the file input for video processing.
   */
  private async initServices(): Promise<void> {
    await this.initTesseract();

    this.openCVService.isLoaded$.subscribe((loaded: boolean) => {
      if (loaded) {
        console.debug('OpenCV is loaded');
      } else {
        console.error("OpenCV isn't loaded");
        this.toastrService.error("Erreur lors du chargement d'OpenCV");
      }
    });
  }

  /**
   * Opens the settings dialog with the current settings.
   */
  protected openSettings(): void {
    this.dialogService.open(ReplayCutterSettingsDialog, {
      data: this.settings,
      autoFocus: false,
      disableClose: true
    });
  }

  /**
   * This function allows the user to select which game to attach the video to.
   * @param gameIndex Index of the game to attach.
   */
  protected selectWhichGameToAttachMinimap(gameIndex: number): void {
    if (
      !this.disableUploadButton(this.games[gameIndex].map) &&
      !this.games[gameIndex].sentForAnalysis
    ) {
      console.log(
        `The user wants to analyze his game with EBP's AI... (game index: ${gameIndex})`
      );
      if (this.identityService.coins && this.identityService.coins > 0) {
        console.log(
          `The user has enough tokens.\nDetecting the start and end of gameplay...`
        );
        this.globalService.loading = '';
        this.getGamePlayingBounds(this.games[gameIndex]).then((game) => {
          if (game) {
            console.log(
              `We pick up the game on the EBP website on the "${game.map}" map and with the score ${game.orangeTeam.score}/${game.blueTeam.score}...`
            );
            this.apiRestService
              .getGames(game.map, game.orangeTeam.score, game.blueTeam.score)
              .subscribe({
                next: (games: RestGame[]) => {
                  this.sortPlayersFromGameFrame(
                    gameIndex,
                    {
                      ID: 0,
                      tags: [],
                      date: new Date().toString(),
                      orangePlayers: [],
                      bluePlayers: []
                    },
                    (
                      orangePlayersNames: string[],
                      bluePlayersNames: string[]
                    ) => {
                      // We get the coordinates of the orange team's information.
                      this.globalService.loading =
                        this.translateService.instant(
                          'view.replay_cutter.detectingOrangeInfoZone'
                        );
                      this.getTeamInfosPosition(
                        gameIndex,
                        new RGB(235, 121, 0),
                        (orangeTeamInfosPosition: CropperPositionAndFrame) => {
                          // We get the coordinates of the blue team's information.
                          this.globalService.loading =
                            this.translateService.instant(
                              'view.replay_cutter.detectingBlueInfoZone'
                            );
                          this.getTeamInfosPosition(
                            gameIndex,
                            new RGB(29, 127, 255),
                            (
                              blueTeamInfosPosition: CropperPositionAndFrame
                            ) => {
                              const ORANGE_BLOC_IMAGE =
                                ReplayCutterService.cropImage(
                                  orangeTeamInfosPosition.frame!,
                                  orangeTeamInfosPosition.x1,
                                  orangeTeamInfosPosition.y1,
                                  orangeTeamInfosPosition.x2,
                                  orangeTeamInfosPosition.y2
                                );

                              const BLUE_BLOC_IMAGE =
                                ReplayCutterService.cropImage(
                                  blueTeamInfosPosition.frame!,
                                  blueTeamInfosPosition.x1,
                                  blueTeamInfosPosition.y1,
                                  blueTeamInfosPosition.x2,
                                  blueTeamInfosPosition.y2
                                );

                              if (ORANGE_BLOC_IMAGE && BLUE_BLOC_IMAGE) {
                                const ORANGE_NAMES_IMAGE =
                                  this.getPlayersNamesAsImage(
                                    4,
                                    ORANGE_BLOC_IMAGE,
                                    true
                                  ).toDataURL();
                                const BLUE_NAMES_IMAGE =
                                  this.getPlayersNamesAsImage(
                                    4,
                                    BLUE_BLOC_IMAGE,
                                    false
                                  ).toDataURL();

                                if (ORANGE_BLOC_IMAGE && BLUE_BLOC_IMAGE) {
                                  if (games && games.length > 0) {
                                    const DIALOG_WIDTH: string =
                                      'calc(100vw - 12px * 4)';
                                    this.dialogService
                                      .open(ReplayCutterAttachGameDialog, {
                                        data: {
                                          game: this.games[gameIndex],
                                          games: games,
                                          images: [
                                            ORANGE_NAMES_IMAGE,
                                            BLUE_NAMES_IMAGE
                                          ],

                                          orangePlayersNames:
                                            orangePlayersNames,
                                          bluePlayersNames: bluePlayersNames
                                        },
                                        autoFocus: false,
                                        width: DIALOG_WIDTH,
                                        maxWidth: '922px'
                                      })
                                      .afterClosed()
                                      .subscribe(
                                        (gameID: number | undefined | null) => {
                                          if (gameID === undefined) {
                                            this.globalService.loading =
                                              undefined;
                                          } else if (gameID === null) {
                                            this.createGame(
                                              gameIndex,
                                              orangePlayersNames,
                                              bluePlayersNames,
                                              [
                                                ORANGE_NAMES_IMAGE,
                                                BLUE_NAMES_IMAGE
                                              ]
                                            );
                                          } else {
                                            this.cropGameMinimap(
                                              gameIndex,
                                              games.find(
                                                (game) => game.ID == gameID
                                              )!,
                                              orangeTeamInfosPosition,
                                              blueTeamInfosPosition,
                                              ORANGE_NAMES_IMAGE,
                                              BLUE_NAMES_IMAGE
                                            );
                                          }
                                        }
                                      );
                                  } else {
                                    this.globalService.loading = undefined;
                                    this.translateService
                                      .get(
                                        'view.replay_cutter.toast.noGamesFoundInStatistics',
                                        {
                                          map: game.map,
                                          orangeScore: game.orangeTeam.score,
                                          blueScore: game.blueTeam.score
                                        }
                                      )
                                      .subscribe((translated: string) => {
                                        this.globalService.loading = undefined;
                                        this.toastrService
                                          .error(translated, undefined, {
                                            enableHtml: true,
                                            timeOut: 20 * 1000
                                          })
                                          .onTap.subscribe(() => {
                                            localStorage.setItem(
                                              'notification_images',
                                              JSON.stringify([
                                                ORANGE_NAMES_IMAGE,
                                                BLUE_NAMES_IMAGE
                                              ])
                                            );

                                            this.createGame(
                                              gameIndex,
                                              orangePlayersNames,
                                              bluePlayersNames,
                                              [
                                                ORANGE_NAMES_IMAGE,
                                                BLUE_NAMES_IMAGE
                                              ]
                                            );
                                          });
                                      });
                                  }
                                } else {
                                  console.error(
                                    "'selectWhichGameToAttachMinimap': Team images are missing."
                                  );
                                }
                              }
                            },
                            orangeTeamInfosPosition.frame
                          );
                        }
                      );
                    }
                  );
                }
              });
          } else {
            console.error(`"selectWhichGameToAttachMinimap", no game found.`);
          }
        });
      } else {
        console.error(`The user does not have enough tokens.`);
        this.headerService.showCoinsPopup = true;
      }
    }
  }

  /**
   * Opens the browser's default browser to create a new game with the specified players.
   * - Stores player images in localStorage for the notifications
   * - Sets the current game as being created.
   * - Shows a notification via the Electron API with translated text.
   * - Prepares game data and opens the statistics page in the default browser.
   * @param gameIndex - Index of the game in the games array.
   * @param orangePlayersNames - Names of the orange team players.
   * @param bluePlayersNames - Names of the blue team players.
   * @param playersImages - Base64 of the player images.
   */
  protected createGame(
    gameIndex: number,
    orangePlayersNames: string[],
    bluePlayersNames: string[],
    playersImages: string[]
  ): void {
    localStorage.setItem('notification_images', JSON.stringify(playersImages));
    this.creatingAGame = gameIndex;
    this.translateService
      .get('view.replay_cutter.toast.createGameOnEBPHelper')
      .subscribe((translated: string) => {
        window.electronAPI.showNotification(
          false,
          540,
          210,
          JSON.stringify({
            percent: 0,
            infinite: false,
            icon: undefined,
            text: translated,
            leftRounded: false
          })
        );
      });

    const DATA = {
      map: this.games[gameIndex].map,
      date: new Date().getTime(),
      orange: {
        name: this.games[gameIndex].orangeTeam.name,
        score: this.games[gameIndex].orangeTeam.score,
        players: orangePlayersNames
      },
      blue: {
        name: this.games[gameIndex].blueTeam.name,
        score: this.games[gameIndex].blueTeam.score,
        players: bluePlayersNames
      }
    };

    window.electronAPI.openURL(
      `${this.globalService.webSiteURL}/tools/statistics?new=${encodeURIComponent(JSON.stringify(DATA))}`
    );
  }

  /**
   * Automatically detects the minimap dimensions by analyzing the white borders in the upper left corner of the image.
   * @param videoFrame The canvas containing the image to be analyzed.
   * @returns The coordinates of the minimap (x1, y1, x2, y2) or the default values ​​if not found.
   */
  public detectMinimap(
    game: Game,
    callback: Function,
    index: number = 0,
    max: number = 30
  ): void {
    if (this._videoPath) {
      console.log(
        `"detectMinimap": Trying to detect the minimap (${index})...`
      );
      let retry: boolean = false;

      const BACK: CropperPosition = JSON.parse(
        JSON.stringify(ReplayCutterCropDialog.DEFAULT_CROPPER)
      );

      ReplayCutterService.videoURLToCanvas(
        `http://localhost:${this.globalService.serverPort}/file?path=${this._videoPath}`,
        Math.round((game.start + index) * 1000),
        (videoFrame?: HTMLCanvasElement) => {
          if (videoFrame) {
            const CTX = videoFrame.getContext('2d');
            if (CTX) {
              const IMAGE_DATA = CTX.getImageData(
                0,
                0,
                videoFrame.width,
                videoFrame.height
              ).data;

              const MAX_COLOR_DIFFERENCE: number = 50;

              // We are looking for x1
              l1: for (
                let x = 0;
                x < ReplayCutterCropDialog.DEFAULT_CROPPER.x2;
                x++
              ) {
                for (
                  let y = 0;
                  y < ReplayCutterCropDialog.DEFAULT_CROPPER.y2;
                  y++
                ) {
                  const INDEX = (y * videoFrame.width + x) * 4;
                  const R = IMAGE_DATA[INDEX];
                  const G = IMAGE_DATA[INDEX + 1];
                  const B = IMAGE_DATA[INDEX + 2];

                  if (
                    ReplayCutterService.colorSimilarity(
                      new RGB(R, G, B),
                      new RGB(255, 255, 255),
                      MAX_COLOR_DIFFERENCE
                    )
                  ) {
                    BACK.x1 = x;
                    break l1;
                  }
                }
              }

              // We are looking for x2
              l1: for (
                let x = ReplayCutterCropDialog.DEFAULT_CROPPER.x2;
                x >= 0;
                x--
              ) {
                for (
                  let y = 0;
                  y < ReplayCutterCropDialog.DEFAULT_CROPPER.y2;
                  y++
                ) {
                  const INDEX = (y * videoFrame.width + x) * 4;
                  const R = IMAGE_DATA[INDEX];
                  const G = IMAGE_DATA[INDEX + 1];
                  const B = IMAGE_DATA[INDEX + 2];

                  if (
                    ReplayCutterService.colorSimilarity(
                      new RGB(R, G, B),
                      new RGB(255, 255, 255),
                      MAX_COLOR_DIFFERENCE
                    )
                  ) {
                    BACK.x2 = x + 1;
                    break l1;
                  }
                }
              }

              // We are looking for y1
              l1: for (
                let y = 0;
                y < ReplayCutterCropDialog.DEFAULT_CROPPER.y2;
                y++
              ) {
                for (
                  let x = 0;
                  x < ReplayCutterCropDialog.DEFAULT_CROPPER.x2;
                  x++
                ) {
                  const INDEX = (y * videoFrame.width + x) * 4;
                  const R = IMAGE_DATA[INDEX];
                  const G = IMAGE_DATA[INDEX + 1];
                  const B = IMAGE_DATA[INDEX + 2];

                  if (
                    ReplayCutterService.colorSimilarity(
                      new RGB(R, G, B),
                      new RGB(255, 255, 255),
                      MAX_COLOR_DIFFERENCE
                    )
                  ) {
                    BACK.y1 = y;
                    break l1;
                  }
                }
              }

              // We are looking for y1
              l1: for (
                let y = ReplayCutterCropDialog.DEFAULT_CROPPER.y2;
                y >= 0;
                y--
              ) {
                for (
                  let x = 0;
                  x < ReplayCutterCropDialog.DEFAULT_CROPPER.x2;
                  x++
                ) {
                  const INDEX = (y * videoFrame.width + x) * 4;
                  const R = IMAGE_DATA[INDEX];
                  const G = IMAGE_DATA[INDEX + 1];
                  const B = IMAGE_DATA[INDEX + 2];

                  if (
                    ReplayCutterService.colorSimilarity(
                      new RGB(R, G, B),
                      new RGB(255, 255, 255),
                      MAX_COLOR_DIFFERENCE
                    )
                  ) {
                    BACK.y2 = y + 1;
                    break l1;
                  }
                }
              }
            }

            // Map bound check

            const GAME_MAP = ReplayCutterService.getMapByName(game.map);
            if (GAME_MAP && GAME_MAP.mapBound) {
              const TOLERANCE: number = videoFrame.width * 0.01;

              if (
                // X
                BACK.x1 < GAME_MAP.mapBound[0] - TOLERANCE ||
                BACK.x1 > GAME_MAP.mapBound[0] + TOLERANCE ||
                // Y
                BACK.y1 < GAME_MAP.mapBound[1] - TOLERANCE ||
                BACK.y1 > GAME_MAP.mapBound[1] + TOLERANCE ||
                // Width
                BACK.x2 <
                  GAME_MAP.mapBound[0] + GAME_MAP.mapBound[2] - TOLERANCE ||
                BACK.x2 >
                  GAME_MAP.mapBound[0] + GAME_MAP.mapBound[2] + TOLERANCE ||
                // Height
                BACK.y2 <
                  GAME_MAP.mapBound[1] + GAME_MAP.mapBound[3] - TOLERANCE ||
                BACK.y2 >
                  GAME_MAP.mapBound[1] + GAME_MAP.mapBound[3] + TOLERANCE
              ) {
                retry = true;
                console.warn(
                  'Error: "detectMinimap", the dimensions of the minimap do not match the expected.'
                );
                if (index < max) {
                  console.warn('Retrying...');
                  this.detectMinimap(game, callback, index + 1, max);
                } else {
                  console.warn(`index == max (${max})...`);
                  callback(BACK, videoFrame);
                }
              }
            }

            if (!retry) {
              callback(BACK, videoFrame);
            }
          }
        }
      );
    } else {
      console.error('Error: "detectMinimap", this._videoPath is undefined.');
    }
  }

  /**
   * This function allows the user to set the game mini map position.
   * @param gameIndex Index of the game to upload.
   * @param gameFromStatistics Game infos from EBP's API.
   */
  protected cropGameMinimap(
    gameIndex: number,
    gameFromStatistics: RestGame,
    orangeTeamInfosPosition: CropperPosition,
    blueTeamInfosPosition: CropperPosition,
    orangeNamesAsImage: string,
    blueNamesAsImage: string
  ): void {
    const MAP_NAME = this._games[gameIndex].map;

    // If the positions are already defined for this map, use them directly.
    if (this.miniMapPositionsByMap[MAP_NAME]) {
      this.uploadGameMiniMap(
        gameIndex,
        this.miniMapPositionsByMap[MAP_NAME][0],
        this.miniMapPositionsByMap[MAP_NAME][1],
        gameFromStatistics,
        orangeTeamInfosPosition,
        blueTeamInfosPosition,
        orangeNamesAsImage,
        blueNamesAsImage
      );
      return;
    }

    this.detectMinimap(
      this._games[gameIndex],
      (position: CropperPosition, videoFrame: HTMLCanvasElement) => {
        const DIALOG_WIDTH: string = 'calc(100vw - 12px * 4)';
        const DIALOG_HEIGHT: string = 'calc(100vh - 12px * 4)';
        this.dialogService
          .open(ReplayCutterCropDialog, {
            data: {
              imgBase64: videoFrame.toDataURL('image/png'),
              initialCropperPosition: position,
              component: this,
              gameIndex: gameIndex
            },
            maxWidth: DIALOG_WIDTH,
            maxHeight: DIALOG_HEIGHT,
            width: DIALOG_WIDTH,
            height: DIALOG_HEIGHT,
            autoFocus: false
          })
          .afterClosed()
          .subscribe((miniMapPositions: CropperPosition | undefined) => {
            window.electronAPI.setWindowSize();
            this.globalService.loading = undefined;
            if (miniMapPositions) {
              const MAP = this.maps.find(
                (x) => x.name == this.games[gameIndex].map
              );

              if (MAP) {
                let margedMiniMapPositions = JSON.parse(
                  JSON.stringify(miniMapPositions)
                );
                if (MAP.mapMargins) {
                  const HEIGHT = miniMapPositions.y2 - miniMapPositions.y1;
                  const WIDTH = miniMapPositions.x2 - miniMapPositions.x1;
                  const X = Math.min(
                    miniMapPositions.x1,
                    (WIDTH * MAP.mapMargins[3]) / 100
                  );
                  const Y = Math.min(
                    miniMapPositions.y1,
                    (HEIGHT * MAP.mapMargins[0]) / 100
                  );

                  margedMiniMapPositions = {
                    x1: miniMapPositions.x1 - X,
                    x2:
                      miniMapPositions.x2 +
                      (MAP.mapMargins[1] == MAP.mapMargins[3]
                        ? X
                        : (WIDTH * MAP.mapMargins[1]) / 100),
                    y1: miniMapPositions.y1 - Y,
                    y2:
                      miniMapPositions.y2 +
                      (MAP.mapMargins[0] == MAP.mapMargins[2]
                        ? Y
                        : (HEIGHT * MAP.mapMargins[2]) / 100)
                  };
                }

                miniMapPositions = {
                  x1: Math.round(miniMapPositions.x1),
                  x2: Math.round(miniMapPositions.x2),
                  y1: Math.round(miniMapPositions.y1),
                  y2: Math.round(miniMapPositions.y2)
                };

                this.miniMapPositionsByMap[MAP_NAME] = [
                  miniMapPositions,
                  margedMiniMapPositions
                ];
                this.uploadGameMiniMap(
                  gameIndex,
                  miniMapPositions,
                  margedMiniMapPositions,
                  gameFromStatistics,
                  orangeTeamInfosPosition,
                  blueTeamInfosPosition,
                  orangeNamesAsImage,
                  blueNamesAsImage
                );
              }
            }
          });
      }
    );
  }

  /**
   * This function initializes the different instances of the OCR.
   */
  private async initTesseract(): Promise<void> {
    this.tesseractWorker_basic = await createWorker('eng');
    this.tesseractWorker_number = await createWorker('eng');
    this.tesseractWorker_letter = await createWorker('eng');
    this.tesseractWorker_time = await createWorker('eng');

    this.tesseractWorker_basic.setParameters({
      tessedit_char_whitelist:
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    });
    this.tesseractWorker_number.setParameters({
      tessedit_char_whitelist: '0123456789'
    });
    this.tesseractWorker_letter.setParameters({
      tessedit_char_whitelist:
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz '
    });
    this.tesseractWorker_time.setParameters({
      tessedit_char_whitelist: '0123456789:'
    });

    this.inputFileDisabled = false;
  }

  /**
   * Automatically detects the position boundaries of a team's player information area on a replay video frame by analyzing team color pixels to determine the UI bounds.
   * @param gameIndex Index of the game to analyze.
   * @param color RGB color of the team to detect (orange or blue).
   * @param callback Function called with the detected position bounds {left, top, bottom, right}.
   */
  private getTeamInfosPosition(
    gameIndex: number,
    color: RGB,
    callback: Function,
    frame?: CanvasImageSource,
    index: number = 1,
    nbPlayers: number = 4
  ): void {
    if (frame) {
      this.getTeamInfosPosition_Step2(
        gameIndex,
        color,
        callback,
        frame,
        index,
        nbPlayers
      );
    } else if (this._videoPath) {
      ReplayCutterService.videoURLToCanvas(
        `http://localhost:${this.globalService.serverPort}/file?path=${this._videoPath}`,
        (this._games[gameIndex].start + index) * 1000,
        (videoFrame?: HTMLCanvasElement) => {
          if (videoFrame) {
            this.getTeamInfosPosition_Step2(
              gameIndex,
              color,
              callback,
              videoFrame,
              index,
              nbPlayers
            );
          }
        }
      );
    }
  }

  /**
   * Determines the bounding box of a team's information area in a frame based on its color.
   * The function scans the frame vertically to find the top and bottom edges, then horizontally to find the left and right edges of the team info.
   * @param color The RGB color representing the team
   * @param frame The source image or video frame
   * @param callback A function called with the calculated bounding box { x1, y1, x2, y2, frame }
   */
  private getTeamInfosPosition_Step2(
    gameIndex: number,
    color: RGB,
    callback: Function,
    frame: CanvasImageSource,
    index: number,
    nbPlayers: number
  ): void {
    const EXPECTED_HEIGHT: number = 83;
    const TOLERANCE: number = 0.1;

    let step = 0;

    let top = 0;
    let right = 0;
    let bottom = 0;
    let left = 0;

    const TEAM_IS_ORANGE = color.r > 255 / 2;

    const FRAME_DATA = ReplayCutterService.captureFrameData(frame);
    if (!FRAME_DATA) {
      return;
    }

    // We are looking for the bottom and the top.
    const X: number = TEAM_IS_ORANGE ? 125 : 1806;
    for (let y = ReplayCutterService.getSourceSize(frame).height; y >= 0; y--) {
      const IS_PRIMARY_COLOR = ReplayCutterService.colorSimilarity(
        ReplayCutterService.getPixelColorFromData(FRAME_DATA, X, y),
        color
      );

      if (IS_PRIMARY_COLOR && bottom == 0) {
        bottom = Math.floor(
          y + ReplayCutterService.getSourceSize(frame).height * 0.058
        );
        step = 1;
        continue;
      }

      if (
        (!IS_PRIMARY_COLOR && step == 1) ||
        (IS_PRIMARY_COLOR && step == 2) ||
        (!IS_PRIMARY_COLOR && step == 3) ||
        (IS_PRIMARY_COLOR && step == 4) ||
        (!IS_PRIMARY_COLOR && step == 5) ||
        (IS_PRIMARY_COLOR && step == 6) ||
        (!IS_PRIMARY_COLOR && step == 7)
      ) {
        step++;
        continue;
      }

      if (!IS_PRIMARY_COLOR && step == 8) {
        top = y;
        break;
      }
    }

    // We are looking for the left and the right.
    const Y = Math.floor(
      top + ReplayCutterService.getSourceSize(frame).height * 0.005
    );
    for (
      let x = 0;
      x < ReplayCutterService.getSourceSize(frame).width / 4;
      x++
    ) {
      const IS_PRIMARY_COLOR = ReplayCutterService.colorSimilarity(
        ReplayCutterService.getPixelColorFromData(
          FRAME_DATA,
          TEAM_IS_ORANGE
            ? x
            : ReplayCutterService.getSourceSize(frame).width - x,
          Y
        ),
        color,
        30
      );

      if (IS_PRIMARY_COLOR) {
        if (TEAM_IS_ORANGE) {
          if (left == 0) {
            left = x;
          }
          right = x;
        } else {
          if (right == 0) {
            right = ReplayCutterService.getSourceSize(frame).width - x;
          }
          left = ReplayCutterService.getSourceSize(frame).width - x;
        }
      }
    }

    const HEIGHT = bottom - top;
    if (
      HEIGHT < EXPECTED_HEIGHT * nbPlayers * (1 - TOLERANCE) ||
      HEIGHT > EXPECTED_HEIGHT * nbPlayers * (1 + TOLERANCE)
    ) {
      console.warn(
        '"getTeamInfosPosition_Step2", the team infos image height seems wrong, retrying...'
      );
      this.getTeamInfosPosition(
        gameIndex,
        color,
        callback,
        undefined,
        index + 1,
        nbPlayers
      );
    } else {
      callback({
        x1: left,
        y1: top,
        x2: right,
        y2: bottom,
        frame: frame
      });
    }
  }

  /**
   * Generates a canvas containing the players' name banners extracted from a given frame. Each banner represents a portion of the frame corresponding to a player's nickname.
   * @param nbPlayers Number of players in the frame.
   * @param frame Source image or video frame.
   * @param orange Flag to adjust horizontal cropping for team color.
   * @returns A canvas element with the extracted player name images stacked vertically.
   */
  private getPlayersNamesAsImage(
    nbPlayers: number,
    frame: CanvasImageSource,
    orange: boolean
  ): HTMLCanvasElement {
    const SOURCE_SIZE = ReplayCutterService.getSourceSize(frame);
    const CANVAS = document.createElement('canvas');
    const X1 = 0 + (orange ? SOURCE_SIZE.width * 0.24 : 0);
    const X2 = SOURCE_SIZE.width - (!orange ? SOURCE_SIZE.width * 0.24 : 0);
    const WIDTH = X2 - X1;
    const SLICE_HEIGHT = (SOURCE_SIZE.height / nbPlayers) * 0.3; // The banner containing the player's nickname is 30% of its height.
    const SLICE_SPACING = (SOURCE_SIZE.height / nbPlayers) * 0.7;
    const CANVAS_HEIGHT = nbPlayers * SLICE_HEIGHT;

    CANVAS.width = WIDTH;
    CANVAS.height = CANVAS_HEIGHT;
    const CTX = CANVAS.getContext('2d');

    if (CTX) {
      for (let i = 0; i < nbPlayers; i++) {
        const SOURCE_Y = 0 + i * (SLICE_SPACING + SLICE_HEIGHT);
        const TARGET_Y = i * SLICE_HEIGHT;

        CTX.drawImage(
          frame,
          X1,
          SOURCE_Y,
          WIDTH,
          SLICE_HEIGHT,
          0,
          TARGET_Y,
          WIDTH,
          SLICE_HEIGHT
        );
      }
    }
    return CANVAS;
  }

  /**
   * Sorts a list of player names from the API to match the order detected by Tesseract OCR.
   * The API provides correct spelling but wrong order, while Tesseract provides correct order but potentially incorrect spelling.
   * This function combines both to get correctly spelled names in the correct order.
   * @param original Array of player names from the API (correct spelling, wrong order).
   * @param tesseract Array of player names detected by OCR (correct order, potentially wrong spelling).
   * @returns Array of correctly spelled player names sorted in the order detected by Tesseract.
   */
  private sortByTesseractOrder(
    original: string[],
    tesseract: string[]
  ): string[] {
    const USED: Set<number> = new Set();

    return tesseract.map((tPseudo) => {
      // 1) Check if there is an exact match.
      const EXACT_INDEX = original.findIndex(
        (o) => o === tPseudo && !USED.has(original.indexOf(o))
      );
      if (EXACT_INDEX !== -1) {
        USED.add(EXACT_INDEX);
        return original[EXACT_INDEX];
      }

      // 2) Otherwise, find the most similar nickname not yet used.
      let bestIndex = -1;
      let bestDistance = Infinity;

      original.forEach((o, idx) => {
        if (USED.has(idx)) return;
        const DISTANCE = distance(tPseudo.toLowerCase(), o.toLowerCase());
        if (DISTANCE < bestDistance) {
          bestDistance = DISTANCE;
          bestIndex = idx;
        }
      });

      if (bestIndex !== -1) {
        USED.add(bestIndex);
        return original[bestIndex];
      }

      // 3) If no match, return the original nickname itself.
      return tPseudo;
    });
  }

  /**
   * Extracts player names from a video frame using OCR and sorts API player data based on the detected order.
   * This function captures a frame from the game replay, reads player names using Tesseract OCR, then uses the detected order to correctly sort the player names from the API.
   * @param gameIndex Index of the game being processed.
   * @param gameFromStatistics Game data from the API containing player information.
   * @param callback Function called with the sorted orange and blue player names arrays.
   */
  private sortPlayersFromGameFrame(
    gameIndex: number,
    gameFromStatistics: RestGame,
    callback: Function
  ): void {
    if (this._videoPath) {
      ReplayCutterService.videoURLToCanvas(
        `http://localhost:${this.globalService.serverPort}/file?path=${this._videoPath}`,
        (this._games[gameIndex].start + 10) * 1000,
        async (videoFrame?: HTMLCanvasElement) => {
          if (videoFrame) {
            const ORANGE_PLAYERS_NAMES: string[] = [];
            const BLUE_PLAYERS_NAMES: string[] = [];
            for (
              let i = 0;
              i < MODES[this._games[gameIndex].mode].gameFrame.playersY.length;
              i++
            ) {
              ORANGE_PLAYERS_NAMES.push(
                await ReplayCutterService.getTextFromImage(
                  videoFrame,
                  this.tesseractWorker_basic!,
                  MODES[this._games[gameIndex].mode].gameFrame
                    .orangePlayersX[0],
                  MODES[this._games[gameIndex].mode].gameFrame.playersY[i][0],
                  MODES[this._games[gameIndex].mode].gameFrame
                    .orangePlayersX[1],
                  MODES[this._games[gameIndex].mode].gameFrame.playersY[i][1],
                  7,
                  225,
                  true
                )
              );
              BLUE_PLAYERS_NAMES.push(
                await ReplayCutterService.getTextFromImage(
                  videoFrame,
                  this.tesseractWorker_basic!,
                  MODES[this._games[gameIndex].mode].gameFrame.bluePlayersX[0],
                  MODES[this._games[gameIndex].mode].gameFrame.playersY[i][0],
                  MODES[this._games[gameIndex].mode].gameFrame.bluePlayersX[1],
                  MODES[this._games[gameIndex].mode].gameFrame.playersY[i][1],
                  7,
                  225,
                  true
                )
              );
            }

            const SORTED_ORANGE_PLAYERS_NAMES = this.sortByTesseractOrder(
              gameFromStatistics.orangePlayers,
              ORANGE_PLAYERS_NAMES
            );
            const SORTED_BLUE_PLAYERS_NAMES = this.sortByTesseractOrder(
              gameFromStatistics.bluePlayers,
              BLUE_PLAYERS_NAMES
            );
            callback(SORTED_ORANGE_PLAYERS_NAMES, SORTED_BLUE_PLAYERS_NAMES);
          }
        }
      );
    }
  }

  /**
   * This function allows the user to upload their cut game.
   * @param gameIndex Index of the game to upload.
   * @param miniMapPositions Position of the minimap.
   * @param gameID ID of the game.
   */
  private uploadGameMiniMap(
    gameIndex: number,
    miniMapPositions: CropperPosition,
    margedMiniMapPositions: CropperPosition,
    gameFromStatistics: RestGame,
    orangeTeamInfosPosition: CropperPosition,
    blueTeamInfosPosition: CropperPosition,
    orangeNamesAsImage: string,
    blueNamesAsImage: string
  ): void {
    if (this._videoPath) {
      // We sort the list of players in the correct order.
      this.globalService.loading = this.translateService.instant(
        'view.replay_cutter.detectingPlayerNicknames'
      );
      this.sortPlayersFromGameFrame(
        gameIndex,
        gameFromStatistics,
        (
          sortedOrangePlayersNames: string[],
          sortedBluePlayersNames: string[]
        ) => {
          this.dialogService
            .open(ReplayCutterCheckPlayersOrderDialog, {
              data: {
                orangePlayersNames: sortedOrangePlayersNames,
                bluePlayersNames: sortedBluePlayersNames,
                orangeNamesAsImage: orangeNamesAsImage,
                blueNamesAsImage: blueNamesAsImage,
                replayCutterComponent: this,
                gameIndex: gameIndex
              },
              autoFocus: false,
              width: '500px'
            })
            .afterClosed()
            .subscribe(
              (newData: {
                orangePlayersNames: string[];
                bluePlayersNames: string[];
              }) => {
                if (newData) {
                  const TOP_INFOS_WIDTH: number = 556;
                  const TOP_INFOS_HEIGHT: number = 78;
                  const TOP_INFOS_POSITION: CropperPosition = {
                    x1: (1920 - TOP_INFOS_WIDTH) / 2,
                    y1: 0,
                    x2: (1920 + TOP_INFOS_WIDTH) / 2,
                    y2: TOP_INFOS_HEIGHT
                  };
                  window.electronAPI.uploadGameMiniMap(
                    gameIndex,
                    this._games[gameIndex],
                    miniMapPositions,
                    margedMiniMapPositions,
                    decodeURIComponent(this._videoPath!),
                    gameFromStatistics.ID,
                    orangeTeamInfosPosition,
                    blueTeamInfosPosition,
                    TOP_INFOS_POSITION,
                    newData.orangePlayersNames,
                    newData.bluePlayersNames
                  );
                } else {
                  this.globalService.loading = undefined;
                }
              }
            );
        }
      );
    }
  }

  /**
   * Determines the actual start and end times when a game is playing within a video.
   * It checks both the start and end bounds by analyzing the video frames.
   * @param game The game object containing initial start and end times.
   * @returns A promise resolving to the updated game with corrected bounds, or null if not found.
   */
  private getGamePlayingBounds(game: Game): Promise<Game | null> {
    return new Promise((resolve) => {
      const GAME = new Game(game.mode);
      const URL: string = `http://localhost:${this.globalService.serverPort}/file?path=${this.videoPath}`;

      console.log('Getting game start...');
      this.getGamePlayingBound(URL, GAME, game.start, 1).then((start) => {
        if (start !== null) {
          game.start = start;

          console.log('Getting game end...');
          this.getGamePlayingBound(URL, GAME, game.end, -1).then((end) => {
            if (end !== null) {
              game.end = end;
              resolve(game);
            } else {
              resolve(null);
            }
          });
        } else {
          resolve(null);
        }
      });
    });
  }

  /**
   * Finds the nearest timestamp in a video where the game starts or ends.
   * It seeks through the video frame by frame and uses detectGamePlaying to check.
   * @param url The URL of the video.
   * @param game The game object to check against.
   * @param start Initial timestamp to start searching from.
   * @param jump Time increment per seek (positive for forward, negative for backward).
   * @returns A promise resolving to the timestamp where the game is detected, or null if not found.
   */
  private getGamePlayingBound(
    url: string,
    game: Game,
    start: number,
    jump: number
  ): Promise<number | null> {
    const VIDEO = document.createElement('video');
    console.log('getGamePlayingBound', start);

    return new Promise((resolve) => {
      const ON_SEEKED = () => {
        const FRAME_DATA = ReplayCutterService.captureFrameData(VIDEO);
        if (
          FRAME_DATA &&
          ReplayCutterService.detectGamePlaying(FRAME_DATA, [game], true)
        ) {
          resolve(VIDEO.currentTime);
          CLEAN();
        } else if (VIDEO.currentTime + jump < VIDEO.duration) {
          VIDEO.currentTime += jump;
        } else {
          CLEAN();
          resolve(null);
        }
      };

      const CLEAN = () => {
        VIDEO.removeEventListener('seeked', ON_SEEKED);
        VIDEO.removeEventListener('error', ON_ERROR);
        VIDEO.pause();
        VIDEO.src = '';
      };

      const ON_ERROR = () => {
        console.error('Erreur chargement vidéo');
        CLEAN();
        resolve(null);
      };

      VIDEO.addEventListener('loadeddata', () => {
        VIDEO.currentTime = start;
      });
      VIDEO.addEventListener('error', ON_ERROR);
      VIDEO.addEventListener('seeked', ON_SEEKED);

      VIDEO.src = url;
    });
  }

  /**
   * Gets video information (width, height, duration) by creating a video element
   */
  public static getVideoInfo(
    videoUrl: string
  ): Promise<{ width: number; height: number; duration: number }> {
    return new Promise((resolve, reject) => {
      const VIDEO = document.createElement('video');
      VIDEO.preload = 'metadata';
      VIDEO.crossOrigin = 'anonymous';

      VIDEO.onloadedmetadata = () => {
        resolve({
          width: VIDEO.videoWidth,
          height: VIDEO.videoHeight,
          duration: VIDEO.duration
        });
      };

      VIDEO.onerror = () => {
        reject(new Error('Failed to load video metadata'));
      };

      VIDEO.src = videoUrl;
    });
  }

  /**
   * Handles the user's click on the file input to select a replay video.
   * Initializes the state for a new replay selection and opens the file dialog.
   * @param training Indicates whether the replay is for training mode.
   */
  protected onInputFileClick(training: boolean): void {
    if (!this.inputFileDisabled) {
      this.training = training;
      this.globalService.loading = '';
      this.videoPath = undefined;
      this._games = [];

      window.electronAPI
        .openFiles(['mp4', 'mkv'])
        .then((filesPath: string[]) => {
          if (filesPath.length > 0) {
            window.electronAPI
              .fixMp4ForBrowser(filesPath[0])
              .then((filePath: string) => {
                this.analyzeVideoFile(training, filePath);
              });
          }
        });
    }
  }

  private analyzeVideoFile(training: boolean, videoFilePath: string): void {
    ReplayCutterService.videoURLToCanvas(
      `http://localhost:${this.globalService.serverPort}/file?path=${encodeURIComponent(videoFilePath)}`,
      15 * 1000,
      (videoFrame?: HTMLCanvasElement) => {
        if (videoFrame) {
          const SIZE = ReplayCutterService.getSourceSize(videoFrame);
          const TARGET_WIDTH: number = 1920;
          const TARGET_HEIGHT: number = 1080;

          console.log(SIZE);

          if (SIZE.width == TARGET_WIDTH && SIZE.height == TARGET_HEIGHT) {
            if (training) {
              this.startPythonAnalysis(videoFilePath);
            } else {
              const DIALOG_WIDTH = 'calc(100vw - 12px * 4)';
              this.dialogService
                .open(ReplayCutterManualVideoCutDialog, {
                  autoFocus: false,
                  data: videoFilePath,
                  width: DIALOG_WIDTH,
                  maxWidth: DIALOG_WIDTH
                })
                .afterClosed()
                .subscribe((response: VideoChunk[] | undefined) => {
                  window.electronAPI.setWindowSize();
                  if (response) {
                    this.globalService.loading = '';

                    setTimeout(() => {
                      this.translateService
                        .get('view.notification.manual-cutting.description')
                        .subscribe(async (translated: string) => {
                          const CUTTED_FILE_PATH =
                            await window.electronAPI.manualCutVideoFile(
                              videoFilePath,
                              response,
                              JSON.stringify({
                                percent: 0,
                                infinite: true,
                                icon: 'fa-sharp fa-solid fa-scissors',
                                text: translated,
                                leftRounded: true
                              })
                            );
                          console.log(CUTTED_FILE_PATH);
                          if (CUTTED_FILE_PATH) {
                            this.analyzeVideoFile(true, CUTTED_FILE_PATH);
                          }
                        });
                    }, 1000);
                  } else {
                    this.globalService.loading = undefined;
                  }
                });
            }
          } else {
            this.dialogService
              .open(ReplayCutterUpscaleConfirmationDialog, {
                autoFocus: false,
                disableClose: true,
                data: SIZE.height
              })
              .afterClosed()
              .subscribe(async (upscale: boolean) => {
                if (upscale) {
                  this.translateService
                    .get('view.notification.upscaling.description')
                    .subscribe((translated: string) => {
                      window.electronAPI.showNotification(
                        true,
                        550,
                        150,
                        JSON.stringify({
                          percent: 0,
                          infinite: false,
                          icon: undefined,
                          text: translated,
                          leftRounded: true
                        })
                      );
                    });

                  const RESCALED_FILE_PATH =
                    await window.electronAPI.setVideoResolution(
                      videoFilePath,
                      TARGET_WIDTH,
                      TARGET_HEIGHT
                    );
                  if (RESCALED_FILE_PATH) {
                    this.analyzeVideoFile(training, RESCALED_FILE_PATH);
                  }
                } else {
                  this.globalService.loading = undefined;
                }
              });
          }
        }
      }
    );
  }

  /**
   * Launches the Python analyzer binary and wires up progress/result updates.
   * @param videoFilePath Absolute path to the 1920×1080 video to analyse.
   */
  private startPythonAnalysis(videoFilePath: string): void {
    this.percent = 0;
    this.globalService.loading = '';
    this._videoPath = videoFilePath;
    this._games = [];
    this.pythonAnalysisRunning = true;

    this.translateService
      .get('view.replay_cutter.videoIsBeingAnalyzed', { games: 0 })
      .subscribe((translated: string) => {
        window.electronAPI.showNotification(
          true,
          500,
          150,
          JSON.stringify({
            percent: 0,
            infinite: false,
            icon: undefined,
            text: translated,
            leftRounded: true
          })
        );
      });

    window.electronAPI.runAnalyzer(
      videoFilePath,
      JSON.stringify({
        orangeTeamName: this.settings.orangeTeamName,
        blueTeamName: this.settings.blueTeamName
      })
    );
  }

  /**
   * Reconstructs a typed Game instance from a plain JSON object emitted by the Python analyzer.
   */
  private createGameFromJSON(data: {
    mode: number;
    start: number;
    end: number;
    map: string;
    mapImage?: string;
    orangeTeam: {
      name: string;
      score: number;
      nameImage?: string;
      scoreImage?: string;
    };
    blueTeam: {
      name: string;
      score: number;
      nameImage?: string;
      scoreImage?: string;
    };
  }): Game {
    const GAME = new Game(data.mode ?? 0);
    GAME.start = data.start ?? 0;
    GAME.end = data.end ?? 0;
    GAME.map = data.map ?? '';
    GAME.mapImage = data.mapImage ?? undefined;
    GAME.orangeTeam.name = data.orangeTeam?.name ?? '';
    GAME.orangeTeam.score = data.orangeTeam?.score ?? 0;
    GAME.orangeTeam.nameImage = data.orangeTeam?.nameImage ?? undefined;
    GAME.orangeTeam.scoreImage = data.orangeTeam?.scoreImage ?? undefined;
    GAME.blueTeam.name = data.blueTeam?.name ?? '';
    GAME.blueTeam.score = data.blueTeam?.score ?? 0;
    GAME.blueTeam.nameImage = data.blueTeam?.nameImage ?? undefined;
    GAME.blueTeam.scoreImage = data.blueTeam?.scoreImage ?? undefined;
    return GAME;
  }

  /**
   * Sets the video's playhead to the end once the video has loaded.
   * @param event The loaded data event from the video element.
   */
  protected videoLoadedData(event: Event): void {
    if (this.pythonAnalysisRunning) {
      return;
    }
    if (event.target) {
      const VIDEO = event.target as HTMLVideoElement;
      VIDEO.currentTime = VIDEO.duration;
    }
  }

  /**
   * Handles updates to the video's current time during playback for analysis purposes.
   * This function analyzes each frame to detect game start, end, score frames, team names, and map names.
   * It updates the progress percentage, extracts relevant images and text using OCR, and manages game states.
   * Supports debug pause mode, automatic time jumps to game start, and notifications of analysis progress.
   * @param event The time update event from the video element.
   */
  protected async videoTimeUpdate(event: Event): Promise<void> {
    if (this.pythonAnalysisRunning) {
      return;
    }
    if (this.debugPause) {
      setTimeout(() => {
        this.videoTimeUpdate(event);
      }, 1000);
    } else {
      if (this._videoPath) {
        if (this.start == 0) {
          this.start = Date.now();
        }
        if (event.target) {
          const VIDEO = event.target as HTMLVideoElement;
          let found: boolean = false;
          const DEFAULT_STEP: number = 1;
          if (VIDEO.currentTime > 0) {
            const NOW: number = VIDEO.currentTime;
            this.percent = Math.ceil(100 - (NOW / VIDEO.duration) * 100);

            this.translateService
              .get('view.replay_cutter.videoIsBeingAnalyzed', {
                games: this._games.length
              })
              .subscribe((translated: string) => {
                this.notificationService.sendMessage({
                  percent: this.percent,
                  infinite: false,
                  icon: undefined,
                  text: translated,
                  leftRounded: true,
                  state: 'info'
                });
              });

            const FRAME_DATA = ReplayCutterService.captureFrameData(VIDEO);
            if (!FRAME_DATA) {
              return;
            }

            //#region Detection of a game score frame

            if (!found) {
              const MODE = ReplayCutterService.detectGameScoreFrame(FRAME_DATA);
              if (MODE >= 0) {
                found = true;
                if (this._games.length == 0 || this._games[0].start != -1) {
                  if (MODE >= 0) {
                    this.justJumped = false;
                    const GAME: Game = new Game(MODE);
                    GAME.end = NOW - 1;
                    //#region Orange team

                    const ORANGE_TEAM_NAME: string =
                      await ReplayCutterService.getTextFromImage(
                        VIDEO,
                        this.tesseractWorker_basic!,
                        MODES[MODE].scoreFrame.orangeName[0].x,
                        MODES[MODE].scoreFrame.orangeName[0].y,
                        MODES[MODE].scoreFrame.orangeName[1].x,
                        MODES[MODE].scoreFrame.orangeName[1].y,
                        7,
                        225,
                        true
                      );
                    if (this.settings.orangeTeamName.trim()) {
                      GAME.orangeTeam.name = this.settings.orangeTeamName
                        .trim()
                        .toUpperCase();
                    } else if (
                      ORANGE_TEAM_NAME &&
                      ORANGE_TEAM_NAME.length >= 2
                    ) {
                      GAME.orangeTeam.name = ORANGE_TEAM_NAME.toUpperCase();
                    }

                    const ORANGE_TEAM_SCORE: string =
                      await ReplayCutterService.getTextFromImage(
                        VIDEO,
                        this.tesseractWorker_number!,
                        MODES[MODE].scoreFrame.orangeScore[0].x,
                        MODES[MODE].scoreFrame.orangeScore[0].y,
                        MODES[MODE].scoreFrame.orangeScore[1].x,
                        MODES[MODE].scoreFrame.orangeScore[1].y,
                        7,
                        200,
                        true,
                        undefined,
                        ReplayCutterService.scoreChecker
                      );
                    if (ORANGE_TEAM_SCORE) {
                      const INT_VALUE = Number.parseInt(ORANGE_TEAM_SCORE);
                      if (INT_VALUE <= 100) {
                        GAME.orangeTeam.score = INT_VALUE;
                      }
                    }

                    //#endregion

                    //#region Blue team

                    const BLUE_TEAM_NAME: string =
                      await ReplayCutterService.getTextFromImage(
                        VIDEO,
                        this.tesseractWorker_basic!,
                        MODES[MODE].scoreFrame.blueName[0].x,
                        MODES[MODE].scoreFrame.blueName[0].y,
                        MODES[MODE].scoreFrame.blueName[1].x,
                        MODES[MODE].scoreFrame.blueName[1].y,
                        7,
                        225,
                        false,
                        true
                      );

                    if (this.settings.blueTeamName.trim()) {
                      GAME.blueTeam.name = this.settings.blueTeamName
                        .trim()
                        .toUpperCase();
                    } else if (BLUE_TEAM_NAME && BLUE_TEAM_NAME.length >= 2) {
                      GAME.blueTeam.name = BLUE_TEAM_NAME.toUpperCase();
                    }

                    const BLUE_TEAM_SCORE: string =
                      await ReplayCutterService.getTextFromImage(
                        VIDEO,
                        this.tesseractWorker_number!,
                        MODES[MODE].scoreFrame.blueScore[0].x,
                        MODES[MODE].scoreFrame.blueScore[0].y,
                        MODES[MODE].scoreFrame.blueScore[1].x,
                        MODES[MODE].scoreFrame.blueScore[1].y,
                        7,
                        200,
                        true,
                        undefined,
                        ReplayCutterService.scoreChecker
                      );
                    // DEBUG
                    this.debug?.nativeElement.append(
                      ReplayCutterService.videoToCanvas(VIDEO)
                    );
                    if (BLUE_TEAM_SCORE) {
                      const INT_VALUE = Number.parseInt(BLUE_TEAM_SCORE);
                      if (INT_VALUE <= 100) {
                        GAME.blueTeam.score = INT_VALUE;
                      }
                    }

                    //#endregion

                    const FRAME = ReplayCutterService.videoToCanvas(VIDEO);
                    if (FRAME) {
                      GAME.orangeTeam.scoreImage =
                        ReplayCutterService.cropImage(
                          FRAME,
                          MODES[MODE].scoreFrame.orangeScore[0].x,
                          MODES[MODE].scoreFrame.orangeScore[0].y,
                          MODES[MODE].scoreFrame.orangeScore[1].x,
                          MODES[MODE].scoreFrame.orangeScore[1].y
                        )?.toDataURL();

                      GAME.orangeTeam.nameImage = ReplayCutterService.cropImage(
                        FRAME,
                        MODES[MODE].scoreFrame.orangeName[0].x,
                        MODES[MODE].scoreFrame.orangeName[0].y,
                        MODES[MODE].scoreFrame.orangeName[1].x,
                        MODES[MODE].scoreFrame.orangeName[1].y
                      )?.toDataURL();

                      GAME.blueTeam.scoreImage = ReplayCutterService.cropImage(
                        FRAME,
                        MODES[MODE].scoreFrame.blueScore[0].x,
                        MODES[MODE].scoreFrame.blueScore[0].y,
                        MODES[MODE].scoreFrame.blueScore[1].x,
                        MODES[MODE].scoreFrame.blueScore[1].y
                      )?.toDataURL();

                      GAME.blueTeam.nameImage = ReplayCutterService.cropImage(
                        FRAME,
                        MODES[MODE].scoreFrame.blueName[0].x,
                        MODES[MODE].scoreFrame.blueName[0].y,
                        MODES[MODE].scoreFrame.blueName[1].x,
                        MODES[MODE].scoreFrame.blueName[1].y
                      )?.toDataURL();
                    }

                    this._games.unshift(GAME);

                    this.translateService
                      .get('view.replay_cutter.videoIsBeingAnalyzed', {
                        games: this._games.length
                      })
                      .subscribe((translated: string) => {
                        this.notificationService.sendMessage({
                          percent: this.percent,
                          infinite: false,
                          icon: undefined,
                          text: translated,
                          leftRounded: true,
                          state: 'info'
                        });
                      });
                  }
                } else if (
                  this.lastDetectedGamePlayingFrame &&
                  this._games[0].start == -1
                ) {
                  /*
                  console.log('SUPER SOLVE');
                  this._games[0].start = this.lastDetectedGamePlayingFrame;
                  this.lastDetectedGamePlayingFrame = undefined;
                  console.log(this._games[0].map);
                  */
                }
              }
            }

            //#endregion

            //#region Detection of the end of a game

            if (!found) {
              if (ReplayCutterService.detectGameEndFrame(FRAME_DATA)) {
                found = true;

                if (this._games.length == 0 || this._games[0].start != -1) {
                  this.justJumped = false;
                  const GAME: Game = new Game(1);
                  GAME.end = NOW;

                  const ORANGE_TEAM_SCORE: string =
                    await ReplayCutterService.getTextFromImage(
                      VIDEO,
                      this.tesseractWorker_number!,
                      636,
                      545,
                      903,
                      648,
                      7
                    );
                  if (ORANGE_TEAM_SCORE) {
                    const INT_VALUE = Number.parseInt(ORANGE_TEAM_SCORE);
                    if (INT_VALUE <= 100) {
                      GAME.orangeTeam.score = INT_VALUE;
                    }
                  }

                  const BLUE_TEAM_SCORE: string =
                    await ReplayCutterService.getTextFromImage(
                      VIDEO,
                      this.tesseractWorker_number!,
                      996,
                      545,
                      1257,
                      648,
                      7
                    );
                  if (BLUE_TEAM_SCORE) {
                    const INT_VALUE = Number.parseInt(BLUE_TEAM_SCORE);
                    if (INT_VALUE <= 100) {
                      GAME.blueTeam.score = INT_VALUE;
                    }
                  }

                  this._games.unshift(GAME);
                } else if (
                  this.lastDetectedGamePlayingFrame &&
                  this._games[0].start == -1
                ) {
                  /*
                  console.log('SUPER SOLVE 2222222222222');
                  this._games[0].start = this.lastDetectedGamePlayingFrame;
                  this.lastDetectedGamePlayingFrame = undefined;
                  console.log(this._games[0].map);
                  */
                }
              }
            }

            //#endregion

            //#region Detection of the start of a game

            if (!found) {
              if (
                ReplayCutterService.detectGameLoadingFrame(
                  FRAME_DATA,
                  this._games
                )
              ) {
                found = true;
                this.lastDetectedGamePlayingFrame = undefined;
                this._games[0].start =
                  NOW + 2 /* We remove the map loader end. */;
              }
            }

            if (!found) {
              if (
                ReplayCutterService.detectGameIntro(FRAME_DATA, this._games)
              ) {
                found = true;
                this.lastDetectedGamePlayingFrame = undefined;
                this._games[0].start =
                  NOW + 2 /* We remove the map animation bit. */;
              }
            }

            //#endregion

            //#region Detecting card name during game.

            if (!found) {
              if (
                ReplayCutterService.detectGamePlaying(FRAME_DATA, this._games)
              ) {
                this.lastDetectedGamePlayingFrame = NOW;
                // We are looking for the name of the map.
                if (this._games[0].map == '') {
                  const TEXT: string =
                    await ReplayCutterService.getTextFromImage(
                      VIDEO,
                      this.tesseractWorker_letter!,
                      MODES[this._games[0].mode].gameFrame.map[0].x,
                      MODES[this._games[0].mode].gameFrame.map[0].y,
                      MODES[this._games[0].mode].gameFrame.map[1].x,
                      MODES[this._games[0].mode].gameFrame.map[1].y,
                      7,
                      225,
                      true
                    );

                  if (TEXT) {
                    found = true;
                    if (this._games[0].map == '') {
                      const MAP_NAME: string =
                        ReplayCutterService.getMapByName(TEXT)?.name ?? '';
                      this._games[0].map = MAP_NAME;

                      const FRAME = ReplayCutterService.videoToCanvas(VIDEO);
                      if (FRAME) {
                        this._games[0].mapImage = ReplayCutterService.cropImage(
                          FRAME,
                          MODES[this._games[0].mode].gameFrame.map[0].x,
                          MODES[this._games[0].mode].gameFrame.map[0].y,
                          MODES[this._games[0].mode].gameFrame.map[1].x,
                          MODES[this._games[0].mode].gameFrame.map[1].y
                        )?.toDataURL();
                      }
                    }
                  }
                }

                // We are looking for the name of the orange team.
                if (this._games[0].orangeTeam.name == '') {
                  const TEXT: string =
                    await ReplayCutterService.getTextFromImage(
                      VIDEO,
                      this.tesseractWorker_basic!,
                      MODES[this._games[0].mode].gameFrame.orangeName[0].x,
                      MODES[this._games[0].mode].gameFrame.orangeName[0].y,
                      MODES[this._games[0].mode].gameFrame.orangeName[1].x,
                      MODES[this._games[0].mode].gameFrame.orangeName[1].y,
                      6
                    );
                  if (TEXT && TEXT.length >= 2) {
                    found = true;
                    if (this._games[0].orangeTeam.name == '') {
                      this._games[0].orangeTeam.name = TEXT.toUpperCase();
                    }
                  }
                }

                // We are looking for the name of the blue team.
                if (this._games[0].blueTeam.name == '') {
                  const TEXT: string =
                    await ReplayCutterService.getTextFromImage(
                      VIDEO,
                      this.tesseractWorker_basic!,
                      MODES[this._games[0].mode].gameFrame.blueName[0].x,
                      MODES[this._games[0].mode].gameFrame.blueName[0].y,
                      MODES[this._games[0].mode].gameFrame.blueName[1].x,
                      MODES[this._games[0].mode].gameFrame.blueName[1].y,
                      6
                    );
                  if (TEXT && TEXT.length >= 2) {
                    found = true;
                    if (this._games[0].blueTeam.name == '') {
                      this._games[0].blueTeam.name = TEXT.toUpperCase();
                    }
                  }
                }

                if (
                  this._games[0].orangeTeam.name &&
                  this._games[0].blueTeam.name &&
                  this._games[0].map
                ) {
                  if (!this._games[0].__debug__jumped) {
                    if (!this.justJumped) {
                      const TEXT: string =
                        await ReplayCutterService.getTextFromImage(
                          VIDEO,
                          this.tesseractWorker_time!,
                          MODES[this._games[0].mode].gameFrame.timer[0].x,
                          MODES[this._games[0].mode].gameFrame.timer[0].y,
                          MODES[this._games[0].mode].gameFrame.timer[1].x,
                          MODES[this._games[0].mode].gameFrame.timer[1].y,
                          7
                        );
                      if (TEXT) {
                        found = true;
                        const SPLITTED /* string[] */ = TEXT.split(':');
                        if (SPLITTED.length == 2) {
                          const MINUTES = Number.parseInt(SPLITTED[0]);
                          const SECONDES = Number.parseInt(SPLITTED[1]);

                          if (
                            !Number.isNaN(MINUTES) &&
                            !Number.isNaN(SECONDES)
                          ) {
                            if (MINUTES <= 9) {
                              const DIFFERENCE = Math.max(
                                (this.settings.maxTimePerGame - MINUTES) * 60 -
                                  SECONDES -
                                  20
                              );
                              if (!this._games[0].__debug__jumped) {
                                this._games[0].__debug__jumped = true;
                                console.log(
                                  `All game data has been recovered. Jumping to game's start ! (${MINUTES}:${SECONDES}) (${NOW - DIFFERENCE})`
                                );
                                this.lastDetectedGamePlayingFrame =
                                  NOW - DIFFERENCE;
                                this.justJumped = true;
                                this.setVideoCurrentTime(
                                  VIDEO,
                                  NOW - DIFFERENCE,
                                  this._games
                                );
                                return;
                              }
                            }
                          }
                        }
                      }
                    } else {
                      console.log('Jump is disabled');
                    }
                  }
                }
              }
            }

            //#endregion

            this.setVideoCurrentTime(
              VIDEO,
              Math.max(0, NOW - DEFAULT_STEP),
              this._games
            );
          } else {
            this.onVideoEnded(this._games);

            const DIFFERENCE = Date.now() - this.start;
            const MINUTES = Math.floor(DIFFERENCE / 60000);
            const SECONDS = Math.floor((DIFFERENCE % 60000) / 1000);

            console.log(
              `Scan duration:\n${MINUTES.toString().padStart(
                2,
                '0'
              )}m ${SECONDS.toString().padStart(2, '0')}s`
            );
            this.start = 0;
          }
        }
      }
    }
  }

  /**
   * This function allows you to set the timecode of the video.
   * @param video HTML DOM of the video element to set the timecode to
   * @param time Timecode in seconds to apply.
   * @param games List of games already detected.
   * @param discordServerURL EBP Discord server URL.
   */
  private setVideoCurrentTime(
    video: HTMLVideoElement,
    time: number,
    games: Game[]
  ): void {
    if (video) {
      if (time < video.duration) {
        if (this.videoOldTime == time) {
          console.warn(
            'The "setVideoCurrentTime" function seems to fail to change the video time. The analysis is considered finished.'
          );
          this.onVideoEnded(games);
        } else {
          video.currentTime = time;
          this.videoOldTime = time;
        }
      } else {
        this.onVideoEnded(games);
      }
    }
  }

  /**
   * This function is executed when the video scan is complete.
   * @param games List of detected games.
   */
  private onVideoEnded(games: Game[]): void {
    if (games.length == 0) {
      this.translateService
        .get('view.replay_cutter.toast.noGamesFoundInVideo')
        .subscribe((translated: string) => {
          this.toastrService.error(translated).onTap.subscribe(() => {
            window.electronAPI.openURL(this.globalService.discordServerURL);
          });
        });
    }
    this.percent = -1;
    console.log('onVideoEnded:\n', this._games);
    this.videoOldTime = undefined;
    window.electronAPI.removeNotification(true);
    this.globalService.loading = undefined;
  }

  /**
   * This function allows the user to mute one of his games.
   * @param game Game to cut.
   */
  protected async save(game: Game): Promise<void> {
    if (this.videoPath === undefined) {
      this.translateService
        .get('view.replay_cutter.toast.videoFileNotFound')
        .subscribe((translated: string) => {
          this.toastrService.error(translated);
        });
      return;
    }
    this.globalService.loading = '';
    const FILE_PATH = await window.electronAPI.cutVideoFile(
      game,
      decodeURIComponent(this.videoPath),
      this.settings.freeText
    );
    this.globalService.loading = undefined;
    this.translateService
      .get('view.replay_cutter.toast.videoCutHere', { filePath: FILE_PATH })
      .subscribe((translated: string) => {
        this.toastrService.success(translated).onTap.subscribe(() => {
          window.electronAPI.openFile(FILE_PATH);
        });
      });
  }

  /**
   * This function allows the user to cut all games with a single click.
   */
  protected async saveAll(): Promise<void> {
    if (this.videoPath === undefined) {
      this.translateService
        .get('view.replay_cutter.toast.videoFileNotFound')
        .subscribe((translated: string) => {
          this.toastrService.error(translated);
        });
      return;
    }
    this.globalService.loading = '';
    const FILE_PATH = await window.electronAPI.cutVideoFiles(
      this._games.filter((game) => game.checked),
      decodeURIComponent(this.videoPath),
      this.settings.freeText
    );

    this.globalService.loading = undefined;
    this.translateService
      .get('view.replay_cutter.toast.videosCutHere', { filePath: FILE_PATH })
      .subscribe((translated: string) => {
        this.toastrService.success(translated).onTap.subscribe(() => {
          window.electronAPI.openFile(FILE_PATH);
        });
      });
  }

  /**
   * This function adds game timecodes to the user's clipboard.
   */
  protected copyTimeCodes(): void {
    let result = '';
    this._games
      .filter((game) => game.checked)
      .forEach((game) => {
        result += `${game.readableStart} ${game.orangeTeam.name} vs ${game.blueTeam.name} - ${game.map}\n`;
      });
    navigator.clipboard.writeText(result);

    this.translateService
      .get('view.replay_cutter.toast.timeCodesCopiedClipboard')
      .subscribe((translated: string) => {
        this.toastrService.success(translated);
      });
  }

  /**
   * Opens a dialog to edit the map of a given game and updates the game with the selected map.
   * @param game The game object whose map is being edited
   */
  protected editGameMap(game: Game): void {
    this.dialogService
      .open(ReplayCutterEditMapDialog, {
        data: {
          map: game.map,
          maps: this.maps.map((x) => x.name)
        },
        width: '400px'
      })
      .afterClosed()
      .subscribe((newMap: string | undefined) => {
        if (newMap) {
          game.map = newMap;
        }
      });
  }

  /**
   * Opens a dialog to edit the score of a specific team for a given game.
   * @param game The game object to modify.
   * @param team The team whose score should be edited ('orange' or 'blue').
   */
  protected editTeamScore(game: Game, team: 'orange' | 'blue'): void {
    const CURRENT_SCORE =
      team === 'orange' ? game.orangeTeam.score : game.blueTeam.score;

    this.dialogService
      .open(ReplayCutterEditTeamScoreDialog, {
        data: CURRENT_SCORE,
        width: '400px'
      })
      .afterClosed()
      .subscribe((newScore: number | undefined) => {
        if (newScore) {
          if (team === 'orange') {
            game.orangeTeam.score = newScore;
          } else {
            game.blueTeam.score = newScore;
          }
        }
      });
  }

  /**
   * Captures a specific frame from the video at a given game time and crops it to the specified rectangle.
   * Returns the cropped frame as a data URL.
   * @param gameTimeMs The time in milliseconds of the frame to capture.
   * @param x1 The left coordinate of the crop.
   * @param y1 The top coordinate of the crop.
   * @param x2 The right coordinate of the crop.
   * @param y2 The bottom coordinate of the crop.
   * @returns A promise resolving to the cropped frame as a data URL, or undefined if capture fails.
   */
  protected async getGameCroppedFrame(
    gameTimeMs: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number
  ): Promise<string | undefined> {
    return new Promise((resolve) => {
      ReplayCutterService.videoURLToCanvas(
        `http://localhost:${this.globalService.serverPort}/file?path=${this._videoPath}`,
        gameTimeMs,
        (videoFrame?: HTMLCanvasElement) => {
          if (videoFrame) {
            resolve(
              ReplayCutterService.cropImage(
                videoFrame,
                x1,
                y1,
                x2,
                y2
              )?.toDataURL()
            );
          }
        }
      );
    });
  }

  /**
   * Opens a dialog to edit the name of a specific team for a given game.
   * @param game The game object to modify.
   * @param team The team whose name should be edited ('orange' or 'blue').
   */
  protected editTeamName(game: Game, team: 'orange' | 'blue'): void {
    const CURRENT_NAME =
      team === 'orange' ? game.orangeTeam.name : game.blueTeam.name;

    this.dialogService
      .open(ReplayCutterEditTeamNameDialog, {
        data: CURRENT_NAME,
        width: '400px'
      })
      .afterClosed()
      .subscribe((newName: string | undefined) => {
        if (newName) {
          if (team === 'orange') {
            game.orangeTeam.name = newName;
          } else {
            game.blueTeam.name = newName;
          }
        }
      });
  }

  /**
   * Handler called when the page visibility changes.
   * If the page becomes visible and a game is being created, it removes any notification via the Electron API.
   */
  private visibilityChangeHandler(): void {
    if (!document.hidden) {
      if (this.creatingAGame !== undefined) {
        window.electronAPI.removeNotification(true);
        this.selectWhichGameToAttachMinimap(this.creatingAGame);
        this.creatingAGame = undefined;
      }
    }
  }

  protected openRemoveBorderDialog(): void {
    this.dialogService
      .open(ReplayCutterBeforeRemovingBordersDialog, {
        autoFocus: false
      })
      .afterClosed()
      .subscribe((crop: boolean | undefined) => {
        if (crop === true) {
          window.electronAPI
            .openFiles(['mp4', 'mkv'])
            .then((filesPath: string[]) => {
              if (filesPath.length > 0) {
                ReplayCutterService.videoURLToCanvas(
                  `http://localhost:${this.globalService.serverPort}/file?path=${filesPath[0]}`,
                  15 * 1000,
                  (videoFrame?: HTMLCanvasElement) => {
                    if (videoFrame) {
                      const DIALOG_WIDTH: string = 'calc(100vw - 12px * 4)';
                      const DIALOG_HEIGHT: string = 'calc(100vh - 12px * 4)';
                      const SIZE =
                        ReplayCutterService.getSourceSize(videoFrame);

                      this.dialogService
                        .open(ReplayCutterCropDialog, {
                          data: {
                            imgBase64: videoFrame.toDataURL('image/png'),
                            initialCropperPosition: {
                              x1: 0,
                              y1: 0,
                              x2: SIZE.width,
                              y2: SIZE.height
                            },
                            component: this,
                            gameIndex: -1
                          },
                          maxWidth: DIALOG_WIDTH,
                          maxHeight: DIALOG_HEIGHT,
                          width: DIALOG_WIDTH,
                          height: DIALOG_HEIGHT,
                          autoFocus: false
                        })
                        .afterClosed()
                        .subscribe((positions: CropperPosition | undefined) => {
                          window.electronAPI.setWindowSize();
                          if (positions) {
                            this.translateService
                              .get(
                                'view.notification.removing-border.description'
                              )
                              .subscribe((translated: string) => {
                                window.electronAPI.showNotification(
                                  true,
                                  500,
                                  150,
                                  JSON.stringify({
                                    percent: 0,
                                    infinite: false,
                                    icon: undefined,
                                    text: translated,
                                    leftRounded: true
                                  })
                                );
                              });
                            this.globalService.loading = '';
                            window.electronAPI.removeBorders(
                              positions,
                              filesPath[0]
                            );
                          } else {
                            this.globalService.loading = undefined;
                          }
                        });
                    }
                  }
                );
              }
            });
        } else {
          this.globalService.loading = undefined;
        }
      });
  }

  //#endregion
}
