// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { Component } from '@angular/core';

import { MatDialogModule } from '@angular/material/dialog';
import { TranslateModule } from '@ngx-translate/core';
import { MatTooltipModule } from '@angular/material/tooltip';

//#endregion

@Component({
  selector: 'home-dialog-linux-intro',
  templateUrl: './linux-intro.dialog.html',
  styleUrls: ['./linux-intro.dialog.scss'],
  imports: [MatDialogModule, TranslateModule, MatTooltipModule],
  standalone: true
})
export class LinuxIntroDialog {}
