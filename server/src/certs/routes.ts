import { Router } from 'express';
import type { Response } from 'express';
import type { Pool } from 'pg';
import {
  CERT_PUBLIC_ID_PATTERN,
  CertErrorSchema,
  MyCertificatesResponseSchema,
} from '@fac-academy/shared';
import type { Certificate, CertErrorCode } from '@fac-academy/shared';
import { authOf, requireAuth } from '../middleware/auth.js';
import type { RequireAuthDeps } from '../middleware/auth.js';
import { MediaKeyError } from '../media/store.js';
import type { MediaStore } from '../media/store.js';
import { actor, writeAudit } from '../modules/audit/audit.js';
import { CERT_CONTENT_TYPE } from './issue.js';
import type { CertificateIssuer } from './issue.js';
import { findByPublicId, listForTrainee } from './repo.js';
import type { CertificateRow } from './repo.js';

// The signed-in certificate routes:
//
//   GET /api/certs                        the caller's own certificates
//   GET /api/certs/:publicId/download     the PDF, as an attachment
//
// Both sit behind the ACADEMY_V2 flag (app.ts mounts the gate on /api first)
// and behind requireAuth. The public verify endpoint is deliberately NOT here:
// it has no session at all and lives in verify.routes.ts.
//
// Who may download: the holder, or any manager. A different trainee gets the
// same 404 as an id that does not exist, so a certificate id cannot be used to
// find out whether a colleague passed something. A revoked certificate is 404
// for everyone, the same answer the verify endpoint gives.

export interface CertRoutesDeps extends RequireAuthDeps {
  db: Pool;
  /** The local store the PDFs live in (D15: the server's own disk). */
  store: MediaStore;
  /** Used to re-render a certificate whose file has gone missing. */
  issuer: CertificateIssuer;
}

function fail(res: Response, status: number, error: CertErrorCode): void {
  res.status(status).json(CertErrorSchema.parse({ error }));
}

/** The wire shape of one certificate. */
function toPayload(row: CertificateRow): Certificate {
  return {
    publicId: row.publicId,
    kind: row.kind,
    title: row.title,
    accomplishment: row.accomplishment,
    track: row.track,
    holderName: row.holderName,
    issuedAt: row.issuedAt.toISOString(),
    revoked: row.revokedAt !== null,
    downloadable: row.revokedAt === null,
  };
}

export function certsRouter(deps: CertRoutesDeps): Router {
  const router = Router();

  router.use(requireAuth(deps));

  // Every certificate this trainee holds, newest first. A manager sees their
  // own here, not other people's: there is no "all certificates" endpoint.
  router.get('/certs', async (req, res) => {
    const { traineeId } = authOf(req);
    const rows = await listForTrainee(deps.db, traineeId);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json(MyCertificatesResponseSchema.parse({ certificates: rows.map(toPayload) }));
  });

  // The PDF itself. Streamed from the store, never served by nginx: MEDIA_ROOT
  // is outside anything the web server can reach (D15).
  router.get('/certs/:publicId/download', async (req, res) => {
    const { traineeId, role } = authOf(req);
    const publicId = String(req.params.publicId ?? '');
    if (!CERT_PUBLIC_ID_PATTERN.test(publicId)) {
      fail(res, 404, 'not_found');
      return;
    }

    const certificate = await findByPublicId(deps.db, publicId);
    if (certificate === null || certificate.revokedAt !== null) {
      fail(res, 404, 'not_found');
      return;
    }
    // Not "forbidden": a trainee asking for someone else's certificate is told
    // exactly what they would be told about an id that never existed.
    if (certificate.traineeId !== traineeId && role !== 'MANAGER') {
      fail(res, 404, 'not_found');
      return;
    }

    // A row whose file is missing (a render that failed, a restore that missed
    // MEDIA_ROOT) repairs itself here rather than 404ing at the trainee.
    let ready = certificate;
    try {
      ready = await deps.issuer.ensureRendered(certificate);
    } catch (err) {
      console.error(`[academy-certs] could not render certificate ${publicId}:`, err);
      fail(res, 500, 'internal');
      return;
    }
    if (ready.mediaKey === null) {
      fail(res, 500, 'internal');
      return;
    }
    const mediaKey = ready.mediaKey;

    let stat;
    try {
      stat = await deps.store.stat(mediaKey);
    } catch (err) {
      if (err instanceof MediaKeyError) {
        // A key that breaks the rules got into the database somehow (migration
        // 0007 has the same rule as a CHECK). Say nothing useful to the client.
        console.warn(`[academy-certs] certificate ${publicId} has an unusable key: ${err.message}`);
        fail(res, 404, 'not_found');
        return;
      }
      throw err;
    }
    if (stat === null) {
      fail(res, 500, 'internal');
      return;
    }

    // Audited on every download: there are a handful per trainee in a career,
    // so there is no reason to sample them the way media streaming does.
    try {
      await writeAudit(deps.db, {
        traineeId: certificate.traineeId,
        eventType: 'CERT_DOWNLOAD',
        actor: role === 'MANAGER' ? actor.manager(traineeId) : actor.trainee(traineeId),
        payload: {
          certificate: publicId,
          kind: certificate.kind,
          bytes: stat.size,
          self: certificate.traineeId === traineeId,
        },
      });
    } catch (err) {
      console.error('[academy-certs] could not write the CERT_DOWNLOAD audit row:', err);
    }

    res.setHeader('Content-Type', CERT_CONTENT_TYPE);
    res.setHeader('Content-Length', String(stat.size));
    // The file name is the certificate id: no name, no level, nothing about
    // the person in something that ends up in a Downloads folder.
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="fac-academy-certificate-${publicId}.pdf"`,
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const stream = await deps.store.openRange(mediaKey);
    res.on('close', () => {
      if (!res.writableEnded) stream.destroy();
    });
    stream.on('error', (err: unknown) => {
      console.error(`[academy-certs] streaming certificate ${publicId} failed:`, err);
      res.destroy();
    });
    stream.pipe(res);
  });

  return router;
}
