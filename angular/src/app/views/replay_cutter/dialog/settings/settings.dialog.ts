// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { Component, Inject, NgZone, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { TranslateModule } from '@ngx-translate/core';
import { GridModule } from '../../../../shared/grid/grid.module';
import { MatFormFieldModule } from '@angular/material/form-field';
import { FormsModule } from '@angular/forms';
import { MatInputModule } from '@angular/material/input';
import { GlobalService } from '../../../../core/services/global.service';
import { Settings } from '../../models/settings';

//#endregion

@Component({
  selector: 'replay-cutter-dialog-settings',
  templateUrl: './settings.dialog.html',
  styleUrls: ['./settings.dialog.scss'],
  imports: [
    CommonModule,
    MatDialogModule,
    TranslateModule,
    GridModule,
    MatFormFieldModule,
    FormsModule,
    MatInputModule
  ],
  standalone: true
})
export class ReplayCutterSettingsDialog implements OnInit {
  //#region Attributes

  protected outputPath: string | undefined;

  //#endregion

  constructor(
    protected readonly globalService: GlobalService,
    @Inject(MAT_DIALOG_DATA)
    protected data: Settings,
    private readonly ngZone: NgZone
  ) {}

  //#region Functions

  ngOnInit(): void {
    window.electronAPI.getVideoCutterOutputPath().then((path: string) => {
      this.ngZone.run(() => {
        this.outputPath = path;
      });
    });
  }

  /**
   * This function allows user to change the folder where the cut games are stored.
   */
  protected setOutputPath(): void {
    this.globalService.loading = '';
    window.electronAPI
      .setSetting('videoCutterOutputPath')
      .then((path: string) => {
        this.ngZone.run(() => {
          this.globalService.loading = undefined;
          if (path) {
            this.outputPath = path;
          }
        });
      });
  }

  //#endregion
}
