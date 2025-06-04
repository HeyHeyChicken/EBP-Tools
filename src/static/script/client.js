// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

(async function () {
  const DISCORD_SERVER_URL /* string */ = "https://discord.gg/tAHAc9q3aX";
  const LOGIN_BUTTON /* HTMLElement */ = document.getElementById("loginURL");
  const INPUT_FILE /* HTMLElement */ = document.getElementById("inputFile");
  const GAMES_PERCENT /* HTMLElement */ = document.getElementById("loader");
  const GAMES_COUNTER /* HTMLElement */ = document.getElementById("nbGames");
  const GAMES /* HTMLElement */ = document.querySelector("#result > table");
  const MESSAGE /* HTMLElement */ = document.getElementById("message");
  const FOOTER /* HTMLElement */ = document.querySelector("footer");

  (async function () {
    document.tesseractWorker = await Tesseract.createWorker("eng");
    document.tesseractWorkerNumber = await Tesseract.createWorker("eng");
    document.tesseractWorkerLetter = await Tesseract.createWorker("eng");
    document.tesseractWorkerTime = await Tesseract.createWorker("eng");
    document.tesseractWorker.setParameters({
      tessedit_char_whitelist:
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
    });
    document.tesseractWorkerNumber.setParameters({
      tessedit_char_whitelist: "0123456789",
    });
    document.tesseractWorkerLetter.setParameters({
      tessedit_char_whitelist:
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz ",
    });
    document.tesseractWorkerTime.setParameters({
      tessedit_char_whitelist: "0123456789:",
    });
    INPUT_FILE.disabled = false;
  })();

  let video /* HTMLElement */;

  // List of games detected in a video file.
  let games /* Game[] */ = [];

  // Path to the video file.
  let videoPath /* string */ = "";

  let start = 0;

  async function videoTimeUpdate(event) {
    if (start == 0) {
      start = Date.now();
    }
    if (event.target) {
      let found /* boolean */ = false;
      const DEFAULT_STEP /* number */ = 2;
      if (video.currentTime > 0) {
        const NOW /* number */ = video.currentTime;

        const PERCENT = Math.ceil(100 - (NOW / video.duration) * 100);
        setLoaderPercentOnHMI(PERCENT);

        //#region Détéction de la fin d'une game

        if (!found) {
          if (detectGameScoreFrame(video, games)) {
            found = true;
            const GAME /* Game */ = new Game();
            GAME.end = NOW;

            const PLAYER_NAME_X /* number */ = 475;
            const PLAYER_NAME_MAX_WIDTH /* number */ = 154;

            //#region Orange team

            const ORANGE_TEAM_NAME /* string */ = await getTextFromImage(
              video,
              document.tesseractWorker,
              390,
              187,
              620,
              217,
              7
            );
            if (ORANGE_TEAM_NAME && ORANGE_TEAM_NAME.length >= 2) {
              GAME.orangeTeam.name = ORANGE_TEAM_NAME.toUpperCase();
            }

            const ORANGE_TEAM_SCORE /* string */ = await getTextFromImage(
              video,
              document.tesseractWorkerNumber,
              530,
              89,
              620,
              127,
              7
            );
            if (ORANGE_TEAM_SCORE) {
              const INT_VALUE = parseInt(ORANGE_TEAM_SCORE);
              if (INT_VALUE <= 100) {
                GAME.orangeTeam.score = INT_VALUE;
              }
            }

            // const ORANGE_PLAYER_1 /* string */ = await getTextFromImage(
            //   video,
            //   document.tesseractWorker,
            //   PLAYER_NAME_X,
            //   259,
            //   PLAYER_NAME_X + PLAYER_NAME_MAX_WIDTH,
            //   282,
            //   7
            // );
            // if (ORANGE_PLAYER_1) {
            //   GAME.orangeTeam.players.push(new Player(1, ORANGE_PLAYER_1));
            // }

            // const ORANGE_PLAYER_2 /* string */ = await getTextFromImage(
            //   video,
            //   document.tesseractWorker,
            //   PLAYER_NAME_X,
            //   312,
            //   PLAYER_NAME_X + PLAYER_NAME_MAX_WIDTH,
            //   335,
            //   7
            // );
            // if (ORANGE_PLAYER_2) {
            //   GAME.orangeTeam.players.push(new Player(2, ORANGE_PLAYER_2));
            // }

            // const ORANGE_PLAYER_3 /* string */ = await getTextFromImage(
            //   video,
            //   document.tesseractWorker,
            //   PLAYER_NAME_X,
            //   365,
            //   PLAYER_NAME_X + PLAYER_NAME_MAX_WIDTH,
            //   388,
            //   7
            // );
            // if (ORANGE_PLAYER_3) {
            //   GAME.orangeTeam.players.push(new Player(3, ORANGE_PLAYER_3));
            // }

            // const ORANGE_PLAYER_4 /* string */ = await getTextFromImage(
            //   video,
            //   document.tesseractWorker,
            //   PLAYER_NAME_X,
            //   418,
            //   PLAYER_NAME_X + PLAYER_NAME_MAX_WIDTH,
            //   441,
            //   7
            // );
            // if (ORANGE_PLAYER_4) {
            //   GAME.orangeTeam.players.push(new Player(4, ORANGE_PLAYER_4));
            // }

            //#endregion

            //#region Blue team

            const BLUE_TEAM_NAME /* string */ = await getTextFromImage(
              video,
              document.tesseractWorker,
              390,
              637,
              620,
              667,
              7
            );
            if (BLUE_TEAM_NAME && BLUE_TEAM_NAME.length >= 2) {
              GAME.blueTeam.name = BLUE_TEAM_NAME.toUpperCase();
            }

            const BLUE_TEAM_SCORE /* string */ = await getTextFromImage(
              video,
              document.tesseractWorkerNumber,
              1294,
              89,
              1384,
              127,
              7
            );
            if (BLUE_TEAM_SCORE) {
              const INT_VALUE = parseInt(BLUE_TEAM_SCORE);
              if (INT_VALUE <= 100) {
                GAME.blueTeam.score = INT_VALUE;
              }
            }

            // const BLUE_PLAYER_1 /* string */ = await getTextFromImage(
            //   video,
            //   document.tesseractWorker,
            //   PLAYER_NAME_X,
            //   712,
            //   PLAYER_NAME_X + PLAYER_NAME_MAX_WIDTH,
            //   735,
            //   7
            // );
            // if (BLUE_PLAYER_1) {
            //   GAME.blueTeam.players.push(new Player(6, BLUE_PLAYER_1));
            // }

            // const BLUE_PLAYER_2 /* string */ = await getTextFromImage(
            //   video,
            //   document.tesseractWorker,
            //   PLAYER_NAME_X,
            //   765,
            //   PLAYER_NAME_X + PLAYER_NAME_MAX_WIDTH,
            //   788,
            //   7
            // );
            // if (BLUE_PLAYER_2) {
            //   GAME.blueTeam.players.push(new Player(7, BLUE_PLAYER_2));
            // }

            // const BLUE_PLAYER_3 /* string */ = await getTextFromImage(
            //   video,
            //   document.tesseractWorker,
            //   PLAYER_NAME_X,
            //   818,
            //   PLAYER_NAME_X + PLAYER_NAME_MAX_WIDTH,
            //   841,
            //   7
            // );
            // if (BLUE_PLAYER_3) {
            //   GAME.blueTeam.players.push(new Player(8, BLUE_PLAYER_3));
            // }

            // const BLUE_PLAYER_4 /* string */ = await getTextFromImage(
            //   video,
            //   document.tesseractWorker,
            //   PLAYER_NAME_X,
            //   871,
            //   PLAYER_NAME_X + PLAYER_NAME_MAX_WIDTH,
            //   894,
            //   7
            // );
            // if (BLUE_PLAYER_4) {
            //   GAME.blueTeam.players.push(new Player(9, BLUE_PLAYER_4));
            // }

            //#endregion

            games.unshift(GAME);
            GAMES_COUNTER.innerText = games.length;
          }
        }

        //#endregion

        //#region Détéction du début d'une game

        if (!found) {
          if (detectGameLoadingFrame(video, games)) {
            found = true;
            games[0].start = NOW + 2 /* On vire le bout de loader de map. */;
          }
        }

        if (!found) {
          if (detectGameIntro(video, games)) {
            found = true;
            games[0].start = NOW + 2 /* On vire le bout d'animation de map. */;
          }
        }

        //#endregion

        //#region Detecting card name during game.

        if (!found) {
          if (detectGamePlaying(video, games)) {
            // On cherche le nom de la carte.
            if (games[0].map == "") {
              const TEXT /* string */ = await getTextFromImage(
                video,
                document.tesseractWorkerLetter,
                825,
                81,
                1093,
                102,
                7
              );
              if (TEXT) {
                found = true;
                if (games[0].map == "") {
                  const MAP_NAME /* string */ = getMapByName(TEXT);
                  games[0].map = MAP_NAME;
                  games[0].name = MAP_NAME;
                }
              }
            }

            // We are looking for the name of the orange team.
            if (games[0].orangeTeam.name == "") {
              const TEXT /* string */ = await getTextFromImage(
                video,
                document.tesseractWorker,
                686,
                22,
                833,
                68,
                6
              );
              if (TEXT && TEXT.length >= 2) {
                found = true;
                if (games[0].orangeTeam.name == "") {
                  games[0].orangeTeam.name = TEXT.toUpperCase();
                }
              }
            }

            // We are looking for the name of the blue team.
            if (games[0].blueTeam.name == "") {
              const TEXT /* string */ = await getTextFromImage(
                video,
                document.tesseractWorker,
                1087,
                22,
                1226,
                68,
                6
              );
              if (TEXT && TEXT.length >= 2) {
                found = true;
                if (games[0].blueTeam.name == "") {
                  games[0].blueTeam.name = TEXT.toUpperCase();
                }
              }
            }

            if (
              games[0].orangeTeam.name &&
              games[0].blueTeam.name &&
              games[0].map
            ) {
              if (!games[0].__debug__jumped) {
                const TEXT /* string */ = await getTextFromImage(
                  video,
                  document.tesseractWorkerTime,
                  935,
                  0,
                  985,
                  28,
                  7
                );
                if (TEXT) {
                  found = true;
                  const SPLITTED /* string[] */ = TEXT.split(":");
                  if (SPLITTED.length == 2) {
                    const MINUTES = parseInt(SPLITTED[0]);
                    const SECONDES = parseInt(SPLITTED[1]);
                    const DIFFERENCE = (10 - MINUTES) * 60 - SECONDES;
                    if (MINUTES <= 9) {
                      if (!games[0].__debug__jumped) {
                        games[0].__debug__jumped = true;
                        console.log("Jumping to the game's start !");
                        setVideoCurrentTime(
                          video,
                          NOW - DIFFERENCE,
                          games,
                          videoPath,
                          DISCORD_SERVER_URL
                        );
                        return;
                      }
                    }
                  }
                }
              }
            }
          }
        }

        //#endregion

        setVideoCurrentTime(
          video,
          NOW - DEFAULT_STEP,
          games,
          videoPath,
          DISCORD_SERVER_URL
        );
      } else {
        onVideoEnded(games, videoPath, DISCORD_SERVER_URL);

        const DIFFERENCE = Date.now() - start;
        const MINUTES = Math.floor(DIFFERENCE / 60000);
        const SECONDS = Math.floor((DIFFERENCE % 60000) / 1000);

        console.log(
          `${MINUTES.toString().padStart(
            2,
            "0"
          )}m ${SECONDS.toString().padStart(2, "0")}s`
        );
        start = 0;
      }
    }
  }

  // The server asks the frontend to display an error.
  window.electronAPI.error((error) => {
    displayErrorOnHMI(error);
  });

  // The server gives the path of the video file selected by the user.
  window.electronAPI.setVideoFile((path) => {
    INPUT_FILE.disabled = false;
    videoPath = path;
    if (path) {
      video = document.createElement("video");
      video.addEventListener("loadeddata", videoLoadedData);
      video.addEventListener("timeupdate", videoTimeUpdate);

      video.setAttribute("src", "/file?path=" + path);
      setLoaderPercentOnHMI(0);
      GAMES_PERCENT.classList.remove("d-none");
      INPUT_FILE.classList.add("d-none");
      MESSAGE.classList.remove("d-none");
    } else {
      displayErrorOnHMI("No files selected");
    }
  });

  // Getting the project version.
  window.electronAPI.getVersion().then((version) => {
    FOOTER.innerText = "v" + version.current;
    if (version.current != version.last && version.last) {
      const ALERT = document.createElement("a");
      ALERT.addEventListener("click", function () {
        window.electronAPI.openURL(
          "https://github.com/HeyHeyChicken/EBP-Replay-Cutter/releases/latest"
        );
      });
      ALERT.classList.add("alert");
      ALERT.innerHTML =
        "A new update is available, download it by clicking here.";
      FOOTER.append(ALERT);
    }
  });

  // Getting the web server port.
  window.electronAPI.getExpressPort().then((express_port) => {
    LOGIN_BUTTON.setAttribute(
      "href",
      `https://evabattleplan.com/en/login?redirect_uri=http://127.0.0.1:${express_port}&app=cutter`
    );
  });

  // Getting the user's login status.
  window.electronAPI.getLoginState().then((login_state) => {
    const TARGET = document.getElementById(
      (login_state ? "" : "dis") + "connected"
    );
    if (TARGET) {
      TARGET.style.display = "block";
    }
  });

  // When the user clicks the save all button.
  document
    .querySelector("#result > button")
    .addEventListener("click", async function () {
      const FILE_PATH = await window.electronAPI.cutVideoFiles(
        games,
        videoPath
      );
      const TOAST = Toastify({
        text: "Your videos have been cut here: " + FILE_PATH,
        duration: 5 * 1000,
        close: true,
        gravity: "bottom",
        position: "right",
        stopOnFocus: true,
        style: {
          background: "#4caf50",
        },
        onClick: function () {
          window.electronAPI.readVideoFile(FILE_PATH);
          TOAST.hideToast();
        },
      }).showToast();
    });

  // When the user clicks the login button, it is locked to prevent spam.
  LOGIN_BUTTON.addEventListener("click", function () {
    this.firstChild.disabled = true;
  });

  // When the user clicks on the input to select the video file...
  INPUT_FILE.addEventListener("click", async function () {
    const RESULT = document.getElementById("result");
    RESULT.classList.add("d-none");

    games = [];
    GAMES.innerHTML = "";
    GAMES_COUNTER.innerText = "0";
    INPUT_FILE.disabled = true;
    window.electronAPI.openVideoFile();
  });
})();
