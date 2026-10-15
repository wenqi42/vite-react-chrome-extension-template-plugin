import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const token = `lint-probe-${process.pid}-${Date.now()}`;
const created = [];
let checks = 0;

function runLint(manager = 'npm') {
  const result = spawnSync(manager, ['run', 'lint'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  assert.ifError(result.error);
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function check(condition, message, output = '') {
  assert.ok(condition, `${message}\n${output}`);
  checks += 1;
  console.log(`PASS ${message}`);
}

function fixture(relativePath, source) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source);
  created.push(path);
  return path;
}

function removeFixture(path) {
  rmSync(path, { force: true });
}

try {
  for (const manager of ['npm', 'pnpm']) {
    const result = runLint(manager);
    check(result.status === 0, `${manager} run lint accepts the existing repository`, result.output);
  }

  const validFixtures = [
    [`${token}.config.mjs`, "import { resolve } from 'node:path';\nexport default resolve(process.cwd());\n"],
    [`scripts/${token}.mjs`, "import { readFileSync } from 'node:fs';\nexport const text = () => readFileSync(process.argv[1], 'utf8');\n"],
    [`examples/network-rewrite-extension/public/${token}.js`, "document.body.textContent = window.location.href;\nchrome.runtime.sendMessage({ type: 'lint-probe' });\n"],
    [`packages/create-chrome-extension/template/src/${token}.tsx`, "export const LintProbe = () => <button onClick={() => window.alert('ok')}>OK</button>;\n"],
    [`packages/vite-plugin-chrome-extension/${token}.ts`, "export const answer: number = 42;\n"],
  ];
  for (const [path, source] of validFixtures) fixture(path, source);
  const validResult = runLint();
  check(validResult.status === 0, 'Node, browser, Chrome API, TypeScript and TSX fixtures are accepted', validResult.output);
  for (const [path] of validFixtures) removeFixture(join(root, path));

  const invalidSyntaxPaths = [
    `${token}.config.mjs`,
    `${token}.config.ts`,
    `packages/vite-plugin-chrome-extension/${token}.ts`,
    `packages/vite-plugin-chrome-extension/${token}.test.ts`,
    `packages/create-chrome-extension/template/src/${token}.tsx`,
    `examples/network-rewrite-extension/modules/${token}.ts`,
    `examples/network-rewrite-extension/public/${token}.js`,
    `scripts/${token}.mjs`,
  ];
  for (const relativePath of invalidSyntaxPaths) {
    const path = fixture(relativePath, 'const = ;\n');
    const result = runLint();
    check(result.status !== 0 && result.output.includes(token), `invalid syntax is rejected in ${relativePath}`, result.output);
    removeFixture(path);
  }

  const negativeFixtures = [
    [`examples/network-rewrite-extension/public/${token}.js`, `globalThis.lintProbeResult = ${token.replaceAll('-', '_')};\n`, 'undeclared JavaScript variables are rejected'],
    [`packages/vite-plugin-chrome-extension/${token}.ts`, 'const unusedLintProbe: number = 42;\nexport {};\n', 'unused TypeScript variables are rejected'],
  ];
  for (const [relativePath, source, description] of negativeFixtures) {
    const path = fixture(relativePath, source);
    for (const manager of ['npm', 'pnpm']) {
      const result = runLint(manager);
      check(result.status !== 0 && result.output.includes(token), `${manager}: ${description}`, result.output);
    }
    removeFixture(path);
  }

  const ignoredRoots = [
    'node_modules',
    'dist',
    'coverage',
    '.cache',
    'packages/vite-plugin-chrome-extension/node_modules',
    'packages/vite-plugin-chrome-extension/dist',
    'examples/network-rewrite-extension/dist',
    'examples/network-rewrite-extension/.cache',
  ];
  const ignoredDirectories = [];
  for (const relativeRoot of ignoredRoots) {
    const parent = join(root, relativeRoot);
    mkdirSync(parent, { recursive: true });
    const temporaryDirectory = mkdtempSync(join(parent, `${token}-`));
    ignoredDirectories.push(temporaryDirectory);
    fixture(`${relativeRoot}/${temporaryDirectory.split('/').at(-1)}/invalid.js`, 'const = ;\n');
  }
  try {
    const ignoredResult = runLint();
    check(ignoredResult.status === 0, 'dependencies, dist, coverage and cache artifacts are ignored', ignoredResult.output);
  } finally {
    for (const directory of ignoredDirectories) rmSync(directory, { recursive: true, force: true });
  }

  console.log(`ESLint acceptance: ${checks} checks passed.`);
} finally {
  for (const path of created) removeFixture(path);
}
