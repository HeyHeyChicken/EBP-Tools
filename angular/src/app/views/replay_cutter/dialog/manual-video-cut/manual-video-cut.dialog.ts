// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import {
  Component,
  ElementRef,
  HostListener,
  Inject,
  OnInit,
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
export class ReplayCutterManualVideoCutDialog implements OnInit {
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

  ngOnInit(): void {}

  protected submit(): void {}

  protected onTimeUpdate(video: HTMLVideoElement) {
    this.videoCurrentTime = video.currentTime;
  }

  protected onLoadedMetadata(video: HTMLVideoElement) {
    this.videoDuration = video.duration;

    this.chunks.push(new VideoChunk(0, this.videoDuration));
  }

  protected get playing(): boolean {
    if (this.video) {
      return !this.video.nativeElement.paused;
    }
    return false;
  }

  protected addVideoTime(video: HTMLVideoElement, timeToAdd: number): void {
    this.videoCurrentTime += timeToAdd;
    video.currentTime = this.videoCurrentTime;
  }

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

  protected removeChunk(chunk: VideoChunk, event: MouseEvent): void {
    chunk.remove = !chunk.remove;
    event.stopPropagation();
  }

  protected playPause(): void {
    if (this.video) {
      if (this.playing) {
        this.video.nativeElement.pause();
      } else {
        this.video.nativeElement.play();
      }
    }
  }

  @HostListener('document:mouseup', ['$event'])
  handleMouseUpEvent() {
    this.frameCursorDragging = false;

    const VIDEO = this.video?.nativeElement;
    if (VIDEO && this.videoWasPlaying) {
      VIDEO.play();
    }
  }

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
