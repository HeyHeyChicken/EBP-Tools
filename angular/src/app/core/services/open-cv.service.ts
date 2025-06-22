import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import cv from '@techstark/opencv-js';

@Injectable({
  providedIn: 'root'
})
export class OpenCVService {
  private readonly isLoadedSubject = new BehaviorSubject<boolean>(false);
  public readonly isLoaded$: Observable<boolean> =
    this.isLoadedSubject.asObservable();

  private _cv: typeof cv | null = null;

  constructor() {
    this.init();
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

  public get cv(): typeof cv | null {
    return this._cv;
  }

  public isReady(): boolean {
    return this._cv !== null;
  }
}
