// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { CommonModule } from '@angular/common';
import { Component, isDevMode, NgZone, OnInit } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { GridModule } from '../../shared/grid/grid.module';
import { MatInputModule } from '@angular/material/input';
import { FormsModule } from '@angular/forms';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSelectModule } from '@angular/material/select';
import { ToastrService } from 'ngx-toastr';
import { GlobalService } from '../../core/services/global.service';
import { MatDialog } from '@angular/material/dialog';
import { ConfirmationDialog } from './dialog/confirmation/confirmation.dialog';
import { MessageComponent } from '../../shared/message/message.component';

//#endregion

@Component({
  selector: 'view-game_history',
  templateUrl: './game_history.component.html',
  styleUrls: ['./game_history.component.scss'],
  standalone: true,
  imports: [
    GridModule,
    TranslateModule,
    CommonModule,
    TranslateModule,
    MatInputModule,
    FormsModule,
    MatTooltipModule,
    MatSelectModule,
    MessageComponent
  ]
})
export class GameHistoryComponent implements OnInit {
  //#region Attributes

  protected publicPseudo?: string = undefined;

  protected outputPath: string | undefined;

  protected nbPages: number = 1;

  protected skip: number = 0;

  protected timeToWait: number = 1;

  protected seasonIndex: number = this.seasons.length;

  protected readonly tagPlaceholder: string = 'HeyHeyChicken#37457';

  //#endregion

  constructor(
    protected readonly globalService: GlobalService,
    private readonly ngZone: NgZone,
    private readonly toastrService: ToastrService,
    private readonly dialogService: MatDialog
  ) {}

  //#region Functions

  ngOnInit(): void {
    if (isDevMode()) {
      this.publicPseudo = this.tagPlaceholder;
    }

    window.electronAPI.getGameHistoryOutputPath().then((path: string) => {
      this.ngZone.run(() => {
        this.outputPath = path;
      });
    });

    window.electronAPI.gamesAreExported((filePath?: string) => {
      console.log(`The user exported his games here: "${filePath}"`);
      this.ngZone.run(() => {
        this.globalService.loading = undefined;
        if (filePath) {
          this.toastrService
            .success('Your games have been exported here: ' + filePath)
            .onTap.subscribe(() => {
              window.electronAPI.openFile(filePath);
            });
        }
      });
    });
  }

  /**
   * Returns the list of EVA available seasons as strings.
   */
  protected get seasons(): string[] {
    return ['1', '2', '3', '1 reloaded', '4', '5', '6'];
  }

  /**
   * Returns an array of numbers from 1 to 20 representing the maximum selectable pages.
   */
  protected get maxPages(): number[] {
    return Array.from({ length: 20 }, (_, i) => i + 1);
  }

  /**
   * Determines whether the public pseudo export button should be disabled.
   * The button is disabled if the public pseudo is empty or does not match the required format (alphanumeric text followed by '#' and digits).
   */
  protected get disablePublicPseudoExportButton(): boolean {
    if (!this.publicPseudo) {
      return true;
    }
    const REGEX = /^[a-zA-Z0-9]+#[0-9]+$/;
    return !REGEX.test(this.publicPseudo);
  }

  /**
   * This function allows user to change the folder where game histories are stored.
   */
  protected setOutputPath(): void {
    this.globalService.loading = '';
    window.electronAPI
      .setSetting('gameHistoryOutputPath')
      .then((path: string) => {
        this.ngZone.run(() => {
          this.globalService.loading = undefined;
          if (path) {
            console.log(`The user changed games export folder: "${path}"`);
            this.outputPath = path;
          }
        });
      });
  }

  /**
   * Handles the paste event for the public pseudo input.
   * If the pasted text contains a '/' character, it extracts the last segment containing a '#' symbol and sets it as the new public pseudo.
   * @param event Clipboard paste event.
   */
  protected onPublicPseudoPaste(event: ClipboardEvent): void {
    setTimeout(() => {
      if (event.target && this.publicPseudo) {
        const SPLITTED = this.publicPseudo.split('/');
        if (SPLITTED.length > 1) {
          const TAG = [...SPLITTED].reverse().find((s) => s.includes('#'));
          if (TAG) {
            setTimeout(() => {
              this.publicPseudo = TAG;
            });
          }
        }
      }
    });
  }

  /**
   * Opens a confirmation dialog before exporting games linked to the current public pseudo.
   * If the user confirms, triggers the Electron API to extract the games using the specified pagination and timing parameters.
   */
  protected onPublicPseudoExport(): void {
    if (this.publicPseudo) {
      this.dialogService
        .open(ConfirmationDialog)
        .afterClosed()
        .subscribe((answer: boolean | undefined) => {
          if (answer === true) {
            console.log(
              `The user is trying to export games from public user "${this.publicPseudo}".`
            );
            window.electronAPI.extractPublicPseudoGames(
              this.publicPseudo!,
              this.nbPages,
              this.seasonIndex,
              this.skip ?? 0,
              this.timeToWait ?? 1
            );
          }
        });
    }
  }

  /**
   * Opens a confirmation dialog before exporting games linked to the private pseudo.
   * If the user confirms, triggers the Electron API to extract private games using the specified pagination and timing parameters.
   */
  protected onPrivatePseudoExport(): void {
    this.dialogService
      .open(ConfirmationDialog)
      .afterClosed()
      .subscribe((answer: boolean | undefined) => {
        if (answer === true) {
          console.log(`User is trying to export a private user's games.`);
          window.electronAPI.extractPrivatePseudoGames(
            this.nbPages,
            this.seasonIndex,
            this.skip ?? 0,
            this.timeToWait ?? 1
          );
        }
      });
  }

  //#endregion
}
