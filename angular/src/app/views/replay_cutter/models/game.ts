// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { Team } from './team';

//#endregion

export class Game {
  //#region Attributes

  public checked: boolean = false;

  //#region Debug

  public __debug__jumped: boolean = false;

  //#endregion

  //#region Start

  private _readableStart: string = '';

  private _start: number = -1;

  public set start(value: number) {
    this._start = value;
    this._readableStart = this.readTime(value);
  }

  //#endregion

  //#region End

  private _readableEnd: string = '';

  private _end: number = -1;

  public set end(value: number) {
    this._end = value;
    this._readableEnd = this.readTime(value);
  }

  //#endregion

  public map: string = '';
  public splitted: boolean = false;

  public orangeTeam: Team = new Team();
  public blueTeam: Team = new Team();

  //#endregion

  constructor(public mode: number) {}

  //#region Functions

  public get start(): number {
    return this._start;
  }

  public get end(): number {
    return this._end;
  }
  public get readableEnd(): string {
    return this._readableEnd;
  }

  public get readableStart(): string {
    return this._readableStart;
  }

  private readTime(secondes: number): string {
    const HOURS: number = Math.floor(
      secondes / 60 /* minutes */ / 60 /* heures */
    );
    const MINUTES: number = Math.floor(
      secondes / 60 /* minutes */ - HOURS * 60
    );
    const SECONDES: number = Math.round(
      secondes - HOURS * 60 * 60 - MINUTES * 60
    );

    return (
      (HOURS == 0 ? '' : HOURS + ':') +
      this.twoDigits(MINUTES) +
      ':' +
      this.twoDigits(SECONDES)
    );
  }

  private twoDigits(input: number): string {
    if (input < 10) {
      return '0' + input;
    }
    return input.toString();
  }

  //#endregion
}
