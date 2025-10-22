// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { CommonModule } from '@angular/common';
import { Component, HostListener, OnDestroy, OnInit } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSelectModule } from '@angular/material/select';
import { FormsModule } from '@angular/forms';
import { Observable, Subscription } from 'rxjs';
import { ElectronConsoleService } from '../../core/services/electron-console.service';
import { LogData } from '../../../models/log-data';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { ToastrService } from 'ngx-toastr';

//#endregion

@Component({
  selector: 'shared-console',
  templateUrl: './console.component.html',
  styleUrls: ['./console.component.scss'],
  standalone: true,
  imports: [
    CommonModule,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
    MatSelectModule,
    FormsModule,
    TranslateModule
  ]
})
export class ConsoleComponent implements OnInit, OnDestroy {
  //#region Attributes

  protected isVisible = false;
  protected selectedLogLevel = 'all';
  protected logs$: Observable<LogData[]>;
  private subscription: Subscription = new Subscription();

  protected readonly logLevels = [
    { value: 'all', label: 'All Logs' },
    { value: 'log', label: 'Log' },
    { value: 'info', label: 'Info' },
    { value: 'warn', label: 'Warning' },
    { value: 'error', label: 'Error' },
    { value: 'debug', label: 'Debug' }
  ];

  //#endregion

  constructor(
    private electronConsoleService: ElectronConsoleService,
    private readonly translateService: TranslateService,
    private readonly toastrService: ToastrService
  ) {
    this.logs$ = this.electronConsoleService.logs$;
  }

  //#region Functions

  ngOnInit(): void {
    // Auto-scroll to bottom when new logs arrive
    this.subscription.add(
      this.logs$.subscribe(() => {
        setTimeout(() => this.scrollToBottom(), 100);
      })
    );
  }

  ngOnDestroy(): void {
    this.subscription.unsubscribe();
  }

  /**
   * Handles keyboard shortcuts to toggle console visibility.
   * Ctrl+Shift+C toggles the console.
   * @param event The keyboard event.
   */
  @HostListener('document:keydown', ['$event'])
  handleKeyboard(event: KeyboardEvent): void {
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      this.toggleConsole();
    }
  }

  /**
   * Toggles the console visibility.
   */
  protected toggleConsole(): void {
    this.isVisible = !this.isVisible;
    if (this.isVisible) {
      setTimeout(() => this.scrollToBottom(), 100);
    }
  }

  protected async downloadLogs(): Promise<void> {
    try {
      const FILTERED_LOGS = this.getFilteredLogs(
        this.electronConsoleService.currentLogs
      );

      if (window.electronAPI) {
        const FILE_PATH =
          await window.electronAPI.saveConsoleLogs(FILTERED_LOGS);

        this.translateService
          .get('shared.console.logsExported', { path: FILE_PATH })
          .subscribe((translated: string) => {
            this.toastrService.success(translated).onTap.subscribe(() => {
              window.electronAPI.openFile(FILE_PATH);
            });
          });
      } else {
        console.error('Electron API not available');
      }
    } catch (error) {
      console.error('Error exporting logs:', error);
    }
  }

  /**
   * Closes the console.
   */
  protected closeConsole(): void {
    this.isVisible = false;
  }

  /**
   * Clears all console logs.
   */
  protected clearLogs(): void {
    this.electronConsoleService.clearLogs();
  }

  /**
   * Filters logs based on the selected log level.
   * @param logs Array of all logs.
   * @returns Filtered array of logs.
   */
  protected getFilteredLogs(logs: LogData[]): LogData[] {
    if (this.selectedLogLevel === 'all') {
      return logs;
    }
    const LOGS: LogData[] = logs.filter(
      (log) => log.level === this.selectedLogLevel
    );
    return LOGS.splice(0, LOGS.length - ElectronConsoleService.MAX_LOGS);
  }

  /**
   * Gets the CSS class for a log entry based on its level.
   * @param level The log level.
   * @returns CSS class name.
   */
  protected getLogClass(level: string): string {
    return `log-${level}`;
  }

  /**
   * Formats the timestamp for display.
   * @param timestamp ISO timestamp string.
   * @returns Formatted time string.
   */
  protected formatTime(timestamp: string): string {
    return new Date(timestamp).toLocaleTimeString();
  }

  /**
   * Scrolls the console content to the bottom.
   */
  private scrollToBottom(): void {
    const element = document.querySelector('.console-content');
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }

  //#endregion
}
