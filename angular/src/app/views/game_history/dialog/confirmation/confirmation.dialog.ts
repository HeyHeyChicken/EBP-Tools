//#region Imports

import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatDialogModule } from '@angular/material/dialog';
import { TranslateModule } from '@ngx-translate/core';

//#endregion

@Component({
  selector: 'game-history-dialog-confirmation',
  templateUrl: './confirmation.dialog.html',
  styleUrls: ['./confirmation.dialog.scss'],
  imports: [CommonModule, MatDialogModule, TranslateModule],
  standalone: true
})
export class ConfirmationDialog implements OnInit {
  //#region Attributes

  protected timeToWait: number = 3;

  //#endregion

  constructor() {}
  ngOnInit(): void {
    const INTERVAL = setInterval(() => {
      this.timeToWait--;

      if (this.timeToWait <= 0) {
        clearInterval(INTERVAL);
      }
    }, 1000);
  }

  //#region Functions

  //#endregion
}
