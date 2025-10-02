// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

const { contextBridge, ipcRenderer } = require('electron');

// prettier-ignore
contextBridge.exposeInMainWorld("electronAPI", {
  //#region Client -> Server

  // The front-end asks the server to resize the main frame;
  setWindowSize: (width, height) => ipcRenderer.invoke("set-window-size", width, height),
  // The front-end asks the server to return the developer mode state.
  isDevMode: () => ipcRenderer.invoke("is-dev-mode"),
  // The front-end asks the server to return the user's operating system.
  getOS: () => ipcRenderer.invoke("get-os"),
  // The front-end asks the server to download a YouTube video.
  downloadReplay: (url, platform) => ipcRenderer.invoke("download-replay", url, platform),
  // The front-end asks the server to enables/disables debug mode.
  debugMode: () => ipcRenderer.invoke("debug-mode"),
  // The front-end asks the server to open an url in the default browser.
  openURL: (url) => ipcRenderer.invoke("open-url", url),
  // The front-end asks the server to return the web server port.
  getExpressPort: () => ipcRenderer.invoke("get-express-port"),
  // The front-end asks the server to return the JWT token content.
  getJWTAccessToken: () => ipcRenderer.invoke("get-jwt-access-token"),
  // The front-end asks the server to return the project version.
  getVersion: () => ipcRenderer.invoke("get-version"),
  // The front-end asks the server to return the user's login status.
  getLoginState: () => ipcRenderer.invoke("get-login-state"),
  // The front-end asks the server to return the game-history output path.
  getGameHistoryOutputPath: () => ipcRenderer.invoke("get-game-history-output-path"),
  // The front-end asks the server to return the replay downloader output path.
  getReplayDownloaderOutputPath: () => ipcRenderer.invoke("get-replay-downloader-output-path"),
  // The front-end asks the server to return the cutter output path.
  getVideoCutterOutputPath: () => ipcRenderer.invoke("get-video-cutter-output-path"),
  // The front-end asks the server to edit the cutter output path.
  setSetting: (setting) => ipcRenderer.invoke("set-setting", setting),
  // The front-end asks the server to logout.
  logout: () => ipcRenderer.invoke("logout"),
  // The front-end asks the server to check JWT token.
  checkJwtToken: () => ipcRenderer.invoke("check-jwt-token"),
  // The front-end asks the server to cut a video file.
  cutVideoFile: (game, videoPath, customText) => ipcRenderer.invoke("cut-video-file", game, videoPath, customText),
  // The front-end asks the server to cut all video files.
  cutVideoFiles: (game, videoPath, customText) => ipcRenderer.invoke("cut-video-files", game, videoPath, customText),
  // The front-end asks the server to play a video file that has just been cut.
  openFile: (path) => ipcRenderer.invoke("open-file", path),
  // The front-end asks the server to ask the user to select a video file.
  openVideoFile: (videoPath) => ipcRenderer.invoke("open-video-file", videoPath),
  // The front-end asks the server to extract the public player games.
  extractPublicPseudoGames: (tag, nbPages, seasonIndex, skip, timeToWait) => ipcRenderer.invoke("extract-public-pseudo-games", tag, nbPages, seasonIndex, skip, timeToWait),
  // The front-end asks the server to extract the private player games.
  extractPrivatePseudoGames: (tag, nbPages, seasonIndex, skip, timeToWait) => ipcRenderer.invoke("extract-private-pseudo-games", tag, nbPages, seasonIndex, skip, timeToWait),
  // The front-end asks the server to crop, cut and upload a video to the EBP's S3 server.
  uploadGameMiniMap: (game, cropPosition, videoPath, gameID, orangeTeamInfosPosition, blueTeamInfosPosition, topInfosPosition, sortedOrangePlayersNames, sortedBluePlayersNames) => ipcRenderer.invoke("upload-game-mini-map", game, cropPosition, videoPath, gameID, orangeTeamInfosPosition, blueTeamInfosPosition, topInfosPosition, sortedOrangePlayersNames, sortedBluePlayersNames),
  // The front-end asks the server to cut a video file manualy edited.
  manualCutVideoFile: (videoPath, chunks, notificationData) => ipcRenderer.invoke("manual-cut-video-file", videoPath, chunks, notificationData),
  // The front-end asks the server to save the current language.
  setLanguage: (language) => ipcRenderer.invoke("set-language", language),
  // The front-end asks the server to show a notification.
  showNotification: (hideMainWindow, width, height, notificationData) => ipcRenderer.invoke("show-notification", hideMainWindow, width, height, notificationData),
  // The front-end asks the server to remove the notification.
  removeNotification: (showMainWindow) => ipcRenderer.invoke("remove-notification", showMainWindow),
  
  //#endregion

  //#region Server -> Client

  // The server send the upscaling process percent to the font-end.
  setUpscalePercent: (callback) => ipcRenderer.on("set-upscale-percent", (event, percent) => callback(percent)),
  // The server send the JWT value to the font-end.
  setJWTAccessToken: (callback) => ipcRenderer.on("set-jwt-access-token", (event, accessToken) => callback(accessToken)),
  // The server asks the font-end if the user wants upscaling before analyzing.
  replayCutterUpscale: (callback) => ipcRenderer.on("replay_cutter_upscale", (event, filePath) => callback(filePath)),
  // The server gives the path of the video file selected by the user.
  gameIsUploaded: (callback) => ipcRenderer.on("game-is-uploaded", (event) => callback()),
  // The server gives the path of the video file selected by the user.
  setVideoFile: (callback) => ipcRenderer.on("set-video-file", (event, value) => callback(value)),
  // The server informs the front-end that the games are exported.
  gamesAreExported: (callback) => ipcRenderer.on("games-are-exported", (event, filePath) => callback(filePath)),
  // The server asks the font-end to display an error.
  error: (callback) => ipcRenderer.on("error", (event, i18nPath, i18nVariables) => callback(i18nPath, i18nVariables)),
  // The server asks the font-end to display a replay downloader error.
  replayDownloaderError: (callback) => ipcRenderer.on("replay-downloader-error", (event, error) => callback(error)),
  // The server asks the font-end that the video is well downloaded.
  replayDownloaderSuccess: (callback) => ipcRenderer.on("replay-downloader-success", (event, path) => callback(path)),
  // The server asks the font-end the downloading percent.
  replayDownloaderPercent: (callback) => ipcRenderer.on("replay-downloader-percent", (event, percent) => callback(percent)),
  // The server asks the font-end to display a global message.
  globalMessage: (callback) => ipcRenderer.on("global-message", (event, i18nPath, i18nVariables) => callback(i18nPath, i18nVariables)),

  //#endregion
});
