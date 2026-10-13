import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import chromeExtension from '@vite-react-chrome-extension/plugin'

export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      input: { background: 'modules/background/background.ts' },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'background'
            ? 'background.js'
            : 'assets/[name]-[hash].js',
        assetFileNames: (asset) =>
          asset.name?.endsWith('.css')
            ? 'assets/css/[name][extname]'
            : 'assets/[name]-[hash][extname]',
      },
    },
  },
  plugins: [
    react(),
    chromeExtension({
      manifest: {
        name: 'My React Chrome Extension',
        description: 'A Chrome extension created with Vite and React.',
        permissions: ['tabs'],
      },
      background: 'background.js',
    }),
  ],
})
