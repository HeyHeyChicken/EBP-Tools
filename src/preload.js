// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  getExpressPort: () => ipcRenderer.invoke("get-express-port"),
  getVersion: () => ipcRenderer.invoke("get-version"),
  getLoginState: () => ipcRenderer.invoke("get-login-state"),
  cutVideoFile: (game, time) =>
    ipcRenderer.invoke("cut-video-file", game, time),
  readVideoFile: (path) => ipcRenderer.invoke("read-video-file", path),
  openVideoFile: () => ipcRenderer.invoke("open-video-file"),
  workingNbGames: (callback) =>
    ipcRenderer.on("working-nb-games", (event, value) => callback(value)),
  log: (callback) => ipcRenderer.on("log", (event, value) => callback(value)),
  error: (callback) =>
    ipcRenderer.on("error", (event, value) => callback(value)),
  workingPercent: (callback) =>
    ipcRenderer.on("working-percent", (event, value) => callback(value)),
  games: (callback) =>
    ipcRenderer.on("games", (event, value) => callback(value)),
});
window.addEventListener("DOMContentLoaded", () => {
  //alert("lol");
});
