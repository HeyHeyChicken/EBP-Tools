const { FusesPlugin } = require("@electron-forge/plugin-fuses");
const { FuseV1Options, FuseVersion } = require("@electron/fuses");

module.exports = {
  packagerConfig: {
    asar: true,
    extraResource: ["./angular/dist/angular/browser/", "./ffmpeg/", "./electron/settings.json"],
    icon: "electron/assets/icon",
    name: "EBP - EVA Battle Plan - Tools",
  },
  rebuildConfig: {},
  makers: [
    {
      // Windows
      name: "@electron-forge/maker-squirrel",
      config: {
        setupIcon: "./electron/assets/icon.ico",
        description: "EBP - EVA Battle Plan - Tools",
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
          icon: "./electron/icon",
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
        icon: "electron/assets/icon.icns",
        background: "electron/assets/dmg-background.png",
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
              html: "./angular/dist/angular/browser/index.html",
              js: "./angular/dist/angular/browser/main.js",
              name: "main_window",
              preload: {
                js: "./electron/preload.js",
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
