// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import type { Config } from 'jest';
import { createCjsPreset } from 'jest-preset-angular/presets';

//#endregion

export default {
  ...createCjsPreset(),
  setupFilesAfterEnv: ['<rootDir>/setup-jest.ts']
} satisfies Config;
