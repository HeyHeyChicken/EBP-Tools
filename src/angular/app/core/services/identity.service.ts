//#region Imports

import { Injectable } from "@angular/core";

//#endregion

@Injectable({
  providedIn: "root",
})
export class IdentityService {
  //#region Attributes

  public id: number = 0;
  public premium: boolean = false;

  //#endregion
}
