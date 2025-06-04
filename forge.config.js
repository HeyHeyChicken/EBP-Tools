const { FusesPlugin } = require("@electron-forge/plugin-fuses");
const { FuseV1Options, FuseVersion } = require("@electron/fuses");

module.exports = {
  packagerConfig: {
    asar: true,
    extraResource: ["./src/views/", "./src/static/", "./src/ffmpeg/"],
    icon: "assets/icon",
    name: "EBP - Replay Cutter",
  },
  rebuildConfig: {},
  makers: [
    {
      // Windows
      name: "@electron-forge/maker-squirrel",
      config: {
        setupIcon: "./assets/icon.ico",
        description: "EBP Replay Cutter Tool",
      },
    },
    {
      // ZIP
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
    },
    {
      // Linux (Debian/Ubuntu)
      name: "@electron-forge/maker-deb",
      config: {
        options: {
          icon: "./src/icon",
        },
      },
    },
    {
      // Linux (Fedora, etc.)
      name: "@electron-forge/maker-rpm",
      config: {},
    },
    {
      // MacOS
      name: "@electron-forge/maker-dmg",
      config: {
        format: "ULFO",
        icon: "assets/icon.icns",
        background: "assets/dmg-background.png",
        overwrite: true,
        window: {
          size: {
            width: 660,
            height: 400,
          },
        },
      },
    },
  ],
  plugins: [
    {
      name: "@electron-forge/plugin-auto-unpack-natives",
      config: {},
    },
    {
      name: "@electron-forge/plugin-webpack",
      config: {
        mainConfig: "./webpack.main.config.js",
        renderer: {
          config: "./webpack.renderer.config.js",
          entryPoints: [
            {
              html: "./src/views/index.html",
              js: "./src/static/script/client.js",
              name: "main_window",
              preload: {
                js: "./src/preload.js",
              },
            },
          ],
        },
      },
    },
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
