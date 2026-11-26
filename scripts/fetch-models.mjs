#!/usr/bin/env node
/**
 * fetch-models.mjs — download (or import) the two ONNX files Baton needs.
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
import { request as httpRequest } from 'node:http'
import { get as httpsGet, request as httpsRequest } from 'node:https'
import { connect as tlsConnect } from 'node:tls'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const STATE_DIR = process.env.BATON_STATE_DIR || process.env.REMOTE_MIC_STATE_DIR || join(homedir(), '.hermes', 'baton')

/** The two sets this plugin loads, keyed by the relative path under --dir. */
const FILES = [
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

const FP32 = {
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

function parseArgs(argv) {
  const opts = { dir: join(STATE_DIR, 'models'), from: '', fromVad: '', fp32: false, force: false, urls: {}, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const value = () => {
      const next = argv[++i]
      if (next === undefined) throw new Error(`${arg} 需要一个值`)
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
      if (at < 1) throw new Error('--url 需要 <文件名>=<url>')
      opts.urls[basename(spec.slice(0, at))] = spec.slice(at + 1)
    } else if (arg.startsWith('-')) throw new Error(`未知选项：${arg}`)
    else throw new Error(`多余参数：${arg}`)
  }
  if (!opts.dir) throw new Error('--dir 不能为空')
  return opts
}

/* ────────────────────────── http ────────────────────────── */

/**
 * One GET, direct or through HTTPS_PROXY. Corporate/laptop proxies are common
 * enough that a downloader which ignores them is a downloader that does not
 * work; CONNECT tunnelling keeps TLS end-to-end. NO_PROXY (comma list, exact or
 * .suffix) is honoured.
 */
function proxyFor(hostname) {
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

function rawGet(url, headers) {
  const target = new URL(url)
  const proxy = proxyFor(target.hostname)
  const port = target.port || 443

  if (!proxy) {
    return new Promise((resolvePromise, reject) => {
      const req = httpsGet(url, { headers }, response => resolvePromise(response))
      req.setTimeout(120_000, () => req.destroy(new Error(`连接超时 120s：${url}`)))
      req.on('error', reject)
    })
  }

  const authority = `${target.hostname}:${port}`
  return new Promise((resolvePromise, reject) => {
    const connectReq = httpRequest({
      host: proxy.hostname,
      port: proxy.port || 80,
      method: 'CONNECT',
      path: authority,
      headers: { host: authority },
      timeout: 120_000
    })
    connectReq.on('connect', (probe, socket) => {
      if (probe.statusCode !== 200) {
        socket.destroy()
        return reject(new Error(`代理拒绝 CONNECT ${authority}：HTTP ${probe.statusCode}`))
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
      inner.setTimeout(120_000, () => inner.destroy(new Error(`连接超时 120s：${url}`)))
      inner.on('response', resolvePromise)
      inner.on('error', reject)
      inner.end()
    })
    connectReq.on('timeout', () => connectReq.destroy(new Error(`代理连接超时：${proxy.host}`)))
    connectReq.on('error', reject)
    connectReq.end()
  })
}

async function request(url, headers, redirects = 0) {
  const response = await rawGet(url, headers)
  const statusCode = response.statusCode || 0
  const location = response.headers.location
  if (statusCode >= 300 && statusCode < 400 && location) {
    response.resume()
    if (redirects >= 8) throw new Error(`重定向过多：${url}`)
    return request(new URL(location, url).toString(), headers, redirects + 1)
  }
  return { response, statusCode, headers: response.headers }
}

const human = bytes => {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KiB`
  return `${bytes} B`
}

function sha256File(file) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    const input = createReadStream(file)
    input.on('data', chunk => hash.update(chunk))
    input.on('error', reject)
    input.on('end', () => resolvePromise(hash.digest('hex')))
  })
}

async function downloadOne(url, dest, { size, sha256, label, force }) {
  mkdirSync(dirname(dest), { recursive: true })
  const part = `${dest}.part`
  const have = existsSync(part) ? statSync(part).size : 0
  const headers = { 'user-agent': 'baton-fetch-models/1', accept: '*/*' }
  if (have > 0) headers.range = `bytes=${have}-`

  let { response, statusCode, headers: reply } = await request(url, headers)

  // The server ignored the Range header: start clean instead of appending twice.
  if (have > 0 && statusCode === 200) {
    response.resume()
    unlinkSync(part)
    ;({ response, statusCode, headers: reply } = await request(url, { 'user-agent': headers['user-agent'], accept: '*/*' }))
  }

  if (statusCode === 416) {
    // Range past EOF: the .part is already the whole file.
    response.resume()
  } else if (statusCode !== 200 && statusCode !== 206) {
    response.resume()
    throw new Error(`HTTP ${statusCode}：${url}`)
  }

  const total = Number(reply['content-length'] || 0) + (statusCode === 206 ? have : 0)
  const startAt = statusCode === 206 ? have : 0
  if (total && size && total !== size) {
    console.warn(`  ! 服务器报告 ${human(total)}，预期 ${human(size)}（继续下载，最后按 sha256 判定）`)
  }

  if (statusCode !== 416 && response.readable) {
    await new Promise((resolvePromise, reject) => {
      const out = createWriteStream(part, { flags: startAt > 0 ? 'a' : 'w' })
      let received = startAt
      let bucket = total ? Math.floor((received / total) * 10) : 0
      response.on('data', chunk => {
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
    throw new Error(`断点文件不见了：${part}`)
  }

  const got = statSync(part).size
  if (size && got !== size) {
    throw new Error(`${label}: 大小不对（${got} 字节，预期 ${size}）。断点续传可能接错了文件；--force 重下一次。`)
  }
  const digest = await sha256File(part)
  if (sha256 && digest !== sha256 && !force) {
    throw new Error(`${label}: sha256 不匹配\n  得到 ${digest}\n  预期 ${sha256}\n  若上游确实更新了文件，用 --force 接受新文件，并更新本脚本里的期望值。`)
  }
  renameSync(part, dest)
  return digest
}

/* ────────────────────────── main ────────────────────────── */

function findLocalVad(fromDir, explicit) {
  if (explicit) return existsSync(explicit) ? explicit : null
  const candidates = [
    join(fromDir, 'silero_vad.onnx'),
    join(fromDir, '..', 'silero', 'silero_vad.onnx'),
    join(fromDir, '..', 'silero-vad', 'silero_vad.onnx')
  ]
  return candidates.find(file => existsSync(file)) || null
}

async function importFrom(fromDir, opts) {
  if (!existsSync(fromDir)) throw new Error(`--from 目录不存在：${fromDir}`)
  const names = readdirSync(fromDir)
  const asr = names.find(name => name === 'model.int8.onnx') || names.find(name => name.endsWith('.int8.onnx')) || names.find(name => name === 'model.onnx')
  if (!asr) throw new Error(`${fromDir} 里没有 model.int8.onnx / model.onnx`)
  if (!names.includes('tokens.txt')) throw new Error(`${fromDir} 里没有 tokens.txt`)
  const vad = findLocalVad(fromDir, opts.fromVad)
  if (!vad) throw new Error(`没找到 silero_vad.onnx；用 --from-vad <file> 指定`)

  const targets = [
    [join(fromDir, asr), join(opts.dir, 'sensevoice-onnx', asr === 'model.int8.onnx' ? 'model.int8.onnx' : asr)],
    [join(fromDir, 'tokens.txt'), join(opts.dir, 'sensevoice-onnx', 'tokens.txt')],
    [vad, join(opts.dir, 'silero-vad', 'silero_vad.onnx')]
  ]
  console.log(`导入（不联网）：${fromDir}`)
  for (const [src, dest] of targets) {
    mkdirSync(dirname(dest), { recursive: true })
    const bytes = statSync(src).size
    copyFileSync(src, dest)
    const digest = await sha256File(dest)
    console.log(`  ✓ ${dest}  ${human(bytes)}  sha256=${digest}`)
  }
}

async function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`fetch-models: ${error.message}\n\n${HELP}`)
    return 2
  }
  if (opts.help) {
    process.stdout.write(HELP)
    return 0
  }

  console.log(`目标目录：${opts.dir}`)
  if (opts.from) {
    await importFrom(opts.from, opts)
    console.log('\n完成。把 modelDir / vadModel 指到上面两个目录即可（见 --help 末尾）。')
    return 0
  }

  const wanted = opts.fp32 ? [...FILES, FP32] : FILES
  let failed = 0
  for (const file of wanted) {
    const dest = join(opts.dir, file.name)
    const label = basename(file.name)
    const url = opts.urls[label] || file.url
    const present = existsSync(dest) ? statSync(dest).size : -1
    if (!opts.force && present === file.size) {
      const digest = await sha256File(dest)
      if (!file.sha256 || digest === file.sha256) {
        console.log(`✓ ${label} 已就绪（${human(present)}，sha256=${digest}）`)
        continue
      }
      console.log(`… ${label} 大小对但 sha256 不同，重新下载`)
    } else if (!opts.force && present >= 0) {
      console.log(`… ${label} 现有 ${human(present)}，预期 ${human(file.size)}，重新下载`)
    }
    console.log(`↓ ${label}  ← ${url}`)
    try {
      const digest = await downloadOne(url, dest, { ...file, label, force: opts.force })
      console.log(`✓ ${label}  ${human(statSync(dest).size)}  sha256=${digest}`)
    } catch (error) {
      failed += 1
      console.error(`✗ ${label}: ${error.message}`)
      console.error(`  可换源：--url ${label}=<url>，或用 --from <本地模型目录> 离线导入。`)
    }
  }

  console.log(
    failed === 0
      ? `\n完成。模型在 ${opts.dir}\n把 modelDir / vadModel 指过去（见 --help 末尾），或改用外部 STT 服务。`
      : `\n${failed} 个文件失败。见上面的错误与替代方案。`
  )
  return failed === 0 ? 0 : 1
}

main().then(code => process.exit(code), error => {
  console.error(`fetch-models: ${error?.message || error}`)
  process.exit(1)
})
