//#region Import

import { Component } from "@angular/core";
import { GridModule } from "../grid/grid.module";
import { CommonModule } from "@angular/common";

//#endregion

@Component({
  selector: "ebp-footer",
  templateUrl: "./footer.component.html",
  styleUrls: ["./footer.component.scss"],
  standalone: true,
  imports: [GridModule, CommonModule],
})
export class FooterComponent {}
