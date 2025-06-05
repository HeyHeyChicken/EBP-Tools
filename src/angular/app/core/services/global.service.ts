//#region Imports

import { Injectable } from "@angular/core";

//#endregion

@Injectable({
  providedIn: "root",
})
export class GlobalService {
  //#region Attributes

  public get discordServerURL(): string {
    return "https://discord.gg/tAHAc9q3aX";
  }

  //#endregion

  //#region Functions

  public static random(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1) + min);
  }

  //#endregion
}
