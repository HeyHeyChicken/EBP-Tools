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
import { TranslateModule } from '@ngx-translate/core';
import { Versions } from '../models/versions';
import { IdentityService } from './core/services/identity.service';

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
    private readonly identityService: IdentityService
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
    window.electronAPI.getOS().then((os: NodeJS.Platform) => {
      this.ngZone.run(() => {
        this.globalService.os = os;
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
        this.versions = versions;
      });
    });

    // Getting the web server port.
    window.electronAPI.getExpressPort().then((serverPort: number) => {
      this.ngZone.run(() => {
        this.globalService.serverPort = serverPort;
      });
    });

    // Getting logged user informations from his JWT.
    window.electronAPI.getJWTAccessToken().then((accessToken: string) => {
      this.identityService.set(accessToken);
    });
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
    window.electronAPI.debugMode();
  }

  protected onNewUpdateLinkClick(): void {
    window.electronAPI.openURL(
      'https://github.com/HeyHeyChicken/EBP-EVA-Battle-Plan-Tools/releases/latest'
    );
  }
  //#endregion
}
