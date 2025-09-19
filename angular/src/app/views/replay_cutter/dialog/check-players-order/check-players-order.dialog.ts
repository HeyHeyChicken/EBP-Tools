// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import {
  Component,
  Inject,
  ViewChild,
  ViewChildren,
  QueryList,
  ElementRef,
  AfterViewInit
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import {
  MatDialogModule,
  MatDialogRef,
  MAT_DIALOG_DATA
} from '@angular/material/dialog';
import { CropperPosition } from 'ngx-image-cropper';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { TranslateModule } from '@ngx-translate/core';
import { GridModule } from '../../../../shared/grid/grid.module';
import { ReplayCutterComponent } from '../../replay_cutter.component';
import { GlobalService } from '../../../../core/services/global.service';

//#endregion

@Component({
  selector: 'app-check-players-order-dialog',
  templateUrl: './check-players-order.dialog.html',
  styleUrls: ['./check-players-order.dialog.scss'],
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    TranslateModule,
    GridModule
  ]
})
export class CheckPlayersOrderDialog implements AfterViewInit {
  //#region Attributes

  protected value: {
    orangePlayersNames: string[];
    bluePlayersNames: string[];
    orangeTeamInfosPosition: CropperPosition;
    blueTeamInfosPosition: CropperPosition;
  };

  @ViewChild('canvasOrangeRef') canvasOrangeRef?: ElementRef<HTMLCanvasElement>;
  @ViewChild('canvasBlueRef') canvasBlueRef?: ElementRef<HTMLCanvasElement>;

  @ViewChildren('orangeInput') orangeInputs?: QueryList<ElementRef>;
  @ViewChildren('blueInput') blueInputs?: QueryList<ElementRef>;

  //#endregion

  constructor(
    public readonly dialogRef: MatDialogRef<CheckPlayersOrderDialog>,
    @Inject(MAT_DIALOG_DATA)
    public readonly data: {
      orangePlayersNames: string[];
      bluePlayersNames: string[];
      orangeTeamInfosPosition: CropperPosition;
      blueTeamInfosPosition: CropperPosition;
      replayCutterComponent: ReplayCutterComponent;
      gameIndex: number;
    },
    private readonly globalService: GlobalService
  ) {
    this.value = data;
  }

  ngAfterViewInit(): void {
    this.data.replayCutterComponent.videoURLToCanvas(
      `http://localhost:${this.globalService.serverPort}/file?path=${this.data.replayCutterComponent.videoPath}`,
      Math.round(
        (this.data.replayCutterComponent.games[this.data.gameIndex].start +
          10) *
          1000
      ),
      (videoFrame?: HTMLCanvasElement) => {
        if (videoFrame) {
          this.drawVideoFrame(
            this.data.orangeTeamInfosPosition,
            this.data.orangePlayersNames.length,
            videoFrame,
            this.canvasOrangeRef?.nativeElement,
            true
          );
          this.drawVideoFrame(
            this.data.blueTeamInfosPosition,
            this.data.bluePlayersNames.length,
            videoFrame,
            this.canvasBlueRef?.nativeElement,
            false
          );
        }
      }
    );
  }

  /**
   * Extracts and draws a specific portion of the video frame onto the target canvas using position coordinates to crop the team names area.
   * @param position The cropper position coordinates defining the area to extract.
   * @param nbPlayers The number of players to extract from the team area.
   * @param frame The source video frame canvas to extract from.
   * @param target The target canvas to draw the extracted portion onto.
   * @param cropFromTheLeft Whether to crop from the left side (true) or right side (false) of the position area.
   */
  private drawVideoFrame(
    position: CropperPosition,
    nbPlayers: number,
    frame: HTMLCanvasElement,
    target: HTMLCanvasElement | undefined,
    cropFromTheLeft: boolean
  ): void {
    if (frame && target) {
      const X1 = cropFromTheLeft
        ? (position.x2 - position.x1) * 0.24 + position.x1
        : position.x1;
      const X2 = !cropFromTheLeft
        ? position.x2 - (position.x2 - position.x1) * 0.24
        : position.x2;
      const WIDTH = X2 - X1;
      const TOTAL_HEIGHT = position.y2 - position.y1;
      const SLICE_HEIGHT = (TOTAL_HEIGHT / nbPlayers) * 0.3; // The banner containing the player's nickname is 30% of its height.
      const SLICE_SPACING = (TOTAL_HEIGHT / nbPlayers) * 0.7;
      const CANVAS_HEIGHT = nbPlayers * SLICE_HEIGHT;

      target.width = WIDTH;
      target.height = CANVAS_HEIGHT;
      const CTX = target.getContext('2d');

      if (CTX) {
        for (let i = 0; i < nbPlayers; i++) {
          const SOURCE_Y = position.y1 + i * (SLICE_SPACING + SLICE_HEIGHT);
          const TARGET_Y = i * SLICE_HEIGHT;

          CTX.drawImage(
            frame,
            X1,
            SOURCE_Y,
            WIDTH,
            SLICE_HEIGHT,
            0,
            TARGET_Y,
            WIDTH,
            SLICE_HEIGHT
          );
        }
      }
    }
  }

  /**
   * Moves a player up one position in the team list by swapping with the player above.
   * @param team The team to modify ('orange' or 'blue').
   * @param index The current index of the player to move up.
   */
  movePlayerUp(team: 'orange' | 'blue', index: number): void {
    if (index > 0) {
      const PLAYERS =
        team === 'orange'
          ? this.value.orangePlayersNames
          : this.value.bluePlayersNames;
      [PLAYERS[index - 1], PLAYERS[index]] = [
        PLAYERS[index],
        PLAYERS[index - 1]
      ];
      this.focusOnInput(team, index - 1);
    }
  }

  /**
   * Moves a player down one position in the team list by swapping with the player below.
   * @param team The team to modify ('orange' or 'blue').
   * @param index The current index of the player to move down.
   */
  movePlayerDown(team: 'orange' | 'blue', index: number): void {
    const PLAYERS =
      team === 'orange'
        ? this.value.orangePlayersNames
        : this.value.bluePlayersNames;
    if (index < PLAYERS.length - 1) {
      [PLAYERS[index], PLAYERS[index + 1]] = [
        PLAYERS[index + 1],
        PLAYERS[index]
      ];
      this.focusOnInput(team, index + 1);
    }
  }

  /**
   * Sets focus on the input field for the specified team and index.
   * @param team The team ('orange' or 'blue').
   * @param index The index of the input to focus.
   */
  private focusOnInput(team: 'orange' | 'blue', index: number): void {
    setTimeout(() => {
      const INPUTS = (
        team === 'orange' ? this.orangeInputs : this.blueInputs
      )?.toArray();
      if (INPUTS && INPUTS[index]) {
        INPUTS[index].nativeElement.focus();
      }
    });
  }
}
