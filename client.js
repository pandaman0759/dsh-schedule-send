// Client half of dsh-schedule-send.
//
// Two slots, one store:
//   conversation.input.right  → a clock button beside the composer that opens the
//                                "send later" panel (mode column + content box).
//   conversation.input.dock   → the pending cards above the composer: countdown,
//                                a one-line excerpt of the body, and a cancel ×.
//
// Every task is a Host Schedule whose target is this very Session, so delivery
// arrives as a normal user message to the agent.
const API = '/api/dsh-schedule-send'
const EVENT = 'dsh-schedule-send:changed'
const SLOT_TRIGGER = 'conversation.input.right'
const SLOT_DOCK = 'conversation.input.dock'

const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日']
const REPEAT_OPTIONS = [
  { value: 'none', label: '不重复' },
  { value: 'daily', label: '每天' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' },
]
const MODES = [
  { value: 'after-turn', title: '本轮结束后发送', desc: '这一轮回答结束，就自动发出去一次' },
  { value: 'interval', title: '间隔发送', desc: '每隔一段时间发一次，可以只发几次' },
  { value: 'clock', title: '定时发送', desc: '给定日期时间发送，可选每天／每周／每月' },
]

const CSS = `
.dss-trigger{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none}
.dss-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dss-trigger:disabled{opacity:.4;cursor:default}
.dss-trigger svg{width:16px;height:16px}

.dss-dock{display:flex;flex-direction:column;gap:6px;width:100%;max-width:860px;margin:0 auto 8px;box-sizing:border-box}
.dss-row{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:var(--dsw-radius-md,8px);border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);font-size:12px;color:var(--dsw-alias-label-secondary);min-width:0}
.dss-row svg{width:14px;height:14px;flex:none;color:var(--dsw-alias-brand-primary)}
.dss-row-time{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);font-size:12px;flex:none}
.dss-row-prompt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.dss-row-del{flex:none;width:20px;height:20px;padding:0;border:0;border-radius:var(--dsw-radius-xs,4px);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:14px;line-height:1}
.dss-row-del:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-error-primary)}

.dss-mask{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;background:rgba(0,0,0,.34)}
.dss-panel{width:min(640px,100%);max-height:min(82vh,760px);overflow:auto;display:flex;flex-direction:column;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);box-shadow:var(--dsw-shadow-lv2);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family)}
.dss-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:14px 16px 10px}
.dss-head-title{font-size:14px;font-weight:600}
.dss-head-sub{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:2px}
.dss-close{width:24px;height:24px;padding:0;border:0;border-radius:var(--dsw-radius-xs,4px);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:16px;line-height:1}
.dss-close:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dss-body{display:flex;gap:12px;padding:0 16px 12px;align-items:stretch}
.dss-modes{width:184px;flex:none;display:flex;flex-direction:column;gap:4px}
.dss-mode{text-align:left;padding:8px 10px;border-radius:var(--dsw-radius-sm,6px);border:1px solid transparent;background:transparent;cursor:pointer;color:inherit}
.dss-mode:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dss-mode[data-active="true"]{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2)}
.dss-mode-title{display:block;font-size:12.5px;font-weight:600}
.dss-mode-desc{display:block;font-size:11px;line-height:1.45;margin-top:2px;color:var(--dsw-alias-label-tertiary)}
.dss-content{flex:1;min-width:0;display:flex;flex-direction:column}
.dss-label{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-bottom:4px}
.dss-textarea{width:100%;box-sizing:border-box;min-height:158px;resize:vertical;padding:10px;border-radius:var(--dsw-radius-md,8px);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:13px;line-height:1.55}
.dss-textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dss-params{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;padding:0 16px 12px}
.dss-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.dss-field>span{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dss-input{width:76px;box-sizing:border-box;padding:6px 8px;border-radius:var(--dsw-radius-sm,6px);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12.5px;font-family:var(--dsw-font-family)}
.dss-input[type=date]{width:auto;min-width:160px}
.dss-input[type=time]{width:auto;min-width:120px}
.dss-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dss-hint{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.5}
.dss-chips{display:flex;gap:4px;flex-wrap:wrap}
.dss-chip{padding:4px 9px;border-radius:var(--dsw-radius-sm,6px);border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font-size:11.5px;cursor:pointer}
.dss-chip[data-active="true"]{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}
.dss-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 16px 14px;border-top:1px solid var(--dsw-alias-border-l1)}
.dss-error{font-size:11.5px;color:var(--dsw-alias-state-error-primary);min-width:0;overflow:hidden;text-overflow:ellipsis}
.dss-actions{display:flex;gap:8px;flex:none}
.dss-btn{padding:6px 14px;border-radius:var(--dsw-radius-sm,6px);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12.5px;cursor:pointer}
.dss-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dss-btn[data-primary="true"]{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}
.dss-btn:disabled{opacity:.55;cursor:default}
`

function pad2(value) {
  return String(value).padStart(2, '0')
}

function localZone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (typeof zone === 'string' && zone.length > 0) return zone
  } catch {
    // the host falls back on its own
  }
  return 'Asia/Shanghai'
}

function todayString() {
  const now = new Date()
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
}

function nextHourString() {
  const now = new Date()
  now.setHours(now.getHours() + 1, 0, 0, 0)
  return `${pad2(now.getHours())}:00`
}

function todayWeekday() {
  // JS: 0 = Sunday … 6 = Saturday → panel index 0 = Monday … 6 = Sunday
  return (new Date().getDay() + 6) % 7
}

function formatCountdown(remainingMs) {
  if (!Number.isFinite(remainingMs)) return '已排定'
  if (remainingMs <= 0) return '即将发送'
  const seconds = Math.floor(remainingMs / 1000)
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  if (days > 0) return `${days}天${hours}小时后`
  if (hours > 0) return `${hours}:${pad2(minutes)}:${pad2(rest)}`
  return `${pad2(minutes)}:${pad2(rest)}`
}

async function postJson(path, body) {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  let data = null
  try {
    data = await response.json()
  } catch {
    data = null
  }
  if (!data || data.ok !== true) {
    throw new Error((data && data.error) || `请求失败（HTTP ${response.status}）`)
  }
  return data
}

function notifyChanged() {
  try {
    window.dispatchEvent(new Event(EVENT))
  } catch {
    // nothing to refresh
  }
}

function resolveSessionId(props) {
  const candidates = [props && props.sessionId, props && props.session && props.session.id]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return ''
}

window.__ModuleLoader__.load({
  id: '@local/dsh-schedule-send',
  factory(require) {
    const React = require('react')
    if (!React || typeof React.createElement !== 'function') return { inject: [], apply() {} }
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    let ReactDOM = null
    try {
      ReactDOM = require('react-dom')
    } catch {
      ReactDOM = null
    }

    function Portal(props) {
      if (ReactDOM && typeof ReactDOM.createPortal === 'function') {
        return ReactDOM.createPortal(props.children, document.body)
      }
      return props.children
    }

    function ClockIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('circle', { cx: 8, cy: 8, r: 6.1, stroke: 'currentColor', strokeWidth: 1.4 }),
        h('path', {
          d: 'M8 4.7V8l2.3 1.5',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    // ── shared task store ─────────────────────────────────────────────────

    function useTasks(sessionId) {
      const [tasks, setTasks] = useState([])
      const alive = useRef(true)

      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      const load = useCallback(async () => {
        if (!sessionId) {
          if (alive.current) setTasks([])
          return
        }
        try {
          const response = await fetch(`${API}/list?sessionId=${encodeURIComponent(sessionId)}`)
          const data = await response.json()
          if (!alive.current) return
          setTasks(data && data.ok && Array.isArray(data.items) ? data.items : [])
        } catch {
          // a transient fetch failure leaves the previous rows in place
        }
      }, [sessionId])

      useEffect(() => {
        load()
        if (!sessionId) return undefined
        const refresh = setInterval(load, 2000)
        const onChanged = () => {
          load()
        }
        window.addEventListener(EVENT, onChanged)
        return () => {
          clearInterval(refresh)
          window.removeEventListener(EVENT, onChanged)
        }
      }, [sessionId, load])

      return { tasks, reload: load }
    }

    async function cancelTask(id) {
      try {
        await postJson('/delete', { id })
      } catch {
        // the row disappears on the next refresh anyway if the Host removed it
      }
      notifyChanged()
    }

    // ── dock above the composer ───────────────────────────────────────────

    function Dock(props) {
      const sessionId = resolveSessionId(props)
      const { tasks, reload } = useTasks(sessionId)
      const [now, setNow] = useState(() => Date.now())

      useEffect(() => {
        const tick = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(tick)
      }, [])

      if (!sessionId || tasks.length === 0) return null

      const rows = tasks.map((task) => {
        const at = Date.parse(task.scheduledAt)
        const remaining = Number.isFinite(at) ? at - now : NaN
        const when = task.waitingTurn === true ? '本轮结束后' : formatCountdown(remaining)
        const excerpt = String(task.prompt || '').replace(/\s+/g, ' ').trim()
        return h(
          'div',
          { key: task.id, className: 'dss-row' },
          h(ClockIcon, { key: 'i' }),
          h('span', { key: 't', className: 'dss-row-time' }, when),
          h('span', { key: 'p', className: 'dss-row-prompt', title: excerpt }, excerpt),
          h(
            'button',
            {
              key: 'x',
              type: 'button',
              className: 'dss-row-del',
              title: '取消这条定时消息',
              'aria-label': '取消这条定时消息',
              onClick: () => {
                cancelTask(task.id).then(reload)
              },
            },
            '×',
          ),
        )
      })

      return h('div', { className: 'dss-dock' }, rows)
    }

    // ── panel ─────────────────────────────────────────────────────────────

    function Panel(props) {
      const [mode, setMode] = useState('after-turn')
      const [prompt, setPrompt] = useState('')
      const [hours, setHours] = useState('0')
      const [minutes, setMinutes] = useState('30')
      const [count, setCount] = useState('1')
      const [date, setDate] = useState(todayString)
      const [time, setTime] = useState(nextHourString)
      const [repeat, setRepeat] = useState('none')
      const [weekdays, setWeekdays] = useState([todayWeekday()])
      const [monthDay, setMonthDay] = useState(() => String(new Date().getDate()))
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const textareaRef = useRef(null)

      useEffect(() => {
        if (textareaRef.current) textareaRef.current.focus()
      }, [])

      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key === 'Escape') props.onClose()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [props.onClose])

      const toggleWeekday = (index) => {
        setWeekdays((current) =>
          current.includes(index) ? current.filter((item) => item !== index) : [...current, index].sort((a, b) => a - b),
        )
      }

      const submit = async () => {
        if (busy) return
        if (prompt.trim().length === 0) {
          setError('先写上要发送的内容')
          return
        }
        const body = { sessionId: props.sessionId, mode, prompt, zone: localZone() }
        if (mode === 'interval') {
          body.hours = Number(hours || 0)
          body.minutes = Number(minutes || 0)
          body.count = Number(count || 1)
        } else if (mode === 'clock') {
          body.date = date
          body.time = time
          body.repeat = repeat
          body.weekdays = weekdays
          body.monthDay = Number(monthDay || 1)
        }
        setBusy(true)
        setError('')
        try {
          await postJson('/create', body)
          notifyChanged()
          props.onClose()
        } catch (failure) {
          setError(failure && failure.message ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }

      const modeColumn = h(
        'div',
        { className: 'dss-modes', key: 'modes' },
        MODES.map((item) =>
          h(
            'button',
            {
              key: item.value,
              type: 'button',
              className: 'dss-mode',
              'data-active': mode === item.value ? 'true' : 'false',
              onClick: () => {
                setMode(item.value)
                setError('')
              },
            },
            h('span', { className: 'dss-mode-title' }, item.title),
            h('span', { className: 'dss-mode-desc' }, item.desc),
          ),
        ),
      )

      const contentColumn = h(
        'div',
        { className: 'dss-content', key: 'content' },
        h('div', { className: 'dss-label' }, '要发送的内容'),
        h('textarea', {
          ref: textareaRef,
          className: 'dss-textarea',
          value: prompt,
          placeholder: '写点什么…时间到了，它就会像你亲手敲进去一样发出去',
          onChange: (event) => setPrompt(event.target.value),
        }),
      )

      let params = null
      if (mode === 'after-turn') {
        params = h(
          'div',
          { className: 'dss-hint' },
          '当前这一轮回答一结束就发出去；如果本回合还在跑，会排在它后面。',
        )
      } else if (mode === 'interval') {
        params = [
          h(
            'label',
            { key: 'h', className: 'dss-field' },
            h('span', {}, '小时'),
            h('input', { className: 'dss-input', type: 'number', min: '0', max: '168', value: hours, onChange: (e) => setHours(e.target.value) }),
          ),
          h(
            'label',
            { key: 'm', className: 'dss-field' },
            h('span', {}, '分钟'),
            h('input', { className: 'dss-input', type: 'number', min: '0', max: '59', value: minutes, onChange: (e) => setMinutes(e.target.value) }),
          ),
          h(
            'label',
            { key: 'c', className: 'dss-field' },
            h('span', {}, '循环次数'),
            h('input', { className: 'dss-input', type: 'number', min: '1', max: '999', value: count, onChange: (e) => setCount(e.target.value) }),
          ),
        ]
      } else {
        const repeatChips = h(
          'div',
          { key: 'r', className: 'dss-field' },
          h('span', {}, '重复'),
          h(
            'div',
            { className: 'dss-chips' },
            REPEAT_OPTIONS.map((option) =>
              h(
                'button',
                {
                  key: option.value,
                  type: 'button',
                  className: 'dss-chip',
                  'data-active': repeat === option.value ? 'true' : 'false',
                  onClick: () => setRepeat(option.value),
                },
                option.label,
              ),
            ),
          ),
        )
        const pieces = [
          h(
            'label',
            { key: 'd', className: 'dss-field' },
            h('span', {}, '日期'),
            h('input', { className: 'dss-input', type: 'date', value: date, disabled: repeat !== 'none' && repeat !== 'daily', onChange: (e) => setDate(e.target.value) }),
          ),
          h(
            'label',
            { key: 't', className: 'dss-field' },
            h('span', {}, '时间'),
            h('input', { className: 'dss-input', type: 'time', value: time, onChange: (e) => setTime(e.target.value) }),
          ),
          repeatChips,
        ]
        if (repeat === 'weekly') {
          pieces.push(
            h(
              'div',
              { key: 'w', className: 'dss-field' },
              h('span', {}, '星期几'),
              h(
                'div',
                { className: 'dss-chips' },
                WEEKDAY_LABELS.map((label, index) =>
                  h(
                    'button',
                    {
                      key: label,
                      type: 'button',
                      className: 'dss-chip',
                      'data-active': weekdays.includes(index) ? 'true' : 'false',
                      onClick: () => toggleWeekday(index),
                    },
                    label,
                  ),
                ),
              ),
            ),
          )
        }
        if (repeat === 'monthly') {
          pieces.push(
            h(
              'label',
              { key: 'md', className: 'dss-field' },
              h('span', {}, '每月几号'),
              h('input', {
                className: 'dss-input',
                type: 'number',
                min: '1',
                max: '31',
                value: monthDay,
                onChange: (e) => setMonthDay(e.target.value),
              }),
            ),
          )
        }
        params = pieces
      }

      const summary =
        mode === 'clock' && repeat === 'none' ? `${date} ${time}` : mode === 'interval' ? `${hours}小时${minutes}分 × ${count} 次` : ''

      return h(
        Portal,
        null,
        h(
          'div',
          {
            className: 'dss-mask',
            onMouseDown: (event) => {
              if (event.target === event.currentTarget) props.onClose()
            },
          },
          h(
            'div',
            { className: 'dss-panel', role: 'dialog', 'aria-modal': 'true' },
            h(
              'div',
              { className: 'dss-head' },
              h(
                'div',
                { key: 'title' },
                h('div', { className: 'dss-head-title' }, '定时发送'),
                h('div', { className: 'dss-head-sub' }, '到点就当作你亲手发出的一条消息' + (summary ? `　·　${summary}` : '')),
              ),
              h(
                'button',
                { type: 'button', className: 'dss-close', title: '关闭', 'aria-label': '关闭', onClick: props.onClose },
                '×',
              ),
            ),
            h('div', { className: 'dss-body' }, modeColumn, contentColumn),
            h('div', { className: 'dss-params' }, Array.isArray(params) ? params : h('div', null, params)),
            h(
              'div',
              { className: 'dss-foot' },
              h('div', { className: 'dss-error' }, error),
              h(
                'div',
                { className: 'dss-actions' },
                h('button', { type: 'button', className: 'dss-btn', onClick: props.onClose }, '取消'),
                h(
                  'button',
                  { type: 'button', className: 'dss-btn', 'data-primary': 'true', disabled: busy, onClick: submit },
                  busy ? '安排中…' : '创建',
                ),
              ),
            ),
          ),
        ),
      )
    }

    function Trigger(props) {
      const sessionId = resolveSessionId(props)
      const [open, setOpen] = useState(false)
      return h(React.Fragment, null, [
        h(
          'button',
          {
            key: 'trigger',
            type: 'button',
            className: 'dss-trigger',
            title: sessionId ? '定时发送' : '这个会话还不能定时发送',
            'aria-label': '定时发送',
            disabled: !sessionId,
            onClick: () => setOpen(true),
          },
          h(ClockIcon, null),
        ),
        open && sessionId
          ? h(Panel, { key: 'panel', sessionId, onClose: () => setOpen(false) })
          : null,
      ])
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        let styled = false
        try {
          const styles = typeof ctx.get === 'function' ? ctx.get('styles') : null
          if (styles && typeof styles.insert === 'function') {
            styles.insert(CSS)
            styled = true
          }
        } catch {
          styled = false
        }
        if (!styled) {
          const style = document.createElement('style')
          style.textContent = CSS
          document.head.appendChild(style)
        }
        ctx.slots.inject(SLOT_TRIGGER, () =>
          ctx.slots.register({ name: SLOT_TRIGGER, id: 'schedule-send-trigger', order: 30 }, Trigger),
        )
        ctx.slots.inject(SLOT_DOCK, () =>
          ctx.slots.register({ name: SLOT_DOCK, id: 'schedule-send-dock', order: 30 }, Dock),
        )
      },
    }
  },
})