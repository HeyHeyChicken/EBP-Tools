// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

export class Map {
  constructor(
    public name: string,
    public dictionnary: string[],
    public isAICompatible: boolean = false
  ) {}
}
