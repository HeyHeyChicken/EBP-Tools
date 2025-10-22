// Copyright (c) 2025, Antoine Duval
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

  //#region Functions

  public coinsCheckerLoop(
    loopIndex: number = 0,
    maxLoop: number = (60 * 5) / 3
  ): void {
    const OLD_COINS_VALUE = this.identityService.coins;
    this.apiRestService.getMyCoins().subscribe((coins: number) => {
      console.log(coins);
      this.identityService.coins = coins;
      if (OLD_COINS_VALUE == coins) {
        if (loopIndex < maxLoop) {
          setTimeout(() => {
            this.coinsCheckerLoop(loopIndex + 1);
          }, 1000 * 3);
        }
      }

      this.identityService.coins = coins;
    });
  }

  //#endregion
}
