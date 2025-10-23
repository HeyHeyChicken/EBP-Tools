// Copyright (c) 2025, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

//#region Imports

import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable } from 'rxjs';
import { LogData } from '../../../../models/log-data';

//#endregion

@Injectable({
  providedIn: 'root'
})
export class ConsoleService {
  //#region Attributes

  public static readonly MAX_LOGS = 500;
  public disabled: boolean = false;
  private _logsSubject = new BehaviorSubject<LogData[]>([]);

  //#endregion

  constructor() {
    this.initializeElectronLogListener();
    this.setupConsoleRedirection();
  }

  //#region Functions

  /**
   * Gets the observable stream of Electron console logs.
   * @returns Observable array of log data.
   */
  public get logs$(): Observable<LogData[]> {
    return this._logsSubject.asObservable();
  }

  /**
   * Gets the current logs array.
   * @returns Current array of log data.
   */
  public get currentLogs(): LogData[] {
    return this._logsSubject.value;
  }

  /**
   * Clears all stored logs.
   */
  public clearLogs(): void {
    this._logsSubject.next([]);
  }

  /**
   * Filters logs by level.
   * @param level The log level to filter by.
   * @returns Array of logs matching the specified level.
   */
  public getLogsByLevel(level: LogData['level']): LogData[] {
    return this.currentLogs.filter((log) => log.level === level);
  }

  /**
   * Initializes the Electron log listener through the electronAPI.
   */
  private initializeElectronLogListener(): void {
    if (typeof window !== 'undefined' && window.electronAPI) {
      window.electronAPI.onConsoleLog((logData: LogData) => {
        this.addLog(logData);
      });
    }
  }

  /**
   * Adds a new log entry to the logs array with size management.
   * @param logData The log data to add.
   */
  private addLog(logData: LogData): void {
    this._logsSubject.next([...this.currentLogs, logData]);
  }

  private setupConsoleRedirection() {
    // Store original console methods
    const originalConsole = {
      log: console.log,
      error: console.error,
      warn: console.warn,
      info: console.info,
      debug: console.debug
    };

    // Helper function to sanitize objects by replacing data:image/ URLs with "..."
    const sanitizeArg = (arg: any): string => {
      if (typeof arg === 'object' && arg !== null) {
        const sanitized = this.sanitizeImageData(arg);
        return JSON.stringify(sanitized, null, 2);
      }
      return String(arg);
    };

    // Override console methods
    console.log = (...args) => {
      originalConsole.log(...args);

      this.addLog({
        level: 'log',
        message: args.map(sanitizeArg).join(' '),
        timestamp: new Date().toISOString(),
        source: 'angular'
      });
    };

    console.error = (...args) => {
      originalConsole.error(...args);

      this.addLog({
        level: 'error',
        message: args.map(sanitizeArg).join(' '),
        timestamp: new Date().toISOString(),
        source: 'angular'
      });
    };

    console.warn = (...args) => {
      originalConsole.warn(...args);

      this.addLog({
        level: 'warn',
        message: args.map(sanitizeArg).join(' '),
        timestamp: new Date().toISOString(),
        source: 'angular'
      });
    };

    console.info = (...args) => {
      originalConsole.info(...args);

      this.addLog({
        level: 'info',
        message: args.map(sanitizeArg).join(' '),
        timestamp: new Date().toISOString(),
        source: 'angular'
      });
    };

    console.debug = (...args) => {
      originalConsole.debug(...args);

      this.addLog({
        level: 'debug',
        message: args.map(sanitizeArg).join(' '),
        timestamp: new Date().toISOString(),
        source: 'angular'
      });
    };
  }

  /**
   * Recursively sanitizes an object by replacing any string values that start with "data:image/" with "...".
   * This prevents large base64 image data from cluttering the console logs.
   * @param obj The object to sanitize.
   * @returns A sanitized copy of the object.
   */
  private sanitizeImageData(obj: any): any {
    if (obj === null || obj === undefined) {
      return obj;
    }

    if (typeof obj === 'string') {
      return obj.startsWith('data:image/') ? 'data:image/...' : obj;
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.sanitizeImageData(item));
    }

    if (typeof obj === 'object') {
      const sanitized: any = {};
      for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
          sanitized[key] = this.sanitizeImageData(obj[key]);
        }
      }
      return sanitized;
    }

    return obj;
  }

  //#endregion
}
