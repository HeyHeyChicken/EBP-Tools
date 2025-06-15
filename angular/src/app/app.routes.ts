// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { Routes } from '@angular/router';
import { HomeComponent } from './views/home/home.component';
import { ReplayCutterComponent } from './views/replay_cutter/replay_cutter.component';
import { GameHistoryComponent } from './views/game_history/game_history.component';

//#endregion

export const routes: Routes = [
  {
    path: '',
    component: HomeComponent,
  },
  {
    path: 'replay_cutter',
    component: ReplayCutterComponent,
  },
  {
    path: 'game_history',
    component: GameHistoryComponent,
  },
];
