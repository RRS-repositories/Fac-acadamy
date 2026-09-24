import { vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from '../src/App.jsx';

// Invented test people only.
export const STAFF = {
  id: 7,
  fullName: 'Trainee Alpha',
  email: 'trainee.a@example.com',
  role: 'STAFF',
  track: 'CS',
};
export const MANAGER = {
  id: 8,
  fullName: 'Manager Beta',
  email: 'manager.b@example.com',
  role: 'MANAGER',
  track: 'MGMT',
};

export const QR_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === undefined) throw new SyntaxError('no body');
      return body;
    },
  };
}

/**
 * Stub global fetch. `routes` maps "METHOD /path" to [status, body] or to a
 * function (init) => [status, body]. Unknown routes answer 404.
 * GET /api/me defaults to 401 (signed out).
 */
export function mockFetch(routes = {}) {
  const table = { 'GET /api/me': [401, { error: 'not_signed_in' }], ...routes };
  const fn = vi.fn(async (path, init = {}) => {
    const key = `${init.method ?? 'GET'} ${path}`;
    const entry = table[key];
    if (!entry) return response(404, { error: 'not_found' });
    const [status, body] = typeof entry === 'function' ? entry(init) : entry;
    return response(status, body);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** The fetch calls made to one "METHOD /path". */
export function callsTo(fetchMock, method, path) {
  return fetchMock.mock.calls.filter(
    ([p, init = {}]) => p === path && (init.method ?? 'GET') === method,
  );
}

export function renderApp(path = '/') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
