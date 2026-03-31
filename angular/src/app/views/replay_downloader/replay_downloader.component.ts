// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { Component, isDevMode, NgZone, OnInit } from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { GridModule } from '../../shared/grid/grid.module';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { ToastrService } from 'ngx-toastr';
import { GlobalService } from '../../core/services/global.service';
import { MessageComponent } from '../../shared/message/message.component';
import { VideoFormat } from './models/video-format.interface';
import { VideoPlatform } from './models/video-platform.enum';

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
    MatSelectModule,
    FormsModule,
    CommonModule,
    MessageComponent
  ]
})
export class ReplayDownloaderComponent implements OnInit {
  //#region Attributes

  protected videoURL?: string = isDevMode()
    ? 'https://www.youtube.com/watch?v=UKVDSvhIRM8'
    : undefined;
  protected outputPath: string | undefined;
  protected percent?: number;

  protected formats: VideoFormat[] = [];
  protected selectedFormat?: string;
  protected loadingFormats = false;
  protected detectedPlatform?: VideoPlatform;

  //#endregion

  constructor(
    protected readonly globalService: GlobalService,
    private readonly toastrService: ToastrService,
    private readonly ngZone: NgZone,
    private readonly translateService: TranslateService
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
        }
      });
    });

    window.electronAPI.replayDownloaderSuccess((videoPath: string) => {
      this.ngZone.run(() => {
        this.percent = undefined;
        if (videoPath) {
          console.log(`The user exported a replay here: "${videoPath}"`);
          this.toastrService.success(videoPath).onTap.subscribe(() => {
            window.electronAPI.openFile(videoPath);
          });
        }
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
   * Fetches available video formats for a YouTube or Twitch URL.
   * Detects the platform from the URL and retrieves format options from the backend.
   */
  protected fetchVideoFormats(): void {
    if (!this.videoURL) {
      return;
    }

    // Detect platform
    if (this.isYouTubeUrl(this.videoURL)) {
      this.detectedPlatform = VideoPlatform.YOUTUBE;
    } else if (this.isTwitchUrl(this.videoURL)) {
      this.detectedPlatform = VideoPlatform.TWITCH;
    } else {
      this.detectedPlatform = undefined;
      this.formats = [];
      this.selectedFormat = undefined;
      return;
    }

    this.loadingFormats = true;
    this.formats = [];
    this.selectedFormat = undefined;

    const URL_TO_FETCH =
      this.detectedPlatform === VideoPlatform.YOUTUBE
        ? this.cleanYouTubeURL(this.videoURL)
        : this.videoURL;

    window.electronAPI
      .getVideoFormats(URL_TO_FETCH)
      .then(
        (result: {
          success: boolean;
          formats?: VideoFormat[];
          error?: string;
        }) => {
          this.ngZone.run(() => {
            this.loadingFormats = false;
            if (result.success && result.formats) {
              this.formats = result.formats;
              if (this.formats.length > 0) {
                this.selectedFormat = this.formats[0].id;
              }
            } else {
              this.toastrService.error(
                result.error ||
                  this.translateService.instant(
                    'view.replay_downloader.noFormats'
                  )
              );
            }
          });
        }
      );
  }

  /**
   * Initiates the download process for the video.
   * Uses the detected platform and selected format to trigger the download.
   */
  protected download(): void {
    if (!this.videoURL || !this.detectedPlatform) {
      return;
    }

    this.percent = 0;
    const URL_TO_DOWNLOAD =
      this.detectedPlatform === VideoPlatform.YOUTUBE
        ? this.cleanYouTubeURL(this.videoURL)
        : this.videoURL;

    window.electronAPI.downloadReplay(
      URL_TO_DOWNLOAD,
      this.detectedPlatform,
      this.selectedFormat
    );
    this.resetForm();
  }

  /**
   * Cleans a YouTube URL by extracting the video ID and creating a standardized YouTube watch URL.
   * This removes any additional parameters and ensures a consistent URL format for download processing.
   * @param url The original YouTube URL that may contain additional parameters.
   * @returns A clean YouTube watch URL with only the video ID parameter, or the original URL if no video ID is found.
   */
  private cleanYouTubeURL(url: string): string {
    const URL_OBJ = new URL(url);
    // Cas youtu.be
    if (URL_OBJ.hostname === 'youtu.be') {
      const VIDEO_ID = URL_OBJ.pathname.slice(1);
      return VIDEO_ID ? `https://www.youtube.com/watch?v=${VIDEO_ID}` : url;
    }

    const VIDEO_ID = URL_OBJ.searchParams.get('v');
    if (VIDEO_ID) {
      return `https://www.youtube.com/watch?v=${VIDEO_ID}`;
    }
    return url;
  }

  /**
   * Resets the form after initiating a download.
   * Clears the URL input field and format selection.
   */
  private resetForm(): void {
    this.videoURL = undefined;
    this.formats = [];
    this.selectedFormat = undefined;
    this.detectedPlatform = undefined;
  }

  /**
   * Validates whether a given URL is a valid YouTube URL.
   * Supports various YouTube URL formats including standard watch URLs, shortened youtu.be links, and live stream URLs.
   * @param url The URL string to validate.
   * @returns True if the URL matches a valid YouTube URL pattern, false otherwise.
   */
  private isYouTubeUrl(url: string): boolean {
    const regex =
      /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|live\/)|youtu\.be\/)[\w-]{11}([?&]\S*)?$/;
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
      /^(https?:\/\/)?(www\.)?twitch\.tv\/(videos\/\d+|[a-zA-Z0-9_]+\/video\/\d+|[a-zA-Z0-9_]+\/clip\/[a-zA-Z0-9_-]+)$/;
    return regex.test(url);
  }

  //#endregion
}
