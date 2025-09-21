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
import { MessageComponent } from '../../shared/message/message.component';
import Tesseract, { createWorker, PSM } from 'tesseract.js';
import { ToastrService } from 'ngx-toastr';
import { Map } from './models/map';
import { Game } from './models/game';
import { RGB } from './models/rgb';
import { GlobalService } from '../../core/services/global.service';
import { MatInputModule } from '@angular/material/input';
import { OpenCVService } from '../../core/services/open-cv.service';
import { ImageDetectionResult } from '../../../models/image-detection-result';
import { MatDialog } from '@angular/material/dialog';
import { ReplayCutterCropDialog } from './dialog/crop/crop.dialog';
import { CropperPosition } from 'ngx-image-cropper';
import { APIRestService } from '../../core/services/api-rest.service';
import { RestGame } from './models/rest-game';
import { IdentityService } from '../../core/services/identity.service';
import { ReplayCutterSettingsDialog } from './dialog/settings/settings.dialog';
import { Settings } from './models/settings';
import { ReplayCutterUpscaleConfirmationDialog } from './dialog/upscale-confirmation/upscale-confirmation.dialog';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { FormsModule } from '@angular/forms';
import { MODES } from './models/mode';
import { EditTeamScoreDialog } from './dialog/edit-score/edit-score.dialog';
import { ReplayCutterAttachGameDialog } from './dialog/attach-game/attach-game.dialog';
import { EditTeamNameDialog } from './dialog/edit-team/edit-team.dialog';
import { distance } from 'fastest-levenshtein';
import { CheckPlayersOrderDialog } from './dialog/check-players-order/check-players-order.dialog';
import { ReplayUploadedDialog } from './dialog/replay-uploaded/replay-uploaded.dialog';

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
    MessageComponent,
    MatInputModule,
    MatCheckboxModule,
    FormsModule
  ]
})
export class ReplayCutterComponent implements OnInit {
  //#region Attributes

  @ViewChild('debug') debug?: ElementRef<HTMLDivElement>;
  protected debugMode: boolean = false;
  protected debugPause: boolean = false;
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

  private start: number = 0;

  private tesseractWorker_basic: Tesseract.Worker | undefined;
  private tesseractWorker_number: Tesseract.Worker | undefined;
  private tesseractWorker_letter: Tesseract.Worker | undefined;
  private tesseractWorker_time: Tesseract.Worker | undefined;

  private miniMapPositionsByMap: { [mapName: string]: CropperPosition } = {};

  //#endregion

  constructor(
    protected readonly identityService: IdentityService,
    protected readonly globalService: GlobalService,
    private readonly toastrService: ToastrService,
    private readonly ngZone: NgZone,
    private readonly translateService: TranslateService,
    private readonly openCVService: OpenCVService,
    private readonly dialogService: MatDialog,
    private readonly apiRestService: APIRestService
  ) {}

  //#region Functions

  ngOnInit(): void {
    this._videoPath = undefined;
    this.initServices();

    window.electronAPI.gameIsUploaded(() => {
      this.ngZone.run(() => {
        this.globalService.loading = undefined;
        this.dialogService.open(ReplayUploadedDialog);
      });
    });

    // The server gives the path of the video file selected by the user.
    window.electronAPI.setVideoFile((path: string) => {
      this.ngZone.run(() => {
        if (path) {
          this._videoPath = encodeURIComponent(path);
          this.percent = 0;
        }
        this.miniMapPositionsByMap = {};
        this.globalService.loading = undefined;
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
          } else {
            this.globalService.loading = undefined;
            this.inputFileDisabled = false;
          }
        });
    });
  }

  protected get disableUploadButton(): boolean {
    return (
      this.identityService.supporterLevel == 0 ||
      !this.identityService.isBetaUser ||
      !this._videoPath
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
    if (!this.disableUploadButton) {
      this.apiRestService.getGames(
        this._games[gameIndex].map,
        this._games[gameIndex].orangeTeam.score,
        this._games[gameIndex].blueTeam.score,
        (games: RestGame[]) => {
          if (games.length > 0) {
            if (games.length == 1) {
              this.cropGameMinimap(gameIndex, games[0]);
            } else {
              this.dialogService
                .open(ReplayCutterAttachGameDialog, {
                  data: {
                    games: games
                  },
                  autoFocus: false
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
          } else {
            this.translateService
              .get('view.replay_cutter.toast.noGamesFoundInStatistics', {
                map: this._games[gameIndex].map,
                orangeScore: this._games[gameIndex].orangeTeam.score,
                blueScore: this._games[gameIndex].blueTeam.score
              })
              .subscribe((translated: string) => {
                this.toastrService.error(translated).onTap.subscribe(() => {
                  window.electronAPI.openURL(
                    this.globalService.discordServerURL
                  );
                });
              });
          }
        }
      );
    }
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
        Math.round((this._games[gameIndex].start + 10) * 1000),
        (videoFrame?: HTMLCanvasElement) => {
          if (videoFrame) {
            const DIALOG_WIDTH: string = 'calc(100vw - 12px * 4)';
            const DIALOG_HEIGHT: string = 'calc(100vh - 12px * 4)';
            this.dialogService
              .open(ReplayCutterCropDialog, {
                data: {
                  imgBase64: videoFrame?.toDataURL('image/png')
                },
                maxWidth: DIALOG_WIDTH,
                maxHeight: DIALOG_HEIGHT,
                width: DIALOG_WIDTH,
                height: DIALOG_HEIGHT,
                autoFocus: false
              })
              .afterClosed()
              .subscribe((miniMapPositions: CropperPosition) => {
                window.electronAPI.setWindowSize();
                if (miniMapPositions) {
                  this.miniMapPositionsByMap[MAP_NAME] = miniMapPositions;
                  this.uploadGameMiniMap(
                    gameIndex,
                    miniMapPositions,
                    gameFromStatistics
                  );
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
                    .open(CheckPlayersOrderDialog, {
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
   * This function is triggered when the user clicks on the "input" to select a replay.
   */
  protected onInputFileClick(): void {
    if (!this.inputFileDisabled) {
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

            //#region Détéction d'une frame de score d'une game

            if (!found) {
              const MODE = this.detectGameScoreFrame(VIDEO);
              if (MODE >= 0) {
                found = true;
                if (this._games.length == 0 || this._games[0].start != -1) {
                  if (MODE >= 0) {
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
                    this.debug?.nativeElement.append(
                      this.videoToCanvas(VIDEO)!
                    );
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
                      const MAP_NAME /* string */ = this.getMapByName(TEXT);
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
                        const DIFFERENCE =
                          (this.settings.maxTimePerGame - MINUTES) * 60 -
                          SECONDES;
                        if (MINUTES <= 9) {
                          if (!this._games[0].__debug__jumped) {
                            this._games[0].__debug__jumped = true;
                            console.log(
                              `Jumping to the game's start ! (${MINUTES}:${SECONDES}) (${NOW - DIFFERENCE})`
                            );
                            this.lastDetectedGamePlayingFrame =
                              NOW - DIFFERENCE;
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
                }
              }
            }

            //#endregion

            this.setVideoCurrentTime(VIDEO, NOW - DEFAULT_STEP, this._games);
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

  private detectImage(
    sourceMat: cv.Mat,
    templateMat: cv.Mat
  ): ImageDetectionResult {
    const _cv: typeof cv = this.openCVService.cv!;

    const result = new _cv.Mat();
    const mask = new _cv.Mat();

    // Match du template
    _cv.matchTemplate(
      sourceMat,
      templateMat,
      result,
      cv.TM_CCOEFF_NORMED,
      mask
    );

    // Recherche de la meilleure correspondance
    const minMax = _cv.minMaxLoc(result, mask);
    const maxPoint = minMax.maxLoc;
    const maxVal = minMax.maxVal;

    // Position (point haut gauche)
    const position = { x: maxPoint.x, y: maxPoint.y };

    // Taille = taille du template
    const size = { width: templateMat.cols, height: templateMat.rows };

    // Nettoyage
    result.delete();
    mask.delete();

    return { position, size, confidence: maxVal };
  }

  private urlToCanvas(
    url: string,
    callback: (canvas: HTMLCanvasElement) => void
  ): void {
    const CANVAS = document.createElement('canvas');
    const IMAGE = new Image();
    IMAGE.src = url;
    IMAGE.onload = () => {
      CANVAS.width = IMAGE.width;
      CANVAS.height = IMAGE.height;
      const CTX = CANVAS.getContext('2d');
      if (CTX) {
        CTX.drawImage(IMAGE, 0, 0);
        callback(CANVAS);
      }
    };
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
  private colorSimilarity(
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
   * @returns Name of the map found.
   */
  private getMapByName(search: string): string {
    const MAPS: Map[] = [
      new Map('Artefact', ['artefact']),
      new Map('Atlantis', ['atlantis']),
      new Map('Ceres', ['ceres']),
      new Map('Engine', ['engine']),
      new Map('Helios Station', ['helios', 'station']),
      new Map('Lunar Outpost', ['lunar', 'outpost']),
      new Map('Outlaw', ['outlaw', 'qutlaw']),
      new Map('Polaris', ['polaris']),
      new Map('Silva', ['silva']),
      new Map('The Cliff', ['cliff']),
      new Map('The Rock', ['rock']),
      new Map('Horizon', ['horizon'])
    ];
    const SPLITTED = search
      .replace(/(\r\n|\n|\r)/gm, '')
      .toLowerCase()
      .split(' ');
    const RESULT = MAPS.find((x) =>
      SPLITTED.some((s) => x.dictionnary.includes(s))
    );
    if (RESULT) {
      return RESULT.name;
    }
    return '';
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
        video.currentTime = time;
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
    this.percent = -1;
    if (games.length == 0) {
      this.translateService
        .get('view.replay_cutter.toast.noGamesFoundInVideo')
        .subscribe((translated: string) => {
          this.toastrService.error(translated).onTap.subscribe(() => {
            window.electronAPI.openURL(this.globalService.discordServerURL);
          });
        });
    }
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
  private videoToCanvas(source: CanvasImageSource): HTMLCanvasElement {
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
  private detectGamePlaying(
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
    if (source) {
      const CANVAS = document.createElement('canvas');
      const WIDTH /* number */ = x2 - x1;
      const HEIGHT /* number */ = y2 - y1;
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

        console.log(TESSERACT_VALUES);
        const RESULT = this.arrayMostFrequent(
          TESSERACT_VALUES.filter((x) => x != '')
        );

        return RESULT ?? '';
      }
    }
    return Promise.resolve('');
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
      .open(EditTeamScoreDialog, {
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
   * Opens a dialog to edit the name of a specific team for a given game.
   * @param game The game object to modify.
   * @param team The team whose name should be edited ('orange' or 'blue').
   */
  protected editTeamName(game: Game, team: 'orange' | 'blue'): void {
    const CURRENT_NAME =
      team === 'orange' ? game.orangeTeam.name : game.blueTeam.name;

    this.dialogService
      .open(EditTeamNameDialog, {
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
