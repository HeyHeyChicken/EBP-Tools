// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { CommonModule } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { GridModule } from '../../shared/grid/grid.module';
import { MatInputModule } from '@angular/material/input';

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
  ],
})
export class GameHistoryComponent implements OnInit {
  //#region Attributes

  //#endregion

  constructor() {}

  //#region Functions

  ngOnInit(): void {}

  protected onPublicPseudoChange(): void {}

  //#endregion
}
