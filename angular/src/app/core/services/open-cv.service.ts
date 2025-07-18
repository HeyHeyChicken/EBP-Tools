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

  public get cv(): typeof cv | null {
    return this._cv;
  }

  public isReady(): boolean {
    return this._cv !== null;
  }

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
