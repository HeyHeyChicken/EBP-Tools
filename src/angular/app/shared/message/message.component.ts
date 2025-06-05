//#region Import

import { CommonModule } from "@angular/common";
import { Component, HostBinding, Input, OnInit } from "@angular/core";
import { FormsModule } from "@angular/forms";

//#endregion

@Component({
  selector: "ebp-message",
  templateUrl: "./message.component.html",
  styleUrls: ["./message.component.scss"],
  standalone: true,
  imports: [CommonModule, FormsModule],
})
export class MessageComponent implements OnInit {
  //#region Attributes

  @Input() protected friend: boolean = false;
  @HostBinding("class.friend") addFriendClass: boolean = false;

  //#endregion

  //#region Functions

  ngOnInit(): void {
    if (this.friend) {
      this.addFriendClass = this.friend;
    }
  }

  //#endregion
}
