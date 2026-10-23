// SPDX-License-Identifier: Apache-2.0
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-types/**',
      '**/vendor/**',
      '**/node_modules/**',
      'test-results/**',
      'playwright-report/**',
      // Golden fixtures are ordinary user apps (CommonJS, Node globals).
      'test/fixtures/**',
      // Preset templates are user apps too (packages/clientvm/presets, ADR 0018).
      'packages/clientvm/presets/**',
      // Node's own tests, vendored byte for byte.
      'test/conformance/node-tests/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Packages talk only through their public `exports`; no reaching into another package's files.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@clientvm/*/*'], message: 'Import from the package entry point only.' },
          ],
        },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly', URL: 'readonly' } },
  },
);
