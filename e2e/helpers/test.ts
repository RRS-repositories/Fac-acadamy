import { test as base } from '@playwright/test';
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import { resetTrainee } from './db.js';
import { claim, release } from './lease.js';
import { captureSignedInState } from './signin.js';
import type { StorageState } from './signin.js';
import { accountFor, prepared } from './state.js';
import type { PreparedAccount } from './state.js';

// The suite's fixtures.
//
// Only five accounts can sign in (the mock CRM's invented users), so an
// account belongs to ONE worker for that worker's whole life: `staff` leases
// one, signs in once through the real /login screen, and every test in that
// worker opens a page with those cookies. Signing in once, rather than per
// test, keeps the run under the API's five-a-minute sign-in limit per IP
// (helpers/throttle.ts). A test never inherits another test's progress,
// because a spec's own `reset()` puts its account back to day one first.

export interface Session {
  account: PreparedAccount;
  state: StorageState;
  /** Signs in again (after a disable, or a sign-out) and refreshes `state`. */
  refresh(): Promise<void>;
  /** Back to day one for this account: no progress, no certificates, this track. */
  reset(track: string | null): Promise<void>;
  /**
   * A page whose context already holds this session's cookies. Context options
   * (a viewport, `reducedMotion`) are passed through, because these contexts
   * are made here rather than by Playwright's own `page` fixture.
   */
  open(options?: BrowserContextOptions): Promise<Page>;
}

async function makeSession(
  browser: Browser,
  email: string,
  pages: Page[],
): Promise<[Session, () => Promise<void>]> {
  const account = accountFor(email);
  const state = await captureSignedInState(browser, email);
  const session: Session = {
    account,
    state,
    async refresh() {
      session.state = await captureSignedInState(browser, email);
    },
    async reset(track) {
      await resetTrainee(account.traineeId, track);
    },
    async open(options) {
      const context = await browser.newContext({ ...options, storageState: session.state });
      const page = await context.newPage();
      pages.push(page);
      return page;
    },
  };
  const dispose = async (): Promise<void> => {
    for (const page of pages.splice(0)) {
      await page
        .context()
        .close()
        .catch(() => undefined);
    }
  };
  return [session, dispose];
}

interface WorkerFixtures {
  /** A leased STAFF account, signed in. */
  staff: Session;
  /** The one MANAGER account, signed in. Leased only by the specs that use it. */
  manager: Session;
}

interface TestFixtures {
  /** A signed-in page for the worker's staff account, closed after the test. */
  staffPage: Page;
  /** A signed-in page for the manager account, closed after the test. */
  managerPage: Page;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  staff: [
    async ({ browser }, use) => {
      const email = await claim(prepared().staff, 'a staff account');
      const pages: Page[] = [];
      const [session, dispose] = await makeSession(browser, email, pages);
      try {
        await use(session);
      } finally {
        await dispose();
        release(email);
      }
    },
    { scope: 'worker' },
  ],

  manager: [
    async ({ browser }, use) => {
      const email = await claim([prepared().manager], 'the manager account');
      const pages: Page[] = [];
      const [session, dispose] = await makeSession(browser, email, pages);
      try {
        await use(session);
      } finally {
        await dispose();
        release(email);
      }
    },
    { scope: 'worker' },
  ],

  staffPage: async ({ staff }, use) => {
    const page = await staff.open();
    await use(page);
    await page.context().close();
  },

  managerPage: async ({ manager }, use) => {
    const page = await manager.open();
    await use(page);
    await page.context().close();
  },
});

export { expect } from '@playwright/test';
