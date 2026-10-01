const t0 = Date.now();

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export function log(level: LogLevel, msg: string): void {
  const now = new Date();
  const ts = now.toTimeString().slice(0, 8);
  process.stdout.write(`[${ts}] [${level}] ${msg}\n`);
}

export function uptime(): number {
  return Date.now() - t0;
}
