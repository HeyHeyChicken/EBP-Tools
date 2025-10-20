import { CropperPosition } from 'ngx-image-cropper';

export interface CropperPositionAndFrame extends CropperPosition {
  frame?: CanvasImageSource;
}
