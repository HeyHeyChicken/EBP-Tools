// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { Component } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { CommonModule } from '@angular/common';
import { LoaderComponent } from '../../../shared/loader/loader.component';
import { MessageComponent } from '../../../shared/message/message.component';

//#endregion

@Component({
  selector: 'view-notification-manual-cutting',
  templateUrl: './manual-cutting.component.html',
  styleUrls: ['./manual-cutting.component.scss'],
  standalone: true,
  imports: [TranslateModule, CommonModule, LoaderComponent, MessageComponent]
})
export class NotificationManualCuttingComponent {}
