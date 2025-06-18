// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { CommonModule } from '@angular/common';
import { Component, NgZone, OnInit } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { GridModule } from '../../shared/grid/grid.module';
import { MatInputModule } from '@angular/material/input';
import { FormsModule } from '@angular/forms';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSelectModule } from '@angular/material/select';
import { ToastrService } from 'ngx-toastr';
import { GlobalService } from '../../core/services/global.service';

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
  ],
})
export class GameHistoryComponent implements OnInit {
  //#region Attributes

  protected publicPseudo?: string = undefined;

  protected nbPages: number = 1;
  protected get maxPages(): number[] {
    return Array.from({ length: 20 }, (_, i) => i + 1);
  }

  protected skip: number = 0;

  protected timeToWait: number = 1;

  protected get seasons(): string[] {
    return ['1', '2', '3', '1 reloaded', '4', '5'];
  }
  protected seasonIndex: number = this.seasons.length;

  protected get disablePublicPseudoExportButton(): boolean {
    if (!this.publicPseudo) {
      return true;
    }
    const REGEX = /^[a-zA-Z0-9]+#[0-9]+$/;
    return !REGEX.test(this.publicPseudo);
  }

  //#endregion

  constructor(
    private readonly ngZone: NgZone,
    private readonly toastrService: ToastrService,
    protected readonly globalService: GlobalService
  ) {}

  //#region Functions

  ngOnInit(): void {
    //@ts-ignore
    window.electronAPI.gamesAreExported((filePath: string) => {
      this.ngZone.run(() => {
        this.globalService.loading = false;
        if (filePath) {
          this.toastrService
            .success('Your games have been exported here: ' + filePath)
            .onTap.subscribe(() => {
              //@ts-ignore
              window.electronAPI.openFile(filePath);
            });
        }
      });
    });
  }

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

  protected onPublicPseudoExport(): void {
    if (this.publicPseudo) {
      this.globalService.loading = true;

      //@ts-ignore
      window.electronAPI.extractPublicPseudoGames(
        this.publicPseudo,
        this.nbPages,
        this.seasonIndex,
        this.skip ?? 0,
        this.timeToWait ?? 1
      );
    }
  }

  protected onPrivatePseudoExport(): void {
    this.globalService.loading = true;

    //@ts-ignore
    window.electronAPI.extractPrivatePseudoGames(
      this.nbPages,
      this.seasonIndex,
      this.skip ?? 0,
      this.timeToWait ?? 1
    );
  }

  //#endregion
}
