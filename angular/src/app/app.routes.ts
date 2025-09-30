// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { Routes } from '@angular/router';
import { HomeComponent } from './views/home/home.component';
import { ReplayCutterComponent } from './views/replay_cutter/replay_cutter.component';
import { GameHistoryComponent } from './views/game_history/game_history.component';
import { ReplayDownloaderComponent } from './views/replay_downloader/replay_downloader.component';

//#endregion

export const routes: Routes = [
  {
    path: ':lang',
    children: [
      {
        path: '',
        component: HomeComponent
      },
      {
        path: 'replay_cutter',
        component: ReplayCutterComponent
      },
      {
        path: 'game_history',
        component: GameHistoryComponent
      },
      {
        path: 'replay_downloader',
        component: ReplayDownloaderComponent
      },
      {
        path: 'notification',
        loadChildren: () =>
          import('./views/notification/notification-routing.module').then(
            (m) => {
              return m.NotificationRoutingModule;
            }
          )
      }
    ]
  }
];
