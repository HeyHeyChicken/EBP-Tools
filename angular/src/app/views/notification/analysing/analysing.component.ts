// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { Component, OnDestroy, OnInit } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { CommonModule } from '@angular/common';
import { LoaderComponent } from '../../../shared/loader/loader.component';
import { MessageComponent } from '../../../shared/message/message.component';
import { AnalysingCommunicationService } from './services/analysing-communication.service';
import { Message } from './models/message.model';
import { Subscription } from 'rxjs';

//#endregion

@Component({
  selector: 'view-notification-analysing',
  templateUrl: './analysing.component.html',
  styleUrls: ['./analysing.component.scss'],
  standalone: true,
  imports: [TranslateModule, CommonModule, LoaderComponent, MessageComponent]
})
export class NotificationAnalysingComponent implements OnInit, OnDestroy {
  //#region Attributes

  protected data: Message = {
    games: [],
    percent: 0
  };
  private subscription: Subscription | undefined;

  //#endregion

  constructor(
    private readonly analysingCommunicationService: AnalysingCommunicationService
  ) {}

  //#region Functions

  ngOnInit(): void {
    this.subscription = this.analysingCommunicationService.messages$.subscribe(
      (msg: Message) => (this.data = msg)
    );
  }

  ngOnDestroy(): void {
    this.subscription?.unsubscribe();
  }

  //#endregion
}
