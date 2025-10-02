// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

export interface Message {
  //#region Attributes

  percent: number;
  infinite: boolean;
  icon: string | undefined;
  text: string;

  //#endregion
}
