// Pure-logic test for model precision selection: loads no sherpa, needs no hardware,
// only exercises resolveModelPaths.
// Covers four cases: default int8 / explicit fp32 / fp32 wanted but only int8 present
// (must fall back and leave a note) / explicit file name.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveModelPaths } from '../sidecar/stt/sensevoice.mjs'

const dir = mkdtempSync(join(tmpdir(), 'rm-precision-'))
const touch = (name: string) => writeFileSync(join(dir, name), 'x')
const vad = join(dir, 'vad.onnx')
touch('tokens.txt')
touch('vad.onnx')

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail: string | null | undefined = '') => {
  if (ok) {
    pass += 1
    console.log(name, 'PASS', detail)
  } else {
    fail += 1
    console.log(name, 'FAIL', detail)
  }
}

// 1) Both files present + no precision specified → int8 (historical behaviour must not change)
touch('model.onnx')
touch('model.int8.onnx')
let p = resolveModelPaths({ modelDir: dir, vadModel: vad })
check('default picks int8', String(p.model).endsWith('model.int8.onnx') && p.precision === 'int8', p.model)

// 2) Explicitly want fp32 → model.onnx
p = resolveModelPaths({ modelDir: dir, vadModel: vad, precision: 'fp32' })
check('fp32 picks model.onnx', String(p.model).endsWith('/model.onnx') && p.precision === 'fp32', p.model)

// 3) Only int8 present but fp32 requested → fall back to int8 with an explanatory note
rmSync(join(dir, 'model.onnx'))
p = resolveModelPaths({ modelDir: dir, vadModel: vad, precision: 'fp32' })
check('missing fp32 falls back to int8', String(p.model).endsWith('model.int8.onnx') && p.notes.length === 1, JSON.stringify(p.notes))

// 4) An explicit file name beats the precision preference
touch('custom.onnx')
p = resolveModelPaths({ modelDir: dir, vadModel: vad, modelFile: 'custom.onnx', precision: 'int8' })
check('explicit file wins', String(p.model).endsWith('custom.onnx'), p.model)

// 5) Explicit file does not exist → leave a note and fall back
p = resolveModelPaths({ modelDir: dir, vadModel: vad, modelFile: 'nope.onnx' })
check('missing explicit file leaves a note', String(p.model).endsWith('model.int8.onnx') && p.notes.some(n => n.includes('nope.onnx')), JSON.stringify(p.notes))

rmSync(dir, { recursive: true, force: true })
console.log(`PRECISION SUMMARY ${pass} pass / ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
