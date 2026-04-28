// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

export interface Message {
  //#region Attributes

  percent: number;
  infinite: boolean;
  icon: string | undefined;
  text: string;
  textParams?: Record<string, unknown>;
  leftRounded: boolean;
  state: 'info' | 'success' | 'error';

  //#endregion
}
