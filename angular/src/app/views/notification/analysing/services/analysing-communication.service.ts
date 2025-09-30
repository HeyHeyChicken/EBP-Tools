// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { Injectable, NgZone } from '@angular/core';
import { Subject } from 'rxjs';
import { Message } from '../models/message.model';

//#endregion

@Injectable({ providedIn: 'root' })
export class AnalysingCommunicationService {
  //#region Attributes

  private _channel = new BroadcastChannel('ebp_tools_notification_analysing');
  private _messages$ = new Subject<Message>();
  messages$ = this._messages$.asObservable();

  //#endregion

  constructor(private zone: NgZone) {
    this._channel.onmessage = (event) => {
      this.zone.run(() => this._messages$.next(event.data));
    };
  }

  //#region Functions

  sendMessage(data: Message) {
    this._channel.postMessage(data);
  }

  //#endregion
}
