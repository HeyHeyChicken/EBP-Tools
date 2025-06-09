// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { Routes } from "@angular/router";
import { HomeComponent } from "./views/home/home.component";

//#endregion

export const routes: Routes = [
  {
    path: "",
    component: HomeComponent,
  },
];
