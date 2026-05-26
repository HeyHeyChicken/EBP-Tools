// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { Component } from '@angular/core';
import { MatDialogModule } from '@angular/material/dialog';
import { TranslateModule } from '@ngx-translate/core';
import { GridModule } from '../../../../shared/grid/grid.module';
import { MatTooltipModule } from '@angular/material/tooltip';

//#endregion

@Component({
  selector: 'replay-cutter-dialog-before-removing-borders',
  templateUrl: './before-removing-borders.dialog.html',
  imports: [MatDialogModule, TranslateModule, GridModule, MatTooltipModule],
  standalone: true
})
export class ReplayCutterBeforeRemovingBordersDialog {}
