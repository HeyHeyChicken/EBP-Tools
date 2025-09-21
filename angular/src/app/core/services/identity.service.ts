// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { Injectable } from '@angular/core';
import { GlobalService } from './global.service';

//#endregion

@Injectable({
  providedIn: 'root'
})
export class IdentityService {
  //#region Attributes

  private _accessToken: string = '';
  private _userID: number = 0;
  private _email: number = 0;
  private _supporterLevel: number = 0;

  //#endregion

  constructor(private readonly globalService: GlobalService) {}

  //#region Functions

  public set(accessToken: string) {
    this._accessToken = accessToken;

    const PAYLOAD = accessToken.split('.')[1];
    const DATA = JSON.parse(atob(PAYLOAD));

    this._userID = parseInt(DATA.sub);

    this._email = DATA.email;

    this._supporterLevel = parseInt(DATA.supporterLevel);
    if (isNaN(this._supporterLevel)) {
      this._supporterLevel = 0;
    }
  }

  //#region Getters

  public get accessToken(): string {
    return this._accessToken;
  }

  public get userID(): number {
    return this._userID;
  }

  public get email(): number {
    return this._email;
  }

  public get supporterLevel(): number {
    return this._supporterLevel;
  }

  public get isBetaUser(): boolean {
    return this.globalService.betaUsers.includes(this._userID);
  }

  //#endregion

  //#endregion
}
