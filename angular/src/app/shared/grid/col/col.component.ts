//#region Imports

import { Component, ElementRef, Host, HostBinding, Input, OnInit } from "@angular/core";
import { RowComponent } from "../row/row.component";

//#endregion

@Component({
	selector: "ebp-column",
	templateUrl: "./col.component.html",
	styleUrls: ["./col.component.scss"],
	standalone: false,
})
export class ColComponent implements OnInit {
	//#region Attributes

	@Input() public xs: number | "auto" = -1;
	@Input() public sm: number | "auto" = -1;
	@Input() public md: number | "auto" = -1;
	@Input() public lg: number | "auto" = -1;
	@Input() public xl: number | "auto" = -1;
	@Input() public xl2: number | "auto" = -1;
	@Input() public xl3: number | "auto" = -1;
	@Input() public xl4: number | "auto" = -1;
	@Input() public xl5: number | "auto" = -1;

	@Input() public text_xs?: "start" | "center" | "end";
	@Input() public text_sm?: "start" | "center" | "end";
	@Input() public text_md?: "start" | "center" | "end";
	@Input() public text_lg?: "start" | "center" | "end";
	@Input() public text_xl?: "start" | "center" | "end";
	@Input() public text_xl2?: "start" | "center" | "end";
	@Input() public text_xl3?: "start" | "center" | "end";
	@Input() public text_xl4?: "start" | "center" | "end";
	@Input() public text_xl5?: "start" | "center" | "end";

	@Input() public align_self_xs?: "start" | "center" | "end" | "baseline" | "stretch";
	@Input() public align_self_sm?: "start" | "center" | "end" | "baseline" | "stretch";
	@Input() public align_self_md?: "start" | "center" | "end" | "baseline" | "stretch";
	@Input() public align_self_lg?: "start" | "center" | "end" | "baseline" | "stretch";
	@Input() public align_self_xl?: "start" | "center" | "end" | "baseline" | "stretch";
	@Input() public align_self_xl2?: "start" | "center" | "end" | "baseline" | "stretch";

	@Input() public align_self_xl3?: "start" | "center" | "end" | "baseline" | "stretch";

	@Input() public align_self_xl4?: "start" | "center" | "end" | "baseline" | "stretch";

	@Input() public align_self_xl5?: "start" | "center" | "end" | "baseline" | "stretch";

	protected row: RowComponent;

	@HostBinding("class") classAttribute: string = "";

	//#endregion

	constructor(private readonly elementRef: ElementRef, @Host() parent: RowComponent) {
		this.row = parent;
	}

	ngOnInit(): void {
		if (this.elementRef.nativeElement.parentNode.nodeName != "EBP-ROW") {
			console.error(
				'An "ebp-column" must necessarily be encapsulated in a "row" element.',
				this.elementRef.nativeElement,
			);
		}
		const CLASSES: string[] = [];
		if (this.row.size > 0) {
			CLASSES.push("row-" + this.row.size);
		}
		//#region Size

		if (this.xs == "auto") CLASSES.push("_xs-" + this.xs);
		else if (this.xs >= 0) CLASSES.push("_xs-" + this.xs);

		if (this.sm == "auto") CLASSES.push("_sm-" + this.xs);
		else if (this.sm >= 0) CLASSES.push("_sm-" + this.sm);

		if (this.md == "auto") CLASSES.push("_md-" + this.xs);
		else if (this.md >= 0) CLASSES.push("_md-" + this.md);

		if (this.lg == "auto") CLASSES.push("_lg-" + this.xs);
		else if (this.lg >= 0) CLASSES.push("_lg-" + this.lg);

		if (this.xl == "auto") CLASSES.push("_xl-" + this.xs);
		else if (this.xl >= 0) CLASSES.push("_xl-" + this.xl);

		if (this["xl2"] == "auto") CLASSES.push("_xl2-" + this.xs);
		else if (this["xl2"] >= 0) CLASSES.push("_xl2-" + this["xl2"]);

		if (this["xl3"] == "auto") CLASSES.push("_xl3-" + this.xs);
		else if (this["xl3"] >= 0) CLASSES.push("_xl3-" + this["xl3"]);

		if (this["xl4"] == "auto") CLASSES.push("_xl4-" + this.xs);
		else if (this["xl4"] >= 0) CLASSES.push("_xl4-" + this["xl4"]);

		if (this["xl5"] == "auto") CLASSES.push("_xl5-" + this.xs);
		else if (this["xl5"] >= 0) CLASSES.push("_xl5-" + this["xl5"]);

		//#endregion

		//#region TextAlign

		if (this.text_xs != undefined) CLASSES.push("text-xs-" + this.text_xs);
		if (this.text_sm != undefined) CLASSES.push("text-sm-" + this.text_sm);
		if (this.text_md != undefined) CLASSES.push("text-md-" + this.text_md);
		if (this.text_lg != undefined) CLASSES.push("text-lg-" + this.text_lg);
		if (this.text_xl != undefined) CLASSES.push("text-xl-" + this.text_xl);
		if (this.text_xl2 != undefined) CLASSES.push("text-xl2-" + this.text_xl2);
		if (this.text_xl3 != undefined) CLASSES.push("text-xl3-" + this.text_xl3);
		if (this.text_xl4 != undefined) CLASSES.push("text-xl4-" + this.text_xl4);
		if (this.text_xl5 != undefined) CLASSES.push("text-xl5-" + this.text_xl5);

		//#endregion

		//#region SelfAlign

		if (this.align_self_xs != undefined) CLASSES.push("align-self-xs-" + this.align_self_xs);
		if (this.align_self_sm != undefined) CLASSES.push("align-self-sm-" + this.align_self_sm);
		if (this.align_self_md != undefined) CLASSES.push("align-self-md-" + this.align_self_md);
		if (this.align_self_lg != undefined) CLASSES.push("align-self-lg-" + this.align_self_lg);
		if (this.align_self_xl != undefined) CLASSES.push("align-self-xl-" + this.align_self_xl);
		if (this.align_self_xl2 != undefined) CLASSES.push("align-self-xl2-" + this.align_self_xl2);
		if (this.align_self_xl3 != undefined) CLASSES.push("align-self-xl3-" + this.align_self_xl3);
		if (this.align_self_xl4 != undefined) CLASSES.push("align-self-xl4-" + this.align_self_xl4);
		if (this.align_self_xl5 != undefined) CLASSES.push("align-self-xl5-" + this.align_self_xl5);

		//#endregion

		this.classAttribute = CLASSES.join(" ");
	}
}

