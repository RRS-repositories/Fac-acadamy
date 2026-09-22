import express from 'express';
import type { ErrorRequestHandler, Express } from 'express';
import { requireAcademyFlag } from './middleware/flag.js';
import { healthRouter } from './modules/health/routes.js';

export interface AppDeps {
  /** ACADEMY_V2. When false, every API route except /api/health is 503. */
  flagEnabled: boolean;
  /** Never throws; resolves false when the database is unreachable. */
  checkDb: () => Promise<boolean>;
  /** Never throws; resolves false when Redis is unreachable or not configured. */
  checkRedis: () => Promise<boolean>;
}

export function createApp(deps: AppDeps): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.use('/api/health', healthRouter(deps));

  // Flag gate: after health, before every other API route and the JSON 404.
  app.use('/api', requireAcademyFlag(deps.flagEnabled));

  // Feature routers are mounted here in later sections.

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
