import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { RateLimiterMemory, RateLimiterRedis } from 'rate-limiter-flexible';
import type { RateLimiterAbstract } from 'rate-limiter-flexible';
import {
  CERT_PUBLIC_ID_PATTERN,
  CERT_VERIFY_RATE_LIMIT_PER_MINUTE,
  CertErrorSchema,
  CertVerifyResponseSchema,
} from '@fac-academy/shared';
import { findByPublicId } from './repo.js';

// GET /api/cert/:publicId/verify — the PUBLIC one.
//
// Anyone with a certificate in their hand can check it: a recruiter, a client,
// anybody. So this router is mounted before requireAuth, with no session and
// no cookie. It is still behind the ACADEMY_V2 flag, because the flag gate is
// mounted on /api ahead of every router.
//
// Four rules make it safe to leave open:
//
//  1. **It says almost nothing.** Five facts: the name on the certificate, the
//     track, the kind, what was completed and when. No email, no scores, no
//     stages, no id numbers, nothing about anybody else.
//  2. **It never says whether a row exists.** A real id answers
//     `{ valid: true, ... }`; an id that never existed, a tampered id, a
//     malformed id and a revoked certificate all answer exactly
//     `{ valid: false }` — same status, same body, and the same work done
//     first, so the response time does not give the answer away either.
//  3. **30 requests a minute per IP address**, so the 24-character ids cannot
//     be walked even in theory.
//  4. **Nothing is cached**: no-store, so an answer is never served from a
//     shared cache after a certificate is revoked.

export interface CertVerifyDeps {
  db: Pool;
  /** Shared with the sign-in limiters when Redis is configured. */
  redis?: Redis | null;
  /** Requests per IP per minute. Defaults to the shared contract's 30. */
  limitPerMinute?: number;
}

/**
 * A public id that cannot match a row, used to do the same database work for a
 * malformed id as for a real one. Random per process, so it cannot be guessed
 * and cannot collide with anything ever issued.
 */
const IMPOSSIBLE_ID = randomBytes(18).toString('base64url');

function limiter(redis: Redis | null, points: number): RateLimiterAbstract {
  const memory = new RateLimiterMemory({
    keyPrefix: 'academy:rl-cert-verify',
    points,
    duration: 60,
  });
  if (redis === null) return memory;
  return new RateLimiterRedis({
    keyPrefix: 'academy:rl-cert-verify',
    points,
    duration: 60,
    storeClient: redis,
    insuranceLimiter: memory,
  });
}

export function certVerifyRouter(deps: CertVerifyDeps): Router {
  const router = Router();
  const perIp = limiter(
    deps.redis ?? null,
    deps.limitPerMinute ?? CERT_VERIFY_RATE_LIMIT_PER_MINUTE,
  );

  router.get('/cert/:publicId/verify', async (req, res) => {
    // app.ts trusts X-Forwarded-For from loopback only, so req.ip is the real
    // caller behind nginx and cannot be spoofed from outside.
    const ip = req.ip ?? 'unknown';
    try {
      await perIp.consume(ip);
    } catch (rejection) {
      if (rejection instanceof Error) throw rejection; // a limiter failure, not a limit
      res.setHeader('Cache-Control', 'no-store');
      res.status(429).json(CertErrorSchema.parse({ error: 'rate_limited' }));
      return;
    }

    const asked = String(req.params.publicId ?? '');
    // A malformed id is looked up too (as an id that cannot exist), so the
    // work done — and therefore the time taken — is the same either way.
    const lookup = CERT_PUBLIC_ID_PATTERN.test(asked) ? asked : IMPOSSIBLE_ID;
    const certificate = await findByPublicId(deps.db, lookup);

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (certificate === null || certificate.revokedAt !== null) {
      res.json(CertVerifyResponseSchema.parse({ valid: false }));
      return;
    }

    res.json(
      CertVerifyResponseSchema.parse({
        valid: true,
        name: certificate.holderName,
        track: certificate.track,
        kind: certificate.kind,
        completed: certificate.title,
        issuedAt: certificate.issuedAt.toISOString(),
      }),
    );
  });

  return router;
}
