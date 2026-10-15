import { defineConfig } from 'vite'
import chromeExtension, { defineBackground } from '@vite-react-chrome-extension/plugin'

export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      input: { background: 'modules/background/background.ts', sidepanel: 'modules/sidepanel/index.html' },
      output: {
        entryFileNames: chunk => chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  plugins: [chromeExtension({
    tailwind: false,
    pages: false,
    background: defineBackground('modules/background/background.ts'),
    manifest: {
      name: 'Network Rewrite Sidebar',
      description: 'Inspect and rewrite responses for the selected tab.',
      permissions: ['debugger', 'offscreen', 'storage', 'sidePanel', 'tabs'],
      host_permissions: ['http://*/*', 'https://*/*'],
      action: { default_title: 'Network Rewrite Sidebar' },
      side_panel: { default_path: 'modules/sidepanel/index.html' },
      sandbox: { pages: ['sandbox.html'] },
      content_security_policy: {
        sandbox: "sandbox allow-scripts; script-src 'self' 'unsafe-eval'; object-src 'self'",
      },
    },
  })],
})
