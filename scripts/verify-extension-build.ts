#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

interface ManifestLike {
  [key: string]: unknown;
}

interface VerificationIssue {
  level: "error" | "warning";
  field: string;
  message: string;
}

export interface ExtensionBuildVerification {
  distDir: string;
  files: string[];
  issues: VerificationIssue[];
  manifest: ManifestLike;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function localPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("<") &&
    !value.startsWith("/") &&
    !value.startsWith("#") &&
    !value.startsWith("//") &&
    !/^[a-z][a-z\d+.-]*:/i.test(value)
  );
}

function addReference(
  references: Array<{ field: string; value: string }>,
  field: string,
  value: unknown,
) {
  if (localPath(value)) references.push({ field, value });
}

function manifestReferences(manifest: ManifestLike) {
  const references: Array<{ field: string; value: string }> = [];
  const action = manifest.action;
  if (isObject(action)) {
    addReference(references, "manifest.action.default_popup", action.default_popup);
    const icon = action.default_icon;
    if (typeof icon === "string") {
      addReference(references, "manifest.action.default_icon", icon);
    } else if (isObject(icon)) {
      for (const [size, file] of Object.entries(icon)) {
        addReference(references, `manifest.action.default_icon.${size}`, file);
      }
    }
  }
  const background = manifest.background;
  if (isObject(background)) {
    addReference(
      references,
      "manifest.background.service_worker",
      background.service_worker,
    );
  }
  addReference(references, "manifest.options_page", manifest.options_page);
  addReference(references, "manifest.devtools_page", manifest.devtools_page);
  const optionsUi = manifest.options_ui;
  if (isObject(optionsUi)) addReference(references, "manifest.options_ui.page", optionsUi.page);
  const sidePanel = manifest.side_panel;
  if (isObject(sidePanel)) {
    addReference(references, "manifest.side_panel.default_path", sidePanel.default_path);
  }
  const icons = manifest.icons;
  if (isObject(icons)) {
    for (const [size, file] of Object.entries(icons)) {
      addReference(references, `manifest.icons.${size}`, file);
    }
  }
  const contentScripts = manifest.content_scripts;
  if (Array.isArray(contentScripts)) {
    contentScripts.forEach((entry, index) => {
      if (!isObject(entry)) return;
      for (const field of ["js", "css"]) {
        const files = entry[field];
        if (!Array.isArray(files)) continue;
        files.forEach((file, fileIndex) =>
          addReference(
            references,
            `manifest.content_scripts[${index}].${field}[${fileIndex}]`,
            file,
          ),
        );
      }
    });
  }
  const webAccessibleResources = manifest.web_accessible_resources;
  if (Array.isArray(webAccessibleResources)) {
    webAccessibleResources.forEach((entry, index) => {
      if (!isObject(entry) || !Array.isArray(entry.resources)) return;
      entry.resources.forEach((file, fileIndex) =>
        addReference(
          references,
          `manifest.web_accessible_resources[${index}].resources[${fileIndex}]`,
          file,
        ),
      );
    });
  }
  return references;
}

async function walkFiles(directory: string, prefix = ""): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(path.join(directory, entry.name), relative)));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}

function globRegExp(pattern: string) {
  const escaped = pattern
    .split("")
    .map((character) => {
      if (character === "*") return ".*";
      if (character === "?") return ".";
      return character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  return new RegExp(`^${escaped}$`);
}

function fileMatches(reference: string, files: Set<string>) {
  const normalized = reference.replaceAll(path.sep, "/").replace(/^\.\/+/, "");
  if (normalized.includes("*") || normalized.includes("?")) {
    const expression = globRegExp(normalized);
    return [...files].some((file) => expression.test(file));
  }
  return files.has(normalized);
}

export async function verifyExtensionBuild(
  distDirectory = "dist",
): Promise<ExtensionBuildVerification> {
  const distDir = path.resolve(distDirectory);
  const issues: VerificationIssue[] = [];
  let manifest: ManifestLike;
  try {
    manifest = JSON.parse(
      await fs.readFile(path.join(distDir, "manifest.json"), "utf8"),
    ) as ManifestLike;
  } catch (error) {
    return {
      distDir,
      files: [],
      manifest: {},
      issues: [{
        level: "error",
        field: "manifest.json",
        message: `Unable to read a valid manifest.json: ${error instanceof Error ? error.message : String(error)}`,
      }],
    };
  }

  const files = await walkFiles(distDir);
  const fileSet = new Set(files);
  if (manifest.manifest_version !== 3) {
    issues.push({
      level: "error",
      field: "manifest.manifest_version",
      message: "Expected Manifest V3 (manifest_version: 3).",
    });
  }
  for (const field of ["name", "version"]) {
    if (typeof manifest[field] !== "string" || !manifest[field]) {
      issues.push({
        level: "error",
        field: `manifest.${field}`,
        message: "Expected a non-empty string.",
      });
    }
  }
  const background = manifest.background;
  if (!isObject(background) || typeof background.service_worker !== "string") {
    issues.push({
      level: "warning",
      field: "manifest.background.service_worker",
      message: "No background service worker is declared.",
    });
  }
  for (const reference of manifestReferences(manifest)) {
    if (!fileMatches(reference.value, fileSet)) {
      issues.push({
        level: "error",
        field: reference.field,
        message: `Referenced file "${reference.value}" is missing from ${distDir}.`,
      });
    }
  }
  return { distDir, files, issues, manifest };
}

function optionValue(args: string[], option: string) {
  const index = args.indexOf(option);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const result = await verifyExtensionBuild(optionValue(args, "--dist") || "dist");
  const errors = result.issues.filter(({ level }) => level === "error");
  const warnings = result.issues.filter(({ level }) => level === "warning");
  const json = args.includes("--json");
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[extension-verifier] Checked ${result.distDir}`);
    console.log(`[extension-verifier] ${result.files.length} output files`);
    for (const issue of result.issues) {
      console.error(`[extension-verifier] ${issue.level}: ${issue.field}: ${issue.message}`);
    }
    if (errors.length === 0) {
      console.log(
        `[extension-verifier] PASS (${warnings.length} warning${warnings.length === 1 ? "" : "s"})`,
      );
    }
  }
  if (errors.length > 0) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`[extension-verifier] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
