import fs from 'fs';

const MAX_LOG_SIZE_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_ROTATED_FILES = 3;

class Logger {
  private logFile: string;
  private logStream: fs.WriteStream;
  private currentSize = 0;

  constructor(logFile = 'log.txt') {
    this.logFile = logFile;
    this.logStream = this.openStream();
  }

  private openStream(): fs.WriteStream {
    if (fs.existsSync(this.logFile)) {
      const stats = fs.statSync(this.logFile);
      this.currentSize = stats.size;
    } else {
      this.currentSize = 0;
    }
    return fs.createWriteStream(this.logFile, { flags: 'a' });
  }

  private rotate(): void {
    this.logStream.end();

    for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
      const src = `${this.logFile}.${i}`;
      const dst = `${this.logFile}.${i + 1}`;
      if (fs.existsSync(src)) {
        fs.renameSync(src, dst);
      }
    }

    if (fs.existsSync(this.logFile)) {
      fs.renameSync(this.logFile, `${this.logFile}.1`);
    }

    this.currentSize = 0;
    this.logStream = this.openStream();
  }

  log(message: string): void {
    const now = new Date().toISOString();
    const logMsg = `${now}: ${message}\n`;
    const bytes = Buffer.byteLength(logMsg, 'utf8');

    if (this.currentSize + bytes > MAX_LOG_SIZE_BYTES) {
      this.rotate();
    }

    this.logStream.write(logMsg);
    this.currentSize += bytes;
    process.stdout.write(logMsg);
  }

  error(message: string, error?: Error): void {
    const errorMsg = error ? `${message}: ${error.message}` : message;
    this.log(`ERROR: ${errorMsg}`);
    if (error?.stack) {
      this.log(`STACK: ${error.stack}`);
    }
  }

  warn(message: string): void {
    this.log(`WARN: ${message}`);
  }

  info(message: string): void {
    this.log(`INFO: ${message}`);
  }

  close(): void {
    this.logStream.end();
  }
}

export const logger = new Logger();
