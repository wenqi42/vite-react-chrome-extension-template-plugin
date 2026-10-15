import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import {
  build,
  loadConfigFromFile,
  mergeConfig,
  type InlineConfig,
  type Plugin,
  type PluginOption,
  type UserConfig,
  type ViteDevServer,
} from "vite";
import type { InputOption, OutputBundle, OutputOptions, RollupWatcher } from "rollup";
import type { ChromeExtensionOptions, Manifest } from "./index.js";
import { contentHmrRuntimeSource, prepareContentHmr, type ContentHmrEntry } from "./content-hmr.js";

export const DEV_CLIENT_FILE = "chrome-extension-dev-client.js";
export const DEV_WORKER_FILE = "chrome-extension-dev-worker.js";
export const DEV_STATUS_PATH = "/__chrome_extension_dev_status__";
export const DEV_HELLO_EVENT = "chrome-extension:dev:hello";
export const DEV_RELOAD_EVENT = "chrome-extension:dev:reload";
export const DEV_BUILD = Symbol("chrome-extension-dev-build");

interface ReloadState {
  session: string;
  revision: number;
  building: boolean;
  error: string | null;
  outDir: string;
  reloadExtension?: boolean;
  lastExtensionReloadRevision?: number;
  contentScripts?: ContentHmrEntry[];
  runtimeSnapshot?: string;
  contentOnly?: boolean;
}

interface ReloadConnection {
  socketUrl: string;
  httpOrigin: string;
  session: string;
  revision: number;
  contentScripts?: ContentHmrEntry[];
  runtimeSnapshot?: string;
}

/** Copy configuration containers without cloning plugin closures or functions. */
export function copyDevConfig<T>(value: T): T {
  if (Array.isArray(value)) return value.map(copyDevConfig) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyDevConfig(item)])) as T;
  }
  return value;
}

/** Rollup resolves input IDs from cwd; Vite's root may be an external project. */
export function resolveDevInput(input: InputOption | undefined, root: string): InputOption | undefined {
  const resolve = (entry: string) => {
    if (path.isAbsolute(entry) || entry.startsWith("\0") || /^[a-z][a-z\d+.-]*:/i.test(entry)) return entry;
    const absolute = path.resolve(root, entry);
    // Keep virtual/bare/alias IDs available to the user's resolver plugins.
    return fs.existsSync(absolute) ? absolute : entry;
  };
  if (typeof input === "string") return resolve(input);
  if (Array.isArray(input)) return input.map(resolve);
  if (input && typeof input === "object") {
    return Object.fromEntries(Object.entries(input).map(([name, entry]) => [name, resolve(entry as string)]));
  }
  return input;
}

async function withoutExtensionPlugin(options: PluginOption[]): Promise<PluginOption[]> {
  const plugins = await Promise.all(options.map(async (option): Promise<PluginOption> => {
    const value = await option;
    if (Array.isArray(value)) return withoutExtensionPlugin(value);
    return value && value.name === "vite-plugin-chrome-extension" ? false : value;
  }));
  return plugins;
}

export function reloadClientSource(connection: ReloadConnection, worker: boolean): string {
  return `/* chrome-extension development auto reload; production builds omit this file. */
(() => {
  const initial = ${JSON.stringify(connection)};
  let revision = initial.revision;
  let session = initial.session;
  let socket;
  let retry;
  let stopped = false;
  ${worker && connection.contentScripts ? `const updateContent = ${contentHmrRuntimeSource(connection.contentScripts)};` : ""}
  const reload = () => ${worker ? "chrome.runtime.reload()" : "location.reload()"};
  const hello = () => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "custom", event: ${JSON.stringify(DEV_HELLO_EVENT)}, data: { revision, session } }));
    }
  };
  const connect = () => {
    if (stopped) return;
    socket = new WebSocket(initial.socketUrl, "vite-hmr");
    socket.addEventListener("open", hello);
    socket.addEventListener("message", (event) => {
      if (stopped) return;
      let payload;
      try { payload = JSON.parse(event.data); } catch { return; }
      if (payload.type !== "custom" || payload.event !== ${JSON.stringify(DEV_RELOAD_EVENT)}) return;
      const next = payload.data;
      if (!next || typeof next.revision !== "number" || !next.session) return;
      if (next.session !== session || next.revision > revision) {
        const sessionChanged = next.session !== session;
        const sameRuntimeAfterRestart = sessionChanged && initial.contentScripts &&
          initial.runtimeSnapshot && next.runtimeSnapshot === initial.runtimeSnapshot;
        const needsExtensionReload = sessionChanged ? !sameRuntimeAfterRestart :
          next.reloadExtension !== false || next.lastExtensionReloadRevision > revision;
        revision = next.revision;
        session = next.session;
        if (!needsExtensionReload) {
          ${worker && connection.contentScripts ? `if (Array.isArray(next.contentScripts)) void updateContent(next.contentScripts);` : ""}
          ${worker ? "return;" : "if (next.contentOnly) return;"}
        }
        stopped = true;
        clearTimeout(retry);
        clearInterval(heartbeat);
        socket.close();
        reload();
      }
    });
    socket.addEventListener("close", () => {
      if (!stopped) retry = setTimeout(async () => {
        try {
          const response = await fetch(initial.httpOrigin + ${JSON.stringify(DEV_STATUS_PATH)}, { cache: "no-store" });
          if (response.ok) {
            const status = await response.json();
            if (status.socketUrl) initial.socketUrl = status.socketUrl;
          }
        } catch {}
        connect();
      }, 1000);
    });
    socket.addEventListener("error", () => socket.close());
  };
  // Chrome 116+ keeps extension service workers alive while WebSocket messages flow.
  const heartbeat = setInterval(hello, 20000);
  connect();
  ${worker ? "" : `addEventListener("pagehide", () => { stopped = true; clearInterval(heartbeat); clearTimeout(retry); socket?.close(); }, { once: true });`}
})();\n`;
}

function appendConnectSource(value: unknown, source: string): string {
  const policy = typeof value === "string" ? value : "script-src 'self'; object-src 'self'";
  const directives = policy.split(";").map((part) => part.trim()).filter(Boolean);
  const index = directives.findIndex((part) => /^connect-src(?:\s|$)/.test(part));
  if (index < 0) {
    const fallback = directives.find((part) => /^default-src(?:\s|$)/.test(part));
    const tokens = fallback
      ? fallback.split(/\s+/).slice(1).filter((token) => token !== "'none'")
      : ["*"];
    directives.push(["connect-src", ...tokens, source].join(" "));
  }
  else {
    const tokens = directives[index].split(/\s+/).filter((token) => token !== "'none'");
    if (!tokens.includes(source)) tokens.push(source);
    directives[index] = tokens.join(" ");
  }
  return `${directives.join("; ")};`;
}

/** Fingerprint only extension registration/runtime inputs, excluding page bundles. */
export function extensionReloadSnapshot(manifest: Manifest, bundle: OutputBundle, publicDir: string | false, managedContent = new Set<number>()): string {
  const snapshotManifest = structuredClone(manifest);
  const managedResources = new Set<string>();
  const collect = (file: string) => {
    if (managedResources.has(file)) return;
    managedResources.add(file);
    const chunk = bundle[file];
    if (chunk?.type !== "chunk") return;
    const metadata = (chunk as typeof chunk & { viteMetadata?: { importedCss?: Set<string>; importedAssets?: Set<string> } }).viteMetadata;
    for (const dependency of [...(chunk.imports || []), ...(chunk.dynamicImports || []), ...(chunk.referencedFiles || []), ...(metadata?.importedCss || []), ...(metadata?.importedAssets || [])]) collect(dependency);
  };
  if (Array.isArray(snapshotManifest.content_scripts)) {
    snapshotManifest.content_scripts.forEach((script, index) => {
      if (!managedContent.has(index)) return;
      for (const entry of [...(script.js || []), ...(script.css || [])]) collect(entry);
      script.js = ["<content-hmr>"];
      delete script.css;
    });
  }
  if (Array.isArray(snapshotManifest.web_accessible_resources)) {
    snapshotManifest.web_accessible_resources = snapshotManifest.web_accessible_resources.map((group) => ({
      ...group,
      resources: Array.isArray(group.resources) ? group.resources.filter((file: string) => !managedResources.has(file)) : group.resources,
    })).filter((group) => group.resources?.length);
  }
  const files = new Map<string, string | Uint8Array>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    const output = bundle[file];
    files.set(file, "");
    if (output?.type === "chunk") {
      files.set(file, output.code);
      for (const dependency of [...(output.imports || []), ...(output.dynamicImports || []), ...(output.referencedFiles || [])]) visit(dependency);
      const metadata = (output as typeof output & { viteMetadata?: { importedCss?: Set<string>; importedAssets?: Set<string> } }).viteMetadata;
      for (const dependency of [...(metadata?.importedCss || []), ...(metadata?.importedAssets || [])]) visit(dependency);
    } else if (output?.type === "asset") files.set(file, output.source);
    else if (publicDir && fs.existsSync(path.join(publicDir, file))) files.set(file, fs.readFileSync(path.join(publicDir, file)));
  };
  const background = manifest.background as { service_worker?: string } | undefined;
  if (background?.service_worker) visit(background.service_worker);
  if (Array.isArray(manifest.content_scripts)) {
    for (const [index, script] of manifest.content_scripts.entries()) {
      if (managedContent.has(index)) continue;
      for (const entry of [...(script.js || []), ...(script.css || [])]) visit(entry);
    }
  }
  const hash = createHash("sha256").update(JSON.stringify(snapshotManifest));
  for (const [file, source] of [...files].sort(([left], [right]) => left.localeCompare(right))) hash.update(file).update(source);
  return hash.digest("hex");
}

/** Track extension pages separately so content updates leave them mounted. */
function extensionPageSnapshot(bundle: OutputBundle): string {
  const files = new Map<string, string | Uint8Array>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    const item = bundle[file];
    if (!item) return;
    files.set(file, item.type === "chunk" ? item.code : item.source);
    if (item.type === "chunk") {
      const metadata = (item as typeof item & { viteMetadata?: { importedCss?: Set<string>; importedAssets?: Set<string> } }).viteMetadata;
      for (const dependency of [...(item.imports || []), ...(item.dynamicImports || []), ...(item.referencedFiles || []), ...(metadata?.importedCss || []), ...(metadata?.importedAssets || [])]) visit(dependency);
    }
  };
  for (const item of Object.values(bundle)) {
    if ((item.type === "asset" && item.fileName.endsWith(".html")) ||
        (item.type === "chunk" && item.isEntry && item.facadeModuleId?.endsWith(".html"))) visit(item.fileName);
  }
  const hash = createHash("sha256");
  for (const [file, source] of [...files].sort(([left], [right]) => left.localeCompare(right))) hash.update(file).update(source);
  return hash.digest("hex");
}

/** Publish a complete successful build, restoring the old directory on failure. */
export function publishDevBuild(staging: string, destination: string): void {
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true });
  const publication = fs.mkdtempSync(path.join(parent, `.${path.basename(destination)}-dev-publish-`));
  const backup = `${publication}-previous`;
  let movedPrevious = false;
  try {
    fs.cpSync(staging, publication, { recursive: true });
    if (fs.existsSync(destination)) {
      fs.renameSync(destination, backup);
      movedPrevious = true;
    }
    try {
      fs.renameSync(publication, destination);
    } catch (error) {
      if (movedPrevious) fs.renameSync(backup, destination);
      throw error;
    }
    if (movedPrevious) fs.rmSync(backup, { recursive: true, force: true });
  } finally {
    fs.rmSync(publication, { recursive: true, force: true });
  }
}

export function createDevOutputPlugin(
  connection: () => ReloadConnection,
  snapshot?: (value: string, entries?: ContentHmrEntry[], pages?: string) => void,
  contentHmr = false,
): Plugin {
  let publicDir: string | false = false;
  let outputDir = "";
  return {
    name: "chrome-extension-dev-output",
    enforce: "post",
    configResolved(config) {
      publicDir = config.publicDir;
      outputDir = path.resolve(config.root, config.build.outDir);
      Object.defineProperty(config, DEV_BUILD, { value: true });
    },
    generateBundle(_options, bundle) {
      const manifestAsset = bundle["manifest.json"];
      if (!manifestAsset || manifestAsset.type !== "asset") {
        throw new Error("[chrome-extension] Development build did not emit manifest.json.");
      }
      const manifest = JSON.parse(String(manifestAsset.source)) as Manifest;
      const originalManifest = structuredClone(manifest);
      const entries = contentHmr ? prepareContentHmr(
        manifest, bundle, publicDir,
        (fileName, source) => { this.emitFile({ type: "asset", fileName, source }); },
        (message) => { this.warn(message); },
      ) : undefined;
      const runtimeSnapshot = extensionReloadSnapshot(originalManifest, bundle, publicDir, new Set(entries?.map((entry) => Number(entry.id.slice("content-".length)))));
      snapshot?.(runtimeSnapshot, entries, extensionPageSnapshot(bundle));
      const current = { ...connection(), ...(entries ? { contentScripts: entries, runtimeSnapshot } : {}) };
      const background = manifest.background as { service_worker?: string; type?: string } | undefined;
      const workerFile = background?.service_worker || DEV_WORKER_FILE;
      for (const reserved of [DEV_CLIENT_FILE, ...(!background?.service_worker ? [DEV_WORKER_FILE] : [])]) {
        if (bundle[reserved] || (publicDir && fs.existsSync(path.join(publicDir, reserved)))) {
          throw new Error(`[chrome-extension] Development output name ${reserved} is reserved. Rename the conflicting source/public file or set liveReload: false.`);
        }
      }
      const worker = bundle[workerFile];
      const workerClient = reloadClientSource(current, true);
      if (worker?.type === "chunk") worker.code += `\n${workerClient}`;
      else if (worker?.type === "asset") worker.source = `${String(worker.source)}\n${workerClient}`;
      else {
        // public/ is copied after generateBundle and is not represented in bundle.
        const publicWorker = publicDir && path.join(publicDir, workerFile);
        const source = publicWorker && fs.existsSync(publicWorker) ? fs.readFileSync(publicWorker, "utf8") : "";
        if (background?.service_worker && !source) {
          throw new Error(`[chrome-extension] Cannot inject development reload into missing worker ${workerFile}.`);
        }
        this.emitFile({ type: "asset", fileName: workerFile, source: `${source}\n${workerClient}` });
      }
      manifest.background = { ...background, service_worker: workerFile };
      const hostPermission = `${current.httpOrigin}/*`;
      const hostPermissions = Array.isArray(manifest.host_permissions) ? manifest.host_permissions : [];
      manifest.host_permissions = [...new Set([...hostPermissions, hostPermission])];
      const csp = manifest.content_security_policy;
      const policy = csp && typeof csp === "object" ? csp as Record<string, unknown> : {};
      manifest.content_security_policy = {
        ...policy,
        extension_pages: appendConnectSource(
          appendConnectSource(policy.extension_pages, new URL(current.socketUrl).origin),
          current.httpOrigin,
        ),
      };
      manifestAsset.source = `${JSON.stringify(manifest, null, 2)}\n`;
      this.emitFile({ type: "asset", fileName: DEV_CLIENT_FILE, source: reloadClientSource(current, false) });
      for (const asset of Object.values(bundle)) {
        if (asset.type !== "asset" || !asset.fileName.endsWith(".html")) continue;
        const source = String(asset.source);
        const relative = path.posix.relative(path.posix.dirname(asset.fileName), DEV_CLIENT_FILE);
        const script = `<script src="${relative}" defer></script>`;
        asset.source = source.includes("</head>") ? source.replace("</head>", `${script}</head>`) : `${script}${source}`;
      }
    },
    writeBundle(outputOptions, bundle) {
      // Vite normally copies public/ before compilation. Defer it until a
      // successful build so syntax errors cannot overwrite an injected worker
      // or otherwise mutate the last known good unpacked extension.
      if (!publicDir || !fs.existsSync(publicDir)) return;
      const destination = outputOptions.dir || outputDir;
      const emitted = new Set(Object.keys(bundle));
      fs.cpSync(publicDir, destination, {
        recursive: true,
        dereference: true,
        filter: (source) => !emitted.has(path.relative(publicDir as string, source).replaceAll(path.sep, "/")),
      });
    },
  };
}

export function resolveReloadConnection(server: ViteDevServer, state: ReloadState): ReloadConnection {
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") {
    throw new Error("[chrome-extension] Auto reload requires Vite's HTTP server; middleware mode is unsupported. Set liveReload: false for web preview only.");
  }
  const hmr = typeof server.config.server.hmr === "object" ? server.config.server.hmr : {};
  const httpProtocol = server.config.server.https ? "https" : "http";
  const listenHost = typeof server.config.server.host === "string" &&
    !["0.0.0.0", "::"].includes(server.config.server.host)
    ? server.config.server.host
    : "localhost";
  const hostname = hmr.host || listenHost;
  const urlHost = (host: string) => host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const port = hmr.clientPort || hmr.port || address.port;
  const wsProtocol = hmr.protocol || (server.config.server.https ? "wss" : "ws");
  const pathname = hmr.path ? path.posix.join(server.config.base, hmr.path) : server.config.base;
  const socketUrl = new URL(`${wsProtocol}://${urlHost(hostname)}:${port}${pathname}`);
  if (server.config.webSocketToken) socketUrl.searchParams.set("token", server.config.webSocketToken);
  return { socketUrl: socketUrl.href, httpOrigin: `${httpProtocol}://${urlHost(listenHost)}:${address.port}`, session: state.session, revision: state.revision + 1 };
}

/** A build-backed development extension; no remotely hosted extension JavaScript. */
export async function configureExtensionDevServer(
  server: ViteDevServer,
  originalConfig: UserConfig,
  options: ChromeExtensionOptions,
  manifest: Manifest,
  createExtensionPlugin: (options: ChromeExtensionOptions) => Plugin,
): Promise<() => Promise<void>> {
  const state: ReloadState = { session: randomUUID(), revision: 0, building: false, error: null, outDir: path.resolve(server.config.root, server.config.build.outDir) };
  const relativeRoot = path.relative(state.outDir, server.config.root);
  if (!relativeRoot || !relativeRoot.startsWith("..")) {
    throw new Error("[chrome-extension] Development build.outDir must not be the project root or one of its parent directories.");
  }
  const stagingRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chrome-extension-dev-")));
  const staging = path.join(stagingRoot, "output");
  fs.mkdirSync(staging);
  let watcher: RollupWatcher | undefined;
  let closed = false;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let restarting = Promise.resolve();
  let successfulSnapshot: string | undefined;
  let pendingSnapshots: string[] = [];
  let pendingPageSnapshots: string[] = [];
  let successfulPageSnapshot: string | undefined;
  let successfulContentSnapshot: string | undefined;
  let forceExtensionReload = false;
  const sendState = (_data?: unknown, client?: { send(event: string, data: unknown): void }) => {
    if (!state.revision || state.building || state.error) return;
    const payload = {
      revision: state.revision,
      session: state.session,
      reloadExtension: state.reloadExtension,
      lastExtensionReloadRevision: state.lastExtensionReloadRevision,
      contentScripts: state.contentScripts,
      runtimeSnapshot: state.runtimeSnapshot,
      contentOnly: state.contentOnly,
    };
    if (client) client.send(DEV_RELOAD_EVENT, payload);
    else server.ws.send(DEV_RELOAD_EVENT, payload);
  };
  server.ws.on(DEV_HELLO_EVENT, sendState);
  server.middlewares.use((request, response, next) => {
    if (request.url?.split("?")[0] !== DEV_STATUS_PATH) return next();
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    const origin = request.headers.origin;
    if (origin && /^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
    }
    response.end(JSON.stringify({ ...state, socketUrl: resolveReloadConnection(server, state).socketUrl }));
  });
  const start = async () => {
    if (closed) return;
    const loaded = server.config.configFile
      ? await loadConfigFromFile({ command: "serve", mode: server.config.mode }, server.config.configFile, server.config.root)
      : undefined;
    const config = loaded ? mergeConfig(loaded.config, server.config.inlineConfig) : copyDevConfig(originalConfig);
    const plugins = await withoutExtensionPlugin(config.plugins || []);
    const userOutput = config.build?.rollupOptions?.output;
    const stagedOutput = (output: OutputOptions | undefined): OutputOptions => ({
      ...output,
      dir: staging,
      file: undefined,
    });
    const inline: InlineConfig = {
      ...config,
      configFile: false,
      root: fs.existsSync(server.config.root) ? fs.realpathSync(server.config.root) : server.config.root,
      mode: server.config.mode,
      plugins: [...plugins, createExtensionPlugin({ ...options, manifest, liveReload: false }), createDevOutputPlugin(
        () => resolveReloadConnection(server, state),
        (value, entries, pages) => { pendingSnapshots.push(value); pendingPageSnapshots.push(pages || ""); state.contentScripts = entries; },
        !Array.isArray(options.contentScripts) && options.contentScripts?.hmr === true && options.contentScripts.standalone !== false,
      )],
      build: {
        ...config.build,
        rollupOptions: {
          ...config.build?.rollupOptions,
          input: resolveDevInput(config.build?.rollupOptions?.input, server.config.root),
          output: Array.isArray(userOutput)
            ? userOutput.map(stagedOutput)
            : stagedOutput(userOutput),
        },
        outDir: staging,
        watch: {},
        minify: false,
        emptyOutDir: true,
        copyPublicDir: false,
        write: true,
      },
    };
    const result = await build(inline);
    if (!("on" in result)) throw new Error("[chrome-extension] Expected a Vite build watcher.");
    watcher = result;
    watcher.on("event", (event) => {
      if (closed) return;
      if (event.code === "START") { state.building = true; state.error = null; pendingSnapshots = []; pendingPageSnapshots = []; }
      if (event.code === "ERROR") { state.building = false; state.error = event.error.message; }
      if (event.code === "END" && !state.error) {
        state.building = false;
        try {
          publishDevBuild(staging, state.outDir);
        } catch (error) {
          state.error = `Cannot publish development extension: ${String(error)}`;
          server.config.logger.error(`[chrome-extension] ${state.error}`);
          return;
        }
        const snapshot = JSON.stringify(pendingSnapshots);
        state.runtimeSnapshot = pendingSnapshots.length === 1 ? pendingSnapshots[0] : snapshot;
        const pages = JSON.stringify(pendingPageSnapshots);
        const content = JSON.stringify(state.contentScripts);
        const pagesChanged = successfulPageSnapshot !== pages;
        const contentChanged = successfulContentSnapshot !== content;
        state.reloadExtension = forceExtensionReload || successfulSnapshot === undefined || successfulSnapshot !== snapshot ||
          (contentChanged && pagesChanged && successfulContentSnapshot !== undefined);
        state.contentOnly = Boolean(state.contentScripts?.length) && contentChanged && !pagesChanged && !state.reloadExtension;
        successfulSnapshot = snapshot;
        successfulPageSnapshot = pages;
        successfulContentSnapshot = content;
        forceExtensionReload = false;
        state.revision += 1;
        if (state.reloadExtension) state.lastExtensionReloadRevision = state.revision;
        if (state.revision === 1) {
          server.config.logger.info(`[chrome-extension] Development extension ready: load unpacked ${state.outDir}. Auto reload is active (Chrome 116+).`);
        }
        sendState();
      }
    });
    if (closed) await watcher.close();
  };
  const scheduleRestart = (file: string) => {
    const relative = path.relative(server.config.root, file);
    const inPublic = server.config.publicDir && !path.relative(server.config.publicDir, file).startsWith("..");
    const newPage = relative.startsWith(`${options.pageRoot || "modules"}${path.sep}`) && path.basename(file) === "index.html";
    if (!inPublic && !newPage) return;
    if (inPublic) forceExtensionReload = true;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restarting = restarting.then(async () => {
        await watcher?.close();
        await start();
      }).catch((error: unknown) => { state.error = String(error); server.config.logger.error(`[chrome-extension] ${String(error)}`); });
    }, 80);
  };
  server.watcher.on("add", scheduleRestart);
  server.watcher.on("unlink", scheduleRestart);
  const publicChange = (file: string) => {
    if (server.config.publicDir && !path.relative(server.config.publicDir, file).startsWith("..")) scheduleRestart(file);
  };
  server.watcher.on("change", publicChange);
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () => {
    cleanupPromise ||= (async () => {
      closed = true;
      clearTimeout(restartTimer);
      server.httpServer?.off("listening", launch);
      server.ws.off(DEV_HELLO_EVENT, sendState);
      server.watcher.off("add", scheduleRestart);
      server.watcher.off("unlink", scheduleRestart);
      server.watcher.off("change", publicChange);
      await restarting;
      await watcher?.close();
      fs.rmSync(stagingRoot, { recursive: true, force: true });
    })();
    return cleanupPromise;
  };
  server.httpServer?.once("close", () => { void cleanup(); });
  const launch = () => {
    restarting = restarting.then(start).catch((error: unknown) => {
      state.error = String(error);
      server.config.logger.error(`[chrome-extension] ${String(error)}`);
    });
  };
  if (server.httpServer?.listening) launch();
  else server.httpServer?.once("listening", launch);
  return cleanup;
}
