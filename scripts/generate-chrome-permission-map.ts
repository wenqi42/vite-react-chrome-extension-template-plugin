#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { load } from "cheerio";

const API_INDEX_URL =
  "https://developer.chrome.com/docs/extensions/reference/api?hl=en";
const outputPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../packages/vite-plugin-chrome-extension/chrome-permission-map.json",
);

const fallbackPermissions: Record<string, string[]> = {
  accessibilityFeatures: [
    "accessibilityFeatures.read",
    "accessibilityFeatures.modify",
  ],
  alarms: ["alarms"],
  bookmarks: ["bookmarks"],
  browsingData: ["browsingData"],
  contentSettings: ["contentSettings"],
  contextMenus: ["contextMenus"],
  cookies: ["cookies"],
  debugger: ["debugger"],
  declarativeContent: ["declarativeContent"],
  declarativeNetRequest: ["declarativeNetRequest"],
  declarativeNetRequestWithHostAccess: ["declarativeNetRequestWithHostAccess"],
  downloads: ["downloads"],
  fileBrowserHandler: ["fileBrowserHandler"],
  fileSystemProvider: ["fileSystemProvider"],
  fontSettings: ["fontSettings"],
  gcm: ["gcm"],
  history: ["history"],
  identity: ["identity"],
  idle: ["idle"],
  management: ["management"],
  notifications: ["notifications"],
  offscreen: ["offscreen"],
  omnibox: ["omnibox"],
  pageCapture: ["pageCapture"],
  permissions: ["permissions"],
  power: ["power"],
  printerProvider: ["printerProvider"],
  printing: ["printing"],
  privacy: ["privacy"],
  readingList: ["readingList"],
  // Lifecycle/messaging/reload do not require a namespace permission.
  // Native messaging is method-specific and remains an explicit permission.
  runtime: [],
  scripting: ["scripting"],
  sessions: ["sessions"],
  sidePanel: ["sidePanel"],
  tabCapture: ["tabCapture"],
  tabs: ["tabs"],
  topSites: ["topSites"],
  tts: ["tts"],
  ttsEngine: ["ttsEngine"],
  unlimitedStorage: ["unlimitedStorage"],
  userScripts: ["userScripts"],
  webNavigation: ["webNavigation"],
  webRequest: ["webRequest"],
  webRequestBlocking: ["webRequestBlocking"],
  windows: ["windows"],
  vpnProvider: ["vpnProvider"],
  wallpaper: ["wallpaper"],
  webAuthenticationProxy: ["webAuthenticationProxy"],
};

function apiLinks(html: string) {
  const $ = load(html);
  const links = new Set<string>();
  $('a[href*="/docs/extensions/reference/api/"]').each((_, element) => {
    const href = $(element).attr("href");
    const match = href?.match(/\/api\/([a-zA-Z][\w]*)/);
    if (match) links.add(match[1]);
  });
  return [...links].sort();
}

function permissionsFromPage(html: string, namespace: string) {
  const text = load(html).root().text().replace(/\s+/g, " ");
  const permissions = new Set<string>();
  const phrases = [
    new RegExp(
      `requires? (?:the )?["'\`]?(${namespace}(?:\\.[a-z]+)?)["'\`]? permission`,
      "gi",
    ),
    new RegExp(`需要["'\`]?(${namespace}(?:\\.[a-z]+)?)["'\`]?权限`, "gi"),
  ];
  for (const phrase of phrases) {
    for (const match of text.matchAll(phrase)) permissions.add(match[1]);
  }
  return [...permissions];
}

async function main() {
  const response = await fetch(API_INDEX_URL);
  if (!response.ok)
    throw new Error(`Failed to fetch ${API_INDEX_URL}: ${response.status}`);
  const indexHtml = await response.text();
  const namespaces = apiLinks(indexHtml);
  const apis = { ...fallbackPermissions };

  for (const namespace of namespaces) {
    const url = `https://developer.chrome.com/docs/extensions/reference/api/${namespace}?hl=en`;
    try {
      const pageResponse = await fetch(url);
      if (!pageResponse.ok) continue;
      const discovered = permissionsFromPage(
        await pageResponse.text(),
        namespace,
      );
      if (discovered.length > 0) apis[namespace] = discovered;
    } catch {
      // Keep the checked-in fallback when an individual API page is unavailable.
    }
  }

  const result = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    source: API_INDEX_URL,
    description: "Chrome extension API namespace to manifest permission map.",
    generatedBy: "scripts/generate-chrome-permission-map.ts",
    apis: Object.fromEntries(
      Object.entries(apis).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
  await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    `Wrote ${Object.keys(result.apis).length} API mappings to ${outputPath}`,
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
