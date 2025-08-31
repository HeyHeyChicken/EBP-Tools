// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { VideoPlatform } from './video-platform.enum';
import { Versions } from './versions';
import { JWT } from './jwt';
import { CropperPosition } from 'ngx-image-cropper';
import { Game } from '../app/views/replay_cutter/models/game';

//#endregion

export interface ElectronAPI {
  //#region Client to Server

  setWindowSize: (width?: number, height?: number) => Promise<void>;
  cutVideoFile: (game: Game, videoPath: string) => Promise<string>;
  cutVideoFiles: (games: Game[], videoPath: string) => Promise<string>;
  debugMode: () => Promise<void>;
  downloadReplay: (url: string, platform: VideoPlatform) => Promise<void>;
  extractPublicPseudoGames: (
    tag: string,
    nbPages: number,
    seasonIndex: number,
    skip: number,
    timeToWait: number
  ) => Promise<void>;
  extractPrivatePseudoGames: (
    nbPages: number,
    seasonIndex: number,
    skip: number,
    timeToWait: number
  ) => Promise<void>;
  getExpressPort: () => Promise<number>;
  getJWTAccessToken: () => Promise<string>;
  getGameHistoryOutputPath: () => Promise<string>;
  getOS: () => Promise<NodeJS.Platform>;
  getPublicPseudoGamesOutputPath: () => Promise<string>;
  getPrivatePseudoGamesOutputPath: () => Promise<string>;
  getReplayCutterOutputPath: () => Promise<string>;
  getReplayDownloaderOutputPath: () => Promise<string>;
  getVersion: () => Promise<Versions>;
  getVideoCutterOutputPath: () => Promise<string>;
  isDevMode: () => Promise<boolean>;
  logout: () => Promise<void>;
  openFile: (pathFile: string) => Promise<void>;
  openVideoFile: (videoPath?: string) => void;
  openURL: (url: string) => void;
  setSetting: (setting: string) => Promise<string>;
  setVideoFile: (callback: (path: string) => void) => Promise<void>;
  uploadGameMiniMap: (
    game: Game,
    c: CropperPosition,
    videoPath: string,
    gameID: number
  ) => void;

  //#endregion

  //#region Server to Client

  replayCutterUpscale: (callback: (filePath: string) => void) => void;
  gameIsUploaded: (callback: () => void) => void;
  gamesAreExported: (callback: (filePath: string | undefined) => void) => void;
  replayDownloaderError: (callback: (error: string) => void) => void;
  replayDownloaderSuccess: (callback: (path: string) => void) => void;
  replayDownloaderPercent: (callback: (percent: number) => void) => void;
  error: (callback: (i18nPath: string, i18nVariables: object) => void) => void;
  globalMessage: (
    callback: (i18nPath: string, i18nVariables: object) => void
  ) => void;

  //#endregion
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
