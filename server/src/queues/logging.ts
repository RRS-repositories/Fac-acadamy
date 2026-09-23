// The smallest logger the queue code needs. The process entry points pass a
// console-backed one; tests pass a recorder and assert on the lines.

export interface QueueLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function consoleLogger(tag: string): QueueLogger {
  return {
    info: (message) => console.log(`[${tag}] ${message}`),
    warn: (message) => console.warn(`[${tag}] ${message}`),
    error: (message) => console.error(`[${tag}] ${message}`),
  };
}

export const silentLogger: QueueLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
