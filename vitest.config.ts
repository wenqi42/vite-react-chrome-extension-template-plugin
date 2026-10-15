import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/**/*.vitest.ts'],
    environment: 'node',
    passWithNoTests: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['packages/vite-plugin-chrome-extension/index.ts', 'packages/vite-plugin-chrome-extension/dev.ts'],
      exclude: ['**/dist/**', '**/test/**', '**/*.d.ts'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
    },
  },
})
