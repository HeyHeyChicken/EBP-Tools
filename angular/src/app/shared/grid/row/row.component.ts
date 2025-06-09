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

