/* eslint-disable no-console */

const PREFIX = '[nijam]';

let silent = false;

/** Suppress all output (set from the `silent` option). */
export function setSilent(value: boolean): void {
  silent = value;
}

export const log = {
  warn(message: string): void {
    if (silent) return;
    console.warn(`${PREFIX} ${message}`);
  },
  /** Info is only emitted when not silent. Kept terse so it never spams CI logs. */
  info(message: string): void {
    if (silent) return;
    console.warn(`${PREFIX} ${message}`);
  },
};
