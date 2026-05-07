// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { Player } from './player';

//#endregion

export class Team {
  //#region Attributes

  public score: number = 0;
  public players: Player[] = [];

  public nameImage: string | undefined;
  public scoreImage: string | undefined;

  //#endregion
}
