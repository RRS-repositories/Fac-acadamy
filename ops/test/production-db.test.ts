// The guard that used to be decorative.
//
// Until 24 Sep the wrong-database check was a substring search for 'prod' or
// 'live'. The academy shares the CRM's Postgres, and that database is called
// `client_credentials` — no 'prod', no 'live'. The one database in the world
// the guard most needed to catch was the one it waved through.
//
// These tests exist so that can never quietly come back.

import { describe, expect, it } from 'vitest';
import {
  isProductionDbName,
  KNOWN_PRODUCTION_DB_NAMES,
  productionReason,
} from '../lib/production-db.js';
import { AdminError, parseExpectDb as adminExpectDb } from '../admin/lib.js';
import { MediaError, parseExpectDb as mediaExpectDb } from '../media/lib.js';
import { assertThrowAwayTarget, BackupError, looksLikeProduction } from '../backup/lib.js';

const CRM_DB = 'client_credentials';

describe('isProductionDbName', () => {
  it('knows the CRM database by name, not by hint', () => {
    expect(CRM_DB).not.toMatch(/prod|live/);
    expect(isProductionDbName(CRM_DB)).toBe(true);
  });

  it('is case- and whitespace-insensitive', () => {
    for (const name of ['CLIENT_CREDENTIALS', '  Client_Credentials  ']) {
      expect(isProductionDbName(name)).toBe(true);
    }
  });

  it('still catches the conventional names', () => {
    for (const name of ['academy_prod', 'crm_live', 'fac-production', 'LIVE_DB']) {
      expect(isProductionDbName(name)).toBe(true);
    }
  });

  it('leaves development and test names alone', () => {
    for (const name of ['academy_dev', 'academy_test', 'academy_ci', 'academy', '']) {
      expect(isProductionDbName(name)).toBe(false);
    }
  });

  it('names the CRM database in its reason, so the message teaches', () => {
    expect(productionReason(CRM_DB)).toMatch(/live CRM database/);
    expect(productionReason('client_credentials_drill')).toMatch(/live CRM database/);
    expect(productionReason('academy_prod')).toMatch(/looks like production/);
  });

  it('lists the CRM database, so removing it fails a test rather than a deploy', () => {
    expect(KNOWN_PRODUCTION_DB_NAMES).toContain(CRM_DB);
  });
});

describe('the media and backup scripts refuse production outright', () => {
  it('media: no --confirm flag exists, because there is no legitimate use', () => {
    expect(() => mediaExpectDb(CRM_DB)).toThrow(MediaError);
    expect(() => mediaExpectDb(CRM_DB)).toThrow(/live CRM database/);
  });

  it('backup: the restore drill will not target the CRM database', () => {
    expect(looksLikeProduction(CRM_DB)).toBe(true);
    expect(() => assertThrowAwayTarget(CRM_DB, {})).toThrow(BackupError);
    // Nor dressed up as a drill.
    expect(() => assertThrowAwayTarget('client_credentials_drill', {})).toThrow(BackupError);
  });

  it('media still accepts a local database', () => {
    expect(mediaExpectDb('academy_dev')).toBe('academy_dev');
  });
});

describe('the IT admin commands make production deliberate, not impossible', () => {
  it('refuses the CRM database without --confirm-production', () => {
    expect(() => adminExpectDb(CRM_DB)).toThrow(AdminError);
    expect(() => adminExpectDb(CRM_DB)).toThrow(/--confirm-production/);
  });

  it('allows it with the flag — these are production tools (D14)', () => {
    expect(adminExpectDb(CRM_DB, true)).toBe(CRM_DB);
  });

  it('does not ask for the flag on a local database', () => {
    expect(adminExpectDb('academy_dev')).toBe('academy_dev');
    expect(adminExpectDb('academy_test')).toBe('academy_test');
  });

  it('still requires --expect-db at all', () => {
    expect(() => adminExpectDb(undefined)).toThrow(/--expect-db/);
    expect(() => adminExpectDb('   ')).toThrow(/--expect-db/);
  });
});

describe('the media scripts: one way through, and only one', () => {
  it('still refuses the CRM database by default', () => {
    expect(() => mediaExpectDb(CRM_DB)).toThrow(MediaError);
    expect(() => mediaExpectDb(CRM_DB)).toThrow(/--confirm-production/);
  });

  it('lets a recording be added to the live academy when that is meant', () => {
    expect(mediaExpectDb(CRM_DB, true)).toBe(CRM_DB);
  });

  it('does not ask for the flag on a local database', () => {
    expect(mediaExpectDb('academy_dev')).toBe('academy_dev');
    expect(mediaExpectDb('academy_test', true)).toBe('academy_test');
  });

  it('still requires --expect-db at all', () => {
    expect(() => mediaExpectDb(undefined, true)).toThrow(/--expect-db/);
  });
});
