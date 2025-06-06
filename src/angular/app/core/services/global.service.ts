//#region Imports

import { Injectable } from "@angular/core";
import { TranslateService } from "@ngx-translate/core";

//#endregion

@Injectable({
  providedIn: "root",
})
export class GlobalService {
  //#region Attributes

  public get discordServerURL(): string {
    return "https://discord.gg/tAHAc9q3aX";
  }

  public get webSiteURL(): string {
    return `https://evabattleplan.com/${this.translateService.currentLang}`;
  }

  public serverPort: number = 0;

  //#endregion

  constructor(private readonly translateService: TranslateService) {}

  //#region Functions

  public static random(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1) + min);
  }

  //#endregion
}
