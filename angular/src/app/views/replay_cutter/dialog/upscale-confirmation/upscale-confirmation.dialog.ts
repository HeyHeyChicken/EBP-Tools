// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { Component, Inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { TranslateModule } from '@ngx-translate/core';
import { GridModule } from '../../../../shared/grid/grid.module';

//#endregion

@Component({
  selector: 'replay-cutter-dialog-upscale-confirmation',
  templateUrl: './upscale-confirmation.dialog.html',
  imports: [CommonModule, MatDialogModule, TranslateModule, GridModule],
  standalone: true
})
export class ReplayCutterUpscaleConfirmationDialog {
  constructor(
    @Inject(MAT_DIALOG_DATA)
    protected data: number
  ) {}
}
