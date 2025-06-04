// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

class Step {
  constructor(
    x /* number */,
    y /* number */,
    dead = false /* boolean */,
    step = 0 /* number */
  ) {
    this.x = x;
    this.y = y;
    this.dead = dead;
    this.step = step;
  }
}
