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
  ViewChild,
} from '@angular/core';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { HeaderComponent } from './shared/header/header.component';
import { WizzComponent } from './shared/wizz/wizz.component';
import { FooterComponent } from './shared/footer/footer.component';
import { CommonModule } from '@angular/common';
import { GlobalService } from './core/services/global.service';
import { TranslateModule } from '@ngx-translate/core';

//#endregion

declare let cv: any;

interface Versions {
  current: string;
  last: string;
}

@Component({
  selector: 'app-root',
  imports: [
    RouterOutlet,
    HeaderComponent,
    WizzComponent,
    FooterComponent,
    CommonModule,
    TranslateModule,
  ],
  templateUrl: './app.html',
  styleUrls: ['./app.scss'],
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
    private readonly ngZone: NgZone
  ) {}

  //#region Functions

  ngOnInit(): void {
    this.loadOpenCV();

    // On scroll vers le haut à chaque fois que l'utilisateur change de page.
    this.router.events.subscribe((event) => {
      if (this.main) {
        if (event instanceof NavigationEnd) {
          this.main.nativeElement.scrollTo(0, 0);
        }
      }
    });

    // Getting the user's operating system.
    //@ts-ignore
    window.electronAPI.getOS().then((os: any) => {
      this.ngZone.run(() => {
        this.globalService.os = os;
      });
    });

    //@ts-ignore
    window.electronAPI.isDevMode().then((devMode: boolean) => {
      this.ngZone.run(() => {
        this.globalService.devMode = devMode;
      });
    });

    // Getting the project version.
    //@ts-ignore
    window.electronAPI.getVersion().then((versions: any) => {
      this.ngZone.run(() => {
        this.versions = versions;
      });
    });

    // Getting the web server port.
    //@ts-ignore
    window.electronAPI.getExpressPort().then((serverPort: number) => {
      this.ngZone.run(() => {
        this.globalService.serverPort = serverPort;
      });
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
    //@ts-ignore
    window.electronAPI.debugMode();
  }

  protected onNewUpdateLinkClick(): void {
    //@ts-ignore
    window.electronAPI.openURL(
      'https://github.com/HeyHeyChicken/EBP-EVA-Battle-Plan-Tools/releases/latest'
    );
  }

  /**
   * This function injects the OpenCV.js library.
   */
  private loadOpenCV(callback?: Function): void {
    const OPENCV_URL: string = '/assets/js/opencv/opencv.js';

    const SCRIPT: HTMLScriptElement = document.createElement('script');
    SCRIPT.setAttribute('async', '');
    SCRIPT.setAttribute('type', 'text/javascript');

    SCRIPT.addEventListener('load', async () => {
      if (cv.getBuildInformation) {
        if (callback) {
          callback();
        }
      } else {
        // WASM
        if (cv instanceof Promise) {
          cv = await cv;
          if (callback) {
            callback();
          }
        } else {
          cv['onRuntimeInitialized'] = () => {
            if (callback) {
              callback();
            }
          };
        }
      }
    });

    SCRIPT.addEventListener('error', () => {
      console.error('Failed to load ' + OPENCV_URL);
    });

    SCRIPT.src = OPENCV_URL;

    const NODE: HTMLScriptElement = document.getElementsByTagName('script')[0];
    NODE.parentNode?.insertBefore(SCRIPT, NODE);
  }

  //#endregion
}
