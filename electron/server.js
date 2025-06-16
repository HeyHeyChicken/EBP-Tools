// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const {
  app,
  BrowserWindow,
  screen,
  ipcMain,
  session,
  dialog,
  shell,
} = require("electron");

// When in installation mode, close the application.
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
const http = require("http");
const fs = require("fs");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const ExcelJS = require("exceljs");
require("./discord-rpc");

puppeteer.use(StealthPlugin());

//#endregion

let isProd = process.env.NODE_ENV === "production";
const ROOT_PATH = isProd ? process.resourcesPath : __dirname;
const FFMPEG_PATH = path.join(
  ROOT_PATH,
  isProd ? "ffmpeg" : "../ffmpeg",
  os.platform()
);
const SETTINGS_PATH = path.join(ROOT_PATH, "settings.json");
const WINDOW_WIDTH = 800;
const WINDOW_DEV_PANEL_WIDTH = 540;
const WINDOW_HEIGHT = 800;
let mainWindow;
let projectLatestVersion /* string */ = "";

(async () => {
  getProjectLatestVersion((version) => {
    projectLatestVersion = version;
  });

  //#region Express

  // A port is randomly generated from the ports available on the machine.
  const PORT = await getPort();
  const APP = express();
  if (!isProd) {
    APP.set("env", "development");
  }
  if (isProd) {
    APP.use(express.static(path.join(ROOT_PATH, "browser")));
  }

  APP.get("/", (request, response) => {
    if (isProd) {
      response.sendFile(path.join(ROOT_PATH, "browser", "index.html"));
    } else {
      response.redirect("http://localhost:4200");
    }
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
    console.log(`[EXPRESS] Listening on http://localhost:${PORT}.`);
  });

  //#endregion

  function getVideoCutterOutputPath() {
    const SETTINGS = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
    return (
      SETTINGS.videoCutterOutputPath ?? path.join(os.homedir(), "Downloads")
    );
  }

  /**
   * This function allows you to wait for an HTTP:PORT address to respond.
   * @param {number} port Port of address to wait.
   * @param {string} host Host of address to wait.
   * @param {number} timeout Maximum time to wait before declaring a failure.
   * @param {number} interval Address presence check interval.
   * @returns
   */
  function waitForHttp(
    port,
    host = "localhost",
    timeout = 60 * 1000,
    interval = 500
  ) {
    return new Promise((resolve, reject) => {
      const DEADLINE = Date.now() + timeout;

      const CHECK = () => {
        const REQUEST = http.get(
          { hostname: host, port: port, path: "/", timeout: 2000 },
          (res) => {
            res.destroy();
            resolve();
          }
        );

        REQUEST.on("error", () => {
          if (Date.now() > DEADLINE) {
            reject(
              new Error(`Timeout waiting for HTTP server on port ${port}`)
            );
          } else {
            setTimeout(CHECK, interval);
          }
        });
      };

      CHECK();
    });
  }

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
      getVideoCutterOutputPath(),
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
   * This function retrieves the number of the latest published version of the project.
   * @param {Function} callback
   */
  function getProjectLatestVersion(callback) {
    const OPTIONS = {
      hostname: "api.github.com",
      path: "/repos/heyheychicken/EBP-EVA-Battle-Plan-Tools/releases/latest",
      method: "GET",
      headers: { "User-Agent": "Node.js" },
    };

    const REQUEST = https.request(OPTIONS, (res) => {
      let data = "";

      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const DATA = JSON.parse(data);
          callback(DATA.tag_name);
        } catch (err) {}
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
        callback(0, 0);
      } else {
        const WIDTH = +RESOLUTION[1];
        const HEIGHT = +RESOLUTION[2];
        callback(WIDTH, HEIGHT);
      }
    });
  }

  /**
   * This function initializes the front-end.
   */
  function createWindow() {
    const PRIMARY_DISPLAY = screen.getPrimaryDisplay();
    mainWindow = new BrowserWindow({
      width: Math.min(
        PRIMARY_DISPLAY.workAreaSize.width,
        WINDOW_WIDTH + (!isProd ? WINDOW_DEV_PANEL_WIDTH : 0)
      ),
      height: Math.min(PRIMARY_DISPLAY.workAreaSize.height, WINDOW_HEIGHT),
      resizable: false,
      contextIsolation: true,
      webPreferences: {
        preload: isProd
          ? MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY
          : path.join(__dirname, "preload.js"),
      },
    });

    // Hides the menu bar displayed in the top left corner on Windows.
    mainWindow.setMenuBarVisibility(false);

    // Loads the application's index.html.
    mainWindow.loadURL(
      isProd
        ? `https://evabattleplan.com/${app.getLocale()}/login?app=cutter&redirect_uri=${encodeURIComponent(
            "http://localhost:" + PORT
          )}`
        : `http://localhost:${PORT}`
    );
    if (!isProd) {
      mainWindow.webContents.openDevTools();
    }
  }

  /**
   * This function adds an EVA game to a game list.
   * @param {*} games List of games to complete.
   * @param {*} game Game to add.
   */
  function addGame(games, game) {
    const DATE = new Date(game.createdAt);
    const NEW_GAME = {
      mode: game.mode.identifier,
      map: game.map.name,
      date: DATE.toLocaleDateString("fr-FR"),
      hour: DATE.toLocaleTimeString("fr-FR", {
        hour: "2-digit",
        minute: "2-digit",
      }),
      duration: game.data.duration,
      orangeTeam: {
        name: game.data.teamOne.name,
        score: game.data.teamOne.score,
        players: [],
      },
      blueTeam: {
        name: game.data.teamTwo.name,
        score: game.data.teamTwo.score,
        players: [],
      },
    };
    game.players.forEach((player) => {
      const NEW_PLAYER = {
        name: player.data.niceName,
        kills: player.data.kills,
        deaths: player.data.deaths,
        assists: player.data.assists,
        score: player.data.score,
      };
      if (player.data.team == NEW_GAME.orangeTeam.name) {
        NEW_GAME.orangeTeam.players.push(NEW_PLAYER);
      } else if (player.data.team == NEW_GAME.blueTeam.name) {
        NEW_GAME.blueTeam.players.push(NEW_PLAYER);
      }
    });

    games.push(NEW_GAME);
  }

  async function exportGamesToExcel(games, playerName) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path.join(ROOT_PATH, "template.xlsx"));

    const worksheet = workbook.getWorksheet(1);

    worksheet.getCell("A1").value = app.getLocale();

    let rowIndew = 3;
    games.forEach((game) => {
      rowIndew++;

      worksheet.getCell(`A${rowIndew}`).value = game.mode; // Mode
      worksheet.getCell(`B${rowIndew}`).value =
        game.orangeTeam.players.length + game.blueTeam.players.length; // Nb players
      worksheet.getCell(`C${rowIndew}`).value = game.map; // Map
      worksheet.getCell(`H${rowIndew}`).value = game.date; // Date
      worksheet.getCell(`I${rowIndew}`).value = game.hour; // Hour
      worksheet.getCell(`K${rowIndew}`).value = game.duration; // Duration
      worksheet.getCell(`J${rowIndew}`).value = `${Math.floor(
        game.duration / 60
      )}m${game.duration % 60}s`; // Readable duration
      worksheet.getCell(`L${rowIndew}`).value = game.orangeTeam.score; // Orange team score
      worksheet.getCell(`AL${rowIndew}`).value = game.blueTeam.score; // Blue team score

      let letters = [
        ["M", "N", "O", "P", "Q"],
        ["R", "S", "T", "U", "V"],
        ["W", "X", "Y", "Z", "AA"],
        ["AB", "AC", "AD", "AE", "AF"],
        ["AG", "AH", "AI", "AJ", "AK"],
      ];
      for (let i = 0; i < game.orangeTeam.players.length; i++) {
        worksheet.getCell(`${letters[i][0]}${rowIndew}`).value =
          game.orangeTeam.players[i].name; // Name
        worksheet.getCell(`${letters[i][1]}${rowIndew}`).value =
          game.orangeTeam.players[i].kills; // Kills
        worksheet.getCell(`${letters[i][2]}${rowIndew}`).value =
          game.orangeTeam.players[i].deaths; // Deaths
        worksheet.getCell(`${letters[i][3]}${rowIndew}`).value =
          game.orangeTeam.players[i].assists; // Assists
        worksheet.getCell(`${letters[i][4]}${rowIndew}`).value =
          game.orangeTeam.players[i].score; // Score
      }

      letters = [
        ["AM", "AN", "AO", "AP", "AQ"],
        ["AR", "AS", "AT", "AU", "AV"],
        ["AW", "AX", "AY", "AZ", "BA"],
        ["BB", "BC", "BD", "BE", "BF"],
        ["BG", "BH", "BI", "BJ", "BK"],
      ];
      for (let i = 0; i < game.blueTeam.players.length; i++) {
        worksheet.getCell(`${letters[i][0]}${rowIndew}`).value =
          game.blueTeam.players[i].name; // Name
        worksheet.getCell(`${letters[i][1]}${rowIndew}`).value =
          game.blueTeam.players[i].kills; // Kills
        worksheet.getCell(`${letters[i][2]}${rowIndew}`).value =
          game.blueTeam.players[i].deaths; // Deaths
        worksheet.getCell(`${letters[i][3]}${rowIndew}`).value =
          game.blueTeam.players[i].assists; // Assists
        worksheet.getCell(`${letters[i][4]}${rowIndew}`).value =
          game.blueTeam.players[i].score; // Score
      }
    });

    const NOW = new Date().getTime();
    const FILE_PATH = path.join(
      os.homedir(),
      "Downloads",
      `EBP - ${playerName} (${NOW}).xlsx`
    );
    // Sauvegarder dans un nouveau fichier
    await workbook.xlsx.writeFile(FILE_PATH);

    return FILE_PATH;
  }

  async function extractGames(browser, page, nbPages, tag, seasonIndex) {
    let index = 0;
    const GAMES = [];

    page.on("request", async (request) => {
      const URL = request.url();
      if (URL.includes("graphql")) {
        try {
          const DATA = request.postData();
          if (DATA) {
            const JSON_DATA = JSON.parse(DATA);
            if (JSON_DATA.operationName === "listGameHistories") {
              JSON_DATA.variables.seasonId = seasonIndex;
              request.continue({
                headers: request.headers(),
                method: "POST",
                postData: JSON.stringify(JSON_DATA),
              });
            } else {
              request.continue();
            }
          } else {
            request.continue();
          }
        } catch (err) {}
      } else {
        request.continue();
      }
    });

    await page.setRequestInterception(true);
    page.on("response", async (response) => {
      if (response.status() === 403) {
        console.log("❌ Accès refusé à l’API :", response.url());
      }
      if (response.url().includes("graphql")) {
        try {
          const JSON = await response.json();
          if (
            JSON?.data?.gameHistories?.nodes &&
            Array.isArray(JSON.data.gameHistories.nodes)
          ) {
            index++;
            const OLD_INDEX = index;
            JSON.data.gameHistories.nodes.forEach((game) => {
              addGame(GAMES, game);
            });

            if (index < nbPages) {
              const MIN = 800;
              const MAX = 1200;
              setTimeout(async () => {
                const QUERY = ".btn-group > button:last-child";
                await page.waitForSelector(QUERY);
                await page.click(QUERY);

                setTimeout(async () => {
                  if (OLD_INDEX == index) {
                    await page.waitForSelector(QUERY);
                    await page.click(QUERY);
                  }
                }, MAX + 1000);
              }, Math.floor(Math.random() * (MAX - MIN + 1)) + MIN);
            } else {
              const FILE_PATH = await exportGamesToExcel(
                GAMES,
                tag.split("#")[0]
              );
              browser.close();
              mainWindow.webContents.send("games-are-exported", FILE_PATH);
            }
          }
        } catch (err) {}
      }
    });
  }

  if (!isProd) {
    app.commandLine.appendSwitch("disable-web-security");
    app.commandLine.appendSwitch(
      "disable-features",
      "IsolateOrigins,site-per-process"
    );
  }

  /**
   * This method will be called when Electron has finished initialization and is ready to create browser windows.
   */
  app.whenReady().then(() => {
    if (isProd) {
      // If we are in production, we immediately create the window that will contain the HMI.
      createWindow();
    } else {
      // If we are in dev, we wait until the Angular server is ready before creating the window that will contain the HMI.
      waitForHttp(4200).then(() => {
        createWindow();
      });
    }

    // The front-end asks the server to enables/disables debug mode.
    ipcMain.handle("debug-mode", async () => {
      isProd = !isProd;
      if (isProd) {
        mainWindow.webContents.closeDevTools();
      } else {
        mainWindow.webContents.openDevTools();
      }

      const PRIMARY_DISPLAY = screen.getPrimaryDisplay();
      mainWindow.setResizable(true);
      const DESIRED_WIDTH =
        WINDOW_WIDTH + (!isProd ? WINDOW_DEV_PANEL_WIDTH : 0);
      mainWindow.setSize(
        Math.min(PRIMARY_DISPLAY.workAreaSize.width, DESIRED_WIDTH),
        Math.min(PRIMARY_DISPLAY.workAreaSize.height, WINDOW_HEIGHT)
      );
      mainWindow.setResizable(false);
    });

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

    // The front-end asks the server to edit the video cutter output path.
    ipcMain.handle("set-video-cutter-output-path", async () => {
      const PATH = getVideoCutterOutputPath();

      const { canceled, filePaths } = await dialog.showOpenDialog({
        properties: ["openDirectory"],
        defaultPath: PATH,
      });
      if (!canceled && filePaths.length == 1) {
        const SETTINGS = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
        SETTINGS.videoCutterOutputPath = filePaths[0];

        fs.writeFileSync(
          SETTINGS_PATH,
          JSON.stringify(SETTINGS, null, 2),
          "utf-8"
        );
        return filePaths[0];
      }
    });

    // The front-end asks the server to return the video cutter output path.
    ipcMain.handle("get-video-cutter-output-path", async () => {
      return getVideoCutterOutputPath();
    });

    // The front-end asks the server to return the user's login status.
    ipcMain.handle("get-login-state", async () => {
      return session.defaultSession.cookies
        .get({ domain: "evabattleplan.com" })
        .then((cookies) => {
          const WORDPRESS_COOKIE = cookies.find((c) =>
            c.name.startsWith("wordpress_logged_in")
          );
          if (!isProd) {
            return true;
          }
          return !!WORDPRESS_COOKIE;
        });
    });

    // The front-end asks the server to logout.
    ipcMain.handle("logout", async () => {
      const SESSION = session.defaultSession;

      Promise.all([
        SESSION.clearStorageData({
          storages: [
            "cookies",
            "localstorage",
            "indexdb",
            "websql",
            "serviceworkers",
          ],
        }),
        SESSION.clearCache(),
      ]).then(() => {
        mainWindow.loadURL(
          `https://evabattleplan.com/en/login?app=cutter&redirect_uri=${encodeURIComponent(
            "http://localhost:" + PORT
          )}`
        );
      });
    });

    // The front-end asks the server to extract the public player games.
    ipcMain.handle(
      "extract-private-pseudo-games",
      async (event, nbPages, seasonIndex) => {
        const PRIMARY_DISPLAY = screen.getPrimaryDisplay();
        const BROWSER_WIDTH = Math.min(
          PRIMARY_DISPLAY.workAreaSize.width,
          1920
        );
        const BROWSER_HEIGHT = Math.min(
          PRIMARY_DISPLAY.workAreaSize.height,
          1080
        );
        const BROWSER = await puppeteer.launch({
          headless: false,
          args: [`--window-size=${BROWSER_WIDTH},${BROWSER_HEIGHT}`],
        });
        const PAGE = await BROWSER.newPage();
        const LANGUAGE = await PAGE.evaluate(() => navigator.language);

        PAGE.on("framenavigated", async (frame) => {
          // When the user is logged in, he is redirected to the games page.
          if (frame.url().endsWith("/profile/dashboard")) {
            await PAGE.goto(`https://app.eva.gg/${LANGUAGE}/profile/history/`);
          }
        });

        await extractGames(BROWSER, PAGE, nbPages, "private", seasonIndex);

        await PAGE.goto(`https://app.eva.gg/${LANGUAGE}/login`, {
          waitUntil: "networkidle2",
        });
      }
    );

    // The front-end asks the server to extract the public player games.
    ipcMain.handle(
      "extract-public-pseudo-games",
      async (event, tag, nbPages, seasonIndex) => {
        if (tag) {
          const BROWSER = await puppeteer.launch({
            headless: false,
            defaultViewport: {
              width: 1920,
              height: 1080,
            },
            args: ["--window-size=0,0"],
          });
          const PAGE = await BROWSER.newPage();

          // Interception des requêtes GraphQL
          await extractGames(BROWSER, PAGE, nbPages, tag, seasonIndex);

          await PAGE.goto(`https://app.eva.gg/profile/public/${tag}/history/`, {
            waitUntil: "networkidle2",
          });
        }
      }
    );

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
    ipcMain.handle("open-file", async (event, path) => {
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
