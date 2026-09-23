import cookieParser from 'cookie-parser';
import express from 'express';
import type { ErrorRequestHandler, Express } from 'express';
import { mediaProgressRouter } from './media/progress.js';
import { mediaStreamRouter } from './media/routes.js';
import type { MediaStore } from './media/store.js';
import { managerUploadRouter } from './media/upload.js';
import { requireAcademyFlag } from './middleware/flag.js';
import { authRouter } from './modules/auth/routes.js';
import type { AuthDeps } from './modules/auth/routes.js';
import { healthRouter } from './modules/health/routes.js';
import { managerRouter } from './modules/manager/routes.js';
import type { TrainingDeps } from './modules/training/repo.js';
import { trainingRouter } from './modules/training/routes.js';
import type { JobQueue } from './queues/queue.js';

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
  /**
   * Training routes (S04): the track list, stage content, lesson reads and
   * quizzes. Omitted only by tests that exercise health and the flag gate.
   */
  training?: TrainingDeps;
  /**
   * ACADEMY_PROVISIONING. Surfaced read-only by GET /api/manager/config
   * (S07 task 4) beside ACADEMY_V2 and STAGE1_AUTH_REQUIRED; nothing in the
   * API can change any of the three.
   */
  provisioningEnabled?: boolean;
  /**
   * Where the media files live (S06, decision D15: on the server's own disk,
   * never S3). Given together with `training`, it mounts
   * GET /api/media/:recordingId/stream. Left out, there is no streaming route
   * at all — which is what the tests that only exercise health and the flag do,
   * and it fails closed rather than serving from a default folder.
   */
  mediaStore?: MediaStore;
  /**
   * S06 manager upload. Given together with `auth` and `mediaStore`, it mounts
   * POST /api/manager/recordings: the queue the transcription and
   * draft-question jobs go on, and MEDIA_MAX_UPLOAD_MB already in bytes.
   */
  mediaUpload?: { queue: JobQueue; maxUploadBytes: number };
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
    // S06 manager upload (POST /api/manager/recordings). Mounted before the
    // S07 manager router and guarded per route, so every other manager route
    // falls through it without a second session lookup.
    if (deps.mediaStore !== undefined && deps.mediaUpload !== undefined) {
      app.use(
        '/api/manager',
        managerUploadRouter({ ...deps.auth, store: deps.mediaStore, ...deps.mediaUpload }),
      );
    }
    app.use(
      '/api/manager',
      managerRouter({
        ...deps.auth,
        stage1AuthRequired: deps.training?.stage1AuthRequired ?? false,
        academyV2: deps.flagEnabled,
        provisioningEnabled: deps.provisioningEnabled ?? false,
      }),
    );
  }

  if (deps.training !== undefined) {
    app.use('/api', trainingRouter(deps.training));
    // S06 listening beacons. Its own router under /api/media so the streaming
    // half can mount beside it without either owning the whole prefix; it runs
    // the same requireAuth and the same gate() as every content route.
    app.use('/api/media', mediaProgressRouter(deps.training));
    // S06 streaming. The other half of /api/media: every byte of every
    // recording and of the video leaves the server through here, after the
    // same requireAuth and the same gate().
    if (deps.mediaStore !== undefined) {
      app.use('/api/media', mediaStreamRouter({ ...deps.training, store: deps.mediaStore }));
    }
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
