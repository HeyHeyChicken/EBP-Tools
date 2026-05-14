// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { Component, OnDestroy, OnInit } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';

import { LoaderComponent } from '../../shared/loader/loader.component';
import { MessageComponent } from '../../shared/message/message.component';
import { NotificationService } from './services/notification.service';
import { Message } from './models/message.model';
import { Subscription } from 'rxjs';
import { ActivatedRoute } from '@angular/router';
import { ConsoleService } from '../../shared/console/services/console.service';

//#endregion

@Component({
  selector: 'view-notification',
  templateUrl: './notification.component.html',
  styleUrls: ['./notification.component.scss'],
  standalone: true,
  imports: [TranslateModule, LoaderComponent, MessageComponent]
})
export class NotificationComponent implements OnInit, OnDestroy {
  //#region Attributes

  protected images: string[] = [];
  protected data: Message = {
    percent: 0,
    infinite: false,
    icon: undefined,
    text: '',
    leftRounded: true,
    state: 'info'
  };
  private subscription: Subscription | undefined;

  //#endregion

  constructor(
    private readonly notificationService: NotificationService,
    private readonly route: ActivatedRoute,
    private readonly consoleService: ConsoleService
  ) {
    this.consoleService.disabled = true;
  }

  //#region Functions

  ngOnInit(): void {
    this.subscription = this.notificationService.messages$.subscribe(
      (msg: Message) => (this.data = msg)
    );

    // Retrieving images
    const IMAGES = localStorage.getItem('notification_images');
    if (IMAGES) {
      this.images = JSON.parse(IMAGES);
    }
    localStorage.removeItem('notification_images');

    this.route.queryParams.subscribe((params) => {
      if (params['data']) {
        try {
          this.data = JSON.parse(decodeURIComponent(params['data']));
        } catch (e) {}
      }
    });
  }

  ngOnDestroy(): void {
    this.subscription?.unsubscribe();
  }

  //#endregion
}
