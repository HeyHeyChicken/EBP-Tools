// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

/**
 * This function initializes the position of a video's playhead when it is loaded.
 * @param {Event} event
 */
function videoLoadedData(event) {
  if (event.target) {
    event.target.currentTime = event.target.duration;
  }
}

/**
 * This function returns the RGB color of a video pixel at a given position.
 * @param {HTMLVideoElement} video HTML DOM of the video from which to extract the pixel.
 * @param {number} x X coordinate of the pixel on the video.
 * @param {number} y  Y coordinate of the pixel on the video.
 * @returns {RGB} RGB color of the video pixel.
 */
function getPixelColor(video, x, y) {
  if (video) {
    const CANVAS = document.createElement("canvas");
    CANVAS.width = 1;
    CANVAS.height = 1;
    const CTX = CANVAS.getContext("2d");
    if (CTX) {
      CTX.drawImage(
        video /* Image */,
        x /* Image X */,
        y /* Image Y */,
        1 /* Image width */,
        1 /* Image height */,
        0 /* Canvas X */,
        0 /* Canvas Y */,
        1 /* Canvas width */,
        1 /* Canvas height */
      );
      const FRAME_DATA = CTX.getImageData(0, 0, 1, 1).data;
      return new RGB(FRAME_DATA[0], FRAME_DATA[1], FRAME_DATA[2]);
    }
  }

  return new RGB(0, 0, 0);
}

/**
 * This function allows you to define if two colors are similar.
 * @param {RGB} color1 Couleur 1.
 * @param {RGB} color2 Couleur 2.
 * @param {number} maxDifference Tolerance.
 * @returns {boolean} Are the colors similar?
 */
function colorSimilarity(color1, color2, maxDifference = 20) {
  return (
    Math.abs(color1.r - color2.r) <= maxDifference &&
    Math.abs(color1.g - color2.g) <= maxDifference &&
    Math.abs(color1.b - color2.b) <= maxDifference
  );
}

/**
 * This function returns the map that resembles what the OCR found.
 * @param string*} search Text found by OCR.
 * @returns {string} Name of the map found.
 */
function getMapByName(search) {
  const MAPS /* Map[] */ = [
    new Map("Artefact", ["artefact"]),
    new Map("Atlantis", ["atlantis"]),
    new Map("Ceres", ["ceres"]),
    new Map("Engine", ["engine"]),
    new Map("Helios Station", ["helios", "station"]),
    new Map("Lunar Outpost", ["lunar", "outpost"]),
    new Map("Outlaw", ["outlaw"]),
    new Map("Polaris", ["polaris"]),
    new Map("Silva", ["silva"]),
    new Map("The Cliff", ["cliff"]),
    new Map("The Rock", ["rock"]),
  ];
  const SPLITTED = search
    .replace(/(\r\n|\n|\r)/gm, "")
    .toLowerCase()
    .split(" ");
  const RESULT = MAPS.find((x) =>
    SPLITTED.some((s) => x.dictionnary.includes(s))
  );
  if (RESULT) {
    return RESULT.name;
  }
  return "";
}

/**
 * This function detects the end of a game via the score display.
 * @param {HTMLVideoElement} video HTML DOM of the video element to be analyzed.
 * @param {Game[]} games List of games already detected.
 * @returns {number} Is the current frame a game score frame?
 */
// prettier-ignore
function detectGameScoreFrame(video, games) {
  if (games.length == 0 || games[0].start != -1) {
    if (
        /* Orange logo */
        colorSimilarity(getPixelColor(video, 325, 153), new RGB(239, 203, 14)) &&
        /* Blue logo */
        colorSimilarity(getPixelColor(video, 313, 613), new RGB(50, 138, 230))
    ) {
      console.log("Detect game score frame (mode 1)");
      return 1;
    }
    if (
        /* Orange logo */
        colorSimilarity(getPixelColor(video, 325, 123), new RGB(239, 203, 14)) &&
        /* Blue logo */
        colorSimilarity(getPixelColor(video, 313, 618), new RGB(50, 138, 230))
    ) {
      console.log("Detect game score frame (mode 2)");
      return 2;
    }
  }
  return 0;
}

/**
 * This function allows you to set the timecode of the video.
 * @param {HTMLVideoElement} video HTML DOM of the video element to set the timecode to
 * @param {number} time Timecode in seconds to apply.
 * @param {Game[]} games List of games already detected.
 * @param {string} videoPath Path of the video file to analyze.
 * @param {string} discordServerURL EBP Discord server URL.
 */
function setVideoCurrentTime(video, time, games, videoPath, discordServerURL) {
  if (video) {
    if (time < video.duration) {
      video.currentTime = time;
    } else {
      onVideoEnded(games, videoPath, discordServerURL);
    }
  }
}

/**
 * This function is executed when the video scan is complete.
 * @param {Game[]} games List of detected games.
 * @param {string} videoPath Path of the analyzed video file.
 * @param {string} discordServerURL EBP Discord server URL.
 */
function onVideoEnded(games, videoPath, discordServerURL) {
  if (games.length == 0) {
    const INPUT_FILE = document.getElementById("inputFile");
    const GAMES_PERCENT = document.getElementById("loader");
    const MESSAGE = document.getElementById("message");

    MESSAGE.classList.add("d-none");
    INPUT_FILE.classList.remove("d-none");
    GAMES_PERCENT.classList.add("d-none");

    const TOAST = Toastify({
      text: "No games were found in your video. If you think this is a mistake, please let me know.",
      duration: 5 * 1000,
      close: true,
      gravity: "bottom",
      position: "right",
      stopOnFocus: true,
      style: {
        background: "#F44336",
      },
      onClick: function () {
        window.electronAPI.openURL(discordServerURL);
        TOAST.hideToast();
      },
    }).showToast();
  } else {
    showGamesOnHMI(games, videoPath);
    console.log(games);
  }
}

/**
 * This function detects the start of a game via the display of the EVA loader.
 * @param {HTMLVideoElement} video HTML DOM of the video element to be analyzed.
 * @param {Game[]} games List of games already detected.
 * @returns {boolean} Is the current frame a game loading frame?
 */
function detectGameLoadingFrame(video, games) /*  */ {
  if (games.length > 0 && games[0].end != -1 && games[0].start == -1) {
    switch (games[0].mode) {
      case 1:
      case 2:
        if (
          /* Logo top */ colorSimilarity(
            getPixelColor(video, 958, 427),
            new RGB(255, 255, 255)
          ) &&
          /* Logo left */ colorSimilarity(
            getPixelColor(video, 857, 653),
            new RGB(255, 255, 255)
          ) &&
          /* Logo right */ colorSimilarity(
            getPixelColor(video, 1060, 653),
            new RGB(255, 255, 255)
          ) &&
          /* Logo middle */ colorSimilarity(
            getPixelColor(video, 958, 642),
            new RGB(255, 255, 255)
          ) &&
          /* Logo black 1 */ colorSimilarity(
            getPixelColor(video, 958, 463),
            new RGB(0, 0, 0)
          ) &&
          /* Logo black 2 */ colorSimilarity(
            getPixelColor(video, 880, 653),
            new RGB(0, 0, 0)
          ) &&
          /* Logo black 3 */ colorSimilarity(
            getPixelColor(video, 1037, 653),
            new RGB(0, 0, 0)
          ) &&
          /* Logo black 4 */ colorSimilarity(
            getPixelColor(video, 958, 610),
            new RGB(0, 0, 0)
          )
        ) {
          console.log("Detect game loading frame");
          return true;
        }
        break;
    }
  }
  return false;
}

/**
 * This function detects the start of a game via the introduction of the map.
 * @param {HTMLVideoElement} video HTML DOM of the video element to be analyzed.
 * @param {Game[]} games List of games already detected.
 * @returns {boolean} Is the current frame a game intro frame?
 */
function detectGameIntro(video, games) {
  if (games.length > 0 && games[0].end != -1 && games[0].start == -1) {
    // We are trying to detect the "B" of "BATTLE ARENA" in the lower right corner of the image.
    if (
      //#region B1
      (colorSimilarity(
        getPixelColor(video, 1495, 942),
        new RGB(255, 255, 255),
        30
      ) &&
        colorSimilarity(
          getPixelColor(video, 1512, 950),
          new RGB(255, 255, 255),
          30
        ) &&
        colorSimilarity(
          getPixelColor(video, 1495, 962),
          new RGB(255, 255, 255),
          30
        ) &&
        colorSimilarity(
          getPixelColor(video, 1512, 972),
          new RGB(255, 255, 255),
          30
        ) &&
        colorSimilarity(
          getPixelColor(video, 1495, 982),
          new RGB(255, 255, 255),
          30
        ) &&
        colorSimilarity(
          getPixelColor(video, 1503, 951),
          new RGB(0, 0, 0),
          200
        ) &&
        colorSimilarity(
          getPixelColor(video, 1503, 972),
          new RGB(0, 0, 0),
          200
        )) ||
      //#endregion
      //#region B2
      (colorSimilarity(
        getPixelColor(video, 1558, 960),
        new RGB(255, 255, 255),
        30
      ) &&
        colorSimilarity(
          getPixelColor(video, 1572, 968),
          new RGB(255, 255, 255),
          30
        ) &&
        colorSimilarity(
          getPixelColor(video, 1558, 977),
          new RGB(255, 255, 255),
          30
        ) &&
        colorSimilarity(
          getPixelColor(video, 1572, 987),
          new RGB(255, 255, 255),
          30
        ) &&
        colorSimilarity(
          getPixelColor(video, 1558, 995),
          new RGB(255, 255, 255),
          30
        ) &&
        colorSimilarity(
          getPixelColor(video, 1564, 969),
          new RGB(0, 0, 0),
          200
        ) &&
        colorSimilarity(
          getPixelColor(video, 1564, 986),
          new RGB(0, 0, 0),
          200
        )) ||
      //#endregion
      //#region B3
      (colorSimilarity(
        getPixelColor(video, 1556, 957),
        new RGB(255, 255, 255),
        30
      ) &&
        colorSimilarity(
          getPixelColor(video, 1571, 964),
          new RGB(255, 255, 255),
          30
        ) &&
        colorSimilarity(
          getPixelColor(video, 1556, 975),
          new RGB(255, 255, 255),
          30
        ) &&
        colorSimilarity(
          getPixelColor(video, 1571, 984),
          new RGB(255, 255, 255),
          30
        ) &&
        colorSimilarity(
          getPixelColor(video, 1556, 993),
          new RGB(255, 255, 255),
          30
        ) &&
        colorSimilarity(
          getPixelColor(video, 1564, 966),
          new RGB(0, 0, 0),
          200
        ) &&
        colorSimilarity(
          getPixelColor(video, 1564, 984),
          new RGB(0, 0, 0),
          200
        )) ||
      //#endregion
      //#region B4
      (colorSimilarity(
        getPixelColor(video, 1617, 979),
        new RGB(255, 255, 255),
        30
      ) &&
        colorSimilarity(
          getPixelColor(video, 1630, 985),
          new RGB(255, 255, 255),
          30
        ) &&
        colorSimilarity(
          getPixelColor(video, 1617, 995),
          new RGB(255, 255, 255),
          30
        ) &&
        colorSimilarity(
          getPixelColor(video, 1630, 1004),
          new RGB(255, 255, 255),
          30
        ) &&
        colorSimilarity(
          getPixelColor(video, 1617, 1011),
          new RGB(255, 255, 255),
          30
        ) &&
        colorSimilarity(
          getPixelColor(video, 1623, 987),
          new RGB(0, 0, 0),
          200
        ) &&
        colorSimilarity(
          getPixelColor(video, 1623, 1004),
          new RGB(0, 0, 0),
          200
        )) ||
      //#endregion
      //#region B5
      (colorSimilarity(
        getPixelColor(video, 1606, 976),
        new RGB(255, 255, 255),
        30
      ) &&
        colorSimilarity(
          getPixelColor(video, 1619, 982),
          new RGB(255, 255, 255),
          30
        ) &&
        colorSimilarity(
          getPixelColor(video, 1606, 991),
          new RGB(255, 255, 255),
          30
        ) &&
        colorSimilarity(
          getPixelColor(video, 1619, 1000),
          new RGB(255, 255, 255),
          30
        ) &&
        colorSimilarity(
          getPixelColor(video, 1606, 1008),
          new RGB(255, 255, 255),
          30
        ) &&
        colorSimilarity(
          getPixelColor(video, 1612, 983),
          new RGB(0, 0, 0),
          200
        ) &&
        colorSimilarity(
          getPixelColor(video, 1612, 1000),
          new RGB(0, 0, 0),
          200
        ))
      //#endregion
    ) {
      console.log("Detect game intro frame");
      return true;
    }
  }
  return false;
}

/**
 * This function detects a playing game frame.
 * @param {HTMLVideoElement} video HTML DOM of the video element to be analyzed.
 * @param {Game[]} games List of games already detected.
 * @returns {boolean} Is the current frame a playing game frame?
 */
function detectGamePlaying(video, games) {
  if (games.length > 0 && games[0].start == -1) {
    // Trying to detect the color of all players' life bars.
    const J1_PIXEL /* RGB */ = getPixelColor(
      video,
      118,
      games[0].mode == 1 ? 742 : 717
    );
    const J2_PIXEL /* RGB */ = getPixelColor(
      video,
      118,
      games[0].mode == 1 ? 825 : 806
    );
    const J3_PIXEL /* RGB */ = getPixelColor(
      video,
      118,
      games[0].mode == 1 ? 907 : 896
    );
    const J4_PIXEL /* RGB */ = getPixelColor(
      video,
      118,
      games[0].mode == 1 ? 991 : 985
    );
    const J5_PIXEL /* RGB */ = getPixelColor(
      video,
      1801,
      games[0].mode == 1 ? 742 : 717
    );
    const J6_PIXEL /* RGB */ = getPixelColor(
      video,
      1801,
      games[0].mode == 1 ? 825 : 806
    );
    const J7_PIXEL /* RGB */ = getPixelColor(
      video,
      1801,
      games[0].mode == 1 ? 907 : 896
    );
    const J8_PIXEL /* RGB */ = getPixelColor(
      video,
      1801,
      games[0].mode == 1 ? 991 : 985
    );
    if (
      //#region Orange team
      // Player 1
      (colorSimilarity(J1_PIXEL, new RGB(231, 123, 9)) ||
        colorSimilarity(J1_PIXEL, new RGB(0, 0, 0), 50)) &&
      // Player 2
      (colorSimilarity(J2_PIXEL, new RGB(231, 123, 9)) ||
        colorSimilarity(J2_PIXEL, new RGB(0, 0, 0), 50)) &&
      // Player 3
      (colorSimilarity(J3_PIXEL, new RGB(231, 123, 9)) ||
        colorSimilarity(J3_PIXEL, new RGB(0, 0, 0), 50)) &&
      //Joueur 4
      (colorSimilarity(J4_PIXEL, new RGB(231, 123, 9)) ||
        colorSimilarity(J4_PIXEL, new RGB(0, 0, 0), 50)) &&
      //#endregion
      //#region Blue team
      //Joueur 1
      (colorSimilarity(J5_PIXEL, new RGB(30, 126, 242)) ||
        colorSimilarity(J5_PIXEL, new RGB(0, 0, 0), 50)) &&
      // Player 2
      (colorSimilarity(J6_PIXEL, new RGB(30, 126, 242)) ||
        colorSimilarity(J6_PIXEL, new RGB(0, 0, 0), 50)) &&
      // Player 3
      (colorSimilarity(J7_PIXEL, new RGB(30, 126, 242)) ||
        colorSimilarity(J7_PIXEL, new RGB(0, 0, 0), 50)) &&
      // Player 4
      (colorSimilarity(J8_PIXEL, new RGB(30, 126, 242)) ||
        colorSimilarity(J8_PIXEL, new RGB(0, 0, 0), 50))
      //#endregion
    ) {
      console.log("Detect game playing frame");
      return true;
    }
    return false;
  }
  return false;
}

/**
 * This function attempts to find text present in a canvas at specific coordinates.
 * @param {*=HTMLVideoElement} video HTML DOM of the video element to be analyzed.
 * @param {*} tesseractWorker Tesseract instance.
 * @param {number} x1 X position of the top left corner of the rectangle to be analyzed.
 * @param {number} y1 Y position of the top left corner of the rectangle to be analyzed.
 * @param {number} x2 X position of the bottom right corner of the rectangle to be analyzed.
 * @param {number} y2 Y position of the bottom right corner of the rectangle to be analyzed.
 * @param {number} tesseditPagesegMode Page segmentation mode (how Tesseract divides the text to be recognized).
 * @param {number} imageModeIndex // Index of the transformation list to apply to the rectangle to make it more readable by OCR.
 * @param {number[]} imageModeOrder // Transformation list to apply to the rectangle to make it more readable by OCR.
 * @returns {Promise<string>} Text found by OCR.
 */
async function getTextFromImage(
  video,
  tesseractWorker,
  x1,
  y1,
  x2,
  y2,
  tesseditPagesegMode = 3,
  imageModeIndex = 0,
  imageModeOrder = [0, 1, 2]
) {
  if (video) {
    const CANVAS = document.createElement("canvas");
    const WIDTH /* number */ = x2 - x1;
    const HEIGHT /* number */ = y2 - y1;
    CANVAS.width = WIDTH;
    CANVAS.height = HEIGHT;
    const CTX = CANVAS.getContext("2d");
    if (CTX) {
      switch (imageModeOrder[imageModeIndex]) {
        case 1:
          CTX.filter = "grayscale(1) contrast(100) brightness(1)";
          break;
        case 2:
          CTX.filter = "grayscale(1) contrast(100) brightness(1) invert(1)";
          break;
      }
      CTX.drawImage(
        video /* Image */,
        x1 /* Image X */,
        y1 /* Image Y */,
        WIDTH /* Image width */,
        HEIGHT /* Image height */,
        0 /* Canvas X */,
        0 /* Canvas Y */,
        WIDTH /* Canvas width */,
        HEIGHT /* Canvas height */
      );
      const IMG = CANVAS.toDataURL("image/png");
      const DATA = await tesseractWorker.recognize(IMG, {
        tessedit_pageseg_mode: tesseditPagesegMode.toString(),
      });
      if (!DATA.data.text && imageModeIndex < imageModeOrder.length - 1) {
        return getTextFromImage(
          video,
          tesseractWorker,
          x1,
          y1,
          x2,
          y2,
          tesseditPagesegMode,
          imageModeIndex + 1,
          imageModeOrder
        );
      }
      return DATA.data.text.replace(/\r?\n|\r/, "");
    }
  }
  return Promise.resolve("");
}

//#region HMI

/**
 * This function displays the games to the user.
 * @param {Game[]} games List of games to display.
 * @param {string} videoPath Path of the analyzed video file.
 */
function showGamesOnHMI(games, videoPath) {
  const INPUT_FILE = document.getElementById("inputFile");
  const GAMES_PERCENT = document.getElementById("loader");
  const MESSAGE = document.getElementById("message");
  const RESULT = document.getElementById("result");
  const GAMES = RESULT.querySelector("table");

  RESULT.classList.remove("d-none");
  INPUT_FILE.classList.remove("d-none");
  MESSAGE.classList.add("d-none");
  GAMES_PERCENT.classList.add("d-none");

  const TBODY = document.createElement("tbody");
  GAMES.append(TBODY);

  games.forEach((game) => {
    const TR = document.createElement("tr");
    TBODY.append(TR);

    const MAP = document.createElement("th");
    MAP.innerText = game.map;
    MAP.style.backgroundImage = `url('https://evabattleplan.com/back/wp-content/uploads/${game.map
      .replaceAll(" ", "-")
      .toLowerCase()}-300x169.webp')`;
    TR.append(MAP);

    const TD = document.createElement("td");
    TD.classList.add("infos");
    TD.innerHTML = `<p class='orange'>${game.orangeTeam.name} (${game.orangeTeam.score})</p><p class='blue'>${game.blueTeam.name} (${game.blueTeam.score})</p>`;
    TR.append(TD);

    const BUTTONS = document.createElement("td");
    BUTTONS.classList.add("buttons");
    TR.append(BUTTONS);

    const BUTTONS_CONTAINER = document.createElement("div");
    BUTTONS.append(BUTTONS_CONTAINER);

    const BUTTON_1 = document.createElement("button");
    BUTTON_1.classList.add("squared");
    BUTTON_1.innerHTML = "<i class='fa-solid fa-floppy-disk'></i>";
    BUTTON_1.addEventListener("click", async function () {
      const FILE_PATH = await window.electronAPI.cutVideoFile(game, videoPath);
      const TOAST = Toastify({
        text: "Your video has been cut here: " + FILE_PATH,
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

    BUTTONS_CONTAINER.append(BUTTON_1);

    const BUTTON_2 = document.createElement("button");
    BUTTON_2.classList.add("squared");
    BUTTON_2.innerHTML = "<i class='fa-sharp fa-solid fa-cloud-arrow-up'></i>";
    BUTTON_2.setAttribute("disabled", "true");
    BUTTONS_CONTAINER.append(BUTTON_2);
  });
}

/**
 * This function updates the progress percentage of the analysis.
 * @param {number} value Percentage of progress.
 */
function setLoaderPercentOnHMI(value) {
  const GAMES_PERCENT = document.getElementById("loader");

  GAMES_PERCENT.classList.forEach((cls) => {
    if (cls.startsWith("t")) {
      GAMES_PERCENT.classList.remove(cls);
    }
  });
  GAMES_PERCENT.classList.add("t" + value);
}

/**
 * This function displays an error as a toast to the user.
 * @param {string} error Error text to display.
 */
function displayErrorOnHMI(error) {
  console.error(error);
  const TOAST = Toastify({
    text: error,
    duration: 5 * 1000,
    close: true,
    gravity: "bottom",
    position: "right",
    stopOnFocus: true,
    style: {
      background: "#F44336",
    },
    onClick: function () {
      TOAST.hideToast();
    },
  }).showToast();
}

//#endregion
