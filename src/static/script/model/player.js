// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

class Player {
  constructor(
    number /* number */,
    name /* string */,
    score = 0 /* number */,
    kills = 0 /* number */,
    deads = 0 /* number */,
    assistances = 0 /* number */
  ) {
    this.number = number;
    this.name = name;
    this.score = score;
    this.kills = kills;
    this.deads = deads;
    this.assistances = assistances;
    this.steps /* Step[] */ = [];
  }
}
