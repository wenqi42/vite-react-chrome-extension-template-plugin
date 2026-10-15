#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import { manifestReferenceEntries, validateManifest, type Manifest } from "./index.js";

export interface DoctorOptions {
  root?: string;
  dist?: string;
  devUrl?: string;
  cdp?: string;
  extensionId?: string;
  timeoutMs?: number;
}
export interface DoctorIssue {
  code: string;
  level: "error" | "warning";
  message: string;
  hint: string;
  field?: string;
  file?: string;
}
export interface DoctorPermissions {
  actual: string[];
  explicit: string[] | null;
  inferred: Array<{ permission: string; sources: Array<{ file: string; api: string }> }>;
  autoPermissions: boolean | null;
  hostPermissions: string[];
}
export interface DoctorReport {
  ok: boolean;
  issues: DoctorIssue[];
  permissions: DoctorPermissions;
  checks: Array<{ id: string; status: "pass" | "fail" | "skipped"; message: string }>;
}
const object = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const errorMessage = (value: unknown) => value instanceof Error ? value.message : String(value);

async function filesIn(directory: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await filesIn(path.join(directory, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}
function localReference(value: string) {
  if (!value || /^(?:[a-z][\w+.-]*:|\/\/|#|<)/i.test(value)) return null;
  try {
    return decodeURIComponent(value.split(/[?#]/)[0]);
  } catch {
    return value.split(/[?#]/)[0];
  }
}
function existsReference(reference: string, owner: string, files: Set<string>) {
  const local = localReference(reference);
  if (local === null) return true;
  const normalized = path.posix.normalize(local.startsWith("/") ? local.slice(1) : path.posix.join(path.posix.dirname(owner), local));
  if (!normalized.includes("*")) return files.has(normalized);
  const pattern = normalized.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return [...files].some((file) => new RegExp(`^${pattern}$`).test(file));
}
function sourceReferences(code: string, file: string): string[] {
  if (/\.html?$/i.test(file)) {
    return [...code.matchAll(/<(?:script|link|img|iframe|source|video|audio)\b[^>]*?\b(?:src|href|poster)\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]);
  }
  if (/\.css$/i.test(file)) {
    return [...code.matchAll(/(?:url\(\s*|@import\s*)["']?([^"')\s;]+)["']?\s*\)?/g)].map((match) => match[1]);
  }
  if (!/\.[cm]?js$/i.test(file)) return [];
  const ast = parse(code, { sourceType: "unambiguous", allowReturnOutsideFunction: true });
  const refs = new Set<string>();
  const walk = (value: unknown): void => {
    if (!object(value)) return;
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(value.type) && value.source?.value) refs.add(value.source.value);
    if (value.type === "CallExpression" &&
      (value.callee?.type === "Import" || value.callee?.name === "importScripts")) {
      for (const argument of value.arguments || []) if (argument.type === "StringLiteral") refs.add(argument.value);
    }
    if (value.type === "NewExpression" && value.callee?.name === "URL" &&
      value.arguments?.[0]?.type === "StringLiteral" && value.arguments?.[1]?.type === "MemberExpression" &&
      value.arguments[1].object?.type === "MetaProperty") refs.add(value.arguments[0].value);
    for (const [key, child] of Object.entries(value)) {
      if (["loc", "start", "end"].includes(key)) continue;
      if (Array.isArray(child)) child.forEach(walk);
      else walk(child);
    }
  };
  walk(ast);
  return [...refs];
}
async function jsonRequest(url: string, timeout: number): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeout}ms`)), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status} at ${url}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

class DoctorCdp {
  private sequence = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  events: Array<{ method: string; params: any; sessionId?: string }> = [];
  constructor(private socket: WebSocket, private timeout: number) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (typeof message.id !== "number") { this.events.push(message); return; }
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
    socket.addEventListener("close", () => this.rejectAll());
  }
  private rejectAll() {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("CDP connection closed"));
    }
    this.pending.clear();
  }
  static async connect(url: string, timeout: number) {
    if (typeof WebSocket === "undefined") throw new Error("CDP diagnostics require Node.js 22+ with built-in WebSocket");
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error("CDP connection timed out")); }, timeout);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Unable to connect to Chrome CDP")); }, { once: true });
    });
    return new DoctorCdp(socket, timeout);
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  close() { this.rejectAll(); this.socket.close(); }
}

export async function diagnoseExtension(options: DoctorOptions = {}): Promise<DoctorReport> {
  const root = path.resolve(options.root || process.cwd());
  const dist = path.resolve(root, options.dist || "dist");
  const timeout = Number.isFinite(options.timeoutMs) && options.timeoutMs! > 0 ? options.timeoutMs! : 3000;
  const report: DoctorReport = {
    ok: true, issues: [], checks: [],
    permissions: { actual: [], explicit: null, inferred: [], autoPermissions: null, hostPermissions: [] },
  };
  const issue = (code: string, level: DoctorIssue["level"], message: string, hint: string, location: { field?: string; file?: string } = {}) =>
    report.issues.push({ code, level, message, hint, ...location });
  const check = (id: string, before: number, message: string) => report.checks.push({
    id, status: report.issues.slice(before).some((entry) => entry.level === "error") ? "fail" : "pass", message,
  });
  let manifest: Manifest = {};
  const staticStart = report.issues.length;
  try {
    const loaded: unknown = JSON.parse(await fs.readFile(path.join(dist, "manifest.json"), "utf8"));
    if (!object(loaded)) throw new Error("Manifest must be an object");
    manifest = loaded;
    try { validateManifest(manifest); }
    catch (error) { issue("MANIFEST_INVALID", "error", errorMessage(error), "Correct the named Manifest V3 field and rebuild.", { file: "manifest.json" }); }
    const files = new Set(await filesIn(dist));
    for (const reference of manifestReferenceEntries(manifest)) {
      if (!existsReference(reference.value, "manifest.json", files)) issue("RESOURCE_MISSING", "error", `Missing resource "${reference.value}".`, "Correct the path or include the file in the build output.", { field: reference.field, file: "manifest.json" });
    }
    if (object(manifest.sandbox)) for (const page of strings(manifest.sandbox.pages)) {
      if (!existsReference(page, "manifest.json", files)) issue("RESOURCE_MISSING", "error", `Missing sandbox page "${page}".`, "Include the sandbox page in the build output.", { field: "manifest.sandbox.pages", file: "manifest.json" });
    }
    for (const file of files) {
      if (!/\.(?:html?|css|[cm]?js)$/i.test(file)) continue;
      try {
        for (const reference of sourceReferences(await fs.readFile(path.join(dist, file), "utf8"), file)) {
          if (!existsReference(reference, file, files)) issue("RESOURCE_MISSING", "error", `Missing resource "${reference}" referenced by ${file}.`, "Correct the relative URL or include the referenced file.", { file });
        }
      } catch (error) {
        issue("SOURCE_INVALID", "error", `Cannot inspect ${file}: ${errorMessage(error)}`, "Correct the generated JavaScript syntax and rebuild.", { file });
      }
    }
    const policy = manifest.content_security_policy;
    const csp = object(policy) ? policy.extension_pages : typeof policy === "string" ? policy : undefined;
    if (typeof csp === "string") {
      const directives = new Map(csp.split(";").map((directive) => {
        const [key, ...values] = directive.trim().split(/\s+/);
        return [key, values] as const;
      }));
      for (const directive of ["script-src", "script-src-elem", "worker-src"]) {
        const values = directives.get(directive) || (directive === "script-src" ? directives.get("default-src") : undefined);
        if (values?.some((value) => !["'self'", "'none'", "'wasm-unsafe-eval'"].includes(value) && !/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/?$/.test(value))) {
          issue("CSP_INVALID", "error", `Invalid MV3 extension_pages CSP ${directive}: ${values.join(" ")}`, "Use self-hosted scripts and the MV3 minimum CSP; keep sandbox policy in content_security_policy.sandbox.", { field: "manifest.content_security_policy.extension_pages", file: "manifest.json" });
        }
      }
    }
    report.permissions.actual = strings(manifest.permissions);
    report.permissions.hostPermissions = strings(manifest.host_permissions);
    try {
      const evidence = JSON.parse(await fs.readFile(path.join(dist, "chrome-extension-diagnostics.json"), "utf8"));
      const permissions = object(evidence) ? evidence.permissions : undefined;
      const named = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
      if (evidence?.version !== 1 || !object(permissions) ||
        !Array.isArray(permissions.explicit) || !permissions.explicit.every(named) ||
        typeof permissions.autoPermissions !== "boolean" || !Array.isArray(permissions.inferred) ||
        !permissions.inferred.every((entry: unknown) => object(entry) && named(entry.permission) &&
          Array.isArray(entry.sources) && entry.sources.every((source: unknown) =>
            object(source) && named(source.file) && named(source.api)))) {
        throw new Error("Unsupported or incomplete build provenance");
      }
      report.permissions.explicit = permissions.explicit;
      report.permissions.autoPermissions = permissions.autoPermissions;
      report.permissions.inferred = permissions.inferred;
    } catch (error) {
      issue("PERMISSION_PROVENANCE_UNAVAILABLE", "warning", `Permission source evidence unavailable: ${errorMessage(error)}`, "Rebuild with the current plugin to generate chrome-extension-diagnostics.json; host permissions remain manually configured.");
    }
  } catch (error) {
    issue("MANIFEST_UNREADABLE", "error", `Cannot read manifest.json: ${errorMessage(error)}`, "Build the extension and point --dist at its output directory.", { file: "manifest.json" });
  }
  check("static", staticStart, `Checked Manifest V3 and local resources in ${dist}; common checks, not a complete Chrome schema validation.`);

  if (options.devUrl) {
    const start = report.issues.length;
    try {
      const url = new URL(options.devUrl);
      if (url.pathname === "/") url.pathname = "/__chrome_extension_dev_status__";
      const state = await jsonRequest(url.href, timeout);
      if (!object(state) || typeof state.revision !== "number" || typeof state.building !== "boolean") throw new Error("Invalid dev status response; expected revision and building fields");
      if (state.error) issue("DEV_BUILD_FAILED", "error", `Development build failed: ${String(state.error)}`, "Fix the reported build error and wait for a successful revision.");
      if (typeof state.outDir !== "string" || path.resolve(root, state.outDir) !== dist) issue("DEV_OUTDIR_MISMATCH", "error", `Development output directory ${String(state.outDir)} does not match ${dist}.`, "Point --dist at the dev status outDir or correct the Vite output directory.");
      check("dev", start, `Connected to ${url.href}: revision=${state.revision}, building=${state.building}, outDir=${String(state.outDir)}, socketUrl=${String(state.socketUrl || "not reported")}`);
    } catch (error) {
      issue("DEV_UNREACHABLE", "error", `Development service unavailable: ${errorMessage(error)}`, "Start vite dev, check --dev-url and retry; increase --timeout-ms for slow services.");
      check("dev", start, "Development status request failed.");
    }
  } else report.checks.push({ id: "dev", status: "skipped", message: "Development diagnostics not requested; pass --dev-url." });
  if (options.cdp) {
    const start = report.issues.length;
    let cdp: DoctorCdp | undefined;
    let ownTarget: string | undefined;
    const sessions: string[] = [];
    try {
      if (!options.extensionId || !/^[a-p]{32}$/.test(options.extensionId)) throw new Error("A valid --extension-id is required for CDP diagnostics");
      const endpoint = options.cdp.startsWith("ws") ? options.cdp : (await jsonRequest(new URL("/json/version", options.cdp).href, timeout)).webSocketDebuggerUrl;
      if (typeof endpoint !== "string") throw new Error("Chrome did not report a browser WebSocket endpoint");
      cdp = await DoctorCdp.connect(endpoint, timeout);
      const browser = await cdp.send("Browser.getVersion");
      const { targetId } = await cdp.send("Target.createTarget", { url: "chrome://extensions/" });
      ownTarget = targetId;
      const manager = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
      sessions.push(manager.sessionId);
      await cdp.send("Runtime.enable", {}, manager.sessionId);
      const result = await cdp.send("Runtime.evaluate", {
        expression: `new Promise((resolve,reject)=>{const attempt=()=>{if(!globalThis.chrome?.developerPrivate){reject(new Error("Chrome extension diagnostics API unavailable"));return;}chrome.developerPrivate.getExtensionsInfo({includeDisabled:true,includeTerminated:true},info=>{if(chrome.runtime.lastError)reject(new Error(chrome.runtime.lastError.message));else resolve(info);});};if(document.readyState==="complete")attempt();else addEventListener("load",attempt,{once:true});})`,
        awaitPromise: true, returnByValue: true,
      }, manager.sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Chrome extension inventory failed");
      const extensions = result.result?.value;
      if (!Array.isArray(extensions)) throw new Error("Chrome extension inventory unavailable");
      const extension = extensions.find((entry: any) => entry.id === options.extensionId);
      if (!extension || extension.state !== "ENABLED") issue("EXTENSION_NOT_LOADED", "error", `Extension ${options.extensionId} is not enabled in Chrome.`, "Load the unpacked --dist directory in chrome://extensions with Developer mode enabled.");
      else {
        for (const error of [...(extension.manifestErrors || []), ...(extension.runtimeErrors || [])]) issue("CHROME_EXTENSION_ERROR", "error", `${error.message || error.description || JSON.stringify(error)}`, "Open the extension Errors panel, correct this runtime/CSP/registration error and reload the extension.");
        const { targetInfos } = await cdp.send("Target.getTargets");
        const contexts = targetInfos.filter((target: any) => target.url.startsWith(`chrome-extension://${options.extensionId}/`));
        const worker = contexts.find((target: any) => target.type === "service_worker");
        if (object(manifest.background) && !worker) issue("WORKER_UNAVAILABLE", "error", "Declared service worker has no active Chrome runtime context; registration or startup could not be verified.", "Open the extension service worker from chrome://extensions, inspect registration errors and rerun doctor while it is active.");
        for (const context of contexts) {
          const attached = await cdp.send("Target.attachToTarget", { targetId: context.targetId, flatten: true });
          sessions.push(attached.sessionId);
          await cdp.send("Runtime.enable", {}, attached.sessionId);
          await cdp.send("Log.enable", {}, attached.sessionId);
          const evaluated = await cdp.send("Runtime.evaluate", { expression: "({ id: chrome.runtime.id, manifest: chrome.runtime.getManifest() })", returnByValue: true }, attached.sessionId);
          if (evaluated.exceptionDetails || evaluated.result?.value?.id !== options.extensionId) issue("CONTEXT_UNAVAILABLE", "error", `Cannot evaluate extension ${context.type} ${context.url}.`, "Inspect this extension context for loading, CSP or runtime failures.");
        }
        for (const event of cdp.events) {
          if (event.sessionId === manager.sessionId) continue;
          if (event.method === "Runtime.exceptionThrown" ||
            event.method === "Log.entryAdded" && event.params.entry.level === "error") {
            const detail = event.params.exceptionDetails;
            issue("CHROME_RUNTIME_ERROR", "error", detail?.exception?.description || detail?.text || event.params.entry.text, "Correct the reported JavaScript/CSP error and reload the extension.");
          }
        }
        report.checks.push({ id: "contexts", status: contexts.length ? "pass" : "skipped", message: `Chrome ${browser.product}: ${contexts.map((context: any) => `${context.type} ${context.url}`).join(", ") || "No active extension contexts; extension inventory inspected."}` });
      }
    } catch (error) {
      issue("CDP_UNAVAILABLE", "error", `Chrome CDP diagnostics failed: ${errorMessage(error)}`, "Launch Chrome for Testing with remote debugging, verify --cdp and --extension-id, and use Node.js 22+.");
    } finally {
      if (cdp) {
        for (const sessionId of sessions) await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
        if (ownTarget) await cdp.send("Target.closeTarget", { targetId: ownTarget }).catch(() => {});
        cdp.close();
      }
    }
    check("runtime", start, "Read Chrome extension inventory and available runtime contexts; no existing tabs or extension configuration changed.");
  } else report.checks.push({ id: "runtime", status: "skipped", message: "Chrome runtime diagnostics not requested; pass --cdp and --extension-id." });
  report.ok = !report.issues.some((entry) => entry.level === "error");
  return report;
}

async function doctorCommand(args: string[], write: (text: string) => void): Promise<number> {
  if (args.includes("--help")) {
    write("chrome-extension-doctor [--root project] [--dist directory] [--json] [--dev-url origin] [--cdp endpoint --extension-id id] [--timeout-ms 3000]\nStatic and dev checks require Node.js 18+; CDP requires Node.js 22+.");
    return 0;
  }
  const allowed = new Set(["--root", "--dist", "--dev-url", "--cdp", "--extension-id", "--timeout-ms", "--json"]);
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    if (!allowed.has(args[i])) throw new Error(`Unknown option ${args[i]}`);
    if (args[i] === "--json") continue;
    if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`Missing value for ${args[i]}`);
    values.set(args[i], args[++i]);
  }
  const timeout = values.has("--timeout-ms") ? Number(values.get("--timeout-ms")) : undefined;
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) throw new Error("--timeout-ms requires a positive finite number");
  const report = await diagnoseExtension({
    root: values.get("--root"), dist: values.get("--dist"), devUrl: values.get("--dev-url"),
    cdp: values.get("--cdp"), extensionId: values.get("--extension-id"),
    timeoutMs: timeout,
  });
  if (args.includes("--json")) write(JSON.stringify(report, null, 2));
  else {
    write(`Extension Doctor: ${report.ok ? "PASS" : "FAIL"}`);
    for (const entry of report.checks) write(`[${entry.status}] ${entry.id}: ${entry.message}`);
    for (const entry of report.issues) write(`[${entry.level}] ${entry.code}: ${entry.message}\n  Fix: ${entry.hint}`);
    write(`Permissions: ${report.permissions.actual.join(", ") || "(none)"}; host permissions are manually configured.`);
  }
  return report.ok ? 0 : 1;
}

/** Run the CLI with explicit arguments and output, without changing process state. */
export async function runDoctorCli(args: string[], write: (text: string) => void = console.log): Promise<number> {
  try {
    return await doctorCommand(args, write);
  } catch (error) {
    const report: DoctorReport = { ok: false, issues: [{ code: "CLI_INVALID", level: "error", message: errorMessage(error), hint: "Run chrome-extension-doctor --help for supported arguments." }], checks: [], permissions: { actual: [], explicit: null, inferred: [], autoPermissions: null, hostPermissions: [] } };
    write(args.includes("--json") ? JSON.stringify(report, null, 2) : `Extension Doctor: FAIL\n${errorMessage(error)}`);
    return 1;
  }
}
if (process.argv[1] && await fs.realpath(process.argv[1]).catch(() => null) ===
    await fs.realpath(fileURLToPath(import.meta.url))) {
  process.exitCode = await runDoctorCli(process.argv.slice(2));
}
