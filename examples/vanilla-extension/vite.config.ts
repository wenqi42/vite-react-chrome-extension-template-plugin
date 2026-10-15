import { defineConfig } from "vite";
import chromeExtension from "@vite-react-chrome-extension/plugin";

export default defineConfig({
  base: "./",
  build: {
    rollupOptions: {
      input: { background: "modules/background/background.ts" },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "background"
            ? "background.js"
            : "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  plugins: [
    chromeExtension({
      manifest: {
        name: "Vanilla Vite Extension",
        description: "A framework-agnostic DOM smoke-test extension.",
        content_scripts: [
          {
            matches: ["http://localhost/*", "http://127.0.0.1/*"],
            js: ["modules/content/content.ts"],
            css: ["modules/content/content.css"],
            run_at: "document_idle",
          },
        ],
      },
      background: "background.js",
    }),
  ],
});
