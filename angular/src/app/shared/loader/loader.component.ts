// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Import

import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

//#endregion

@Component({
  selector: 'ebp-loader',
  templateUrl: './loader.component.html',
  styleUrls: ['./loader.component.scss'],
  standalone: true,
  imports: [CommonModule]
})
export class LoaderComponent {
  //#region Attributes

  @Input() public value: number = 0;

  //#endregion
}
