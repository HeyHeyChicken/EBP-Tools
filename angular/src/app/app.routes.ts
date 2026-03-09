// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { Routes } from '@angular/router';
import { HomeComponent } from './views/home/home.component';
import { ReplayCutterComponent } from './views/replay_cutter/replay_cutter.component';
import { ReplayDownloaderComponent } from './views/replay_downloader/replay_downloader.component';
import { NotificationComponent } from './views/notification/notification.component';

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
        path: 'replay_downloader',
        component: ReplayDownloaderComponent
      },
      {
        path: 'notification',
        component: NotificationComponent
      }
    ]
  }
];
