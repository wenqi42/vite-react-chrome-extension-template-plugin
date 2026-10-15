import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.nyc_output/**',
      '**/.cache/**',
      '**/.vite/**',
      '**/.turbo/**',
      '**/.playwright-mcp/**',
    ],
  },
  {
    files: ['**/*.{js,mjs,ts,tsx}'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [...tseslint.configs.recommended],
    rules: {
      // Existing Chrome protocol payloads and runtime mocks use dynamic values.
      // Keep this compatibility exception while still checking unused TS values.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    files: [
      'examples/**/modules/**/*.{js,mjs,ts,tsx}',
      'examples/**/public/**/*.{js,mjs,ts,tsx}',
      'packages/create-chrome-extension/template/modules/**/*.{js,mjs,ts,tsx}',
      'packages/create-chrome-extension/template/src/**/*.{js,mjs,ts,tsx}',
    ],
    languageOptions: {
      globals: {
        ...Object.fromEntries(Object.keys(globals.node).map(name => [name, 'off'])),
        ...globals.browser,
        chrome: 'readonly',
      },
    },
  },
)
