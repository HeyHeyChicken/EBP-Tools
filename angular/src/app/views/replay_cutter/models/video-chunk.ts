// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

export class VideoChunk {
  constructor(
    public start: number,
    public end: number,
    public remove: boolean = false
  ) {}
}
