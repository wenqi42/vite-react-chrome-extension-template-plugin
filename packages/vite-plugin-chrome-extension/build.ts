import { copyFileSync } from "node:fs";

copyFileSync(
  new URL("../chrome-permission-map.json", import.meta.url),
  new URL("./chrome-permission-map.json", import.meta.url),
);
