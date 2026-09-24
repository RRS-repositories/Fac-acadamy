import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { STAFF, mockFetch, renderApp } from './helpers.jsx';

afterEach(() => {
  vi.unstubAllGlobals();
});

// Invented rows only: the real 34 statuses are the firm's content and live in
// the database, never in this repo. The page has to work off whatever the API
// sends it, which is exactly what these stand-ins prove.
const ROWS = [
  {
    status: 'Alpha Review',
    clientLine: 'We are reviewing your file and will call you back.',
    sort: 1,
  },
  { status: 'Bravo Requested', clientLine: 'We have asked for the missing paperwork.', sort: 2 },
  {
    status: 'Charlie Closed',
    clientLine: 'Your file is closed; nothing further is needed.',
    sort: 3,
  },
];

function signedIn(routes = {}) {
  return mockFetch({
    'GET /api/me': [200, { me: STAFF }],
    // The shell's rail reads this; the page itself needs nothing from it.
    'GET /api/track': [200, { track: STAFF.track, waitingForTrack: false, stages: [] }],
    'GET /api/status-guide': [200, { rows: ROWS }],
    ...routes,
  });
}

/** The page body, so nothing here can match the shell around it. */
function main() {
  return within(screen.getByRole('main'));
}

function searchBox() {
  return main().getByRole('searchbox', { name: 'Search the status guide' });
}

function shownStatuses() {
  return main()
    .getAllByRole('listitem')
    .map((li) => li.firstChild.textContent);
}

describe('Status Guide page', () => {
  it('lists every row the API sends, in the order it sends them', async () => {
    signedIn();
    renderApp('/status-guide');

    expect(await screen.findByRole('heading', { name: 'The Status Guide' })).toBeInTheDocument();
    await screen.findAllByRole('listitem');
    expect(shownStatuses()).toEqual(['Alpha Review', 'Bravo Requested', 'Charlie Closed']);
    expect(screen.getByText(ROWS[0].clientLine)).toBeInTheDocument();
    expect(screen.getByText('3 statuses')).toBeInTheDocument();
  });

  it('filters live as you type, on the status and on the client line', async () => {
    signedIn();
    renderApp('/status-guide');
    const box = await screen.findByRole('searchbox', { name: 'Search the status guide' });
    await screen.findAllByRole('listitem');

    // Matches the status, case-insensitively.
    fireEvent.change(box, { target: { value: 'bravo' } });
    expect(shownStatuses()).toEqual(['Bravo Requested']);
    expect(screen.getByText('1 of 3 statuses')).toBeInTheDocument();

    // Matches the client line too.
    fireEvent.change(box, { target: { value: 'paperwork' } });
    expect(shownStatuses()).toEqual(['Bravo Requested']);

    // Clearing brings everything back.
    fireEvent.change(box, { target: { value: '' } });
    expect(shownStatuses()).toHaveLength(3);
  });

  it('shows a clear empty state, and the clear button restores the list', async () => {
    signedIn();
    renderApp('/status-guide');
    const box = await screen.findByRole('searchbox', { name: 'Search the status guide' });
    await screen.findAllByRole('listitem');

    fireEvent.change(box, { target: { value: 'zzzz no such status' } });
    expect(main().queryByRole('listitem')).not.toBeInTheDocument();
    expect(screen.getByText('No status matches your search.')).toBeInTheDocument();
    expect(screen.getByText('0 of 3 statuses')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(shownStatuses()).toHaveLength(3);
    expect(searchBox()).toHaveValue('');
  });

  it('never scrolls while filtering (scroll rule: in-place updates stay put)', async () => {
    signedIn();
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    window.scrollTo = scrollTo;
    renderApp('/status-guide');
    const box = await screen.findByRole('searchbox', { name: 'Search the status guide' });
    await screen.findAllByRole('listitem');

    scrollTo.mockClear(); // the route change on first render is allowed to scroll
    for (const value of ['a', 'al', 'alp', 'alph', 'alpha']) {
      fireEvent.change(box, { target: { value } });
    }
    expect(shownStatuses()).toEqual(['Alpha Review']);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('keeps the search box keyboard reachable and labelled', async () => {
    signedIn();
    renderApp('/status-guide');
    const box = await screen.findByRole('searchbox', { name: 'Search the status guide' });
    await screen.findAllByRole('listitem');

    box.focus();
    expect(box).toHaveFocus();
    // A native input: reachable by Tab, no tabindex games.
    expect(box).not.toHaveAttribute('tabindex');
    expect(box.tagName).toBe('INPUT');
  });

  it('offers a retry when the guide cannot be loaded, and shows no rows', async () => {
    const fetchMock = signedIn({ 'GET /api/status-guide': [500, { error: 'internal' }] });
    renderApp('/status-guide');

    expect(await screen.findByText("We couldn't load the status guide.")).toBeInTheDocument();
    expect(main().queryByRole('listitem')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText("We couldn't load the status guide.");
    expect(
      fetchMock.mock.calls.filter(([path]) => path === '/api/status-guide').length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('sends a signed-out visitor to sign in first', async () => {
    mockFetch();
    renderApp('/status-guide');
    expect(
      await screen.findByRole('heading', { name: 'Sign in to start training' }),
    ).toBeInTheDocument();
  });
});
