/**
 * Host half of the DeepSeek pricing widget.
 *
 * The Client half owns the clock and the popover; this half answers ONE
 * question for it — "which provider/model is the current session on, is that
 * the official DeepSeek route, and what does that route's wallet say" — over a
 * single same-origin POST route. A route (not a Remote) because the answer is
 * assembled from four different Host services (sessions, agentDefaultModel,
 * llm, settings, credentials) plus an outbound provider request, and none of
 * that belongs in the session log.
 *
 * Two decisions worth knowing when editing this file:
 *
 * 1. Peak/off-peak is computed on the CLIENT, from the holiday table this
 *    route echoes back. A clock is read once a second; asking the Host each
 *    second would be absurd, and China has no daylight saving time, so a
 *    correct local computation needs nothing but `Asia/Shanghai` + the dates.
 *    The Host is the only half storing configuration, so it ships the table.
 *
 * 2. The balance is best-effort by design. Which credential a provider route
 *    actually uses is a composition detail (credentials store, ambient env,
 *    the provider's own settings row, or the DeepSeek account grant), so the
 *    lookup walks those in order and reports WHY it failed instead of
 *    pretending the number is zero.
 */

/** `Asia/Shanghai` is a fixed +08:00 offset; the region has no DST. */
const SHANGHAI_OFFSET_SECONDS = 8 * 3600

/**
 * Statutory holidays, one block per year, straight from the State Council
 * notice. Only dates are listed; a weekend is off-peak anyway, so listing every
 * day of each break is both simpler and immune to range-parsing mistakes.
 *
 * 2026 — 国务院办公厅关于2026年部分节假日安排的通知 (国办发明电〔2025〕7号)
 *   元旦 1/1-1/3 · 春节 2/15-2/23 · 清明 4/4-4/6 · 劳动节 5/1-5/5 ·
 *   端午 6/19-6/21 · 中秋 9/25-9/27 · 国庆 10/1-10/7
 *
 * 2027 — 国办发明电〔2026〕10号 (2026-11-05)
 *   元旦 1/1-1/3 · 春节 2/5-2/13 · 清明 4/3-4/5 · 劳动节 5/1-5/5 ·
 *   端午 6/9 · 中秋 9/15 · 国庆 10/1-10/7
 *
 * The newest year present here is also the newest year this widget is willing
 * to judge (see `coveredThroughOf`). Add a block when the next notice lands (or
 * override the whole table via the plugin row's `holidays`); past the last
 * block the widget stops asserting a schedule instead of guessing one.
 */
const DEFAULT_HOLIDAYS = [
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
  '2026-10-06', '2026-10-07',
  // 2027: 国办发明电〔2026〕10号 (2026-11-05)
  // 元旦 1/1-1/3 · 春节 2/5-2/13 · 清明 4/3-4/5 · 劳动节 5/1-5/5 ·
  // 端午 6/9 · 中秋 9/15 · 国庆 10/1-10/7
  '2027-01-01', '2027-01-02', '2027-01-03',
  '2027-02-05', '2027-02-06', '2027-02-07', '2027-02-08', '2027-02-09',
  '2027-02-10', '2027-02-11', '2027-02-12', '2027-02-13',
  '2027-04-03', '2027-04-04', '2027-04-05',
  '2027-05-01', '2027-05-02', '2027-05-03', '2027-05-04', '2027-05-05',
  '2027-06-09',
  '2027-09-15',
  '2027-10-01', '2027-10-02', '2027-10-03', '2027-10-04', '2027-10-05',
  '2027-10-06', '2027-10-07',
]

/** Exact route. Distinct from every shipped path, so registration cannot clash. */
const ROUTE_PATH = '/valley-clock/status'

/** The wallet probe, split off so a slow provider cannot delay the schedule. */
const BALANCE_PATH = '/valley-clock/balance'

/** A status body is a session id; anything larger is not a client of ours. */
const MAX_BODY_BYTES = 16 * 1024

/**
 * Statuses that state "this endpoint is gone", not "this request failed".
 *
 * 410 Gone is the explicit one — the provider removed the route and will not
 * bring it back. Retrying it every few minutes is pointless noise, and calling
 * it a "read failure" hides the only useful fact from the user.
 */
const RETIRED_STATUS = new Set([404, 410, 501])

const DEFAULT_CONFIG = {
  /** ISO dates treated as 法定节假日. Empty = the built-in 2026+2027 table. */
  holidays: [],
  /** Provider ids treated as the official DeepSeek route (case-insensitive). */
  deepseekProviders: ['deepseek'],
  /** `{ providerId: 'sk-...' }` — an explicit key beats every discovery step. */
  apiKeys: {},
  /** `{ providerId: ['MY_KEY_ENV'] }` — extra env names looked up per provider. */
  extraEnvKeys: {},
  /** Outbound provider request budget. */
  requestTimeoutMs: 8000,
  /** How long a successful balance may be reused. */
  balanceCacheMs: 5 * 60 * 1000,
}

/**
 * Balance sources, in match order. A route's identity comes from its PROVIDER
 * id, never from a model name: every large model name is resold by several
 * gateways (`deepseek-ai/DeepSeek-V3` on SiliconFlow, `deepseek/...` on
 * OpenRouter), and those gateways each have their own price policy — SiliconFlow
 * does not use DeepSeek's peak/off-peak clock at all. Matching on the model
 * would therefore announce half-price windows on a channel that never had them.
 */
const BALANCE_SOURCES = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    provider: /deepseek/i,
    envKeys: ['DEEPSEEK_API_KEY', 'DEEPSEEK_API', 'DEEPSEEK_KEY', 'DS_API_KEY'],
    url: 'https://api.deepseek.com/user/balance',
    parse(json) {
      const infos = Array.isArray(json?.balance_infos) ? json.balance_infos : []
      const info = infos.find(item => item && item.currency === 'CNY') ?? infos[0]
      if (!info || info.total_balance === undefined || info.total_balance === null) {
        throw new Error('no balance_infos in the response')
      }
      const detail = []
      if (info.topped_up_balance != null) detail.push({ key: 'toppedUp', amount: String(info.topped_up_balance) })
      if (info.granted_balance != null) detail.push({ key: 'granted', amount: String(info.granted_balance) })
      return { currency: info.currency || 'CNY', total: String(info.total_balance), detail }
    },
  },
  {
    id: 'moonshot',
    label: 'Moonshot / Kimi',
    provider: /moonshot|kimi/i,
    envKeys: ['MOONSHOT_API_KEY', 'KIMI_API_KEY', 'MOONSHOT_KEY'],
    url: 'https://api.moonshot.cn/v1/users/me/balance',
    parse(json) {
      const data = json?.data ?? {}
      const total = data.available_balance
      if (total === undefined || total === null) throw new Error('no available_balance in the response')
      const detail = []
      if (data.cash_balance != null) detail.push({ key: 'toppedUp', amount: String(data.cash_balance) })
      if (data.voucher_balance != null) detail.push({ key: 'granted', amount: String(data.voucher_balance) })
      return { currency: 'CNY', total: String(total), detail }
    },
  },
  // SiliconFlow is deliberately absent. Its `/v1/user/info` endpoint was
  // retired on 2026-08-14 by the official notice of 2026-08-11 ("[API Service
  // Adjustment] /user/info Endpoint Deprecation") and answers 410 Gone since;
  // the platform states that any account API will be a NEW endpoint, not this
  // one. Keeping the old route here would only turn a clear "this API exposes
  // no balance" into a permanent failure log, so it stays documented rather
  // than wired up. Re-add it as a source only when a replacement endpoint is
  // announced — see https://docs.siliconflow.cn/docs/release-notes/overview
  {
    id: 'openrouter',
    label: 'OpenRouter',
    provider: /openrouter/i,
    envKeys: ['OPENROUTER_API_KEY', 'OPENROUTER_KEY'],
    url: 'https://openrouter.ai/api/v1/credits',
    parse(json) {
      const data = json?.data ?? {}
      const credits = Number(data.total_credits)
      if (!Number.isFinite(credits)) throw new Error('no total_credits in the response')
      const usage = Number(data.total_usage)
      const used = Number.isFinite(usage) ? usage : 0
      const detail = Number.isFinite(usage) ? [{ key: 'used', amount: usage.toFixed(2) }] : []
      return { currency: 'USD', total: Math.max(0, credits - used).toFixed(2), detail }
    },
  },
  {
    id: 'novita',
    label: 'Novita AI',
    provider: /novita/i,
    envKeys: ['NOVITA_API_KEY', 'NOVITA_KEY'],
    url: 'https://api.novita.ai/openapi/v1/billing/balance/detail',
    parse(json) {
      // Novita reports every amount in 1/10000 USD: "10000" means $1.00.
      const total = toUsd(json?.availableBalance)
      if (total === undefined) throw new Error('no availableBalance in the response')
      const detail = []
      const cash = toUsd(json?.cashBalance)
      if (cash !== undefined) detail.push({ key: 'toppedUp', amount: cash })
      return { currency: 'USD', total, detail }
    },
  },
]

/** The Host plugin needs the browser carrier; without it there is no route. */
export const inject = ['webServer']

/**
 * Mount the status route.
 * @param ctx - Host plugin context.
 * @param rawConfig - the row's `config` (see {@link normalizeConfig}).
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const holidays = config.holidays.length > 0 ? config.holidays : DEFAULT_HOLIDAYS
  // The table can only speak for the years it lists; the Client stops judging
  // the schedule past this year instead of treating an unlisted year as empty.
  const coveredThrough = coveredThroughOf(holidays)

  /** `sourceId:provider` -> `{ at, value }`; balances change on the order of minutes. */
  const balanceCache = new Map()

  const handler = (req, res) => {
    void serveStatus(req, res).catch(error => {
      sendJson(res, 500, { ok: false, error: messageOf(error) })
    })
  }

  const balanceHandler = (req, res) => {
    void serveBalance(req, res).catch(error => {
      sendJson(res, 500, { ok: false, error: messageOf(error) })
    })
  }

  /** Trust check, method check, and the JSON body — shared by both routes. */
  async function admit(req, res) {
    if (rejected(ctx, req)) {
      sendJson(res, 403, { ok: false, error: 'forbidden' })
      return undefined
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return undefined
    }
    return { body: await readJsonBody(req) }
  }

  /**
   * The schedule half. Everything here is computed inside this process (which
   * provider the session is on, which years the table can speak for), so the
   * answer is immediate and the clock never waits for the network.
   *
   * The wallet deliberately lives on its own route: a provider API that is slow
   * or unreachable used to hold this response hostage, which left the clock
   * neutral until something else triggered another request.
   */
  async function serveStatus(req, res) {
    const admitted = await admit(req, res)
    if (!admitted) return
    const sessionId = typeof admitted.body?.sessionId === 'string' ? admitted.body.sessionId : undefined
    const route = await resolveRoute(ctx, sessionId)
    const source = resolveSource(route, config)

    sendJson(res, 200, {
      ok: true,
      provider: route.provider ?? null,
      model: route.model ?? null,
      deepseek: source?.id === 'deepseek',
      /** Which balance API owns this route, so the popover can name it. */
      source: source?.id ?? null,
      sourceLabel: source?.label ?? null,
      /** `live` | `default` | `none` — see resolveRoute; `default` is a guess. */
      routeSource: route.routeSource ?? 'none',
      coveredThrough,
      holidays,
    })
  }

  /** The wallet half, as slow as the provider makes it and cached on top. */
  async function serveBalance(req, res) {
    const admitted = await admit(req, res)
    if (!admitted) return
    const sessionId = typeof admitted.body?.sessionId === 'string' ? admitted.body.sessionId : undefined
    const route = await resolveRoute(ctx, sessionId)
    const source = resolveSource(route, config)
    const entry = findProviderEntry(ctx, route.provider)
    const balance = source
      ? await cachedBalance(ctx, config, balanceCache, route, source, entry)
      : { supported: false, reason: 'unsupported' }

    sendJson(res, 200, {
      ok: true,
      source: source?.id ?? null,
      sourceLabel: source?.label ?? null,
      balance,
    })
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE_PATH, handler }),
    'valley-clock: status route',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: BALANCE_PATH, handler: balanceHandler }),
    'valley-clock: balance route',
  )
}

/**
 * The newest year the holiday table can answer for, derived from the table
 * itself so the two can never disagree. `undefined` only for an empty table.
 */
function coveredThroughOf(holidays) {
  let year
  for (const date of holidays) {
    const current = Number(date.slice(0, 4))
    if (!Number.isFinite(current)) continue
    if (year === undefined || current > year) year = current
  }
  return year
}

/** Merge the row config over the defaults without trusting its shapes. */
function normalizeConfig(raw) {
  const config = { ...DEFAULT_CONFIG }
  if (!raw || typeof raw !== 'object') return config
  if (Array.isArray(raw.holidays)) {
    config.holidays = raw.holidays
      .filter(date => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date))
  }
  if (Array.isArray(raw.deepseekProviders)) {
    const tokens = raw.deepseekProviders
      .filter(token => typeof token === 'string' && token.trim() !== '')
      .map(token => token.trim().toLowerCase())
    if (tokens.length > 0) config.deepseekProviders = tokens
  }
  if (raw.apiKeys && typeof raw.apiKeys === 'object') {
    config.apiKeys = pickStringRecord(raw.apiKeys)
  }
  if (raw.extraEnvKeys && typeof raw.extraEnvKeys === 'object') {
    const extra = {}
    for (const [key, value] of Object.entries(raw.extraEnvKeys)) {
      if (!Array.isArray(value)) continue
      extra[key] = value.filter(name => typeof name === 'string' && name.trim() !== '')
    }
    config.extraEnvKeys = extra
  }
  if (Number.isFinite(raw.requestTimeoutMs) && raw.requestTimeoutMs >= 1000) {
    config.requestTimeoutMs = Math.min(raw.requestTimeoutMs, 30000)
  }
  if (Number.isFinite(raw.balanceCacheMs) && raw.balanceCacheMs >= 0) {
    config.balanceCacheMs = Math.min(raw.balanceCacheMs, 60 * 60 * 1000)
  }
  return config
}

function pickStringRecord(value) {
  const result = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && entry.trim() !== '') result[key] = entry.trim()
  }
  return result
}

// ---------------------------------------------------------------------------
// Route resolution
// ---------------------------------------------------------------------------

/**
 * Which provider/model the session is on right now, and where that came from.
 *
 * `session.requestContext()` is the live answer for a running conversation; a
 * session that has not issued a request yet carries the route in its last
 * `request/header`.
 *
 * A NAMED session we cannot read gets NO route — deliberately not the profile
 * default. The default is where a NEW session would start, not what an existing
 * conversation is billed at: substituting it labelled a DeepSeek session with a
 * relay provider during the startup hydration window, so the clock dropped its
 * colour and only recovered on the next minute-long poll (or a click, which
 * refreshed sooner). "I don't know yet" is the honest answer there, and the
 * Client keeps retrying quickly while it holds it.
 */
async function resolveRoute(ctx, sessionId) {
  const named = typeof sessionId === 'string' && sessionId !== ''
  if (named) {
    const session = safeGet(ctx, 'sessions')?.get?.(sessionId)
    if (session) {
      try {
        const context = session.requestContext?.()
        if (context && typeof context.provider === 'string') {
          return {
            provider: context.provider,
            model: typeof context.model === 'string' ? context.model : undefined,
            routeSource: 'live',
          }
        }
      } catch { /* fall through to the recorded header */ }
      try {
        const header = session.requestHeader?.()
        const configured = header?.config
        if (configured && typeof configured.provider === 'string') {
          return {
            provider: configured.provider,
            model: typeof configured.model === 'string' ? configured.model : undefined,
            routeSource: 'live',
          }
        }
      } catch { /* fall through to "unknown" */ }
    }
    return { provider: undefined, model: undefined, routeSource: 'none' }
  }
  try {
    const selection = safeGet(ctx, 'agentDefaultModel')?.currentSelection?.()
    if (selection && typeof selection.provider === 'string') {
      return {
        provider: selection.provider,
        model: typeof selection.model === 'string' ? selection.model : undefined,
        routeSource: 'default',
      }
    }
  } catch { /* no default selection either */ }
  return { provider: undefined, model: undefined, routeSource: 'none' }
}

/**
 * Which source owns this route. Only the provider id may answer that question —
 * see the note on {@link BALANCE_SOURCES} for why a model name must never do it.
 * An unidentified route is treated as "not DeepSeek", which is the safe side:
 * a wrong "peak pricing" claim would mislead about money, while a wrong "not
 * official" only adds a truthful notice.
 */
function resolveSource(route, config) {
  const provider = typeof route.provider === 'string' ? route.provider : ''
  if (provider === '') return undefined
  for (const source of BALANCE_SOURCES) {
    if (source.provider.test(provider)) return source
  }
  // Explicit opt-in for a private/composed provider id (`deepseekProviders`).
  const lowered = provider.toLowerCase()
  if (config.deepseekProviders.some(token => lowered.includes(token))) {
    return BALANCE_SOURCES.find(source => source.id === 'deepseek')
  }
  return undefined
}

/** The live directory entry for a provider route, when the llm layer declares one. */
function findProviderEntry(ctx, provider) {
  if (typeof provider !== 'string' || provider === '') return undefined
  const llm = safeGet(ctx, 'llm')
  if (!llm || typeof llm.listConfigurableProviders !== 'function') return undefined
  try {
    const list = llm.listConfigurableProviders()
    if (!Array.isArray(list)) return undefined
    return list.find(entry => entry && entry.provider === provider)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

async function cachedBalance(ctx, config, cache, route, source, entry) {
  const key = `${source.id}:${route.provider ?? ''}`
  const now = Date.now()
  const hit = cache.get(key)
  const ttl = balanceTtl(hit, config)
  if (hit && now - hit.at < ttl) return hit.value
  const value = await computeBalance(ctx, config, source, entry)
  cache.set(key, { at: now, value })
  return value
}

/**
 * A wallet is worth re-reading every few minutes, a transient failure in
 * seconds, and a retired endpoint almost never — it is gone, not flaky.
 */
function balanceTtl(hit, config) {
  if (!hit) return 0
  if (hit.value.supported === true) return config.balanceCacheMs
  if (hit.value.reason === 'retired') return 6 * 60 * 60 * 1000
  return 30 * 1000
}

async function computeBalance(ctx, config, source, entry) {
  // The signed-in DeepSeek account is the wallet the official route bills.
  if (source.id === 'deepseek') {
    const account = await readAccountBalance(ctx, config)
    if (account) return account
  }
  const apiKey = await resolveApiKey(ctx, config, source, entry)
  if (!apiKey) return { supported: false, reason: 'no-key', label: source.label }
  if (typeof fetch !== 'function') {
    return { supported: false, reason: 'network', label: source.label, message: 'fetch is unavailable' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs)
  try {
    const response = await fetch(source.url, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok) {
      // 410 Gone is a permanent statement: the provider retired the endpoint.
      // Report it as retired so the widget can say so once and back off, rather
      // than re-probing a dead route on every poll.
      return {
        supported: false,
        reason: RETIRED_STATUS.has(response.status) ? 'retired' : 'http',
        label: source.label,
        status: response.status,
        detail: providerMessage(text),
        message: clip(text),
      }
    }
    let json
    try {
      json = JSON.parse(text)
    } catch {
      return { supported: false, reason: 'parse', label: source.label, message: clip(text) }
    }
    // A 200 whose body lacks the balance fields is a DIFFERENT failure from an
    // unparseable body, and that difference is exactly what the user needs in
    // order to tell "wrong key" from "this account exposes no balance".
    let parsed
    try {
      parsed = source.parse(json)
    } catch (error) {
      return { supported: false, reason: 'fields', label: source.label, message: messageOf(error) }
    }
    return {
      supported: true,
      via: 'api-key',
      label: source.label,
      currency: parsed.currency,
      total: parsed.total,
      detail: parsed.detail,
    }
  } catch (error) {
    return {
      supported: false,
      reason: controller.signal.aborted ? 'timeout' : 'network',
      label: source.label,
      message: messageOf(error),
    }
  } finally {
    clearTimeout(timer)
  }
}

/** The official account wallet, when the user signed in instead of pasting a key. */
async function readAccountBalance(ctx, config) {
  const account = safeGet(ctx, 'deepseekAccount')
  if (!account || typeof account.getBalance !== 'function') return undefined
  try {
    // The platform host can stall on a cold connection. The wallet must give up
    // rather than pin a request — the schedule no longer waits on it, but the
    // balance route should still answer in bounded time.
    const state = await withTimeout(account.getState(), config.requestTimeoutMs)
    if (!state || state.status !== 'credential-stored') return undefined
    const balance = await withTimeout(account.getBalance({
      version: '0.1.0',
      locale: 'zh',
      timezoneOffsetSeconds: SHANGHAI_OFFSET_SECONDS,
    }), config.requestTimeoutMs)
    if (!balance || balance.status !== 'ready') return undefined
    const wallets = Array.isArray(balance.value) ? balance.value : []
    const bonuses = Array.isArray(balance.bonusWallets) ? balance.bonusWallets : []
    const currency = wallets[0]?.currency ?? bonuses[0]?.currency ?? 'CNY'
    const same = wallet => wallet && wallet.currency === currency
    const total = sumAmounts([...wallets.filter(same), ...bonuses.filter(same)].map(wallet => wallet.balance))
    if (total === undefined) return undefined
    const detail = []
    for (const wallet of wallets.filter(same)) detail.push({ key: 'wallet', amount: wallet.balance })
    for (const wallet of bonuses.filter(same)) detail.push({ key: 'granted', amount: wallet.balance })
    return { supported: true, via: 'account', label: 'DeepSeek', currency, total, detail }
  } catch {
    return undefined
  }
}

/**
 * Find the credential behind one provider route, in decreasing authority:
 * the row's explicit key, then the credential store / ambient environment
 * (names taken from the live provider directory first), then the provider's
 * own settings row.
 */
async function resolveApiKey(ctx, config, source, entry) {
  const explicit = config.apiKeys[source.id]
  if (typeof explicit === 'string' && explicit !== '') return explicit

  const branch = readProviderBranch(ctx, entry)
  const names = []
  const push = name => {
    if (typeof name !== 'string' || name === '' || names.includes(name)) return
    names.push(name)
  }
  for (const name of config.extraEnvKeys[source.id] ?? []) push(name)
  // The provider's own configured env name outranks any guess of ours.
  for (const name of envNamesOf(branch)) push(name)
  for (const name of entry?.nativeAuth?.env ?? []) push(name)
  for (const name of source.envKeys) push(name)

  const credentials = safeGet(ctx, 'credentials')
  for (const name of names) {
    if (credentials) {
      try {
        const resolved = await credentials.resolve(name)
        if (resolved && typeof resolved.value === 'string' && resolved.value !== '') return resolved.value
      } catch { /* try the ambient environment */ }
    }
    const ambient = readEnv(name)
    if (ambient) return ambient
  }
  return findSecret(branch, 0)
}

/**
 * The settings sub-object describing THIS provider, or nothing at all.
 *
 * Deliberately never the whole row: the providers share one settings entry
 * (`llm-pi-ai` keeps them all under `providers`), so an unscoped search is
 * exactly how one provider's credential ends up in another provider's request.
 */
function readProviderBranch(ctx, entry) {
  if (!entry || typeof entry.settingsNs !== 'string') return undefined
  const settings = safeGet(ctx, 'settings')
  if (!settings || typeof settings.describe !== 'function') return undefined
  let descriptors
  try {
    descriptors = settings.describe()
  } catch {
    return undefined
  }
  if (!Array.isArray(descriptors)) return undefined
  const owned = descriptors.find(descriptor => descriptor && descriptor.ns === entry.settingsNs)
  if (!owned) return undefined
  // A declared path is authoritative. An empty one would mean "the whole row",
  // which is precisely what must not happen here — look the id up instead.
  if (Array.isArray(entry.settingsPath) && entry.settingsPath.length > 0) {
    const byPath = resolvePath(owned.value, entry.settingsPath)
    if (byPath && typeof byPath === 'object') return byPath
  }
  return findProviderObject(owned.value, entry.provider, 0)
}

/** Bounded search for the sub-object keyed by this provider's id. */
function findProviderObject(value, provider, depth) {
  if (depth > 4 || !value || typeof value !== 'object') return undefined
  if (typeof provider !== 'string' || provider === '') return undefined
  const wanted = provider.toLowerCase()
  for (const [key, child] of Object.entries(value)) {
    if (key.toLowerCase() === wanted && child && typeof child === 'object') return child
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      const found = findProviderObject(child, provider, depth + 1)
      if (found) return found
    }
  }
  return undefined
}

/**
 * The env-var NAMES this provider configured (`apiKeyEnv`, `keyEnvs`, …).
 * They are names, not secrets: the value is resolved through the credential
 * layer, which is what makes a `.env`-backed key work.
 */
function envNamesOf(branch) {
  const names = []
  if (!branch || typeof branch !== 'object') return names
  for (const [key, value] of Object.entries(branch)) {
    if (!/key/i.test(key) || !/env/i.test(key)) continue
    if (typeof value === 'string' && value !== '') {
      names.push(value)
    } else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string' && item !== '') names.push(item)
    }
  }
  return names
}

function resolvePath(value, path) {
  if (!Array.isArray(path) || path.length === 0) return value
  let current = value
  for (const segment of path) {
    if (current == null || typeof current !== 'object') return undefined
    current = current[segment]
  }
  return current
}

const SECRET_KEY = /^(api[-_]?key|apikey|key|token|secret|access[-_]?key)$/i

/** Breadth-first, bounded search for the first credential-looking string. */
function findSecret(value, depth) {
  if (depth > 5 || value == null || typeof value !== 'object') return undefined
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'string' && child !== '' && SECRET_KEY.test(key)) return child
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      const found = findSecret(child, depth + 1)
      if (found) return found
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Connection owns deployment trust; never infer it locally. */
function rejected(ctx, req) {
  const connection = safeGet(ctx, 'connection')
  if (!connection || typeof connection.requestRejection !== 'function') return false
  try {
    return connection.requestRejection({ headers: req.headers }) !== undefined
  } catch {
    return false
  }
}

function safeGet(ctx, name) {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

function readEnv(name) {
  const env = typeof process !== 'undefined' ? process.env : undefined
  const value = env ? env[name] : undefined
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function readJsonBody(req) {
  return new Promise(resolve => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        resolve({})
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

function sendJson(res, status, value) {
  try {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(value))
  } catch {
    /* the peer may already be gone */
  }
}

/**
 * Novita (and anything else that reports minor units) hands back integer
 * ten-thousandths of a dollar: "10000" is $1.00. Dividing is not cosmetic —
 * skipping it renders a $100 balance as "$1000000.00".
 */
function toUsd(value) {
  if (value === undefined || value === null || value === '') return undefined
  const units = Number(value)
  if (!Number.isFinite(units)) return undefined
  return (units / 10000).toFixed(2)
}

/** Money strings come from provider APIs; add them as decimals, print 2 places. */
function sumAmounts(amounts) {
  let total = 0
  let seen = false
  for (const amount of amounts) {
    const parsed = Number(amount)
    if (!Number.isFinite(parsed)) continue
    total += parsed
    seen = true
  }
  return seen ? total.toFixed(2) : undefined
}

/**
 * The provider's own one-line complaint, when it sent one inside JSON
 * (`{"code":30014,"message":"Token is invalid."}`). Long or non-JSON bodies
 * give nothing: the caller already shows the status code.
 */
function providerMessage(text) {
  try {
    const json = JSON.parse(text)
    const message = json?.message ?? json?.error?.message ?? json?.error
    if (typeof message !== 'string') return undefined
    const value = message.trim()
    if (value === '' || value.length > 48) return undefined
    return value
  } catch {
    return undefined
  }
}

function clip(text) {
  const value = typeof text === 'string' ? text.trim() : ''
  return value.length > 300 ? `${value.slice(0, 300)}…` : value
}

function messageOf(error) {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : 'unknown error'
}

/** Stop waiting on a promise that a Host service may never settle. */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms)
    Promise.resolve(promise).then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
