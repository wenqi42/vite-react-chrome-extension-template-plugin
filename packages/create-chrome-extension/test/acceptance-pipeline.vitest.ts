import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const runner = path.join(root, 'scripts/acceptance.mjs')
type MatrixCase = { id: string; style: string; eslint: boolean; prettier: boolean; viteMajor: number }

function listCases(): MatrixCase[] {
  const output = execFileSync(process.execPath, [runner, '--list', '--json'], { cwd: root, encoding: 'utf8' })
  return JSON.parse(output).cases
}

type MatrixOptions = {
  cases: string[]; chrome?: string; keep: boolean; list: boolean; json: boolean; report?: string; selected: MatrixCase[]
}
type Artifact = { sha256: string; files: { path: string; sha256: string }[] }
const corePath = path.join(root, 'scripts/acceptance-core.mjs')
const core = await import(corePath) as {
  createMatrix(): MatrixCase[]
  parseArguments(args: string[], environment?: Record<string, string | undefined>): MatrixOptions
  hashFile(filename: string): Promise<string>
  identifyArtifact(directory: string): Promise<Artifact>
  overallStatus(cases: { status: string }[]): 'PASS' | 'FAIL'
}

describe('acceptance planning and artifact public API', () => {
  it('creates the same deterministic complete matrix exposed by the CLI', () => {
    expect(core.createMatrix()).toEqual(listCases())
    expect(core.createMatrix()).toEqual(core.createMatrix())
  })

  it('parses listing without requiring Chrome or selecting a partial matrix', () => {
    const result = core.parseArguments(['--list', '--json'], {})
    expect(result).toMatchObject({ cases: [], keep: false, list: true, json: true })
    expect(result.selected).toEqual(core.createMatrix())
  })

  it('supports explicit Chrome, report, keep, and multiple selected cases', () => {
    const cases = core.createMatrix()
    const ids = [cases[0].id, cases.at(-1)!.id]
    const result = core.parseArguments([
      '--case', ids[0], '--case', ids[1], '--chrome', '/explicit/chrome', '--report', '/reports/matrix.json', '--keep',
    ], { CHROME_PATH: '/environment/chrome' })
    expect(result).toMatchObject({
      chrome: '/explicit/chrome', report: '/reports/matrix.json', keep: true, list: false, json: false, cases: ids,
    })
    expect(result.selected.map(item => item.id)).toEqual(ids)
  })

  it('uses CHROME_PATH fallback and runs all cases when none are selected', () => {
    const result = core.parseArguments([], { CHROME_PATH: '/environment/chrome' })
    expect(result.chrome).toBe('/environment/chrome')
    expect(result.selected).toHaveLength(36)
  })

  it.each([
    { args: [], message: /chrome/i },
    { args: ['--unknown'], message: /unknown|invalid|unsupported/i },
    { args: ['--case', 'invalid-case', '--list'], message: /case/i },
    { args: ['--case'], message: /case|value|required|argument/i },
    { args: ['--chrome'], message: /chrome|value|required|argument/i },
    { args: ['--report'], message: /report|value|required|argument/i },
    { args: ['--case', '--list'], message: /case|value|required|argument/i },
  ])('rejects malformed selection $args', ({ args, message }) => {
    expect(() => core.parseArguments(args, {})).toThrow(message)
  })

  it('hashes exact bytes using SHA256 and reports missing files', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'acceptance-hash-'))
    try {
      const filename = path.join(directory, 'abc')
      writeFileSync(filename, 'abc')
      expect(await core.hashFile(filename)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
      writeFileSync(filename, 'abcd')
      expect(await core.hashFile(filename)).not.toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
      await expect(core.hashFile(path.join(directory, 'missing'))).rejects.toThrow()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('identifies all artifact paths and contents with stable sorted POSIX paths', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'acceptance-artifact-'))
    try {
      mkdirSync(path.join(directory, 'nested'))
      writeFileSync(path.join(directory, 'z.js'), 'console.log(1)')
      writeFileSync(path.join(directory, 'nested', 'a.css'), 'body { color: red }')
      const first = await core.identifyArtifact(directory)
      expect(first.files.map(file => file.path)).toEqual(['nested/a.css', 'z.js'])
      for (const file of first.files) {
        expect(file.sha256).toBe(await core.hashFile(path.join(directory, file.path)))
      }
      expect(first.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(await core.identifyArtifact(directory)).toEqual(first)
      writeFileSync(path.join(directory, 'z.js'), 'console.log(2)')
      const changed = await core.identifyArtifact(directory)
      expect(changed.sha256).not.toBe(first.sha256)
      renameSync(path.join(directory, 'z.js'), path.join(directory, 'renamed.js'))
      expect((await core.identifyArtifact(directory)).sha256).not.toBe(changed.sha256)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('gives an empty directory a repeatable identity and rejects missing artifacts', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'acceptance-empty-artifact-'))
    try {
      const first = await core.identifyArtifact(directory)
      expect(first.files).toEqual([])
      expect(first.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(await core.identifyArtifact(directory)).toEqual(first)
      await expect(core.identifyArtifact(path.join(directory, 'missing'))).rejects.toThrow()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each([
    { cases: [], expected: 'FAIL' },
    { cases: [{ status: 'PASS' }], expected: 'PASS' },
    { cases: [{ status: 'PASS' }, { status: 'PASS' }], expected: 'PASS' },
    { cases: [{ status: 'FAIL' }, { status: 'PASS' }], expected: 'FAIL' },
    { cases: [{ status: 'SKIP' }], expected: 'FAIL' },
    { cases: [{ status: 'BLOCKED' }], expected: 'FAIL' },
  ])('never promotes an incomplete matrix to PASS: $cases', ({ cases, expected }) => {
    expect(core.overallStatus(cases)).toBe(expected)
  })
})

describe('published-project acceptance pipeline (public CLI)', () => {
  it('enumerates exactly 36 independent CSS/Less/Sass × tooling × Vite cases', () => {
    const cases = listCases()
    expect(cases).toHaveLength(36)
    expect(new Set(cases.map(item => item.id)).size).toBe(36)
    for (const item of cases) {
      expect(typeof item.id).toBe('string')
      expect(item.id.length).toBeGreaterThan(0)
      expect(typeof item.eslint).toBe('boolean')
      expect(typeof item.prettier).toBe('boolean')
      expect(typeof item.viteMajor).toBe('number')
    }
    const combinations = new Set(cases.map(item => `${item.style}/${item.eslint}/${item.prettier}/${item.viteMajor}`))
    for (const style of ['css', 'less', 'sass']) {
      for (const eslint of [false, true]) {
        for (const prettier of [false, true]) {
          for (const viteMajor of [5, 6, 7]) {
            expect(combinations.has(`${style}/${eslint}/${prettier}/${viteMajor}`)).toBe(true)
          }
        }
      }
    }
  })

  it('lists deterministically without starting installation or a browser', () => {
    expect(listCases()).toEqual(listCases())
  })

  it.each([
    { args: ['--not-an-option'], error: /unknown|invalid|unsupported|未知|无效/i },
    { args: ['--case', 'definitely-not-a-case'], error: /case|组合|用例/i },
    { args: ['--case'], error: /case|value|required|参数|缺少/i },
    { args: ['--chrome'], error: /chrome|value|required|参数|缺少/i },
  ])('rejects invalid arguments $args with a useful nonzero failure', ({ args, error }) => {
    const result = spawnSync(process.execPath, [runner, ...args], { cwd: root, encoding: 'utf8', timeout: 10_000 })
    expect(result.error).toBeUndefined()
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).toMatch(error)
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module/)
  })

  it('records a missing browser as failure rather than reporting unexecuted cases as success', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'extension-acceptance-contract-'))
    try {
      const selected = listCases()[0]
      const reportPath = path.join(directory, 'report.json')
      const result = spawnSync(process.execPath, [
        runner, '--case', selected.id, '--chrome', path.join(directory, 'missing-chrome'),
        '--report', reportPath,
      ], { cwd: root, encoding: 'utf8', timeout: 15_000 })
      expect(result.error).toBeUndefined()
      expect(result.status).not.toBe(0)
      const report = JSON.parse(readFileSync(reportPath, 'utf8'))
      expect(report.status).toBe('FAIL')
      expect(report.cases.some((item: { status: string }) => item.status === 'PASS')).toBe(false)
      expect(JSON.stringify(report)).toMatch(/chrome|browser/i)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.runIf(process.platform !== 'win32')('keeps a live run RUNNING and reports a real failed pack command without swallowing its exit code', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'acceptance-process-contract-'))
    const reportPath = path.join(directory, 'report.json')
    mkdirSync(path.join(directory, 'bin'))
    writeFileSync(path.join(directory, 'bin', 'npm'), '#!/usr/bin/env node\nsetTimeout(() => { console.error("VERIFIER_PACK_FAILURE"); process.exit(37) }, 800)\n', { mode: 0o755 })
    const selected = listCases()[0]
    const child = spawn(process.execPath, [
      runner, '--case', selected.id, '--chrome', process.execPath, '--report', reportPath,
    ], { cwd: root, env: { ...process.env, PATH: `${path.join(directory, 'bin')}${path.delimiter}${process.env.PATH}` }, stdio: 'pipe' })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk.toString() })
    child.stderr.on('data', chunk => { output += chunk.toString() })
    const completed = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', resolve)
    })
    try {
      let liveReport
      for (let attempt = 0; attempt < 50 && child.exitCode === null; attempt++) {
        try {
          liveReport = JSON.parse(readFileSync(reportPath, 'utf8'))
          break
        } catch { await new Promise(resolve => setTimeout(resolve, 10)) }
      }
      expect(liveReport?.status).toBe('RUNNING')
      expect(liveReport?.finishedAt).toBeUndefined()
      const exitCode = await completed
      expect(exitCode).not.toBe(0)
      const finalReport = JSON.parse(readFileSync(reportPath, 'utf8'))
      expect(finalReport.status).toBe('FAIL')
      expect(finalReport.finishedAt).toEqual(expect.any(String))
      expect(finalReport.cases).toHaveLength(1)
      expect(finalReport.cases[0]).toMatchObject({ id: selected.id, status: 'FAIL', failedStage: 'pack-cli' })
      expect(finalReport.stages.find((stage: { name: string }) => stage.name === 'pack-cli')).toMatchObject({
        status: 'FAIL', exitCode: 37,
      })
      expect(output).toMatch(/FAIL/)
    } finally {
      if (child.exitCode === null) child.kill('SIGTERM')
      rmSync(directory, { recursive: true, force: true })
    }
  }, 10_000)

  it.runIf(process.platform !== 'win32')('interrupts with failure evidence and terminates a subprocess tree that ignores SIGTERM', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'acceptance-interrupt-contract-'))
    const reportPath = path.join(directory, 'report.json')
    const pidPath = path.join(directory, 'pids.json')
    mkdirSync(path.join(directory, 'bin'))
    writeFileSync(path.join(directory, 'bin', 'npm'), `#!/usr/bin/env node
const { spawn } = require('node:child_process')
const fs = require('node:fs')
process.on('SIGTERM', () => {})
const descendant = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' })
fs.writeFileSync(process.env.VERIFIER_TREE_PIDS, JSON.stringify([process.pid, descendant.pid]))
setInterval(() => {}, 1000)
`, { mode: 0o755 })
    const selected = listCases()[0]
    const child = spawn(process.execPath, [
      runner, '--case', selected.id, '--chrome', process.execPath, '--report', reportPath,
    ], {
      cwd: root,
      env: { ...process.env, VERIFIER_TREE_PIDS: pidPath, PATH: `${path.join(directory, 'bin')}${path.delimiter}${process.env.PATH}` },
      stdio: 'pipe',
    })
    child.stdout.resume()
    child.stderr.resume()
    const completed = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    const descendants: number[] = []
    const running = (pid: number) => {
      try { process.kill(pid, 0); return true } catch { return false }
    }
    try {
      for (let attempt = 0; attempt < 150; attempt++) {
        try {
          descendants.push(...JSON.parse(readFileSync(pidPath, 'utf8')))
          break
        } catch { await new Promise(resolve => setTimeout(resolve, 10)) }
      }
      expect(descendants).toHaveLength(2)
      expect(descendants.every(running)).toBe(true)
      expect(JSON.parse(readFileSync(reportPath, 'utf8')).status).toBe('RUNNING')
      child.kill('SIGINT')
      const outcome = await completed
      expect(outcome.code).not.toBe(0)
      for (let attempt = 0; attempt < 250 && descendants.some(running); attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(descendants.filter(running)).toEqual([])
      const report = JSON.parse(readFileSync(reportPath, 'utf8'))
      expect(report.status).toBe('FAIL')
      expect(report.finishedAt).toEqual(expect.any(String))
      expect(JSON.stringify(report)).toMatch(/SIGINT|interrupt/i)
      expect(report.cases[0].status).toBe('FAIL')
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL')
      for (const pid of descendants) {
        try { process.kill(pid, 'SIGKILL') } catch { /* already cleaned by the runner */ }
      }
      rmSync(directory, { recursive: true, force: true })
    }
  }, 15_000)
})
