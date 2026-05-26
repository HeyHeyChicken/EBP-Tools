// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { Injectable } from '@angular/core';
import { APIRestService } from '../../../core/services/api-rest.service';
import { IdentityService } from '../../../core/services/identity/identity.service';

//#endregion

@Injectable({
  providedIn: 'root'
})
export class HeaderService {
  //#region Attributes

  public showCoinsPopup: boolean = false;
  public coinsCheckerInterval: NodeJS.Timeout | undefined;

  //#endregion

  constructor(
    private readonly identityService: IdentityService,
    private readonly apiRestService: APIRestService
  ) {}
}
