import cookieParser from 'cookie-parser';
import express from 'express';
import type { ErrorRequestHandler, Express } from 'express';
import { requireAcademyFlag } from './middleware/flag.js';
import { authRouter } from './modules/auth/routes.js';
import type { AuthDeps } from './modules/auth/routes.js';
import { healthRouter } from './modules/health/routes.js';
import { managerRouter } from './modules/manager/accounts.js';

export interface AppDeps {
  /** ACADEMY_V2. When false, every API route except /api/health is 503. */
  flagEnabled: boolean;
  /** Never throws; resolves false when the database is unreachable. */
  checkDb: () => Promise<boolean>;
  /** Never throws; resolves false when Redis is unreachable or not configured. */
  checkRedis: () => Promise<boolean>;
  /**
   * Sign-in, sessions and manager account routes: database pool, session and
   * pending-MFA stores, CRM client, limiters, MFA key and clock. Omitted only
   * by tests that exercise health and the flag gate alone.
   */
  auth?: AuthDeps;
}

export function createApp(deps: AppDeps): Express {
  const app = express();

  app.disable('x-powered-by');
  // nginx runs on the same box: trust X-Forwarded-For from loopback only, so
  // req.ip is the real client (rate limits and audit rows depend on it).
  app.set('trust proxy', 'loopback');
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.use('/api/health', healthRouter(deps));

  // Flag gate: after health, before every other API route and the JSON 404.
  app.use('/api', requireAcademyFlag(deps.flagEnabled));

  if (deps.auth !== undefined) {
    app.use('/api', authRouter(deps.auth));
    app.use('/api/manager', managerRouter(deps.auth));
  }

  // Further feature routers are mounted here in later sections.

  // Unknown API routes get JSON, never the HTML default.
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  const errorHandler: ErrorRequestHandler = (err: unknown, req, res, next) => {
    // Body parser rejections (malformed JSON, too large) are the client's fault.
    const status = (err as { status?: unknown } | null)?.status;
    if (!res.headersSent && (status === 400 || status === 413)) {
      res.status(status).json({ error: 'invalid_request' });
      return;
    }
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
