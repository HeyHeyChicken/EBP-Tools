# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

EBP - EVA Battle Plan - Tools is an Electron application with an Angular frontend that provides tooling for EVA (eva.gg) players. The application offers:

1. Auto-cutting game replays
2. YouTube timecode generation for replays
3. EVA game history export to Excel
4. Replay downloading from YouTube and Twitch

## Architecture

This is a hybrid Electron + Angular application with the following structure:

- **Frontend**: Angular 20 application in `/angular/` directory
- **Backend**: Electron main process in `/electron/` directory
- **Communication**: Express server running on random port for Angular-Electron communication
- **Build System**: Electron Forge with Webpack for packaging and distribution

### Key Directories

- `angular/src/app/views/` - Main application views (home, replay_cutter, game_history, replay_downloader)
- `angular/src/app/core/services/` - Angular services including API communication and global state
- `electron/` - Electron main process, preload scripts, and assets
- `binaries/` - External binaries (ffmpeg, yt-dlp) bundled with the app

## Development Commands

### Initial Setup
```bash
npm run install_npm  # Install dependencies for both root and Angular
```

### Development
```bash
npm start  # Start development server (Angular dev server + Electron)
```

### Building
```bash
npm run make  # Build Angular app and create Electron distribution
```

### Code Quality
```bash
npm run lint        # Run ESLint on Angular TypeScript files
npm run lint:fix    # Fix ESLint issues and format with Prettier
```

### Testing
```bash
npm test  # Run Jest tests (in angular/ directory)
```

## Code Style and Conventions

- **Language**: TypeScript throughout
- **Linting**: ESLint with TypeScript support, semicolons required
- **Formatting**: Prettier for code formatting
- **Testing**: Jest with jest-preset-angular
- **Imports**: Organized with `//#region Imports` comments
- **Copyright**: All files include copyright header for Antoine Duval

### Angular-Specific
- Uses Angular 20 with standalone components
- Material Design components via Angular Material
- Internationalization with ngx-translate
- Toast notifications via ngx-toastr
- Image processing with ngx-image-cropper and Tesseract.js for OCR

### Electron-Specific
- Express server on random port for frontend communication
- Puppeteer for web scraping functionality
- ExcelJS for spreadsheet generation
- Discord RPC integration for rich presence

## Important Implementation Notes

- **Electron Forge Configuration**: The `forge.config.js` handles multi-platform builds (Windows, macOS, Linux) with proper code signing for macOS
- **Resource Bundling**: External binaries and assets are bundled via `extraResource` in forge config
- **Communication Pattern**: Angular frontend communicates with Electron main process via Express server
- **Platform-Specific Logic**: Handles macOS executable permissions in post-package hook

## Service Architecture

The Angular application uses a service-based architecture:

- `GlobalService` - Application-wide state and configuration
- `ApiRestService` - HTTP communication with Electron backend
- `IdentityService` - User identification and beta user management
- `OpenCvService` - Computer vision functionality

## Build Pipeline

1. Angular build creates distribution in `angular/dist/`
2. Electron Forge packages the app with bundled resources
3. Platform-specific installers are generated (DMG for macOS, Squirrel for Windows, DEB/RPM for Linux)
4. macOS builds include code signing and notarization