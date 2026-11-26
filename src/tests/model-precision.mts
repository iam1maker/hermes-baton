// 模型精度选择的纯逻辑测试：不加载 sherpa、不需要硬件，只跑 resolveModelPaths。
// 覆盖四种情形：默认 int8 / 显式 fp32 / 要 fp32 但只有 int8（必须回退并留痕）/ 显式文件名。
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

// 1) 两个文件都在 + 不指定精度 → int8（历史行为不能变）
touch('model.onnx')
touch('model.int8.onnx')
let p = resolveModelPaths({ modelDir: dir, vadModel: vad })
check('默认选 int8', String(p.model).endsWith('model.int8.onnx') && p.precision === 'int8', p.model)

// 2) 显式要 fp32 → model.onnx
p = resolveModelPaths({ modelDir: dir, vadModel: vad, precision: 'fp32' })
check('fp32 选 model.onnx', String(p.model).endsWith('/model.onnx') && p.precision === 'fp32', p.model)

// 3) 只有 int8 却要 fp32 → 回退 int8 且 notes 说明
rmSync(join(dir, 'model.onnx'))
p = resolveModelPaths({ modelDir: dir, vadModel: vad, precision: 'fp32' })
check('缺 fp32 时回退 int8', String(p.model).endsWith('model.int8.onnx') && p.notes.length === 1, JSON.stringify(p.notes))

// 4) 显式文件名优先于精度偏好
touch('custom.onnx')
p = resolveModelPaths({ modelDir: dir, vadModel: vad, modelFile: 'custom.onnx', precision: 'int8' })
check('显式文件优先', String(p.model).endsWith('custom.onnx'), p.model)

// 5) 显式文件不存在 → 留痕并回落
p = resolveModelPaths({ modelDir: dir, vadModel: vad, modelFile: 'nope.onnx' })
check('显式文件缺失时留痕', String(p.model).endsWith('model.int8.onnx') && p.notes.some(n => n.includes('nope.onnx')), JSON.stringify(p.notes))

rmSync(dir, { recursive: true, force: true })
console.log(`PRECISION SUMMARY ${pass} pass / ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
