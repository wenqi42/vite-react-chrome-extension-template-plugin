#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import { constants, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { hashFile, identifyArtifact, overallStatus, parseArguments } from './acceptance-core.mjs'

const repository = fileURLToPath(new URL('..', import.meta.url))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.list) {
    console.log(options.json
      ? JSON.stringify({ cases: options.selected })
      : options.selected.map(item => item.id).join('\n'))
    return
  }
  const reportPath = path.resolve(options.report ?? '.cache/acceptance/report.json')
  const evidenceRoot = path.join(path.dirname(reportPath), `${path.basename(reportPath, '.json')}-evidence`)
  await fs.mkdir(evidenceRoot, { recursive: true })
  const report = {
    status: 'RUNNING', startedAt: new Date().toISOString(), node: process.version,
    chrome: path.resolve(options.chrome), scope: options.cases.length ? 'selected' : 'full',
    matrixSize: 36, expectedCaseCount: options.selected.length,
    keep: options.keep, evidenceDir: evidenceRoot, stages: [], cases: [],
  }
  let temporary
  let interruption
  const children = new Set()
  const terminations = new Map()
  function terminateTree(child) {
    if (terminations.has(child)) return terminations.get(child)
    const pending = (async () => {
      if (!child.pid) return
      if (process.platform === 'win32') {
        await new Promise(resolve => {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
          killer.once('error', resolve)
          killer.once('close', resolve)
        })
        return
      }
      function signal(name) {
        try { process.kill(-child.pid, name); return true } catch (error) {
          if (error.code !== 'ESRCH') throw error
          return false
        }
      }
      if (!signal('SIGTERM')) return
      await new Promise(resolve => setTimeout(resolve, 1000))
      signal('SIGKILL')
    })()
    terminations.set(child, pending)
    return pending
  }
  function interrupt(signal) {
    interruption ??= new Error(`Acceptance interrupted by ${signal}`)
    process.exitCode = 1
    for (const child of children) void terminateTree(child)
  }
  const onInterrupt = () => interrupt('SIGINT')
  const onTerminate = () => interrupt('SIGTERM')
  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', onTerminate)
  function assertRunning() {
    if (interruption) throw interruption
  }
  async function save() {
    report.completedCaseCount = report.cases.filter(item => item.finishedAt || item.failedStage).length
    report.status = report.finishedAt
      ? !report.error && report.cases.length === report.expectedCaseCount ? overallStatus(report.cases) : 'FAIL'
      : 'RUNNING'
    const temporaryReport = path.join(path.dirname(reportPath), `.${path.basename(reportPath)}.${process.pid}-${randomUUID()}.tmp`)
    try {
      await fs.writeFile(temporaryReport, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
      await fs.rename(temporaryReport, reportPath)
    } finally {
      await fs.rm(temporaryReport, { force: true })
    }
  }
  async function stage(owner, name, command, args, cwd, directory = evidenceRoot) {
    assertRunning()
    const logPath = path.join(directory, `${name}.log`)
    const record = { name, status: 'FAIL', command: [command, ...args], cwd, exitCode: null, log: logPath, startedAt: new Date().toISOString() }
    owner.stages.push(record)
    const handle = await fs.open(logPath, 'w')
    let stdout = ''
    let child
    let timedOut = false
    try {
      const result = await new Promise((resolve, reject) => {
        child = spawn(command, args, {
          cwd, env: { ...process.env, NODE_PATH: '', npm_config_audit: 'false', npm_config_fund: 'false' },
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        children.add(child)
        const timer = setTimeout(() => {
          timedOut = true
          record.error = 'Stage timed out after 10 minutes'
          void terminateTree(child)
        }, 600_000)
        child.stdout.on('data', chunk => { stdout += chunk; writeSync(handle.fd, chunk) })
        child.stderr.on('data', chunk => { writeSync(handle.fd, chunk) })
        child.once('error', error => { clearTimeout(timer); reject(error) })
        child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }) })
      })
      record.exitCode = result.code ?? 1
      assertRunning()
      if (timedOut) throw new Error(`${name} timed out after 10 minutes; see ${logPath}`)
      if (result.code !== 0) throw new Error(`${name} failed (${result.signal ?? result.code}); see ${logPath}`)
      record.status = 'PASS'
      return stdout
    } catch (error) {
      record.exitCode ??= 1
      record.error = error.message
      throw error
    } finally {
      if (child) {
        await terminateTree(child)
        children.delete(child)
      }
      record.finishedAt = new Date().toISOString()
      await handle.close()
    }
  }
  try {
    await save()
    try {
      await fs.access(report.chrome, constants.X_OK)
    } catch {
      for (const item of options.selected) {
        report.cases.push({ ...item, status: 'FAIL', failedStage: 'chrome-preflight', stages: [{
          name: 'chrome-preflight', status: 'FAIL', command: ['access', report.chrome], exitCode: 1,
          error: `Chrome executable is missing or not executable: ${report.chrome}`,
        }] })
      }
      throw new Error(`Chrome executable is missing or not executable: ${report.chrome}`)
    }
    temporary = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'extension-acceptance-')))
    report.temporaryDirectory = temporary
    const packDirectory = path.join(evidenceRoot, 'packages')
    await fs.mkdir(packDirectory, { recursive: true })
    // Pack lifecycle builds are deliberately run once before any case starts.
    for (const [key, workspace] of [
      ['cli', 'packages/create-chrome-extension'],
      ['plugin', 'packages/vite-plugin-chrome-extension'],
    ]) {
      const output = await stage(report, `pack-${key}`, npm, ['pack', '--json', '--pack-destination', packDirectory], path.join(repository, workspace))
      // Lifecycle scripts may print before npm's final JSON array.
      const match = output.match(/\[\s*\{[\s\S]*\}\s*\]\s*$/)
      if (!match) throw new Error(`npm pack did not return a package description for ${key}`)
      const [packed] = JSON.parse(match[0])
      const filename = path.join(packDirectory, packed.filename)
      report[key] = { name: packed.name, version: packed.version, filename, sha256: await hashFile(filename), integrity: packed.integrity }
    }
    await stage(report, 'build-verifier', npm, ['run', 'build:scripts'], repository)
    const tools = path.join(temporary, 'tools')
    await fs.mkdir(tools)
    await fs.writeFile(path.join(tools, 'package.json'), JSON.stringify({ private: true }))
    await stage(report, 'install-cli', npm, ['install', '--save-exact', report.cli.filename], tools)
    const cli = path.join(tools, 'node_modules/create-vite-react-chrome-extension/dist/bin/create.js')
    const { verifyExtensionInChrome } = await import('./acceptance-browser.mjs')
    for (const item of options.selected) {
      assertRunning()
      const evidenceDir = path.join(evidenceRoot, item.id)
      await fs.mkdir(evidenceDir, { recursive: true })
      const result = { ...item, status: 'FAIL', failedStage: null, stages: [], evidenceDir }
      report.cases.push(result)
      const project = path.join(temporary, item.id)
      result.projectDirectory = project
      try {
        await stage(result, 'generate', process.execPath, [
          cli, 'create', item.id, item.eslint ? '--eslint' : '--no-eslint',
          item.prettier ? '--prettier' : '--no-prettier', `--${item.style}`,
        ], temporary, evidenceDir)
        const packagePath = path.join(project, 'package.json')
        const generated = JSON.parse(await fs.readFile(packagePath, 'utf8'))
        generated.devDependencies['@vite-react-chrome-extension/plugin'] = `file:${report.plugin.filename}`
        generated.devDependencies.vite = `^${item.viteMajor}.0.0`
        await fs.writeFile(packagePath, `${JSON.stringify(generated, null, 2)}\n`)
        await stage(result, 'install', npm, ['install'], project, evidenceDir)
        await fs.copyFile(packagePath, path.join(evidenceDir, 'package.json'))
        await fs.copyFile(path.join(project, 'package-lock.json'), path.join(evidenceDir, 'package-lock.json'))
        const installed = JSON.parse(await fs.readFile(path.join(project, 'package-lock.json'), 'utf8'))
        result.versions = Object.fromEntries(
          ['vite', 'typescript', 'eslint', 'prettier', '@vite-react-chrome-extension/plugin'].flatMap(name => {
            const version = installed.packages[`node_modules/${name}`]?.version
            return version ? [[name, version]] : []
          }),
        )
        if (Number(result.versions.vite?.split('.')[0]) !== item.viteMajor) throw new Error('Installed Vite major does not match requested matrix case')
        const resolvedPlugin = path.join(project, 'node_modules/@vite-react-chrome-extension/plugin')
        if ((await fs.lstat(resolvedPlugin)).isSymbolicLink()) throw new Error('Plugin must be installed from its tarball, not linked')
        if (!item.eslint && installed.packages['node_modules/eslint']) throw new Error('ESLint was installed despite being disabled')
        if (!item.prettier && installed.packages['node_modules/prettier']) throw new Error('Prettier was installed despite being disabled')
        for (const name of ['typecheck', 'build', ...(item.eslint ? ['lint'] : []), ...(item.prettier ? ['format:check'] : [])]) {
          await stage(result, name, npm, ['run', name], project, evidenceDir)
        }
        const dist = path.join(project, 'dist')
        const output = await stage(result, 'artifact-check', process.execPath, [
          path.join(repository, 'dist/scripts/verify-extension-build.js'), '--dist', dist, '--json',
        ], project, evidenceDir)
        result.artifactVerification = JSON.parse(output)
        result.artifact = await identifyArtifact(dist)
        const browserStage = { name: 'chrome-runtime', status: 'FAIL', command: ['verifyExtensionInChrome', '--dist', dist, '--chrome', report.chrome], exitCode: null }
        result.stages.push(browserStage)
        try {
          result.browser = await verifyExtensionInChrome({ dist, chrome: report.chrome, evidenceDir })
          assertRunning()
          browserStage.status = 'PASS'
          browserStage.exitCode = 0
        } catch (error) {
          result.browser = error.details
          browserStage.exitCode = 1
          browserStage.error = error.message
          throw error
        }
        result.status = 'PASS'
        console.log(`[acceptance] PASS ${item.id}`)
      } catch (error) {
        result.failedStage = result.stages.findLast(stage => stage.status === 'FAIL')?.name ?? 'case-setup'
        result.error = error.message
        console.error(`[acceptance] FAIL ${item.id}: ${error.message}`)
      } finally {
        result.finishedAt = new Date().toISOString()
        if (!options.keep) await fs.rm(project, { recursive: true, force: true })
        await save()
      }
    }
  } catch (error) {
    report.error = error.message
    if (report.cases.length === 0) {
      for (const item of options.selected) report.cases.push({
        ...item, status: 'FAIL', failedStage: report.stages.findLast(stage => stage.status === 'FAIL')?.name ?? 'setup', stages: [], error: error.message,
      })
    }
    console.error(`[acceptance] ${error.message}`)
  } finally {
    await Promise.allSettled([...children].map(terminateTree))
    if (temporary && !options.keep) await fs.rm(temporary, { recursive: true, force: true })
    if (interruption) report.error = interruption.message
    report.finishedAt = new Date().toISOString()
    await save()
    process.off('SIGINT', onInterrupt)
    process.off('SIGTERM', onTerminate)
    console.log(`[acceptance] ${report.status}: ${report.cases.filter(item => item.status === 'PASS').length}/${report.cases.length}; report ${reportPath}`)
    if (report.status !== 'PASS') process.exitCode = 1
  }
}

main().catch(error => {
  console.error(`[acceptance] ${error.message}`)
  process.exitCode = 1
})
