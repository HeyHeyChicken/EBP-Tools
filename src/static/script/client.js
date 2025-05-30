// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

const LOGIN_BUTTON = document.getElementById("loginURL");
const INPUT_FILE = document.getElementById("inputFile");
const GAMES_PERCENT = document.getElementById("loader");
const GAMES_COUNTER = document.getElementById("nbGames");
const GAMES = document.getElementById("games");
const MESSAGE = document.getElementById("message");
const FOOTER = document.querySelector("footer");
let userID = 0;

function setLoaderPercent(value) {
  GAMES_PERCENT.classList.forEach((cls) => {
    if (cls.startsWith("t")) {
      GAMES_PERCENT.classList.remove(cls);
    }
  });
  GAMES_PERCENT.classList.add("t" + value);
}

window.electronAPI.log((value) => {
  console.log(value);
});

window.electronAPI.error((error) => {
  console.error(error);
});

// Le serveur envoie l'état de la recherche de games.
// On met à jour l'IHM en conséquence.
window.electronAPI.workingNbGames((value) => {
  GAMES_COUNTER.innerText = value;
});

window.electronAPI.workingPercent((value) => {
  setLoaderPercent(value);
});

window.electronAPI.games((games) => {
  MESSAGE.classList.add("d-none");
  INPUT_FILE.classList.remove("d-none");
  GAMES_PERCENT.classList.add("d-none");

  const TBODY = document.createElement("tbody");
  GAMES.append(TBODY);

  const NOW = new Date().getTime();

  games.forEach((game) => {
    const TR = document.createElement("tr");
    TBODY.append(TR);

    const MAP = document.createElement("th");
    MAP.innerText = game.map;
    MAP.style.backgroundImage = `url('https://evabattleplan.com/back/wp-content/uploads/${game.map
      .replaceAll(" ", "-")
      .toLowerCase()}-300x169.jpg')`;
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
      const FILE_PATH = await window.electronAPI.cutVideoFile(game, NOW);
      const TOAST = Toastify({
        text: "Your video has been cut here: " + FILE_PATH,
        duration: 300000,
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
});

// On récupère la version de l'application.
window.electronAPI.getVersion().then((version) => {
  FOOTER.innerText = "v" + version;
});

// On récupère le port du serveur Express.
window.electronAPI.getExpressPort().then((express_port) => {
  LOGIN_BUTTON.setAttribute(
    "href",
    `https://evabattleplan.com/en/login?redirect_uri=http://127.0.0.1:${express_port}&app=cutter`
  );
});

// On récupère l'état de connexion à EBP de l'utilisateur.
window.electronAPI.getLoginState().then((login_state) => {
  const TARGET = document.getElementById(
    (login_state ? "" : "dis") + "connected"
  );
  if (TARGET) {
    TARGET.style.display = "block";
  }
});

// Lorsque l'utilisateur clique sur le bouton de connection, on le verouille pour éviter le spam.
LOGIN_BUTTON.addEventListener("click", function () {
  this.firstChild.disabled = true;
});

INPUT_FILE.addEventListener("click", async function () {
  GAMES.innerHTML = "";
  GAMES_COUNTER.innerText = "0";
  INPUT_FILE.disabled = true;
  const filePath = await window.electronAPI.openVideoFile();
  INPUT_FILE.disabled = false;
  if (filePath) {
    setLoaderPercent(0);
    GAMES_PERCENT.classList.remove("d-none");
    INPUT_FILE.classList.add("d-none");
    MESSAGE.classList.remove("d-none");
    // Utilise le chemin du fichier ici
  } else {
    console.log("Aucun fichier sélectionné");
  }
});
