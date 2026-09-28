import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import RecordingSummary from '../src/components/training/RecordingSummary.jsx';
import { callsTo, mockFetch } from './helpers.jsx';

/*
 * The "Summarise" button under a recording.
 *
 * Every state comes from the server: the component is told `state` and renders
 * it. So these tests are mostly about honesty — that the button says "not
 * available yet" when there is no transcript instead of offering something that
 * would do nothing, that a switched-off feature leaves NOTHING on the page, and
 * that a failure says nothing was saved and lets the trainee try again.
 *
 * Everything is invented: recording 21 does not exist and the "summary" is three
 * made-up lines.
 */

const PATH = '/api/media/21/summary';

const SUMMARY = [
  'The agent called the client about an outstanding questionnaire.',
  '- The client was missing an account number.',
  '- Two bank statements are still needed.',
].join('\n');

function state(overrides) {
  return {
    recordingId: 21,
    state: 'ready',
    summary: null,
    model: null,
    generatedAt: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderSummary(routes) {
  const fetchMock = mockFetch(routes);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RecordingSummary recordingId={21} mediaType="AUDIO" />
    </QueryClientProvider>,
  );
  return fetchMock;
}

const button = () => screen.queryByRole('button', { name: /summarise this call/i });

describe('RecordingSummary', () => {
  it('renders nothing at all when the feature is switched off', async () => {
    renderSummary({ [`GET ${PATH}`]: [200, state({ state: 'disabled' })] });

    // Give the query time to resolve, then check the page is still empty.
    await waitFor(() => {
      expect(screen.queryByText(/summar/i)).toBeNull();
    });
    expect(button()).toBeNull();
    expect(document.querySelector('[data-summary]')).toBeNull();
  });

  it('renders nothing when the server cannot be asked', async () => {
    // mockFetch answers an unknown route with 404, which is what an old server
    // without this endpoint would do. A summary must never break the player.
    renderSummary({});
    await waitFor(() => {
      expect(document.querySelector('[data-summary]')).toBeNull();
    });
    expect(button()).toBeNull();
  });

  it('says a summary is not available yet when there is no transcript, and offers no button', async () => {
    renderSummary({ [`GET ${PATH}`]: [200, state({ state: 'no_transcript' })] });

    expect(await screen.findByText(/isn't available yet/i)).toBeTruthy();
    expect(screen.getByText(/hasn't been transcribed/i)).toBeTruthy();
    expect(button()).toBeNull();
  });

  it('offers the button when there is a transcript, and shows the summary after a press', async () => {
    const fetchMock = renderSummary({
      [`GET ${PATH}`]: [200, state({ state: 'ready' })],
      [`POST ${PATH}`]: [
        200,
        state({
          state: 'done',
          summary: SUMMARY,
          model: 'a-model',
          generatedAt: '2026-09-28T09:00:00.000Z',
        }),
      ],
    });

    const press = await screen.findByRole('button', { name: /summarise this call/i });
    expect(callsTo(fetchMock, 'POST', PATH)).toHaveLength(0);

    press.click();

    expect(await screen.findByText(/what was said on this call/i)).toBeTruthy();
    expect(screen.getByText(/outstanding questionnaire/i)).toBeTruthy();
    // The bullet dashes become bullets, not literal hyphens in the text.
    expect(screen.getByText('The client was missing an account number.')).toBeTruthy();
    // And it is honest about what it is.
    expect(screen.getByText(/written by AI from the transcript/i)).toBeTruthy();

    // Exactly one press, exactly one request.
    expect(callsTo(fetchMock, 'POST', PATH)).toHaveLength(1);
    // The button is gone once there is a summary: there is nothing left to press.
    await waitFor(() => {
      expect(button()).toBeNull();
    });
  });

  it('shows the saved summary straight away, with no button and no press', async () => {
    const fetchMock = renderSummary({
      [`GET ${PATH}`]: [200, state({ state: 'done', summary: SUMMARY, model: 'a-model' })],
    });

    expect(await screen.findByText(/what was said on this call/i)).toBeTruthy();
    expect(button()).toBeNull();
    // Nobody paid for a model call to read it: no POST at all.
    expect(callsTo(fetchMock, 'POST', PATH)).toHaveLength(0);
  });

  it('says somebody else is having it written, and lets them press again', async () => {
    renderSummary({
      [`GET ${PATH}`]: [200, state({ state: 'working' })],
    });

    expect(await screen.findByText(/somebody else is having this call summarised/i)).toBeTruthy();
    // It is still pressable: a second press costs nothing while one is in flight.
    expect(button()).not.toBeNull();
  });

  it('says nothing was saved when it fails, and keeps the button pressable', async () => {
    const fetchMock = renderSummary({
      [`GET ${PATH}`]: [200, state({ state: 'ready' })],
      [`POST ${PATH}`]: [502, { error: 'summary_failed' }],
    });

    const press = await screen.findByRole('button', { name: /summarise this call/i });
    press.click();

    expect(await screen.findByText(/nothing was saved/i)).toBeTruthy();
    expect(button()).not.toBeNull();

    // Pressing again really does ask again.
    button().click();
    await waitFor(() => {
      expect(callsTo(fetchMock, 'POST', PATH)).toHaveLength(2);
    });
  });

  it('calls it a recording rather than a call for a video', async () => {
    mockFetch({ [`GET ${PATH}`]: [200, state({ state: 'ready' })] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <RecordingSummary recordingId={21} mediaType="VIDEO" />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('button', { name: /summarise this recording/i })).toBeTruthy();
  });
});
