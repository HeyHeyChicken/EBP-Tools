// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Import

import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatTooltipModule } from '@angular/material/tooltip';
import { TranslateModule } from '@ngx-translate/core';

//#endregion

@Component({
  selector: 'ebp-assistant',
  templateUrl: './assistant.component.html',
  styleUrls: ['./assistant.component.scss'],
  standalone: true,
  imports: [CommonModule, MatTooltipModule, TranslateModule]
})
export class AssistantComponent {
  //#region Attributes

  private _opened: boolean = false;
  protected get opened(): boolean {
    return this._opened;
  }
  protected set opened(value: boolean) {
    this._opened = value;
    this.change.emit(value);
  }

  @Input() public text: string | undefined;
  @Input() public textWidth: string | undefined;

  @Output() change: EventEmitter<boolean> = new EventEmitter<boolean>();

  //#endregion
}
