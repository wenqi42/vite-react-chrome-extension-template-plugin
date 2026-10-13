import { chmodSync } from "node:fs";

// npm's bin entry points to this compiled executable, not to TypeScript source.
chmodSync(new URL("./bin/create.js", import.meta.url), 0o755);
