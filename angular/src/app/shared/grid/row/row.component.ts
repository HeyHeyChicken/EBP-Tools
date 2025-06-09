// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { Component, Input } from "@angular/core";

//#endregion

@Component({
	selector: "ebp-row",
	templateUrl: "./row.component.html",
	styleUrls: ["./row.component.scss"],
	standalone: false,
})
export class RowComponent {
	//#region Attributes

	@Input() public size: number = 12;

	//#endregion
}

