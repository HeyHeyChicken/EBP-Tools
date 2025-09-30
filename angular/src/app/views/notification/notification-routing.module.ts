// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { NotificationRootComponent } from './root/root.component';
import { NotificationAnalysingComponent } from './analysing/analysing.component';

//#endregion

const ROUTES: Routes = [
  {
    path: '',
    component: NotificationRootComponent,
    children: [{ path: 'analysing', component: NotificationAnalysingComponent }]
  }
];

@NgModule({
  imports: [RouterModule.forChild(ROUTES)],
  exports: [RouterModule]
})
export class NotificationRoutingModule {}
