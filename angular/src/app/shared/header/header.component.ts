// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Import

import { Component, OnInit } from "@angular/core";
import { TranslateModule, TranslateService } from "@ngx-translate/core";
import { CommonModule, Location as CommonLocation } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { Router } from "@angular/router";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatSelectModule } from "@angular/material/select";
import { IdentityService } from "../../core/services/identity.service";
import { GlobalService } from "../../core/services/global.service";
import { MatTooltipModule } from "@angular/material/tooltip";

//#endregion

@Component({
  selector: "ebp-header",
  templateUrl: "./header.component.html",
  styleUrls: ["./header.component.scss"],
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    TranslateModule,
    MatFormFieldModule,
    MatSelectModule,
    MatTooltipModule
  ],
})
export class HeaderComponent implements OnInit {
  //#region Attributes

  protected disableLogoutButton: boolean = false;

  private static STORAGE_KEY_NAME: string = "language";
  private static DEFAULT_LANGUAGE: string = "en";

  //#endregion

  constructor(
    protected readonly commonLocation: CommonLocation,
    protected readonly router: Router,
    protected readonly translateService: TranslateService,
    protected readonly identityService: IdentityService,
    protected readonly globalService: GlobalService
  ) {}

  //#region Functions

  ngOnInit(): void {
    // List of languages ​​supported by the application.
    this.translateService.langs = ["fr", "de", "en", "es", "it"].sort();

    this.translateService.setDefaultLang(HeaderComponent.DEFAULT_LANGUAGE);

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

  /**
   * This function opens a URL in the user's default browser.
   * @param url URL to open in the user's default browser.
   */
  protected openURLExternalBrowser(url: string): void {
    //@ts-ignore
    window.electronAPI.openURL(url);
  }

  /**
   * This function allows the user to log out.
   */
  protected logout(): void{
    if(!this.disableLogoutButton){
      this.disableLogoutButton = true;
      //@ts-ignore
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

  /**
   * Cette fonction permet de changer la langue du site web.
   * @param language Langue à appliquer.
   */
  private setLanguage(language: string): void {
    const LANGUAGE: string = language.toLowerCase();
    this.translateService.use(LANGUAGE);
    localStorage.setItem(HeaderComponent.STORAGE_KEY_NAME, LANGUAGE);
  }

  //#endregion
}
