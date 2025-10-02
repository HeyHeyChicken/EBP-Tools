// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import {
  Component,
  ElementRef,
  HostListener,
  NgZone,
  OnInit,
  ViewChild
} from '@angular/core';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { HeaderComponent } from './shared/header/header.component';
import { WizzComponent } from './shared/wizz/wizz.component';
import { FooterComponent } from './shared/footer/footer.component';
import { CommonModule } from '@angular/common';
import { GlobalService } from './core/services/global.service';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Versions } from '../models/versions';
import { IdentityService } from './core/services/identity.service';
import { APIRestService } from './core/services/api-rest.service';
import { ToastrService } from 'ngx-toastr';

//#endregion
@Component({
  selector: 'app-root',
  imports: [
    RouterOutlet,
    HeaderComponent,
    WizzComponent,
    FooterComponent,
    CommonModule,
    TranslateModule
  ],
  templateUrl: './app.html',
  styleUrls: ['./app.scss']
})
export class App implements OnInit {
  //#region Attributes

  /** Conteneur principal de la page. */
  @ViewChild('main')
  private readonly main: ElementRef<HTMLElement> | undefined;

  protected versions: Versions | undefined;

  //#endregion
  constructor(
    protected readonly globalService: GlobalService,
    private readonly router: Router,
    private readonly ngZone: NgZone,
    private readonly identityService: IdentityService,
    private readonly apiRestService: APIRestService,
    private readonly translateService: TranslateService,
    private readonly toastrService: ToastrService
  ) {}

  //#region Functions

  ngOnInit(): void {
    // On scroll vers le haut à chaque fois que l'utilisateur change de page.
    this.router.events.subscribe((event) => {
      if (this.main) {
        if (event instanceof NavigationEnd) {
          this.main.nativeElement.scrollTo(0, 0);
        }
      }
    });

    // Getting the user's operating system.
    window.electronAPI?.getOS().then((os: NodeJS.Platform) => {
      this.ngZone.run(() => {
        this.globalService.os = os;
      });
    });

    window.electronAPI?.isDevMode().then((devMode: boolean) => {
      this.ngZone.run(() => {
        this.globalService.devMode = devMode;
      });
    });

    // Getting the project version.
    window.electronAPI?.getVersion().then((versions: Versions) => {
      this.ngZone.run(() => {
        this.versions = new Versions(versions.current, versions.last);
      });
    });

    // Getting the web server port.
    window.electronAPI?.getExpressPort().then((serverPort: number) => {
      this.ngZone.run(() => {
        this.globalService.serverPort = serverPort;
      });
    });

    window.electronAPI?.setJWTAccessToken((accessToken: string) => {
      this.ngZone.run(() => {
        this.identityService.set(accessToken);

        if (this.globalService.betaUsers === undefined) {
          this.apiRestService.getBetaUsers((betaUsers: number[]) => {
            this.globalService.betaUsers = betaUsers;

            this.apiRestService.getCoins((nbCoins: number) => {
              this.identityService.coins = nbCoins;
            });
          });
        }
      });
    });

    // Getting logged user informations from his JWT.
    window.electronAPI?.getJWTAccessToken();

    window.electronAPI?.error((i18nPath: string, i18nVariables: object) => {
      this.ngZone.run(() => {
        this.globalService.loading = undefined;

        this.translateService
          .get(i18nPath, i18nVariables)
          .subscribe((translated: string) => {
            this.toastrService.error(translated);
          });
      });
    });

    window.electronAPI?.globalMessage(
      (i18nPath: string, i18nVariables: object) => {
        this.ngZone.run(() => {
          this.translateService
            .get(i18nPath, i18nVariables)
            .subscribe((translated: string) => {
              this.globalService.loading = translated;
            });
        });
      }
    );
  }

  @HostListener('document:keydown', ['$event'])
  handleKeyboardEvent(event: KeyboardEvent) {
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'd') {
      this.debugMode();
    }
  }

  /**
   * This function enables/disables debug mode.
   */
  debugMode(): void {
    window.electronAPI?.debugMode();
  }

  protected onNewUpdateLinkClick(): void {
    window.electronAPI?.openURL(
      'https://github.com/HeyHeyChicken/EBP-EVA-Battle-Plan-Tools/releases/latest'
    );
  }
  //#endregion
}
