#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createInterface, type Interface } from 'node:readline'

const [, , command, ...args] = process.argv
const templateDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../template')

async function main() {
  if (command === '--help' || command === '-h') {
    console.log('Usage: create-vite-react-chrome-extension create [directory] [--eslint|--no-eslint] [--prettier|--no-prettier] [--css|--less|--sass]')
    return
  }
  if (command !== 'create') throw new Error('Usage: create-vite-react-chrome-extension create [directory]')
  const flags = new Set(args.filter(arg => arg.startsWith('--')))
  const allowed = ['--eslint', '--no-eslint', '--prettier', '--no-prettier', '--css', '--less', '--sass']
  for (const flag of flags) {
    if (!allowed.includes(flag)) throw new Error(`Unknown option: ${flag}`)
  }
  const positional = args.filter(arg => !arg.startsWith('--'))
  if (positional.length > 1) throw new Error('Only one project directory is allowed.')
  for (const tool of ['eslint', 'prettier']) {
    if (flags.has(`--${tool}`) && flags.has(`--no-${tool}`)) throw new Error(`Conflicting options for ${tool}`)
  }
  const styleFlags = ['--css', '--less', '--sass'].filter(flag => flags.has(flag))
  if (styleFlags.length > 1) throw new Error('Conflicting stylesheet options.')
  let rl: Interface | undefined
  let lines: AsyncIterableIterator<string> | undefined
  async function ask(question: string) {
    if (!rl) {
      rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
      lines = rl[Symbol.asyncIterator]()
    }
    process.stdout.write(question)
    const answer = await lines!.next()
    if (answer.done) throw new Error('Input ended; creation cancelled. Supply a directory and explicit tool flags for non-interactive use.')
    return answer.value.trim()
  }
  try {
    const projectArg = positional[0] || await ask('Project name (my-chrome-extension): ') || 'my-chrome-extension'
    const targetDir = path.resolve(process.cwd(), projectArg)
    const name = path.basename(targetDir)
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name) || name.length > 214 || ['node_modules', 'favicon.ico'].includes(name)) {
      throw new Error('Project name must be a lowercase npm name (letters, numbers, dots, hyphens or underscores).')
    }
    if (fs.existsSync(targetDir) && (!fs.statSync(targetDir).isDirectory() || fs.readdirSync(targetDir).length > 0)) {
      throw new Error(`Target directory is not empty or is not a directory: ${targetDir}`)
    }
    async function choose(tool: string) {
      if (flags.has(`--${tool}`)) return true
      if (flags.has(`--no-${tool}`)) return false
      while (true) {
        const answer = (await ask(`Enable ${tool === 'eslint' ? 'ESLint' : 'Prettier'}? (y/N): `)).toLowerCase()
        if (['', 'n', 'no'].includes(answer)) return false
        if (['y', 'yes'].includes(answer)) return true
        console.log('Please enter y or n.')
      }
    }
    async function chooseStyle() {
      while (true) {
        const answer = (await ask('Stylesheet format? (css/less/sass, default css): ')).toLowerCase()
        if (['', 'css', 'less', 'sass'].includes(answer)) return answer || 'css'
        console.log('Please enter css, less or sass.')
      }
    }
    const eslint = await choose('eslint')
    const prettier = await choose('prettier')
    const style = styleFlags[0]?.slice(2) || await chooseStyle()
    fs.mkdirSync(targetDir, { recursive: true })
    fs.cpSync(templateDir, targetDir, { recursive: true })
    const packageJsonPath = path.join(targetDir, 'package.json')
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
    packageJson.name = name
    packageJson.devDependencies[style === 'less' ? 'less' : style === 'sass' ? 'sass' : 'postcss'] =
      style === 'less' ? '^4.4.0' : style === 'sass' ? '^1.93.2' : '^8.5.6'
    const sourceStyle = path.join(targetDir, 'modules/popup/popup.css')
    const stylePath = path.join(targetDir, `modules/popup/popup.${style}`)
    fs.renameSync(sourceStyle, stylePath)
    for (const moduleName of ['popup', 'options']) {
      const entryPath = path.join(targetDir, `modules/${moduleName}/index.tsx`)
      fs.writeFileSync(
        entryPath,
        fs.readFileSync(entryPath, 'utf8').replace(`'./${moduleName}.css'`, `'./${moduleName}.${style}'`),
      )
    }
    fs.renameSync(path.join(targetDir, 'modules/options/options.css'), path.join(targetDir, `modules/options/options.${style}`))
    const optionalDir = path.resolve(templateDir, '../optional')
    if (eslint) {
      Object.assign(packageJson.devDependencies, {
        eslint: '^9.39.0', '@eslint/js': '^9.39.0', 'typescript-eslint': '^8.46.0',
        'eslint-plugin-react-hooks': '^5.2.0', 'eslint-plugin-react-refresh': '^0.4.24', globals: '^16.4.0', jiti: '^2.6.1'
      })
      packageJson.scripts.lint = 'eslint .'
      packageJson.scripts['lint:fix'] = 'eslint . --fix'
      fs.copyFileSync(path.join(optionalDir, 'eslint.config.ts'), path.join(targetDir, 'eslint.config.ts'))
    }
    if (prettier) {
      packageJson.devDependencies.prettier = '^3.6.2'
      packageJson.scripts.format = 'prettier --write .'
      packageJson.scripts['format:check'] = 'prettier --check .'
      fs.copyFileSync(path.join(optionalDir, 'prettier.json'), path.join(targetDir, '.prettierrc.json'))
      fs.writeFileSync(path.join(targetDir, '.prettierignore'), 'node_modules\ndist\npackage-lock.json\n')
    }
    fs.writeFileSync(path.join(targetDir, '.gitignore'), 'node_modules\ndist\n*.local\n')
    fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`)
    console.log(`\nCreated ${name} at ${targetDir}`)
    console.log(`\nNext steps:\n\n  cd ${JSON.stringify(projectArg)}\n  npm install\n  npm run dev\n  npm run build\n`)
  } finally {
    rl?.close()
  }
}

main().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
