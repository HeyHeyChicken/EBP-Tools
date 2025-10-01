// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { Injectable } from '@angular/core';
import { Game } from '../models/game';
import { ReplayCutterComponent } from '../replay_cutter.component';
import { RGB } from '../models/rgb';
import { Line } from './models/line.model';

//#endregion

@Injectable({
  providedIn: 'root'
})
export class KillFeedService {
  //#region Attributes

  public videoPath: string | undefined;
  public game: Game | undefined;

  protected percent: number = -1;

  private start: number = 0;

  //#endregion

  //#region Functions

  public scan(videoPath: string, game: Game) {
    this.videoPath = videoPath;
    this.game = game;
  }

  private onScanEnded(): void {
    this.videoPath = undefined;
    console.log('end');
  }

  private setVideoCurrentTime(video: HTMLVideoElement, time: number): void {
    if (video) {
      if (time < video.duration) {
        video.currentTime = time;
      } else {
        this.onScanEnded();
      }
    }
  }

  /**
   * This function indicates whether a frame is likely to receive kill information.
   */
  private doesFrameContainDeaths(
    video: HTMLVideoElement,
    replayCutterComponent: ReplayCutterComponent
  ): boolean {
    const WIDTH: number = 420;
    const HEIGHT: number = 450;
    const TEXT_HEIGHT: number = 11;
    const TEXT_HEIGHT_TOLERENCE: number = 4;
    const COLOR_TOLERENCE: number = 40;

    const CANVAS = document.createElement('canvas');
    CANVAS.width = WIDTH;
    CANVAS.height = HEIGHT;
    const CTX = CANVAS.getContext('2d');

    if (CTX) {
      //CTX.filter = 'grayscale(100%)';
      CTX.drawImage(
        video,
        video.videoWidth - WIDTH,
        0,
        WIDTH,
        HEIGHT,
        0,
        0,
        WIDTH,
        HEIGHT
      );
      const DATA = CTX.getImageData(0, 0, WIDTH, HEIGHT);

      // On détecte le nombre de pixels orange, bleu ou rouge de chaque ligne.
      const LINES: {
        orange: number;
        blue: number;
        red: number;
        white: number;
      }[] = [];
      for (let y = 0; y < HEIGHT; y++) {
        LINES.push({
          orange: 0,
          blue: 0,
          red: 0,
          white: 0
        });

        for (let x = 0; x < WIDTH; x++) {
          const i = (y * WIDTH + x) * 4;
          if (
            replayCutterComponent.colorSimilarity(
              new RGB(DATA.data[i], DATA.data[i + 1], DATA.data[i + 2]),
              new RGB(213, 131, 58),
              COLOR_TOLERENCE
            )
          ) {
            LINES[LINES.length - 1].orange++;
          } else if (
            replayCutterComponent.colorSimilarity(
              new RGB(DATA.data[i], DATA.data[i + 1], DATA.data[i + 2]),
              new RGB(52, 124, 231),
              COLOR_TOLERENCE
            )
          ) {
            LINES[LINES.length - 1].blue++;
          } else if (
            replayCutterComponent.colorSimilarity(
              new RGB(DATA.data[i], DATA.data[i + 1], DATA.data[i + 2]),
              new RGB(208, 109, 101),
              COLOR_TOLERENCE
            )
          ) {
            LINES[LINES.length - 1].red++;
          } else if (
            replayCutterComponent.colorSimilarity(
              new RGB(DATA.data[i], DATA.data[i + 1], DATA.data[i + 2]),
              new RGB(206, 203, 202),
              COLOR_TOLERENCE
            )
          ) {
            LINES[LINES.length - 1].white++;
          }
        }
      }

      let groups: Line[] = [];
      let currentGroup: Line | undefined;

      for (let i = 0; i < LINES.length; i++) {
        const hasPixels =
          LINES[i].white > 0 &&
          ((LINES[i].orange > 0 && LINES[i].blue > 0) || LINES[i].red > 0);

        if (hasPixels) {
          // Ajouter la ligne au groupe courant
          if (!currentGroup) {
            currentGroup = new Line(0, i, 0, 1);
          } else {
            currentGroup.height++;
          }
        } else {
          // Fin d’un groupe
          if (currentGroup) {
            if (
              currentGroup.height >= TEXT_HEIGHT - TEXT_HEIGHT_TOLERENCE &&
              currentGroup.height <= TEXT_HEIGHT + TEXT_HEIGHT_TOLERENCE
            ) {
              groups.push(currentGroup); // sauvegarde le groupe
            } else {
              console.log(currentGroup.height);
            }
            currentGroup = undefined;
          }
        }
      }

      if (groups.length) {
        console.log(groups);

        groups.forEach((group) => {
          CTX.strokeStyle = 'red';
          CTX.lineWidth = 1;
          CTX.strokeRect(10, group.y, WIDTH - 20, group.height);
        });

        // DEBUG
        replayCutterComponent.debug?.nativeElement.append(
          replayCutterComponent.videoToCanvas(CANVAS)!
        );
      }

      /*
      console.log(nbOrangePixels, nbBluePixels);
      if ((nbOrangePixels > 0 && nbBluePixels > 0) || nbRedPixels > 0) {
        // DEBUG
        replayCutterComponent.debug?.nativeElement.append(
          replayCutterComponent.videoToCanvas(CANVAS)!
        );
      } else {
        // DEBUG
        //this.debug?.nativeElement.append(this.videoToCanvas(CANVAS)!);
      }
      */

      // On passe l'image en noir et blanc.
      //const threshold = 100;
      //for (let i = 0; i < DATA.data.length; i += 4) {
      //  const value = DATA.data[i] < threshold ? 255 : 0;
      //  DATA.data[i] = DATA.data[i + 1] = DATA.data[i + 2] = value;
      //}

      //CTX.putImageData(DATA /* Image */, 0 /* Image X */, 0 /* Image Y */);
    }
    return true;
  }

  public async videoTimeUpdate(
    event: Event,
    replayCutterComponent: ReplayCutterComponent
  ): Promise<void> {
    if (this.game) {
      if (replayCutterComponent.debugPause) {
        setTimeout(() => {
          this.videoTimeUpdate(event, replayCutterComponent);
        }, 1000);
      } else {
        if (this.videoPath) {
          if (this.start == 0) {
            this.start = Date.now();
          }
          if (event.target) {
            const VIDEO = event.target as HTMLVideoElement;
            const DEFAULT_STEP: number = 1;

            if (VIDEO.currentTime < VIDEO.duration) {
              const NOW: number = VIDEO.currentTime;
              this.percent = Math.ceil(100 - (NOW / VIDEO.duration) * 100);

              if (replayCutterComponent.detectGamePlaying(VIDEO, [this.game])) {
                this.doesFrameContainDeaths(VIDEO, replayCutterComponent);
              }

              this.setVideoCurrentTime(VIDEO, NOW + DEFAULT_STEP);
            }
          }
        }
      }
    }
  }

  //#endregion
}
