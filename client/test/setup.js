import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

// Testing Library's findBy*/waitFor give up after 1 second by default. The
// first render of a page plus its mocked fetch can take longer than that on a
// loaded CI runner, which fails a test that is in fact passing. Waiting longer
// changes no assertion; it only stops the suite reporting a timing accident as
// a defect.
configure({ asyncUtilTimeout: 5_000 });

// With `globals: false` Testing Library cannot register its own cleanup hook.
afterEach(() => {
  cleanup();
});

// jsdom does not implement scrolling; keep it quiet in tests.
globalThis.window.scrollTo = () => {};
