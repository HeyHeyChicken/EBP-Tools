// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { Component } from '@angular/core';

import { FormsModule } from '@angular/forms';
import { MatDialogModule } from '@angular/material/dialog';
import { TranslateModule } from '@ngx-translate/core';
import { GridModule } from '../../../../shared/grid/grid.module';
import { IdentityService } from '../../../../core/services/identity/identity.service';

//#endregion

@Component({
  selector: 'replay-cutter-dialog-replay-uploaded',
  templateUrl: './replay-uploaded.dialog.html',
  standalone: true,
  imports: [FormsModule, MatDialogModule, TranslateModule, GridModule]
})
export class ReplayCutterReplayUploadedDialog {
  constructor(protected readonly identityService: IdentityService) {}
}
