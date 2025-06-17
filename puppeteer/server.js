// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const http = require("http");
const { Server } = require("socket.io");

//#endregion

async function startPuppeteer(port) {
  puppeteer.use(StealthPlugin());

  const SERVER = http.createServer();
  const IO = new Server(SERVER);

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

  /**
   * Cette fonction extrait les games à partir d'une session EVA.
   * @param {*} browser
   * @param {*} page
   * @param {*} nbPages
   * @param {*} tag
   * @param {*} seasonIndex
   * @param {*} callback
   */
  async function extractGames(
    browser,
    page,
    nbPages,
    tag,
    seasonIndex,
    callback
  ) {
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
              callback(GAMES);
              browser.close();
            }
          }
        } catch (err) {}
      }
    });
  }

  IO.on("connection", (socket) => {
    // L'utilisateur demande à exporter les games d'un profil publique.
    socket.on(
      "extract-public-pseudo-games",
      async (tag, nbPages, seasonIndex, callback) => {
        try {
          const BROWSER = await puppeteer.launch({
            headless: false,
            defaultViewport: {
              width: 1920,
              height: 1080,
            },
            args: ["--window-size=0,0"],
          });
          const PAGE = await BROWSER.newPage();

          await extractGames(
            BROWSER,
            PAGE,
            nbPages,
            tag,
            seasonIndex,
            callback
          );

          await PAGE.goto(`https://app.eva.gg/profile/public/${tag}/history/`, {
            waitUntil: "networkidle2",
          });
        } catch (err) {}
      }
    );

    // L'utilisateur demande à exporter les games d'un profil privé.
    socket.on(
      "extract-private-pseudo-games",
      async (nbPages, seasonIndex, primaryDisplay, callback) => {
        try {
          const BROWSER_WIDTH = Math.min(
            primaryDisplay.workAreaSize.width,
            1920
          );
          const BROWSER_HEIGHT = Math.min(
            primaryDisplay.workAreaSize.height,
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
              await PAGE.goto(
                `https://app.eva.gg/${LANGUAGE}/profile/history/`
              );
            }
          });

          await extractGames(
            BROWSER,
            PAGE,
            nbPages,
            "private",
            seasonIndex,
            callback
          );

          await PAGE.goto(`https://app.eva.gg/${LANGUAGE}/login`, {
            waitUntil: "networkidle2",
          });
        } catch (err) {}
      }
    );

    socket.on("disconnect", () => {
      process.exit(0);
    });
  });

  SERVER.listen(port, () => {
    console.log(`[PUPPETEER] Listening on http://localhost:${port}.`);
  });
}

module.exports = startPuppeteer;
