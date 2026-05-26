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
import { TranslateModule } from '@ngx-translate/core';
import { GridModule } from '../../../../shared/grid/grid.module';
import { MatSelectModule } from '@angular/material/select';

//#endregion

@Component({
  selector: 'replay-cutter-dialog-edit-map',
  templateUrl: './edit-map.dialog.html',
  standalone: true,
  imports: [
    FormsModule,
    MatButtonModule,
    MatDialogModule,
    MatFormFieldModule,
    MatSelectModule,
    TranslateModule,
    GridModule
  ]
})
export class ReplayCutterEditMapDialog {
  //#region Attributes

  protected value: string;

  //#endregion

  constructor(
    public readonly dialogRef: MatDialogRef<ReplayCutterEditMapDialog>,
    @Inject(MAT_DIALOG_DATA)
    public readonly data: {
      map: string;
      maps: string[];
    }
  ) {
    this.value = data.map;
  }
}
