// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import {
  Component,
  ElementRef,
  NgZone,
  OnInit,
  ViewChild
} from '@angular/core';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { HeaderComponent } from './shared/header/header.component';
import { WizzComponent } from './shared/wizz/wizz.component';

import { GlobalService } from './core/services/global.service';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { Versions } from '../models/versions';
import { IdentityService } from './core/services/identity/identity.service';
import { APIRestService } from './core/services/api-rest.service';
import { ToastrService } from 'ngx-toastr';
import { Team } from './core/services/identity/model/team.model';
import { ConsoleComponent } from './shared/console/console.component';
import { AccessibilitySettingsDTO } from './core/services/identity/model/accessibility-settings.model';
import { MatDialog } from '@angular/material/dialog';
import { LinuxIntroDialog } from './views/home/dialogs/linux-intro/linux-intro.dialog';
import { MatTooltipModule } from '@angular/material/tooltip';
import { NotificationService } from './views/notification/services/notification.service';
import { ReplayCutterService } from './views/replay_cutter/services/replay-cutter.service';
import { Message } from './views/notification/models/message.model';

//#endregion
@Component({
  selector: 'app-root',
  imports: [
    RouterOutlet,
    HeaderComponent,
    WizzComponent,
    TranslateModule,
    ConsoleComponent,
    MatTooltipModule
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

  @ViewChild(ConsoleComponent) consoleComponent!: ConsoleComponent;

  //#endregion
  constructor(
    protected readonly globalService: GlobalService,
    private readonly router: Router,
    private readonly ngZone: NgZone,
    private readonly identityService: IdentityService,
    private readonly apiRestService: APIRestService,
    private readonly translateService: TranslateService,
    private readonly toastrService: ToastrService,
    private readonly elementRef: ElementRef,
    private readonly dialogService: MatDialog,
    private readonly notificationService: NotificationService
  ) {}

  //#region Functions

  ngOnInit(): void {
    const SPLITED = globalThis.location.pathname
      .split('/')
      .filter((x) => x && x.trim().length > 0);
    // If the language is not in the URL...
    if (SPLITED.length == 0 || SPLITED[0].length != 2) {
      const URL = `/${this.translateService.getCurrentLang() ?? 'en'}${SPLITED.slice(1).join('/')}`;
      this.router.navigate([URL]);
    }

    // We scroll up each time the user changes pages.
    this.router.events.subscribe((event) => {
      if (this.main) {
        if (event instanceof NavigationEnd) {
          this.main.nativeElement.scrollTo(0, 0);
        }
      }
    });

    // Getting the web server port.
    window.electronAPI.getExpressPort().then((serverPort: number) => {
      this.ngZone.run(() => {
        this.globalService.serverPort = serverPort;
      });
    });

    if (SPLITED[1] != 'notification') {
      // Getting the user's operating system.
      window.electronAPI.getOS().then((os: NodeJS.Platform) => {
        this.ngZone.run(() => {
          this.globalService.os = os;

          if (os == 'linux') {
            if (SPLITED[1] != 'notification') {
              this.dialogService.open(LinuxIntroDialog);
            }
          }
        });
      });

      window.electronAPI.isDevMode().then((devMode: boolean) => {
        this.ngZone.run(() => {
          this.globalService.devMode = devMode;
        });
      });

      // Getting the project version.
      window.electronAPI.getVersion().then((versions: Versions) => {
        this.ngZone.run(() => {
          this.versions = new Versions(versions.current, versions.last);
        });
      });

      window.electronAPI.setJWTAccessToken((accessToken: string) => {
        this.ngZone.run(() => {
          this.identityService.set(accessToken);

          if (this.globalService.betaUsers === undefined) {
            this.apiRestService
              .getBetaUsers()
              .subscribe((betaUsers: number[]) => {
                this.globalService.betaUsers = betaUsers;

                this.apiRestService.getMyTeams().subscribe((teams: Team[]) => {
                  this.identityService.teams = teams;
                });

                // Get account accessibility settings
                this.apiRestService
                  .getAccessibilitySettings()
                  .subscribe(
                    (
                      accessibilitySettings: AccessibilitySettingsDTO | null
                    ) => {
                      if (accessibilitySettings) {
                        this.identityService.accessibilitySettings.saturation =
                          accessibilitySettings.saturation;
                        this.identityService.accessibilitySettings.contrast =
                          accessibilitySettings.contrast;
                        this.identityService.accessibilitySettings.protanopia =
                          accessibilitySettings.protanopia;
                        this.identityService.accessibilitySettings.deuteranopia =
                          accessibilitySettings.deuteranopia;
                        this.identityService.accessibilitySettings.tritanopia =
                          accessibilitySettings.tritanopia;
                        this.updateAccessibilityFilter();
                      }
                    }
                  );
              });
          }
        });
      });

      window.electronAPI.toast(
        (
          type: 'success' | 'error' | 'warning' | 'info',
          i18nPath: string,
          i18nVariables: object
        ) => {
          this.ngZone.run(() => {
            this.translateService
              .get(i18nPath, i18nVariables)
              .subscribe((translated: string) => {
                switch (type) {
                  case 'success':
                    this.toastrService.success(translated);
                    break;
                  case 'error':
                    this.toastrService.error(translated);
                    break;
                  case 'warning':
                    this.toastrService.warning(translated);
                    break;
                  case 'info':
                    this.toastrService.info(translated);
                    break;
                }
              });
          });
        }
      );

      // The server update the notification informations
      window.electronAPI.setNotificationData((message: Message) => {
        this.ngZone.run(() => {
          this.notificationService.sendMessage(message);
        });
      });

      window.electronAPI.globalMessage(
        (i18nPath: string, i18nVariables: object) => {
          this.ngZone.run(() => {
            if (i18nPath) {
              this.translateService
                .get(i18nPath, i18nVariables)
                .subscribe((translated: string) => {
                  this.globalService.loading = translated;
                });
            } else {
              this.globalService.loading = undefined;
            }
          });
        }
      );

      // Getting logged user informations from his JWT.
      window.electronAPI.getJWTAccessToken();
      window.electronAPI.checkJwtToken();
    }
  }

  /**
   * Opens the GitHub releases page in the user's default browser to download the latest application update.
   * This method is called when the user clicks on a new update notification link.
   */
  protected onNewUpdateLinkClick(): void {
    window.electronAPI.openURL(
      'https://github.com/HeyHeyChicken/EBP-Tools/releases/latest'
    );
  }

  /**
   * Updates the element's CSS filter based on user accessibility settings.
   * Adjusts saturation and contrast, and applies approximated color adjustments for protanopia, deuteranopia, and tritanopia according to the configured intensity.
   */
  private updateAccessibilityFilter() {
    let filter = `saturate(${
      (this.identityService.accessibilitySettings.saturation ?? 50) / 50
    }) contrast(${(100 + (this.identityService.accessibilitySettings.contrast ?? 0)) / 100})`;

    // Approximations CSS pour les différents types de daltonisme
    if (this.identityService.accessibilitySettings.protanopia > 0) {
      const intensity =
        this.identityService.accessibilitySettings.protanopia / 100;
      filter += ` hue-rotate(${-20 * intensity}deg) saturate(${1 + 0.5 * intensity}) sepia(${
        0.2 * intensity
      })`;
    }

    if (this.identityService.accessibilitySettings.deuteranopia > 0) {
      const intensity =
        this.identityService.accessibilitySettings.deuteranopia / 100;
      filter += ` hue-rotate(${25 * intensity}deg) saturate(${1 + 0.4 * intensity}) sepia(${
        0.15 * intensity
      })`;
    }

    if (this.identityService.accessibilitySettings.tritanopia > 0) {
      const intensity =
        this.identityService.accessibilitySettings.tritanopia / 100;
      filter += ` hue-rotate(${-40 * intensity}deg) saturate(${1 + 0.3 * intensity}) sepia(${
        0.25 * intensity
      }) brightness(${1 + 0.1 * intensity})`;
    }

    this.elementRef.nativeElement.style.filter = filter;
  }

  //#endregion
}
