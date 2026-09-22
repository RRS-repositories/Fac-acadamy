// Background worker. Queues arrive in later sections: BullMQ with
// prefix 'academy' and plain queue names (BullMQ throws on names containing ':').

console.log('[academy-worker] started; no queues registered yet (they arrive in later sections)');

// Nothing is listening yet, so hold the event loop open until we are told to stop.
const keepAlive = setInterval(() => {}, 60 * 60 * 1000);

function shutdown(signal: NodeJS.Signals): void {
  console.log(`[academy-worker] ${signal} received, stopping`);
  clearInterval(keepAlive);
  process.exit(0);
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
