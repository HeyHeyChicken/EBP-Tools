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
import { GlobalService } from '../../../../core/services/global.service';
import { Game } from '../../models/game';

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
    private readonly globalService: GlobalService,
    @Inject(MAT_DIALOG_DATA)
    protected data: {
      game: Game;
      games: RestGame[];
      images: [string | undefined, string | undefined];
      orangePlayersNames: string[];
      bluePlayersNames: string[];
    }
  ) {
    window.electronAPI.setWindowSize();
  }

  //#region Functions

  protected clickOnDescription(event: MouseEvent): void {
    if (event.target instanceof HTMLElement) {
      if (event.target.tagName === 'A') {
        window.electronAPI.openURL(
          `${this.globalService.webSiteURL}/tools/statistics`
        );
      } else if (event.target.tagName === 'B') {
        const DATA = {
          map: this.data.game.map,
          date: new Date().getTime(),
          orange: {
            name: this.data.game.orangeTeam.name,
            score: this.data.game.orangeTeam.score,
            players: this.data.orangePlayersNames
          },
          blue: {
            name: this.data.game.blueTeam.name,
            score: this.data.game.blueTeam.score,
            players: this.data.bluePlayersNames
          }
        };
        window.electronAPI.openURL(
          `${this.globalService.webSiteURL}/tools/statistics?new=${encodeURIComponent(JSON.stringify(DATA))}`
        );
      }
    }
  }

  //#endregion
}
