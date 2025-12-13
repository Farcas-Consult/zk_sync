import fs from 'fs';

class Logger {
  private logStream: fs.WriteStream;

  constructor(logFile = 'log.txt') {
    this.logStream = fs.createWriteStream(logFile, { flags: 'a' });
  }

  log(message: string): void {
    const now = new Date().toISOString();
    const logMsg = `${now}: ${message}\n`;
    this.logStream.write(logMsg);
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

