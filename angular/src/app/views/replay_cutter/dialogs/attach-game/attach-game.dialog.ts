// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { Component, Inject } from '@angular/core';

import {
  MAT_DIALOG_DATA,
  MatDialogModule,
  MatDialogRef
} from '@angular/material/dialog';
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
  imports: [MatDialogModule, TranslateModule, GridModule, MatTooltipModule],
  standalone: true
})
export class ReplayCutterAttachGameDialog {
  constructor(
    private readonly dialogRef: MatDialogRef<ReplayCutterAttachGameDialog>,
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

  /**
   * Handles click events on the description text to open external URLs based on the clicked element.
   * If an anchor tag (A) is clicked, opens the general statistics page.
   * If a bold tag (B) is clicked, opens the statistics page with pre-created game data including teams, scores, and players.
   * @param event The mouse click event containing the target element information.
   */
  protected clickOnDescription(event: MouseEvent): void {
    if (event.target instanceof HTMLElement) {
      if (event.target.tagName === 'A') {
        window.electronAPI.openURL(
          `${this.globalService.webSiteURL}/tools/statistics`
        );
      } else if (event.target.tagName === 'B') {
        this.dialogRef.close(null);
      }
    }
  }

  //#endregion
}
