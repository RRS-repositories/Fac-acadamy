import express from 'express';
import type { ErrorRequestHandler, Express } from 'express';
import { healthRouter } from './modules/health/routes.js';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.use('/api/health', healthRouter);

  // Unknown API routes get JSON, never the HTML default.
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  const errorHandler: ErrorRequestHandler = (err: unknown, req, res, next) => {
    console.error(`[academy-api] ${req.method} ${req.originalUrl} failed:`, err);
    // Mid-stream failure: let Express close the connection.
    if (res.headersSent) {
      next(err);
      return;
    }
    // Never send the stack or message to the client.
    res.status(500).json({ error: 'internal' });
  };
  app.use(errorHandler);

  return app;
}
