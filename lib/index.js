/**
 * dsh-oc-faker — DSH 全局 User-Agent 伪装
 *
 * 背景：某些模型网关/API 现在校验 User-Agent（例如 opencode 网关只放行
 * `User-Agent: opencode`），而 DSH 自己的 LLM 层通过 dsh-llm 的
 * attributionHeaders() 硬编码发送 `deepseek-harness/x (+url)`，人手无法改，
 * 导致请求被拒。本插件在宿主进程内全局接管出站 HTTP 的 UA 头：
 *
 *   - 包装 globalThis.fetch（LLM 调用、web 搜索、网关转发等全部走这里）
 *   - 包装 undici 全局 dispatcher（fetch 之外的 undici 裸请求）
 *   - 给 http/https globalAgent 注入默认 User-Agent（node 原生/axios 兜底）
 *
 * 默认值 "opencode"；全部行为可运行时调整（dev_ua_set / dev_ua_test 工具），
 * 并持久化到 ~/.dsh/ua-spoof.json（重载/重启后自动恢复）。
 * 所有副作用都挂在 ctx.effect 上——卸载/重载即完全还原，不留残留。
 *
 * 零外部依赖：不 import 任何第三方模块，纯 node 内建 + 全局 API。
 */
import http from 'node:http'
import https from 'node:https'
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-oc-faker'
export const inject = ['tools']

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STATE_FILE = join(DSH_HOME, 'ua-spoof.json')
const DEFAULT_UA = 'opencode'
const MODES = ['force', 'fill', 'targets']
const WRAP_FLAG = Symbol.for('dsh.ua-spoof.wrapped')

// ── 状态：默认配置 <- env <- 插件 config <- 持久化文件（优先级逐级升高） ──
function defaults(config) {
  const cfg = (config && typeof config === 'object') ? config : {}
  let ua = process.env.DSH_UA || cfg.ua || DEFAULT_UA
  if (typeof ua !== 'string' || !ua.trim()) ua = DEFAULT_UA
  let mode = process.env.DSH_UA_MODE || cfg.mode || 'force'
  if (!MODES.includes(mode)) mode = 'force'
  return {
    ua: ua.trim(),
    mode,
    keep: Array.isArray(cfg.keep) ? cfg.keep.filter((x) => typeof x === 'string') : [],
    targets: Array.isArray(cfg.targets) ? cfg.targets.filter((x) => typeof x === 'string') : [],
  }
}

function loadState(config) {
  try {
    if (existsSync(STATE_FILE)) {
      const j = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
      const d = defaults(config)
      return {
        ua: typeof j.ua === 'string' && j.ua.trim() ? j.ua.trim() : d.ua,
        mode: MODES.includes(j.mode) ? j.mode : d.mode,
        keep: Array.isArray(j.keep) ? j.keep.filter((x) => typeof x === 'string') : d.keep,
        targets: Array.isArray(j.targets) ? j.targets.filter((x) => typeof x === 'string') : d.targets,
      }
    }
  } catch { /* 损坏则回落默认 */ }
  return defaults(config)
}

function saveState(state) {
  try {
    mkdirSync(DSH_HOME, { recursive: true })
    const tmp = STATE_FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    renameSync(tmp, STATE_FILE)
    return true
  } catch { return false }
}

// ── 主机名提取与匹配 ──
function hostOf(input) {
  try {
    const u = input instanceof URL ? input : new URL(String(input))
    return u.hostname
  } catch {
    const s = String(input)
    return s.startsWith('http') ? s.split('/')[2] || '' : s.split('/')[0] || ''
  }
}

function matchList(host, list) {
  const h = String(host || '').toLowerCase()
  for (const raw of list) {
    if (typeof raw !== 'string' || !raw) continue
    const item = raw.trim().toLowerCase()
    if (!item) continue
    if (item === h) return true
    if (item.startsWith('*.')) { if (h.endsWith(item.slice(1))) return true } // *.example.com
    if (item.startsWith('*')) { if (h.endsWith(item.slice(1))) return true }   // *example.com
    if (h.startsWith(item)) return true  // 前缀：api.
    if (h.endsWith(item)) return true    // 后缀：example.com
  }
  return false
}

function wantSpoof(state, host, hadUa) {
  if (matchList(host, state.keep)) return false  // keep 名单一律保留原始 UA
  const m = state.mode
  if (m === 'force') return true
  if (m === 'fill') return !hadUa
  if (m === 'targets') return matchList(host, state.targets)
  return false
}

// ── ① globalThis.fetch 包装（覆盖面最大：LLM / 搜索 / 网关转发 / 本插件自检） ──
function installFetchWrapper(state) {
  const original = globalThis.fetch
  if (typeof original !== 'function' || original[WRAP_FLAG]) return null
  const wrapper = async function uaSpoofFetch(input, init) {
    let headers
    const isRequest = typeof Request !== 'undefined' && input instanceof Request
    if (init && init.headers !== undefined) headers = new Headers(init.headers)
    else if (isRequest) headers = new Headers(input.headers)
    else headers = new Headers()
    const had = headers.has('user-agent')
    const host = hostOf(isRequest ? input.url : input)
    if (wantSpoof(state, host, had)) headers.set('user-agent', state.ua)
    return original(input, { ...(init ?? {}), headers })
  }
  Object.defineProperty(wrapper, WRAP_FLAG, { value: true })
  globalThis.fetch = wrapper
  return () => {
    if (globalThis.fetch === wrapper) globalThis.fetch = original
  }
}

// ── ② undici 全局 dispatcher 包装（fetch 之外的裸 undici 请求兜底） ──
const UNDICI_SYMBOL = Symbol.for('undici.globalDispatcher.1')

function normalizeHeaderEntries(headers) {
  if (Array.isArray(headers)) return headers.map(([k, v]) => [String(k).toLowerCase(), String(v)])
  if (headers && typeof headers === 'object') return Object.entries(headers).map(([k, v]) => [String(k).toLowerCase(), String(v)])
  return []
}

function installDispatcherWrap(state) {
  const dispatcher = globalThis[UNDICI_SYMBOL]
  if (!dispatcher || typeof dispatcher.dispatch !== 'function' || dispatcher.dispatch[WRAP_FLAG]) return null
  const original = dispatcher.dispatch.bind(dispatcher)
  const wrapped = function uaSpoofDispatch(origin, options) {
    let opts = options
    if (options && options.headers !== undefined) {
      const entries = normalizeHeaderEntries(options.headers)
      const host = hostOf(origin && (origin.hostname || origin.host || String(origin)))
      const had = entries.some(([k]) => k === 'user-agent')
      if (wantSpoof(state, host, had)) {
        opts = { ...options, headers: entries.filter(([k]) => k !== 'user-agent').concat([['user-agent', state.ua]]) }
      }
    }
    return original.call(this, origin, opts)
  }
  Object.defineProperty(wrapped, WRAP_FLAG, { value: true })
  dispatcher.dispatch = wrapped
  return () => { if (dispatcher.dispatch === wrapped) dispatcher.dispatch = original }
}

// ── ③ http/https globalAgent 默认头（node 原生 http.request / axios 兜底） ──
function installGlobalAgents(state) {
  const restorers = []
  for (const agent of [http.globalAgent, https.globalAgent]) {
    if (!agent || !agent.options || typeof agent.options !== 'object') continue
    const prev = agent.options.headers
    agent.options.headers = { ...(prev || {}), 'User-Agent': state.ua }
    restorers.push(() => { agent.options.headers = prev })
  }
  return () => { restorers.forEach((r) => r()) }
}

// ── 工具注册辅助 ──
function toJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, meta] of Object.entries(spec || {})) {
    const prop = { type: meta.type }
    if (meta.description) prop.description = meta.description
    if (Array.isArray(meta.enum)) prop.enum = meta.enum
    properties[key] = prop
    if (meta.required) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

function fmtList(list) {
  return list.length === 0 ? '(空)' : list.join(', ')
}

// ── 本地回环自检：起一个临时 http 服务，用（已打补丁的）fetch 打过去，读回 UA ──
function probeLocalEcho(state) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ua: req.headers['user-agent'] }))
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', async () => {
      const port = server.address().port
      try {
        const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5000) })
        const j = await r.json()
        resolve(String(j.ua || ''))
      } catch (e) {
        reject(e)
      } finally {
        server.close()
      }
    })
  })
}

export function apply(ctx, config) {
  const state = loadState(config)
  const live = { fetch: false, dispatcher: false, agents: false }

  ctx.effect(() => {
    const r1 = installFetchWrapper(state)
    const r2 = installDispatcherWrap(state)
    const r3 = installGlobalAgents(state)
    if (r1 !== null) live.fetch = true
    if (r2 !== null) live.dispatcher = true
    if (r3 !== null) live.agents = true
    return () => { r1 && r1(); r2 && r2(); r3 && r3(); live.fetch = live.dispatcher = live.agents = false }
  })

  const registerTool = (tool) => {
    try {
      ctx.effect(() => ctx.tools.register({
        ...tool,
        parameters: toJsonSchema(tool.parameters),
        output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      }))
      return true
    } catch (e) {
      ctx.logger?.warn?.('[dsh-oc-faker] tool register failed: ' + e?.message)
      return false
    }
  }

  const summary = () => [
    `ua=${state.ua}`,
    `mode=${state.mode} (force=全量替换 / fill=缺省才补 / targets=仅名单主机)`,
    `keep=[${fmtList(state.keep)}]`,
    `targets=[${fmtList(state.targets)}]`,
    `patch: fetch=${live.fetch ? 'on' : 'off'} dispatcher=${live.dispatcher ? 'on' : 'off'} http/https=${live.agents ? 'on' : 'off'}`,
    `stateFile=${STATE_FILE}`,
  ].join('\n')

  registerTool({
    name: 'dev_ua_status',
    description: 'Show the current User-Agent spoof state: ua value, mode (force/fill/targets), keep/targets host lists, patch coverage (fetch/dispatcher/http), and the persisted state file. The LLM layer otherwise hardcodes its own deepseek-harness UA, which UA-checking gateways reject.',
    parameters: {},
    execute() {
      return summary()
    },
  })

  registerTool({
    name: 'dev_ua_set',
    description: 'Change the User-Agent spoof at runtime: ua (value, default "opencode"), mode (force=replace on every host / fill=only when absent / targets=only listed hosts), addKeep/delKeep and addTarget/delTarget to manage host lists (exact, *.suffix, prefix or suffix match), reset=1 to clear keep/targets. Persisted to ~/.dsh/ua-spoof.json and survives reload/restart.',
    parameters: {
      ua: { type: 'string', description: 'UA header value, e.g. opencode' },
      mode: { type: 'string', enum: MODES, description: 'force | fill | targets' },
      addKeep: { type: 'string', description: 'host pattern to always preserve its original UA' },
      delKeep: { type: 'string', description: 'host pattern to remove from keep list' },
      addTarget: { type: 'string', description: 'host pattern to spoof only on (mode=targets)' },
      delTarget: { type: 'string', description: 'host pattern to remove from targets list' },
      reset: { type: 'number', description: '1 = clear keep+targets lists' },
    },
    execute(args) {
      const before = JSON.stringify(state)
      if (typeof args.ua === 'string' && args.ua.trim()) state.ua = args.ua.trim()
      if (MODES.includes(args.mode)) state.mode = args.mode
      const edit = (list, item, add) => {
        if (typeof item !== 'string' || !item.trim()) return
        const v = item.trim().toLowerCase()
        const hit = list.findIndex((x) => x.toLowerCase() === v)
        if (add && hit === -1) list.push(v)
        if (!add && hit !== -1) list.splice(hit, 1)
      }
      if (args.reset === 1) { state.keep = []; state.targets = [] }
      edit(state.keep, args.addKeep, true)
      edit(state.keep, args.delKeep, false)
      edit(state.targets, args.addTarget, true)
      edit(state.targets, args.delTarget, false)
      const saved = saveState(state)
      const changed = JSON.stringify(state) !== before
      return `saved=${saved ? 'yes' : 'no (persist failed; runtime-only)'}\n` + summary() + (changed ? '\n(changed — applies to the next request)' : '\n(no change)')
    },
  })

  registerTool({
    name: 'dev_ua_test',
    description: 'Verify the User-Agent spoof end-to-end. Without url: spins a local echo server in-process and proves what UA the patched fetch actually sends. With url: additionally probes that URL and reports status plus the UA the server saw if it echoes headers in a JSON body (e.g. httpbin.org/headers).',
    parameters: {
      url: { type: 'string', description: 'optional external URL to probe, e.g. https://httpbin.org/headers' },
    },
    timeoutMs: 25000,
    async execute(args) {
      const lines = []
      try {
        const seen = await probeLocalEcho(state)
        lines.push(`local-echo: server saw UA="${seen}" ${seen === state.ua ? 'PASS ✓' : 'MISS ✗ (expected ' + state.ua + ')'}`)
      } catch (e) {
        lines.push(`local-echo: FAIL ${e?.message || e}`)
      }
      if (typeof args.url === 'string' && args.url.trim()) {
        const url = args.url.trim()
        try {
          const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) })
          let seen = '(server did not echo headers)'
          try {
            const j = await res.json()
            const raw = j['user-agent'] ?? j['User-Agent'] ?? j.user_agent ?? (j.headers && (j.headers['User-Agent'] ?? j.headers['user-agent']))
            seen = raw !== undefined && raw !== null ? String(raw) : JSON.stringify(j).slice(0, 200)
          } catch { seen = '(non-json body)' }
          lines.push(`probe ${url}: status=${res.status} server-saw-UA=${seen}`)
        } catch (e) {
          lines.push(`probe ${url}: FAIL ${e?.message || e}`)
        }
      }
      return lines.join('\n')
    },
  })

  ctx.logger?.info?.('[dsh-oc-faker] active: ua=' + state.ua + ' mode=' + state.mode + ' (patch fetch+dispatcher+http/https, tools: dev_ua_status/dev_ua_set/dev_ua_test)')
}
