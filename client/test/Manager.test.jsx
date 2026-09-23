import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { MANAGER, STAFF, callsTo, mockFetch, renderApp } from './helpers.jsx';

/*
 * The management dashboard (S07), against a mocked manager API.
 *
 * Every person, stage and number here is invented. The management screens show
 * progress and account state only, so no training content appears in this file
 * — and the preview test proves the screen ignores anything lesson-shaped even
 * if the server were to send it.
 */

const ROSTER_PATH = '/api/manager/roster?includeDisabled=true';
const EXPORT_PATH = '/api/manager/export.csv';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

function trainee(overrides) {
  return {
    id: 1,
    fullName: 'Test Person',
    email: 'test.person@example.com',
    track: 'CS',
    status: 'ACTIVE',
    isDisabled: false,
    onlineNow: false,
    lastSeenAt: ago(30 * MINUTE),
    lastActivityAt: ago(30 * MINUTE),
    stagesTotal: 8,
    stagesDone: 2,
    currentStageCode: 'l1-3',
    currentStageTitle: 'Third stage',
    currentStageDisplayNum: '3',
    attempts: 3,
    fails: 0,
    bestAverage: 84,
    stage1Authorised: true,
    stages: [],
    startedAt: ago(20 * DAY),
    ...overrides,
  };
}

const AVERY = trainee({
  id: 11,
  fullName: 'Avery Stone',
  email: 'avery.stone@example.com',
  track: 'CS',
  onlineNow: true,
  lastSeenAt: ago(MINUTE),
  lastActivityAt: ago(2 * MINUTE),
  stagesDone: 3,
  attempts: 5,
  fails: 1,
  bestAverage: 88,
  stages: [
    { code: 'l1-1', displayNum: '1', attempts: 1, best: 92, fails: 0, passed: true },
    { code: 'l1-2', displayNum: '2', attempts: 2, best: 80, fails: 1, passed: true },
  ],
});

const CASEY = trainee({
  id: 12,
  fullName: 'Casey Nolan',
  email: 'casey.nolan@example.com',
  track: null,
  onlineNow: false,
  stagesTotal: 0,
  stagesDone: 0,
  currentStageCode: null,
  currentStageTitle: null,
  currentStageDisplayNum: null,
  attempts: 0,
  fails: 0,
  bestAverage: null,
  stage1Authorised: false,
  startedAt: ago(2 * DAY),
});

const DANA = trainee({
  id: 13,
  fullName: 'Dana Fielding',
  email: 'dana.fielding@example.com',
  track: 'SALES',
  isDisabled: true,
  lastActivityAt: ago(9 * DAY),
  fails: 3,
});

/** The signed-in manager's own row: same id as the MANAGER fixture. */
const SELF = trainee({
  id: MANAGER.id,
  fullName: MANAGER.fullName,
  email: MANAGER.email,
  track: null,
  stagesTotal: 0,
  stagesDone: 0,
  currentStageCode: null,
  currentStageTitle: null,
  currentStageDisplayNum: null,
  attempts: 0,
  fails: 0,
  bestAverage: null,
  stage1Authorised: false,
});

const COUNTS = { total: 3, active: 2, disabled: 1, onlineNow: 1, waitingForTrack: 1 };

/** The manager's own training, for the sidebar-link checks. */
const OWN_TRACK = {
  track: 'CS',
  waitingForTrack: false,
  stages: [
    {
      code: 'own1',
      title: 'Own stage',
      blurb: 'A test blurb.',
      displayNum: '1',
      level: 1,
      dept: null,
      position: 1,
      state: 'available',
      pct: 0,
      attempts: 0,
      best: null,
      passMark: 80,
      lessonCount: 1,
      recordingCount: 0,
      recordingsWithMedia: 0,
    },
  ],
};

const STUCK = {
  trainees: [
    {
      id: 13,
      fullName: 'Dana Fielding',
      track: 'SALES',
      reason: 'both',
      stuckStageCode: 'l1-4',
      stageFails: 3,
      inactiveDays: 9,
      lastActivityAt: ago(9 * DAY),
    },
    {
      id: 14,
      fullName: 'Eden Marsh',
      track: 'ADMIN',
      reason: 'inactive',
      stuckStageCode: null,
      stageFails: 0,
      inactiveDays: 12,
      lastActivityAt: ago(12 * DAY),
    },
  ],
};

const CONFIG = { stage1AuthRequired: true, academyV2: true, provisioning: false };

function previewStage(overrides) {
  return {
    code: 'p1',
    title: 'Preview stage',
    displayNum: '1',
    level: 1,
    dept: null,
    position: 1,
    lessonCount: 2,
    recordingCount: 1,
    questionCount: 10,
    passMark: 80,
    ...overrides,
  };
}

const PREVIEW = {
  track: 'CS',
  stages: [
    previewStage({
      code: 'p1',
      title: 'Preview stage one',
      displayNum: '1',
      position: 1,
      // A field the contract does not name: it is stripped before a screen
      // ever sees it, and no screen would render it anyway.
      lessonHtml: '<p>Never render me</p>',
    }),
    previewStage({ code: 'p2', title: 'Preview stage two', displayNum: '2', position: 2 }),
    previewStage({
      code: 'pA1',
      title: 'Preview module A1',
      displayNum: 'A1',
      position: 3,
      level: null,
      dept: 'CS',
    }),
  ],
};

const DETAIL = {
  trainee: AVERY,
  stages: [
    {
      code: 'l1-1',
      title: 'First stage',
      displayNum: '1',
      level: 1,
      dept: null,
      state: 'done',
      attempts: 2,
      best: 95,
      fails: 1,
      lastAttemptAt: ago(3 * DAY),
    },
    {
      code: 'l1-2',
      title: 'Second stage',
      displayNum: '2',
      level: 1,
      dept: null,
      state: 'available',
      attempts: 1,
      best: 60,
      fails: 1,
      lastAttemptAt: ago(DAY),
    },
  ],
};

/** The manager endpoints a roster screen needs, with a mutable roster. */
function managerRoutes(overrides = {}, { people = [AVERY, CASEY, DANA] } = {}) {
  const disabled = new Set([13]);
  const tracks = new Map();
  const roster = () => ({
    trainees: people.map((t) => ({
      ...t,
      isDisabled: disabled.has(t.id),
      // A disabled account is signed out, so the server stops calling it online.
      onlineNow: disabled.has(t.id) ? false : t.onlineNow,
      track: tracks.has(t.id) ? tracks.get(t.id) : t.track,
    })),
    counts: COUNTS,
  });
  return {
    'GET /api/me': [200, { me: MANAGER }],
    [`GET ${ROSTER_PATH}`]: () => [200, roster()],
    'GET /api/manager/stuck': [200, STUCK],
    'GET /api/manager/config': [200, CONFIG],
    'POST /api/manager/trainees/11/disable': () => {
      disabled.add(11);
      return [204];
    },
    'POST /api/manager/trainees/13/enable': () => {
      disabled.delete(13);
      return [204];
    },
    'PUT /api/manager/trainees/12/track': (init) => {
      tracks.set(12, JSON.parse(init.body).track);
      return [204];
    },
    ...overrides,
  };
}

function row(id) {
  const found = document.querySelector(`[data-trainee="${id}"]`);
  expect(found).not.toBeNull();
  return found;
}

/** The roster arrives over the network; wait for the table before reading it. */
async function rosterLoaded() {
  await screen.findByRole('table');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Manager area — what a staff session sees', () => {
  it('renders only the no-access message and asks the manager API for nothing', async () => {
    const fetchMock = mockFetch({ 'GET /api/me': [200, { me: STAFF }] });
    renderApp('/manager');

    expect(
      await screen.findByRole('heading', { name: "You don't have access to this page" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Trainee roster' })).toBeNull();
    expect(callsTo(fetchMock, 'GET', ROSTER_PATH)).toHaveLength(0);
    expect(callsTo(fetchMock, 'GET', '/api/manager/stuck')).toHaveLength(0);
    expect(callsTo(fetchMock, 'GET', '/api/manager/config')).toHaveLength(0);
  });

  it('shows no Management link in the training sidebar', async () => {
    mockFetch({
      'GET /api/me': [200, { me: STAFF }],
      'GET /api/track': [200, OWN_TRACK],
    });
    renderApp('/');
    await screen.findByRole('heading', { name: 'Welcome back, Trainee' });
    expect(screen.queryByRole('link', { name: 'Management' })).toBeNull();
  });

  it('shows the Management link to a manager', async () => {
    mockFetch({
      'GET /api/me': [200, { me: MANAGER }],
      'GET /api/track': [200, OWN_TRACK],
    });
    renderApp('/');
    expect(await screen.findByRole('link', { name: 'Management' })).toHaveAttribute(
      'href',
      '/manager',
    );
  });
});

describe('Manager roster', () => {
  it('lists every trainee with their progress, counts and online state', async () => {
    mockFetch(managerRoutes());
    renderApp('/manager');

    expect(await screen.findByRole('heading', { name: 'Trainee roster' })).toBeInTheDocument();
    await rosterLoaded();
    expect(screen.getByRole('link', { name: 'Avery Stone' })).toHaveAttribute(
      'href',
      '/manager/trainee/11',
    );

    const avery = within(row(11));
    // getByRole('cell') and not getByText: every row carries a track <select>
    // whose options name all nine tracks.
    expect(avery.getByRole('cell', { name: 'Customer Service' })).toBeInTheDocument();
    expect(avery.getByText(/Stage 3 · Third stage/)).toBeInTheDocument();
    expect(avery.getByText('3 of 8 stages passed')).toBeInTheDocument();

    // One chip per attempted stage: green clean, red the moment there is a fail.
    expect(avery.getByText('S1: 1× · best 92%')).toBeInTheDocument();
    expect(avery.getByText('S2: 2× · best 80% · 1 fail')).toBeInTheDocument();
    expect(avery.getByText('S1: 1× · best 92%')).toHaveAttribute('data-tone', 'pass');
    expect(avery.getByText('S2: 2× · best 80% · 1 fail')).toHaveAttribute('data-tone', 'fail');
    expect(within(row(12)).getByText('No attempts yet')).toBeInTheDocument();

    // The dot follows onlineNow, and says so in words as well as colour.
    expect(avery.getByTestId('online-dot')).toHaveAttribute('data-online', 'true');
    expect(avery.getByText('Online now')).toBeInTheDocument();
    expect(within(row(12)).getByTestId('online-dot')).toHaveAttribute('data-online', 'false');

    // D13: no track yet is a state of its own, not an empty cell.
    expect(within(row(12)).getByRole('cell', { name: 'No track yet' })).toBeInTheDocument();
    expect(within(row(12)).getByText('Waiting for a track')).toBeInTheDocument();

    const counts = within(screen.getByTestId('counts'));
    expect(counts.getByText('Trainees').nextSibling).toHaveTextContent('3');
    expect(counts.getByText('Online now').nextSibling).toHaveTextContent('1');
    expect(counts.getByText('Waiting for a track').nextSibling).toHaveTextContent('1');
    expect(counts.getByText('Disabled').nextSibling).toHaveTextContent('1');
  });

  it('narrows the rows by search and by track, and offers a way back', async () => {
    mockFetch(managerRoutes());
    renderApp('/manager');
    await rosterLoaded();
    expect(document.querySelectorAll('[data-trainee]')).toHaveLength(3);

    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'casey' } });
    expect(document.querySelectorAll('[data-trainee]')).toHaveLength(1);
    expect(screen.getByText('Casey Nolan')).toBeInTheDocument();
    expect(screen.queryByText('Avery Stone')).toBeNull();
    expect(screen.getByText('1 of 3 shown')).toBeInTheDocument();

    // Searching filters in the browser: no extra request per keystroke.
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Track'), { target: { value: 'SALES' } });
    expect(document.querySelectorAll('[data-trainee]')).toHaveLength(1);
    expect(screen.getByText('Dana Fielding')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Track'), { target: { value: 'NONE' } });
    expect(document.querySelectorAll('[data-trainee]')).toHaveLength(1);
    expect(screen.getByText('Casey Nolan')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'nobody' } });
    expect(document.querySelectorAll('[data-trainee]')).toHaveLength(0);
    expect(screen.getByText('Nobody matches those filters.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(document.querySelectorAll('[data-trainee]')).toHaveLength(3);
  });

  it('asks before disabling an account, then calls the endpoint and updates the row', async () => {
    const fetchMock = mockFetch(managerRoutes());
    renderApp('/manager');
    await rosterLoaded();

    fireEvent.click(within(row(11)).getByRole('button', { name: 'Disable' }));
    // Nothing has been sent yet — the manager has to mean it.
    expect(callsTo(fetchMock, 'POST', '/api/manager/trainees/11/disable')).toHaveLength(0);
    expect(within(row(11)).getByText(/Disable Avery Stone\?/)).toBeInTheDocument();

    fireEvent.click(within(row(11)).getByRole('button', { name: 'Cancel' }));
    expect(within(row(11)).queryByText(/Disable Avery Stone\?/)).toBeNull();
    expect(callsTo(fetchMock, 'POST', '/api/manager/trainees/11/disable')).toHaveLength(0);

    fireEvent.click(within(row(11)).getByRole('button', { name: 'Disable' }));
    fireEvent.click(within(row(11)).getByRole('button', { name: 'Yes, disable' }));

    await waitFor(() =>
      expect(callsTo(fetchMock, 'POST', '/api/manager/trainees/11/disable')).toHaveLength(1),
    );
    expect(await within(row(11)).findByRole('button', { name: 'Re-enable' })).toBeInTheDocument();
    expect(row(11)).toHaveAttribute('data-disabled', 'true');
    expect(within(row(11)).getByText('Disabled')).toBeInTheDocument();
    expect(within(row(11)).getByTestId('online-dot')).toHaveAttribute('data-online', 'false');
  });

  it('re-enables without a confirmation step', async () => {
    const fetchMock = mockFetch(managerRoutes());
    renderApp('/manager');
    await rosterLoaded();

    fireEvent.click(within(row(13)).getByRole('button', { name: 'Re-enable' }));
    await waitFor(() =>
      expect(callsTo(fetchMock, 'POST', '/api/manager/trainees/13/enable')).toHaveLength(1),
    );
    expect(await within(row(13)).findByRole('button', { name: 'Disable' })).toBeInTheDocument();
  });

  it('offers no Disable on the signed-in manager’s own row, only a "You" marker', async () => {
    const fetchMock = mockFetch(managerRoutes({}, { people: [SELF, AVERY] }));
    renderApp('/manager');
    await rosterLoaded();

    const self = within(row(MANAGER.id));
    expect(self.queryByRole('button', { name: 'Disable' })).toBeNull();
    expect(self.getByTestId('own-row-marker')).toHaveTextContent('Your account');
    expect(self.getByText('You')).toBeInTheDocument();

    // A manager takes the training too, so the track control stays.
    expect(
      self.getByRole('combobox', { name: `Track for ${MANAGER.fullName}` }),
    ).toBeInTheDocument();

    // Everybody else still has one.
    expect(within(row(11)).getByRole('button', { name: 'Disable' })).toBeInTheDocument();
    expect(callsTo(fetchMock, 'POST', `/api/manager/trainees/${MANAGER.id}/disable`)).toHaveLength(
      0,
    );
  });

  it('names the reason a change was refused instead of "that didn’t save"', async () => {
    mockFetch(
      managerRoutes({
        'POST /api/manager/trainees/11/disable': () => [400, { error: 'invalid_request' }],
      }),
    );
    renderApp('/manager');
    await rosterLoaded();

    fireEvent.click(within(row(11)).getByRole('button', { name: 'Disable' }));
    fireEvent.click(within(row(11)).getByRole('button', { name: 'Yes, disable' }));

    expect(
      await within(row(11)).findByText("You can't disable your own account."),
    ).toBeInTheDocument();
    expect(within(row(11)).queryByText(/didn't save/i)).toBeNull();
  });

  it('says the row has gone when the server answers not_found', async () => {
    mockFetch(
      managerRoutes({
        'POST /api/manager/trainees/13/enable': () => [404, { error: 'not_found' }],
      }),
    );
    renderApp('/manager');
    await rosterLoaded();

    fireEvent.click(within(row(13)).getByRole('button', { name: 'Re-enable' }));
    expect(
      await within(row(13)).findByText('That trainee no longer exists. Refresh the page.'),
    ).toBeInTheDocument();
  });

  it('says so plainly when the request never reached the server', async () => {
    mockFetch(managerRoutes());
    const live = globalThis.fetch;
    // Only the disable call fails at the transport layer; the roster still loads.
    vi.stubGlobal('fetch', (path, init = {}) => {
      if (String(path).endsWith('/disable')) return Promise.reject(new TypeError('offline'));
      return live(path, init);
    });
    renderApp('/manager');
    await rosterLoaded();

    fireEvent.click(within(row(11)).getByRole('button', { name: 'Disable' }));
    fireEvent.click(within(row(11)).getByRole('button', { name: 'Yes, disable' }));
    expect(await within(row(11)).findByText("Couldn't reach the server.")).toBeInTheDocument();
  });

  it('keeps Assign switched off while the select still says "No track yet"', async () => {
    const fetchMock = mockFetch(managerRoutes());
    renderApp('/manager');
    await rosterLoaded();

    const casey = within(row(12));
    const assign = casey.getByRole('button', { name: 'Assign' });
    expect(casey.getByRole('combobox', { name: 'Track for Casey Nolan' })).toHaveValue('');
    expect(assign).toBeDisabled();

    fireEvent.click(assign);
    expect(callsTo(fetchMock, 'PUT', '/api/manager/trainees/12/track')).toHaveLength(0);

    fireEvent.change(casey.getByRole('combobox', { name: 'Track for Casey Nolan' }), {
      target: { value: 'ADMIN' },
    });
    expect(casey.getByRole('button', { name: 'Assign' })).toBeEnabled();
  });

  it('assigns a track with a PUT carrying the chosen code', async () => {
    const fetchMock = mockFetch(managerRoutes());
    renderApp('/manager');
    await rosterLoaded();

    const casey = within(row(12));
    const select = casey.getByRole('combobox', { name: 'Track for Casey Nolan' });
    // Nothing is sent by picking: the manager confirms with Assign.
    fireEvent.change(select, { target: { value: 'ADMIN' } });
    expect(callsTo(fetchMock, 'PUT', '/api/manager/trainees/12/track')).toHaveLength(0);

    fireEvent.click(casey.getByRole('button', { name: 'Assign' }));
    await waitFor(() =>
      expect(callsTo(fetchMock, 'PUT', '/api/manager/trainees/12/track')).toHaveLength(1),
    );
    const [[, init]] = callsTo(fetchMock, 'PUT', '/api/manager/trainees/12/track');
    expect(JSON.parse(init.body)).toEqual({ track: 'ADMIN' });
    expect(init.credentials).toBe('same-origin');
    expect(await within(row(12)).findByRole('cell', { name: 'Admin' })).toBeInTheDocument();
  });

  it('offers the CSV export as a download link to the server endpoint', async () => {
    mockFetch(managerRoutes());
    renderApp('/manager');
    await rosterLoaded();

    const link = screen.getByTestId('export-csv-button');
    expect(link).toHaveAttribute('href', EXPORT_PATH);
    expect(link).toHaveAttribute('download');
    expect(screen.getByTestId('export-csv')).toHaveAttribute('href', EXPORT_PATH);
  });

  it('shows the three settings read-only, with no control to change them', async () => {
    mockFetch(managerRoutes());
    renderApp('/manager');
    await screen.findByText('Stage 1 needs the authenticator');

    const strip = document.querySelector('[data-config="stage1AuthRequired"]').closest('ul');
    expect(within(strip).getByText('STAGE1_AUTH_REQUIRED')).toBeInTheDocument();
    expect(document.querySelector('[data-config="stage1AuthRequired"]')).toHaveTextContent('On');
    expect(document.querySelector('[data-config="academyV2"]')).toHaveTextContent('On');
    expect(document.querySelector('[data-config="provisioning"]')).toHaveTextContent('Off');
    expect(within(strip).getByText('Stage 1 needs the authenticator')).toBeInTheDocument();
    expect(within(strip).queryByRole('button')).toBeNull();
    expect(within(strip).queryByRole('checkbox')).toBeNull();
  });

  it('says so plainly when there is nobody on the roster', async () => {
    mockFetch({
      'GET /api/me': [200, { me: MANAGER }],
      [`GET ${ROSTER_PATH}`]: [
        200,
        {
          trainees: [],
          counts: { total: 0, active: 0, disabled: 0, onlineNow: 0, waitingForTrack: 0 },
        },
      ],
      'GET /api/manager/stuck': [200, { trainees: [] }],
      'GET /api/manager/config': [200, CONFIG],
    });
    renderApp('/manager');
    expect(await screen.findByText('No trainees yet.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('Roster layout', () => {
  it('uses the approved column set with a navy header row', async () => {
    mockFetch(managerRoutes());
    renderApp('/manager');
    await rosterLoaded();

    // The last column to appear is the flag-dependent one; wait for it.
    await screen.findByRole('columnheader', { name: 'Stage 1 auth' });
    const headers = screen.getAllByRole('columnheader').map((el) => el.textContent);
    expect(headers).toEqual([
      'Trainee',
      'Status',
      'Track',
      'Current position',
      'Test stats (attempts · best %)',
      'Stage 1 auth',
      'Account',
    ]);
    // The prototype's navy header with white labels, ported to the tokens.
    for (const cell of screen.getAllByRole('columnheader')) {
      expect(cell.className).toContain('bg-navy');
      expect(cell.className).toContain('text-white');
      // Sticky, so the labels stay put while the rows scroll.
      expect(cell.className).toContain('sticky');
    }
  });

  it('leaves the Stage 1 auth column out while the gate is switched off', async () => {
    mockFetch(
      managerRoutes({
        'GET /api/manager/config': [
          200,
          { stage1AuthRequired: false, academyV2: true, provisioning: false },
        ],
      }),
    );
    renderApp('/manager');
    await rosterLoaded();
    // Wait for the config answer itself, so this is not just "not loaded yet".
    await waitFor(() =>
      expect(document.querySelector('[data-config="stage1AuthRequired"]')).toHaveTextContent('Off'),
    );

    const headers = screen.getAllByRole('columnheader').map((el) => el.textContent);
    expect(headers).not.toContain('Stage 1 auth');
    expect(screen.queryByTestId('stage1-pill')).toBeNull();
    expect(screen.queryByText('Authorised')).toBeNull();
  });

  it('shows the authorisation pill only when the gate is on', async () => {
    mockFetch(managerRoutes());
    renderApp('/manager');
    await screen.findByRole('columnheader', { name: 'Stage 1 auth' });

    expect(within(row(11)).getByTestId('stage1-pill')).toHaveAttribute('data-authorised', 'true');
    expect(within(row(11)).getByText('Authorised')).toBeInTheDocument();
    expect(within(row(12)).getByTestId('stage1-pill')).toHaveAttribute('data-authorised', 'false');
  });

  it('scrolls the table inside its own container, never the page', async () => {
    mockFetch(managerRoutes());
    renderApp('/manager');
    const table = await screen.findByRole('table');

    // The scrolling element is the box around the table, so a wide roster
    // cannot push the document sideways.
    const box = screen.getByTestId('roster-scroll');
    expect(table.closest('[data-scroll="roster"]')).toBe(box);
    expect(box.className).toContain('overflow-auto');
    expect(box.className).toContain('min-w-0');
    expect(box.className).toMatch(/max-h-/);
    // The box must be a containing block, or the sr-only labels in the
    // right-hand cells fall outside every clip and the PAGE scrolls sideways.
    expect(box.className).toContain('relative');

    // Nothing between the table and the page may stretch to the table's width.
    const main = table.closest('main');
    expect(main.className).toContain('min-w-0');

    // Long values truncate with the full text kept in a title attribute.
    const email = within(row(11)).getByText('avery.stone@example.com');
    expect(email.className).toContain('truncate');
    expect(email).toHaveAttribute('title', 'avery.stone@example.com');
  });
});

describe('Needs attention', () => {
  it('explains each reason in plain English', async () => {
    mockFetch(managerRoutes());
    renderApp('/manager/stuck');

    expect(await screen.findByRole('heading', { name: 'Needs attention' })).toBeInTheDocument();
    await screen.findByText('3 fails on stage l1-4, and no activity for 9 days');
    const dana = within(document.querySelector('[data-stuck="13"]'));
    expect(dana.getByText('3 fails on stage l1-4, and no activity for 9 days')).toBeInTheDocument();
    expect(dana.getByText('Struggling')).toBeInTheDocument();

    const eden = within(document.querySelector('[data-stuck="14"]'));
    expect(eden.getByText('no activity for 12 days')).toBeInTheDocument();
    expect(eden.getByText('Gone quiet')).toBeInTheDocument();
    expect(eden.getByRole('link', { name: 'Eden Marsh' })).toHaveAttribute(
      'href',
      '/manager/trainee/14',
    );
  });

  it('is announced on the roster with a link to the list', async () => {
    mockFetch(managerRoutes());
    renderApp('/manager');
    await rosterLoaded();
    expect(await screen.findByText('2 trainees need a nudge')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See who' })).toHaveAttribute('href', '/manager/stuck');
  });
});

describe('One trainee', () => {
  it('shows the account, the totals and a chip per stage', async () => {
    mockFetch({ ...managerRoutes(), 'GET /api/manager/trainee/11': [200, DETAIL] });
    renderApp('/manager/trainee/11');

    expect(await screen.findByRole('heading', { name: 'Avery Stone' })).toBeInTheDocument();
    expect(screen.getByText('avery.stone@example.com')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('trainee-facts')).getByText('Customer Service'),
    ).toBeInTheDocument();
    expect(within(screen.getByTestId('trainee-facts')).getByText('3/8')).toBeInTheDocument();

    const first = within(document.querySelector('[data-stage="l1-1"]'));
    expect(first.getByText('First stage')).toBeInTheDocument();
    expect(first.getByText('Passed')).toBeInTheDocument();
    expect(first.getByText(/2 attempts/)).toBeInTheDocument();
    expect(first.getByText(/best 95%/)).toBeInTheDocument();
    expect(first.getByText('1 fail')).toBeInTheDocument();
    expect(document.querySelector('[data-stage="l1-2"]')).toHaveAttribute(
      'data-state',
      'available',
    );

    // The same account controls as the roster row.
    expect(screen.getByRole('button', { name: 'Disable' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Track for Avery Stone' })).toBeInTheDocument();
  });
});

describe('Preview a track', () => {
  it('lists the stages that track sees, badged as a preview, with no lesson content', async () => {
    const fetchMock = mockFetch({
      ...managerRoutes(),
      'GET /api/manager/preview/CS': [200, PREVIEW],
    });
    renderApp('/manager/preview/CS');

    expect(
      await screen.findByRole('heading', { name: 'Customer Service — 3 stages' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Preview')).toBeInTheDocument();
    expect(screen.getByText(/Nothing on this page is recorded/)).toBeInTheDocument();

    const list = document.querySelector('[data-preview="CS"]');
    const items = within(list).getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('data-stage'))).toEqual(['p1', 'p2', 'pA1']);
    expect(within(items[0]).getByText('Preview stage one')).toBeInTheDocument();
    expect(
      within(items[0]).getByText('2 lessons · 1 recording · 10 questions · pass 80%'),
    ).toBeInTheDocument();
    expect(within(items[2]).getByText('Preview module A1')).toBeInTheDocument();
    expect(within(list).getByText('Level 1')).toBeInTheDocument();
    expect(within(list).getByText('Department training')).toBeInTheDocument();

    // Lesson text is never rendered, and no lesson or quiz route is called.
    expect(screen.queryByText('Never render me')).toBeNull();
    expect(document.body.innerHTML).not.toContain('Never render me');
    expect(fetchMock.mock.calls.some(([path]) => String(path).startsWith('/api/stage/'))).toBe(
      false,
    );
  });

  it('asks for a track when the URL has none', async () => {
    const fetchMock = mockFetch(managerRoutes());
    renderApp('/manager/preview');
    expect(await screen.findByText('Pick a track to preview.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([p]) => String(p).includes('/preview/'))).toBe(false);
  });
});
