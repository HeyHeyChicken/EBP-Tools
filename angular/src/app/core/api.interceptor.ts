// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { HttpEvent, HttpHandlerFn, HttpRequest } from '@angular/common/http';
import { inject } from '@angular/core';
import { Observable } from 'rxjs';
import { IdentityService } from './services/identity.service';

//#endregion

export function APIInterceptor(
  req: HttpRequest<unknown>,
  next: HttpHandlerFn
): Observable<HttpEvent<unknown>> {
  //#region Imports

  const IDENTITY_SERVICE = inject(IdentityService);

  //#endregion

  const INCLUDED_URLS: string[] = ['https://evabattleplan.com/back/api-tools/'];

  if (
    !IDENTITY_SERVICE.accessToken ||
    !INCLUDED_URLS.some((includedUrl) => req.url.startsWith(includedUrl))
  ) {
    return next(req);
  }

  const NEW_REQ = req.clone({
    setHeaders: {
      Authorization: `Bearer ${IDENTITY_SERVICE.accessToken}`
    }
  });

  return next(NEW_REQ);
}
