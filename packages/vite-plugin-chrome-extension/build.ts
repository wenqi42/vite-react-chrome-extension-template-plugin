import { chmodSync, copyFileSync } from "node:fs";

copyFileSync(
  new URL("../chrome-permission-map.json", import.meta.url),
  new URL("./chrome-permission-map.json", import.meta.url),
);
chmodSync(new URL("./doctor.js", import.meta.url), 0o755);
