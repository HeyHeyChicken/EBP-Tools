// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { Component } from '@angular/core';
import { MatDialogModule } from '@angular/material/dialog';
import { TranslateModule } from '@ngx-translate/core';
import { GridModule } from '../../../../shared/grid/grid.module';

//#endregion

@Component({
  selector: 'replay-cutter-dialog-beta-required',
  templateUrl: './beta-required.dialog.html',
  styleUrls: ['./beta-required.dialog.scss'],
  imports: [MatDialogModule, TranslateModule, GridModule],
  standalone: true
})
export class ReplayCutterBetaRequiredDialog {}
