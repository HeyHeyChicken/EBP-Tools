// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const {
  app,
  BrowserWindow,
  ipcMain,
  session,
  dialog,
  shell,
} = require("electron");

// run this as early in the main process as possible
if (require("electron-squirrel-startup")) {
  app.quit();
}

const path = require("node:path");
const express = require("express");
const os = require("os");
const { exec } = require("child_process");
const { default: getPort } = require("get-port");
const { version } = require("../package.json");
const https = require("https");

//#endregion

const IS_PROD = process.env.NODE_ENV === "production";
const ROOT_PATH = IS_PROD ? process.resourcesPath : __dirname;
const FFMPEG_PATH = path.join(ROOT_PATH, "ffmpeg", os.platform());
let mainWindow;
let projectLatestVersion /* string */ = "";

(async () => {
  getProjectLatestVersion((version) => {
    projectLatestVersion = version;
  });

  //#region Express

  const PORT = await getPort();
  const APP = express();
  if (!IS_PROD) {
    APP.set("env", "development");
  }
  APP.use(express.static(path.join(ROOT_PATH, "static")));

  APP.get("/", (request, response) => {
    response.sendFile(path.join(ROOT_PATH, "views", "index.html"));
  });

  // Allows the application's front-end to access local files on the user's device.
  APP.get("/file", (req, res) => {
    const FILE_PATH = req.query.path;
    if (!FILE_PATH) {
      return res.status(400).send("Missing path");
    }
    res.sendFile(FILE_PATH);
  });

  APP.listen(PORT, () => {
    console.log(
      `EBP's Replay cutter's express server is listening on http://localhost:${PORT}`
    );
  });

  //#endregion

  /**
   * This function cuts out a part of a video to get one file per game.
   * @param {Game} game Game's data.
   * @param {string} videoPath Full video path.
   * @returns {string} Cutted video path.
   */
  function cutVideoFile(game, videoPath) {
    // A unique number is added to the end of the file name to ensure that an existing file is not overwritten.
    const NOW = new Date().getTime();
    const OUTPUT_FILE_PATH /* string */ = path.join(
      path.join(os.homedir(), "Downloads"),
      `EBP - ${game.orangeTeam.name} vs ${game.blueTeam.name} - ${game.map} (${NOW}).mp4`
    );
    const COMMAND /* string */ = `"${FFMPEG_PATH}" -ss ${
      game._start
    } -i "${videoPath}" -t ${
      game._end - game._start
    } -c copy "${OUTPUT_FILE_PATH}"`;

    exec(COMMAND);
    return OUTPUT_FILE_PATH;
  }

  /**
   * Cette fonction récupère le numéro de la dernière version publiée du projet.
   * @param {Function} callback
   */
  function getProjectLatestVersion(callback) {
    const OPTIONS = {
      hostname: "api.github.com",
      path: "/repos/heyheychicken/ebp-replay-cutter/releases/latest",
      method: "GET",
      headers: { "User-Agent": "Node.js" },
    };

    const REQUEST = https.request(OPTIONS, (res) => {
      let data = "";

      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          callback(json.tag_name);
        } catch (err) {
          console.error(err);
        }
      });
    });

    REQUEST.on("error", (err) => callback(err));
    REQUEST.end();
  }

  /**
   * This function retrieves the resolution of a video file.
   * @param {string} ffmpegPath Path of the ffmpeg binary.
   * @param {string} videoPath Path of the video file.
   * @param {Function} callback Callback function with width and height information.
   */
  function getVideoResolution(ffmpegPath, videoPath, callback) {
    const COMMAND = `${ffmpegPath} -i "${videoPath}" 2>&1`;
    exec(COMMAND, (err, stdout, stderr) => {
      const OUTPUT = stderr || stdout;
      const RESOLUTION = OUTPUT.match(/, (\d+)x(\d+)[ ,]/);
      if (!RESOLUTION) {
        console.error("Info not found");
      }
      const WIDTH = +RESOLUTION[1];
      const HEIGHT = +RESOLUTION[2];
      callback(WIDTH, HEIGHT);
    });
  }

  /**
   * This function initializes the front-end.
   */
  function createWindow() {
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

    // Hides the menu bar displayed in the top left corner on Windows.
    mainWindow.setMenuBarVisibility(false);

    // Loads the application's index.html.
    mainWindow.loadURL(`http://127.0.0.1:${PORT}`);
    if (!IS_PROD) {
      mainWindow.webContents.openDevTools();
    }
  }

  /**
   * This method will be called when Electron has finished initialization and is ready to create browser windows.
   */
  app.whenReady().then(() => {
    createWindow();

    // The front-end asks the server to open an url in the default browser.
    ipcMain.handle("open-url", async (event, url) => {
      shell.openExternal(url);
    });

    // The front-end asks the server to return the web server port.
    ipcMain.handle("get-express-port", async () => {
      return PORT;
    });

    // The front-end asks the server to return the project version.
    ipcMain.handle("get-version", async () => {
      return {
        current: version,
        last: projectLatestVersion,
      };
    });

    // The front-end asks the server to return the user's login status.
    ipcMain.handle("get-login-state", async () => {
      return session.defaultSession.cookies
        .get({ domain: "evabattleplan.com" })
        .then((cookies) => {
          const WORDPRESS_COOKIE = cookies.find((c) =>
            c.name.startsWith("wordpress_logged_in")
          );
          if (!IS_PROD) {
            return true;
          }
          return !!WORDPRESS_COOKIE;
        });
    });

    // The front-end asks the server to ask the user to choose a video file.
    ipcMain.handle("open-video-file", async () => {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        properties: ["openFile"],
        filters: [{ name: "EVA MP4 video", extensions: ["mp4"] }],
      });
      if (canceled) {
        mainWindow.webContents.send("set-video-file", "");
      } else {
        // Check that the video file resolution is correct.
        getVideoResolution(
          FFMPEG_PATH,
          filePaths[0],
          (width, height, duration) => {
            const EXPECTED_WIDTH /* number */ = 1920;
            const EXPECTED_HEIGHT /* number */ = 1080;
            if (width == EXPECTED_WIDTH && height == EXPECTED_HEIGHT) {
              mainWindow.webContents.send("set-video-file", filePaths[0]);
            } else {
              mainWindow.webContents.send(
                "error",
                `Resolution must be ${EXPECTED_WIDTH}x${EXPECTED_HEIGHT}`
              );
              mainWindow.webContents.send("set-video-file", "");
            }
          }
        );
      }
    });

    // The front-end asks the server to cut a video file.
    ipcMain.handle("cut-video-files", async (event, games, videoPath) => {
      games.forEach((game) => {
        return cutVideoFile(game, videoPath);
      });
      return path.join(os.homedir(), "Downloads");
    });

    // The front-end asks the server to cut a video file.
    ipcMain.handle("cut-video-file", async (event, game, videoPath) => {
      return cutVideoFile(game, videoPath);
    });

    // The front-end asks the server to open a video file.
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
      // On macOS it's common to re-create a window in the app when the dock icon is clicked and there are no other windows open.
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // Quit when all windows are closed, except on macOS.
  // There, it's common for applications and their menu bar to stay active until the user quits explicitly with Cmd + Q.
  app.on("window-all-closed", function () {
    if (process.platform !== "darwin") app.quit();
  });
})();
