// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { Injectable } from '@angular/core';
import { Game } from '../models/game';
import { RGB } from '../models/rgb';
import { MODES } from '../models/mode';
import { PSM } from 'tesseract.js';
import { Map } from '../models/map';

//#endregion

@Injectable({
  providedIn: 'root'
})
export class ReplayCutterService {
  //#region Attributes

  public videoPath: string | undefined;
  public game: Game | undefined;

  protected percent: number = -1;

  private static maps: Map[] = [
    new Map('Artefact', ['artefact'], [4, 1, 6, 1], [38, 18, 390, 223]), // v
    new Map('Atlantis', ['atlantis'], [3, 2, 3, 2], [13, 21, 433, 228]), // v
    new Map('Ceres', ['ceres'], [3, 2, 3, 2], [20, 25, 420, 212]), // v
    new Map('Engine', ['engine'], [3, 2, 3, 2], [6, 12, 442, 225]), // v
    new Map(
      'Helios Station',
      ['helios', 'station'],
      [3, 2, 3, 2],
      [14, 23, 432, 217]
    ),
    new Map(
      'Lunar Outpost',
      ['lunar', 'outpost'],
      [3, 2, 3, 2],
      [18, 38, 593, 301]
    ),
    new Map('Outlaw', ['outlaw', 'qutlaw'], [3, 5, 5, 3], [4, 5, 269, 270]),
    new Map('Polaris', ['polaris'], [3, 2, 3, 2], [16, 18, 428, 237]), // v
    new Map('Silva', ['silva'], [3, 2, 3, 2], [29, 18, 310, 237]), // v
    new Map('The Cliff', ['cliff'], [3, 3, 3, 3]), // v
    new Map('The Rock', ['rock'], [3, 2, 3, 2], [14, 22, 432, 217]),
    new Map('Horizon', ['horizon'], [3, 2, 3, 2], [19, 29, 327, 209]) // v
  ];

  //#endregion

  //#region Functions

  /**
   * Captures a frame from a video URL at a specified time and converts it to a canvas element.
   * Performs a basic check to avoid black frames by retrying if the average color is too dark.
   * @param url The URL of the video.
   * @param timeMs The time in milliseconds at which to capture the frame.
   * @param callback Function called with the resulting canvas or undefined if capture fails.
   */
  public static videoURLToCanvas(
    url: string,
    timeMs: number,
    callback: (video?: HTMLCanvasElement) => void
  ): void {
    const VIDEO = document.createElement('video');
    VIDEO.crossOrigin = 'anonymous';
    VIDEO.muted = true;
    VIDEO.preload = 'auto';

    VIDEO.addEventListener('loadedmetadata', () => {
      const TIME_SECONDS = timeMs / 1000;
      if (TIME_SECONDS > VIDEO.duration) {
        callback(undefined);
        return;
      }
      VIDEO.currentTime = TIME_SECONDS;
    });

    VIDEO.addEventListener('seeked', () => {
      const CANVAS = document.createElement('canvas');
      CANVAS.width = VIDEO.videoWidth;
      CANVAS.height = VIDEO.videoHeight;
      const CTX = CANVAS.getContext('2d');

      if (CTX) {
        CTX.drawImage(VIDEO, 0, 0, CANVAS.width, CANVAS.height);
        const IMAGE_DATA = CTX.getImageData(
          0,
          0,
          CANVAS.width,
          CANVAS.height
        ).data;

        let red = 0,
          green = 0,
          blue = 0;
        const pixelCount = CANVAS.width * CANVAS.height;

        for (let i = 0; i < IMAGE_DATA.length; i += 4) {
          red += IMAGE_DATA[i];
          green += IMAGE_DATA[i + 1];
          blue += IMAGE_DATA[i + 2];
        }

        red = Math.round(red / pixelCount);
        green = Math.round(green / pixelCount);
        blue = Math.round(blue / pixelCount);

        console.log(
          `videoURLToCanvas, red: ${red}, green: ${green}, blue: ${blue}, canvas width: ${CANVAS.width}, canvas height: ${CANVAS.height}.`
        );

        // DEBUG
        const DEBUG_CONTAINER = document.getElementById('debug');
        if (DEBUG_CONTAINER) {
          DEBUG_CONTAINER.append(CANVAS);
        }

        if (red < 20 && green < 20 && blue < 20) {
          console.warn(
            'Error "videoURLToCanvas", the image is too dark, retrying...'
          );
          ReplayCutterService.videoURLToCanvas(url, timeMs + 1000, callback);
        } else {
          callback(ReplayCutterService.videoToCanvas(VIDEO));
        }
      }
    });

    VIDEO.addEventListener('error', () => {
      callback(undefined);
    });

    VIDEO.src = url;
  }

  /**
   * Converts a canvas image source to an HTMLCanvasElement by drawing it onto a new canvas.
   * The resulting canvas will have the same dimensions as the source.
   * @param source The image source to convert (video, image, or canvas).
   * @returns A new HTMLCanvasElement containing the rendered source.
   */
  public static videoToCanvas(source: CanvasImageSource): HTMLCanvasElement {
    const CANVAS = document.createElement('canvas');
    const SIZE = ReplayCutterService.getSourceSize(source);
    CANVAS.width = SIZE.width;
    CANVAS.height = SIZE.height;
    const CTX = CANVAS.getContext('2d');
    if (CTX) {
      CTX.drawImage(source, 0, 0, CANVAS.width, CANVAS.height);
    }
    return CANVAS;
  }

  /**
   * Gets the actual dimensions (width and height) of a canvas image source.
   * Handles different types of image sources (HTMLVideoElement, HTMLImageElement, HTMLCanvasElement, OffscreenCanvas).
   * @param src The canvas image source to get dimensions from.
   * @returns An object containing the width and height of the source.
   * @throws Error if the source type is not supported.
   */
  public static getSourceSize(src: CanvasImageSource): {
    width: number;
    height: number;
  } {
    if (src instanceof HTMLVideoElement)
      return {
        width: src.videoWidth,
        height: src.videoHeight
      };
    if (src instanceof HTMLImageElement)
      return {
        width: src.width,
        height: src.height
      };
    if (src instanceof HTMLCanvasElement)
      return {
        width: src.width,
        height: src.height
      };
    if (src instanceof OffscreenCanvas)
      return {
        width: src.width,
        height: src.height
      };
    throw new Error('Type non géré');
  }

  /**
   * This function allows you to define if two colors are similar.
   * @param color1 Couleur 1.
   * @param color2 Couleur 2.
   * @param maxDifference Tolerance.
   * @returns Are the colors similar?
   */
  public static colorSimilarity(
    color1: RGB,
    color2: RGB,
    maxDifference: number = 20
  ): boolean {
    return (
      Math.abs(color1.r - color2.r) <= maxDifference &&
      Math.abs(color1.g - color2.g) <= maxDifference &&
      Math.abs(color1.b - color2.b) <= maxDifference
    );
  }

  /**
   * Captures all pixel data from a frame into a reusable buffer.
   * @param source The image source to capture.
   * @returns An object with the raw RGBA data and frame width, or undefined if capture fails.
   */
  public static captureFrameData(
    source: CanvasImageSource
  ): { data: Uint8ClampedArray; width: number } | undefined {
    const SIZE = ReplayCutterService.getSourceSize(source);
    const CANVAS = document.createElement('canvas');
    CANVAS.width = SIZE.width;
    CANVAS.height = SIZE.height;
    const CTX = CANVAS.getContext('2d');
    if (CTX) {
      CTX.drawImage(source, 0, 0, SIZE.width, SIZE.height);
      return {
        data: CTX.getImageData(0, 0, SIZE.width, SIZE.height).data,
        width: SIZE.width
      };
    }
    return undefined;
  }

  /**
   * Returns the RGB color of a pixel from pre-captured frame data.
   * @param frameData Frame data captured with captureFrameData.
   * @param x X coordinate of the pixel.
   * @param y Y coordinate of the pixel.
   * @returns RGB color of the pixel.
   */
  public static getPixelColorFromData(
    frameData: { data: Uint8ClampedArray; width: number },
    x: number,
    y: number
  ): RGB {
    const INDEX = (Math.round(y) * frameData.width + Math.round(x)) * 4;
    return new RGB(
      frameData.data[INDEX],
      frameData.data[INDEX + 1],
      frameData.data[INDEX + 2]
    );
  }

  /**
   * This function detects the end of a game via the score display.
   * @param video HTML DOM of the video element to be analyzed.
   * @returns Is the current frame a game score frame?
   */
  public static detectGameScoreFrame(frameData: {
    data: Uint8ClampedArray;
    width: number;
  }): number {
    for (let i = 0; i < MODES.length; i++) {
      if (
        /* Orange logo */
        ReplayCutterService.colorSimilarity(
          ReplayCutterService.getPixelColorFromData(
            frameData,
            MODES[i].scoreFrame.orangeLogo.x,
            MODES[i].scoreFrame.orangeLogo.y
          ),
          new RGB(239, 203, 14)
        ) &&
        /* Blue logo */
        ReplayCutterService.colorSimilarity(
          ReplayCutterService.getPixelColorFromData(
            frameData,
            MODES[i].scoreFrame.blueLogo.x,
            MODES[i].scoreFrame.blueLogo.y
          ),
          new RGB(50, 138, 230)
        )
      ) {
        console.log(`Game score frame detected (mode ${i + 1})`);
        return i;
      }
    }
    return -1;
  }

  /**
   * Crops a rectangular region from a given image or canvas and returns it as a new canvas.
   * @param source The source image or canvas to crop from.
   * @param x1 The starting X coordinate of the crop area.
   * @param y1 The starting Y coordinate of the crop area.
   * @param x2 The ending X coordinate of the crop area.
   * @param y2 The ending Y coordinate of the crop area.
   * @returns A new canvas containing the cropped image, or undefined if the context could not be created.
   */
  public static cropImage(
    source: CanvasImageSource,
    x1: number,
    y1: number,
    x2: number,
    y2: number
  ): HTMLCanvasElement | undefined {
    const CANVAS: HTMLCanvasElement = document.createElement('canvas');
    const WIDTH: number = x2 - x1;
    const HEIGHT: number = y2 - y1;

    CANVAS.width = WIDTH;
    CANVAS.height = HEIGHT;

    const CTX = CANVAS.getContext('2d');
    if (CTX) {
      CTX.drawImage(
        source /* Image */,
        x1 /* Image X */,
        y1 /* Image Y */,
        WIDTH /* Image width */,
        HEIGHT /* Image height */,
        0 /* Canvas X */,
        0 /* Canvas Y */,
        WIDTH /* Canvas width */,
        HEIGHT /* Canvas height */
      );

      return CANVAS;
    }

    return undefined;
  }

  /**
   * This function returns a black and white canvas from a canvas ctx passed as a parameter.
   * @param ctx Canvas ctx to copy.
   * @param luminance Boundary luminance between white and black.
   * @returns Transformed canvas.
   */
  public static setCanvasBlackAndWhite(
    ctx: CanvasRenderingContext2D,
    luminance: number
  ): HTMLCanvasElement {
    const CANVAS = document.createElement('canvas');
    CANVAS.width = ctx.canvas.width;
    CANVAS.height = ctx.canvas.height;
    const CTX = CANVAS.getContext('2d');
    if (CTX) {
      const IMAGE_DATA = ctx.getImageData(
        0,
        0,
        ctx.canvas.width,
        ctx.canvas.height
      );
      const DATA = IMAGE_DATA.data;

      for (let i = 0; i < DATA.length; i += 4) {
        const RED = DATA[i];
        const GREEN = DATA[i + 1];
        const BLUE = DATA[i + 2];

        // Simple luminance
        const PIXEL_LUMINANCE = 0.299 * RED + 0.587 * GREEN + 0.114 * BLUE;

        // Threshold to adjust (200 = light, therefore white; the rest becomes black)
        const VALUE = PIXEL_LUMINANCE > luminance ? 255 : 0;

        DATA[i] = VALUE; // Red
        DATA[i + 1] = VALUE; // Green
        DATA[i + 2] = VALUE; // Blue
      }

      CTX.putImageData(IMAGE_DATA, 0, 0);
    }
    return CANVAS;
  }

  /**
   * This function attempts to find text present in a canvas at specific coordinates.
   * @param source HTML DOM of the video element to be analyzed.
   * @param tesseractWorker Tesseract instance.
   * @param x1 X position of the top left corner of the rectangle to be analyzed.
   * @param y1 Y position of the top left corner of the rectangle to be analyzed.
   * @param x2 X position of the bottom right corner of the rectangle to be analyzed.
   * @param y2 Y position of the bottom right corner of the rectangle to be analyzed.
   * @param tesseditPagesegMode Page segmentation mode (how Tesseract divides the text to be recognized).
   * @param luminance // If the translation is not always reliable, the image will be analyzed once more, in black and white, split by the luminance passed as a parameter.
   * @param filter // ???
   * @param disableInitialScan // ???
   * @param checker // Function to verify the value found by Tesseract.
   * @returns Text found by OCR.
   */
  public static async getTextFromImage(
    source: CanvasImageSource,
    tesseractWorker: Tesseract.Worker,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    tesseditPagesegMode: number = 3,
    luminance?: number,
    filter: boolean = false,
    disableInitialScan: boolean = false,
    checker?: Function
  ): Promise<string> {
    const CANVAS = ReplayCutterService.cropImage(source, x1, y1, x2, y2);
    if (CANVAS) {
      const CTX = CANVAS.getContext('2d');
      if (CTX) {
        const IMG = CANVAS.toDataURL('image/png');

        // On scan sans transformations.
        await tesseractWorker.setParameters({
          tessedit_pageseg_mode: tesseditPagesegMode.toString() as PSM
        });
        const TESSERACT_VALUES: string[] = [];

        if (!disableInitialScan) {
          TESSERACT_VALUES.push(
            (await tesseractWorker.recognize(IMG)).data.text.replace(
              /\r?\n|\r/,
              ''
            )
          );
        }

        // We scan with luminence if it is activated.
        if (luminance) {
          const CORRECTED_CANVAS = ReplayCutterService.setCanvasBlackAndWhite(
            CTX,
            luminance
          );
          const IMG_STRING = CORRECTED_CANVAS.toDataURL('image/png');
          TESSERACT_VALUES.push(
            (await tesseractWorker.recognize(IMG_STRING)).data.text.replace(
              /\r?\n|\r/,
              ''
            )
          );
        }

        // We scan with filter if it is activated.
        if (filter) {
          const FILTER1_CANVAS = document.createElement('canvas');
          FILTER1_CANVAS.width = CANVAS.width;
          FILTER1_CANVAS.height = CANVAS.height;
          const FILTER1_CTX = FILTER1_CANVAS.getContext('2d');
          if (FILTER1_CTX) {
            FILTER1_CTX.filter = 'invert(1) contrast(200%) brightness(150%)';
            FILTER1_CTX.drawImage(
              CANVAS /* Image */,
              0 /* Image X */,
              0 /* Image Y */,
              CANVAS.width /* Image width */,
              CANVAS.height /* Image height */
            );

            const IMG_STRING = FILTER1_CANVAS.toDataURL('image/png');
            TESSERACT_VALUES.push(
              (await tesseractWorker.recognize(IMG_STRING)).data.text.replace(
                /\r?\n|\r/,
                ''
              )
            );
          }

          const FILTER2_CANVAS = document.createElement('canvas');
          FILTER2_CANVAS.width = CANVAS.width;
          FILTER2_CANVAS.height = CANVAS.height;
          const FILTER2_CTX = FILTER2_CANVAS.getContext('2d');
          if (FILTER2_CTX) {
            FILTER2_CTX.filter = 'grayscale(1) contrast(300%) brightness(150%)';
            FILTER2_CTX.drawImage(
              CANVAS /* Image */,
              0 /* Image X */,
              0 /* Image Y */,
              CANVAS.width /* Image width */,
              CANVAS.height /* Image height */
            );

            const IMG_STRING = FILTER2_CANVAS.toDataURL('image/png');
            TESSERACT_VALUES.push(
              (await tesseractWorker.recognize(IMG_STRING)).data.text.replace(
                /\r?\n|\r/,
                ''
              )
            );
          }

          const FILTER3_CANVAS = document.createElement('canvas');
          FILTER3_CANVAS.width = CANVAS.width;
          FILTER3_CANVAS.height = CANVAS.height;
          const FILTER3_CTX = FILTER3_CANVAS.getContext('2d');
          if (FILTER3_CTX) {
            CTX.filter = 'grayscale(1) contrast(100) brightness(1) invert(1)';
            FILTER3_CTX.drawImage(
              CANVAS /* Image */,
              0 /* Image X */,
              0 /* Image Y */,
              CANVAS.width /* Image width */,
              CANVAS.height /* Image height */
            );

            const IMG_STRING = FILTER3_CANVAS.toDataURL('image/png');
            TESSERACT_VALUES.push(
              (await tesseractWorker.recognize(IMG_STRING)).data.text.replace(
                /\r?\n|\r/,
                ''
              )
            );
          }
        }

        if (checker) {
          for (let i = 0; i < TESSERACT_VALUES.length; i++) {
            TESSERACT_VALUES[i] = checker(TESSERACT_VALUES[i]);
          }
        }

        const RESULT = ReplayCutterService.arrayMostFrequent(
          TESSERACT_VALUES.filter((x) => x != '')
        );

        return RESULT ?? '';
      }
    }
    return Promise.resolve('');
  }

  /**
   * This function returns the most common value in a list.
   * @param arr List of where to find the most present value.
   * @returns Most present value in the list.
   */
  public static arrayMostFrequent(arr: string[]): string | null {
    if (arr.length === 0) return null;

    const FREQUENCY: Record<string, number> = {};

    // Counting occurrences
    for (const VALUE of arr) {
      FREQUENCY[VALUE] = (FREQUENCY[VALUE] || 0) + 1;
    }

    let maxCount = 0;
    let mostCommon: string = arr[0];

    // Route in table order to respect "first in case of a tie".
    for (const VALUE of arr) {
      if (FREQUENCY[VALUE] > maxCount) {
        maxCount = FREQUENCY[VALUE];
        mostCommon = VALUE;
      }
    }

    return mostCommon;
  }

  /**
   * This function ensures that the value passed as a parameter (coming from Tesseract) corresponds to a score.
   * @param value Value found by tesseract.
   * @returns Corrected value.
   */
  public static scoreChecker(value: string): string {
    let score = Number.parseInt(value.slice(0, 3));
    if (!Number.isNaN(score)) {
      score = Math.max(score, 0);
      score = Math.min(score, 100);
      return score.toString();
    }
    return '0';
  }

  /**
   * Detects whether the current video frame corresponds to the end of a game.
   * Checks specific pixel colors in the frame to identify the presence of team logos indicating game conclusion.
   * @param video The video element to analyze.
   * @returns True if the end-of-game frame is detected, otherwise false.
   */
  public static detectGameEndFrame(frameData: {
    data: Uint8ClampedArray;
    width: number;
  }): boolean {
    if (
      /* Orange logo */
      ReplayCutterService.colorSimilarity(
        ReplayCutterService.getPixelColorFromData(frameData, 387, 417),
        new RGB(251, 209, 0)
      ) &&
      ReplayCutterService.colorSimilarity(
        ReplayCutterService.getPixelColorFromData(frameData, 481, 472),
        new RGB(252, 205, 4)
      ) &&
      /* Blue logo */
      ReplayCutterService.colorSimilarity(
        ReplayCutterService.getPixelColorFromData(frameData, 1498, 437),
        new RGB(46, 144, 242)
      ) &&
      ReplayCutterService.colorSimilarity(
        ReplayCutterService.getPixelColorFromData(frameData, 1630, 486),
        new RGB(46, 136, 226)
      )
    ) {
      console.log('Game end frame detected.');
      return true;
    }
    return false;
  }

  /**
   * This function detects the start of a game via the display of the EVA loader.
   * @param video HTML DOM of the video element to be analyzed.
   * @param games List of games already detected.
   * @returns Is the current frame a game loading frame?
   */
  public static detectGameLoadingFrame(
    frameData: { data: Uint8ClampedArray; width: number },
    games: Game[]
  ): boolean {
    if (games.length > 0 && games[0].end != -1 && games[0].start == -1) {
      for (
        let index: number = 0;
        index < MODES[games[0].mode].loadingFrames.length;
        index++
      ) {
        if (
          /* Logo top */ ReplayCutterService.colorSimilarity(
            ReplayCutterService.getPixelColorFromData(
              frameData,
              MODES[games[0].mode].loadingFrames[index].logoTop.x,
              MODES[games[0].mode].loadingFrames[index].logoTop.y
            ),
            new RGB(255, 255, 255)
          ) &&
          /* Logo left */ ReplayCutterService.colorSimilarity(
            ReplayCutterService.getPixelColorFromData(
              frameData,
              MODES[games[0].mode].loadingFrames[index].logoLeft.x,
              MODES[games[0].mode].loadingFrames[index].logoLeft.y
            ),
            new RGB(255, 255, 255)
          ) &&
          /* Logo right */ ReplayCutterService.colorSimilarity(
            ReplayCutterService.getPixelColorFromData(
              frameData,
              MODES[games[0].mode].loadingFrames[index].logoRight.x,
              MODES[games[0].mode].loadingFrames[index].logoRight.y
            ),
            new RGB(255, 255, 255)
          ) &&
          /* Logo middle */ ReplayCutterService.colorSimilarity(
            ReplayCutterService.getPixelColorFromData(
              frameData,
              MODES[games[0].mode].loadingFrames[index].logoMiddle.x,
              MODES[games[0].mode].loadingFrames[index].logoMiddle.y
            ),
            new RGB(255, 255, 255)
          ) &&
          /* Logo black 1 */ ReplayCutterService.colorSimilarity(
            ReplayCutterService.getPixelColorFromData(
              frameData,
              MODES[games[0].mode].loadingFrames[index].logoBlack1.x,
              MODES[games[0].mode].loadingFrames[index].logoBlack1.y
            ),
            new RGB(0, 0, 0)
          ) &&
          /* Logo black 2 */ ReplayCutterService.colorSimilarity(
            ReplayCutterService.getPixelColorFromData(
              frameData,
              MODES[games[0].mode].loadingFrames[index].logoBlack2.x,
              MODES[games[0].mode].loadingFrames[index].logoBlack2.y
            ),
            new RGB(0, 0, 0)
          ) &&
          /* Logo black 3 */ ReplayCutterService.colorSimilarity(
            ReplayCutterService.getPixelColorFromData(
              frameData,
              MODES[games[0].mode].loadingFrames[index].logoBlack3.x,
              MODES[games[0].mode].loadingFrames[index].logoBlack3.y
            ),
            new RGB(0, 0, 0)
          ) &&
          /* Logo black 4 */ ReplayCutterService.colorSimilarity(
            ReplayCutterService.getPixelColorFromData(
              frameData,
              MODES[games[0].mode].loadingFrames[index].logoBlack4.x,
              MODES[games[0].mode].loadingFrames[index].logoBlack4.y
            ),
            new RGB(0, 0, 0)
          )
        ) {
          console.log('Game loading frame detected.');
          return true;
        }
      }
    }
    return false;
  }

  /**
   * This function detects the start of a game via the introduction of the map.
   * @param video HTML DOM of the video element to be analyzed.
   * @param games List of games already detected.
   * @returns Is the current frame a game intro frame?
   */
  public static detectGameIntro(
    frameData: { data: Uint8ClampedArray; width: number },
    games: Game[]
  ): boolean {
    if (games.length > 0 && games[0].end != -1 && games[0].start == -1) {
      // We are trying to detect the "B" of "BATTLE ARENA" in the lower right corner of the image.
      if (
        //#region B1
        (ReplayCutterService.colorSimilarity(
          ReplayCutterService.getPixelColorFromData(frameData, 1495, 942),
          new RGB(255, 255, 255),
          30
        ) &&
          ReplayCutterService.colorSimilarity(
            ReplayCutterService.getPixelColorFromData(frameData, 1512, 950),
            new RGB(255, 255, 255),
            30
          ) &&
          ReplayCutterService.colorSimilarity(
            ReplayCutterService.getPixelColorFromData(frameData, 1495, 962),
            new RGB(255, 255, 255),
            30
          ) &&
          ReplayCutterService.colorSimilarity(
            ReplayCutterService.getPixelColorFromData(frameData, 1512, 972),
            new RGB(255, 255, 255),
            30
          ) &&
          ReplayCutterService.colorSimilarity(
            ReplayCutterService.getPixelColorFromData(frameData, 1495, 982),
            new RGB(255, 255, 255),
            30
          ) &&
          ReplayCutterService.colorSimilarity(
            ReplayCutterService.getPixelColorFromData(frameData, 1503, 951),
            new RGB(0, 0, 0),
            200
          ) &&
          ReplayCutterService.colorSimilarity(
            ReplayCutterService.getPixelColorFromData(frameData, 1503, 972),
            new RGB(0, 0, 0),
            200
          )) ||
        //#endregion
        //#region B2
        (ReplayCutterService.colorSimilarity(
          ReplayCutterService.getPixelColorFromData(frameData, 1558, 960),
          new RGB(255, 255, 255),
          30
        ) &&
          ReplayCutterService.colorSimilarity(
            ReplayCutterService.getPixelColorFromData(frameData, 1572, 968),
            new RGB(255, 255, 255),
            30
          ) &&
          ReplayCutterService.colorSimilarity(
            ReplayCutterService.getPixelColorFromData(frameData, 1558, 977),
            new RGB(255, 255, 255),
            30
          ) &&
          ReplayCutterService.colorSimilarity(
            ReplayCutterService.getPixelColorFromData(frameData, 1572, 987),
            new RGB(255, 255, 255),
            30
          ) &&
          ReplayCutterService.colorSimilarity(
            ReplayCutterService.getPixelColorFromData(frameData, 1558, 995),
            new RGB(255, 255, 255),
            30
          ) &&
          ReplayCutterService.colorSimilarity(
            ReplayCutterService.getPixelColorFromData(frameData, 1564, 969),
            new RGB(0, 0, 0),
            200
          ) &&
          ReplayCutterService.colorSimilarity(
            ReplayCutterService.getPixelColorFromData(frameData, 1564, 986),
            new RGB(0, 0, 0),
            200
          )) ||
        //#endregion
        //#region B3
        (ReplayCutterService.colorSimilarity(
          ReplayCutterService.getPixelColorFromData(frameData, 1556, 957),
          new RGB(255, 255, 255),
          30
        ) &&
          ReplayCutterService.colorSimilarity(
            ReplayCutterService.getPixelColorFromData(frameData, 1571, 964),
            new RGB(255, 255, 255),
            30
          ) &&
          ReplayCutterService.colorSimilarity(
            ReplayCutterService.getPixelColorFromData(frameData, 1556, 975),
            new RGB(255, 255, 255),
            30
          ) &&
          ReplayCutterService.colorSimilarity(
            ReplayCutterService.getPixelColorFromData(frameData, 1571, 984),
            new RGB(255, 255, 255),
            30
          ) &&
          ReplayCutterService.colorSimilarity(
            ReplayCutterService.getPixelColorFromData(frameData, 1556, 993),
            new RGB(255, 255, 255),
            30
          ) &&
          ReplayCutterService.colorSimilarity(
            ReplayCutterService.getPixelColorFromData(frameData, 1564, 966),
            new RGB(0, 0, 0),
            200
          ) &&
          ReplayCutterService.colorSimilarity(
            ReplayCutterService.getPixelColorFromData(frameData, 1564, 984),
            new RGB(0, 0, 0),
            200
          )) ||
        //#endregion
        //#region B4
        (ReplayCutterService.colorSimilarity(
          ReplayCutterService.getPixelColorFromData(frameData, 1617, 979),
          new RGB(255, 255, 255),
          30
        ) &&
          ReplayCutterService.colorSimilarity(
            ReplayCutterService.getPixelColorFromData(frameData, 1630, 985),
            new RGB(255, 255, 255),
            30
          ) &&
          ReplayCutterService.colorSimilarity(
            ReplayCutterService.getPixelColorFromData(frameData, 1617, 995),
            new RGB(255, 255, 255),
            30
          ) &&
          ReplayCutterService.colorSimilarity(
            ReplayCutterService.getPixelColorFromData(frameData, 1630, 1004),
            new RGB(255, 255, 255),
            30
          ) &&
          ReplayCutterService.colorSimilarity(
            ReplayCutterService.getPixelColorFromData(frameData, 1617, 1011),
            new RGB(255, 255, 255),
            30
          ) &&
          ReplayCutterService.colorSimilarity(
            ReplayCutterService.getPixelColorFromData(frameData, 1623, 987),
            new RGB(0, 0, 0),
            200
          ) &&
          ReplayCutterService.colorSimilarity(
            ReplayCutterService.getPixelColorFromData(frameData, 1623, 1004),
            new RGB(0, 0, 0),
            200
          )) ||
        //#endregion
        //#region B5
        (ReplayCutterService.colorSimilarity(
          ReplayCutterService.getPixelColorFromData(frameData, 1606, 976),
          new RGB(255, 255, 255),
          30
        ) &&
          ReplayCutterService.colorSimilarity(
            ReplayCutterService.getPixelColorFromData(frameData, 1619, 982),
            new RGB(255, 255, 255),
            30
          ) &&
          ReplayCutterService.colorSimilarity(
            ReplayCutterService.getPixelColorFromData(frameData, 1606, 991),
            new RGB(255, 255, 255),
            30
          ) &&
          ReplayCutterService.colorSimilarity(
            ReplayCutterService.getPixelColorFromData(frameData, 1619, 1000),
            new RGB(255, 255, 255),
            30
          ) &&
          ReplayCutterService.colorSimilarity(
            ReplayCutterService.getPixelColorFromData(frameData, 1606, 1008),
            new RGB(255, 255, 255),
            30
          ) &&
          ReplayCutterService.colorSimilarity(
            ReplayCutterService.getPixelColorFromData(frameData, 1612, 983),
            new RGB(0, 0, 0),
            200
          ) &&
          ReplayCutterService.colorSimilarity(
            ReplayCutterService.getPixelColorFromData(frameData, 1612, 1000),
            new RGB(0, 0, 0),
            200
          ))
        //#endregion
      ) {
        console.log('Game intro frame detected.');
        return true;
      }
    }
    return false;
  }

  /**
   * This function detects a playing game frame.
   * @param video HTML DOM of the video element to be analyzed.
   * @param games List of games already detected.
   * @param force Disable the first if.
   * @returns Is the current frame a playing game frame?
   */
  public static detectGamePlaying(
    frameData: { data: Uint8ClampedArray; width: number },
    games: Game[],
    force: boolean = false
  ): boolean {
    if ((games.length > 0 && games[0].start == -1) || force) {
      // Trying to detect the color of all players' life bars.
      const J1_PIXEL = ReplayCutterService.getPixelColorFromData(
        frameData,
        MODES[games[0].mode].gameFrame.playersX[0],
        (MODES[games[0].mode].gameFrame.playersY[0][0] +
          MODES[games[0].mode].gameFrame.playersY[0][1]) /
          2
      );
      const J2_PIXEL = ReplayCutterService.getPixelColorFromData(
        frameData,
        MODES[games[0].mode].gameFrame.playersX[0],
        (MODES[games[0].mode].gameFrame.playersY[1][0] +
          MODES[games[0].mode].gameFrame.playersY[1][1]) /
          2
      );
      const J3_PIXEL = ReplayCutterService.getPixelColorFromData(
        frameData,
        MODES[games[0].mode].gameFrame.playersX[0],
        (MODES[games[0].mode].gameFrame.playersY[2][0] +
          MODES[games[0].mode].gameFrame.playersY[2][1]) /
          2
      );
      const J4_PIXEL = ReplayCutterService.getPixelColorFromData(
        frameData,
        MODES[games[0].mode].gameFrame.playersX[0],
        (MODES[games[0].mode].gameFrame.playersY[3][0] +
          MODES[games[0].mode].gameFrame.playersY[3][1]) /
          2
      );
      const J5_PIXEL = ReplayCutterService.getPixelColorFromData(
        frameData,
        MODES[games[0].mode].gameFrame.playersX[1],
        (MODES[games[0].mode].gameFrame.playersY[0][0] +
          MODES[games[0].mode].gameFrame.playersY[0][1]) /
          2
      );
      const J6_PIXEL = ReplayCutterService.getPixelColorFromData(
        frameData,
        MODES[games[0].mode].gameFrame.playersX[1],
        (MODES[games[0].mode].gameFrame.playersY[1][0] +
          MODES[games[0].mode].gameFrame.playersY[1][1]) /
          2
      );
      const J7_PIXEL = ReplayCutterService.getPixelColorFromData(
        frameData,
        MODES[games[0].mode].gameFrame.playersX[1],
        (MODES[games[0].mode].gameFrame.playersY[2][0] +
          MODES[games[0].mode].gameFrame.playersY[2][1]) /
          2
      );
      const J8_PIXEL = ReplayCutterService.getPixelColorFromData(
        frameData,
        MODES[games[0].mode].gameFrame.playersX[1],
        (MODES[games[0].mode].gameFrame.playersY[3][0] +
          MODES[games[0].mode].gameFrame.playersY[3][1]) /
          2
      );

      const ORANGE = new RGB(231, 123, 9);
      const BLUE = new RGB(30, 126, 242);
      const BLACK = new RGB(0, 0, 0);

      // S'il y a au moins un joueur en vie
      if (
        (ReplayCutterService.colorSimilarity(J1_PIXEL, ORANGE) ||
          ReplayCutterService.colorSimilarity(J2_PIXEL, ORANGE) ||
          ReplayCutterService.colorSimilarity(J3_PIXEL, ORANGE) ||
          ReplayCutterService.colorSimilarity(J4_PIXEL, ORANGE)) &&
        (ReplayCutterService.colorSimilarity(J5_PIXEL, BLUE) ||
          ReplayCutterService.colorSimilarity(J6_PIXEL, BLUE) ||
          ReplayCutterService.colorSimilarity(J7_PIXEL, BLUE) ||
          ReplayCutterService.colorSimilarity(J8_PIXEL, BLUE))
      ) {
        if (
          //#region Orange team
          // Player 1
          (ReplayCutterService.colorSimilarity(J1_PIXEL, ORANGE) ||
            ReplayCutterService.colorSimilarity(J1_PIXEL, BLACK, 50)) &&
          // Player 2
          (ReplayCutterService.colorSimilarity(J2_PIXEL, ORANGE) ||
            ReplayCutterService.colorSimilarity(J2_PIXEL, BLACK, 50)) &&
          // Player 3
          (ReplayCutterService.colorSimilarity(J3_PIXEL, ORANGE) ||
            ReplayCutterService.colorSimilarity(J3_PIXEL, BLACK, 50)) &&
          //Joueur 4
          (ReplayCutterService.colorSimilarity(J4_PIXEL, ORANGE) ||
            ReplayCutterService.colorSimilarity(J4_PIXEL, BLACK, 50)) &&
          //#endregion
          //#region Blue team
          //Joueur 1
          (ReplayCutterService.colorSimilarity(J5_PIXEL, BLUE) ||
            ReplayCutterService.colorSimilarity(J5_PIXEL, BLACK, 50)) &&
          // Player 2
          (ReplayCutterService.colorSimilarity(J6_PIXEL, BLUE) ||
            ReplayCutterService.colorSimilarity(J6_PIXEL, BLACK, 50)) &&
          // Player 3
          (ReplayCutterService.colorSimilarity(J7_PIXEL, BLUE) ||
            ReplayCutterService.colorSimilarity(J7_PIXEL, BLACK, 50)) &&
          // Player 4
          (ReplayCutterService.colorSimilarity(J8_PIXEL, BLUE) ||
            ReplayCutterService.colorSimilarity(J8_PIXEL, BLACK, 50))
          //#endregion
        ) {
          console.log('Game playing frame detected.');
          return true;
        }
      }
      return false;
    }
    return false;
  }

  /**
   * This function returns the map that resembles what the OCR found.
   * @param search Text found by OCR.
   * @returns Map found.
   */
  public static getMapByName(search: string): Map | undefined {
    const SPLITTED = search
      .replace(/(\r\n|\n|\r)/gm, '')
      .toLowerCase()
      .split(' ');
    const RESULT = ReplayCutterService.maps.find((x) =>
      SPLITTED.some((s) => x.dictionnary.includes(s))
    );
    if (RESULT) {
      return RESULT;
    }
    return undefined;
  }

  //#endregion
}
