// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

class Team {
  constructor(
    name /* string */ = "",
    score = 0 /* number */,
    players = [] /* Player[] */
  ) {
    this.name = name;
    this.score = score;
    this.players = players;
  }
}
