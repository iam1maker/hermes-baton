#!/usr/bin/env node
/**
 * fetch-models.mts — download (or import) the two ONNX files Baton needs.
 *
 *   node scripts/fetch-models.mjs                 # download into the plugin state dir
 *   node scripts/fetch-models.mjs --from ~/.dsh/speech-to-text/sensevoice/models/sensevoice-onnx
 *   node scripts/fetch-models.mjs --fp32          # also fetch model.onnx (894 MiB)
 *   node scripts/fetch-models.mjs --help
 *
 * Why a script instead of npm dependencies: the models are 230 MB+ and do not
 * belong in git, and the plugin deliberately has no runtime dependencies beyond
 * the host's node. This uses node:https only, follows redirects (HuggingFace and
 * GitHub Releases both hand out signed CDN URLs), resumes with a Range request,
 * and prints a sha256 so two machines can be compared.
 *
 * Exit codes: 0 = all target files present and verified; 1 = a file is missing
 * or failed verification; 2 = bad usage.
 */

import { createHash } from 'node:crypto'
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync
} from 'node:fs'
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import { get as httpsGet, request as httpsRequest } from 'node:https'
import { connect as tlsConnect } from 'node:tls'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { Duplex } from 'node:stream'

const STATE_DIR = process.env.BATON_STATE_DIR || process.env.REMOTE_MIC_STATE_DIR || join(homedir(), '.hermes', 'baton')

/** One downloadable file. `sha256: null` means the digest is printed but not enforced. */
interface ModelFile {
  name: string
  asr?: boolean
  vad?: boolean
  size: number
  sha256: string | null
  url: string
}

/** The two sets this plugin loads, keyed by the relative path under --dir. */
const FILES: ModelFile[] = [
  {
    name: 'sensevoice-onnx/model.int8.onnx',
    asr: true,
    size: 239_233_841,
    sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
    url: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx'
  },
  {
    name: 'sensevoice-onnx/tokens.txt',
    size: 315_894,
    sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc',
    url: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt'
  },
  {
    name: 'silero-vad/silero_vad.onnx',
    vad: true,
    size: 643_854,
    sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx'
  }
]

const FP32: ModelFile = {
  name: 'sensevoice-onnx/model.onnx',
  asr: true,
  size: 937_617_178,
  sha256: null, // 894 MiB; size is pinned, sha is printed but not enforced
  url: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.onnx'
}

const HELP = `fetch-models.mjs — download or import Baton's local speech models

USAGE
  node scripts/fetch-models.mjs [options]

OPTIONS
  --dir <path>        target root (default: ${STATE_DIR}/models)
                      layout: <dir>/sensevoice-onnx/{model.int8.onnx,tokens.txt}
                              <dir>/silero-vad/silero_vad.onnx
  --from <path>       import from a local SenseVoice directory instead of downloading
                      (e.g. ~/.dsh/speech-to-text/sensevoice/models/sensevoice-onnx).
                      The Silero VAD is looked up in the same dir and in ../silero/;
                      override with --from-vad <file>.
  --from-vad <file>   explicit silero_vad.onnx to import alongside --from
  --fp32              also fetch model.onnx (894 MiB, adds punctuation)
  --url <name>=<url>  override a download URL, repeatable. <name> is one of:
                      model.int8.onnx | tokens.txt | silero_vad.onnx | model.onnx
  --force             re-download even when the local file matches size + sha256
  --help              this text

WHAT IT DOES
  · resumes an interrupted download (Range request against the .part file)
  · prints progress every 10%
  · verifies byte size and, for pinned files, sha256
  · skips a file that is already correct
  · never deletes anything except its own <file>.part on completion

AFTERWARDS
  Point the daemon at the new paths. The daemon's own defaults still look at the
  DSH install, so set both paths once (there is no model-path field on the
  desktop page in this build):

    TOKEN=$(cat ${STATE_DIR}/token)
    curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \\
      -d '{"patch":{"modelDir":"${STATE_DIR}/models/sensevoice-onnx","vadModel":"${STATE_DIR}/models/silero-vad/silero_vad.onnx"}}' \\
      http://127.0.0.1:8791/config

  Or skip local models entirely and set sttBaseUrl / sttModel / sttApiKey to an
  OpenAI-compatible transcription endpoint.
`

/* ────────────────────────── args ────────────────────────── */

interface Options {
  dir: string
  from: string
  fromVad: string
  fp32: boolean
  force: boolean
  urls: Record<string, string>
  help: boolean
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { dir: join(STATE_DIR, 'models'), from: '', fromVad: '', fp32: false, force: false, urls: {}, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const value = (): string => {
      i += 1
      const next = argv[i]
      if (next === undefined) throw new Error(`${arg} needs a value`)
      return next
    }
    if (arg === '--help' || arg === '-h') opts.help = true
    else if (arg === '--dir') opts.dir = resolve(value())
    else if (arg === '--from') opts.from = resolve(value())
    else if (arg === '--from-vad') opts.fromVad = resolve(value())
    else if (arg === '--fp32') opts.fp32 = true
    else if (arg === '--force') opts.force = true
    else if (arg === '--url') {
      const spec = value()
      const at = spec.indexOf('=')
      if (at < 1) throw new Error('--url needs <name>=<url>')
      opts.urls[basename(spec.slice(0, at))] = spec.slice(at + 1)
    } else if (arg.startsWith('-')) throw new Error(`unknown option: ${arg}`)
    else throw new Error(`unexpected argument: ${arg}`)
  }
  if (!opts.dir) throw new Error('--dir must not be empty')
  return opts
}

/* ────────────────────────── http ────────────────────────── */

/**
 * One GET, direct or through HTTPS_PROXY. Corporate/laptop proxies are common
 * enough that a downloader which ignores them is a downloader that does not
 * work; CONNECT tunnelling keeps TLS end-to-end. NO_PROXY (comma list, exact or
 * .suffix) is honoured.
 */
function proxyFor(hostname: string): URL | null {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
  if (!raw) return null
  const rules = (process.env.NO_PROXY || process.env.no_proxy || '')
    .split(',')
    .map(rule => rule.trim().toLowerCase())
    .filter(Boolean)
  const host = hostname.toLowerCase()
  if (rules.some(rule => rule === '*' || host === rule || host.endsWith(rule.startsWith('.') ? rule : `.${rule}`))) return null
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

function rawGet(url: string, headers: Record<string, string>): Promise<IncomingMessage> {
  const target = new URL(url)
  const proxy = proxyFor(target.hostname)
  const port = target.port || 443

  if (!proxy) {
    return new Promise<IncomingMessage>((resolvePromise, reject) => {
      const req = httpsGet(url, { headers }, response => resolvePromise(response))
      req.setTimeout(120_000, () => req.destroy(new Error(`connect timeout after 120s: ${url}`)))
      req.on('error', reject)
    })
  }

  const authority = `${target.hostname}:${port}`
  return new Promise<IncomingMessage>((resolvePromise, reject) => {
    const connectReq = httpRequest({
      host: proxy.hostname,
      port: proxy.port || 80,
      method: 'CONNECT',
      path: authority,
      headers: { host: authority },
      timeout: 120_000
    })
    connectReq.on('connect', (probe: IncomingMessage, socket: Duplex, _head: Buffer) => {
      if (probe.statusCode !== 200) {
        socket.destroy()
        return reject(new Error(`proxy refused CONNECT ${authority}: HTTP ${probe.statusCode}`))
      }
      const tlsSocket = tlsConnect({ socket, servername: target.hostname, ALPNProtocols: ['http/1.1'] })
      const inner = httpsRequest({
        host: target.hostname,
        port,
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        headers,
        servername: target.hostname,
        createConnection: () => tlsSocket
      })
      inner.setTimeout(120_000, () => inner.destroy(new Error(`connect timeout after 120s: ${url}`)))
      inner.on('response', resolvePromise)
      inner.on('error', reject)
      inner.end()
    })
    connectReq.on('timeout', () => connectReq.destroy(new Error(`proxy connect timeout: ${proxy.host}`)))
    connectReq.on('error', reject)
    connectReq.end()
  })
}

interface Reply {
  response: IncomingMessage
  statusCode: number
  headers: IncomingHttpHeaders
}

async function request(url: string, headers: Record<string, string>, redirects = 0): Promise<Reply> {
  const response = await rawGet(url, headers)
  const statusCode = response.statusCode || 0
  const location = response.headers.location
  if (statusCode >= 300 && statusCode < 400 && typeof location === 'string') {
    response.resume()
    if (redirects >= 8) throw new Error(`too many redirects: ${url}`)
    return request(new URL(location, url).toString(), headers, redirects + 1)
  }
  return { response, statusCode, headers: response.headers }
}

const human = (bytes: number): string => {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KiB`
  return `${bytes} B`
}

function sha256File(file: string): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    const hash = createHash('sha256')
    const input = createReadStream(file)
    input.on('data', (chunk: Buffer) => hash.update(chunk))
    input.on('error', reject)
    input.on('end', () => resolvePromise(hash.digest('hex')))
  })
}

interface DownloadSpec {
  size: number
  sha256: string | null
  label: string
  force: boolean
}

async function downloadOne(url: string, dest: string, { size, sha256, label, force }: DownloadSpec): Promise<string> {
  mkdirSync(dirname(dest), { recursive: true })
  const part = `${dest}.part`
  const have = existsSync(part) ? statSync(part).size : 0
  const headers: Record<string, string> = { 'user-agent': 'baton-fetch-models/1', accept: '*/*' }
  if (have > 0) headers.range = `bytes=${have}-`

  let got = await request(url, headers)

  // The server ignored the Range header: start clean instead of appending twice.
  if (have > 0 && got.statusCode === 200) {
    got.response.resume()
    unlinkSync(part)
    got = await request(url, { 'user-agent': headers['user-agent'], accept: '*/*' })
  }

  const { response, statusCode } = got
  const reply = got.headers

  if (statusCode === 416) {
    // Range past EOF: the .part is already the whole file.
    response.resume()
  } else if (statusCode !== 200 && statusCode !== 206) {
    response.resume()
    throw new Error(`HTTP ${statusCode}: ${url}`)
  }

  const total = Number(reply['content-length'] || 0) + (statusCode === 206 ? have : 0)
  const startAt = statusCode === 206 ? have : 0
  if (total && size && total !== size) {
    console.warn(`  ! server reports ${human(total)}, expected ${human(size)} (continuing; sha256 decides)`)
  }

  if (statusCode !== 416 && response.readable) {
    await new Promise<void>((resolvePromise, reject) => {
      const out = createWriteStream(part, { flags: startAt > 0 ? 'a' : 'w' })
      let received = startAt
      let bucket = total ? Math.floor((received / total) * 10) : 0
      response.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (total >= 1024 * 1024) {
          const now = Math.min(10, Math.floor((received / total) * 10))
          while (bucket < now) {
            bucket += 1
            process.stdout.write(`  ${label}: ${bucket * 10}% (${human(received)} / ${human(total)})\n`)
          }
        }
      })
      response.pipe(out)
      out.on('finish', resolvePromise)
      out.on('error', reject)
      response.on('error', reject)
    })
  } else if (!existsSync(part)) {
    // 416 means "your range starts past EOF"; without the .part there is nothing to verify.
    throw new Error(`resume file disappeared: ${part}`)
  }

  const got_ = statSync(part).size
  if (size && got_ !== size) {
    throw new Error(`${label}: wrong size (${got_} bytes, expected ${size}). The resume may have glued onto a different file; re-run with --force.`)
  }
  const digest = await sha256File(part)
  if (sha256 && digest !== sha256 && !force) {
    throw new Error(`${label}: sha256 mismatch\n  got      ${digest}\n  expected ${sha256}\n  If upstream really republished the file, accept it with --force and update the expected value in this script.`)
  }
  renameSync(part, dest)
  return digest
}

/* ────────────────────────── main ────────────────────────── */

function findLocalVad(fromDir: string, explicit: string): string | null {
  if (explicit) return existsSync(explicit) ? explicit : null
  const candidates = [
    join(fromDir, 'silero_vad.onnx'),
    join(fromDir, '..', 'silero', 'silero_vad.onnx'),
    join(fromDir, '..', 'silero-vad', 'silero_vad.onnx')
  ]
  return candidates.find(file => existsSync(file)) || null
}

async function importFrom(fromDir: string, opts: Options): Promise<void> {
  if (!existsSync(fromDir)) throw new Error(`--from directory does not exist: ${fromDir}`)
  const names = readdirSync(fromDir)
  const asr = names.find(name => name === 'model.int8.onnx') || names.find(name => name.endsWith('.int8.onnx')) || names.find(name => name === 'model.onnx')
  if (!asr) throw new Error(`${fromDir} has no model.int8.onnx / model.onnx`)
  if (!names.includes('tokens.txt')) throw new Error(`${fromDir} has no tokens.txt`)
  const vad = findLocalVad(fromDir, opts.fromVad)
  if (!vad) throw new Error(`silero_vad.onnx not found; point at it with --from-vad <file>`)

  const targets: Array<[string, string]> = [
    [join(fromDir, asr), join(opts.dir, 'sensevoice-onnx', asr === 'model.int8.onnx' ? 'model.int8.onnx' : asr)],
    [join(fromDir, 'tokens.txt'), join(opts.dir, 'sensevoice-onnx', 'tokens.txt')],
    [vad, join(opts.dir, 'silero-vad', 'silero_vad.onnx')]
  ]
  console.log(`importing (offline): ${fromDir}`)
  for (const [src, dest] of targets) {
    mkdirSync(dirname(dest), { recursive: true })
    const bytes = statSync(src).size
    copyFileSync(src, dest)
    const digest = await sha256File(dest)
    console.log(`  ✓ ${dest}  ${human(bytes)}  sha256=${digest}`)
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

async function main(): Promise<number> {
  let opts: Options
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`fetch-models: ${messageOf(error)}\n\n${HELP}`)
    return 2
  }
  if (opts.help) {
    process.stdout.write(HELP)
    return 0
  }

  console.log(`target directory: ${opts.dir}`)
  if (opts.from) {
    await importFrom(opts.from, opts)
    console.log('\ndone. Point modelDir / vadModel at the two directories above (see the end of --help).')
    return 0
  }

  const wanted: ModelFile[] = opts.fp32 ? [...FILES, FP32] : FILES
  let failed = 0
  for (const file of wanted) {
    const dest = join(opts.dir, file.name)
    const label = basename(file.name)
    const url = opts.urls[label] || file.url
    const present = existsSync(dest) ? statSync(dest).size : -1
    if (!opts.force && present === file.size) {
      const digest = await sha256File(dest)
      if (!file.sha256 || digest === file.sha256) {
        console.log(`✓ ${label} ready (${human(present)}, sha256=${digest})`)
        continue
      }
      console.log(`… ${label} size matches but sha256 differs, re-downloading`)
    } else if (!opts.force && present >= 0) {
      console.log(`… ${label} has ${human(present)}, expected ${human(file.size)}, re-downloading`)
    }
    console.log(`↓ ${label}  ← ${url}`)
    try {
      const digest = await downloadOne(url, dest, { ...file, label, force: opts.force })
      console.log(`✓ ${label}  ${human(statSync(dest).size)}  sha256=${digest}`)
    } catch (error) {
      failed += 1
      console.error(`✗ ${label}: ${messageOf(error)}`)
      console.error(`  Try another mirror with --url ${label}=<url>, or import offline with --from <local model dir>.`)
    }
  }

  console.log(
    failed === 0
      ? `\ndone. Models are in ${opts.dir}\nPoint modelDir / vadModel there (see the end of --help), or switch to an external STT service.`
      : `\n${failed} file(s) failed. See the errors and alternatives above.`
  )
  return failed === 0 ? 0 : 1
}

main().then(code => process.exit(code), (error: unknown) => {
  console.error(`fetch-models: ${error instanceof Error ? error.message || String(error) : String(error)}`)
  process.exit(1)
})
