// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import {
  Component,
  ElementRef,
  Inject,
  OnInit,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  MAT_DIALOG_DATA,
  MatDialogModule,
  MatDialogRef
} from '@angular/material/dialog';
import { TranslateModule } from '@ngx-translate/core';
import {
  ImageCropperComponent,
  CropperPosition,
  Dimensions
} from 'ngx-image-cropper';
import { MatTooltipModule } from '@angular/material/tooltip';
import { AssistantComponent } from '../../../../shared/assistant/assistant.component';
import { ReplayCutterComponent } from '../../replay_cutter.component';

//#endregion

@Component({
  selector: 'replay-cutter-dialog-crop',
  templateUrl: './crop.dialog.html',
  styleUrls: ['./crop.dialog.scss'],
  imports: [
    CommonModule,
    MatDialogModule,
    TranslateModule,
    ImageCropperComponent,
    MatTooltipModule,
    AssistantComponent
  ],
  standalone: true
})
export class ReplayCutterCropDialog implements OnInit {
  //#region Attributes

  @ViewChild('matDialogContent') matDialogContent?: ElementRef<HTMLDivElement>;

  public static DEFAULT_CROPPER: CropperPosition = {
    x1: 0,
    y1: 0,
    x2: 650,
    y2: 400
  };

  protected cropper: CropperPosition = ReplayCutterCropDialog.DEFAULT_CROPPER;
  protected globalCropper: CropperPosition =
    ReplayCutterCropDialog.DEFAULT_CROPPER;

  protected currentImgBase64?: string;
  protected currentImgDimensions?: Dimensions;
  private cropperReady: boolean = false;
  private currentScale: number = 1;

  @ViewChild('imageCropperContainer')
  private readonly imageCropperContainer:
    | ElementRef<HTMLDivElement>
    | undefined;

  protected get disableSubmitButton(): boolean {
    if (
      this.globalCropper.x2 - this.globalCropper.x1 >
        ReplayCutterCropDialog.DEFAULT_CROPPER.x2 ||
      this.globalCropper.y2 - this.globalCropper.y1 >
        ReplayCutterCropDialog.DEFAULT_CROPPER.y2
    ) {
      return true;
    }
    return false;
  }

  //#endregion

  constructor(
    @Inject(MAT_DIALOG_DATA)
    protected data: {
      imgBase64: string;
      initialCropperPosition: CropperPosition | undefined;
      component: ReplayCutterComponent;
      gameIndex: number;
    },
    private readonly dialogRef: MatDialogRef<ReplayCutterCropDialog>
  ) {
    // We resize the window to full screen.
    window.electronAPI.setWindowSize(0, 0);

    if (data.initialCropperPosition) {
      this.cropper = data.initialCropperPosition;
    }
  }

  //#region Functions

  ngOnInit(): void {
    const SELF = this;

    setTimeout(() => {
      const IMAGE = new Image();
      IMAGE.onload = function () {
        let matDialogContentWidth: number = 0;
        let matDialogContentHeight: number = 0;
        if (SELF.matDialogContent?.nativeElement) {
          const STYLE = window.getComputedStyle(
            SELF.matDialogContent?.nativeElement
          );
          const PADDING_LEFT = parseFloat(STYLE.paddingLeft);
          const PADDING_RIGHT = parseFloat(STYLE.paddingRight);
          const PADDING_TOP = parseFloat(STYLE.paddingTop);
          const PADDING_BOTTOM = parseFloat(STYLE.paddingBottom) + 16;

          matDialogContentWidth =
            SELF.matDialogContent?.nativeElement.clientWidth -
            PADDING_LEFT -
            PADDING_RIGHT;

          matDialogContentHeight =
            SELF.matDialogContent?.nativeElement.clientHeight -
            PADDING_TOP -
            PADDING_BOTTOM;
        }

        const CANVAS = document.createElement('canvas');
        CANVAS.width = matDialogContentWidth;
        CANVAS.height = matDialogContentHeight;

        const CTX = CANVAS.getContext('2d');
        if (CTX) {
          CTX.drawImage(
            IMAGE /* Image */,
            ReplayCutterCropDialog.DEFAULT_CROPPER.x1 /* Image X */,
            ReplayCutterCropDialog.DEFAULT_CROPPER.y1 /* Image Y */
          );

          SELF.currentImgBase64 = CANVAS.toDataURL('image/png');
        }
      };
      IMAGE.src = this.data.imgBase64;
    }, 200);
  }

  /**
   * Generates a new image by selecting a random frame from the current game's time range and detecting the minimap.
   * This method calculates a random timestamp within the game's start and end times, then uses the parent component's minimap detection to extract a frame and cropper position, which are then applied to reset the dialog state.
   */
  protected getNewImage(): void {
    const MIN = this.data.component.games[this.data.gameIndex].start;
    const MAX = this.data.component.games[this.data.gameIndex].end;
    const RANDOM = Math.floor(Math.random() * (MAX - MIN + 1)) + MIN;

    this.data.component.detectMinimap(
      this.data.component.games[this.data.gameIndex],
      (position: CropperPosition, videoFrame: HTMLCanvasElement) => {
        this.reset();
        this.currentImgBase64 = videoFrame.toDataURL('image/png');
        this.data.initialCropperPosition = position;
      },
      RANDOM
    );
  }

  /**
   * Handles the cropper ready event by storing the image dimensions and enabling cropper functionality.
   * Uses a setTimeout to ensure the cropper is fully initialized before allowing interactions.
   * @param event The dimensions of the loaded image containing width and height information.
   */
  protected onCropperReady(event: Dimensions): void {
    this.currentImgDimensions = event;

    setTimeout(() => {
      this.cropperReady = true;
    });
  }

  /**
   * Handles cropper position change events by updating the zoomed crop view.
   * Only processes the change if the cropper is in a ready state to prevent issues during initialization.
   * @param event The new cropper position data containing the selected crop area coordinates.
   */
  protected onCropperChange(event: CropperPosition): void {
    if (this.cropperReady) {
      this.reinjectZoomedCrop(event);
    }
  }

  /**
   * Resets the crop dialog to its initial state by restoring the original image and cropper settings.
   * This includes resetting the image data, cropper positions, and scale factor to their default values.
   * If an initial cropper position was provided, it will be applied instead of the default position.
   */
  protected reset(): void {
    this.currentImgBase64 = this.data.imgBase64;
    this.cropper = ReplayCutterCropDialog.DEFAULT_CROPPER;
    this.globalCropper = ReplayCutterCropDialog.DEFAULT_CROPPER;
    this.currentScale = 1;
    if (this.data.initialCropperPosition) {
      this.cropper = this.data.initialCropperPosition;
    }
  }

  /**
   * Submits the crop dialog by closing it with the appropriate cropper position data.
   * If the cropper position hasn't changed from the initial state, returns the original cropper.
   * Otherwise, returns the updated global cropper position.
   */
  protected submit(): void {
    if (!this.disableSubmitButton) {
      if (this.cropper == this.data.initialCropperPosition) {
        this.dialogRef.close(this.cropper);
      } else {
        this.dialogRef.close(this.globalCropper);
      }
    }
  }

  /**
   * Calculates the effective content width of the Material Dialog by subtracting padding from the total client width.
   * This provides the actual usable width for content positioning within the dialog.
   * @returns The content width in pixels, or 0 if the dialog element is not available.
   */
  protected get matDialogContentWidth(): number {
    if (this.matDialogContent?.nativeElement) {
      const STYLE = getComputedStyle(this.matDialogContent?.nativeElement);
      return (
        this.matDialogContent?.nativeElement.clientWidth -
        parseInt(STYLE.paddingLeft) -
        parseInt(STYLE.paddingRight)
      );
    }
    return 0;
  }

  /**
   * Calculates the effective content height of the Material Dialog by subtracting top padding from the total client height.
   * This provides the actual usable height for content positioning within the dialog.
   * @returns The content height in pixels, or 0 if the dialog element is not available.
   */
  protected get matDialogContentHeight(): number {
    if (this.matDialogContent?.nativeElement) {
      const STYLE = getComputedStyle(this.matDialogContent?.nativeElement);
      return (
        this.matDialogContent?.nativeElement.clientHeight -
        parseInt(STYLE.paddingTop)
      );
    }
    return 0;
  }

  /**
   * Reinjects a zoomed crop by extracting the selected area from the current image and updating the cropper display.
   * This method performs several operations:
   * 1. Calculates the actual pixel coordinates based on the current image scale.
   * 2. Updates the global cropper position to track the cumulative crop area.
   * 3. Extracts the selected region from the image using canvas manipulation.
   * 4. Scales the extracted region to fit the display container.
   * 5. Updates the image cropper with the new zoomed image data.
   * @param position The cropper position defining the area to zoom into.
   */
  private reinjectZoomedCrop(position: CropperPosition) {
    if (
      this.currentImgBase64 &&
      this.currentImgDimensions &&
      this.imageCropperContainer
    ) {
      this.cropperReady = false;

      const IMG = new Image();
      IMG.src = this.currentImgBase64;

      IMG.onload = () => {
        const targetDisplayWidth =
          this.imageCropperContainer!.nativeElement.clientWidth;
        const targetDisplayHeight =
          this.imageCropperContainer!.nativeElement.clientHeight;

        const RATIO = IMG.width / this.currentImgDimensions!.width;
        const X1 = position.x1 * RATIO;
        const Y1 = position.y1 * RATIO;
        const X2 = position.x2 * RATIO;
        const Y2 = position.y2 * RATIO;

        const WIDTH = X2 - X1;
        const HEIGHT = Y2 - Y1;

        const GLOBAL_CROPPER_X1 =
          this.globalCropper.x1 + Math.round(X1 / this.currentScale);
        const GLOBAL_CROPPER_Y1 =
          this.globalCropper.y1 + Math.round(Y1 / this.currentScale);

        this.globalCropper = {
          x1: GLOBAL_CROPPER_X1,
          x2:
            Math.round(X2 / this.currentScale) +
            (this.currentScale == 1 ? 0 : GLOBAL_CROPPER_X1),
          y1: GLOBAL_CROPPER_Y1,
          y2:
            Math.round(Y2 / this.currentScale) +
            (this.currentScale == 1 ? 0 : GLOBAL_CROPPER_Y1)
        };

        const SCALE_X = targetDisplayWidth / WIDTH;
        const SCALE_Y = targetDisplayHeight / HEIGHT;
        const SCALE = Math.min(SCALE_X, SCALE_Y);
        this.currentScale *= SCALE;

        const CANVAS = document.createElement('canvas');

        CANVAS.width = WIDTH * SCALE;
        CANVAS.height = HEIGHT * SCALE;

        const CTX = CANVAS.getContext('2d');
        if (CTX) {
          CTX.drawImage(
            IMG,
            X1,
            Y1,
            WIDTH,
            HEIGHT,
            0,
            0,
            WIDTH * SCALE,
            HEIGHT * SCALE
          );

          const ZOOMED_BASE_64 = CANVAS.toDataURL('image/png');
          this.currentImgBase64 = ZOOMED_BASE_64;
          this.cropper = {
            x1: 0,
            y1: 0,
            x2: WIDTH * SCALE,
            y2: HEIGHT * SCALE
          };
        }
      };
    }
  }

  //#endregion
}
