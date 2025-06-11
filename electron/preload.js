// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  //#region Client -> Server

  // The front-end asks the server to open an url in the default browser.
  openURL: (url) => ipcRenderer.invoke("open-url", url),
  // The front-end asks the server to return the web server port.
  getExpressPort: () => ipcRenderer.invoke("get-express-port"),
  // The front-end asks the server to return the project version.
  getVersion: () => ipcRenderer.invoke("get-version"),
  // The front-end asks the server to return the user's login status.
  getLoginState: () => ipcRenderer.invoke("get-login-state"),
  // The front-end asks the server to return the cutter output path.
  getVideoCutterOutputPath: () => ipcRenderer.invoke("get-video-cutter-output-path"),
  // The front-end asks the server to edit the cutter output path.
  setVideoCutterOutputPath: () => ipcRenderer.invoke("set-video-cutter-output-path"),
  // The front-end asks the server to logout.
  logout: () => ipcRenderer.invoke("logout"),
  // The front-end asks the server to cut a video file.
  cutVideoFile: (game, videoPath) =>
    ipcRenderer.invoke("cut-video-file", game, videoPath),
  // The front-end asks the server to cut all video files.
  cutVideoFiles: (game, videoPath) =>
    ipcRenderer.invoke("cut-video-files", game, videoPath),
  // The front-end asks the server to play a video file that has just been cut.
  readVideoFile: (path) => ipcRenderer.invoke("read-video-file", path),
  // The front-end asks the server to ask the user to select a video file.
  openVideoFile: () => ipcRenderer.invoke("open-video-file"),

  //#endregion

  //#region Server -> Client

  // The server gives the path of the video file selected by the user.
  setVideoFile: (callback) =>
    ipcRenderer.on("set-video-file", (event, value) => callback(value)),
  // The server asks the font to display an error.
  error: (callback) =>
    ipcRenderer.on("error", (event, value) => callback(value)),

  //#endregion
});