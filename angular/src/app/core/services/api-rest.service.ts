// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { RestGame } from '../../views/replay_cutter/models/rest-game';
import { Observable } from 'rxjs';
import { Team } from './identity/model/team.model';

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
   * Retrieves the player's filtered EVA games.
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
   * Retrieves the list of user IDs who have access to the beta program.
   * @returns An Observable emitting an array of user IDs.
   */
  public getBetaUsers(): Observable<number[]> {
    const PARAMS = new HttpParams().set('r', 'betaUsers');
    return this.httpClient.get<number[]>(APIRestService.serverURL, {
      params: PARAMS
    });
  }

  /**
   * Retrieves the number of tokens available in the current user's account.
   * @returns An Observable emitting the token count as a number.
   */
  public getMyCoins(): Observable<number> {
    const PARAMS = new HttpParams().set('r', 'coins');
    return this.httpClient.get<number>(APIRestService.serverURL, {
      params: PARAMS
    });
  }

  /**
   * Fetches the list of teams managed by the current user.
   * @returns An Observable emitting an array of Team objects.
   */
  public getMyTeams(): Observable<Team[]> {
    const PARAMS = new HttpParams().set('r', 'teams');
    return this.httpClient.get<Team[]>(APIRestService.serverURL, {
      params: PARAMS
    });
  }

  //#endregion
}
