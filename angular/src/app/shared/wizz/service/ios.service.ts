//#region Imports

import { Injectable } from "@angular/core";

//#endregion

@Injectable({
  providedIn: "root",
})
export class iOSService {
  //#region Attributes

  public static get isiOS(): boolean {
    return (
      [
        "iPad Simulator",
        "iPhone Simulator",
        "iPod Simulator",
        "iPad",
        "iPhone",
        "iPod",
      ].includes(navigator.platform) ||
      // iPad on iOS 13 detection
      (navigator.userAgent.includes("Mac") && "ontouchend" in document)
    );
  }

  //#endregion

  //#region Functions

  /**
   * This function allows the developer to open the iOS keyboard on the selected input.
   * @param el Input
   * @param timeout
   */
  public focus(el: any, timeout: number = 100): void {
    // Align temp input element approximately where the input element is so the cursor doesn't jump around
    var __tempEl__ = document.createElement("input");
    __tempEl__.style.position = "absolute";
    __tempEl__.style.top = el.offsetTop + 7 + "px";
    __tempEl__.style.left = el.offsetLeft + "px";
    __tempEl__.style.height = 0 + "";
    __tempEl__.style.opacity = 0 + "";
    // Put this temp element as a child of the page <body> and focus on it
    document.body.appendChild(__tempEl__);
    __tempEl__.focus();

    // The keyboard is open. Now do a delayed focus on the target element
    setTimeout(function () {
      el.focus();
      el.click();
      // Remove the temp element
      document.body.removeChild(__tempEl__);
    }, timeout);
  }

  //#endregion
}
