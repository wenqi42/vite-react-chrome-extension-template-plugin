import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export function createMatrix() {
  const cases = []
  for (const style of ['css', 'less', 'sass']) {
    for (const eslint of [false, true]) {
      for (const prettier of [false, true]) {
        for (const viteMajor of [5, 6, 7]) {
          cases.push({
            id: `${style}-eslint-${eslint ? 'on' : 'off'}-prettier-${prettier ? 'on' : 'off'}-vite-${viteMajor}`,
            style, eslint, prettier, viteMajor,
          })
        }
      }
    }
  }
  return cases
}

export function parseArguments(args, environment = process.env) {
  const options = { cases: [], chrome: environment.CHROME_PATH, keep: false, list: false, json: false }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (['--keep', '--list', '--json'].includes(argument)) {
      options[argument.slice(2)] = true
    } else if (['--case', '--chrome', '--report'].includes(argument)) {
      const value = args[++index]
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`)
      if (argument === '--case') options.cases.push(value)
      else options[argument.slice(2)] = value
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  const matrix = createMatrix()
  for (const id of options.cases) {
    if (!matrix.some(item => item.id === id)) throw new Error(`Unknown acceptance case: ${id}`)
  }
  options.selected = options.cases.length
    ? matrix.filter(item => options.cases.includes(item.id))
    : matrix
  if (!options.list && !options.chrome) throw new Error('--chrome <Chrome for Testing executable> is required (or set CHROME_PATH).')
  return options
}

export async function hashFile(filename) {
  return createHash('sha256').update(await fs.readFile(filename)).digest('hex')
}

export async function identifyArtifact(directory) {
  const files = []
  async function visit(current) {
    const entries = await fs.readdir(current, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(current, entry.name)
      if (entry.isDirectory()) await visit(filename)
      else if (entry.isFile()) files.push({ path: path.relative(directory, filename).replaceAll(path.sep, '/'), sha256: await hashFile(filename) })
    }
  }
  await visit(directory)
  return {
    sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    files,
  }
}

export function overallStatus(cases) {
  return cases.length > 0 && cases.every(item => item.status === 'PASS') ? 'PASS' : 'FAIL'
}
