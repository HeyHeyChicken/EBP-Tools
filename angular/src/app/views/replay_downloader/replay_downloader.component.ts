// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { Component, NgZone, OnInit } from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { GridModule } from '../../shared/grid/grid.module';
import { MatInputModule } from '@angular/material/input';
import { FormsModule } from '@angular/forms';
import { LoaderComponent } from '../../shared/loader/loader.component';
import { CommonModule } from '@angular/common';
import { ToastrService } from 'ngx-toastr';
import { GlobalService } from '../../core/services/global.service';
import { VideoPlatform } from '../../../models/video-platform.enum';
import { MessageComponent } from '../../shared/message/message.component';
import { NotificationService } from '../notification/services/notification.service';

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
    CommonModule,
    MessageComponent
  ]
})
export class ReplayDownloaderComponent implements OnInit {
  //#region Attributes

  protected youTubeURL?: string; // https://www.youtube.com/watch?v=UKVDSvhIRM8
  protected twitchURL?: string;
  protected outputPath: string | undefined;
  protected percent?: number;

  //#endregion

  constructor(
    protected readonly globalService: GlobalService,
    private readonly toastrService: ToastrService,
    private readonly ngZone: NgZone,
    private readonly translateService: TranslateService,
    private readonly notificationService: NotificationService
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
          this.globalService.loading = undefined;
          this.toastrService.error(error);
          window.electronAPI.removeNotification(true);
        }
      });
    });

    window.electronAPI.replayDownloaderSuccess((videoPath: string) => {
      this.ngZone.run(() => {
        this.percent = undefined;
        if (videoPath) {
          this.globalService.loading = undefined;
          this.toastrService.success(videoPath).onTap.subscribe(() => {
            window.electronAPI.openFile(videoPath);
          });
          window.electronAPI.removeNotification(true);
        }
      });
    });

    window.electronAPI.replayDownloaderPercent((percent: number) => {
      this.ngZone.run(() => {
        this.percent = percent;

        this.globalService.loading = '';

        this.translateService
          .get('view.notification.replay_downloader.downloading')
          .subscribe((translated: string) => {
            this.notificationService.sendMessage({
              percent: percent,
              infinite: percent == 100,
              icon:
                percent == 100
                  ? 'fa-sharp fa-solid fa-clapperboard-play'
                  : undefined,
              text: translated
            });
          });
      });
    });
  }

  /**
   * This function allows user to change the folder where the replay downloader are stored.
   */
  protected setOutputPath(): void {
    this.globalService.loading = '';
    window.electronAPI
      .setSetting('replayDownloaderOutputPath')
      .then((path: string) => {
        this.ngZone.run(() => {
          this.globalService.loading = undefined;
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
        const cleanUrl = this.cleanYouTubeURL(this.youTubeURL);
        window.electronAPI.downloadReplay(cleanUrl, VideoPlatform.YOUTUBE);
        this.showNotification();
      }
    }
  }

  protected onDownloadTwitch(): void {
    if (this.twitchURL) {
      if (this.isTwitchUrl(this.twitchURL)) {
        this.percent = 0;
        window.electronAPI.downloadReplay(this.twitchURL, VideoPlatform.TWITCH);
        this.showNotification();
      }
    }
  }

  private cleanYouTubeURL(url: string): string {
    const URL_OBJ = new URL(url);
    const VIDEO_ID = URL_OBJ.searchParams.get('v');
    if (VIDEO_ID) {
      return `https://www.youtube.com/watch?v=${VIDEO_ID}`;
    }
    return url;
  }

  private showNotification() {
    this.youTubeURL = undefined;
    this.twitchURL = undefined;

    this.globalService.loading = '';

    this.translateService
      .get('view.notification.replay_downloader.fetching')
      .subscribe((translated: string) => {
        window.electronAPI.showNotification(
          true,
          500,
          150,
          JSON.stringify({
            percent: 0,
            infinite: true,
            icon: 'fa-sharp fa-solid fa-clapperboard-play',
            text: translated
          })
        );
      });
  }

  private isYouTubeUrl(url: string): boolean {
    const regex =
      /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|live\/)|youtu\.be\/)[\w-]{11}(&\S*)?$/;
    return regex.test(url);
  }

  private isTwitchUrl(url: string): boolean {
    const regex =
      /^(https?:\/\/)?(www\.)?twitch\.tv\/(videos\/\d+|[a-zA-Z0-9_]+\/clip\/[a-zA-Z0-9_-]+)$/;
    return regex.test(url);
  }

  //#endregion
}
