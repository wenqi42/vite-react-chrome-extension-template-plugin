import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { OutputBundle } from "rollup";
import type { Manifest } from "./index.js";
import { parse } from "@babel/parser";

export interface ContentHmrEntry {
  id: string;
  js: string[];
  css: string;
  hash: string;
  matches: string[];
  excludeMatches: string[];
  includeGlobs: string[];
  excludeGlobs: string[];
  world: "ISOLATED" | "MAIN";
  allFrames: boolean;
}

export const CONTENT_HMR_MARKER = "chrome-extension:content-script-versions";
export const CONTENT_HMR_READY = "chrome-extension:content-script-ready";

/** Prepare stable, local Chrome content-script files for a development build. */
export function prepareContentHmr(
  manifest: Manifest,
  bundle: OutputBundle,
  publicDir: string | false,
  emit: (fileName: string, source: string) => void,
  warn: (message: string) => void,
): ContentHmrEntry[] {
  const entries: ContentHmrEntry[] = [];
  const registrations = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
  const bridges: Record<string, unknown>[] = [];
  const read = (file: string): string | undefined => {
    const item = bundle[file];
    if (item?.type === "chunk") return item.code;
    if (item?.type === "asset") return typeof item.source === "string" ? item.source : new TextDecoder().decode(item.source);
    const absolute = publicDir && path.join(publicDir, file);
    return absolute && fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8") : undefined;
  };
  registrations.forEach((registration, index) => {
    const js = Array.isArray(registration.js) ? registration.js : [];
    const css = new Set<string>(Array.isArray(registration.css) ? registration.css : []);
    const visited = new Set<string>();
    const collectStyles = (file: string) => {
      if (visited.has(file)) return;
      visited.add(file);
      const chunk = bundle[file];
      if (chunk?.type !== "chunk") return;
      const metadata = (chunk as typeof chunk & { viteMetadata?: { importedCss?: Set<string> } }).viteMetadata;
      for (const stylesheet of metadata?.importedCss || []) css.add(stylesheet);
      for (const dependency of chunk.imports) collectStyles(dependency);
    };
    js.forEach(collectStyles);
    const sources = js.map((file: string) => read(file));
    const styles = [...css].map((file) => read(file)?.replace(
      /url\(\s*(["']?)([^"')]+)\1\s*\)/g,
      (original, quote: string, url: string) => {
        if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#|<)/i.test(url)) return original;
        const asset = url.startsWith("/") ? url.slice(1) : path.posix.normalize(path.posix.join(path.posix.dirname(file), url));
        return `url(${quote}__CHROME_EXTENSION_ASSET__/${asset}${quote})`;
      },
    ));
    // Entries whose loading semantics cannot be reproduced remain on the
    // existing full-reload path instead of pretending they support HMR.
    if (sources.some((source: string | undefined) => source === undefined ||
        parse(source, { sourceType: "module" }).program.body.some((node) => node.type === "ImportDeclaration" || node.type.startsWith("Export"))) ||
        styles.some((source: string | undefined) => source === undefined) ||
        (js.length > 0 && !js.some((file: string) => {
          const chunk = bundle[file];
          return chunk?.type === "chunk" && (chunk as typeof chunk & { contentHmrLifecycle?: boolean }).contentHmrLifecycle;
        })) ||
        registration.match_origin_as_fallback || registration.match_about_blank) {
      warn(`[chrome-extension] Content HMR cannot safely update content_scripts[${index}]. Use defineContentScript from @vite-react-chrome-extension/plugin/client in an active source entry/dependency and standalone output; about:blank/origin fallback entries are unsupported. Retaining full reload for this entry.`);
      return;
    }
    const id = `content-${index}`;
    const files = sources.map((source: string, fileIndex: number) => {
      const file = `chrome-extension-content-${index}-${fileIndex}.js`;
      emit(file, source);
      return file;
    });
    const hash = createHash("sha256").update(sources.join("\n")).digest("hex");
    const initial = `chrome-extension-content-${index}-initial.js`;
    emit(initial, `(() => { const key = Symbol.for(${JSON.stringify(CONTENT_HMR_MARKER)}); const versions = globalThis[key] ||= {}; versions[${JSON.stringify(id)}] = ${JSON.stringify(hash)}; })();\n`);
    registration.js = [...files, initial];
    delete registration.css;
    const bridge = `chrome-extension-content-${index}-bridge.js`;
    emit(bridge, `chrome.runtime.sendMessage({ type: ${JSON.stringify(CONTENT_HMR_READY)}, id: ${JSON.stringify(id)} }).catch(error => console.warn("[chrome-extension] Content HMR connection unavailable:", error.message));\n`);
    bridges.push({ ...registration, world: "ISOLATED", js: [bridge] });
    entries.push({
      id,
      js: files,
      css: styles.join("\n"),
      hash,
      matches: registration.matches || [],
      excludeMatches: registration.exclude_matches || [],
      includeGlobs: registration.include_globs || [],
      excludeGlobs: registration.exclude_globs || [],
      world: registration.world === "MAIN" ? "MAIN" : "ISOLATED",
      allFrames: registration.all_frames === true,
    });
  });
  manifest.content_scripts = [...registrations, ...bridges];
  if (entries.length) {
    manifest.permissions = [...new Set([...(manifest.permissions || []), "scripting"])];
    manifest.host_permissions = [...new Set([
      ...(Array.isArray(manifest.host_permissions) ? manifest.host_permissions : []),
      ...entries.flatMap((entry) => entry.matches),
    ])];
  }
  return entries;
}

/**
 * Serialized into the extension worker; all JavaScript stays in local files.
 * CSS is injected by Chrome so the host's style CSP cannot disable updates.
 */
export function createContentHmrRuntime(initial: ContentHmrEntry[]) {
  const browser = (globalThis as typeof globalThis & { chrome: any }).chrome;
  let entries = initial;
  let pending = Promise.resolve();
  const appliedCss = new Map<string, string>();
  const glob = (pattern: string, value: string) =>
    new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("?", ".")).join(".*")}$`).test(value);
  const matchPattern = (pattern: string, value: string) => {
    if (pattern === "<all_urls>") return /^(https?|file|ftp):/.test(value);
    const match = /^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)$/.exec(pattern);
    if (!match) return false;
    let url: URL;
    try { url = new URL(value); } catch { return false; }
    const [, scheme, host, pathname] = match;
    if (scheme === "*" ? !/^https?:$/.test(url.protocol) : url.protocol !== `${scheme}:`) return false;
    if (host !== "*" && !(host.startsWith("*.") ? url.hostname === host.slice(2) || url.hostname.endsWith(host.slice(1)) : url.host === host || url.hostname === host)) return false;
    return glob(pathname, `${url.pathname}${url.search}`);
  };
  const applies = (entry: ContentHmrEntry, url: string) =>
    entry.matches.some((pattern) => matchPattern(pattern, url)) &&
    !entry.excludeMatches.some((pattern) => matchPattern(pattern, url)) &&
    (!entry.includeGlobs.length || entry.includeGlobs.some((pattern) => glob(pattern, url))) &&
    !entry.excludeGlobs.some((pattern) => glob(pattern, url));
  const apply = async (onlyTab?: number, onlyFrame?: number, onlyId?: string) => {
    const tabs = onlyTab === undefined ? await browser.tabs.query({}) : [{ id: onlyTab }];
    for (const tab of tabs) {
      if (typeof tab.id !== "number") continue;
      for (const entry of entries) {
        if (onlyId && entry.id !== onlyId) continue;
        if (onlyFrame !== undefined && onlyFrame !== 0 && !entry.allFrames) continue;
        const target = onlyFrame !== undefined
          ? { tabId: tab.id, frameIds: [onlyFrame] }
          : entry.allFrames ? { tabId: tab.id, allFrames: true } : { tabId: tab.id, frameIds: [0] };
        let frames: any[];
        try {
          frames = await browser.scripting.executeScript({
            target,
            world: entry.world,
            func: (id: string) => ({
              url: location.href,
              hash: (globalThis as any)[Symbol.for("chrome-extension:content-script-versions")]?.[id],
            }),
            args: [entry.id],
          });
        } catch { continue; /* Restricted and unrelated tabs are expected. */ }
        for (const frame of frames) {
          if (!frame.result || !applies(entry, frame.result.url)) continue;
          const documentTarget = frame.documentId
            ? { tabId: tab.id, documentIds: [frame.documentId] }
            : { tabId: tab.id, frameIds: [frame.frameId] };
          if (frame.result.hash !== entry.hash && entry.js.length) {
            await browser.scripting.executeScript({ target: documentTarget, world: entry.world, files: entry.js });
            await browser.scripting.executeScript({
              target: documentTarget,
              world: entry.world,
              func: (id: string, hash: string) => {
                const key = Symbol.for("chrome-extension:content-script-versions");
                const versions = (globalThis as any)[key] ||= {};
                versions[id] = hash;
              },
              args: [entry.id, entry.hash],
            });
          }
          const key = `${tab.id}:${frame.documentId || frame.frameId}:${entry.id}`;
          const css = entry.css.replace(/__CHROME_EXTENSION_ASSET__\/([^"')\s]+)/g, (_match, asset: string) => browser.runtime.getURL(asset));
          const previous = appliedCss.get(key);
          if (previous !== css) {
            if (css) await browser.scripting.insertCSS({ target: documentTarget, css });
            if (previous) await browser.scripting.removeCSS({ target: documentTarget, css: previous });
            appliedCss.set(key, css);
          }
        }
      }
    }
  };
  const enqueue = (task: () => Promise<void>) => {
    const result = pending.then(task);
    pending = result.catch((error: unknown) => console.error("[chrome-extension] Content HMR update failed:", error));
    return result;
  };
  browser.runtime.onMessage.addListener((message: any, sender: any, respond: (response: unknown) => void) => {
    if (message?.type !== "chrome-extension:content-script-ready" || sender.tab?.id === undefined) return;
    void enqueue(() => apply(sender.tab.id, sender.frameId || 0, message.id)).then(
      () => respond({ ok: true }),
      (error: unknown) => respond({ ok: false, error: String(error) }),
    );
    return true;
  });
  browser.tabs.onRemoved.addListener((tabId: number) => {
    for (const key of appliedCss.keys()) if (key.startsWith(`${tabId}:`)) appliedCss.delete(key);
  });
  return (next: ContentHmrEntry[]) => {
    entries = next;
    return enqueue(() => apply());
  };
}

export function contentHmrRuntimeSource(entries: ContentHmrEntry[]): string {
  return `(${createContentHmrRuntime.toString()})(${JSON.stringify(entries)})`;
}
