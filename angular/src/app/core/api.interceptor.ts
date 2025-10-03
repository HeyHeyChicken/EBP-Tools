// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import {
  HttpEvent,
  HttpHandlerFn,
  HttpRequest,
  HttpErrorResponse
} from '@angular/common/http';
import { inject } from '@angular/core';
import { Observable, catchError, throwError, retry, timer, defer } from 'rxjs';
import { IdentityService } from './services/identity/identity.service';

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

  return defer(() => {
    // The token is recovered on each attempt
    const NEW_REQ = req.clone({
      setHeaders: {
        Authorization: `Bearer ${IDENTITY_SERVICE.accessToken}`
      }
    });
    return next(NEW_REQ);
  }).pipe(
    retry({
      count: 5,
      delay: (error: HttpErrorResponse, retryCount: number) => {
        if (error.status === 401) {
          window.electronAPI?.checkJwtToken();
          // Retry with exponential backoff: 1s, 2s, 4s, 8s, 16s
          return timer(Math.pow(2, retryCount - 1) * 1000);
        }
        // For non-401 errors, don't retry
        return throwError(() => error);
      }
    }),
    catchError((error: HttpErrorResponse) => {
      if (error.status === 401) {
        window.electronAPI?.checkJwtToken();
      }
      return throwError(() => error);
    })
  );
}
