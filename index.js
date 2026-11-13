// Host half of dsh-schedule-send: turns the composer panel's intent (send after
// this turn, every N minutes, or at a clock time) into a Host Schedule task whose
// target is the conversation the panel was opened in. Delivery is the Harness's
// own scheduled-message path, so the message reaches the agent exactly like a
// message the user typed and submitted.
export const inject = ['schedule', 'webServer']

const BASE_PATH = '/api/dsh-schedule-send'
const MAX_BODY = 256 * 1024
const MAX_TASKS = 200
const WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
const WEEKDAY_NAMES = { MO: '一', TU: '二', WE: '三', TH: '四', FR: '五', SA: '六', SU: '日' }

// ── HTTP plumbing ─────────────────────────────────────────────────────────────

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求内容太大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// ── timing construction ───────────────────────────────────────────────────────

function pad2(value) {
  return String(value).padStart(2, '0')
}

function resolveZone(requested) {
  if (typeof requested === 'string' && /^[A-Za-z][A-Za-z0-9_+\-/]{0,60}$/.test(requested)) return requested
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (typeof zone === 'string' && zone.length > 0) return zone
  } catch {
    // fall through to the default below
  }
  return 'Asia/Shanghai'
}

function localStamp(date) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}T${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`
}

function parseClock(raw) {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(raw ?? '').trim())
  if (!match) throw new Error('时间格式应为 HH:mm 或 HH:mm:ss')
  const hours = Number(match[1])
  const minutes = Number(match[2])
  const seconds = match[3] === undefined ? 0 : Number(match[3])
  if (hours > 23 || minutes > 59 || seconds > 59) throw new Error('时间超出范围')
  return { hours, minutes, seconds }
}

/** The Schedule service wants whole seconds in clock times, so never send HH:mm. */
function clockText({ hours, minutes, seconds }) {
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`
}

function parseDate(raw) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw ?? '').trim())
  if (!match) throw new Error('日期格式应为 YYYY-MM-DD')
  return `${match[1]}-${match[2]}-${match[3]}`
}

/** Next future instant at a local clock time, used as an RRULE DTSTART anchor. */
function nextClockAnchor(hours, minutes, monthDay) {
  const now = new Date()
  const candidate = new Date(now.getFullYear(), now.getMonth(), monthDay ?? now.getDate(), hours, minutes, 0, 0)
  if (candidate.getTime() <= now.getTime()) {
    candidate.setDate(candidate.getDate() + 1)
  }
  return candidate
}

function integer(raw, fallback, min, max, label) {
  const value = Number(raw)
  if (!Number.isFinite(value)) return fallback
  const rounded = Math.floor(value)
  if (rounded < min || rounded > max) throw new Error(`${label}需要在 ${min} 到 ${max} 之间`)
  return rounded
}

/**
 * Build one ScheduleTiming from the panel's mode request. The panel sends intent
 * only; the exact rule (and therefore the time zone handling) is decided here.
 */
function buildTiming(body) {
  const mode = String(body.mode ?? '')
  const zone = resolveZone(body.zone)

  if (mode === 'after-turn') {
    // Delivery to this Session is queued behind whatever the Session is doing, so
    // one second here means "as soon as the running turn is over".
    return { kind: 'after', after_seconds: 1 }
  }

  if (mode === 'interval') {
    const hours = integer(body.hours, 0, 0, 168, '小时')
    const minutes = integer(body.minutes, 0, 0, 59, '分钟')
    const total = hours * 60 + minutes
    if (total < 1) throw new Error('间隔至少 1 分钟')
    const count = integer(body.count, 1, 1, 999, '循环次数')
    const start = new Date(Date.now() + total * 60000)
    const rule = `DTSTART;TZID=${zone}:${localStamp(start)}\nRRULE:FREQ=MINUTELY;INTERVAL=${total};COUNT=${count}`
    return { kind: 'rrule', rrule: rule }
  }

  if (mode === 'clock') {
    const clock = parseClock(body.time)
    const { hours, minutes } = clock
    const repeat = String(body.repeat ?? 'none')

    if (repeat === 'none') {
      const date = parseDate(body.date)
      return { kind: 'at', at: { date, time: clockText(clock), time_zone: zone } }
    }

    if (repeat === 'daily') {
      return { kind: 'daily', daily: { time: clockText(clock), time_zone: zone } }
    }

    if (repeat === 'weekly') {
      const raw = Array.isArray(body.weekdays) ? body.weekdays : []
      const days = []
      for (const item of raw) {
        const index = Number(item)
        if (!Number.isInteger(index) || index < 0 || index > 6) continue
        const code = WEEKDAY_CODES[index]
        if (!days.includes(code)) days.push(code)
      }
      if (days.length === 0) throw new Error('至少选择一个星期几')
      const anchor = nextClockAnchor(hours, minutes)
      const rule = `DTSTART;TZID=${zone}:${localStamp(anchor)}\nRRULE:FREQ=WEEKLY;BYDAY=${days.join(',')};BYHOUR=${hours};BYMINUTE=${minutes};BYSECOND=0`
      return { kind: 'rrule', rrule: rule }
    }

    if (repeat === 'monthly') {
      const day = integer(body.monthDay, 1, 1, 31, '每月几号')
      const anchor = nextClockAnchor(hours, minutes)
      const rule = `DTSTART;TZID=${zone}:${localStamp(anchor)}\nRRULE:FREQ=MONTHLY;BYMONTHDAY=${day};BYHOUR=${hours};BYMINUTE=${minutes};BYSECOND=0`
      return { kind: 'rrule', rrule: rule }
    }

    throw new Error('不支持的重复方式')
  }

  throw new Error('不支持的发送方式')
}

// ── schedule records → panel rows ─────────────────────────────────────────────

function summarize(item) {
  return {
    id: item.id,
    title: item.title,
    prompt: item.prompt,
    kind: item.kind,
    status: item.status,
    scheduledAt: item.scheduledAt,
    updatedAt: item.updatedAt ?? null,
    sessionId: item.target && item.target.kind === 'session' ? item.target.sessionId : null,
  }
}

function shortClock(raw) {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(raw ?? '').trim())
  return match ? `${pad2(match[1])}:${match[2]}` : String(raw ?? '')
}

function minuteSpan(minutes) {
  if (minutes < 60) return `${minutes} 分钟`
  if (minutes % 60 === 0) return `${minutes / 60} 小时`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`
}

function describeRrule(raw) {
  const text = String(raw ?? '')
  const pick = (pattern) => {
    const found = pattern.exec(text)
    return found ? found[1] : ''
  }
  const freq = pick(/FREQ=([A-Z]+)/)
  const interval = pick(/INTERVAL=(\d+)/)
  const count = pick(/COUNT=(\d+)/)
  const byDay = pick(/BYDAY=([A-Z,]+)/)
  const byHour = pick(/BYHOUR=(\d+)/)
  const byMinute = pick(/BYMINUTE=(\d+)/)
  const byMonthDay = pick(/BYMONTHDAY=(\d+)/)
  const clock = byHour !== '' && byMinute !== '' ? `${pad2(byHour)}:${pad2(byMinute)}` : ''
  const times = count !== '' ? `，共 ${count} 次` : ''

  if (freq === 'MINUTELY') return `每 ${minuteSpan(Number(interval || '1'))}${times}`
  if (freq === 'HOURLY') return `每 ${Number(interval || '1')} 小时${times}`
  if (freq === 'WEEKLY' && byDay !== '') {
    const names = byDay.split(',').map((code) => WEEKDAY_NAMES[code] ?? code).join('、')
    return `每周${names} ${clock}${times}`
  }
  if (freq === 'MONTHLY' && byMonthDay !== '') return `每月 ${byMonthDay} 号 ${clock}${times}`
  if (freq === 'DAILY') return `每天 ${clock}${times}`
  return text
}

function describeTiming(item) {
  if (typeof item.expression === 'string' && item.expression.length > 0) return `cron ${item.expression}`
  if (typeof item.rrule === 'string' && item.rrule.length > 0) return describeRrule(item.rrule)
  if (typeof item.date === 'string' && typeof item.time === 'string') {
    return `${item.date} ${shortClock(item.time)}`
  }
  if (typeof item.time === 'string') {
    const clock = shortClock(item.time)
    if (item.kind === 'weekly' && Array.isArray(item.weekdays)) {
      const names = item.weekdays.map((day) => WEEKDAY_NAMES[day] ?? String(day)).join('、')
      return `每周${names} ${clock}`
    }
    if (item.kind === 'monthly' && typeof item.monthDay === 'number') return `每月 ${item.monthDay} 号 ${clock}`
    if (item.kind === 'daily') return `每天 ${clock}`
    return clock
  }
  if (typeof item.everySeconds === 'number') return `每 ${minuteSpan(Math.max(1, Math.round(item.everySeconds / 60)))}`
  if (typeof item.afterSeconds === 'number') return '本轮结束后'
  return ''
}

// ── plugin ────────────────────────────────────────────────────────────────────

export function apply(ctx) {
  const schedule = ctx.schedule

  const handleList = async (req, res) => {
    try {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: '不支持的请求方法' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const sessionId = (url.searchParams.get('sessionId') ?? '').trim()
      if (sessionId.length === 0) {
        sendJson(res, 400, { ok: false, error: '缺少 sessionId' })
        return
      }
      const page = await schedule.list({ active: true, limit: MAX_TASKS, offset: 0 })
      const items = Array.isArray(page.items) ? page.items : []
      const mine = items
        .filter((item) => item.target && item.target.kind === 'session' && item.target.sessionId === sessionId)
        .map((item) => ({ ...summarize(item), rule: describeTiming(item) }))
        .sort((left, right) => String(left.scheduledAt).localeCompare(String(right.scheduledAt)))
      sendJson(res, 200, { ok: true, items: mine, total: page.total ?? items.length })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const handleCreate = async (req, res) => {
    try {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '不支持的请求方法' })
        return
      }
      const raw = await readBody(req, MAX_BODY)
      const body = JSON.parse(raw.toString('utf8') || '{}')

      const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
      if (sessionId.length === 0) {
        sendJson(res, 400, { ok: false, error: '缺少 sessionId' })
        return
      }

      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
      if (prompt.length === 0) {
        sendJson(res, 400, { ok: false, error: '要发送的内容不能为空' })
        return
      }
      if (prompt.length > 20000) {
        sendJson(res, 400, { ok: false, error: '内容太长了（上限 20000 字）' })
        return
      }

      const title = prompt.replace(/\s+/g, ' ').slice(0, 24) || '定时消息'
      const timing = buildTiming(body)
      const entry = await schedule.create({
        title,
        prompt,
        timing,
        target: { kind: 'session', sessionId },
      })
      sendJson(res, 200, { ok: true, task: { ...summarize(entry), rule: describeTiming(entry) } })
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const handleDelete = async (req, res) => {
    try {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '不支持的请求方法' })
        return
      }
      const raw = await readBody(req, MAX_BODY)
      const body = JSON.parse(raw.toString('utf8') || '{}')
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      if (id.length === 0) {
        sendJson(res, 400, { ok: false, error: '缺少任务 id' })
        return
      }
      const result = await schedule.edit({ id, action: 'delete' })
      sendJson(res, 200, { ok: true, result })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const handleRun = async (req, res) => {
    try {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '不支持的请求方法' })
        return
      }
      const raw = await readBody(req, MAX_BODY)
      const body = JSON.parse(raw.toString('utf8') || '{}')
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      if (id.length === 0) {
        sendJson(res, 400, { ok: false, error: '缺少任务 id' })
        return
      }
      const result = await schedule.run({ id })
      sendJson(res, 200, { ok: true, result })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  // A hot-reloaded copy of this bundle can already own the routes when this
  // instance activates. Re-registering then throws "duplicate exact route",
  // which would fail the whole activation and take the panels down with it, so
  // keep the incumbent registration and carry on.
  const mount = (path, handler) => {
    try {
      const dispose = ctx.webServer.register({ kind: 'exact', path, handler })
      return typeof dispose === 'function' ? dispose : () => {}
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/duplicate|already registered|in use/i.test(message)) return () => {}
      throw error
    }
  }

  ctx.effect(() => {
    const disposers = [
      mount(`${BASE_PATH}/list`, handleList),
      mount(`${BASE_PATH}/create`, handleCreate),
      mount(`${BASE_PATH}/delete`, handleDelete),
      mount(`${BASE_PATH}/run`, handleRun),
    ]
    return () => {
      for (const dispose of disposers) {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          // the registry is already gone
        }
      }
    }
  })
}