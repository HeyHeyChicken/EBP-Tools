// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Import

import { Component, Input, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';

//#endregion

@Component({
  selector: 'ebp-loader',
  templateUrl: './loader.component.html',
  styleUrls: ['./loader.component.scss'],
  standalone: true,
  imports: [CommonModule]
})
export class LoaderComponent implements OnInit, OnDestroy {
  //#region Attributes

  @Input() public value: number = 0;
  @Input() public infinite: boolean = false;
  @Input() public icon: string | undefined;

  private interval: NodeJS.Timeout | undefined;

  //#endregion

  //#region Functions

  ngOnInit(): void {
    if (this.infinite) {
      this.interval = setInterval(() => {
        this.value++;
        if (this.value > 100) {
          this.value = 0;
        }
      }, 10);
    }
  }

  ngOnDestroy(): void {
    if (this.interval) {
      clearInterval(this.interval);
    }
  }

  //#endregion
}
