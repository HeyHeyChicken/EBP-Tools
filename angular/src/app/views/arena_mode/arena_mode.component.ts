// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import {
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  OnInit,
  ViewChild
} from '@angular/core';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { GridModule } from '../../shared/grid/grid.module';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { FormsModule } from '@angular/forms';

import { ToastrService } from 'ngx-toastr';
import { MessageComponent } from '../../shared/message/message.component';
import {
  ArenaCaptureDevice,
  ArenaCaptureStatus,
  ArenaLocation,
  ArenaModeState
} from '../../../models/electron';

//#endregion

@Component({
  selector: 'view-arena-mode',
  templateUrl: './arena_mode.component.html',
  styleUrls: ['./arena_mode.component.scss'],
  standalone: true,
  imports: [
    GridModule,
    TranslateModule,
    MatInputModule,
    MatSelectModule,
    MatTooltipModule,
    FormsModule,
    MessageComponent
  ]
})
export class ArenaModeComponent implements OnInit, OnDestroy {
  //#region Attributes

  protected state?: ArenaModeState;

  protected roomId?: number;
  /** Id T_EVA_Terrains de l'arène. */
  protected arenaId?: number;
  protected key?: string;
  protected registering: boolean = false;

  /** Salles activables (clé posée par un admin), pour les listes déroulantes. */
  protected locations: ArenaLocation[] = [];
  /** Arène unique dans la salle choisie → présélectionnée et verrouillée. */
  protected arenaLocked: boolean = false;

  protected devices: ArenaCaptureDevice[] = [];
  protected selectedDeviceId?: string;
  protected captureStatus?: ArenaCaptureStatus;
  private captureStatusTimer?: ReturnType<typeof setInterval>;

  @ViewChild('previewVideo')
  private previewVideo?: ElementRef<HTMLVideoElement>;
  private previewStream?: MediaStream;
  /** Nom du device actuellement prévisualisé (évite de rouvrir en boucle). */
  private previewDeviceName?: string;

  //#endregion

  constructor(
    private readonly toastrService: ToastrService,
    private readonly ngZone: NgZone,
    private readonly translateService: TranslateService
  ) {}

  //#region Functions

  ngOnInit(): void {
    window.electronAPI.arenaModeGetState().then((state: ArenaModeState) => {
      this.ngZone.run(() => {
        this.state = state;
        if (state.registered) {
          this.initCapture();
        } else {
          this.fetchLocations();
        }
      });
    });
  }

  private fetchLocations(): void {
    window.electronAPI
      .arenaModeListLocations()
      .then((locations: ArenaLocation[]) => {
        this.ngZone.run(() => {
          this.locations = locations;
        });
      });
  }

  /** Salle choisie : arène unique → présélection + verrouillage du select. */
  protected onRoomChange(): void {
    const LOCATION = this.locations.find(
      (l) => Number(l.id) === this.roomId
    );
    if (LOCATION && LOCATION.terrains.length === 1) {
      this.arenaId = Number(LOCATION.terrains[0].id);
      this.arenaLocked = true;
    } else {
      this.arenaId = undefined;
      this.arenaLocked = false;
    }
  }

  protected get selectedLocation(): ArenaLocation | undefined {
    return this.locations.find((l) => Number(l.id) === this.roomId);
  }

  ngOnDestroy(): void {
    if (this.captureStatusTimer) {
      clearInterval(this.captureStatusTimer);
    }
    document.removeEventListener(
      'visibilitychange',
      this.onVisibilityChange
    );
    this.stopPreview();
  }

  /**
   * L'aperçu ne consomme que lorsqu'il est visible : fenêtre minimisée ou
   * masquée → on coupe le flux caméra (un PC de salle peut rester des heures
   * sur cette page). Le poll de statut (5 s) le relancera à la réapparition.
   */
  private readonly onVisibilityChange = (): void => {
    if (document.hidden) {
      this.ngZone.run(() => this.stopPreview());
    }
  };

  /**
   * Aperçu live de la source : la même caméra (virtuelle) que ffmpeg, ouverte
   * en parallèle via getUserMedia — les caméras virtuelles acceptent plusieurs
   * lecteurs. Résolution réduite : c'est un contrôle visuel, pas la captation.
   */
  private async startPreview(deviceName: string): Promise<void> {
    if (this.previewDeviceName === deviceName) {
      return;
    }
    this.stopPreview();
    this.previewDeviceName = deviceName;
    try {
      // Le label Chromium correspond au nom du périphérique système (même
      // source que la liste ffmpeg).
      const DEVICES = await navigator.mediaDevices.enumerateDevices();
      const MATCH = DEVICES.find(
        (d) => d.kind === 'videoinput' && d.label === deviceName
      );
      if (!MATCH) {
        this.previewDeviceName = undefined;
        return;
      }
      const STREAM = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: { exact: MATCH.deviceId },
          width: { ideal: 640 }
        }
      });
      this.previewStream = STREAM;
      this.attachPreview();
    } catch (e) {
      console.warn('Preview unavailable:', e);
      this.previewDeviceName = undefined;
    }
  }

  /**
   * Attache le flux au <video>. L'élément n'existe qu'une fois le bloc
   * "running" rendu : si le rendu n'est pas encore passé, on réessaie.
   */
  private attachPreview(attempt: number = 0): void {
    if (!this.previewStream) {
      return;
    }
    if (this.previewVideo) {
      this.previewVideo.nativeElement.srcObject = this.previewStream;
    } else if (attempt < 10) {
      setTimeout(() => this.attachPreview(attempt + 1), 100);
    }
  }

  private stopPreview(): void {
    if (this.previewStream) {
      for (const TRACK of this.previewStream.getTracks()) {
        TRACK.stop();
      }
      this.previewStream = undefined;
    }
    if (this.previewVideo) {
      this.previewVideo.nativeElement.srcObject = null;
    }
    this.previewDeviceName = undefined;
  }

  /**
   * Charge périphériques + statut de captation, et rafraîchit le statut
   * toutes les 5 s tant que la page est ouverte (la captation vit côté main
   * process, indépendamment de cette page).
   */
  private initCapture(): void {
    this.refreshDevices();
    this.refreshCaptureStatus();
    if (!this.captureStatusTimer) {
      this.captureStatusTimer = setInterval(
        () => this.refreshCaptureStatus(),
        5000
      );
    }
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  protected refreshDevices(): void {
    window.electronAPI
      .arenaCaptureListDevices()
      .then((devices: ArenaCaptureDevice[]) => {
        this.ngZone.run(() => {
          this.devices = devices;
        });
      });
  }

  private refreshCaptureStatus(): void {
    window.electronAPI
      .arenaCaptureGetStatus()
      .then((status: ArenaCaptureStatus) => {
        this.ngZone.run(() => {
          this.captureStatus = status;
          if (this.selectedDeviceId === undefined && status.deviceId) {
            this.selectedDeviceId = status.deviceId;
          }
          if (status.running && status.deviceName && !document.hidden) {
            this.startPreview(status.deviceName);
          } else if (!status.running) {
            this.stopPreview();
          }
        });
      });
  }

  /** Sélectionne le périphérique et (re)démarre la captation dessus. */
  protected applyDevice(): void {
    const DEVICE = this.devices.find((d) => d.id === this.selectedDeviceId);
    if (!DEVICE) {
      return;
    }
    window.electronAPI
      .arenaCaptureSetDevice(DEVICE)
      .then((status: ArenaCaptureStatus) => {
        this.ngZone.run(() => {
          this.captureStatus = status;
        });
      });
  }

  /** Ouvre le dossier de travail du mode salle (spool/, work/, games/). */
  protected openFolder(): void {
    window.electronAPI.arenaOpenFolder();
  }

  protected toggleCapture(): void {
    const CALL = this.captureStatus?.running
      ? window.electronAPI.arenaCaptureStop()
      : window.electronAPI.arenaCaptureStart();
    CALL.then((status: ArenaCaptureStatus) => {
      this.ngZone.run(() => {
        this.captureStatus = status;
      });
    });
  }

  /**
   * Registers this machine as the streaming PC of the given arena by
   * validating the room key against the EBP backend.
   */
  protected register(): void {
    if (this.registering || !this.roomId || !this.arenaId || !this.key) {
      return;
    }
    this.registering = true;
    window.electronAPI
      .arenaModeRegister(this.roomId, this.arenaId, this.key)
      .then((result) => {
        this.ngZone.run(() => {
          this.registering = false;
          if (result.success && result.state) {
            this.state = result.state;
            this.key = undefined;
            this.initCapture();
          } else {
            this.toastrService.error(
              this.translateService.instant(
                `view.arena_mode.errors.${result.error ?? 'network'}`
              )
            );
          }
        });
      })
      .catch((e: unknown) => {
        // Échec de l'IPC lui-même (ex. main process sans le handler) : sans ce
        // catch, le spinner tournerait indéfiniment sans aucun feedback.
        console.error('arena-mode-register IPC failed', e);
        this.ngZone.run(() => {
          this.registering = false;
          this.toastrService.error(
            this.translateService.instant('view.arena_mode.errors.network')
          );
        });
      });
  }

  /**
   * Unregisters the arena mode on this machine.
   */
  protected unregister(): void {
    window.electronAPI.arenaModeUnregister().then((state: ArenaModeState) => {
      this.ngZone.run(() => {
        this.state = state;
      });
    });
  }

  //#endregion
}
