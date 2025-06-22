// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { Component, NgZone, OnInit } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { GridModule } from '../../shared/grid/grid.module';
import { MatInputModule } from '@angular/material/input';
import { FormsModule } from '@angular/forms';
import { LoaderComponent } from '../../shared/loader/loader.component';
import { CommonModule } from '@angular/common';
import { ToastrService } from 'ngx-toastr';
import { GlobalService } from '../../core/services/global.service';
import { VideoPlatform } from '../../../types/video-platform.enum';

//#endregion

@Component({
  selector: 'view-replay-downloader',
  templateUrl: './replay_downloader.component.html',
  styleUrls: ['./replay_downloader.component.scss'],
  standalone: true,
  imports: [
    GridModule,
    TranslateModule,
    MatInputModule,
    FormsModule,
    LoaderComponent,
    CommonModule
  ]
})
export class ReplayDownloaderComponent implements OnInit {
  //#region Attributes

  protected youTubeURL?: string;
  protected twitchURL?: string;
  protected outputPath: string | undefined;
  protected percent?: number;

  //#endregion

  constructor(
    protected readonly globalService: GlobalService,
    private readonly toastrService: ToastrService,
    private readonly ngZone: NgZone
  ) {}

  //#region Functions

  ngOnInit(): void {
    window.electronAPI.getReplayDownloaderOutputPath().then((path: string) => {
      this.ngZone.run(() => {
        this.outputPath = path;
      });
    });

    window.electronAPI.replayDownloaderError((error: string) => {
      this.ngZone.run(() => {
        this.percent = undefined;
        if (error) {
          this.toastrService.error(error);
        }
      });
    });

    window.electronAPI.replayDownloaderSuccess((videoPath: string) => {
      this.ngZone.run(() => {
        this.percent = undefined;
        if (videoPath) {
          this.toastrService.success(videoPath).onTap.subscribe(() => {
            window.electronAPI.openFile(videoPath);
          });
        }
      });
    });

    window.electronAPI.replayDownloaderPercent((percent: number) => {
      this.ngZone.run(() => {
        this.percent = percent;
      });
    });
  }

  /**
   * This function allows user to change the folder where the replay downloader are stored.
   */
  protected setOutputPath(): void {
    this.globalService.loading = true;
    window.electronAPI
      .setSetting('replayDownloaderOutputPath')
      .then((path: string) => {
        this.ngZone.run(() => {
          this.globalService.loading = false;
          if (path) {
            this.outputPath = path;
          }
        });
      });
  }

  protected onDownloadYouTube(): void {
    if (this.youTubeURL) {
      if (this.isYouTubeUrl(this.youTubeURL)) {
        this.percent = 0;
        window.electronAPI.downloadReplay(
          this.youTubeURL,
          VideoPlatform.YOUTUBE
        );
        this.youTubeURL = undefined;
      }
    }
  }

  protected onDownloadTwitch(): void {
    if (this.twitchURL) {
      if (this.isTwitchUrl(this.twitchURL)) {
        this.percent = 0;
        window.electronAPI.downloadReplay(this.twitchURL, VideoPlatform.TWITCH);
        this.twitchURL = undefined;
      }
    }
  }

  private isYouTubeUrl(url: string): boolean {
    const regex =
      /^(https?:\/\/)?(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)[\w-]{11}(&\S*)?$/;
    return regex.test(url);
  }

  private isTwitchUrl(url: string): boolean {
    const regex =
      /^(https?:\/\/)?(www\.)?twitch\.tv\/(videos\/\d+|[a-zA-Z0-9_]+\/clip\/[a-zA-Z0-9_-]+)$/;
    return regex.test(url);
  }

  //#endregion
}
