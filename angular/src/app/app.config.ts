// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import {
  ApplicationConfig,
  importProvidersFrom,
  provideBrowserGlobalErrorListeners,
  provideZoneChangeDetection
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes';
import { TranslateModule } from '@ngx-translate/core';
import { provideToastr } from 'ngx-toastr';
import { provideHttpClient } from '@angular/common/http';
import { provideTranslateHttpLoader } from '@ngx-translate/http-loader';
import { provideAnimations } from '@angular/platform-browser/animations';

//#endregion

export const appConfig: ApplicationConfig = {
  providers: [
    provideAnimations(),
    provideHttpClient(),
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    importProvidersFrom(TranslateModule.forRoot()),
    provideTranslateHttpLoader({
      prefix: '/assets/i18n/',
      suffix: '.json'
    }),
    provideToastr({
      positionClass: 'toast-bottom-right'
    })
  ]
};
