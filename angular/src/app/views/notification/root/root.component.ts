// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { Component } from '@angular/core';
import { RouterModule } from '@angular/router';

//#endregion

@Component({
  selector: 'view-notification-root',
  templateUrl: './root.component.html',
  styleUrls: ['./root.component.scss'],
  standalone: true,
  imports: [RouterModule]
})
export class NotificationRootComponent {}
