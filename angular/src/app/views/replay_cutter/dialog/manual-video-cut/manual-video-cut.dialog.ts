// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import {
  Component,
  ElementRef,
  HostListener,
  Inject,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  MAT_DIALOG_DATA,
  MatDialogModule,
  MatDialogRef
} from '@angular/material/dialog';
import { TranslateModule } from '@ngx-translate/core';
import { GlobalService } from '../../../../core/services/global.service';
import { VideoChunk } from '../../models/video-chunk';
import { MatTooltipModule } from '@angular/material/tooltip';

//#endregion

@Component({
  selector: 'replay-cutter-dialog-manual-video-cut',
  templateUrl: './manual-video-cut.dialog.html',
  styleUrls: ['./manual-video-cut.dialog.scss'],
  imports: [CommonModule, MatDialogModule, TranslateModule, MatTooltipModule],
  standalone: true
})
export class ReplayCutterManualVideoCutDialog {
  //#region Attributes

  @ViewChild('videoPlayer') video: ElementRef<HTMLVideoElement> | undefined;
  @ViewChild('videoBar') bar: ElementRef<HTMLDivElement> | undefined;

  protected videoCurrentTime: number = 0;
  protected videoDuration: number = 0;
  protected videoLoaded: boolean = false;
  protected videoWasPlaying: boolean = false;

  protected chunks: VideoChunk[] = [];
  protected frameCursorDragging: boolean = false;

  //#endregion

  constructor(
    protected readonly globalService: GlobalService,
    private readonly dialogRef: MatDialogRef<ReplayCutterManualVideoCutDialog>,
    @Inject(MAT_DIALOG_DATA) public readonly data: string
  ) {}

  //#region Functions

  /**
   * Submit the video chunks and close the dialog.
   * Only submits if the button is not disabled.
   */
  protected submit(): void {
    if (!this.submitButtonIsDisabled) {
      this.dialogRef.close(this.chunks);
    }
  }

  /**
   * Check if the submit button should be disabled.
   * @returns True if no chunks are marked for removal, false otherwise.
   */
  protected get submitButtonIsDisabled(): boolean {
    return !this.chunks.some((chunk) => chunk.remove === true);
  }

  /**
   * Update the current time when the video position changes.
   * @param video HTML video element.
   */
  protected onTimeUpdate(video: HTMLVideoElement) {
    this.videoCurrentTime = video.currentTime;
  }

  /**
   * When the video metadata is loaded, the video duration is stored and we create the initial chunk.
   * @param video HTML video element.
   */
  protected onLoadedMetadata(video: HTMLVideoElement) {
    this.videoDuration = video.duration;

    this.chunks = [new VideoChunk(0, this.videoDuration)];
  }

  /**
   * Get the current playing state of the video.
   * @returns True if the video is playing, false if paused or video element is not available.
   */
  protected get playing(): boolean {
    if (this.video) {
      return !this.video.nativeElement.paused;
    }
    return false;
  }

  /**
   * Add or subtract time to/from the current video position.
   * @param video HTML video element.
   * @param timeToAdd Time in seconds to add or subtract.
   */
  protected addVideoTime(video: HTMLVideoElement, timeToAdd: number): void {
    this.videoCurrentTime += timeToAdd;
    video.currentTime = this.videoCurrentTime;
  }

  /**
   * Split a video chunk at the current time position.
   * Creates a new chunk from the start of the current chunk to the current time, and modifies the existing chunk to start from the current time.
   */
  protected cut(): void {
    if (this.video) {
      for (let i = 0; i < this.chunks.length; i++) {
        if (
          this.videoCurrentTime > this.chunks[i].start &&
          this.videoCurrentTime < this.chunks[i].end
        ) {
          this.chunks.push(
            new VideoChunk(this.chunks[i].start, this.videoCurrentTime)
          );
          this.chunks[i].start = this.videoCurrentTime;
          break;
        }
      }
      this.chunks.sort((a, b) => a.end - b.end);
    }
  }

  /**
   * Toggle the removal state of a video chunk.
   * @param chunk The video chunk to toggle.
   * @param event Mouse event to prevent propagation.
   */
  protected removeChunk(chunk: VideoChunk, event: MouseEvent): void {
    chunk.remove = !chunk.remove;
    event.stopPropagation();
  }

  /**
   * Toggle video playback between play and pause states.
   * @param video HTML video element to control.
   */
  protected playPause(video: HTMLVideoElement): void {
    if (this.playing) {
      video.pause();
    } else {
      video.play();
    }
  }

  /**
   * Handle mouse down event on the video progress bar to seek to a specific position.
   * Pauses video if playing, starts dragging mode, and calculates the clicked position.
   * @param event Mouse down event.
   */
  protected mouseDownOnBar(event: Event): void {
    if (event.target) {
      const BAR = this.bar?.nativeElement;
      const VIDEO = this.video?.nativeElement;
      if (BAR && VIDEO) {
        this.videoWasPlaying = this.playing;
        if (this.videoWasPlaying) {
          VIDEO.pause();
        }

        this.frameCursorDragging = true;
        const POINTER_EVENT = event as PointerEvent;
        let x: number = Math.max(
          0,
          POINTER_EVENT.clientX - BAR.getBoundingClientRect().left
        );
        this.videoCurrentTime = Math.min(
          Math.ceil((x / BAR.clientWidth) * this.videoDuration),
          this.videoDuration
        );
        VIDEO.currentTime = this.videoCurrentTime;
      }
    }
  }

  /**
   * Handle mouse up event to stop dragging and resume video playback if it was playing before.
   */
  @HostListener('document:mouseup', ['$event'])
  handleMouseUpEvent() {
    this.frameCursorDragging = false;

    const VIDEO = this.video?.nativeElement;
    if (VIDEO && this.videoWasPlaying) {
      VIDEO.play();
    }
  }

  /**
   * Handle mouse move event during dragging to continuously update video position.
   * @param event Mouse move event.
   */
  @HostListener('document:mousemove', ['$event'])
  handleMouseMoveEvent(event: MouseEvent) {
    if (this.frameCursorDragging) {
      const BAR = this.bar?.nativeElement;
      const VIDEO = this.video?.nativeElement;
      if (BAR && VIDEO) {
        const X = Math.max(0, event.clientX - BAR.getBoundingClientRect().left);
        this.videoCurrentTime = Math.min(
          Math.ceil((X / BAR.clientWidth) * this.videoDuration),
          this.videoDuration
        );
        this.videoCurrentTime = Math.min(
          this.videoCurrentTime,
          this.videoDuration
        );
        VIDEO.currentTime = this.videoCurrentTime;
      }
    }
  }

  //#endregion
}
