// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Import

import { Component, Input, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';

//#endregion

@Component({
  selector: 'ebp-loader',
  templateUrl: './loader.component.html',
  styleUrls: ['./loader.component.scss'],
  standalone: true,
  imports: [CommonModule]
})
export class LoaderComponent implements OnDestroy {
  //#region Attributes

  //#region infinite

  private _infinite = false;
  @Input()
  set infinite(value: boolean) {
    this._infinite = value;
    this.infiniteChange();
  }
  get infinite(): boolean {
    return this._infinite;
  }

  //#endregion

  @Input() public value: number = 0;
  @Input() public icon: string | undefined;

  private _interval: NodeJS.Timeout | undefined;

  //#endregion

  //#region Functions

  ngOnDestroy(): void {
    this.removeInterval();
  }

  /**
   * Clears the active interval timer and resets the interval reference.
   * This method safely stops any running interval to prevent memory leaks.
   */
  private removeInterval(): void {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = undefined;
    }
  }

  /**
   * Manages the infinite progress animation by starting or stopping the interval timer.
   * When infinite mode is enabled, creates a timer that continuously cycles the progress value from 0 to 100.
   * When infinite mode is disabled, removes any existing interval timer.
   */
  private infiniteChange(): void {
    if (this.infinite) {
      this._interval = setInterval(() => {
        this.value++;
        if (this.value > 100) {
          this.value = 0;
        }
      }, 10);
    } else {
      this.removeInterval();
    }
  }

  //#endregion
}
