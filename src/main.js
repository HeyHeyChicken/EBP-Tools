// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

const { app, BrowserWindow, ipcMain, session, dialog } = require("electron");
const path = require("node:path");
const express = require("express");
const os = require("os");
const { spawn, exec } = require("child_process");
const { default: getPort } = require("get-port");
const downloadsFolder = require("downloads-folder");
const fs = require("fs");

const { version } = require("../package.json");

const IS_PROD = process.env.NODE_ENV === "production";
const ROOT_PATH = IS_PROD ? process.resourcesPath : __dirname;
const FFMPEG_PATH = path.join(ROOT_PATH, "ffmpeg", os.platform());
let mainWindow;
let videoPath;

//#region Express

(async () => {
  const PORT = await getPort();
  const APP = express();
  APP.set("env", "development");
  //APP.set("view engine", "pug");
  //APP.set("views", VIEW_PATH);
  APP.use(express.static(path.join(ROOT_PATH, "static")));

  APP.get("/", (request, response) => {
    response.sendFile(path.join(ROOT_PATH, "views", "index.html"));
  });

  APP.listen(PORT, () => {
    console.log(
      `EBP's Replay cutter's express server is listening on http://localhost:${PORT}`
    );
  });

  //#endregion

  /**
   * Cette fonction permet de récupérer la résolution et la durée d'un fichier vidéo.
   * @param {*} ffmpegPath
   * @param {*} videoPath
   * @param {*} callback
   */
  function getVideoInfo(ffmpegPath, videoPath, callback) {
    const COMMAND = `${ffmpegPath} -i "${videoPath}" 2>&1`;
    exec(COMMAND, (err, stdout, stderr) => {
      const OUTPUT = stderr || stdout;
      const RESOLUTION = OUTPUT.match(/, (\d+)x(\d+)[ ,]/);
      const DURATION = OUTPUT.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
      console.log(RESOLUTION, DURATION);
      if (!RESOLUTION || !DURATION) {
        console.error("Info not found");
      }
      const width = +RESOLUTION[1];
      const height = +RESOLUTION[2];
      const duration = +DURATION[1] * 3600 + +DURATION[2] * 60 + +DURATION[3];
      callback(width, height, duration);
    });
  }

  async function detectGamesInVideo(filePath) {
    const BINARY_PATH = path.join(ROOT_PATH, "detector", os.platform());
    const FFMPEG_PATH = path.join(ROOT_PATH, "ffmpeg", os.platform());

    getVideoInfo(FFMPEG_PATH, filePath, (width, height, duration) => {
      if (width == 1920 && height == 1080) {
        const child = spawn(BINARY_PATH, [
          filePath,
          os.platform(),
          !IS_PROD,
          FFMPEG_PATH,
          duration,
        ]);
        mainWindow.webContents.send("log", "B");

        child.stdout.on("data", (data) => {
          mainWindow.webContents.send("log", "C: Data");
          try {
            const DATA = JSON.parse(data.toString().trim());
            console.log(DATA);
            if (DATA.nbGames) {
              mainWindow.webContents.send("working-nb-games", DATA.nbGames);
            }
            if (DATA.percent) {
              mainWindow.webContents.send("working-percent", DATA.percent);
            } else if (Array.isArray(DATA)) {
              mainWindow.webContents.send("games", DATA);
            }
          } catch (e) {
            console.error(e);
          }
        });

        child.stderr.on("data", (stderr) => {
          mainWindow.webContents.send("error", stderr.toString().trim());
          mainWindow.webContents.send("games", []);
        });
      } else {
        mainWindow.webContents.send("error", "Resolution must be 1920x1080");
      }
    });
  }

  function createWindow() {
    // Create the browser window.
    mainWindow = new BrowserWindow({
      width: 800 + (!IS_PROD ? 540 : 0),
      height: 800,
      resizable: false,
      webPreferences: {
        preload: IS_PROD
          ? MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY
          : path.join(__dirname, "preload.js"),
      },
    });

    mainWindow.setMenuBarVisibility(false);

    // and load the index.html of the app.
    mainWindow.loadURL(`http://127.0.0.1:${PORT}`);
    //if (!IS_PROD) {
    mainWindow.webContents.openDevTools();
    //}

    // Open the DevTools.
    // mainWindow.webContents.openDevTools()
  }

  // This method will be called when Electron has finished
  // initialization and is ready to create browser windows.
  // Some APIs can only be used after this event occurs.
  app.whenReady().then(() => {
    createWindow();

    ipcMain.handle("get-express-port", async () => {
      return PORT;
    });

    ipcMain.handle("get-version", async () => {
      return version;
    });

    ipcMain.handle("get-login-state", async () => {
      return session.defaultSession.cookies
        .get({ domain: "evabattleplan.com" })
        .then((cookies) => {
          // Cherche le cookie wordpress_logged_in...
          const wpCookie = cookies.find((c) =>
            c.name.startsWith("wordpress_logged_in")
          );
          if (!IS_PROD) {
            return true;
          }
          return !!wpCookie;
        });
    });

    ipcMain.handle("open-video-file", async () => {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        properties: ["openFile"],
        filters: [{ name: "MP4 videos", extensions: ["mp4"] }],
      });
      if (canceled) {
        return null;
      } else {
        videoPath = filePaths[0];
        detectGamesInVideo(videoPath);
        return videoPath;
      }
    });

    ipcMain.handle("cut-video-file", async (event, game, time) => {
      const OUTPUT_FILE_PATH = path.join(
        downloadsFolder(),
        "EBP_" + game.map + "_" + time + ".mp4"
      );
      const COMMAND = `"${FFMPEG_PATH}" -ss ${
        game.start
      } -i "${videoPath}" -t ${
        game.end.time - game.start
      } -c copy "${OUTPUT_FILE_PATH}"`;
      mainWindow.webContents.send("log", COMMAND);

      exec(COMMAND);
      return OUTPUT_FILE_PATH;
    });

    ipcMain.handle("read-video-file", async (event, path) => {
      const COMMAND =
        process.platform === "win32"
          ? `start "" "${path}"`
          : process.platform === "darwin"
          ? `open "${path}"`
          : `xdg-open "${path}"`;

      exec(COMMAND);
    });

    app.on("activate", function () {
      // On macOS it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // Quit when all windows are closed, except on macOS. There, it's common
  // for applications and their menu bar to stay active until the user quits
  // explicitly with Cmd + Q.
  app.on("window-all-closed", function () {
    if (process.platform !== "darwin") app.quit();
  });

  // In this file you can include the rest of your app's specific main process
  // code. You can also put them in separate files and require them here.
})();
