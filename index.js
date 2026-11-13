/**
 * dsh-schedule-send — Host half.
 *
 * Scheduled "send as the user" messages for one Session. Three modes:
 *   after-turn  send once when the running turn ends
 *   interval    send every X hours Y minutes, N times
 *   clock       send at a date/time, optionally repeating daily / weekly / monthly
 *
 * Delivery goes through `ctx.sessionController.prompt(...)`, i.e. the exact same
 * channel the composer uses, so the delivered message is the plain user text —
 * no scheduled-reminder envelope.
 *
 * Every task lives in `<home>/.dsh/schedule-send/tasks.json`, so a Host restart
 * keeps pending sends.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const inject = ['webServer', 'sessionController']

const BASE_PATH = '/api/dsh-schedule-send'
const DATA_DIR = join(homedir(), '.dsh', 'schedule-send')
const DATA_FILE = join(DATA_DIR, 'tasks.json')
const MAX_BODY = 20000
const MAX_TASKS = 200
const TICK_MS = 1000
const MAX_ATTEMPTS = 3
const ZONE_FALLBACK = 'Asia/Shanghai'
// Panel index: 0 = Monday … 6 = Sunday.
const WEEKDAY_LABEL = ['一', '二', '三', '四', '五', '六', '日']
// Reloading the Host does not always dispose the previous effect, so the plugin
// keeps a process-wide handle and hands it over (or tears it down) on re-apply.
const INSTANCE_KEY = Symbol.for('@local/dsh-schedule-send/active-instance')

const MS_MINUTE = 60 * 1000
const MS_HOUR = 60 * MS_MINUTE
const MS_DAY = 24 * MS_HOUR

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 512 * 1024) {
        reject(new Error('请求内容太大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw === '') return resolve({})
      try {
        const parsed = JSON.parse(raw)
        resolve(parsed && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(new Error('请求内容不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

function resolveZone(raw) {
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: raw })
      return raw
    } catch {
      // fall through to the fallback zone
    }
  }
  return ZONE_FALLBACK
}

function zoneParts(zone, date) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const map = {}
  for (const part of formatter.formatToParts(date)) map[part.type] = part.value
  let hour = Number(map.hour)
  if (hour === 24) hour = 0
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    second: Number(map.second),
  }
}

function zoneOffsetMs(zone, date) {
  const parts = zoneParts(zone, date)
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return asUtc - date.getTime()
}

/** Wall-clock time in `zone` → UTC epoch ms (two passes so DST edges settle). */
function zonedMs(zone, year, month, day, hour, minute, second) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second)
  const first = guess - zoneOffsetMs(zone, new Date(guess))
  const second2 = guess - zoneOffsetMs(zone, new Date(first))
  return second2
}

function parseClock(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text)
  if (match === null) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  const seconds = match[3] === undefined ? 0 : Number(match[3])
  if (hours > 23 || minutes > 59 || seconds > 59) return null
  return { hours, minutes, seconds }
}

function parseDate(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (match === null) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null
  return { year, month, day }
}

function clockText(clock) {
  return `${pad2(clock.hours)}:${pad2(clock.minutes)}:${pad2(clock.seconds)}`
}

function integer(raw, fallback, min, max) {
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(value)) return fallback
  const rounded = Math.round(value)
  if (rounded < min || rounded > max) return fallback
  return rounded
}

/** Next wall-clock occurrence of `clock` strictly after `afterMs`, for a daily rule. */
function nextDailyMs(zone, clock, afterMs) {
  const today = zoneParts(zone, new Date(afterMs))
  for (let add = 0; add < 400; add += 1) {
    const probe = new Date(Date.UTC(today.year, today.month - 1, today.day + add))
    const candidate = zonedMs(
      zone,
      probe.getUTCFullYear(),
      probe.getUTCMonth() + 1,
      probe.getUTCDate(),
      clock.hours,
      clock.minutes,
      clock.seconds,
    )
    if (candidate > afterMs) return candidate
  }
  return null
}

/** Next occurrence on one of `weekdays` (panel index 0 = Monday). */
function nextWeeklyMs(zone, clock, weekdays, afterMs) {
  const today = zoneParts(zone, new Date(afterMs))
  for (let add = 0; add < 15; add += 1) {
    const probe = new Date(Date.UTC(today.year, today.month - 1, today.day + add))
    const panelIndex = (probe.getUTCDay() + 6) % 7
    if (weekdays.includes(panelIndex)) {
      const candidate = zonedMs(
        zone,
        probe.getUTCFullYear(),
        probe.getUTCMonth() + 1,
        probe.getUTCDate(),
        clock.hours,
        clock.minutes,
        clock.seconds,
      )
      if (candidate > afterMs) return candidate
    }
  }
  return null
}

/** Next occurrence on day-of-month `monthDay`, skipping months that lack it. */
function nextMonthlyMs(zone, clock, monthDay, afterMs) {
  const today = zoneParts(zone, new Date(afterMs))
  for (let add = 0; add < 24; add += 1) {
    const probe = new Date(Date.UTC(today.year, today.month - 1 + add, monthDay))
    if (probe.getUTCDate() !== monthDay) continue
    const candidate = zonedMs(
      zone,
      probe.getUTCFullYear(),
      probe.getUTCMonth() + 1,
      monthDay,
      clock.hours,
      clock.minutes,
      clock.seconds,
    )
    if (candidate > afterMs) return candidate
  }
  return null
}

function nextClockMs(task, afterMs) {
  const clock = parseClock(task.time)
  if (clock === null) return null
  const zone = resolveZone(task.zone)
  if (task.repeat === 'daily') return nextDailyMs(zone, clock, afterMs)
  if (task.repeat === 'weekly') return nextWeeklyMs(zone, clock, task.weekdays, afterMs)
  if (task.repeat === 'monthly') return nextMonthlyMs(zone, clock, task.monthDay, afterMs)
  const date = parseDate(task.date)
  if (date === null) return null
  return zonedMs(zone, date.year, date.month, date.day, clock.hours, clock.minutes, clock.seconds)
}

function describeTask(task) {
  if (task.mode === 'after-turn') return task.nextAt === null ? '本轮结束后发送一次' : '即将发送一次'
  if (task.mode === 'interval') {
    const minutes = task.intervalMinutes
    const span =
      minutes % 60 === 0
        ? `${minutes / 60} 小时`
        : minutes < 60
          ? `${minutes} 分钟`
          : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`
    return `每 ${span}发一次，共 ${task.repeatCount} 次（第 ${task.sentCount + 1} 次）`
  }
  const clock = parseClock(task.time)
  const at = clock === null ? task.time : `${pad2(clock.hours)}:${pad2(clock.minutes)}`
  if (task.repeat === 'daily') return `每天 ${at}`
  if (task.repeat === 'weekly') {
    const days = task.weekdays.map((index) => WEEKDAY_LABEL[index] || '?').join('')
    return `每周${days} ${at}`
  }
  if (task.repeat === 'monthly') return `每月 ${task.monthDay} 号 ${at}`
  return `${task.date} ${at}`
}

function summarize(task, now) {
  return {
    id: task.id,
    sessionId: task.sessionId,
    mode: task.mode,
    prompt: task.body,
    rule: describeTask(task),
    scheduledAt: typeof task.nextAt === 'number' ? new Date(task.nextAt).toISOString() : null,
    countdownMs: typeof task.nextAt === 'number' ? task.nextAt - now : null,
    waitingTurn: task.mode === 'after-turn' && task.nextAt === null,
    sentCount: task.sentCount,
    repeatCount: task.mode === 'interval' ? task.repeatCount : null,
    lastError: task.lastError || null,
  }
}

export function apply(ctx) {
  const token = {}
  const previous = globalThis[INSTANCE_KEY]
  if (previous && previous.token !== token && typeof previous.dispose === 'function') {
    // A reloaded build leaves the previous instance's timer behind; hand it
    // over so two copies can never deliver the same task twice. Deferred, because
    // tearing down inside an HMR transaction raises "HMR transactions cannot be nested".
    setTimeout(() => {
      try {
        previous.dispose()
      } catch {
        // the old instance is already gone
      }
    }, 0)
  }
  let tasks = []
  let loaded = false
  let ticking = false
  let timer = null
  const disposers = []

  function mount(path, handler) {
    try {
      return ctx.webServer.register({ kind: 'exact', path, handler })
    } catch (error) {
      const message = error && error.message ? String(error.message) : String(error)
      if (/duplicate|already registered|in use/i.test(message)) return () => {}
      throw error
    }
  }

  async function load() {
    if (loaded) return
    loaded = true
    try {
      const raw = await readFile(DATA_FILE, 'utf8')
      const parsed = JSON.parse(raw)
      const list = parsed && Array.isArray(parsed.tasks) ? parsed.tasks : []
      tasks = list.filter((item) => item && typeof item.id === 'string' && item.done !== true).slice(0, MAX_TASKS)
    } catch {
      tasks = []
    }
  }

  async function save() {
    try {
      await mkdir(DATA_DIR, { recursive: true })
      const temp = `${DATA_FILE}.tmp`
      await writeFile(temp, JSON.stringify({ version: 1, tasks }, null, 2), 'utf8')
      await rename(temp, DATA_FILE)
    } catch {
      // a failed write only loses restart durability, never a live send
    }
  }

  let cachedMode = null
  let cachedModeAt = 0

  /**
   * The composer's own busy-send policy: `ui-conversation` owns `busyEnter`
   * ("steer" = 插话, "queue" = 排队). A scheduled send must behave exactly like
   * the user pressing Enter in that Session, so it reads the same setting.
   */
  function promptMode() {
    const now = Date.now()
    if (cachedMode !== null && now - cachedModeAt < 3000) return cachedMode
    let mode = null
    try {
      const settings = ctx.get('settings')
      if (settings && typeof settings.describe === 'function') {
        for (const entry of settings.describe()) {
          const value = entry && entry.value
          if (value && typeof value === 'object') {
            if (value.busyEnter === 'steer' || value.busyEnter === 'queue') {
              mode = value.busyEnter
              break
            }
          }
        }
      }
    } catch {
      // an unreadable settings tree only costs the busier default below
    }
    cachedMode = mode === null ? 'queue' : mode
    cachedModeAt = now
    return cachedMode
  }

  async function sessionRunning(sessionId) {
    try {
      const controller = new AbortController()
      const state = await ctx.sessionController.state({ sessionId }, controller.signal)
      if (state && typeof state.running === 'boolean') return state.running
      return null
    } catch {
      return null
    }
  }

  async function deliver(task) {
    const controller = new AbortController()
    const request = {
      requestId: `ss-${task.id}-${task.sentCount}-${Date.now()}`,
      sessionId: task.sessionId,
      mode: promptMode(),
      content: [{ type: 'text', text: task.body }],
      clientTimeZone: resolveZone(task.zone),
    }
    await ctx.sessionController.prompt(request, controller.signal)
  }

  async function fire(task) {
    const now = Date.now()
    try {
      await deliver(task)
      task.sentCount += 1
      task.lastSentAt = new Date(now).toISOString()
      task.lastError = null
      if (task.mode === 'after-turn') {
        task.done = true
      } else if (task.mode === 'interval') {
        task.nextAt = now + task.intervalMinutes * MS_MINUTE
        if (task.sentCount >= task.repeatCount) task.done = true
      } else if (task.repeat === 'none') {
        task.done = true
      } else {
        const next = nextClockMs(task, now + 1000)
        if (next === null) task.done = true
        else task.nextAt = next
      }
    } catch (error) {
      task.attempts = (task.attempts || 0) + 1
      task.lastError = error && error.message ? String(error.message) : String(error)
      if (task.attempts >= MAX_ATTEMPTS) {
        task.done = true
      } else if (task.mode === 'interval') {
        task.nextAt = now + task.intervalMinutes * MS_MINUTE
      } else if (task.mode !== 'after-turn' && task.repeat !== 'none') {
        const next = nextClockMs(task, now + 1000)
        if (next !== null) task.nextAt = next
      }
    }
    if (task.done === true) {
      tasks = tasks.filter((item) => item.id !== task.id)
    }
    await save()
  }

  async function tick() {
    if (ticking) return
    ticking = true
    try {
      await load()
      const now = Date.now()
      const snapshot = tasks.slice()
      for (const task of snapshot) {
        if (task.done === true) continue
        if (task.mode === 'after-turn' && task.nextAt === null) {
          const running = await sessionRunning(task.sessionId)
          if (running === null) {
            task.waitProbe = (task.waitProbe || 0) + 1
            if (task.waitProbe >= 600) {
              task.done = true
              task.lastError = '读不到会话状态，已放弃这条'
            }
            continue
          }
          task.waitProbe = 0
          if (running === false) await fire(task)
          continue
        }
        if (typeof task.nextAt === 'number' && now >= task.nextAt) await fire(task)
      }
      // drop entries that completed while this loop was running
      tasks = tasks.filter((item) => item.done !== true)
    } finally {
      ticking = false
    }
  }

  function buildTask(body) {
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    if (sessionId === '') throw new Error('缺少会话 id')
    const mode = body.mode === 'interval' || body.mode === 'clock' ? body.mode : 'after-turn'
    const text = typeof body.prompt === 'string' ? body.prompt : ''
    if (text.trim() === '') throw new Error('要发送的内容不能为空')
    if (text.length > MAX_BODY) throw new Error(`内容太长（最多 ${MAX_BODY} 字）`)
    const zone = resolveZone(body.zone)
    const now = Date.now()
    const task = {
      id: `ss-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId,
      mode,
      body: text,
      zone,
      createdAt: new Date(now).toISOString(),
      nextAt: null,
      sentCount: 0,
      repeatCount: 1,
      attempts: 0,
      lastError: null,
      done: false,
    }

    if (mode === 'after-turn') {
      task.repeatCount = 1
      task.nextAt = null
      return { task, armed: true }
    }

    if (mode === 'interval') {
      const hours = integer(body.hours, 0, 0, 999)
      const minutes = integer(body.minutes, 0, 0, 9999)
      const total = hours * 60 + minutes
      if (total < 1) throw new Error('间隔至少 1 分钟')
      const count = integer(body.count, 1, 1, 999)
      task.intervalMinutes = total
      task.repeatCount = count
      task.nextAt = now + total * MS_MINUTE
      return { task, armed: true }
    }

    const clock = parseClock(body.time)
    if (clock === null) throw new Error('时间格式要写成 HH:mm')
    task.time = clockText(clock)
    const repeat = body.repeat === 'daily' || body.repeat === 'weekly' || body.repeat === 'monthly' ? body.repeat : 'none'
    task.repeat = repeat
    if (repeat === 'weekly') {
      const raw = Array.isArray(body.weekdays) ? body.weekdays : []
      const days = raw.map((item) => integer(item, -1, 0, 6)).filter((item) => item >= 0)
      const unique = [...new Set(days)].sort((a, b) => a - b)
      if (unique.length === 0) throw new Error('至少选一个星期几')
      task.weekdays = unique
    } else if (repeat === 'monthly') {
      task.monthDay = integer(body.monthDay, new Date().getDate(), 1, 31)
    }
    if (repeat === 'none') {
      const date = parseDate(body.date)
      if (date === null) throw new Error('日期格式要写成 YYYY-MM-DD')
      task.date = `${date.year}-${pad2(date.month)}-${pad2(date.day)}`
    }
    const next = nextClockMs(task, now)
    if (next === null) throw new Error('算不出下一次发送时间，请检查日期与时间')
    if (repeat === 'none' && next <= now) throw new Error('这个时间已经过去了')
    task.nextAt = next
    return { task, armed: true }
  }

  async function handleList(req, res, url) {
    await load()
    const sessionId = url.searchParams.get('sessionId') || ''
    const now = Date.now()
    const items = tasks
      .filter((task) => task.done !== true && (sessionId === '' || task.sessionId === sessionId))
      .map((task) => summarize(task, now))
    sendJson(res, 200, { ok: true, items, total: items.length, promptMode: promptMode() })
  }

  async function handleCreate(req, res) {
    const body = await readBody(req)
    await load()
    if (tasks.length >= MAX_TASKS) throw new Error(`待发送任务太多（上限 ${MAX_TASKS} 条）`)
    const { task } = buildTask(body)
    if (task.mode === 'after-turn') {
      // "after this turn" only waits when a turn is actually running; an idle
      // Session has no turn to wait for, so the send happens right away.
      const running = await sessionRunning(task.sessionId)
      task.nextAt = running === true ? null : Date.now() + 1000
    }
    tasks.push(task)
    await save()
    sendJson(res, 200, { ok: true, item: summarize(task, Date.now()) })
  }

  async function handleDelete(req, res) {
    const body = await readBody(req)
    const id = typeof body.id === 'string' ? body.id : ''
    if (id === '') throw new Error('缺少任务 id')
    await load()
    const before = tasks.length
    tasks = tasks.filter((task) => task.id !== id)
    if (tasks.length !== before) await save()
    sendJson(res, 200, { ok: true, removed: before !== tasks.length })
  }

  async function handleRun(req, res) {
    const body = await readBody(req)
    const id = typeof body.id === 'string' ? body.id : ''
    await load()
    const task = tasks.find((item) => item.id === id)
    if (!task) throw new Error('找不到这条任务')
    await fire(task)
    sendJson(res, 200, { ok: true })
  }

  /**
   * Model-facing entry point: the agent arms a message to its own Session and
   * reads it later. This is the whole "check the result again in five minutes"
   * loop — the send arrives as an ordinary user message, so it wakes the agent
   * exactly like the user typing it.
   */
  function toolZone() {
    try {
      return resolveZone(new Intl.DateTimeFormat().resolvedOptions().timeZone)
    } catch {
      return ZONE_FALLBACK
    }
  }

  function registerSendTool() {
    const tools = ctx.get('tools')
    if (!tools || typeof tools.register !== 'function') return () => {}
    const definition = {
      name: 'schedule_send',
      description:
        '把一段话在之后某个时刻当作「用户自己发的消息」送回当前会话，用来定时唤醒自己：例如先跑一个要等结果的任务，再定 5 分钟后回来检查；或指定今天/某天的几点几分提醒自己；或本轮回答结束后立刻再跑一次。三种方式：after-turn = 这一轮答完就发一次；interval = 每隔 N 分钟发一次、共 count 次；clock = 指定日期时间，可选每天/每周几/每月几号重复。发送时会像用户按回车一样遵循当前会话的排队/插话设置。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'mode'],
        properties: {
          text: {
            type: 'string',
            description: '到点发出去的原话，也就是未来你读到的那条用户消息（建议写成给自己的指令，带上要检查什么）',
          },
          mode: {
            type: 'string',
            enum: ['after-turn', 'interval', 'clock'],
            description: 'after-turn = 本轮结束后发送；interval = 间隔发送；clock = 定时发送',
          },
          minutes: { type: 'integer', minimum: 1, maximum: 9999, description: 'interval：每隔多少分钟发一次' },
          count: { type: 'integer', minimum: 1, maximum: 999, description: 'interval：一共发几次，默认 1' },
          date: { type: 'string', description: 'clock：日期 YYYY-MM-DD；repeat=none 时必填，过去的时间会被拒绝' },
          time: { type: 'string', description: 'clock：时间 HH:mm，必填' },
          repeat: {
            type: 'string',
            enum: ['none', 'daily', 'weekly', 'monthly'],
            description: 'clock：重复方式，默认 none',
          },
          weekdays: {
            type: 'array',
            items: { type: 'integer' },
            description: 'clock + weekly：星期几，0=周一 … 6=周日',
          },
          monthDay: { type: 'integer', minimum: 1, maximum: 31, description: 'clock + monthly：每月几号' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'id', 'rule', 'scheduledAt', 'waitingTurn'],
          properties: {
            ok: { type: 'boolean' },
            id: { type: 'string' },
            rule: { type: 'string' },
            scheduledAt: { type: 'string', description: '下一次发送的 UTC 时间；等轮次发送时为空串' },
            waitingTurn: { type: 'boolean', description: 'true = 正在等这一轮结束再发' },
          },
        },
        render: (_args, value) => {
          const record = value && typeof value === 'object' ? value : {}
          const when = record.scheduledAt ? `，下一次 ${record.scheduledAt}` : ''
          const rule = typeof record.rule === 'string' ? record.rule : '已排定'
          return [{ type: 'text', text: `${rule}${when}（任务 ${record.id || '?'}）` }]
        },
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const raw = args && typeof args === 'object' ? args : {}
        const sessionId = exec && exec.agent && exec.agent.id ? String(exec.agent.id) : ''
        await load()
        if (tasks.length >= MAX_TASKS) throw new Error(`待发送任务太多（上限 ${MAX_TASKS} 条）`)
        const { task } = buildTask({
          sessionId,
          zone: toolZone(),
          mode: raw.mode,
          prompt: raw.text,
          minutes: raw.minutes,
          count: raw.count,
          date: raw.date,
          time: raw.time,
          repeat: raw.repeat,
          weekdays: raw.weekdays,
          monthDay: raw.monthDay,
        })
        if (task.mode === 'after-turn') {
          const running = await sessionRunning(task.sessionId)
          task.nextAt = running === true ? null : Date.now() + 1000
        }
        tasks.push(task)
        await save()
        const view = summarize(task, Date.now())
        return {
          ok: true,
          id: view.id,
          rule: view.rule,
          scheduledAt: typeof view.scheduledAt === 'string' ? view.scheduledAt : '',
          waitingTurn: view.waitingTurn === true,
        }
      },
    }
    const cancelDefinition = {
      name: 'schedule_cancel',
      description: '取消一条已经排定的定时发送任务（id 用 schedule_send 的返回值，或用列表里看到的 id）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: { id: { type: 'string', description: '任务 id，形如 ss-xxxx-xxxxxx' } },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'removed'],
          properties: { ok: { type: 'boolean' }, removed: { type: 'boolean' } },
        },
        render: (_args, value) => [
          { type: 'text', text: value && value.removed === true ? '已取消这条定时发送' : '没找到这条任务（可能已经发出或删掉了）' },
        ],
      },
      isConcurrencySafe: () => false,
      async execute(args) {
        const id = args && typeof args.id === 'string' ? args.id : ''
        await load()
        const before = tasks.length
        tasks = tasks.filter((task) => task.id !== id)
        const removed = tasks.length !== before
        if (removed) await save()
        return { ok: true, removed }
      },
    }

    const registered = []
    for (const item of [definition, cancelDefinition]) {
      try {
        registered.push(tools.register(item))
      } catch (error) {
        const message = error && error.message ? String(error.message) : String(error)
        if (!/duplicate|already registered|in use/i.test(message)) throw error
      }
    }
    return () => {
      for (const dispose of registered) {
        if (typeof dispose === 'function') dispose()
      }
    }
  }

  ctx.effect(() => {
    disposers.push(registerSendTool())
    disposers.push(mount(`${BASE_PATH}/list`, (req, res) => {
      const url = new URL(req.url || '/', 'http://localhost')
      handleList(req, res, url).catch((error) => {
        sendJson(res, 500, { ok: false, error: error && error.message ? String(error.message) : String(error) })
      })
    }))

    disposers.push(mount(`${BASE_PATH}/create`, (req, res) => {
      handleCreate(req, res).catch((error) => {
        sendJson(res, 400, { ok: false, error: error && error.message ? String(error.message) : String(error) })
      })
    }))

    disposers.push(mount(`${BASE_PATH}/delete`, (req, res) => {
      handleDelete(req, res).catch((error) => {
        sendJson(res, 400, { ok: false, error: error && error.message ? String(error.message) : String(error) })
      })
    }))

    disposers.push(mount(`${BASE_PATH}/run`, (req, res) => {
      handleRun(req, res).catch((error) => {
        sendJson(res, 400, { ok: false, error: error && error.message ? String(error.message) : String(error) })
      })
    }))

    const handle = setInterval(() => {
      tick().catch(() => {})
    }, TICK_MS)
    timer = handle
    load()
      .then(() => tick())
      .catch(() => {})

    let stopped = false
    const stop = () => {
      if (stopped) return
      stopped = true
      if (timer !== null) clearInterval(timer)
      timer = null
      for (const dispose of disposers) {
        if (typeof dispose === 'function') dispose()
      }
    }
    globalThis[INSTANCE_KEY] = { token, dispose: stop }
    return () => {
      stop()
      const current = globalThis[INSTANCE_KEY]
      if (current && current.token === token) globalThis[INSTANCE_KEY] = null
    }
  })
}