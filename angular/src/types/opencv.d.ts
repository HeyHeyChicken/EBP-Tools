// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

/* eslint-disable no-var */
// Minimal OpenCV type definitions for global cv object
// Extend as needed for your project

declare namespace cv {
  class Mat {
    constructor();
    cols: number;
    rows: number;
    delete(): void;
    // Add more methods as needed
  }

  interface Point {
    x: number;
    y: number;
  }

  interface Size {
    width: number;
    height: number;
  }

  interface MinMaxLocResult {
    minVal: number;
    maxVal: number;
    minLoc: Point;
    maxLoc: Point;
  }

  function imread(canvas: HTMLCanvasElement | string): Mat;
  function matchTemplate(
    image: Mat,
    templ: Mat,
    result: Mat,
    method: number,
    mask?: Mat
  ): void;
  function minMaxLoc(src: Mat, mask?: Mat): MinMaxLocResult;

  // Constants
  const TM_CCOEFF_NORMED: number;
}

declare var cv: typeof cv;
