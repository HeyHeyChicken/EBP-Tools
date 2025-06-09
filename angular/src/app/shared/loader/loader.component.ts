//#region Import

import { Component, Input } from "@angular/core";
import { CommonModule } from "@angular/common";

//#endregion

@Component({
  selector: "ebp-loader",
  templateUrl: "./loader.component.html",
  styleUrls: ["./loader.component.scss"],
  standalone: true,
  imports: [CommonModule],
})
export class LoaderComponent {
  //#region Attributes

  @Input() public value: number = 0;

  //#endregion
}
