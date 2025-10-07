// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { CommonModule } from '@angular/common';
import {
  Component,
  ElementRef,
  isDevMode,
  NgZone,
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
import { ReplayCutterCropDialog } from './dialog/crop/crop.dialog';
import { CropperPosition } from 'ngx-image-cropper';
import { APIRestService } from '../../core/services/api-rest.service';
import { RestGame } from './models/rest-game';
import { IdentityService } from '../../core/services/identity/identity.service';
import { ReplayCutterSettingsDialog } from './dialog/settings/settings.dialog';
import { Settings } from './models/settings';
import { ReplayCutterUpscaleConfirmationDialog } from './dialog/upscale-confirmation/upscale-confirmation.dialog';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { FormsModule } from '@angular/forms';
import { MODES } from './models/mode';
import { ReplayCutterEditTeamScoreDialog } from './dialog/edit-score/edit-score.dialog';
import { ReplayCutterAttachGameDialog } from './dialog/attach-game/attach-game.dialog';
import { ReplayCutterEditTeamNameDialog } from './dialog/edit-team/edit-team.dialog';
import { distance } from 'fastest-levenshtein';
import { ReplayCutterCheckPlayersOrderDialog } from './dialog/check-players-order/check-players-order.dialog';
import { ReplayCutterReplayUploadedDialog } from './dialog/replay-uploaded/replay-uploaded.dialog';
import { ReplayCutterBetaRequiredDialog } from './dialog/beta-required/beta-required.dialog';
import { ReplayCutterManualVideoCutDialog } from './dialog/manual-video-cut/manual-video-cut.dialog';
import { VideoChunk } from './models/video-chunk';
import { KillFeedService } from './services/kill-feed.service';
import { ReplayCutterEditMapDialog } from './dialog/edit-map/edit-map.dialog';
import { NotificationService } from '../notification/services/notification.service';

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
export class ReplayCutterComponent implements OnInit {
  //#region Attributes

  @ViewChild('debug') debug?: ElementRef<HTMLDivElement>;
  protected debugMode: boolean = false;
  public debugPause: boolean = false;
  private settings: Settings = new Settings();

  protected percent: number = -1;
  protected inputFileDisabled: boolean = true;
  private lastDetectedGamePlayingFrame?: number;

  private _videoPath: string | undefined;
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

  private miniMapPositionsByMap: { [mapName: string]: CropperPosition } = {};

  protected maps: Map[] = [
    new Map('Artefact', ['artefact'], [4, 1, 4, 1]),
    new Map('Atlantis', ['atlantis'], [3, 2, 3, 2]),
    new Map('Ceres', ['ceres'], [3, 2, 3, 2]),
    new Map('Engine', ['engine'], [3, 2, 3, 2]),
    new Map('Helios Station', ['helios', 'station'], [3, 2, 3, 2]),
    new Map('Lunar Outpost', ['lunar', 'outpost'], [3, 2, 3, 2]),
    new Map('Outlaw', ['outlaw', 'qutlaw'], [3, 5, 5, 3]),
    new Map('Polaris', ['polaris'], [3, 2, 3, 2]),
    new Map('Silva', ['silva'], [3, 2, 3, 2]),
    new Map('The Cliff', ['cliff'], [3, 3, 3, 3]),
    new Map('The Rock', ['rock'], [3, 2, 3, 2]),
    new Map('Horizon', ['horizon'], [3, 2, 3, 2])
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
    private readonly notificationService: NotificationService
  ) {}

  //#region Functions

  ngOnInit(): void {
    this._videoPath = undefined;
    this.initServices();

    window.electronAPI.gameIsUploaded(() => {
      this.ngZone.run(() => {
        this.globalService.loading = undefined;
        this.dialogService.open(ReplayCutterReplayUploadedDialog);
      });
    });

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
              text: translated
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
              text: translated
            });
          });
      });
    });

    // The server gives the path of the video file selected by the user.
    window.electronAPI.setVideoFile((path: string) => {
      this.ngZone.run(() => {
        if (this.training) {
          if (path) {
            this.percent = 0;
            this.globalService.loading = '';

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
                    text: translated
                  })
                );
                this._videoPath = encodeURIComponent(path);
              });
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
        this.inputFileDisabled = false;
      });
    });

    // The server asks the font-end if the user wants upscaling before analyzing.
    window.electronAPI.replayCutterUpscale((videoPath: string) => {
      this.dialogService
        .open(ReplayCutterUpscaleConfirmationDialog, {
          autoFocus: false,
          disableClose: true
        })
        .afterClosed()
        .subscribe((upscale: boolean) => {
          if (upscale) {
            window.electronAPI.openVideoFile(videoPath);

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
                    text: translated
                  })
                );
              });
          } else {
            this.globalService.loading = undefined;
            this.inputFileDisabled = false;
          }
        });
    });
  }

  protected disableUploadButton(mapName: string): boolean {
    return (
      !this._videoPath ||
      (!this.getMapByName(mapName)?.mapMargins &&
        this.identityService.isBetaUser)
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

  protected playPauseDebug(): void {
    this.debugPause = !this.debugPause;
  }

  private async initServices(): Promise<void> {
    await this.initTesseract();

    this.openCVService.isLoaded$.subscribe((loaded: boolean) => {
      if (loaded) {
        console.log('OpenCV loaded');
        this.inputFileDisabled = false;
      } else {
        console.error("OpenCV isn't loaded");
        this.toastrService.error("Erreur lors du chargement d'OpenCV");
      }
    });
  }

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
    if (this.identityService.isBetaUser) {
      this.getGamePlayingBounds(this.games[gameIndex]).then((game) => {
        if (game) {
          if (isDevMode() || this.getMapByName(game.map)?.mapMargins) {
            this.apiRestService
              .getGames(game.map, game.orangeTeam.score, game.blueTeam.score)
              .subscribe({
                next: (games: RestGame[]) => {
                  if (games && games.length > 0) {
                    this.videoURLToCanvas(
                      `http://localhost:${this.globalService.serverPort}/file?path=${this._videoPath}`,
                      Math.round((game.end - 1) * 1000),
                      (videoFrame?: HTMLCanvasElement) => {
                        if (videoFrame) {
                          const DIALOG_WIDTH: string = 'calc(100vw - 12px * 4)';
                          this.dialogService
                            .open(ReplayCutterAttachGameDialog, {
                              data: {
                                games: games,
                                image: videoFrame.toDataURL()
                              },
                              autoFocus: false,
                              width: DIALOG_WIDTH,
                              maxWidth: DIALOG_WIDTH
                            })
                            .afterClosed()
                            .subscribe((gameID: number | undefined) => {
                              if (gameID) {
                                this.cropGameMinimap(
                                  gameIndex,
                                  games.find((game) => game.ID == gameID)!
                                );
                              }
                            });
                        }
                      }
                    );
                  } else {
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
                        this.toastrService
                          .error(translated)
                          .onTap.subscribe(() => {
                            window.electronAPI.openURL(
                              this.globalService.discordServerURL
                            );
                          });
                      });
                  }
                }
              });
          } else {
            this.translateService
              .get('view.replay_cutter.toast.mapNotAICompatible', {
                map: game.map
              })
              .subscribe((translated: string) => {
                this.toastrService.error(translated);
              });
          }
        }
      });
    } else {
      this.dialogService.open(ReplayCutterBetaRequiredDialog, {
        width: '700px',
        maxWidth: '700px',
        height: '500px',
        autoFocus: false
      });
    }
  }

  /**
   * Automatically detects the minimap dimensions by analyzing the white borders in the upper left corner of the image.
   * @param videoFrame The canvas containing the image to be analyzed.
   * @returns The coordinates of the minimap (x1, y1, x2, y2) or the default values ​​if not found.
   */
  private detectMinimap(videoFrame: HTMLCanvasElement): CropperPosition {
    const BACK: CropperPosition = JSON.parse(
      JSON.stringify(ReplayCutterCropDialog.DEFAULT_CROPPER)
    );

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
      l1: for (let x = 0; x < ReplayCutterCropDialog.DEFAULT_CROPPER.x2; x++) {
        for (let y = 0; y < ReplayCutterCropDialog.DEFAULT_CROPPER.y2; y++) {
          const INDEX = (y * videoFrame.width + x) * 4;
          const R = IMAGE_DATA[INDEX];
          const G = IMAGE_DATA[INDEX + 1];
          const B = IMAGE_DATA[INDEX + 2];

          if (
            this.colorSimilarity(
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
      l1: for (let x = ReplayCutterCropDialog.DEFAULT_CROPPER.x2; x >= 0; x--) {
        for (let y = 0; y < ReplayCutterCropDialog.DEFAULT_CROPPER.y2; y++) {
          const INDEX = (y * videoFrame.width + x) * 4;
          const R = IMAGE_DATA[INDEX];
          const G = IMAGE_DATA[INDEX + 1];
          const B = IMAGE_DATA[INDEX + 2];

          if (
            this.colorSimilarity(
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
      l1: for (let y = 0; y < ReplayCutterCropDialog.DEFAULT_CROPPER.y2; y++) {
        for (let x = 0; x < ReplayCutterCropDialog.DEFAULT_CROPPER.x2; x++) {
          const INDEX = (y * videoFrame.width + x) * 4;
          const R = IMAGE_DATA[INDEX];
          const G = IMAGE_DATA[INDEX + 1];
          const B = IMAGE_DATA[INDEX + 2];

          if (
            this.colorSimilarity(
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
      l1: for (let y = ReplayCutterCropDialog.DEFAULT_CROPPER.y2; y >= 0; y--) {
        for (let x = 0; x < ReplayCutterCropDialog.DEFAULT_CROPPER.x2; x++) {
          const INDEX = (y * videoFrame.width + x) * 4;
          const R = IMAGE_DATA[INDEX];
          const G = IMAGE_DATA[INDEX + 1];
          const B = IMAGE_DATA[INDEX + 2];

          if (
            this.colorSimilarity(
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
    return BACK;
  }

  /**
   * This function allows the user to set the game mini map position.
   * @param gameIndex Index of the game to upload.
   * @param gameFromStatistics Game infos from EBP's API.
   */
  protected cropGameMinimap(
    gameIndex: number,
    gameFromStatistics: RestGame
  ): void {
    const MAP_NAME = this._games[gameIndex].map;

    // Si les positions sont déjà définies pour cette map, les utiliser directement.
    if (this.miniMapPositionsByMap[MAP_NAME]) {
      this.uploadGameMiniMap(
        gameIndex,
        this.miniMapPositionsByMap[MAP_NAME],
        gameFromStatistics
      );
      return;
    }

    if (this._videoPath) {
      this.videoURLToCanvas(
        `http://localhost:${this.globalService.serverPort}/file?path=${this._videoPath}`,
        Math.round((this._games[gameIndex].start + 1) * 1000),
        (videoFrame?: HTMLCanvasElement) => {
          if (videoFrame) {
            const DIALOG_WIDTH: string = 'calc(100vw - 12px * 4)';
            const DIALOG_HEIGHT: string = 'calc(100vh - 12px * 4)';
            this.dialogService
              .open(ReplayCutterCropDialog, {
                data: {
                  imgBase64: videoFrame?.toDataURL('image/png'),
                  initialCropperPosition: this.detectMinimap(videoFrame)
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
                if (miniMapPositions) {
                  const MAP = this.maps.find(
                    (x) => x.name == this.games[gameIndex].map
                  );

                  if (MAP) {
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

                      const MARGED_MINI_MAP_POSITIONS = {
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

                      miniMapPositions = MARGED_MINI_MAP_POSITIONS;
                    }

                    miniMapPositions = {
                      x1: Math.round(miniMapPositions.x1),
                      x2: Math.round(miniMapPositions.x2),
                      y1: Math.round(miniMapPositions.y1),
                      y2: Math.round(miniMapPositions.y2)
                    };

                    this.miniMapPositionsByMap[MAP_NAME] = miniMapPositions;
                    this.uploadGameMiniMap(
                      gameIndex,
                      miniMapPositions,
                      gameFromStatistics
                    );
                  }
                }
              });
          }
        }
      );
    }
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
    callback: Function
  ): void {
    if (this._videoPath) {
      const TEAM_IS_ORANGE = color.r > 255 / 2;
      this.videoURLToCanvas(
        `http://localhost:${this.globalService.serverPort}/file?path=${this._videoPath}`,
        this._games[gameIndex].start * 1000,
        (videoFrame?: HTMLCanvasElement) => {
          if (videoFrame) {
            let step = 0;

            let top = 0;
            let right = 0;
            let bottom = 0;
            let left = 0;

            // We are looking for the bottom and the top.
            const X: number = TEAM_IS_ORANGE ? 125 : 1806;
            for (let y = videoFrame.height; y >= 0; y--) {
              const IS_PRIMARY_COLOR = this.colorSimilarity(
                this.getPixelColor(videoFrame, X, y),
                color
              );

              if (IS_PRIMARY_COLOR && bottom == 0) {
                bottom = Math.floor(y + videoFrame.height * 0.058);
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
            const Y = Math.floor(top + videoFrame.height * 0.005);
            for (let x = 0; x < videoFrame.width / 4; x++) {
              const IS_PRIMARY_COLOR = this.colorSimilarity(
                this.getPixelColor(
                  videoFrame,
                  TEAM_IS_ORANGE ? x : videoFrame.width - x,
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
                    right = videoFrame.width - x;
                  }
                  left = videoFrame.width - x;
                }
              }
            }

            callback({
              x1: left,
              y1: top,
              x2: right,
              y2: bottom
            });
          }
        }
      );
    }
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
      this.videoURLToCanvas(
        `http://localhost:${this.globalService.serverPort}/file?path=${this._videoPath}`,
        this._games[gameIndex].start * 1000,
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
                await this.getTextFromImage(
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
                await this.getTextFromImage(
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
    gameFromStatistics: RestGame
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
          // We get the coordinates of the orange team's information.
          this.globalService.loading = this.translateService.instant(
            'view.replay_cutter.detectingOrangeInfoZone'
          );
          this.getTeamInfosPosition(
            gameIndex,
            new RGB(235, 121, 0),
            (orangeTeamInfosPosition: CropperPosition) => {
              // We get the coordinates of the blue team's information.
              this.globalService.loading = this.translateService.instant(
                'view.replay_cutter.detectingBlueInfoZone'
              );
              this.getTeamInfosPosition(
                gameIndex,
                new RGB(29, 127, 255),
                (blueTeamInfosPosition: CropperPosition) => {
                  this.dialogService
                    .open(ReplayCutterCheckPlayersOrderDialog, {
                      data: {
                        orangePlayersNames: sortedOrangePlayersNames,
                        bluePlayersNames: sortedBluePlayersNames,
                        orangeTeamInfosPosition: orangeTeamInfosPosition,
                        blueTeamInfosPosition: blueTeamInfosPosition,
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
                        orangeTeamInfosPosition: CropperPosition;
                        blueTeamInfosPosition: CropperPosition;
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
                            this._games[gameIndex],
                            miniMapPositions,
                            decodeURIComponent(this._videoPath!),
                            gameFromStatistics.ID,
                            newData.orangeTeamInfosPosition,
                            newData.blueTeamInfosPosition,
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

      this.getGamePlayingBound(URL, GAME, game.start, 1).then((start) => {
        if (start !== null) {
          game.start = start;

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

    return new Promise((resolve) => {
      const ON_SEEKED = () => {
        if (this.detectGamePlaying(VIDEO, [game], true)) {
          resolve(VIDEO.currentTime);
          CLEAN();
        } else if (VIDEO.currentTime < VIDEO.duration) {
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
   * This function is triggered when the user clicks on the "input" to select a replay.
   */
  protected onInputFileClick(training: boolean): void {
    if (!this.inputFileDisabled) {
      this.training = training;
      this.globalService.loading = '';
      this._videoPath = undefined;
      this.inputFileDisabled = true;
      this._games = [];

      window.electronAPI.openVideoFile();
    }
  }

  /**
   * This function initializes the position of a video's playhead when it is loaded.
   * @param event
   */
  protected videoLoadedData(event: Event): void {
    if (event.target) {
      const VIDEO = event.target as HTMLVideoElement;
      VIDEO.currentTime = VIDEO.duration;
    }
  }

  /**
   * This function ensures that the value passed as a parameter (coming from Tesseract) corresponds to a score.
   * @param value Value found by tesseract.
   * @returns Corrected value.
   */
  private scoreChecker(value: string): string {
    let score = parseInt(value.slice(0, 3));
    if (!isNaN(score)) {
      score = Math.max(score, 0);
      score = Math.min(score, 100);
      return score.toString();
    }
    return '0';
  }

  protected async videoTimeUpdate(event: Event): Promise<void> {
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
                  text: translated
                });
              });

            //#region Détéction d'une frame de score d'une game

            if (!found) {
              const MODE = this.detectGameScoreFrame(VIDEO);
              if (MODE >= 0) {
                found = true;
                if (this._games.length == 0 || this._games[0].start != -1) {
                  if (MODE >= 0) {
                    this.justJumped = false;
                    const GAME: Game = new Game(MODE);
                    GAME.end = NOW;
                    //#region Orange team

                    const ORANGE_TEAM_NAME /* string */ =
                      await this.getTextFromImage(
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

                    const ORANGE_TEAM_SCORE /* string */ =
                      await this.getTextFromImage(
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
                        this.scoreChecker
                      );
                    if (ORANGE_TEAM_SCORE) {
                      const INT_VALUE = parseInt(ORANGE_TEAM_SCORE);
                      if (INT_VALUE <= 100) {
                        GAME.orangeTeam.score = INT_VALUE;
                      }
                    }

                    // const ORANGE_PLAYER_1 /* string */ = await getTextFromImage(
                    //   VIDEO,
                    //   document.tesseractWorker,
                    //   PLAYER_NAME_X,
                    //   259,
                    //   PLAYER_NAME_X + PLAYER_NAME_MAX_WIDTH,
                    //   282,
                    //   7
                    // );
                    // if (ORANGE_PLAYER_1) {
                    //   GAME.orangeTeam.players.push(new Player(1, ORANGE_PLAYER_1));
                    // }

                    // const ORANGE_PLAYER_2 /* string */ = await getTextFromImage(
                    //   VIDEO,
                    //   document.tesseractWorker,
                    //   PLAYER_NAME_X,
                    //   312,
                    //   PLAYER_NAME_X + PLAYER_NAME_MAX_WIDTH,
                    //   335,
                    //   7
                    // );
                    // if (ORANGE_PLAYER_2) {
                    //   GAME.orangeTeam.players.push(new Player(2, ORANGE_PLAYER_2));
                    // }

                    // const ORANGE_PLAYER_3 /* string */ = await getTextFromImage(
                    //   VIDEO,
                    //   document.tesseractWorker,
                    //   PLAYER_NAME_X,
                    //   365,
                    //   PLAYER_NAME_X + PLAYER_NAME_MAX_WIDTH,
                    //   388,
                    //   7
                    // );
                    // if (ORANGE_PLAYER_3) {
                    //   GAME.orangeTeam.players.push(new Player(3, ORANGE_PLAYER_3));
                    // }

                    // const ORANGE_PLAYER_4 /* string */ = await getTextFromImage(
                    //   VIDEO,
                    //   document.tesseractWorker,
                    //   PLAYER_NAME_X,
                    //   418,
                    //   PLAYER_NAME_X + PLAYER_NAME_MAX_WIDTH,
                    //   441,
                    //   7
                    // );
                    // if (ORANGE_PLAYER_4) {
                    //   GAME.orangeTeam.players.push(new Player(4, ORANGE_PLAYER_4));
                    // }

                    //#endregion

                    //#region Blue team

                    const BLUE_TEAM_NAME /* string */ =
                      await this.getTextFromImage(
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

                    const BLUE_TEAM_SCORE /* string */ =
                      await this.getTextFromImage(
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
                        this.scoreChecker
                      );
                    console.log(' ----------------- ', GAME.mode);
                    // DEBUG
                    this.debug?.nativeElement.append(this.videoToCanvas(VIDEO));
                    if (BLUE_TEAM_SCORE) {
                      const INT_VALUE = parseInt(BLUE_TEAM_SCORE);
                      if (INT_VALUE <= 100) {
                        GAME.blueTeam.score = INT_VALUE;
                      }
                    }

                    // const BLUE_PLAYER_1 /* string */ = await getTextFromImage(
                    //   VIDEO,
                    //   document.tesseractWorker,
                    //   PLAYER_NAME_X,
                    //   712,
                    //   PLAYER_NAME_X + PLAYER_NAME_MAX_WIDTH,
                    //   735,
                    //   7
                    // );
                    // if (BLUE_PLAYER_1) {
                    //   GAME.blueTeam.players.push(new Player(6, BLUE_PLAYER_1));
                    // }

                    // const BLUE_PLAYER_2 /* string */ = await getTextFromImage(
                    //   VIDEO,
                    //   document.tesseractWorker,
                    //   PLAYER_NAME_X,
                    //   765,
                    //   PLAYER_NAME_X + PLAYER_NAME_MAX_WIDTH,
                    //   788,
                    //   7
                    // );
                    // if (BLUE_PLAYER_2) {
                    //   GAME.blueTeam.players.push(new Player(7, BLUE_PLAYER_2));
                    // }

                    // const BLUE_PLAYER_3 /* string */ = await getTextFromImage(
                    //   VIDEO,
                    //   document.tesseractWorker,
                    //   PLAYER_NAME_X,
                    //   818,
                    //   PLAYER_NAME_X + PLAYER_NAME_MAX_WIDTH,
                    //   841,
                    //   7
                    // );
                    // if (BLUE_PLAYER_3) {
                    //   GAME.blueTeam.players.push(new Player(8, BLUE_PLAYER_3));
                    // }

                    // const BLUE_PLAYER_4 /* string */ = await getTextFromImage(
                    //   VIDEO,
                    //   document.tesseractWorker,
                    //   PLAYER_NAME_X,
                    //   871,
                    //   PLAYER_NAME_X + PLAYER_NAME_MAX_WIDTH,
                    //   894,
                    //   7
                    // );
                    // if (BLUE_PLAYER_4) {
                    //   GAME.blueTeam.players.push(new Player(9, BLUE_PLAYER_4));
                    // }

                    //#endregion

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
                          text: translated
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

            //#region Détéction de la fin d'une game

            if (!found) {
              if (this.detectGameEndFrame(VIDEO)) {
                found = true;

                if (this._games.length == 0 || this._games[0].start != -1) {
                  this.justJumped = false;
                  const GAME: Game = new Game(1);
                  GAME.end = NOW;

                  const ORANGE_TEAM_SCORE /* string */ =
                    await this.getTextFromImage(
                      VIDEO,
                      this.tesseractWorker_number!,
                      636,
                      545,
                      903,
                      648,
                      7
                    );
                  if (ORANGE_TEAM_SCORE) {
                    const INT_VALUE = parseInt(ORANGE_TEAM_SCORE);
                    if (INT_VALUE <= 100) {
                      GAME.orangeTeam.score = INT_VALUE;
                    }
                  }

                  const BLUE_TEAM_SCORE /* string */ =
                    await this.getTextFromImage(
                      VIDEO,
                      this.tesseractWorker_number!,
                      996,
                      545,
                      1257,
                      648,
                      7
                    );
                  if (BLUE_TEAM_SCORE) {
                    const INT_VALUE = parseInt(BLUE_TEAM_SCORE);
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

            //#region Détéction du début d'une game

            if (!found) {
              if (this.detectGameLoadingFrame(VIDEO, this._games)) {
                found = true;
                this.lastDetectedGamePlayingFrame = undefined;
                this._games[0].start =
                  NOW + 2 /* On vire le bout de loader de map. */;
              }
            }

            if (!found) {
              if (this.detectGameIntro(VIDEO, this._games)) {
                found = true;
                this.lastDetectedGamePlayingFrame = undefined;
                this._games[0].start =
                  NOW + 2 /* On vire le bout d'animation de map. */;
                console.log(this._games[0].map);
              }
            }

            //#endregion

            //#region Detecting card name during game.

            if (!found) {
              if (this.detectGamePlaying(VIDEO, this._games)) {
                this.lastDetectedGamePlayingFrame = NOW;
                // On cherche le nom de la carte.
                if (this._games[0].map == '') {
                  const TEXT /* string */ = await this.getTextFromImage(
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
                      const MAP_NAME /* string */ =
                        this.getMapByName(TEXT)?.name ?? '';
                      this._games[0].map = MAP_NAME;
                      console.log('----- ', this._games[0].map);
                    }
                  }
                }

                // We are looking for the name of the orange team.
                if (this._games[0].orangeTeam.name == '') {
                  const TEXT /* string */ = await this.getTextFromImage(
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
                  const TEXT /* string */ = await this.getTextFromImage(
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
                      const TEXT /* string */ = await this.getTextFromImage(
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
                          const MINUTES = parseInt(SPLITTED[0]);
                          const SECONDES = parseInt(SPLITTED[1]);

                          if (!isNaN(MINUTES) && !isNaN(SECONDES)) {
                            if (MINUTES <= 9) {
                              const DIFFERENCE = Math.max(
                                (this.settings.maxTimePerGame - MINUTES) * 60 -
                                  SECONDES -
                                  5
                              );
                              if (!this._games[0].__debug__jumped) {
                                this._games[0].__debug__jumped = true;
                                console.log('Z', TEXT);
                                console.log('A', MINUTES, 'B', SECONDES);
                                console.log('C', NOW, 'D', DIFFERENCE);
                                console.log(
                                  `Jumping to the game's start ! (${MINUTES}:${SECONDES}) (${NOW - DIFFERENCE})`
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
              `${MINUTES.toString().padStart(
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
   * This function returns the RGB color of a video pixel at a given position.
   * @param video HTML DOM of the video from which to extract the pixel.
   * @param x X coordinate of the pixel on the video.
   * @param y  Y coordinate of the pixel on the video.
   * @returns RGB color of the video pixel.
   */
  private getPixelColor(video: CanvasImageSource, x: number, y: number): RGB {
    if (video) {
      const CANVAS = document.createElement('canvas');
      CANVAS.width = 1;
      CANVAS.height = 1;
      const CTX = CANVAS.getContext('2d');
      if (CTX) {
        CTX.drawImage(
          video /* Image */,
          x /* Image X */,
          y /* Image Y */,
          1 /* Image width */,
          1 /* Image height */,
          0 /* Canvas X */,
          0 /* Canvas Y */,
          1 /* Canvas width */,
          1 /* Canvas height */
        );
        const FRAME_DATA = CTX.getImageData(0, 0, 1, 1).data;
        return new RGB(FRAME_DATA[0], FRAME_DATA[1], FRAME_DATA[2]);
      }
    }

    return new RGB(0, 0, 0);
  }

  /**
   * This function allows you to define if two colors are similar.
   * @param color1 Couleur 1.
   * @param color2 Couleur 2.
   * @param maxDifference Tolerance.
   * @returns Are the colors similar?
   */
  public colorSimilarity(
    color1: RGB,
    color2: RGB,
    maxDifference: number = 20
  ): boolean {
    return (
      Math.abs(color1.r - color2.r) <= maxDifference &&
      Math.abs(color1.g - color2.g) <= maxDifference &&
      Math.abs(color1.b - color2.b) <= maxDifference
    );
  }

  /**
   * This function returns the map that resembles what the OCR found.
   * @param search Text found by OCR.
   * @returns Map found.
   */
  protected getMapByName(search: string): Map | undefined {
    const SPLITTED = search
      .replace(/(\r\n|\n|\r)/gm, '')
      .toLowerCase()
      .split(' ');
    const RESULT = this.maps.find((x) =>
      SPLITTED.some((s) => x.dictionnary.includes(s))
    );
    if (RESULT) {
      return RESULT;
    }
    return undefined;
  }

  private detectGameEndFrame(video: HTMLVideoElement): boolean {
    if (
      /* Orange logo */
      this.colorSimilarity(
        this.getPixelColor(video, 387, 417),
        new RGB(251, 209, 0)
      ) &&
      this.colorSimilarity(
        this.getPixelColor(video, 481, 472),
        new RGB(252, 205, 4)
      ) &&
      /* Blue logo */
      this.colorSimilarity(
        this.getPixelColor(video, 1498, 437),
        new RGB(46, 144, 242)
      ) &&
      this.colorSimilarity(
        this.getPixelColor(video, 1630, 486),
        new RGB(46, 136, 226)
      )
    ) {
      console.log('Detect game end frame');
      return true;
    }
    return false;
  }

  /**
   * This function detects the end of a game via the score display.
   * @param video HTML DOM of the video element to be analyzed.
   * @returns Is the current frame a game score frame?
   */
  private detectGameScoreFrame(video: HTMLVideoElement): number {
    for (let i = 0; i < MODES.length; i++) {
      if (
        /* Orange logo */
        this.colorSimilarity(
          this.getPixelColor(
            video,
            MODES[i].scoreFrame.orangeLogo.x,
            MODES[i].scoreFrame.orangeLogo.y
          ),
          new RGB(239, 203, 14)
        ) &&
        /* Blue logo */
        this.colorSimilarity(
          this.getPixelColor(
            video,
            MODES[i].scoreFrame.blueLogo.x,
            MODES[i].scoreFrame.blueLogo.y
          ),
          new RGB(50, 138, 230)
        )
      ) {
        console.log(`Detect game score frame (mode ${i + 1})`);
        return i;
      }
    }
    return -1;
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
    this.getGamesDebugImages(games, () => {
      this.percent = -1;
      console.log(this._games);
      this.videoOldTime = undefined;
      window.electronAPI.removeNotification(true);
      this.globalService.loading = undefined;
    });
  }

  private getGamesDebugImages(
    games: Game[],
    callback: Function,
    index: number = 0
  ): void {
    this.translateService
      .get('view.replay_cutter.correctionImageGeneration')
      .subscribe((translated: string) => {
        this.notificationService.sendMessage({
          percent: (index / games.length) * 100,
          infinite: false,
          icon: undefined,
          text: translated
        });
      });

    this.getGameCroppedFrame(
      (games[index].start + 5) * 1000,
      MODES[games[index].mode].gameFrame.map[0].x,
      MODES[games[index].mode].gameFrame.map[0].y,
      MODES[games[index].mode].gameFrame.map[1].x,
      MODES[games[index].mode].gameFrame.map[1].y
    ).then((image) => {
      games[index].mapImage = image;

      this.videoURLToCanvas(
        `http://localhost:${this.globalService.serverPort}/file?path=${this._videoPath}`,
        (games[index].end - 1) * 1000,
        (videoFrame?: HTMLCanvasElement) => {
          if (videoFrame) {
            games[index].orangeTeam.scoreImage = this.cropImage(
              videoFrame,
              MODES[games[index].mode].scoreFrame.orangeScore[0].x,
              MODES[games[index].mode].scoreFrame.orangeScore[0].y,
              MODES[games[index].mode].scoreFrame.orangeScore[1].x,
              MODES[games[index].mode].scoreFrame.orangeScore[1].y
            )?.toDataURL();

            games[index].orangeTeam.nameImage = this.cropImage(
              videoFrame,
              MODES[games[index].mode].scoreFrame.orangeName[0].x,
              MODES[games[index].mode].scoreFrame.orangeName[0].y,
              MODES[games[index].mode].scoreFrame.orangeName[1].x,
              MODES[games[index].mode].scoreFrame.orangeName[1].y
            )?.toDataURL();

            games[index].blueTeam.scoreImage = this.cropImage(
              videoFrame,
              MODES[games[index].mode].scoreFrame.blueScore[0].x,
              MODES[games[index].mode].scoreFrame.blueScore[0].y,
              MODES[games[index].mode].scoreFrame.blueScore[1].x,
              MODES[games[index].mode].scoreFrame.blueScore[1].y
            )?.toDataURL();

            games[index].blueTeam.nameImage = this.cropImage(
              videoFrame,
              MODES[games[index].mode].scoreFrame.blueName[0].x,
              MODES[games[index].mode].scoreFrame.blueName[0].y,
              MODES[games[index].mode].scoreFrame.blueName[1].x,
              MODES[games[index].mode].scoreFrame.blueName[1].y
            )?.toDataURL();
          }
          if (index < games.length - 1) {
            this.getGamesDebugImages(games, callback, index + 1);
          } else {
            callback();
          }
        }
      );
    });
  }

  /**
   * This function allows the user to mute one of his games.
   * @param game Game to cut.
   */
  protected async save(game: Game): Promise<void> {
    if (this._videoPath === undefined) {
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
      decodeURIComponent(this._videoPath),
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
    if (this._videoPath === undefined) {
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
      decodeURIComponent(this._videoPath),
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
   * This function detects the start of a game via the display of the EVA loader.
   * @param video HTML DOM of the video element to be analyzed.
   * @param games List of games already detected.
   * @returns Is the current frame a game loading frame?
   */
  private detectGameLoadingFrame(
    video: HTMLVideoElement,
    games: Game[]
  ): boolean {
    if (games.length > 0 && games[0].end != -1 && games[0].start == -1) {
      if (
        /* Logo top */ this.colorSimilarity(
          this.getPixelColor(
            video,
            MODES[games[0].mode].loadingFrame.logoTop.x,
            MODES[games[0].mode].loadingFrame.logoTop.y
          ),
          new RGB(255, 255, 255)
        ) &&
        /* Logo left */ this.colorSimilarity(
          this.getPixelColor(
            video,
            MODES[games[0].mode].loadingFrame.logoLeft.x,
            MODES[games[0].mode].loadingFrame.logoLeft.y
          ),
          new RGB(255, 255, 255)
        ) &&
        /* Logo right */ this.colorSimilarity(
          this.getPixelColor(
            video,
            MODES[games[0].mode].loadingFrame.logoRight.x,
            MODES[games[0].mode].loadingFrame.logoRight.y
          ),
          new RGB(255, 255, 255)
        ) &&
        /* Logo middle */ this.colorSimilarity(
          this.getPixelColor(
            video,
            MODES[games[0].mode].loadingFrame.logoMiddle.x,
            MODES[games[0].mode].loadingFrame.logoMiddle.y
          ),
          new RGB(255, 255, 255)
        ) &&
        /* Logo black 1 */ this.colorSimilarity(
          this.getPixelColor(
            video,
            MODES[games[0].mode].loadingFrame.logoBlack1.x,
            MODES[games[0].mode].loadingFrame.logoBlack1.y
          ),
          new RGB(0, 0, 0)
        ) &&
        /* Logo black 2 */ this.colorSimilarity(
          this.getPixelColor(
            video,
            MODES[games[0].mode].loadingFrame.logoBlack2.x,
            MODES[games[0].mode].loadingFrame.logoBlack2.y
          ),
          new RGB(0, 0, 0)
        ) &&
        /* Logo black 3 */ this.colorSimilarity(
          this.getPixelColor(
            video,
            MODES[games[0].mode].loadingFrame.logoBlack3.x,
            MODES[games[0].mode].loadingFrame.logoBlack3.y
          ),
          new RGB(0, 0, 0)
        ) &&
        /* Logo black 4 */ this.colorSimilarity(
          this.getPixelColor(
            video,
            MODES[games[0].mode].loadingFrame.logoBlack4.x,
            MODES[games[0].mode].loadingFrame.logoBlack4.y
          ),
          new RGB(0, 0, 0)
        )
      ) {
        console.log('Detect game loading frame');
        return true;
      }
    }
    return false;
  }

  /**
   * This function detects the start of a game via the introduction of the map.
   * @param video HTML DOM of the video element to be analyzed.
   * @param games List of games already detected.
   * @returns Is the current frame a game intro frame?
   */
  private detectGameIntro(video: HTMLVideoElement, games: Game[]): boolean {
    if (games.length > 0 && games[0].end != -1 && games[0].start == -1) {
      // We are trying to detect the "B" of "BATTLE ARENA" in the lower right corner of the image.
      if (
        //#region B1
        (this.colorSimilarity(
          this.getPixelColor(video, 1495, 942),
          new RGB(255, 255, 255),
          30
        ) &&
          this.colorSimilarity(
            this.getPixelColor(video, 1512, 950),
            new RGB(255, 255, 255),
            30
          ) &&
          this.colorSimilarity(
            this.getPixelColor(video, 1495, 962),
            new RGB(255, 255, 255),
            30
          ) &&
          this.colorSimilarity(
            this.getPixelColor(video, 1512, 972),
            new RGB(255, 255, 255),
            30
          ) &&
          this.colorSimilarity(
            this.getPixelColor(video, 1495, 982),
            new RGB(255, 255, 255),
            30
          ) &&
          this.colorSimilarity(
            this.getPixelColor(video, 1503, 951),
            new RGB(0, 0, 0),
            200
          ) &&
          this.colorSimilarity(
            this.getPixelColor(video, 1503, 972),
            new RGB(0, 0, 0),
            200
          )) ||
        //#endregion
        //#region B2
        (this.colorSimilarity(
          this.getPixelColor(video, 1558, 960),
          new RGB(255, 255, 255),
          30
        ) &&
          this.colorSimilarity(
            this.getPixelColor(video, 1572, 968),
            new RGB(255, 255, 255),
            30
          ) &&
          this.colorSimilarity(
            this.getPixelColor(video, 1558, 977),
            new RGB(255, 255, 255),
            30
          ) &&
          this.colorSimilarity(
            this.getPixelColor(video, 1572, 987),
            new RGB(255, 255, 255),
            30
          ) &&
          this.colorSimilarity(
            this.getPixelColor(video, 1558, 995),
            new RGB(255, 255, 255),
            30
          ) &&
          this.colorSimilarity(
            this.getPixelColor(video, 1564, 969),
            new RGB(0, 0, 0),
            200
          ) &&
          this.colorSimilarity(
            this.getPixelColor(video, 1564, 986),
            new RGB(0, 0, 0),
            200
          )) ||
        //#endregion
        //#region B3
        (this.colorSimilarity(
          this.getPixelColor(video, 1556, 957),
          new RGB(255, 255, 255),
          30
        ) &&
          this.colorSimilarity(
            this.getPixelColor(video, 1571, 964),
            new RGB(255, 255, 255),
            30
          ) &&
          this.colorSimilarity(
            this.getPixelColor(video, 1556, 975),
            new RGB(255, 255, 255),
            30
          ) &&
          this.colorSimilarity(
            this.getPixelColor(video, 1571, 984),
            new RGB(255, 255, 255),
            30
          ) &&
          this.colorSimilarity(
            this.getPixelColor(video, 1556, 993),
            new RGB(255, 255, 255),
            30
          ) &&
          this.colorSimilarity(
            this.getPixelColor(video, 1564, 966),
            new RGB(0, 0, 0),
            200
          ) &&
          this.colorSimilarity(
            this.getPixelColor(video, 1564, 984),
            new RGB(0, 0, 0),
            200
          )) ||
        //#endregion
        //#region B4
        (this.colorSimilarity(
          this.getPixelColor(video, 1617, 979),
          new RGB(255, 255, 255),
          30
        ) &&
          this.colorSimilarity(
            this.getPixelColor(video, 1630, 985),
            new RGB(255, 255, 255),
            30
          ) &&
          this.colorSimilarity(
            this.getPixelColor(video, 1617, 995),
            new RGB(255, 255, 255),
            30
          ) &&
          this.colorSimilarity(
            this.getPixelColor(video, 1630, 1004),
            new RGB(255, 255, 255),
            30
          ) &&
          this.colorSimilarity(
            this.getPixelColor(video, 1617, 1011),
            new RGB(255, 255, 255),
            30
          ) &&
          this.colorSimilarity(
            this.getPixelColor(video, 1623, 987),
            new RGB(0, 0, 0),
            200
          ) &&
          this.colorSimilarity(
            this.getPixelColor(video, 1623, 1004),
            new RGB(0, 0, 0),
            200
          )) ||
        //#endregion
        //#region B5
        (this.colorSimilarity(
          this.getPixelColor(video, 1606, 976),
          new RGB(255, 255, 255),
          30
        ) &&
          this.colorSimilarity(
            this.getPixelColor(video, 1619, 982),
            new RGB(255, 255, 255),
            30
          ) &&
          this.colorSimilarity(
            this.getPixelColor(video, 1606, 991),
            new RGB(255, 255, 255),
            30
          ) &&
          this.colorSimilarity(
            this.getPixelColor(video, 1619, 1000),
            new RGB(255, 255, 255),
            30
          ) &&
          this.colorSimilarity(
            this.getPixelColor(video, 1606, 1008),
            new RGB(255, 255, 255),
            30
          ) &&
          this.colorSimilarity(
            this.getPixelColor(video, 1612, 983),
            new RGB(0, 0, 0),
            200
          ) &&
          this.colorSimilarity(
            this.getPixelColor(video, 1612, 1000),
            new RGB(0, 0, 0),
            200
          ))
        //#endregion
      ) {
        console.log('Detect game intro frame');
        return true;
      }
    }
    return false;
  }

  /**
   * Gets the actual dimensions (width and height) of a canvas image source.
   * Handles different types of image sources (HTMLVideoElement, HTMLImageElement, HTMLCanvasElement, OffscreenCanvas).
   * @param src The canvas image source to get dimensions from.
   * @returns An object containing the width and height of the source.
   * @throws Error if the source type is not supported.
   */
  private getSourceSize(src: CanvasImageSource): {
    width: number;
    height: number;
  } {
    if (src instanceof HTMLVideoElement)
      return {
        width: src.videoWidth,
        height: src.videoHeight
      };
    if (src instanceof HTMLImageElement)
      return {
        width: src.width,
        height: src.height
      };
    if (src instanceof HTMLCanvasElement)
      return {
        width: src.width,
        height: src.height
      };
    if (src instanceof OffscreenCanvas)
      return {
        width: src.width,
        height: src.height
      };
    throw new Error('Type non géré');
  }

  /**
   * Converts a canvas image source to an HTMLCanvasElement by drawing it onto a new canvas.
   * The resulting canvas will have the same dimensions as the source.
   * @param source The image source to convert (video, image, or canvas).
   * @returns A new HTMLCanvasElement containing the rendered source.
   */
  public videoToCanvas(source: CanvasImageSource): HTMLCanvasElement {
    const CANVAS = document.createElement('canvas');
    const SIZE = this.getSourceSize(source);
    CANVAS.width = SIZE.width;
    CANVAS.height = SIZE.height;
    const CTX = CANVAS.getContext('2d');
    if (CTX) {
      CTX.drawImage(source, 0, 0, CANVAS.width, CANVAS.height);
    }
    return CANVAS;
  }

  public videoURLToCanvas(
    url: string,
    timeMs: number,
    callback: (video?: HTMLCanvasElement) => void
  ): void {
    const VIDEO = document.createElement('video');
    VIDEO.src = url;
    VIDEO.crossOrigin = 'anonymous';
    VIDEO.muted = true;
    VIDEO.preload = 'auto';

    VIDEO.addEventListener('loadedmetadata', () => {
      const TIME_SECONDS = timeMs / 1000;
      if (TIME_SECONDS > VIDEO.duration) {
        callback(undefined);
        return;
      }
      VIDEO.currentTime = TIME_SECONDS;
    });

    VIDEO.addEventListener('seeked', () => {
      callback(this.videoToCanvas(VIDEO));
    });

    VIDEO.addEventListener('error', () => {
      callback(undefined);
    });
  }

  /**
   * This function detects a playing game frame.
   * @param video HTML DOM of the video element to be analyzed.
   * @param games List of games already detected.
   * @param force Disable the first if.
   * @returns Is the current frame a playing game frame?
   */
  public detectGamePlaying(
    video: HTMLVideoElement,
    games: Game[],
    force: boolean = false
  ): boolean {
    if ((games.length > 0 && games[0].start == -1) || force) {
      // Trying to detect the color of all players' life bars.
      const J1_PIXEL = this.getPixelColor(
        video,
        MODES[games[0].mode].gameFrame.playersX[0],
        (MODES[games[0].mode].gameFrame.playersY[0][0] +
          MODES[games[0].mode].gameFrame.playersY[0][1]) /
          2
      );
      const J2_PIXEL = this.getPixelColor(
        video,
        MODES[games[0].mode].gameFrame.playersX[0],
        (MODES[games[0].mode].gameFrame.playersY[1][0] +
          MODES[games[0].mode].gameFrame.playersY[1][1]) /
          2
      );
      const J3_PIXEL = this.getPixelColor(
        video,
        MODES[games[0].mode].gameFrame.playersX[0],
        (MODES[games[0].mode].gameFrame.playersY[2][0] +
          MODES[games[0].mode].gameFrame.playersY[2][1]) /
          2
      );
      const J4_PIXEL = this.getPixelColor(
        video,
        MODES[games[0].mode].gameFrame.playersX[0],
        (MODES[games[0].mode].gameFrame.playersY[3][0] +
          MODES[games[0].mode].gameFrame.playersY[3][1]) /
          2
      );
      const J5_PIXEL = this.getPixelColor(
        video,
        MODES[games[0].mode].gameFrame.playersX[1],
        (MODES[games[0].mode].gameFrame.playersY[0][0] +
          MODES[games[0].mode].gameFrame.playersY[0][1]) /
          2
      );
      const J6_PIXEL = this.getPixelColor(
        video,
        MODES[games[0].mode].gameFrame.playersX[1],
        (MODES[games[0].mode].gameFrame.playersY[1][0] +
          MODES[games[0].mode].gameFrame.playersY[1][1]) /
          2
      );
      const J7_PIXEL = this.getPixelColor(
        video,
        MODES[games[0].mode].gameFrame.playersX[1],
        (MODES[games[0].mode].gameFrame.playersY[2][0] +
          MODES[games[0].mode].gameFrame.playersY[2][1]) /
          2
      );
      const J8_PIXEL = this.getPixelColor(
        video,
        MODES[games[0].mode].gameFrame.playersX[1],
        (MODES[games[0].mode].gameFrame.playersY[3][0] +
          MODES[games[0].mode].gameFrame.playersY[3][1]) /
          2
      );

      const ORANGE = new RGB(231, 123, 9);
      const BLUE = new RGB(30, 126, 242);
      const BLACK = new RGB(0, 0, 0);

      // S'il y a au moins un joueur en vie
      if (
        (this.colorSimilarity(J1_PIXEL, ORANGE) ||
          this.colorSimilarity(J2_PIXEL, ORANGE) ||
          this.colorSimilarity(J3_PIXEL, ORANGE) ||
          this.colorSimilarity(J4_PIXEL, ORANGE)) &&
        (this.colorSimilarity(J5_PIXEL, BLUE) ||
          this.colorSimilarity(J6_PIXEL, BLUE) ||
          this.colorSimilarity(J7_PIXEL, BLUE) ||
          this.colorSimilarity(J8_PIXEL, BLUE))
      ) {
        if (
          //#region Orange team
          // Player 1
          (this.colorSimilarity(J1_PIXEL, ORANGE) ||
            this.colorSimilarity(J1_PIXEL, BLACK, 50)) &&
          // Player 2
          (this.colorSimilarity(J2_PIXEL, ORANGE) ||
            this.colorSimilarity(J2_PIXEL, BLACK, 50)) &&
          // Player 3
          (this.colorSimilarity(J3_PIXEL, ORANGE) ||
            this.colorSimilarity(J3_PIXEL, BLACK, 50)) &&
          //Joueur 4
          (this.colorSimilarity(J4_PIXEL, ORANGE) ||
            this.colorSimilarity(J4_PIXEL, BLACK, 50)) &&
          //#endregion
          //#region Blue team
          //Joueur 1
          (this.colorSimilarity(J5_PIXEL, BLUE) ||
            this.colorSimilarity(J5_PIXEL, BLACK, 50)) &&
          // Player 2
          (this.colorSimilarity(J6_PIXEL, BLUE) ||
            this.colorSimilarity(J6_PIXEL, BLACK, 50)) &&
          // Player 3
          (this.colorSimilarity(J7_PIXEL, BLUE) ||
            this.colorSimilarity(J7_PIXEL, BLACK, 50)) &&
          // Player 4
          (this.colorSimilarity(J8_PIXEL, BLUE) ||
            this.colorSimilarity(J8_PIXEL, BLACK, 50))
          //#endregion
        ) {
          console.log('Detect game playing frame');
          return true;
        }
      }
      return false;
    }
    return false;
  }

  /**
   * This function returns the most common value in a list.
   * @param arr List of where to find the most present value.
   * @returns Most present value in the list.
   */
  private arrayMostFrequent(arr: string[]): string | null {
    if (arr.length === 0) return null;

    const FREQUENCY: Record<string, number> = {};

    // Counting occurrences
    for (const VALUE of arr) {
      FREQUENCY[VALUE] = (FREQUENCY[VALUE] || 0) + 1;
    }

    let maxCount = 0;
    let mostCommon: string = arr[0];

    // Route in table order to respect "first in case of a tie".
    for (const VALUE of arr) {
      if (FREQUENCY[VALUE] > maxCount) {
        maxCount = FREQUENCY[VALUE];
        mostCommon = VALUE;
      }
    }

    return mostCommon;
  }

  /**
   * This function returns a black and white canvas from a canvas ctx passed as a parameter.
   * @param ctx Canvas ctx to copy.
   * @param luminance Boundary luminance between white and black.
   * @returns Transformed canvas.
   */
  private setCanvasBlackAndWhite(
    ctx: CanvasRenderingContext2D,
    luminance: number
  ): HTMLCanvasElement {
    const CANVAS = document.createElement('canvas');
    CANVAS.width = ctx.canvas.width;
    CANVAS.height = ctx.canvas.height;
    const CTX = CANVAS.getContext('2d');
    if (CTX) {
      // Après drawImage(...)
      const IMAGE_DATA = ctx.getImageData(
        0,
        0,
        ctx.canvas.width,
        ctx.canvas.height
      );
      const DATA = IMAGE_DATA.data;

      for (let i = 0; i < DATA.length; i += 4) {
        const RED = DATA[i];
        const GREEN = DATA[i + 1];
        const BLUE = DATA[i + 2];

        // Luminance simple
        const PIXEL_LUMINANCE = 0.299 * RED + 0.587 * GREEN + 0.114 * BLUE;

        // Seuil à ajuster (200 = clair, donc blanc ; le reste devient noir)
        const VALUE = PIXEL_LUMINANCE > luminance ? 255 : 0;

        DATA[i] = VALUE; // R
        DATA[i + 1] = VALUE; // G
        DATA[i + 2] = VALUE; // B
      }

      CTX.putImageData(IMAGE_DATA, 0, 0);
    }
    return CANVAS;
  }

  /**
   * Crops a rectangular region from a given image or canvas and returns it as a new canvas.
   * @param source The source image or canvas to crop from.
   * @param x1 The starting X coordinate of the crop area.
   * @param y1 The starting Y coordinate of the crop area.
   * @param x2 The ending X coordinate of the crop area.
   * @param y2 The ending Y coordinate of the crop area.
   * @returns A new canvas containing the cropped image, or undefined if the context could not be created.
   */
  private cropImage(
    source: CanvasImageSource,
    x1: number,
    y1: number,
    x2: number,
    y2: number
  ): HTMLCanvasElement | undefined {
    const CANVAS: HTMLCanvasElement = document.createElement('canvas');
    const WIDTH: number = x2 - x1;
    const HEIGHT: number = y2 - y1;

    CANVAS.width = WIDTH;
    CANVAS.height = HEIGHT;

    const CTX = CANVAS.getContext('2d');
    if (CTX) {
      CTX.drawImage(
        source /* Image */,
        x1 /* Image X */,
        y1 /* Image Y */,
        WIDTH /* Image width */,
        HEIGHT /* Image height */,
        0 /* Canvas X */,
        0 /* Canvas Y */,
        WIDTH /* Canvas width */,
        HEIGHT /* Canvas height */
      );

      return CANVAS;
    }

    return undefined;
  }

  /**
   * This function attempts to find text present in a canvas at specific coordinates.
   * @param source HTML DOM of the video element to be analyzed.
   * @param tesseractWorker Tesseract instance.
   * @param x1 X position of the top left corner of the rectangle to be analyzed.
   * @param y1 Y position of the top left corner of the rectangle to be analyzed.
   * @param x2 X position of the bottom right corner of the rectangle to be analyzed.
   * @param y2 Y position of the bottom right corner of the rectangle to be analyzed.
   * @param tesseditPagesegMode Page segmentation mode (how Tesseract divides the text to be recognized).
   * @param luminance // If the translation is not always reliable, the image will be analyzed once more, in black and white, split by the luminance passed as a parameter.
   * @param filter // ???
   * @param disableInitialScan // ???
   * @param checker // Function to verify the value found by Tesseract.
   * @returns Text found by OCR.
   */
  private async getTextFromImage(
    source: CanvasImageSource,
    tesseractWorker: Tesseract.Worker,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    tesseditPagesegMode: number = 3,
    luminance?: number,
    filter: boolean = false,
    disableInitialScan: boolean = false,
    checker?: Function
  ): Promise<string> {
    const CANVAS = this.cropImage(source, x1, y1, x2, y2);
    if (CANVAS) {
      const CTX = CANVAS.getContext('2d');
      if (CTX) {
        const IMG = CANVAS.toDataURL('image/png');
        // DEBUG
        this.debug?.nativeElement.append(CANVAS);

        // On scan sans transformations.
        await tesseractWorker.setParameters({
          tessedit_pageseg_mode: tesseditPagesegMode.toString() as PSM
        });
        const TESSERACT_VALUES: string[] = [];

        if (!disableInitialScan) {
          TESSERACT_VALUES.push(
            (await tesseractWorker.recognize(IMG)).data.text.replace(
              /\r?\n|\r/,
              ''
            )
          );
        }

        // On scan avec luminence s'il est activé.
        if (luminance) {
          const CORRECTED_CANVAS = this.setCanvasBlackAndWhite(CTX, luminance);
          // DEBUG
          this.debug?.nativeElement.append(CORRECTED_CANVAS);
          const IMG_STRING = CORRECTED_CANVAS.toDataURL('image/png');
          TESSERACT_VALUES.push(
            (await tesseractWorker.recognize(IMG_STRING)).data.text.replace(
              /\r?\n|\r/,
              ''
            )
          );
        }

        // On scan avec filtre s'il est activé.
        if (filter) {
          const FILTER1_CANVAS = document.createElement('canvas');
          FILTER1_CANVAS.width = CANVAS.width;
          FILTER1_CANVAS.height = CANVAS.height;
          const FILTER1_CTX = FILTER1_CANVAS.getContext('2d');
          if (FILTER1_CTX) {
            FILTER1_CTX.filter = 'invert(1) contrast(200%) brightness(150%)';
            FILTER1_CTX.drawImage(
              CANVAS /* Image */,
              0 /* Image X */,
              0 /* Image Y */,
              CANVAS.width /* Image width */,
              CANVAS.height /* Image height */
            );

            // DEBUG
            this.debug?.nativeElement.append(FILTER1_CANVAS);

            const IMG_STRING = FILTER1_CANVAS.toDataURL('image/png');
            TESSERACT_VALUES.push(
              (await tesseractWorker.recognize(IMG_STRING)).data.text.replace(
                /\r?\n|\r/,
                ''
              )
            );
          }

          const FILTER2_CANVAS = document.createElement('canvas');
          FILTER2_CANVAS.width = CANVAS.width;
          FILTER2_CANVAS.height = CANVAS.height;
          const FILTER2_CTX = FILTER2_CANVAS.getContext('2d');
          if (FILTER2_CTX) {
            FILTER2_CTX.filter = 'grayscale(1) contrast(300%) brightness(150%)';
            FILTER2_CTX.drawImage(
              CANVAS /* Image */,
              0 /* Image X */,
              0 /* Image Y */,
              CANVAS.width /* Image width */,
              CANVAS.height /* Image height */
            );

            // DEBUG
            this.debug?.nativeElement.append(FILTER2_CANVAS);

            const IMG_STRING = FILTER2_CANVAS.toDataURL('image/png');
            TESSERACT_VALUES.push(
              (await tesseractWorker.recognize(IMG_STRING)).data.text.replace(
                /\r?\n|\r/,
                ''
              )
            );
          }

          const FILTER3_CANVAS = document.createElement('canvas');
          FILTER3_CANVAS.width = CANVAS.width;
          FILTER3_CANVAS.height = CANVAS.height;
          const FILTER3_CTX = FILTER3_CANVAS.getContext('2d');
          if (FILTER3_CTX) {
            CTX.filter = 'grayscale(1) contrast(100) brightness(1) invert(1)';
            FILTER3_CTX.drawImage(
              CANVAS /* Image */,
              0 /* Image X */,
              0 /* Image Y */,
              CANVAS.width /* Image width */,
              CANVAS.height /* Image height */
            );

            // DEBUG
            this.debug?.nativeElement.append(FILTER3_CANVAS);

            const IMG_STRING = FILTER3_CANVAS.toDataURL('image/png');
            TESSERACT_VALUES.push(
              (await tesseractWorker.recognize(IMG_STRING)).data.text.replace(
                /\r?\n|\r/,
                ''
              )
            );
          }
        }

        if (checker) {
          for (let i = 0; i < TESSERACT_VALUES.length; i++) {
            TESSERACT_VALUES[i] = checker(TESSERACT_VALUES[i]);
          }
        }

        const RESULT = this.arrayMostFrequent(
          TESSERACT_VALUES.filter((x) => x != '')
        );

        return RESULT ?? '';
      }
    }
    return Promise.resolve('');
  }

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

  protected async getGameCroppedFrame(
    gameTimeMs: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number
  ): Promise<string | undefined> {
    return new Promise((resolve) => {
      this.videoURLToCanvas(
        `http://localhost:${this.globalService.serverPort}/file?path=${this._videoPath}`,
        gameTimeMs,
        (videoFrame?: HTMLCanvasElement) => {
          if (videoFrame) {
            resolve(this.cropImage(videoFrame, x1, y1, x2, y2)?.toDataURL());
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

  //#endregion
}
