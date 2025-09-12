// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

export class Versions {
  constructor(
    public current: string,
    public last: string
  ) {}

  //#region Functions

  public get isUpToDate(): number {
    const CURRENT = this.current.split('.').map(Number);
    const LAST = this.last.split('.').map(Number);
    const MAX_LENGTH = Math.max(CURRENT.length, LAST.length);

    for (let i = 0; i < MAX_LENGTH; i++) {
      const diff = (CURRENT[i] || 0) - (LAST[i] || 0);
      if (diff !== 0) {
        return diff; // <0: current < last, >0: current > last
      }
    }
    return 0; // current == last
  }

  //#endregion
}
