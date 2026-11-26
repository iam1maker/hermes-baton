/**
 * Local SenseVoice recogniser (sherpa-onnx, offline).
 *
 * Reuses the model files and the native binding that the DSH voice-input
 * bundle already downloaded — nothing is fetched at runtime:
 *
 *   ~/.dsh/speech-to-text/sensevoice/models/sensevoice-onnx/{model.int8.onnx,tokens.txt}
 *   ~/.dsh/speech-to-text/sensevoice/models/silero/silero_vad.onnx
 *   ~/.dsh/profiles/desktop/node_modules/sherpa-onnx-node
 *
 * The inference recipe (VAD segmentation + first-segment onset padding) is the
 * one DSH uses; it is copied here because the same audio front-end must produce
 * the same text. Every override is an env var so a second install can point at
 * its own copies:
 *
 *   BATON_MODEL_DIR / BATON_VAD_MODEL / BATON_SHERPA
 *   (legacy REMOTE_MIC_* names still work)
 */

import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = homedir()
const envAny = (key) => process.env[`BATON_${key}`] || process.env[`REMOTE_MIC_${key}`]

export const DEFAULT_MODEL_DIR = join(
  HOME,
  '.dsh/speech-to-text/sensevoice/models/sensevoice-onnx'
)
export const DEFAULT_VAD_MODEL = join(HOME, '.dsh/speech-to-text/sensevoice/models/silero/silero_vad.onnx')

/** Where the native binding may live, most specific first. */
function sherpaCandidates() {
  const out = []
  if (envAny('SHERPA')) out.push(envAny('SHERPA'))
  out.push(join(import.meta.dirname, 'node_modules/sherpa-onnx-node'))
  out.push(join(HOME, '.dsh/profiles/desktop/node_modules/sherpa-onnx-node'))
  out.push(join(HOME, '.dsh/profiles/node_modules/sherpa-onnx-node'))
  return out
}

function loadSherpa() {
  const tried = []
  for (const dir of sherpaCandidates()) {
    const entry = join(dir, 'sherpa-onnx.js')
    tried.push(entry)
    if (!existsSync(entry)) continue
    try {
      const require = createRequire(join(dir, 'package.json'))
      return require('./sherpa-onnx.js')
    } catch (error) {
      tried.push(`${entry}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const error = new Error(
    `找不到 sherpa-onnx 原生模块（尝试过 ${tried.length} 处）。\n` +
      tried.map(line => `  · ${line}`).join('\n') +
      '\n修法：把 DSH 语音输入 bundle 装回来，或 npm i sherpa-onnx-node（sherpa-onnx-darwin-arm64），再用 REMOTE_MIC_SHERPA 指过去。'
  )
  error.code = 'SHERPA_MISSING'
  throw error
}

/** Resolve the on-disk model set, explaining exactly what is missing. */
export function resolveModelPaths({ modelDir, vadModel, modelFile, precision } = {}) {
  const dir = modelDir || envAny('MODEL_DIR') || DEFAULT_MODEL_DIR
  const vad = vadModel || envAny('VAD_MODEL') || DEFAULT_VAD_MODEL
  const models = existsSync(dir)
    ? readdirSync(dir).filter(name => name.endsWith('.onnx')).map(name => join(dir, name))
    : []
  // 精度选择：显式文件 > 显式精度 > 默认 int8（保持与历史行为一致）。
  // fp32 找不到时静默回退 int8，但要留痕，否则「切了没生效」无从判断。
  const notes = []
  const explicit = modelFile
    ? (modelFile.startsWith('/') ? modelFile : join(dir, modelFile))
    : envAny('MODEL_FILE')
      ? (envAny('MODEL_FILE').startsWith('/')
          ? envAny('MODEL_FILE')
          : join(dir, envAny('MODEL_FILE')))
      : ''
  const want = String(precision || envAny('MODEL_PRECISION') || 'int8').toLowerCase()
  // 同目录里可能躺着 VAD（silero_vad.onnx）之类的其它 onnx，不能当成 ASR 权重。
  const isAsr = file => file.endsWith('.onnx') && !/vad|silero/i.test(file)
  const int8 = models.find(file => file.endsWith('.int8.onnx'))
  const fp32 =
    models.find(file => file.endsWith('/model.onnx')) ||
    models.find(file => isAsr(file) && !file.endsWith('.int8.onnx'))
  let model = null
  if (explicit) {
    if (existsSync(explicit)) model = explicit
    else notes.push(`指定的模型文件不存在：${explicit}`)
  }
  if (!model) {
    if (want === 'fp32') {
      model = fp32 || null
      if (!model && int8) {
        model = int8
        notes.push('要的是 fp32，但目录里只有 int8，已回退 int8')
      }
    } else {
      model = int8 || fp32 || null
    }
  }
  const tokens = join(dir, 'tokens.txt')
  const problems = []
  if (!model) problems.push(`模型目录里没有 .onnx：${dir}`)
  if (!existsSync(tokens)) problems.push(`缺少 tokens.txt：${tokens}`)
  if (!existsSync(vad)) problems.push(`缺少 Silero VAD：${vad}`)
  return {
    ok: problems.length === 0,
    model: model ?? null,
    precision: model ? (model.endsWith('.int8.onnx') ? 'int8' : 'fp32') : null,
    wanted: want,
    notes,
    tokens: existsSync(tokens) ? tokens : null,
    vad: existsSync(vad) ? vad : null,
    dir,
    problems
  }
}

/** Read the PCM sample rate + Int16 samples out of a canonical RIFF/WAVE file. */
export function decodeWav(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, false) !== 0x52494646) throw new Error('不是 WAV 文件（缺少 RIFF 头）')
  let offset = 12
  let sampleRate = 16_000
  let format = 1
  let bits = 16
  while (offset + 8 <= bytes.byteLength) {
    const id = String.fromCharCode(...bytes.subarray(offset, offset + 4))
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ') {
      format = view.getUint16(body, true)
      sampleRate = view.getUint32(body + 4, true)
      bits = view.getUint16(body + 14, true)
    } else if (id === 'data') {
      const end = Math.min(bytes.byteLength, body + size)
      if (format !== 1 || bits !== 16) throw new Error(`只支持 16-bit PCM WAV（拿到 format=${format} bits=${bits}）`)
      return { sampleRate, samples: new Int16Array(bytes.buffer.slice(bytes.byteOffset + body, bytes.byteOffset + end)) }
    }
    offset = body + size + (size % 2)
  }
  throw new Error('WAV 里没有 data 块')
}

/**
 * Build a lazy, warm-kept transcriber. The first call pays the model load (1–3 s);
 * later calls are ~0.1–0.3 s for a short utterance.
 */
export function createSenseVoiceTranscriber({
  modelDir,
  vadModel,
  modelFile,
  precision,
  threads = 2,
  segmentSeconds = 30,
  vadThreshold = 0.5,
  minSilenceSeconds = 0.5,
  minSpeechSeconds = 0.25,
  onsetPaddingSeconds = 0.3,
  maxAudioBytes = 4 * 1024 * 1024,
  log = () => {}
} = {}) {
  let engine = null
  let loading = null
  let calls = 0
  let lastLoadMs = null

  const paths = resolveModelPaths({ modelDir, vadModel, modelFile, precision })

  const load = () => {
    if (engine) return engine
    if (!paths.ok) {
      const error = new Error(`本地 SenseVoice 不可用：\n${paths.problems.map(line => `  · ${line}`).join('\n')}`)
      error.code = 'MODEL_MISSING'
      throw error
    }
    const startedAt = Date.now()
    const sherpa = loadSherpa()
    const nativeConfig = {
      featConfig: { sampleRate: 16_000, featureDim: 80 },
      modelConfig: {
        senseVoice: { model: paths.model, language: 'auto', useInverseTextNormalization: 1 },
        tokens: paths.tokens,
        numThreads: threads,
        provider: 'cpu',
        debug: 0
      }
    }
    const recognizer = new sherpa.OfflineRecognizer(nativeConfig)
    const detector = new sherpa.Vad(
      {
        sileroVad: {
          model: paths.vad,
          threshold: vadThreshold,
          minSilenceDuration: minSilenceSeconds,
          minSpeechDuration: minSpeechSeconds,
          maxSpeechDuration: segmentSeconds,
          windowSize: 512
        },
        sampleRate: 16_000,
        numThreads: threads,
        provider: 'cpu',
        debug: 0
      },
      segmentSeconds + minSilenceSeconds + 1
    )
    lastLoadMs = Date.now() - startedAt
    log(`[stt] SenseVoice 已加载 ${paths.model} (${lastLoadMs} ms)`)
    engine = { sherpa, recognizer, detector, nativeConfig, sampleRate: 16_000 }
    return engine
  }

  const transcribe = (wavBytes, { language = 'zh' } = {}) => {
    if (wavBytes.byteLength > maxAudioBytes) throw new Error(`音频过大：${wavBytes.byteLength} 字节`)
    const { recognizer, detector, nativeConfig } = load()
    const startedAt = Date.now()
    const { sampleRate, samples } = decodeWav(wavBytes)
    if (sampleRate !== 16_000) throw new Error(`识别器只接受 16 kHz，拿到 ${sampleRate} Hz`)
    const audio = Float32Array.from(samples, value => value / 32768)

    nativeConfig.modelConfig.senseVoice.language = language || 'auto'
    recognizer.setConfig(nativeConfig)
    detector.reset()

    const texts = []
    let firstSegment = true
    const onsetPadding = Math.round(onsetPaddingSeconds * sampleRate)
    const drain = () => {
      while (!detector.isEmpty()) {
        const segment = detector.front(false)
        let speech = segment.samples
        if (firstSegment) {
          firstSegment = false
          const from = Math.max(0, segment.start - onsetPadding)
          if (from < segment.start) {
            const restored = new Float32Array(segment.start - from + speech.length)
            restored.set(audio.subarray(from, segment.start))
            restored.set(speech, segment.start - from)
            speech = restored
          }
        }
        const stream = recognizer.createStream()
        stream.acceptWaveform({ sampleRate, samples: speech })
        recognizer.decode(stream)
        texts.push(recognizer.getResult(stream).text.trim())
        detector.pop()
      }
    }
    for (let offset = 0; offset < audio.length; offset += 512) {
      detector.acceptWaveform(audio.subarray(offset, offset + 512))
      drain()
    }
    detector.flush()
    drain()
    calls += 1
    return {
      text: texts.filter(Boolean).join(' ').trim(),
      audioSeconds: samples.length / sampleRate,
      inferenceSeconds: (Date.now() - startedAt) / 1000
    }
  }

  return {
    transcribe,
    paths,
    get info() {
      return {
        kind: 'sensevoice',
        ready: paths.ok,
        loaded: engine !== null,
        calls,
        loadMs: lastLoadMs,
        model: paths.model,
        precision: paths.precision,
        wanted: paths.wanted,
        notes: paths.notes,
        problems: paths.problems
      }
    },
    dispose() {
      // sherpa 的 session 由 native 持有，不显式 free 就会一直被 RSS 记着；
      // 切精度/换模型时必须真的释放，否则内存里会同时躺着两份权重。
      try {
        engine?.recognizer?.free?.()
      } catch {
        /* 老版本 binding 没有 free() */
      }
      try {
        engine?.detector?.free?.()
      } catch {
        /* 同上 */
      }
      engine = null
      lastLoadMs = null
    }
  }
}
