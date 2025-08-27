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

  private _accessToken: string = '';
  private _userID: number = 0;
  private _supporterLevel: number = 0;

  //#endregion

  //#region Functions

  public set(accessToken: string) {
    this._accessToken = accessToken;

    const PAYLOAD = accessToken.split('.')[1];
    const DATA = JSON.parse(atob(PAYLOAD));

    this._userID = DATA.sub;
    this._supporterLevel = parseInt(DATA.supporterLevel);
  }

  //#region Getters

  public get accessToken(): string {
    return this._accessToken;
  }

  public get userID(): number {
    return this._userID;
  }

  public get supporterLevel(): number {
    return this._supporterLevel;
  }

  //#endregion

  //#endregion
}
