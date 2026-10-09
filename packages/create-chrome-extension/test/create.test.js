import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const cli = fileURLToPath(new URL('../bin/create.js', import.meta.url))
const run = (cwd, args, input = '') =>
  spawnSync(process.execPath, [cli, 'create', ...args], { cwd, input, encoding: 'utf8' })

for (const eslint of [false, true]) {
  for (const prettier of [false, true]) {
    test(`interactive creation: eslint=${eslint}, prettier=${prettier}`, () => {
      const cwd = mkdtempSync(path.join(tmpdir(), 'extension-cli-'))
      const result = run(cwd, [], `demo\n${eslint ? 'y' : 'n'}\n${prettier ? 'y' : 'n'}\n`)
      assert.equal(result.status, 0, result.stderr)
      const dir = path.join(cwd, 'demo')
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
      assert.equal(pkg.name, 'demo')
      assert.ok(pkg.devDependencies['@types/chrome'])
      assert.ok(existsSync(path.join(dir, 'src/background.ts')))
      assert.ok(existsSync(path.join(dir, 'vite.config.ts')))
      assert.equal(Boolean(pkg.devDependencies.eslint), eslint)
      assert.equal(Boolean(pkg.devDependencies.prettier), prettier)
      assert.equal(existsSync(path.join(dir, 'eslint.config.js')), eslint)
      assert.equal(existsSync(path.join(dir, '.prettierrc.json')), prettier)
      assert.equal(existsSync(path.join(dir, '.prettierignore')), prettier)
      assert.equal(Boolean(pkg.scripts.lint), eslint)
      assert.equal(Boolean(pkg.scripts.format), prettier)
      const before = readFileSync(path.join(dir, 'package.json'), 'utf8')
      assert.equal(run(cwd, ['demo', '--no-eslint', '--no-prettier']).status, 1)
      assert.equal(readFileSync(path.join(dir, 'package.json'), 'utf8'), before)
    })
  }
}

test('flags allow unattended use; invalid options and interrupted input do not write files', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'extension-cli-'))
  for (const args of [['--unknown'], ['demo', '--eslint', '--no-eslint'], ['Invalid Name']]) {
    assert.equal(run(cwd, args).status, 1)
  }
  assert.equal(run(cwd, [], 'demo\n').status, 1)
  assert.deepEqual(readdirSync(cwd), [])
  assert.equal(run(cwd, ['demo', '--eslint', '--prettier']).status, 0)
})
