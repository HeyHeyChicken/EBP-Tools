// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

export class Settings {
  constructor(
    public orangeTeamName: string = '',
    public blueTeamName: string = '',
    public maxTimePerGame: number = 10,
    public freeText: string = ''
  ) {}
}
