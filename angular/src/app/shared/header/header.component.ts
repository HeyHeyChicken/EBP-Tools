// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Import

import { Component, OnInit } from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { CommonModule, Location as CommonLocation } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectChange, MatSelectModule } from '@angular/material/select';
import { IdentityService } from '../../core/services/identity/identity.service';
import { GlobalService } from '../../core/services/global.service';
import { MatTooltipModule } from '@angular/material/tooltip';
import { CoinComponent } from '../coin/coin.component';
import { HeaderService } from './services/header.service';

//#endregion

@Component({
  selector: 'ebp-header',
  templateUrl: './header.component.html',
  styleUrls: ['./header.component.scss'],
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    TranslateModule,
    MatFormFieldModule,
    MatSelectModule,
    MatTooltipModule,
    RouterModule,
    CoinComponent
  ]
})
export class HeaderComponent implements OnInit {
  //#region Attributes

  protected disableLogoutButton: boolean = false;
  protected showMyAccountBox: boolean = false;

  protected readonly pages: string[] = [
    'replay_downloader',
    'replay_cutter',
    'game_history'
  ];
  protected page?: string;

  private static STORAGE_KEY_NAME: string = 'language';
  private static DEFAULT_LANGUAGE: string = 'en';

  //#endregion

  constructor(
    protected readonly commonLocation: CommonLocation,
    protected readonly router: Router,
    protected readonly translateService: TranslateService,
    protected readonly identityService: IdentityService,
    protected readonly globalService: GlobalService,
    protected readonly headerService: HeaderService
  ) {}

  //#region Functions

  ngOnInit(): void {
    // List of languages supported by the application.
    this.translateService.langs = ['fr', 'de', 'en', 'es', 'it', 'ro'].sort();

    this.translateService.setDefaultLang(HeaderComponent.DEFAULT_LANGUAGE);

    const LANGUAGE = location.pathname.split('/').filter((x) => x != '')[0];
    if (this.translateService.langs.includes(LANGUAGE)) {
      this.setLanguage(LANGUAGE);
    } else {
      const STORED_LANGUAGE = localStorage.getItem(
        HeaderComponent.STORAGE_KEY_NAME
      );
      if (STORED_LANGUAGE) {
        this.setLanguage(STORED_LANGUAGE);
      } else {
        const BROWSER_LANGUAGE: string = navigator.language;
        this.setLanguage(
          this.translateService.langs.includes(BROWSER_LANGUAGE)
            ? BROWSER_LANGUAGE
            : HeaderComponent.DEFAULT_LANGUAGE
        );
      }
    }
  }

  /**
   * This function opens a URL in the user's default browser.
   * @param url URL to open in the user's default browser.
   */
  protected openURLExternalBrowser(url: string): void {
    window.electronAPI.openURL(url);
  }

  /**
   * This function allows the user to log out.
   */
  protected logout(): void {
    if (!this.disableLogoutButton) {
      this.disableLogoutButton = true;
      window.electronAPI.logout();
    }
  }

  /**
   * Cette fonction s'exécute lorsque l'utilisateur change la langue du site web.
   * @param event Evenement "onchange".
   */
  protected languageSelectChanged(event: Event): void {
    if (event.target) {
      const SELECT = event.target as HTMLSelectElement;
      this.setLanguage(SELECT.value);
    }
  }

  protected changeTool(event: MatSelectChange): void {
    this.router.navigate([
      `/${this.translateService.currentLang}/${event.value}`
    ]);
  }

  /**
   * Cette fonction permet de changer la langue du site web.
   * @param language Langue à appliquer.
   */
  private setLanguage(language: string): void {
    const LANGUAGE: string = language.toLowerCase();
    this.translateService.use(LANGUAGE);
    localStorage.setItem(HeaderComponent.STORAGE_KEY_NAME, LANGUAGE);
    window.electronAPI?.setLanguage(LANGUAGE);

    // On change la langue dans l'URL.
    const CURRENT_PATH = this.commonLocation.path(); // Chemin actuel
    let newPath = CURRENT_PATH.replace(/^\/[a-z]{2}/, `/${LANGUAGE}`); // Remplace la langue dans l'URL
    if (newPath.length == 0) {
      newPath = `/${LANGUAGE}`;
    }
    this.commonLocation.replaceState(newPath);
  }

  //#endregion
}
