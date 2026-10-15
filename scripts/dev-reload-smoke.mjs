#!/usr/bin/env node
/**
 * Chrome/CDP acceptance for CASE-06. Requires Node 22+ and Chrome for Testing.
 * The fixture and browser profile live in a new temporary directory; repository
 * source files and the user's existing browser profile are never edited.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, createServer } from "vite";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const chromeFlag = args.indexOf("--chrome");
const chromePath =
  chromeFlag >= 0 ? args[chromeFlag + 1] : process.env.CHROME_PATH;
const keep = args.includes("--keep");
const headed = args.includes("--headed");
const statusPath = "/__chrome_extension_dev_status__";
const clientName = "chrome-extension-dev-client.js";

if (!chromePath || typeof WebSocket === "undefined") {
  console.error(
    "Use Node 22+ and pass --chrome /path/to/chrome-for-testing (or set CHROME_PATH).",
  );
  process.exit(1);
}
await fs.access(chromePath);

const temporary = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), "extension-dev-reload-")),
);
const fixture = path.join(temporary, "fixture");
const profile = path.join(temporary, "chrome-profile");
let vite;
let chrome;
let cdp;
let chromeStderr = "";
const evidence = {
  startedAt: new Date().toISOString(),
  fixture,
  chrome: chromePath,
  checks: [],
  errors: [],
};

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(check, description, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(
    `Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`,
  );
}

async function write(relative, content) {
  const filename = path.join(fixture, relative);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, content);
}

async function filesIn(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesIn(filename)));
    else files.push(filename);
  }
  return files;
}

async function snapshot(directory) {
  return Object.fromEntries(
    await Promise.all(
      (await filesIn(directory)).map(async (filename) => [
        path.relative(directory, filename),
        await fs.readFile(filename, "utf8"),
      ]),
    ),
  );
}

class CDP {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.sessions = new Map();
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timeout);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else if (message.method === "Runtime.exceptionThrown") {
        evidence.errors.push(
          message.params.exceptionDetails.exception?.description ??
            message.params.exceptionDetails.text,
        );
      } else if (
        message.method === "Runtime.consoleAPICalled" &&
        message.params.type === "error"
      ) {
        evidence.errors.push(
          message.params.args
            .map((argument) => argument.value ?? argument.description)
            .join(" "),
        );
      }
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return new CDP(socket);
  }

  request(method, params = {}, sessionId) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, 5_000);
      this.pending.set(id, { resolve, reject, timeout });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  async attach(targetId) {
    if (this.sessions.has(targetId)) return this.sessions.get(targetId);
    const { sessionId } = await this.request("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    this.sessions.set(targetId, sessionId);
    await this.request("Runtime.enable", {}, sessionId);
    return sessionId;
  }

  async detach(targetId) {
    const sessionId = this.sessions.get(targetId);
    if (sessionId) {
      await this.request("Target.detachFromTarget", { sessionId });
      this.sessions.delete(targetId);
    }
  }

  async evaluate(targetId, expression) {
    const sessionId = await this.attach(targetId);
    const result = await this.request(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text,
      );
    }
    return result.result.value;
  }

  async targets() {
    return (await this.request("Target.getTargets")).targetInfos;
  }
}

async function configure(liveReload) {
  await write(
    "vite.config.mjs",
    `import chromeExtension, { defineBackground } from "@vite-react-chrome-extension/plugin";
export default {
  base: "./",
  plugins: [chromeExtension({
    liveReload: ${liveReload},
    tailwind: false,
    background: defineBackground("modules/background/background.ts"),
    manifest: {
      name: "Extension dev reload CDP fixture",
      version: "1.0.0",
      content_scripts: [{
        matches: ["http://127.0.0.1/*"],
        js: ["modules/content/content.ts"],
        run_at: "document_idle"
      }]
    }
  })]
};`,
  );
}

async function startVite(port = 0) {
  vite = await createServer({
    root: fixture,
    configFile: path.join(fixture, "vite.config.mjs"),
    logLevel: "warn",
    clearScreen: false,
    server: { host: "127.0.0.1", port, strictPort: port !== 0 },
  });
  await vite.listen();
  const address = vite.httpServer.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

try {
  await fs.mkdir(fixture, { recursive: true });
  await fs.mkdir(profile, { recursive: true });
  await fs.symlink(path.join(repository, "node_modules"), path.join(fixture, "node_modules"));
  await write("package.json", '{"type":"module","private":true}');
  await configure(true);
  await write("version.ts", 'export const version = "initial";');
  await write("page-version.ts", 'export const pageVersion = "page-initial";');
  await write(
    "modules/popup/index.html",
    '<!doctype html><html><head><meta charset="utf-8"><title>Reload fixture</title></head><body><main id="status"></main><script type="module" src="./index.ts"></script></body></html>',
  );
  await write(
    "modules/popup/index.ts",
    `import { version } from "../../version";
import { pageVersion } from "../../page-version";
document.querySelector("#status").textContent = version + "/" + pageVersion;`,
  );
  await write(
    "modules/background/background.ts",
    `import { version } from "../../version";
globalThis.__smokeVersion = version;
chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.type === "smoke-version") reply(version);
});`,
  );
  await write(
    "modules/content/content.ts",
    `import { version } from "../../version";
document.documentElement.dataset.extensionSmoke = version;`,
  );
  await write(
    "host.html",
    '<!doctype html><html><head><meta charset="utf-8"><title>Host fixture</title></head><body>Host fixture</body></html>',
  );
  const origin = await startVite();
  const status = async () => {
    const response = await fetch(`${origin}${statusPath}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const initial = await waitFor(async () => {
    const value = await status();
    return value.revision > 0 && !value.building && !value.error && value;
  }, "first successful dev extension build");
  const devDist = path.join(fixture, "dist");
  const manifest = JSON.parse(await fs.readFile(path.join(devDist, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  await fs.access(path.join(devDist, clientName));
  evidence.checks.push("dev watch build writes a loadable MV3 dist");

  chrome = spawn(chromePath, [
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${devDist}`,
    `--load-extension=${devDist}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    ...(headed ? [] : ["--headless=new"]),
    "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  chrome.stderr.on("data", (chunk) => { chromeStderr += chunk; });
  const debugPort = await waitFor(async () => {
    const content = await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8");
    return Number(content.split("\n")[0]);
  }, "Chrome remote debugging port");
  const browser = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
  evidence.browser = browser.Browser;
  cdp = await CDP.connect(browser.webSocketDebuggerUrl);
  const { targetId: extensionsPage } = await cdp.request("Target.createTarget", {
    url: "chrome://extensions",
  });
  await waitFor(async () =>
    cdp.evaluate(extensionsPage, "typeof chrome.developerPrivate?.updateProfileConfiguration === 'function'"),
    "Chrome Developer mode control");
  const profileConfiguration = await cdp.evaluate(extensionsPage, `(async () => {
    await chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true });
    return chrome.developerPrivate.getProfileConfiguration();
  })()`);
  assert.equal(profileConfiguration.inDeveloperMode, true);
  evidence.checks.push("Developer mode enabled and confirmed in the isolated Chrome profile");
  await cdp.request("Target.closeTarget", { targetId: extensionsPage });
  const worker = await waitFor(async () => {
    for (const target of await cdp.targets()) {
      if (
        target.type !== "service_worker" ||
        !target.url.startsWith("chrome-extension://") ||
        !target.url.endsWith(`/${manifest.background.service_worker}`)
      ) continue;
      const name = await cdp.evaluate(target.targetId, "chrome.runtime.getManifest().name");
      if (name === manifest.name) return target;
      await cdp.detach(target.targetId);
    }
    return undefined;
  }, "fixture extension service worker");
  const extensionOrigin = `chrome-extension://${new URL(worker.url).hostname}`;
  evidence.extensionOrigin = extensionOrigin;
  const popupUrl = `${extensionOrigin}/${manifest.action.default_popup}`;
  const openPopup = async (expected) => {
    let { targetId } = await cdp.request("Target.createTarget", { url: popupUrl });
    await waitFor(async () => {
      if (!(await cdp.targets()).some((target) => target.targetId === targetId)) {
        ({ targetId } = await cdp.request("Target.createTarget", { url: popupUrl }));
      }
      const value = await cdp.evaluate(
        targetId,
        '({ protocol: location.protocol, status: document.querySelector("#status")?.textContent })',
      );
      if (value.status === expected) return true;
      // runtime.reload unloads the extension before re-registering it. A tab
      // opened during that brief gap displays chrome-error and needs navigation
      // again, equivalent to reopening the popup once registration is complete.
      if (value.protocol !== "chrome-extension:") {
        await cdp.request("Page.navigate", { url: popupUrl }, await cdp.attach(targetId));
      }
      return false;
    }, `popup rendering ${expected}`);
    return targetId;
  };
  let popup = await openPopup("initial/page-initial");
  assert.equal(await cdp.evaluate(worker.targetId, "globalThis.__smokeVersion"), "initial");
  const { targetId: host } = await cdp.request("Target.createTarget", { url: `${origin}/host.html` });
  await waitFor(async () =>
    (await cdp.evaluate(host, "document.documentElement.dataset.extensionSmoke")) === "initial",
    "initial isolated-world content script");
  evidence.checks.push("popup, worker and isolated content run in an unpacked extension");

  await write("page-version.ts", 'export const pageVersion = "page-updated";');
  const pageUpdated = await waitFor(async () => {
    const value = await status();
    return value.revision > initial.revision && !value.building && !value.error && value;
  }, "successful page-only rebuild");
  await waitFor(async () =>
    (await cdp.evaluate(popup, 'document.querySelector("#status")?.textContent')) === "initial/page-updated",
    "same-tab automatic page reload", 45_000);
  assert((await cdp.targets()).some((target) => target.targetId === worker.targetId));
  evidence.checks.push("page-only source edit reloads the same popup tab without restarting background");

  // CDP attachment itself keeps service workers alive. Detach before testing the
  // real >30-second MV3 idle boundary so the result proves the dev transport.
  await cdp.detach(worker.targetId);
  console.log("Checking MV3 worker transport across the 30-second idle boundary...");
  await delay(36_000);
  assert((await cdp.targets()).some((target) => target.targetId === worker.targetId));
  evidence.checks.push("dev worker remains alive for 36 seconds without a debugger attached");

  await write("version.ts", 'export const version = "updated";');
  const updated = await waitFor(async () => {
    const value = await status();
    return value.revision > pageUpdated.revision && !value.building && !value.error && value;
  }, "successful rebuild revision");
  await waitFor(async () => {
    const targets = await cdp.targets();
    return !targets.some((target) => target.targetId === worker.targetId) &&
      !targets.some((target) => target.targetId === popup);
  }, "automatic extension reload closing old worker and popup", 45_000);
  popup = await openPopup("updated/page-updated");
  await waitFor(async () =>
    (await cdp.evaluate(popup, 'chrome.runtime.sendMessage({ type: "smoke-version" })')) === "updated",
    "updated worker responding after reopening popup");
  await waitFor(async () => {
    for (const target of await cdp.targets()) {
      if (target.type !== "service_worker" || !target.url.startsWith(extensionOrigin)) continue;
      if ((await cdp.evaluate(target.targetId, "globalThis.__smokeVersion")) === "updated") return target;
    }
    return undefined;
  }, "automatic background runtime reload", 45_000);
  evidence.checks.push("worker/content edit automatically reloads extension; reopened popup and worker use new version");

  // CASE-07 is explicitly a limit: runtime.reload does not re-run a content
  // script inside an already-open host document. A host navigation is needed.
  const hostAfterReload = await cdp.evaluate(host, "document.documentElement.dataset.extensionSmoke");
  assert.equal(hostAfterReload, "initial");
  await cdp.request("Page.reload", {}, await cdp.attach(host));
  await waitFor(async () =>
    (await cdp.evaluate(host, "document.documentElement.dataset.extensionSmoke")) === "updated",
    "content script after host refresh");
  evidence.checks.push("content update requires host refresh; refreshed host receives new script");

  const goodFiles = await snapshot(devDist);
  await write("version.ts", 'export const version = ;');
  await waitFor(async () => {
    const value = await status();
    return value.error && value;
  }, "failed-build diagnostics");
  await delay(500);
  const failed = await status();
  assert.equal(failed.revision, updated.revision);
  assert.deepEqual(await snapshot(devDist), goodFiles);
  assert.equal(await cdp.evaluate(popup, 'document.querySelector("#status")?.textContent'), "updated/page-updated");
  evidence.checks.push("syntax error keeps last successful dist and does not publish a reload revision");
  await write("version.ts", 'export const version = "recovered";');
  await waitFor(async () => {
    const value = await status();
    return value.revision > updated.revision && !value.building && !value.error;
  }, "recovery build");
  await waitFor(async () =>
    !(await cdp.targets()).some((target) => target.targetId === popup),
    "automatic extension reload after error recovery", 45_000);
  popup = await openPopup("recovered/page-updated");
  evidence.checks.push("fixing the syntax error resumes automatic reload");

  // Reconnect uses the original HTTP origin to discover the new socket token.
  // A server that restarts on a different port cannot be discovered this way.
  await cdp.evaluate(popup, 'chrome.runtime.sendMessage({ type: "smoke-version" })');
  const beforeRestart = await status();
  await vite.close();
  vite = undefined;
  const restartedOrigin = await startVite(Number(new URL(origin).port));
  assert.equal(restartedOrigin, origin);
  await waitFor(async () => {
    const value = await status();
    return value.session !== beforeRestart.session &&
      value.revision > 0 && !value.error && !value.building;
  }, "same-origin Vite restart");
  await waitFor(async () =>
    !(await cdp.targets()).some((target) => target.targetId === popup),
    "automatic extension reload after same-origin server restart", 45_000);
  popup = await openPopup("recovered/page-updated");
  assert.equal(
    await cdp.evaluate(popup, 'chrome.runtime.sendMessage({ type: "smoke-version" })'),
    "recovered",
  );
  evidence.checks.push("same-origin Vite restart reconnects with new session/socket token and reloads extension");
  assert.deepEqual(evidence.errors, []);
  evidence.checks.push("no Runtime exception or console.error in observed extension and host targets");

  await cdp.request("Browser.close");
  cdp.socket.close();
  await vite.close();
  vite = undefined;
  await build({
    root: fixture,
    configFile: path.join(fixture, "vite.config.mjs"),
    logLevel: "warn",
    build: { outDir: "dist-production" },
  });
  const production = await snapshot(path.join(fixture, "dist-production"));
  assert(!Object.hasOwn(production, clientName));
  assert(!Object.values(production).some((source) => source.includes("chrome-extension:dev:")));
  const productionManifest = JSON.parse(production["manifest.json"]);
  assert(!JSON.stringify(productionManifest).includes(origin));
  assert.equal(productionManifest.host_permissions, undefined);
  assert.equal(productionManifest.content_security_policy, undefined);
  evidence.checks.push("production build contains no dev client, reload protocol, dev host permission or development CSP");

  await configure(false);
  const disabledOrigin = await startVite();
  const disabledResponse = await fetch(`${disabledOrigin}${statusPath}`);
  assert(
    disabledResponse.status !== 200 ||
      !disabledResponse.headers.get("content-type")?.includes("application/json"),
    "liveReload:false must not start the extension revision server",
  );
  const disabledFiles = await snapshot(devDist);
  await write("version.ts", 'export const version = "disabled-update";');
  await delay(1_000);
  assert.deepEqual(await snapshot(devDist), disabledFiles);
  evidence.checks.push("liveReload:false leaves serve as ordinary Vite preview");
  evidence.result = "PASS";
  evidence.finishedAt = new Date().toISOString();
  await fs.writeFile(
    path.join(temporary, "dev-reload-cdp-evidence.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.log(JSON.stringify(evidence, null, 2));
} catch (error) {
  evidence.result = "FAIL";
  evidence.failure = error.stack ?? String(error);
  evidence.chromeStderr = chromeStderr.slice(-8_000);
  if (cdp?.socket.readyState === WebSocket.OPEN) {
    try {
      const { targetId } = await cdp.request("Target.createTarget", { url: "chrome://extensions" });
      evidence.extensionDiagnostics = await waitFor(async () => {
        const ready = await cdp.evaluate(targetId, "typeof chrome.developerPrivate?.getExtensionsInfo === 'function'");
        if (!ready) return false;
        return cdp.evaluate(targetId, `new Promise(resolve => chrome.developerPrivate.getExtensionsInfo(
          { includeDisabled: true, includeTerminated: true },
          items => resolve(items.filter(item => item.name === "Extension dev reload CDP fixture").map(
            ({ id, name, state, path, disableReasons, manifestErrors, runtimeErrors, runtimeWarnings }) =>
              ({ id, name, state, path, disableReasons, manifestErrors, runtimeErrors, runtimeWarnings })
          ))
        ))`);
      }, "Chrome extension failure diagnostics", 5_000);
    } catch (diagnosticError) {
      evidence.diagnosticError = diagnosticError.message;
    }
  }
  evidence.finishedAt = new Date().toISOString();
  await fs.writeFile(
    path.join(temporary, "dev-reload-cdp-evidence.json"),
    JSON.stringify(evidence, null, 2),
  );
  console.error(JSON.stringify(evidence, null, 2));
  process.exitCode = 1;
} finally {
  cdp?.socket.close();
  await vite?.close();
  if (chrome && chrome.exitCode === null) chrome.kill("SIGTERM");
  if (keep) console.log(`Preserved smoke fixture: ${temporary}`);
  else await fs.rm(temporary, { recursive: true, force: true });
}
