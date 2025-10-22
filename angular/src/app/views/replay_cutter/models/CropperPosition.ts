// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { CropperPosition } from 'ngx-image-cropper';

//#endregion

export interface CropperPositionAndFrame extends CropperPosition {
  //#region Attributes

  frame?: CanvasImageSource;

  //#endregion
}
