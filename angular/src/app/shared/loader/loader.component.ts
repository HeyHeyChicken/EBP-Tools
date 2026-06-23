// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Import

import { Component, Input, OnDestroy } from '@angular/core';

//#endregion

@Component({
  selector: 'ebp-loader',
  templateUrl: './loader.component.html',
  styleUrls: ['./loader.component.scss'],
  standalone: true,
  imports: []
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

  //#region value

  // Valeur réelle reçue du parent (source de vérité). Séparée de `displayValue`
  // pour que l'animation infinite ne l'écrase pas : sinon, quand le mode infinite
  // se coupe alors que `value` n'a pas changé (ex. premier tick à 0 %), Angular ne
  // réécrit pas l'input et la barre reste figée sur la dernière valeur balayée.
  private _value = 0;
  @Input()
  set value(v: number) {
    this._value = v;
    if (!this._infinite) {
      this.displayValue = v;
    }
  }
  get value(): number {
    return this._value;
  }

  // Valeur réellement rendue (classe `t{n}`) : suit `value` hors infinite, et
  // balaye 0→100 pendant l'animation infinite.
  protected displayValue: number = 0;

  //#endregion

  @Input() public icon: string | undefined;
  @Input() public state: 'info' | 'success' | 'error' = 'info';

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
        this.displayValue++;
        if (this.displayValue > 100) {
          this.displayValue = 0;
        }
      }, 10);
    } else {
      this.removeInterval();
      // Sortie de l'animation : on retombe sur la vraie progression du parent.
      this.displayValue = this._value;
    }
  }

  //#endregion
}
