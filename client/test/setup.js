import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// With `globals: false` Testing Library cannot register its own cleanup hook.
afterEach(() => {
  cleanup();
});

// jsdom does not implement scrolling; keep it quiet in tests.
globalThis.window.scrollTo = () => {};
