// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { Game } from '../../../replay_cutter/models/game';

//#endregion

export interface Message {
  //#region Attributes

  games: Game[];
  percent: number;

  //#endregion
}
