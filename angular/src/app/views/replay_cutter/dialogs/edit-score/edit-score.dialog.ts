// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { Component, Inject } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import {
  MatDialogModule,
  MatDialogRef,
  MAT_DIALOG_DATA
} from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { TranslateModule } from '@ngx-translate/core';
import { GridModule } from '../../../../shared/grid/grid.module';

//#endregion

@Component({
  selector: 'replay-cutter-dialog-edit-score',
  templateUrl: './edit-score.dialog.html',
  standalone: true,
  imports: [
    FormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatInputModule,
    TranslateModule,
    GridModule
  ]
})
export class ReplayCutterEditTeamScoreDialog {
  //#region Attributes

  protected value: number;

  //#endregion

  constructor(
    public readonly dialogRef: MatDialogRef<ReplayCutterEditTeamScoreDialog>,
    @Inject(MAT_DIALOG_DATA) public readonly data: number
  ) {
    this.value = data;
  }
}
