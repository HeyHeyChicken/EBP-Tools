// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';

//#endregion

@Injectable({
  providedIn: 'root'
})
export class OpenCVService {
  //#region Attributes

  private readonly isLoadedSubject = new BehaviorSubject<boolean>(false);

  public readonly isLoaded$: Observable<boolean> =
    this.isLoadedSubject.asObservable();

  private _cv: typeof cv | null = null;

  //#endregion

  constructor() {
    this.init();
  }

  //#region Functions

  /**
   * Gets the OpenCV library instance if it has been successfully loaded.
   * @returns The OpenCV library instance, or null if not yet loaded or failed to load.
   */
  public get cv(): typeof cv | null {
    return this._cv;
  }
  /**
   * Checks whether the OpenCV library is ready for use.
   * @returns True if OpenCV has been successfully loaded and is available, false otherwise.
   */
  public isReady(): boolean {
    return this._cv !== null;
  }

  /**
   * Initializes the OpenCV library by loading it from the assets folder.
   * First checks if OpenCV is already loaded globally, otherwise dynamically loads the opencv.js script.
   * Updates the isLoadedSubject observable to notify when the library is ready or if loading fails.
   */
  private init(): void {
    const WINDOW = window as typeof window & { cv?: typeof cv };
    if (WINDOW.cv) {
      this._cv = WINDOW.cv;
      this.isLoadedSubject.next(true);
      return;
    }
    const SCRIPT = document.createElement('script');
    SCRIPT.src = 'assets/js/opencv.js';
    SCRIPT.async = true;
    SCRIPT.onload = () => {
      this._cv = WINDOW.cv!;
      this.isLoadedSubject.next(true);
    };
    SCRIPT.onerror = (error: string | Event) => {
      console.error('Loading error OpenCV: ', error);
      this.isLoadedSubject.next(false);
    };
    document.body.appendChild(SCRIPT);
  }

  //#endregion
}
