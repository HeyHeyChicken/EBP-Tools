//#region Imports

import { CommonModule } from "@angular/common";
import { Component, OnInit } from "@angular/core";
import { TranslateModule } from "@ngx-translate/core";
import { MatTooltipModule } from "@angular/material/tooltip";
import { GridModule } from "../../shared/grid/grid.module";
import { LoaderComponent } from "../../shared/loader/loader.component";
import { MessageComponent } from "../../shared/message/message.component";
import { Game } from "./models/game";
import { createWorker } from "tesseract.js";
import { ToastrService } from "ngx-toastr";

//#endregion

@Component({
  selector: "view-home",
  templateUrl: "./home.component.html",
  styleUrls: ["./home.component.scss"],
  standalone: true,
  imports: [
    GridModule,
    MatTooltipModule,
    TranslateModule,
    CommonModule,
    TranslateModule,
    LoaderComponent,
    MessageComponent,
  ],
})
export class HomeComponent implements OnInit {
  //#region Attributes

  protected percent: number = -1;
  protected games: Game[] = [];
  protected inputFileDisabled: boolean = true;
  protected videoPath: string | undefined;

  private video: HTMLVideoElement | undefined;

  private tesseractWorker_basic: Tesseract.Worker | undefined;
  private tesseractWorker_number: Tesseract.Worker | undefined;
  private tesseractWorker_letter: Tesseract.Worker | undefined;
  private tesseractWorker_time: Tesseract.Worker | undefined;

  //#endregion

  constructor(private readonly toastrService: ToastrService) {}

  //#region Functions

  async ngOnInit(): Promise<void> {
    this.tesseractWorker_basic = await createWorker("eng");
    this.tesseractWorker_number = await createWorker("eng");
    this.tesseractWorker_letter = await createWorker("eng");
    this.tesseractWorker_time = await createWorker("eng");

    this.tesseractWorker_basic.setParameters({
      tessedit_char_whitelist:
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
    });
    this.tesseractWorker_number.setParameters({
      tessedit_char_whitelist: "0123456789",
    });
    this.tesseractWorker_letter.setParameters({
      tessedit_char_whitelist:
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz ",
    });
    this.tesseractWorker_time.setParameters({
      tessedit_char_whitelist: "0123456789:",
    });

    // The server gives the path of the video file selected by the user.
    //@ts-ignore
    window.electronAPI.setVideoFile((path: string) => {
      this.inputFileDisabled = false;
      this.videoPath = path;
      if (path) {
        this.video = document.createElement("video");
        this.video.addEventListener("loadeddata", this.videoLoadedData);
        this.video.addEventListener("timeupdate", this.videoTimeUpdate);

        this.video.setAttribute("src", "/file?path=" + path);
        this.percent = 0;
      } else {
        this.toastrService.error("No files selected");
      }
    });

    this.inputFileDisabled = false;
  }

  protected onInputFileClick(): void {
    if (!this.inputFileDisabled) {
      this.inputFileDisabled = true;
      this.games = [];
      //GAMES.innerHTML = "";
      //GAMES_COUNTER.innerText = "0";
      //INPUT_FILE.disabled = true;

      //@ts-ignore
      window.electronAPI.openVideoFile();
    }
  }

  /**
   * This function initializes the position of a video's playhead when it is loaded.
   * @param event
   */
  private videoLoadedData(event: Event) {
    if (event.target) {
      const VIDEO = event.target as HTMLVideoElement;
      VIDEO.currentTime = VIDEO.duration;
    }
  }

  private async videoTimeUpdate(event: Event) {}

  //#endregion
}
