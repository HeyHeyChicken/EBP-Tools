// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { Injectable, NgZone } from '@angular/core';
import { Subject } from 'rxjs';
import { Message } from '../models/message.model';

//#endregion

@Injectable({ providedIn: 'root' })
export class NotificationService {
  //#region Attributes

  private _channel = new BroadcastChannel('ebp_tools_notification');
  private _messages$ = new Subject<Message>();
  messages$ = this._messages$.asObservable();

  //#endregion

  constructor(private readonly zone: NgZone) {
    this._channel.onmessage = (event) => {
      this.zone.run(() => this._messages$.next(event.data));
    };
  }

  //#region Functions

  /**
   * Sends a message through the broadcast channel to communicate with the notification HMI on the bottom right of the screen.
   * @param data The message data to send through the channel.
   */
  sendMessage(data: Message) {
    this._channel.postMessage(data);
  }

  //#endregion
}
