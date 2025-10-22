// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { Injectable } from '@angular/core';
import { GlobalService } from '../global.service';
import { Team } from './model/team.model';

//#endregion

@Injectable({
  providedIn: 'root'
})
export class IdentityService {
  //#region Attributes

  private _accessToken: string = '';
  private _userID: number = 0;
  private _leaderID: number = 0;
  private _email: number = 0;
  private _supporterLevel: number = 0;

  public teams: Team[] = [];
  public selectedTeamsIndex: number = 0;

  public coins: number | undefined;

  //#endregion

  constructor(private readonly globalService: GlobalService) {}

  //#region Functions

  /**
   * Sets the access token and extracts user information from its payload.
   * Updates user ID, leader ID, email, and supporter level based on the token data.
   * @param accessToken JWT access token containing user information.
   */
  public set(accessToken: string) {
    if (accessToken) {
      this._accessToken = accessToken;

      const PAYLOAD = accessToken.split('.')[1];
      const DATA = JSON.parse(atob(PAYLOAD));
      console.log(DATA);

      this._userID = parseInt(DATA.userID);
      this._leaderID = parseInt(DATA.sub);

      this._email = DATA.email;

      this._supporterLevel = parseInt(DATA.supporterLevel);
      if (isNaN(this._supporterLevel)) {
        this._supporterLevel = 0;
      }
    }
  }

  //#region Getters

  /**
   * Returns the currently stored access token.
   */
  public get accessToken(): string {
    return this._accessToken;
  }

  /**
   * Returns the user ID extracted from the access token.
   */
  public get userID(): number {
    return this._userID;
  }

  /**
   * Returns the leader ID extracted from the access token.
   */
  public get leaderID(): number {
    return this._leaderID;
  }

  /**
   * Returns the email associated with the current user.
   */
  public get email(): number {
    return this._email;
  }

  /**
   * Returns the supporter level of the current user, as extracted from the access token.
   */
  public get supporterLevel(): number {
    return this._supporterLevel;
  }

  /**
   * Checks if the current user is part of the beta program.
   * @returns True if the user ID is in the beta users list, false otherwise.
   */
  public get isBetaUser(): boolean {
    return (this.globalService.betaUsers ?? []).includes(this._userID);
  }

  //#endregion

  //#endregion
}
