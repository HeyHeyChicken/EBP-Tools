// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { Component, Inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { TranslateModule } from '@ngx-translate/core';
import { RestGame } from '../../models/rest-game';
import { GridModule } from '../../../../shared/grid/grid.module';
import { MatTooltipModule } from '@angular/material/tooltip';

//#endregion

@Component({
  selector: 'replay-cutter-dialog-attach-game',
  templateUrl: './attach-game.dialog.html',
  styleUrls: ['./attach-game.dialog.scss'],
  imports: [
    CommonModule,
    MatDialogModule,
    TranslateModule,
    GridModule,
    MatTooltipModule
  ],
  standalone: true
})
export class ReplayCutterAttachGameDialog {
  constructor(
    @Inject(MAT_DIALOG_DATA)
    protected data: {
      games: RestGame[];
      image: string;
    }
  ) {}
}
