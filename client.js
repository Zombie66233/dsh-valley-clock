/**
 * Client half of the DeepSeek pricing widget.
 *
 * Draws one control into the session header's right-aligned utilities row —
 * the row that already carries the Host's own "session log" capsule — and a
 * portaled popover anchored under it. Everything the popover needs beyond the
 * clock comes from the package's own Host route (see `index.js`); everything
 * the clock needs is computed here, because a per-second value must not cross
 * the wire.
 *
 * Placement note: the popover is portaled to `document.body` and positioned
 * from the button's viewport rect. An `position: absolute` child of the header
 * row would be clipped by the header's own truncation rules.
 *
 * Styling note: the essential geometry and colour come from theme tokens as
 * INLINE styles, and the stylesheet only adds hover/focus/transition. A client
 * half that cannot reach the `styles` builtin still renders a correct card
 * instead of an unstyled block at the end of the page.
 */
window.__ModuleLoader__.load({
  id: 'dsh-valley-clock',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** `react-dom` is a seeded platform external; degrade to inline if absent. */
    let createPortal = null
    try {
      const reactDom = require('react-dom')
      if (reactDom && typeof reactDom.createPortal === 'function') createPortal = reactDom.createPortal
    } catch {
      createPortal = null
    }

    /** `styles` is a dynamic-client builtin; absent in a bare test composition. */
    const stylesApi = (typeof styles !== 'undefined' && styles && typeof styles.insert === 'function')
      ? styles
      : undefined

    const NS = 'valleyClock'
    const SLOT = 'conversation.session.header.utilities'
    /** Schedule: in-process on the Host, instant. */
    const STATUS_ROUTE = 'valley-clock/status'
    /** Wallet: as slow as the provider makes it, on its own request. */
    const BALANCE_ROUTE = 'valley-clock/balance'
    /**
     * Backoff while the schedule is still unknown. Starts at 250 ms because the
     * usual cause is a restart race (route not registered yet), which resolves
     * almost immediately; widens only if the Host keeps failing.
     */
    const RETRY_RAMP = [250, 500, 1000, 2000, 4000, 8000, 15000, 60000]

    /**
     * Why the last status request came back empty — a devtools breadcrumb only,
     * never shown in the UI. `HTTP 404` here means the startup race; `403` means
     * the connection gate; `AbortError` means the request hung.
     */
    let statusTrouble = 'no answer yet'
    function noteTrouble(note) {
      statusTrouble = note
    }
    function lastNote() {
      return statusTrouble
    }
    function reportStatusTrouble(note) {
      if (typeof console === 'undefined' || typeof console.error !== 'function') return
      console.error(`[valley-clock] status still unavailable after 3 attempts: ${note}`)
    }

    /**
     * Does this answer actually name the session's channel?
     *
     * A missing provider is unknown. So is one borrowed from the profile
     * DEFAULT (`routeSource: 'default'`) — that is where a new session would
     * start, not what an existing conversation is billed at, so treating it as
     * fact labelled DeepSeek sessions with a relay provider during the startup
     * hydration window. Unknown keeps the retry ramp fast and the clock neutral,
     * which is the honest answer until the session speaks for itself.
     */
    function routeUnknown(value) {
      if (!value) return true
      if (value.provider == null) return true
      return value.routeSource === 'default'
    }

    /** 9:00-12:00 and 14:00-18:00 Beijing time are peak (minutes of the day). */
    const PEAK_WINDOWS = [[9 * 60, 12 * 60], [14 * 60, 18 * 60]]
    const SHANGHAI_OFFSET_MS = 8 * 3600 * 1000

    const ZH = {
      buttonTitle: '北京时间 · DeepSeek 峰谷时段',
      open: '打开北京时间与 API 用量',
      panelTitle: '北京时间与 API 用量',
      peak: '高峰时段',
      offPeak: '空闲时段',
      peakHint: '按标准价计费',
      offPeakHint: '价格为高峰时段的一半',
      nextPeak: '距高峰开始',
      nextOffPeak: '距空闲开始',
      modelLabel: '当前模型',
      balanceLabel: 'API 余额',
      balanceLoading: '读取中…',
      balanceUnsupported: '当前调用的 API 不支持显示余额',
      balanceNoKey: '未找到该服务的 API Key',
      balanceRetired: '该服务已下线余额接口',
      balanceError: '余额读取失败',
      errParse: '响应无法解析',
      errFields: '响应里没有余额字段',
      errTimeout: '请求超时',
      errNetwork: '网络错误',
      notDeepseek: '非 DeepSeek 官方通道，不适用峰谷价',
      tableEnded: '作者只维护到 {year} 年，之后不再判断峰谷时段',
      weekend: '周末',
      holiday: '法定节假日',
      unknown: '未知',
      walletToppedUp: '充值',
      walletGranted: '赠送',
      walletWallet: '账户',
      walletUsed: '已用',
      unitDay: '天',
      unitHour: '小时',
      unitMinute: '分',
    }

    const EN = {
      buttonTitle: 'Beijing time · DeepSeek peak/off-peak',
      open: 'Open Beijing time and API usage',
      panelTitle: 'Beijing time and API usage',
      peak: 'Peak hours',
      offPeak: 'Off-peak hours',
      peakHint: 'billed at the standard rate',
      offPeakHint: 'billed at half the peak rate',
      nextPeak: 'Peak starts in',
      nextOffPeak: 'Off-peak starts in',
      modelLabel: 'Model',
      balanceLabel: 'API balance',
      balanceLoading: 'Loading…',
      balanceUnsupported: 'The current API does not expose a balance',
      balanceNoKey: 'No API key found for this provider',
      balanceRetired: 'this provider retired its balance endpoint',
      balanceError: 'Could not read the balance',
      errParse: 'unparseable response',
      errFields: 'no balance field in the response',
      errTimeout: 'request timed out',
      errNetwork: 'network error',
      notDeepseek: 'Not the official DeepSeek route; peak pricing does not apply',
      tableEnded: 'the holiday table stops at {year}; peak pricing is no longer judged',
      weekend: 'weekend',
      holiday: 'public holiday',
      unknown: 'unknown',
      walletToppedUp: 'topped up',
      walletGranted: 'granted',
      walletWallet: 'wallet',
      walletUsed: 'used',
      unitDay: 'd',
      unitHour: 'h',
      unitMinute: 'm',
    }

    const WALLET_KEYS = {
      toppedUp: 'walletToppedUp',
      granted: 'walletGranted',
      wallet: 'walletWallet',
      used: 'walletUsed',
    }

    /** Essential layout/colour, inline so it never depends on the stylesheet. */
    const S = {
      root: { display: 'inline-flex', alignItems: 'center' },
      button: color => ({
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        height: '28px',
        padding: '0 9px',
        borderRadius: '8px',
        border: '1px solid transparent',
        background: 'transparent',
        font: 'inherit',
        fontSize: '12px',
        lineHeight: 1,
        color,
        fontVariantNumeric: 'tabular-nums',
        letterSpacing: '0.03em',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }),
      panel: {
        position: 'fixed',
        zIndex: 999,
        width: '268px',
        boxSizing: 'border-box',
        padding: '14px 14px 12px',
        borderRadius: '12px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-overlay)',
        boxShadow: '0 16px 36px -18px var(--dsw-alias-border-l2)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: '12px',
        lineHeight: 1.5,
        textAlign: 'left',
      },
      clock: color => ({
        fontSize: '26px',
        fontWeight: 600,
        letterSpacing: '0.04em',
        fontVariantNumeric: 'tabular-nums',
        color,
      }),
      state: color => ({ marginTop: '2px', fontSize: '12px', color }),
      notice: { marginTop: '2px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
      hint: { marginTop: '4px', color: 'var(--dsw-alias-label-secondary)', fontSize: '11px' },
      divider: { height: '1px', margin: '10px 0', background: 'var(--dsw-alias-border-l1)' },
      row: {
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: '12px',
        padding: '3px 0',
      },
      key: { color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
      value: { textAlign: 'right', wordBreak: 'break-word', fontVariantNumeric: 'tabular-nums' },
      detail: {
        display: 'block',
        marginTop: '2px',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '11px',
      },
    }

    const CSS = `
.dpw-btn:hover { background: var(--dsw-alias-bg-layer-2); }
.dpw-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dpw-btn { transition: background-color 120ms ease, border-color 120ms ease; }
`

    // -- time -------------------------------------------------------------

    /** Reused: constructing an Intl formatter per call is the expensive part. */
    let partsFormatter
    function getPartsFormatter() {
      if (!partsFormatter) {
        partsFormatter = new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Asia/Shanghai',
          hourCycle: 'h23',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          weekday: 'short',
        })
      }
      return partsFormatter
    }

    /** Beijing wall-clock parts for one instant, independent of the local zone. */
    function zonedParts(date) {
      const parts = {}
      for (const part of getPartsFormatter().formatToParts(date)) {
        if (part.type !== 'literal') parts[part.type] = part.value
      }
      return {
        year: Number(parts.year),
        month: Number(parts.month),
        day: Number(parts.day),
        hour: Number(parts.hour),
        minute: Number(parts.minute),
        second: Number(parts.second),
        weekday: parts.weekday,
      }
    }

    function pad2(value) {
      return String(value).padStart(2, '0')
    }

    /** Peak/off-peak for one instant under the supplied holiday table. */
    function statusAt(ms, holidaySet) {
      const parts = zonedParts(new Date(ms))
      const iso = `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`
      const weekend = parts.weekday === 'Sat' || parts.weekday === 'Sun'
      const holiday = holidaySet.has(iso)
      const minutes = parts.hour * 60 + parts.minute
      const inWindow = PEAK_WINDOWS.some(edge => minutes >= edge[0] && minutes < edge[1])
      return { peak: !weekend && !holiday && inWindow, weekend, holiday, iso, minutes }
    }

    /**
     * The next instant the peak status flips. Status can only change at a
     * window edge or at midnight (a weekday/holiday boundary), so a bounded
     * scan over exactly those instants is both exact and cheap enough to redo
     * once a minute.
     */
    function nextSwitchAt(nowMs, holidaySet) {
      const current = statusAt(nowMs, holidaySet).peak
      const shifted = new Date(nowMs + SHANGHAI_OFFSET_MS)
      const year = shifted.getUTCFullYear()
      const month = shifted.getUTCMonth()
      const day = shifted.getUTCDate()
      const edges = [0, 9, 12, 14, 18]
      for (let offset = 0; offset <= 11; offset += 1) {
        for (const hour of edges) {
          const candidate = Date.UTC(year, month, day + offset, hour, 0, 0) - SHANGHAI_OFFSET_MS
          if (candidate <= nowMs) continue
          if (statusAt(candidate, holidaySet).peak !== current) return candidate
        }
      }
      return undefined
    }

    /** The package's own Host route, resolved against the page base. */
    function routeUrl(path) {
      const base = (typeof document !== 'undefined' && document.baseURI)
        || (typeof location !== 'undefined' ? location.href : 'http://dsh.internal/')
      const url = new URL(base)
      url.search = ''
      url.hash = ''
      if (!url.pathname.endsWith('/')) url.pathname = url.pathname.replace(/[^/]*$/, '')
      return new URL(path.replace(/^\/+/, ''), url.href).href
    }

    // -- component --------------------------------------------------------

    function PricingWidget(props) {
      const locale = props && props.__locale
      const tr = React.useMemo(() => makeTranslator(locale), [locale])
      const t = key => tr(key) ?? key
      const sessionId = props && typeof props.sessionId === 'string' ? props.sessionId : undefined

      const [now, setNow] = React.useState(() => Date.now())
      const [status, setStatus] = React.useState(null)
      const [wallet, setWallet] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [placement, setPlacement] = React.useState(null)
      const [, setLocaleTick] = React.useState(0)
      const buttonRef = React.useRef(null)
      const panelRef = React.useRef(null)
      /** One wallet request in flight at a time. */
      const walletBusy = React.useRef(false)
      /** Latest status, for the wake-up listeners below. */
      const statusRef = React.useRef(null)
      statusRef.current = status

      // One tick per second: the only per-second cost is one Intl format call.
      React.useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
      }, [])

      // Follow the active locale live instead of freezing the first render.
      React.useEffect(() => {
        if (!locale || typeof locale.subscribe !== 'function') return undefined
        return locale.subscribe(() => setLocaleTick(tick => tick + 1))
      }, [locale])

      /**
       * One POST, one JSON answer, or `undefined` on any failure. The timeout is
       * a backstop only: both routes are bounded on the Host side.
       */
      const requestJson = React.useCallback((path, timeoutMs) => {
        let cancelled = false
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        const done = (async () => {
          try {
            const response = await fetch(routeUrl(path), {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId: sessionId ?? null }),
              signal: controller.signal,
            })
            // A 404 here is normal during startup (see the retry ramp below).
            if (!response.ok) {
              if (path === STATUS_ROUTE) noteTrouble(`HTTP ${response.status}`)
              return undefined
            }
            const value = await response.json()
            if (!value || value.ok !== true) {
              if (path === STATUS_ROUTE) noteTrouble('malformed payload')
              return undefined
            }
            if (path === STATUS_ROUTE) noteTrouble('ok')
            return value
          } catch (error) {
            if (path === STATUS_ROUTE) {
              noteTrouble(error && error.name ? String(error.name) : 'network error')
            }
            return undefined
          } finally {
            clearTimeout(timer)
          }
        })()
        return {
          done,
          cancel() {
            cancelled = true
            clearTimeout(timer)
            controller.abort()
          },
          get cancelled() {
            return cancelled
          },
        }
      }, [sessionId])

      /**
       * The schedule half — computed in-process, so it answers in milliseconds.
       * A failure here must not silence the clock for a whole minute, hence the
       * short retry in the poll loop below.
       */
      const loadStatus = React.useCallback(() => {
        const call = requestJson(STATUS_ROUTE, 5000)
        void call.done.then(value => {
          if (call.cancelled || value === undefined) return
          setStatus(value)
        })
        return call.cancel
      }, [requestJson])

      /** The wallet half — allowed to be slow, never allowed to block the clock. */
      const loadWallet = React.useCallback(() => {
        // A cold wallet can take seconds. Do not abort it every 5 s just because
        // the schedule is still settling: skip this round instead.
        if (walletBusy.current) return () => {}
        walletBusy.current = true
        const call = requestJson(BALANCE_ROUTE, 30000)
        void call.done
          .then(value => {
            if (call.cancelled || value === undefined) return
            setWallet(value)
          })
          .finally(() => {
            walletBusy.current = false
          })
        return () => {
          walletBusy.current = false
          call.cancel()
        }
      }, [requestJson])

      /**
       * One loop for both halves.
       *
       * The retry chain is scheduled BEFORE the answer is known, and refined
       * once it arrives. That ordering is the whole point: an earlier version
       * awaited first and only then armed the next timer, so a single request
       * that never settled ended the chain — the clock stayed neutral until
       * something else (a click) asked again. A timer that exists regardless of
       * the promise is what makes the loop unkillable.
       *
       * Fast start: the web carrier listens before every plugin has registered
       * its routes, so during startup an unknown path is answered by the
       * fallback handler with 404. 250 ms is enough to cover that race.
       */
      React.useEffect(() => {
        let stopped = false
        let timer = null
        let current = null
        let attempt = 0

        /** Replace the pending retry; the chain always holds a live timer. */
        const schedule = delay => {
          if (timer !== null) clearTimeout(timer)
          timer = setTimeout(step, delay)
        }

        const step = () => {
          if (stopped) return
          if (current) current.cancel()
          const call = requestJson(STATUS_ROUTE, 5000)
          current = call
          // Provisional: assume the worst, keep trying while we wait.
          schedule(RETRY_RAMP[Math.min(attempt, RETRY_RAMP.length - 1)])
          // The wallet rides along; it must never gate the schedule.
          loadWallet()
          void call.done.then(value => {
            if (stopped || call.cancelled) return
            if (value !== undefined) setStatus(value)
            const unknown = value === undefined || routeUnknown(value)
            attempt = unknown ? attempt + 1 : 0
            if (unknown && attempt === 3) {
              // Either the request never answers (404 during startup, the
              // connection gate, a hang) or it answers without a routable
              // session. Those are different bugs; the note says which.
              reportStatusTrouble(value === undefined
                ? lastNote()
                : `answered without a route (provider=${String(value.provider)}, model=${String(value.model)})`)
            }
            // Refine with the outcome in hand: healthy means a minute away.
            schedule(unknown
              ? RETRY_RAMP[Math.min(attempt - 1, RETRY_RAMP.length - 1)]
              : 60 * 1000)
          })
        }

        step()

        /**
         * A browser throttles timers in a hidden window — heavily enough that a
         * 250 ms retry can be parked until the user touches the page, which then
         * looks exactly like "I have to click before it turns green" (and every
         * mounted clock green-stamps at once, because they were all queued).
         * So: whenever the page becomes visible or focused, retry immediately
         * instead of waiting for the parked timer.
         */
        const wake = () => {
          if (stopped) return
          if (routeUnknown(statusRef.current)) step()
        }
        const onVisibility = () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'visible') wake()
        }
        if (typeof document !== 'undefined') {
          document.addEventListener('visibilitychange', onVisibility)
          // Same idea one step earlier: the first interaction with the page is
          // the moment the user is looking at it, so spend it on a retry rather
          // than on waiting for a parked timer.
          document.addEventListener('pointerdown', wake, true)
        }
        if (typeof window !== 'undefined') window.addEventListener('focus', wake)

        return () => {
          stopped = true
          if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', onVisibility)
            document.removeEventListener('pointerdown', wake, true)
          }
          if (typeof window !== 'undefined') window.removeEventListener('focus', wake)
          if (timer !== null) clearTimeout(timer)
          if (current) current.cancel()
        }
      }, [requestJson, loadWallet])

      // Opening re-reads once: a top-up or a model switch should show up now,
      // not on the next minute's poll (the Host caches the wallet for minutes).
      React.useEffect(() => {
        if (!open) return undefined
        const cancelStatus = loadStatus()
        const cancelWallet = loadWallet()
        return () => {
          cancelStatus()
          cancelWallet()
        }
      }, [open, loadStatus, loadWallet])

      const holidaySet = React.useMemo(() => {
        const list = status && Array.isArray(status.holidays) ? status.holidays : []
        return new Set(list)
      }, [status])

      const parts = zonedParts(new Date(now))
      const minuteKey = Math.floor(now / 60000)
      const switchAt = React.useMemo(() => nextSwitchAt(now, holidaySet), [minuteKey, holidaySet])
      const state = React.useMemo(() => statusAt(now, holidaySet), [minuteKey, holidaySet])

      const routeKnown = Boolean(status) && !routeUnknown(status)
      const isDeepseek = routeKnown && status.deepseek === true
      // The holiday table only speaks for the years it lists. Past its newest
      // year the schedule is unknowable, so the clock stops asserting one —
      // same treatment as a non-official channel, different sentence. An older
      // Host that does not send the field yet keeps the previous behaviour.
      const coveredThrough = status && typeof status.coveredThrough === 'number'
        ? status.coveredThrough
        : undefined
      const covered = coveredThrough === undefined || parts.year <= coveredThrough
      const scheduled = isDeepseek && covered
      const timeColor = scheduled
        ? (state.peak ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)')
        : 'var(--dsw-alias-label-primary)'
      const clockText = `${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}`
      // While the schedule cannot be read, say WHY in the tooltip. A neutral
      // clock with no explanation is indistinguishable from a broken widget,
      // and this is the one place a report can come from without devtools.
      const unsettled = !routeKnown
      const buttonTitle = unsettled
        ? `${t('buttonTitle')} · ${lastNote() === 'ok' ? 'no route' : lastNote()}`
        : t('buttonTitle')

      // Measure the anchor after the panel exists — in a layout effect, so the
      // first paint already has the final position.
      React.useLayoutEffect(() => {
        if (!open) {
          setPlacement(null)
          return undefined
        }
        const update = () => {
          const button = buttonRef.current
          if (!button) return
          const rect = button.getBoundingClientRect()
          const margin = 8
          const width = panelRef.current ? panelRef.current.offsetWidth : 268
          const rawRight = window.innerWidth - rect.right
          const right = Math.max(margin, Math.min(rawRight, window.innerWidth - width - margin))
          setPlacement({ top: Math.round(rect.bottom + 8), right: Math.round(right) })
        }
        update()
        window.addEventListener('resize', update)
        window.addEventListener('scroll', update, true)
        return () => {
          window.removeEventListener('resize', update)
          window.removeEventListener('scroll', update, true)
        }
      }, [open])

      // Dismissal: anywhere outside, Escape, or the window losing focus.
      React.useEffect(() => {
        if (!open) return undefined
        const onPointerDown = event => {
          const target = event.target
          if (panelRef.current && panelRef.current.contains(target)) return
          if (buttonRef.current && buttonRef.current.contains(target)) return
          setOpen(false)
        }
        const onKeyDown = event => {
          if (event.key === 'Escape') setOpen(false)
        }
        const onBlur = () => setOpen(false)
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        window.addEventListener('blur', onBlur)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
          window.removeEventListener('blur', onBlur)
        }
      }, [open])

      const reason = state.holiday ? t('holiday') : (state.weekend ? t('weekend') : '')
      const statusText = state.peak ? t('peak') : t('offPeak')
      const statusHint = state.peak ? t('peakHint') : t('offPeakHint')
      // The next edge is always the OPPOSITE of where we are now: inside a peak
      // window the countdown leads to off-peak, and vice versa.
      const nextLabel = state.peak ? t('nextOffPeak') : t('nextPeak')
      const nextText = switchAt === undefined ? '—' : formatDelta(switchAt - now, t)

      const panel = h('div', {
        ref: panelRef,
        className: 'dpw-panel',
        role: 'dialog',
        'aria-label': t('panelTitle'),
        style: placement
          ? Object.assign({}, S.panel, { top: `${placement.top}px`, right: `${placement.right}px` })
          : Object.assign({}, S.panel, { top: '0px', right: '0px', visibility: 'hidden' }),
      },
      h('div', { style: S.clock(timeColor) }, clockText),
      // Only the official DeepSeek route reads the schedule. Every other route
      // gets one notice in the SAME seat — replacing the peak/off-peak reading
      // rather than adding a remark beside the model and balance rows, because
      // there is no countdown and no half-price rule on those routes at all.
      // A route the table has run out of years for gets the same treatment: no
      // reading, no countdown, a sentence saying why.
      // A route we have not identified yet says NOTHING here. Claiming "not the
      // official DeepSeek route" from a guess is worse than staying quiet.
      routeKnown
        ? (isDeepseek
          ? (covered
            ? h('div', { style: S.state(timeColor) }, `${statusText}${reason ? ` · ${reason}` : ''}`)
            : h('div', { style: S.notice }, t('tableEnded').replace('{year}', String(coveredThrough))))
          : h('div', { style: S.notice }, t('notDeepseek')))
        : null,
      scheduled
        ? h('div', { style: S.hint }, `${statusHint}${switchAt === undefined ? '' : ` · ${nextLabel} ${nextText}`}`)
        : null,
      h('div', { style: S.divider }),
      h(Row, { label: t('modelLabel'), value: routeKnown ? modelText(status, t) : t('unknown') }),
      h(Row, {
        label: t('balanceLabel'),
        value: routeKnown ? balanceText(status, wallet, tr, t) : t('balanceLoading'),
      }),
      )

      return h('div', { style: S.root },
        h('button', {
          ref: buttonRef,
          type: 'button',
          className: 'dpw-btn',
          style: S.button(timeColor),
          title: buttonTitle,
          'aria-haspopup': 'dialog',
          'aria-expanded': open ? 'true' : 'false',
          'aria-label': t('open'),
          onClick: () => setOpen(current => !current),
        }, clockText),
        open ? (createPortal ? createPortal(panel, document.body) : panel) : null,
      )
    }

    function Row(props) {
      return h('div', { style: S.row },
        h('span', { style: S.key }, props.label),
        h('span', { style: S.value }, props.value),
      )
    }

    function modelText(status, t) {
      if (!status) return t('unknown')
      const model = typeof status.model === 'string' && status.model !== '' ? status.model : undefined
      const provider = typeof status.provider === 'string' && status.provider !== '' ? status.provider : undefined
      return model ?? provider ?? t('unknown')
    }

    function balanceText(status, wallet, tr, t) {
      // `status.balance` only exists on a Host that still answers in one piece
      // (the pre-split shape) — keeping the fallback makes a page that reloaded
      // before the Host restart show the number instead of "loading" forever.
      const balance = (wallet && wallet.balance) ?? (status && status.balance)
      if (!balance) return t('balanceLoading')
      if (balance.supported === true) {
        const symbol = balance.currency === 'USD' ? '$' : '¥'
        const detail = Array.isArray(balance.detail) ? balance.detail : []
        const detailText = detail
          .map(item => {
            const key = WALLET_KEYS[item.key]
            const label = (key ? tr(key) : undefined) ?? item.key
            return `${label} ${formatAmount(item.amount)}`
          })
          .join(' · ')
        return h(React.Fragment, null,
          `${symbol}${formatAmount(balance.total)}`,
          detailText ? h('span', { style: S.detail }, detailText) : null,
        )
      }
      if (balance.reason === 'unsupported') return t('balanceUnsupported')
      if (balance.reason === 'no-key') return t('balanceNoKey')
      // 410/404 from the provider is not a failure of ours: the endpoint is gone.
      if (balance.reason === 'retired') return `${t('balanceRetired')}${failureSuffix(balance, t)}`
      return `${t('balanceError')}${failureSuffix(balance, t)}`
    }

    /**
     * Why the balance could not be read, on the same line. Without it every
     * failure reads as one identical sentence, and a rejected key cannot be
     * told apart from an account that exposes no balance at all.
     */
    function failureSuffix(balance, t) {
      const parts = []
      if (balance.reason === 'http' || balance.reason === 'retired') {
        if (balance.status) parts.push(`HTTP ${balance.status}`)
      } else if (balance.reason === 'parse') {
        parts.push(t('errParse'))
      } else if (balance.reason === 'fields') {
        parts.push(t('errFields'))
      } else if (balance.reason === 'timeout') {
        parts.push(t('errTimeout'))
      } else if (balance.reason === 'network') {
        parts.push(t('errNetwork'))
      }
      if (typeof balance.detail === 'string' && balance.detail !== '') parts.push(balance.detail)
      return parts.length === 0 ? '' : ` · ${parts.join(' · ')}`
    }

    /** Keep provider-supplied money strings readable without reformatting them. */
    function formatAmount(value) {
      if (value === undefined || value === null || value === '') return '—'
      const text = String(value)
      if (!/^-?\d+(\.\d+)?$/.test(text)) return text
      const number = Number(text)
      if (!Number.isFinite(number)) return text
      return number.toFixed(2)
    }

    function formatDelta(ms, t) {
      const totalMinutes = Math.max(0, Math.round(ms / 60000))
      const days = Math.floor(totalMinutes / 1440)
      const hours = Math.floor((totalMinutes % 1440) / 60)
      const minutes = totalMinutes % 60
      if (days > 0) return `${days}${t('unitDay')} ${hours}${t('unitHour')}`
      if (hours > 0) return `${hours}${t('unitHour')} ${minutes}${t('unitMinute')}`
      return `${Math.max(1, minutes)}${t('unitMinute')}`
    }

    /** Bound translator: falls back to the Chinese table when a key is absent. */
    function makeTranslator(locale) {
      let bound
      if (locale && typeof locale.bind === 'function') {
        try {
          bound = locale.bind(NS)
        } catch {
          bound = undefined
        }
      }
      return key => {
        if (typeof bound === 'function') {
          try {
            const value = bound(key)
            if (typeof value === 'string' && value !== '' && value !== key) return value
          } catch { /* fall through to the bundled table */ }
        }
        return ZH[key]
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const locale = ctx.locale ?? null

        if (stylesApi) {
          ctx.effect(() => stylesApi.insert(CSS), 'valley-clock: styles')
        }

        if (locale && typeof locale.register === 'function') {
          ctx.effect(() => {
            const offZh = locale.register(NS, 'zh', ZH)
            const offEn = locale.register(NS, 'en', EN)
            return () => {
              offZh()
              offEn()
            }
          }, 'valley-clock: dictionaries')
        }

        ctx.slots.inject(SLOT, () => ctx.slots.register({
          name: SLOT,
          id: 'valley-clock',
          order: 60,
          label: () => '北京时间',
        }, props => h(PricingWidget, Object.assign({}, props, { __locale: locale }))))
      },
    }
  },
})
