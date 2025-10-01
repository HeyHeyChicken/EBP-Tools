// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { Component } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { CommonModule } from '@angular/common';
import { LoaderComponent } from '../../../shared/loader/loader.component';
import { MessageComponent } from '../../../shared/message/message.component';
import { Message } from './models/message.model';
import { Subscription } from 'rxjs';
import { UpscalingCommunicationService } from './services/upscaling-communication.service';

//#endregion

@Component({
  selector: 'view-notification-upscaling',
  templateUrl: './upscaling.component.html',
  styleUrls: ['./upscaling.component.scss'],
  standalone: true,
  imports: [TranslateModule, CommonModule, LoaderComponent, MessageComponent]
})
export class UpscalingManualCuttingComponent {
  //#region Attributes

  protected data: Message = {
    percent: 0
  };
  private subscription: Subscription | undefined;

  //#endregion

  constructor(
    private readonly communicationService: UpscalingCommunicationService
  ) {}

  //#region Functions

  ngOnInit(): void {
    this.subscription = this.communicationService.messages$.subscribe(
      (msg: Message) => (this.data = msg)
    );
  }

  ngOnDestroy(): void {
    this.subscription?.unsubscribe();
  }

  //#endregion
}
