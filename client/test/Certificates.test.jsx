import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import { STAFF, mockFetch, renderApp } from './helpers.jsx';

/*
 * S09 on the browser side: the accomplishment banner, "My certificates" and
 * the public check page.
 *
 * Every certificate here is invented. The real wording ("You are ready to
 * start work", the academy names) lives in the database and reaches the app
 * from the API, so this file proves the screens render whatever the server
 * sends — and no real wording is ever written into the repo or the bundle.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

const LEVEL_CERT = {
  publicId: 'Aa1Bb2Cc3Dd4Ee5Ff6Gg7H',
  kind: 'LEVEL',
  title: 'Level 1: Test Foundation',
  accomplishment: 'Ready for the invented test task',
  track: 'CS',
  holderName: STAFF.fullName,
  issuedAt: '2026-09-23T10:00:00.000Z',
  revoked: false,
  downloadable: true,
};

const DEPT_CERT = {
  publicId: 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3S',
  kind: 'DEPT',
  title: 'Test Academy',
  accomplishment: 'Certified Test Reviewer',
  track: 'ADMIN',
  holderName: STAFF.fullName,
  issuedAt: '2026-09-20T09:00:00.000Z',
  revoked: false,
  downloadable: true,
};

const TRACK = {
  track: STAFF.track,
  waitingForTrack: false,
  stages: [
    {
      code: 'a1',
      title: 'Alpha stage',
      blurb: 'A test blurb.',
      displayNum: '1',
      level: 1,
      dept: null,
      position: 1,
      state: 'done',
      pct: 90,
      attempts: 1,
      best: 90,
      passMark: 80,
      lessonCount: 1,
      recordingCount: 0,
      recordingsWithMedia: 0,
    },
  ],
};

function signedIn(routes = {}) {
  return mockFetch({
    'GET /api/me': [200, { me: STAFF }],
    'GET /api/track': [200, TRACK],
    ...routes,
  });
}

describe('the accomplishment banner', () => {
  it('shows the newest accomplishment on the dashboard, from the API', async () => {
    signedIn({ 'GET /api/certs': [200, { certificates: [LEVEL_CERT, DEPT_CERT] }] });
    renderApp('/');

    const banner = await screen.findByRole('region', { name: /latest accomplishment/i });
    expect(within(banner).getByText(LEVEL_CERT.title)).toBeInTheDocument();
    expect(within(banner).getByText(LEVEL_CERT.accomplishment)).toBeInTheDocument();
    // Two certificates, so the link says so and points at the page.
    const link = within(banner).getByRole('link', { name: /2 certificates/i });
    expect(link).toHaveAttribute('href', '/certificates');
  });

  it('shows nothing when there are no certificates yet', async () => {
    signedIn({ 'GET /api/certs': [200, { certificates: [] }] });
    renderApp('/');

    // The dashboard itself renders …
    expect(
      await screen.findByRole('heading', { name: /welcome back|training complete/i }),
    ).toBeInTheDocument();
    // … and the banner does not.
    expect(screen.queryByRole('region', { name: /latest accomplishment/i })).toBeNull();
  });
});

describe('My certificates', () => {
  it('lists each certificate with a download link and its id', async () => {
    signedIn({ 'GET /api/certs': [200, { certificates: [LEVEL_CERT, DEPT_CERT] }] });
    renderApp('/certificates');

    // Wait for the list itself: the heading is on the page while it loads,
    // and before that the app renders a "Loading…" frame of its own.
    const items = await screen.findAllByRole('listitem');
    const main = within(screen.getByRole('main'));
    expect(main.getByRole('heading', { name: /my certificates/i })).toBeInTheDocument();
    expect(items).toHaveLength(2);

    const first = within(items[0]);
    expect(first.getByText(LEVEL_CERT.title)).toBeInTheDocument();
    expect(first.getByText(LEVEL_CERT.accomplishment)).toBeInTheDocument();
    expect(first.getByText(new RegExp(LEVEL_CERT.publicId))).toBeInTheDocument();
    expect(first.getByRole('link', { name: /download pdf/i })).toHaveAttribute(
      'href',
      `/api/certs/${LEVEL_CERT.publicId}/download`,
    );
    expect(first.getByRole('link', { name: /check it/i })).toHaveAttribute(
      'href',
      `/verify/${LEVEL_CERT.publicId}`,
    );

    expect(within(items[1]).getByText(DEPT_CERT.title)).toBeInTheDocument();
  });

  it('says so when there are none', async () => {
    signedIn({ 'GET /api/certs': [200, { certificates: [] }] });
    renderApp('/certificates');

    expect(await screen.findByText(/don't have any certificates yet/i)).toBeInTheDocument();
  });

  it('offers no download for a withdrawn certificate', async () => {
    signedIn({
      'GET /api/certs': [
        200,
        { certificates: [{ ...LEVEL_CERT, revoked: true, downloadable: false }] },
      ],
    });
    renderApp('/certificates');

    expect(await screen.findByText(/withdrawn/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /download pdf/i })).toBeNull();
  });
});

describe('the public check page', () => {
  const VALID = {
    valid: true,
    name: 'Trainee Alpha',
    track: 'CS',
    kind: 'LEVEL',
    completed: 'Level 1: Test Foundation',
    issuedAt: '2026-09-23T10:00:00.000Z',
  };

  it('shows a valid certificate without anybody signing in', async () => {
    // No /api/me route at all: the helper's default answers 401, which is
    // exactly what a stranger's browser gets.
    const fetchMock = mockFetch({
      [`GET /api/cert/${LEVEL_CERT.publicId}/verify`]: [200, VALID],
    });
    renderApp(`/verify/${LEVEL_CERT.publicId}`);

    expect(await screen.findByText(/verified certificate/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: VALID.name })).toBeInTheDocument();
    expect(screen.getByText(VALID.completed)).toBeInTheDocument();
    // The track code is shown as its label, and the id is on the page.
    expect(screen.getByText('Customer Service')).toBeInTheDocument();
    expect(screen.getByText(LEVEL_CERT.publicId)).toBeInTheDocument();
    // Nothing was fetched that needs a session.
    const asked = fetchMock.mock.calls.map(([path]) => path);
    expect(asked).not.toContain('/api/certs');
  });

  it('says plainly when an id does not check out', async () => {
    mockFetch({ 'GET /api/cert/not-a-real-id/verify': [200, { valid: false }] });
    renderApp('/verify/not-a-real-id');

    expect(await screen.findByText(/could not be verified/i)).toBeInTheDocument();
    expect(screen.getByText(/Id checked: not-a-real-id/)).toBeInTheDocument();
  });

  it('offers a retry when the server could not be asked', async () => {
    mockFetch({ [`GET /api/cert/${LEVEL_CERT.publicId}/verify`]: [500, { error: 'internal' }] });
    renderApp(`/verify/${LEVEL_CERT.publicId}`);

    expect(await screen.findByText(/couldn't check this certificate/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});
