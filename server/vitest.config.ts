import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Test files run one at a time: the migration test drops and rebuilds the
    // academy schema in the shared test database, and the S03 auth tests
    // write to that same database. Running them side by side would race.
    fileParallelism: false,
  },
});
