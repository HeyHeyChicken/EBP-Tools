// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { Component, HostListener, ViewEncapsulation } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule } from '@angular/forms';

//#endregion

@Component({
  selector: 'wizz',
  template: '',
  styleUrls: ['./wizz.component.scss'],
  encapsulation: ViewEncapsulation.None,
  standalone: true,
  imports: [CommonModule, FormsModule, ReactiveFormsModule]
})
export class WizzComponent {
  //#region Attributes

  private _shift: boolean = false;
  private _dictionary: string = '';

  @HostListener('document:keypress', ['$event'])
  handleKeyboardEvent(event: KeyboardEvent) {
    if (this._shift) {
      this._dictionary += event.key;
      if (this._dictionary.endsWith('WIZZ')) {
        this._wizz();
      }
    }
  }

  @HostListener('document:keydown', ['$event'])
  onKeyDown($event: KeyboardEvent) {
    if ($event.key === 'Shift') {
      if (!this._shift) {
        this._shift = true;
        this._dictionary = '';
      }
    }
  }

  @HostListener('document:keyup', ['$event'])
  onKeyUp($event: KeyboardEvent) {
    if ($event.key === 'Shift') {
      if (this._shift) {
        this._shift = false;
        this._dictionary = '';
      }
    }
  }

  //#endregion

  //#region Functions

  private _wizz(): void {
    this._dictionary = '';
    this.wizz();
  }

  public wizz(): void {
    const CLASS: string = 'wizz';
    document.body.classList.add(CLASS);
    setTimeout(() => {
      document.body.classList.remove(CLASS);
    }, 750);
  }

  //#endregion
}
