import * as fs from 'fs';

export type DebugLevel = 'off' | 'basic' | 'verbose';

let level: DebugLevel = 'off';
let logFile: fs.WriteStream | null = null;

export function setDebugLevel(l: DebugLevel): void {
  level = l;
}

export function setDebugLogFile(path: string): void {
  logFile = fs.createWriteStream(path, { flags: 'a' });
}

function ts(): string {
  return new Date().toISOString();
}

function write(tag: string, msg: string): void {
  const line = `[${ts()}] [${tag}] ${msg}`;
  console.log(line);
  logFile?.write(line + '\n');
}

export function hexDump(buf: Buffer, maxBytes = 64): string {
  const hex = buf.subarray(0, maxBytes).toString('hex').match(/.{1,2}/g)?.join(' ') ?? '';
  return hex + (buf.length > maxBytes ? ` ... (${buf.length} bytes total)` : ` (${buf.length} bytes)`);
}

export function dbg(tag: string, msg: string): void {
  if (level !== 'off') write(tag, msg);
}

export function dbgVerbose(tag: string, msg: string): void {
  if (level === 'verbose') write(tag, msg);
}

export function isDebug(): boolean {
  return level !== 'off';
}

export function isVerbose(): boolean {
  return level === 'verbose';
}

/**
 * Always-on log for connection lifecycle milestones (open, verify,
 * fallback, disconnect, reconnect). These are rare and are exactly what
 * you need in a production log when the device stops responding, so they
 * are not gated behind the debug level.
 */
export function info(tag: string, msg: string): void {
  write(tag, msg);
}
