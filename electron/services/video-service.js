// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

const {
    FFMPEG_PATH,
    DEFAULT_VIDEO_WIDTH,
    DEFAULT_VIDEO_HEIGHT
} = require('../config/constants');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('node:path');
const { unlinkSync } = require('./global-service');

//#endregion

/**
 * Upscales a video to 1920x1080 resolution using FFmpeg with progress tracking.
 * Sends real-time progress updates to the main window.
 * @param inputPath Path to the source video file to upscale.
 * @param outputPath Path where the upscaled video will be saved.
 * @param percentCallback Function called when the upscaling process percent changed.
 */
function changeVideoResolution(
    inputPath /* string */,
    outputPath /* string */,
    width /* number */,
    height /* number */,
    percentCallback /* Function */
) {
    return new Promise((resolve, reject) => {
        if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
        }

        const FFMPEG_ARGS = [
            '-i',
            inputPath,
            '-vf',
            `scale=${width}:${height}:flags=lanczos`,
            '-c:v',
            'libx264',
            '-preset',
            'ultrafast',
            '-crf',
            '18',
            '-c:a',
            'copy',
            outputPath
        ];

        console.log(
            `[FFMPEG] Upscale - Executing: ${FFMPEG_PATH} ${FFMPEG_ARGS.join(' ')}`
        );

        const FFMPEG = spawn(FFMPEG_PATH, FFMPEG_ARGS);

        let duration = 0;

        // Retrieving duration + progress information
        FFMPEG.stderr.on('data', (data) => {
            const DATA = data.toString();

            // Log all ffmpeg output for debugging
            console.log(`[FFMPEG] Upscale - ${DATA.trim()}`);

            // Total duration
            const DURATION_MATCH = DATA.match(
                /Duration: (\d+):(\d+):(\d+\.\d+)/
            );
            if (DURATION_MATCH) {
                const HOURS = Number.parseInt(DURATION_MATCH[1]);
                const MINUTES = Number.parseInt(DURATION_MATCH[2]);
                const SECONDES = Number.parseFloat(DURATION_MATCH[3]);
                duration = HOURS * 3600 + MINUTES * 60 + SECONDES;
            }

            // Progress
            const TIME_MATCH = DATA.match(/time=(\d+):(\d+):(\d+\.\d+)/);
            if (TIME_MATCH && duration > 0) {
                const HOURS = Number.parseInt(TIME_MATCH[1]);
                const MINUTES = Number.parseInt(TIME_MATCH[2]);
                const SECONDES = Number.parseFloat(TIME_MATCH[3]);
                const CURRENT = HOURS * 3600 + MINUTES * 60 + SECONDES;

                const PERCENT = Math.ceil((CURRENT / duration) * 100);

                if (percentCallback) {
                    percentCallback(PERCENT);
                }
            }
        });

        FFMPEG.on('close', (code) => {
            if (code === 0) {
                resolve(outputPath);
            } else {
                reject(new Error(`FFmpeg process exited with code ${code}`));
            }
        });

        FFMPEG.on('error', (error) => {
            reject(error);
        });
    });
}

function removeBorders(inputPath, cropPosition) {
    return new Promise((resolve) => {
        const EXTENSION = inputPath.split('.').pop().toLowerCase();
        const VIDEO_DIR = path.dirname(inputPath);
        const VIDEO_NAME = path.basename(inputPath, `.${EXTENSION}`);
        const OUTPUT_FILE_PATH = path.join(
            VIDEO_DIR,
            `${VIDEO_NAME} - without borders.${EXTENSION}`
        );

        if (fs.existsSync(OUTPUT_FILE_PATH)) {
            unlinkSync(OUTPUT_FILE_PATH);
        }

        const FFMPEG_ARGS = [
            '-i',
            inputPath,
            '-vf',
            `crop=${cropPosition.x2 - cropPosition.x1}:${cropPosition.y2 - cropPosition.y1}:${cropPosition.x1}:${cropPosition.y1},scale=${DEFAULT_VIDEO_WIDTH}:${DEFAULT_VIDEO_HEIGHT},setsar=1`,
            '-r',
            '30',
            '-c:v',
            'libx264',
            '-preset',
            'ultrafast',
            OUTPUT_FILE_PATH
        ];

        console.log(
            `[FFMPEG] Remove borders - Executing: ${FFMPEG_PATH} ${FFMPEG_ARGS.join(' ')}`
        );

        const FFMPEG = spawn(FFMPEG_PATH, FFMPEG_ARGS);

        let duration = 0;

        // Retrieving duration + progress information
        FFMPEG.stderr.on('data', (data) => {
            const DATA = data.toString();

            // Log all ffmpeg output for debugging
            console.log(`[FFMPEG] Remove borders - ${DATA.trim()}`);

            // Total duration
            const DURATION_MATCH = DATA.match(
                /Duration: (\d+):(\d+):(\d+\.\d+)/
            );
            if (DURATION_MATCH) {
                const HOURS = Number.parseInt(DURATION_MATCH[1]);
                const MINUTES = Number.parseInt(DURATION_MATCH[2]);
                const SECONDES = parseFloat(DURATION_MATCH[3]);
                duration = HOURS * 3600 + MINUTES * 60 + SECONDES;
            }

            // Progress
            const TIME_MATCH = DATA.match(/time=(\d+):(\d+):(\d+\.\d+)/);
            if (TIME_MATCH && duration > 0) {
                const HOURS = Number.parseInt(TIME_MATCH[1]);
                const MINUTES = Number.parseInt(TIME_MATCH[2]);
                const SECONDES = parseFloat(TIME_MATCH[3]);
                const CURRENT = HOURS * 3600 + MINUTES * 60 + SECONDES;

                const PERCENT = Math.ceil((CURRENT / duration) * 100);

                const { getMainWindow } = require('../core/window-manager');
                getMainWindow().webContents.send(
                    'set-remove-borders-percent',
                    PERCENT
                );
            }
        });

        FFMPEG.on('close', (code) => {
            resolve(OUTPUT_FILE_PATH);
        });
    });
}

function fixForBrowser(videoPath) {
    return new Promise((resolve, reject) => {
        const EXTENSION = videoPath.split('.').pop().toLowerCase();
        const VIDEO_DIR = path.dirname(videoPath);
        const TEMP_OUTPUT_PATH = path.join(
            VIDEO_DIR,
            `output_${Date.now()}.${EXTENSION}`
        );

        const FFMPEG_ARGS = [
            '-i',
            videoPath,
            '-c',
            'copy',
            '-movflags',
            'faststart',
            TEMP_OUTPUT_PATH
        ];

        console.log(
            `[FFMPEG] Fix for browser - Executing: ${FFMPEG_PATH} ${FFMPEG_ARGS.join(' ')}`
        );

        const FFMPEG = spawn(FFMPEG_PATH, FFMPEG_ARGS);

        FFMPEG.on('close', (code) => {
            if (code === 0 && fs.existsSync(TEMP_OUTPUT_PATH)) {
                unlinkSync(videoPath);
                fs.renameSync(TEMP_OUTPUT_PATH, videoPath);
                resolve(videoPath);
            } else {
                if (fs.existsSync(TEMP_OUTPUT_PATH)) {
                    unlinkSync(TEMP_OUTPUT_PATH);
                }
                reject(new Error(`FFmpeg process exited with code ${code}`));
            }
        });
    });
}

/**
 * Probes the video codec of a file by spawning ffmpeg and parsing its stderr.
 * Cheap (no decoding); returns the codec short name (e.g. "h264", "hevc")
 * lowercased, or null if unknown.
 */
function probeVideoCodec(inputPath) {
    return new Promise((resolve) => {
        const FFMPEG = spawn(FFMPEG_PATH, [
            '-hide_banner',
            '-i',
            inputPath
        ]);
        let stderr = '';
        FFMPEG.stderr.on('data', (d) => {
            stderr += d.toString();
        });
        FFMPEG.on('close', () => {
            const M = stderr.match(/Stream #\d+:\d+[^\n]*Video:\s+(\w+)/);
            resolve(M ? M[1].toLowerCase() : null);
        });
        FFMPEG.on('error', () => resolve(null));
    });
}

/**
 * Cuts a video segment, stream-copying the video track if it's already H.264
 * (the common case for game capture tools) and re-encoding to libx264
 * otherwise. Audio is always re-encoded to AAC (MP4 doesn't officially
 * support Opus). Faststart for browser streaming. With stream-copy the cut
 * lands at the nearest keyframe before `startSec`, so the actual start may
 * be a few seconds earlier than requested — acceptable for replay gameplay.
 * @param {string} inputPath  Source video.
 * @param {string} outputPath Destination .mp4.
 * @param {number} startSec   Inclusive start time (seconds).
 * @param {number} endSec     Exclusive end time (seconds).
 * @returns {Promise<string>} Resolves with outputPath on success.
 */
async function cutAndEncodeGame(inputPath, outputPath, startSec, endSec) {
    if (fs.existsSync(outputPath)) {
        unlinkSync(outputPath);
    }

    const VIDEO_CODEC = await probeVideoCodec(inputPath);
    const STREAM_COPY = VIDEO_CODEC === 'h264';
    console.log(
        `[FFMPEG] Cut+encode - source video codec=${VIDEO_CODEC ?? 'unknown'}, ${STREAM_COPY ? 'stream-copy' : 'libx264 re-encode'}`
    );

    const VIDEO_ARGS = STREAM_COPY
        ? ['-c:v', 'copy']
        : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '23'];

    return new Promise((resolve, reject) => {
        const FFMPEG_ARGS = [
            '-ss',
            String(startSec),
            '-to',
            String(endSec),
            '-i',
            inputPath,
            ...VIDEO_ARGS,
            '-c:a',
            'aac',
            '-b:a',
            '128k',
            '-movflags',
            '+faststart',
            outputPath
        ];

        console.log(
            `[FFMPEG] Cut+encode - Executing: ${FFMPEG_PATH} ${FFMPEG_ARGS.join(' ')}`
        );

        const FFMPEG = spawn(FFMPEG_PATH, FFMPEG_ARGS);

        FFMPEG.stderr.on('data', (data) => {
            console.log(`[FFMPEG] Cut+encode - ${data.toString().trim()}`);
        });

        FFMPEG.on('close', (code) => {
            if (code === 0 && fs.existsSync(outputPath)) {
                resolve(outputPath);
            } else {
                if (fs.existsSync(outputPath)) {
                    unlinkSync(outputPath);
                }
                reject(new Error(`FFmpeg process exited with code ${code}`));
            }
        });

        FFMPEG.on('error', (err) => reject(err));
    });
}

module.exports = {
    changeVideoResolution,
    removeBorders,
    fixForBrowser,
    cutAndEncodeGame
};
