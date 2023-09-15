import fs from "fs";

import { Disposable, LogOutputChannel, window } from "vscode";
import { EXT_NAME } from "./utils";

export enum LogLevel {
    none = 0,
    error = 1,
    warn = 2,
    debug = 3,
}

export class Logger implements Disposable {
    private disposables: Disposable[] = [];

    private fd = 0;

    private outputChannel?: LogOutputChannel;

    public constructor(
        private logLevel: LogLevel,
        filePath: string,
        private outputToConsole = false,
    ) {
        if (logLevel !== LogLevel.none) {
            try {
                this.fd = fs.openSync(filePath, "w");
            } catch {
                // ignore
            }
            this.outputChannel = window.createOutputChannel(`${EXT_NAME} logs`, { log: true });
            this.disposables.push(this.outputChannel);
        }
    }

    public dispose(): void {
        if (this.fd) {
            fs.closeSync(this.fd);
        }
        this.disposables.forEach((d) => d.dispose());
    }

    public debug(msg: string): void {
        msg = `${this.getTimestamp()} DEBUG ${msg}`;
        if (this.logLevel >= LogLevel.debug) {
            if (this.fd) {
                fs.appendFileSync(this.fd, msg + "\n");
            }
            if (this.outputChannel) {
                this.outputChannel.appendLine(msg);
            }
            if (this.outputToConsole) {
                console.log(msg);
            }
        }
    }

    public warn(msg: string): void {
        msg = `${this.getTimestamp()} WARN  ${msg}`;
        if (this.logLevel >= LogLevel.warn) {
            if (this.fd) {
                fs.appendFileSync(this.fd, msg + "\n");
            }
            if (this.outputChannel) {
                this.outputChannel.appendLine(msg);
            }
            if (this.outputToConsole) {
                console.log(msg);
            }
        }
    }

    public error(msg: string): void {
        const logMsg = `${this.getTimestamp()} ERROR ${msg}`;
        if (this.logLevel >= LogLevel.error) {
            if (this.fd) {
                fs.appendFileSync(this.fd, logMsg + "\n");
            }
            if (this.outputChannel) {
                this.outputChannel.appendLine(logMsg);
            }
            if (this.outputToConsole) {
                console.log(logMsg);
            }
        }
        window.showErrorMessage(msg);
    }

    private getTimestamp(): string {
        return new Date().toISOString();
    }
}
