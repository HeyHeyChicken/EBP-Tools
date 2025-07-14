// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { Injectable } from '@angular/core';

//#endregion

@Injectable({
  providedIn: 'root'
})
export class IdentityService {
  //#region Attributes

  public id: number = 0;
  public premium: boolean = false;

  //#endregion
}
