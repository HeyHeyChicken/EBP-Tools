// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { RestGame } from '../../views/replay_cutter/models/rest-game';
import { Observable } from 'rxjs';

//#endregion

@Injectable({
  providedIn: 'root'
})
export class APIRestService {
  //#region Attributes

  private static serverURL: string =
    'https://evabattleplan.com/back/api-tools/';

  //#endregion

  constructor(protected readonly httpClient: HttpClient) {}

  //#region Functions

  /**
   * This function returns the player's filtered EVA games.
   * @param mapName Name of the card.
   * @param orangeScore Orange team score.
   * @param blueScore Blue team score.
   */
  public getGames(
    mapName: string,
    orangeScore: number,
    blueScore: number
  ): Observable<RestGame[]> {
    const params = new HttpParams()
      .set('r', 'games')
      .set('map', mapName)
      .set('orangeScore', orangeScore.toString())
      .set('blueScore', blueScore.toString());

    return this.httpClient.get<RestGame[]>(APIRestService.serverURL, {
      params
    });
  }

  /**
   * This function returns the list of users who have access to BETA features.
   * @param callback Callback fonction.
   */
  public getBetaUsers(callback: Function): void {
    const PARAMS = new HttpParams().set('r', 'betaUsers');

    this.httpClient
      .get<any>(APIRestService.serverURL, {
        responseType: 'text' as 'json',
        params: PARAMS
      })
      .subscribe((response: string) => {
        callback(JSON.parse(response));
      });
  }

  //#endregion
}
