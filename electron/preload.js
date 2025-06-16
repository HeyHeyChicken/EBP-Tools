// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  //#region Client -> Server

  // The front-end asks the server to enables/disables debug mode.
  debugMode: (url) => ipcRenderer.invoke("debug-mode"),
  // The front-end asks the server to open an url in the default browser.
  openURL: (url) => ipcRenderer.invoke("open-url", url),
  // The front-end asks the server to return the web server port.
  getExpressPort: () => ipcRenderer.invoke("get-express-port"),
  // The front-end asks the server to return the project version.
  getVersion: () => ipcRenderer.invoke("get-version"),
  // The front-end asks the server to return the user's login status.
  getLoginState: () => ipcRenderer.invoke("get-login-state"),
  // The front-end asks the server to return the cutter output path.
  getVideoCutterOutputPath: () =>
    ipcRenderer.invoke("get-video-cutter-output-path"),
  // The front-end asks the server to edit the cutter output path.
  setVideoCutterOutputPath: () =>
    ipcRenderer.invoke("set-video-cutter-output-path"),
  // The front-end asks the server to logout.
  logout: () => ipcRenderer.invoke("logout"),
  // The front-end asks the server to cut a video file.
  cutVideoFile: (game, videoPath) =>
    ipcRenderer.invoke("cut-video-file", game, videoPath),
  // The front-end asks the server to cut all video files.
  cutVideoFiles: (game, videoPath) =>
    ipcRenderer.invoke("cut-video-files", game, videoPath),
  // The front-end asks the server to play a video file that has just been cut.
  openFile: (path) => ipcRenderer.invoke("open-file", path),
  // The front-end asks the server to ask the user to select a video file.
  openVideoFile: () => ipcRenderer.invoke("open-video-file"),
  // The front-end asks the server to extract the public player games.
  extractPublicPseudoGames: (tag, nbPages, seasonIndex) =>
    ipcRenderer.invoke(
      "extract-public-pseudo-games",
      tag,
      nbPages,
      seasonIndex
    ),
  // The front-end asks the server to extract the private player games.
  extractPrivatePseudoGames: (tag, nbPages, seasonIndex) =>
    ipcRenderer.invoke(
      "extract-private-pseudo-games",
      tag,
      nbPages,
      seasonIndex
    ),

  //#endregion

  //#region Server -> Client

  // The server gives the path of the video file selected by the user.
  setVideoFile: (callback) =>
    ipcRenderer.on("set-video-file", (event, value) => callback(value)),
  // The server informs the front-end that the games are exported.
  gamesAreExported: (callback) =>
    ipcRenderer.on("games-are-exported", (event, filePath) =>
      callback(filePath)
    ),
  // The server asks the font-end to display an error.
  error: (callback) =>
    ipcRenderer.on("error", (event, value) => callback(value)),

  //#endregion
});
