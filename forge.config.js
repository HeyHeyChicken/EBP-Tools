// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

const { FusesPlugin } = require("@electron-forge/plugin-fuses");
const { FuseV1Options, FuseVersion } = require("@electron/fuses");
const path = require("path");
const { execSync } = require("child_process");

module.exports = {
  packagerConfig: {
    asar: true,
    extraResource: [
      "./angular/dist/angular/browser/",
      "./electron/settings.json",
      "./electron/template.xlsx",
      "./binaries/ffmpeg/",
      "./binaries/yt-dlp/",
    ],
    icon: "electron/assets/icon",
    name: "EBP - EVA Battle Plan - Tools",
    osxSign: {
      identity: "Developer ID Application: Antoine Duval (5DQ59NSHNB)",
    },
    osxNotarize: {
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID,
      keychainProfile: "AC_PASSWORD",
    },
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
        name: "EBP-Tools",
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
  hooks: {
    async postPackage(config) {
      if (process.platform == "darwin") {
        console.log('Running "postPackage" hook on MacOS.');
        try {
          const FFMPEG_PATH = path.join(
            __dirname,
            "out",
            config.packagerConfig.name + "-darwin-arm64",
            config.packagerConfig.name + ".app",
            "Contents",
            "Resources",
            "ffmpeg",
            "darwin"
          );

          execSync(`chmod +x "${FFMPEG_PATH}"`);
          console.log("ffmpeg rendu exécutable");
        } catch (error) {
          console.error("Erreur lors du chmod de ffmpeg :", error);
        }
      }
    },
  },
};
