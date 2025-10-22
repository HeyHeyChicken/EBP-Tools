// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

export interface LogData {
  level: 'log' | 'error' | 'warn' | 'info' | 'debug';
  message: string;
  timestamp: string;
  source: string;
}
