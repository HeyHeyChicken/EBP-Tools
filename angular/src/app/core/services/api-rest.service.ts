// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable } from '@angular/core';

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
   * Cette fonction retourne les games EVA du joueur filtrées.
   * @param mapName Nom de la carte.
   * @param orangeScore Score de l'équipe orange.
   * @param blueScore Score de l'équipe bleu.
   * @param callback Fonction de retour.
   */
  public getGames(
    mapName: string,
    orangeScore: number,
    blueScore: number,
    callback: Function
  ): void {
    const PARAMS = new HttpParams()
      .set('r', 'games')
      .set('map', mapName)
      .set('orangeScore', orangeScore.toString())
      .set('blueScore', blueScore.toString());

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
