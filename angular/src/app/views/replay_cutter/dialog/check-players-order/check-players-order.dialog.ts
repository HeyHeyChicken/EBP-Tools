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
  selector: 'replay-cutter-dialog-check-players-order',
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
export class ReplayCutterCheckPlayersOrderDialog {
  //#region Attributes

  protected value: {
    orangePlayersNames: string[];
    bluePlayersNames: string[];
    orangeNamesAsImage: string;
    blueNamesAsImage: string;
  };

  @ViewChild('canvasOrangeRef') canvasOrangeRef?: ElementRef<HTMLCanvasElement>;
  @ViewChild('canvasBlueRef') canvasBlueRef?: ElementRef<HTMLCanvasElement>;

  @ViewChildren('orangeInput') orangeInputs?: QueryList<ElementRef>;
  @ViewChildren('blueInput') blueInputs?: QueryList<ElementRef>;

  //#endregion

  constructor(
    public readonly dialogRef: MatDialogRef<ReplayCutterCheckPlayersOrderDialog>,
    @Inject(MAT_DIALOG_DATA)
    public readonly data: {
      orangePlayersNames: string[];
      bluePlayersNames: string[];
      orangeNamesAsImage: string;
      blueNamesAsImage: string;
      replayCutterComponent: ReplayCutterComponent;
      gameIndex: number;
    },
    private readonly globalService: GlobalService
  ) {
    this.value = data;
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
