// Flat config for the whole monorepo. Type-aware rules stay off in Phase 0 so
// lint runs fast without project references; `npm run typecheck` covers types.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always'],
      'no-console': 'off',
    },
  },
  {
    files: ['**/*.{js,mjs,cjs,ts}'],
    ignores: ['client/src/**', 'client/test/**'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // The browser app is plain JavaScript (.js/.jsx). It must never import
    // server or ops code: that is how answers, lesson HTML or secrets would
    // leak into the bundle.
    files: ['client/src/**/*.{js,jsx}', 'client/test/**/*.{js,jsx}'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/server/**', '@fac-academy/server', '@fac-academy/server/*'],
              message: 'The client must not import server code. Use @fac-academy/shared contracts.',
            },
            {
              group: ['**/ops/**', '@fac-academy/ops', '@fac-academy/ops/*'],
              message: 'The client must not import ops code.',
            },
          ],
        },
      ],
    },
  },
  {
    // shared/ is imported by the browser too: it holds contracts only.
    files: ['shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/server/**', '**/client/**', '**/ops/**'],
              message: 'shared/ must stay dependency-free of the apps.',
            },
          ],
        },
      ],
    },
  },
  prettier,
);
