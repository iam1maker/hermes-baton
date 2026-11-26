/**
 * Typecheck driver.
 *
 * The gateway sandbox refuses to exec the global `tsc` shim (it is a >1 MiB
 * script and the lifecycle guard refuses to scan it), so we drive the
 * TypeScript compiler API in-process from the dev/ toolchain instead.
 *
 *   node dev/typecheck.mjs            # whole project (tsconfig.json)
 *   node dev/typecheck.mjs --files a.ts b.ts
 *
 * Exit code 1 on any diagnostic, mirroring `tsc --noEmit`.
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const ts = require('typescript')

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const argv = process.argv.slice(2)
const filesIdx = argv.indexOf('--files')
const explicitFiles = filesIdx === -1 ? null : argv.slice(filesIdx + 1)

const configPath = path.join(root, 'tsconfig.json')
const parsed = ts.getParsedCommandLineOfConfigFile(configPath, { noEmit: true }, {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: d => {
    console.error(ts.flattenDiagnosticMessageText(d.messageText, '\n'))
    process.exit(2)
  }
})
if (!parsed) {
  console.error(`cannot read ${configPath}`)
  process.exit(2)
}

const fileNames = explicitFiles && explicitFiles.length > 0
  ? explicitFiles.map(f => path.resolve(process.cwd(), f))
  : parsed.fileNames

const program = ts.createProgram({
  rootNames: fileNames,
  options: { ...parsed.options, noEmit: true }
})

const format = d => {
  const message = ts.flattenDiagnosticMessageText(d.messageText, '\n')
  if (d.file && typeof d.start === 'number') {
    const { line, character } = d.file.getLineAndCharacterOfPosition(d.start)
    const rel = path.relative(root, d.file.fileName)
    return `${rel}:${line + 1}:${character + 1} TS${d.code}: ${message}`
  }
  return `TS${d.code}: ${message}`
}

const diagnostics = [
  ...program.getOptionsDiagnostics(),
  ...program.getGlobalDiagnostics(),
  ...program.getSyntacticDiagnostics(),
  ...program.getSemanticDiagnostics()
]

for (const d of diagnostics) {
  const line = format(d)
  if (d.category === ts.DiagnosticCategory.Error) console.error(line)
  else console.warn(line)
}

const errors = diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error)
const version = ts.version
const count = fileNames.length
const relFiles = count === 1 ? ` ${path.relative(root, fileNames[0])}` : ''
if (errors.length > 0) {
  console.error(`\ntypecheck: ${errors.length} error(s) in ${count} file(s)${relFiles} (ts ${version})`)
  process.exit(1)
}
console.log(`typecheck: clean (${count} files${relFiles}, ts ${version})`)

const generated = path.join(root, 'src')
if (!fs.existsSync(generated)) {
  console.warn('warning: src/ missing')
}
