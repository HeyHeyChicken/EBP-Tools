// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

class Game {
  constructor() {
    this.ID = undefined;
    this.__debug__jumped = false;
    this._readableStart = "";
    this._start = -1;
    this._readableEnd = "";
    this._end = -1;
    this.date = undefined;
    this.name = "";
    this.map = "";
    this.file = "";
    this.splitted = false;
    this.orangeTeam = new Team();
    this.blueTeam = new Team();
  }

  get readableStart() {
    return this._readableStart;
  }
  get start() {
    return this._start;
  }
  set start(value) {
    this._start = value;
    this._readableStart = this._readTime(value);
  }

  get readableEnd() {
    return this._readableEnd;
  }
  get end() {
    return this._end;
  }
  set end(value) {
    this._end = value;
    this._readableEnd = this._readTime(value);
  }

  get duration() {
    return this._end !== -1 && this._start !== -1 ? this._end - this._start : 0;
  }

  get readableDuration() {
    return this.duration > 0 ? this._readTime(this.duration) : "0";
  }

  get readableDate() {
    if (!this.date) return "";
    return (
      this._twoDigits(this.date.getDate()) +
      "/" +
      this._twoDigits(this.date.getMonth() + 1) +
      "/" +
      this.date.getFullYear()
    );
  }

  get bddDate() {
    if (!this.date) return "";
    return (
      this.date.getFullYear() +
      "-" +
      this._twoDigits(this.date.getMonth() + 1) +
      "-" +
      this._twoDigits(this.date.getDate())
    );
  }

  _readTime(seconds) {
    const HOURS = Math.floor(seconds / 3600);
    const MINUTES = Math.floor(seconds / 60) - HOURS * 60;
    const SECONDS = Math.round(seconds - HOURS * 3600 - MINUTES * 60);
    return (
      (HOURS === 0 ? "" : HOURS + ":") +
      String(MINUTES).padStart(2, "0") +
      ":" +
      String(SECONDS).padStart(2, "0")
    );
  }

  _twoDigits(input) {
    return input < 10 ? "0" + input : input.toString();
  }
}
