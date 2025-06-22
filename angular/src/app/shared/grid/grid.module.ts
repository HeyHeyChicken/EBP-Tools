// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { NgModule } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { ContainerComponent } from './container/container.component';
import { RowComponent } from './row/row.component';
import { ColComponent } from './col/col.component';

//#endregion

@NgModule({
  imports: [CommonModule, FormsModule],
  declarations: [ContainerComponent, RowComponent, ColComponent],
  exports: [ContainerComponent, RowComponent, ColComponent]
})
export class GridModule {}
