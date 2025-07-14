// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import cv from '@techstark/opencv-js';

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

  private async init(): Promise<void> {
    try {
      this._cv = await cv;
      this.isLoadedSubject.next(true);
    } catch (error) {
      console.error('Loading error OpenCV: ', error);
      this.isLoadedSubject.next(false);
    }
  }

  //#endregion
}
