// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { Component, OnInit } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { GridModule } from '../../shared/grid/grid.module';
import { MessageComponent } from '../../shared/message/message.component';
import { CommonModule } from '@angular/common';
import { MatTooltipModule } from '@angular/material/tooltip';
import { GlobalService } from '../../core/services/global.service';

//#endregion

@Component({
  selector: 'view-home',
  templateUrl: './home.component.html',
  styleUrls: ['./home.component.scss'],
  standalone: true,
  imports: [
    GridModule,
    TranslateModule,
    MessageComponent,
    CommonModule,
    MatTooltipModule
  ]
})
export class HomeComponent implements OnInit {
  //#region Attributes

  protected developpers: string[] = ['AydenHex'];

  //#endregion

  //#region Functions

  ngOnInit(): void {
    this.arrayShuffle(this.developpers);
  }

  /**
   * Opens the specified URL in the user's default external browser.
   * @param url The URL to open in the external browser.
   */
  protected openURL(url: string): void {
    window.electronAPI.openURL(url);
  }

  /**
   * This function shuffles the elements of a list in random order.
   * @param array Mix list.
   */
  private arrayShuffle(array: unknown[]) {
    let currentIndex = array.length;

    while (currentIndex != 0) {
      const RANDOM_INDEX: number = Math.floor(
        (GlobalService.random(1000000000000000, 9999999999999999) /
          10000000000000000) *
          currentIndex
      );
      currentIndex--;

      [array[currentIndex], array[RANDOM_INDEX]] = [
        array[RANDOM_INDEX],
        array[currentIndex]
      ];
    }
  }

  //#endregion
}
