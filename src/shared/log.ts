const PREFIX = '[kasanemu]';

let debugOn = false;
export function setDebug(on: boolean): void {
  debugOn = on;
}
export function isDebug(): boolean {
  return debugOn;
}
export function dbg(...args: unknown[]): void {
  if (debugOn) console.debug(PREFIX, ...args);
}
export function warn(...args: unknown[]): void {
  console.warn(PREFIX, ...args);
}
export function err(...args: unknown[]): void {
  console.error(PREFIX, ...args);
}
