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
const envAny = (key: string): string | undefined =>
  process.env[`BATON_${key}`] || process.env[`REMOTE_MIC_${key}`]

export const DEFAULT_MODEL_DIR = join(
  HOME,
  '.dsh/speech-to-text/sensevoice/models/sensevoice-onnx'
)
export const DEFAULT_VAD_MODEL = join(HOME, '.dsh/speech-to-text/sensevoice/models/silero/silero_vad.onnx')

/* ── sherpa-onnx native module: only the surface we actually use ─────── */

interface SherpaStream {
  acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void
}

interface SherpaRecognizer {
  setConfig(config: NativeModelConfig): void
  createStream(): SherpaStream
  decode(stream: SherpaStream): void
  getResult(stream: SherpaStream): { text: string }
  /** Only newer bindings have this; older ones leave it undefined. */
  free?(): void
}

interface SpeechSegment {
  samples: Float32Array
  /** Start sample of this segment within the input audio. */
  start: number
}

interface SherpaDetector {
  acceptWaveform(samples: Float32Array): void
  isEmpty(): boolean
  front(enableExternalBuffer?: boolean): SpeechSegment
  pop(): void
  reset(): void
  flush(): void
  free?(): void
}

interface SherpaModule {
  OfflineRecognizer: new (config: NativeModelConfig) => SherpaRecognizer
  Vad: new (config: VadConfig, bufferSizeSeconds: number) => SherpaDetector
}

interface NativeModelConfig {
  featConfig: { sampleRate: number; featureDim: number }
  modelConfig: {
    senseVoice: { model: string; language: string; useInverseTextNormalization: number }
    tokens: string
    numThreads: number
    provider: string
    debug: number
  }
}

interface VadConfig {
  sileroVad: {
    model: string
    threshold: number
    minSilenceDuration: number
    minSpeechDuration: number
    maxSpeechDuration: number
    windowSize: number
  }
  sampleRate: number
  numThreads: number
  provider: string
  debug: number
}

/** Error code attached to the error object: callers branch on code (SHERPA_MISSING / MODEL_MISSING). */
type CodedError = Error & { code?: string }

/** Where the native binding may live, most specific first. */
function sherpaCandidates(): string[] {
  const out: string[] = []
  const override = envAny('SHERPA')
  if (override) out.push(override)
  out.push(join(import.meta.dirname, 'node_modules/sherpa-onnx-node'))
  out.push(join(HOME, '.dsh/profiles/desktop/node_modules/sherpa-onnx-node'))
  out.push(join(HOME, '.dsh/profiles/node_modules/sherpa-onnx-node'))
  return out
}

function loadSherpa(): SherpaModule {
  const tried: string[] = []
  for (const dir of sherpaCandidates()) {
    const entry = join(dir, 'sherpa-onnx.js')
    tried.push(entry)
    if (!existsSync(entry)) continue
    try {
      const require = createRequire(join(dir, 'package.json'))
      return require('./sherpa-onnx.js') as SherpaModule
    } catch (error: unknown) {
      tried.push(`${entry}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const error = new Error(
    `sherpa-onnx native module not found (tried ${tried.length} places).\n` +
      tried.map(line => `  · ${line}`).join('\n') +
      '\nfix: reinstall the DSH voice-input bundle, or npm i sherpa-onnx-node (sherpa-onnx-darwin-arm64), then point REMOTE_MIC_SHERPA at it.'
  ) as CodedError
  error.code = 'SHERPA_MISSING'
  throw error
}

export interface ModelPaths {
  ok: boolean
  model: string | null
  precision: 'int8' | 'fp32' | null
  wanted: string
  notes: string[]
  tokens: string | null
  vad: string | null
  dir: string
  problems: string[]
}

export interface ResolveModelOptions {
  modelDir?: string
  vadModel?: string
  modelFile?: string
  precision?: string
}

/** Resolve the on-disk model set, explaining exactly what is missing. */
export function resolveModelPaths({
  modelDir,
  vadModel,
  modelFile,
  precision,
}: ResolveModelOptions = {}): ModelPaths {
  const dir = modelDir || envAny('MODEL_DIR') || DEFAULT_MODEL_DIR
  const vad = vadModel || envAny('VAD_MODEL') || DEFAULT_VAD_MODEL
  const models = existsSync(dir)
    ? readdirSync(dir)
        .filter(name => name.endsWith('.onnx'))
        .map(name => join(dir, name))
    : []
  // Precision choice: explicit file > explicit precision > default int8 (unchanged historical behaviour).
  // A missing fp32 falls back to int8 silently but leaves a note, otherwise "switched it and nothing changed" is undiagnosable.
  const notes: string[] = []
  const envModelFile = envAny('MODEL_FILE')
  const explicit = modelFile
    ? modelFile.startsWith('/')
      ? modelFile
      : join(dir, modelFile)
    : envModelFile
      ? envModelFile.startsWith('/')
        ? envModelFile
        : join(dir, envModelFile)
      : ''
  const want = String(precision || envAny('MODEL_PRECISION') || 'int8').toLowerCase()
  // Other onnx files (silero_vad.onnx etc.) may sit in the same directory and must not be taken for ASR weights.
  const isAsr = (file: string): boolean => file.endsWith('.onnx') && !/vad|silero/i.test(file)
  const int8 = models.find(file => file.endsWith('.int8.onnx'))
  const fp32 =
    models.find(file => file.endsWith('/model.onnx')) ||
    models.find(file => isAsr(file) && !file.endsWith('.int8.onnx'))
  let model: string | null = null
  if (explicit) {
    if (existsSync(explicit)) model = explicit
    else notes.push(`configured model file does not exist: ${explicit}`)
  }
  if (!model) {
    if (want === 'fp32') {
      model = fp32 || null
      if (!model && int8) {
        model = int8
        notes.push('fp32 was requested but the directory only has int8; fell back to int8')
      }
    } else {
      model = int8 || fp32 || null
    }
  }
  const tokens = join(dir, 'tokens.txt')
  const problems: string[] = []
  if (!model) problems.push(`no .onnx in the model directory: ${dir}`)
  if (!existsSync(tokens)) problems.push(`missing tokens.txt: ${tokens}`)
  if (!existsSync(vad)) problems.push(`missing Silero VAD: ${vad}`)
  return {
    ok: problems.length === 0,
    model: model ?? null,
    precision: model ? (model.endsWith('.int8.onnx') ? 'int8' : 'fp32') : null,
    wanted: want,
    notes,
    tokens: existsSync(tokens) ? tokens : null,
    vad: existsSync(vad) ? vad : null,
    dir,
    problems,
  }
}

export interface DecodedWav {
  sampleRate: number
  samples: Int16Array
}

/** Read the PCM sample rate + Int16 samples out of a canonical RIFF/WAVE file. */
export function decodeWav(bytes: Uint8Array): DecodedWav {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, false) !== 0x52494646) throw new Error('not a WAV file (missing RIFF header)')
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
      if (format !== 1 || bits !== 16) {
        throw new Error(`only 16-bit PCM WAV is supported (got format=${format} bits=${bits})`)
      }
      return {
        sampleRate,
        samples: new Int16Array(bytes.buffer.slice(bytes.byteOffset + body, bytes.byteOffset + end)),
      }
    }
    offset = body + size + (size % 2)
  }
  throw new Error('no data chunk in WAV')
}

export interface TranscribeResult {
  text: string
  audioSeconds: number
  inferenceSeconds: number
}

export interface TranscriberInfo {
  kind: 'sensevoice'
  ready: boolean
  loaded: boolean
  calls: number
  loadMs: number | null
  model: string | null
  precision: 'int8' | 'fp32' | null
  wanted: string
  notes: string[]
  problems: string[]
}

export interface SenseVoiceOptions extends ResolveModelOptions {
  threads?: number
  segmentSeconds?: number
  vadThreshold?: number
  minSilenceSeconds?: number
  minSpeechSeconds?: number
  onsetPaddingSeconds?: number
  maxAudioBytes?: number
  log?: (message: string) => void
}

export interface SenseVoiceTranscriber {
  transcribe(wavBytes: Uint8Array, opts?: { language?: string }): TranscribeResult
  paths: ModelPaths
  readonly info: TranscriberInfo
  dispose(): void
}

interface LoadedEngine {
  sherpa: SherpaModule
  recognizer: SherpaRecognizer
  detector: SherpaDetector
  nativeConfig: NativeModelConfig
  sampleRate: number
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
  log = () => {},
}: SenseVoiceOptions = {}): SenseVoiceTranscriber {
  let engine: LoadedEngine | null = null
  let calls = 0
  let lastLoadMs: number | null = null

  const paths = resolveModelPaths({ modelDir, vadModel, modelFile, precision })

  const load = (): LoadedEngine => {
    if (engine) return engine
    if (!paths.ok) {
      const error = new Error(
        `local SenseVoice unavailable:\n${paths.problems.map(line => `  · ${line}`).join('\n')}`
      ) as CodedError
      error.code = 'MODEL_MISSING'
      throw error
    }
    const startedAt = Date.now()
    const sherpa = loadSherpa()
    const { model, tokens, vad } = paths
    // paths.ok already guarantees all three are non-null; narrow explicitly so null never reaches the native config.
    if (!model || !tokens || !vad) {
      throw new Error(`local SenseVoice unavailable: model paths resolved incompletely`)
    }
    const nativeConfig: NativeModelConfig = {
      featConfig: { sampleRate: 16_000, featureDim: 80 },
      modelConfig: {
        senseVoice: { model, language: 'auto', useInverseTextNormalization: 1 },
        tokens,
        numThreads: threads,
        provider: 'cpu',
        debug: 0,
      },
    }
    const recognizer = new sherpa.OfflineRecognizer(nativeConfig)
    const detector = new sherpa.Vad(
      {
        sileroVad: {
          model: vad,
          threshold: vadThreshold,
          minSilenceDuration: minSilenceSeconds,
          minSpeechDuration: minSpeechSeconds,
          maxSpeechDuration: segmentSeconds,
          windowSize: 512,
        },
        sampleRate: 16_000,
        numThreads: threads,
        provider: 'cpu',
        debug: 0,
      },
      segmentSeconds + minSilenceSeconds + 1
    )
    lastLoadMs = Date.now() - startedAt
    log(`[stt] SenseVoice loaded ${paths.model} (${lastLoadMs} ms)`)
    engine = { sherpa, recognizer, detector, nativeConfig, sampleRate: 16_000 }
    return engine
  }

  const transcribe = (
    wavBytes: Uint8Array,
    { language = 'zh' }: { language?: string } = {}
  ): TranscribeResult => {
    if (wavBytes.byteLength > maxAudioBytes) {
      throw new Error(`audio too large: ${wavBytes.byteLength} bytes`)
    }
    const { recognizer, detector, nativeConfig } = load()
    const startedAt = Date.now()
    const { sampleRate, samples } = decodeWav(wavBytes)
    if (sampleRate !== 16_000) throw new Error(`recogniser accepts 16 kHz only, got ${sampleRate} Hz`)
    const audio = Float32Array.from(samples, value => value / 32768)

    nativeConfig.modelConfig.senseVoice.language = language || 'auto'
    recognizer.setConfig(nativeConfig)
    detector.reset()

    const texts: string[] = []
    let firstSegment = true
    const onsetPadding = Math.round(onsetPaddingSeconds * sampleRate)
    const drain = (): void => {
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
      inferenceSeconds: (Date.now() - startedAt) / 1000,
    }
  }

  return {
    transcribe,
    paths,
    get info(): TranscriberInfo {
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
        problems: paths.problems,
      }
    },
    dispose(): void {
      // sherpa's session is owned by native code; without an explicit free it stays in RSS —
      // switching precision/model must really release it, or two sets of weights sit in memory at once.
      try {
        engine?.recognizer?.free?.()
      } catch {
        /* older bindings have no free() */
      }
      try {
        engine?.detector?.free?.()
      } catch {
        /* same as above */
      }
      engine = null
      lastLoadMs = null
    },
  }
}
