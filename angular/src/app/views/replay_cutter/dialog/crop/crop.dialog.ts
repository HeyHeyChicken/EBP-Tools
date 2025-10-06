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
        const PADDING_BOTTOM = parseFloat(STYLE.paddingBottom);

        matDialogContentWidth =
          SELF.matDialogContent?.nativeElement.clientWidth -
          PADDING_LEFT -
          PADDING_RIGHT;

        matDialogContentHeight =
          SELF.matDialogContent?.nativeElement.clientHeight -
          PADDING_TOP -
          PADDING_BOTTOM;
      }

      const CANVAS_WIDTH =
        ReplayCutterCropDialog.DEFAULT_CROPPER.x2 -
        ReplayCutterCropDialog.DEFAULT_CROPPER.x1;
      const CANVAS_HEIGHT =
        ReplayCutterCropDialog.DEFAULT_CROPPER.y2 -
        ReplayCutterCropDialog.DEFAULT_CROPPER.y1;

      const RATIO = Math.min(
        matDialogContentWidth / CANVAS_WIDTH,
        matDialogContentHeight / CANVAS_HEIGHT
      );

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
  }

  protected onCropperReady(event: Dimensions): void {
    this.currentImgDimensions = event;

    setTimeout(() => {
      this.cropperReady = true;
    });
  }

  protected onCropperChange(event: CropperPosition): void {
    if (this.cropperReady) {
      this.reinjectZoomedCrop(event);
    }
  }

  protected reset(): void {
    this.currentImgBase64 = this.data.imgBase64;
    this.cropper = ReplayCutterCropDialog.DEFAULT_CROPPER;
    this.globalCropper = ReplayCutterCropDialog.DEFAULT_CROPPER;
    this.currentScale = 1;
  }

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
          x2: Math.round(X2 / this.currentScale) + GLOBAL_CROPPER_X1,
          y1: GLOBAL_CROPPER_Y1,
          y2: Math.round(Y2 / this.currentScale) + GLOBAL_CROPPER_Y1
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

  protected submit(): void {
    if (!this.disableSubmitButton) {
      if (this.cropper == this.data.initialCropperPosition) {
        this.dialogRef.close(this.cropper);
      } else {
        this.dialogRef.close(this.globalCropper);
      }
    }
  }

  //#endregion
}
