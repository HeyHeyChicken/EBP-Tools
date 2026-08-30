// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { inject } from '@angular/core';
import {
  ActivatedRouteSnapshot,
  CanActivateFn,
  Router,
  UrlTree
} from '@angular/router';
import { ArenaModeState } from '../../../models/electron';

//#endregion

/**
 * Default page guard: when the room mode is registered with a key, the home page is replaced by the arena mode page.
 */
export const arenaModeHomeGuard: CanActivateFn = async (
  route: ActivatedRouteSnapshot
): Promise<boolean | UrlTree> => {
  const ROUTER: Router = inject(Router);
  const STATE: ArenaModeState = await window.electronAPI.arenaModeGetState();

  if (!STATE.registered) {
    return true;
  }

  const LANG: string =
    route.parent?.params['lang'] ?? route.params['lang'] ?? 'en';
  return ROUTER.createUrlTree([LANG, 'arena_mode']);
};
