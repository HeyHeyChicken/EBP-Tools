// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { Component, isDevMode, NgZone, OnInit } from '@angular/core';
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

  protected youTubeURL?: string = isDevMode()
    ? 'https://www.youtube.com/watch?v=UKVDSvhIRM8'
    : undefined;
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
          console.log(`The user exported a replay here: "${videoPath}"`);
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
            console.log(
              `The user changed the replay download folder: "${path}"`
            );
            this.outputPath = path;
          }
        });
      });
  }

  /**
   * Initiates the download process for a YouTube replay video.
   * Validates the YouTube URL format, cleans it, resets the progress indicator, and triggers the download through the Electron API. Shows a notification to inform the user that the download has started.
   */
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

  /**
   * Initiates the download process for a Twitch replay video.
   * Validates the Twitch URL format, resets the progress indicator, and triggers the download through the Electron API. Shows a notification to inform the user that the download has started.
   */
  protected onDownloadTwitch(): void {
    if (this.twitchURL) {
      if (this.isTwitchUrl(this.twitchURL)) {
        this.percent = 0;
        window.electronAPI.downloadReplay(this.twitchURL, VideoPlatform.TWITCH);
        this.showNotification();
      }
    }
  }

  /**
   * Cleans a YouTube URL by extracting the video ID and creating a standardized YouTube watch URL.
   * This removes any additional parameters and ensures a consistent URL format for download processing.
   * @param url The original YouTube URL that may contain additional parameters.
   * @returns A clean YouTube watch URL with only the video ID parameter, or the original URL if no video ID is found.
   */
  private cleanYouTubeURL(url: string): string {
    const URL_OBJ = new URL(url);
    const VIDEO_ID = URL_OBJ.searchParams.get('v');
    if (VIDEO_ID) {
      return `https://www.youtube.com/watch?v=${VIDEO_ID}`;
    }
    return url;
  }

  /**
   * Displays a notification at the bottom right corner of the screen to inform the user that the download process has started.
   * Clears the URL input fields, sets the global loading state, and shows a notification window with an infinite progress indicator and a localized "fetching" message.
   */
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

  /**
   * Validates whether a given URL is a valid YouTube URL.
   * Supports various YouTube URL formats including standard watch URLs, shortened youtu.be links, and live stream URLs.
   * @param url The URL string to validate.
   * @returns True if the URL matches a valid YouTube URL pattern, false otherwise.
   */
  private isYouTubeUrl(url: string): boolean {
    const regex =
      /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|live\/)|youtu\.be\/)[\w-]{11}(&\S*)?$/;
    return regex.test(url);
  }

  /**
   * Validates whether a given URL is a valid Twitch URL.
   * Supports Twitch video URLs and clip URLs with their respective URL patterns.
   * @param url The URL string to validate.
   * @returns True if the URL matches a valid Twitch URL pattern, false otherwise.
   */
  private isTwitchUrl(url: string): boolean {
    const regex =
      /^(https?:\/\/)?(www\.)?twitch\.tv\/(videos\/\d+|[a-zA-Z0-9_]+\/clip\/[a-zA-Z0-9_-]+)$/;
    return regex.test(url);
  }

  //#endregion
}
