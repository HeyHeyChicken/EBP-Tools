// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const puppeteer = require("puppeteer-core");
const os = require("os");

//#endregion

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
      inflictedDamage: player.data.inflictedDamage,
      bulletsFiredAccuracy: player.data.bulletsFiredAccuracy,
    };
    if (player.data.team == NEW_GAME.orangeTeam.name) {
      NEW_GAME.orangeTeam.players.push(NEW_PLAYER);
    } else if (player.data.team == NEW_GAME.blueTeam.name) {
      NEW_GAME.blueTeam.players.push(NEW_PLAYER);
    }
  });

  games.push(NEW_GAME);
}

function getBrowserPath() {
  switch (os.platform()) {
    case "win32":
      return "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
    case "darwin":
      return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }
}

/**
 * Cette fonction extrait les games à partir d'une session EVA.
 * @param {*} browser
 * @param {*} page
 * @param {*} nbPages Number of game pages to extract.
 * @param {*} tag Player Name.
 * @param {*} seasonIndex Season ID to extract.
 * @param {*} callback Callback function
 */
async function extractGames(
  browser,
  page,
  nbPages,
  seasonIndex,
  skip,
  timeToWait,
  dialog,
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
            JSON_DATA.variables.page.page += skip;
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
      } catch (err) {
        dialog.showErrorBox("Error", err);
      }
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
        const JSON_DATA = await response.json();
        if (
          JSON_DATA?.data?.gameHistories?.nodes &&
          Array.isArray(JSON_DATA.data.gameHistories.nodes)
        ) {
          index++;
          const OLD_INDEX = index;
          JSON_DATA.data.gameHistories.nodes.forEach((game) => {
            addGame(GAMES, game);
          });

          if (index < nbPages) {
            const RANDOM = 200;
            const MIN = timeToWait * 1000 - RANDOM;
            const MAX = timeToWait * 1000 + RANDOM;
            setTimeout(async () => {
              const QUERY = ".btn-group > button:last-child";
              await page.waitForSelector(QUERY);

              const END = (await page.$(QUERY + ":disabled")) !== null;
              if (END) {
                callback(GAMES);
                browser.close();
              } else {
                await page.click(QUERY);

                setTimeout(async () => {
                  if (OLD_INDEX == index) {
                    await page.waitForSelector(QUERY);
                    await page.click(QUERY);
                  }
                }, MAX + 1000);
              }
            }, Math.floor(Math.random() * (MAX - MIN + 1)) + MIN);
          } else {
            callback(GAMES);
            browser.close();
          }
        }
      } catch (err) {
        dialog.showErrorBox("Error", err);
      }
    }
  });
}

async function extractPublicPseudoGames(
  tag,
  nbPages,
  seasonIndex,
  skip,
  timeToWait,
  dialog,
  callback
) {
  try {
    const BROWSER = await puppeteer.launch({
      executablePath: getBrowserPath(),
      headless: false,
      defaultViewport: {
        width: 1920,
        height: 1080,
      },
      args: ["--window-size=0,200"],
    });

    const PAGE = (await BROWSER.pages())[0];

    await extractGames(
      BROWSER,
      PAGE,
      nbPages,
      seasonIndex,
      skip,
      timeToWait,
      dialog,
      callback
    );

    await PAGE.goto(`https://app.eva.gg/profile/public/${tag}/history/`, {
      waitUntil: "networkidle2",
    });
  } catch (err) {
    dialog.showErrorBox("Error", err);
  }
}

async function extractPrivatePseudoGames(
  nbPages,
  seasonIndex,
  skip,
  timeToWait,
  dialog,
  callback
) {
  try {
    const BROWSER = await puppeteer.launch({
      executablePath: getBrowserPath(),
      headless: false,
    });

    // Cet espion permet de relancer la fonction si elle ne s'est pas bien passée.
    setTimeout(async () => {
      const PAGE = (await BROWSER.pages())[0];
      const URL = await PAGE.url();
      if (URL == "about:blank") {
        BROWSER.close();
        extractPrivatePseudoGames(
          nbPages,
          seasonIndex,
          skip,
          timeToWait,
          dialog,
          callback
        );
      }
    }, 2000);

    const PAGE = (await BROWSER.pages())[0];

    PAGE.on("framenavigated", async (frame) => {
      // When the user is logged in, he is redirected to the games page.
      if (frame.url().endsWith("/profile/dashboard")) {
        await PAGE.goto(`https://app.eva.gg/fr-FR/profile/history/`);
      }
    });

    await extractGames(
      BROWSER,
      PAGE,
      nbPages,
      seasonIndex,
      skip,
      timeToWait,
      dialog,
      callback
    );

    await PAGE.goto(`https://app.eva.gg/fr-FR/login`, {
      waitUntil: "networkidle2",
    });
  } catch (err) {
    dialog.showErrorBox("Error", err);
  }
}

module.exports = {
  extractPublicPseudoGames,
  extractPrivatePseudoGames,
};
