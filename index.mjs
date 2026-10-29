/**
 * dsh-scheduled-send — host half.
 *
 * 职责（浏览器关闭也不影响）：
 * 1. 创建会话：`create` 动作里由 Host 直接建一个普通会话，并把定时任务绑定到它，
 *    因此「点一下就多一个定时会话」不需要浏览器参与后续流程。
 * 2. 持久化：任务写入 ~/.dsh/data/scheduled-send/tasks.json（原子写）。
 * 3. 到点真发：定时器触发后用 `sessionController.prompt()` 把消息真正送进该会话，
 *    与用户手打回车走同一条 Host 准入路径（冷会话会被自动 resume）。
 *
 * 设计约束：
 * - apply() 整体 try/catch，任何失败只打日志，绝不让 Host 启动失败。
 * - 路由只服务本机页面的同源 POST 请求（loopback + same-origin 守卫）。
 * - 不静态 import 任何 @deepseek-ai/* 包：link/file 安装时 Node 会把入口
 *   realpath 回源码目录，裸依赖在那里解析不到（composer-keys 踩过的坑）。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export const name = 'scheduled-send'

/** 单条定时消息正文上限（字符）。 */
const MAX_TEXT_CHARS = 100_000
/** 单次投递的最长等待；超时视为失败，避免定时队列被一个卡死的会话堵住。 */
const DELIVER_TIMEOUT_MS = 120_000
/** 定时器最长睡眠时间：到点前每分钟醒来重算一次，休眠/改系统时钟都能纠正。 */
const MAX_TIMER_SLEEP_MS = 60_000
/** 已结束任务（sent/failed/cancelled）的保留时长。 */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
/** 预创建会话时用的占位文本：让会话产出 turn/start 以脱离 blank。 */
const PLACEHOLDER_TEXT = '（定时发送占位）'

/** HTTP 路由。 */
const ROUTE_PATH = '/dsh-timed-send/api'
/** JSON 请求体上限。 */
const MAX_BODY_BYTES = 2 * 1024 * 1024

/**
 * 解析数据目录：DSH_DATA_DIR → $DSH_HOME/data → ~/.dsh/data。
 * 与 dsh-cron 的坑一致：从 C:\Windows\System32 之类目录启动时，相对路径会 EPERM。
 * @returns {string} 本插件的绝对数据目录。
 */
function resolveDataDir() {
  const explicit = process.env.DSH_DATA_DIR
  if (typeof explicit === 'string' && explicit.trim() !== '') return join(explicit.trim(), 'scheduled-send')
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home.trim() !== '') return join(home.trim(), 'data', 'scheduled-send')
  return join(homedir(), '.dsh', 'data', 'scheduled-send')
}

/** 可读的错误文本。 */
function reasonOf(error) {
  if (error === undefined || error === null) return 'unknown error'
  return error instanceof Error ? error.message : String(error)
}

/** 任务状态中仍然「待发」的集合。 */
const ACTIVE = 'active'

/**
 * tasks.json 的读写。结构固定为 `{ version: 1, tasks: Task[] }`；
 * 写入走 tmp + rename，进程被杀也不会留下半个文件。
 */
class TaskStore {
  /** @param {string} file - 绝对路径。 */
  constructor(file) {
    this.file = file
    /** @type {{version: number, tasks: any[]}} */
    this.data = { version: 1, tasks: [] }
    this.load()
  }

  /** 读盘；坏文件不致命——改名备份后从空表开始。 */
  load() {
    try {
      const raw = readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : []
      const now = Date.now()
      this.data = {
        version: 1,
        tasks: tasks.filter((task) => {
          if (task === null || typeof task !== 'object') return false
          // 只有 id 是必需的：sessionId 可以为空（「到点新开对话」的任务在投递后才回填）。
          if (typeof task.id !== 'string') return false
          if (task.sessionId !== undefined && typeof task.sessionId !== 'string') return false
          if (task.status === ACTIVE) return true
          const stamp = Date.parse(task.finishedAt ?? task.at ?? '')
          return Number.isFinite(stamp) ? now - stamp < RETENTION_MS : false
        }),
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return
      try {
        renameSync(this.file, `${this.file}.broken-${Date.now()}`)
      } catch { /* 备份失败也不影响启动 */ }
      console.error('[scheduled-send] tasks.json 读取失败，已忽略：', reasonOf(error))
      this.data = { version: 1, tasks: [] }
    }
  }

  /** 原子落盘。 */
  save() {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }

  /** @returns {any[]} 全部任务（副本）。 */
  list() {
    return this.data.tasks.map((task) => ({ ...task }))
  }

  /** @param {string} id */
  find(id) {
    return this.data.tasks.find((task) => task.id === id)
  }

  /** @param {any} task */
  add(task) {
    this.data.tasks.push(task)
    this.save()
    return task
  }

  /**
   * 合并式更新：只覆盖调用方给的字段。
   * @param {string} id
   * @param {Record<string, unknown>} patch
   */
  update(id, patch) {
    const task = this.find(id)
    if (task === undefined) return undefined
    Object.assign(task, patch)
    this.save()
    return { ...task }
  }
}

/** 本机同源 POST 守卫（与 dsh-free-search 的 bridge 路由同一套判定思路）。 */
function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  const value = address.startsWith('::ffff:') ? address.slice(7) : address
  return value === '::1' || value === '127.0.0.1' || value.startsWith('127.')
}

/** @returns {boolean} 是否允许处理。 */
function requestAllowed(req) {
  if (req.method !== 'POST') return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return false
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '') {
    try {
      if (new URL(origin).host !== host) return false
    } catch {
      return false
    }
  }
  const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
  if (hostname === '127.0.0.1' || hostname === '::1' || hostname === 'localhost') {
    return isLoopbackAddress(req.socket?.remoteAddress)
  }
  // 非 loopback Host（例如经移动端网关转发）：只接受同源请求，且连接本身来自本机代理。
  const local = req.socket?.localAddress
  return isLoopbackAddress(local) || local === hostname
}

/** 写 JSON 响应。 */
function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload)
}

/** 读 JSON 请求体；超限或非法返回 undefined。 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * 定时引擎：持有唯一 timer，串行投递，失败不重排（避免死循环）。
 * @param {{store: TaskStore, deliver: (task: any) => Promise<{ok: boolean, error?: string}>, log: (...args: any[]) => void}} options
 */
function createEngine({ store, deliver, log }) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer
  let stopped = false
  /** 正在投递中的任务 id，避免事件循环重复触发。 */
  const inflight = new Set()

  function clearTimer() {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  function arm() {
    clearTimer()
    if (stopped) return
    const now = Date.now()
    const next = store
      .list()
      .filter((task) => task.status === ACTIVE)
      .map((task) => Date.parse(task.at))
      .filter((at) => Number.isFinite(at))
      .sort((a, b) => a - b)[0]
    if (next === undefined) return
    const delay = Math.max(0, Math.min(next - now, MAX_TIMER_SLEEP_MS))
    timer = setTimeout(() => {
      tick().catch((error) => log('tick failed:', reasonOf(error)))
    }, delay)
    if (typeof timer.unref === 'function') timer.unref()
  }

  async function tick() {
    if (stopped) return
    const now = Date.now()
    const due = store
      .list()
      .filter((task) => task.status === ACTIVE && Date.parse(task.at) <= now)
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    for (const task of due) {
      if (stopped) return
      if (inflight.has(task.id)) continue
      inflight.add(task.id)
      try {
        store.update(task.id, { status: 'sending', lastAttemptAt: new Date().toISOString() })
        const outcome = await deliver(task)
        if (outcome.ok) {
          store.update(task.id, {
            status: 'sent',
            sentAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            error: undefined,
          })
          log(`已发送 ${task.id} → 会话 ${task.sessionId}`)
        } else {
          store.update(task.id, {
            status: 'failed',
            finishedAt: new Date().toISOString(),
            error: outcome.error ?? 'unknown error',
          })
          log(`发送失败 ${task.id}：${outcome.error ?? 'unknown'}`)
        }
      } catch (error) {
        store.update(task.id, {
          status: 'failed',
          finishedAt: new Date().toISOString(),
          error: reasonOf(error),
        })
        log(`发送异常 ${task.id}：${reasonOf(error)}`)
      } finally {
        inflight.delete(task.id)
      }
    }
    arm()
  }

  return {
    start() {
      stopped = false
      arm()
    },
    /** 新任务落地后调用。 */
    reschedule: arm,
    stop() {
      stopped = true
      clearTimer()
    },
    tick,
  }
}

/**
 * 纯逻辑出口，供 test/ 直接单测（不启动 Host）。
 * 不属于对外 API，改动不保证兼容。
 */
export const __test = { TaskStore, createEngine, requestAllowed, resolveDataDir }

/**
 * 插件入口。所有副作用都在 try/catch 内，保证不会让 Host 启动失败。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 */
export function apply(ctx) {
  /** @type {TaskStore | undefined} */
  let store
  try {
    store = new TaskStore(join(resolveDataDir(), 'tasks.json'))
  } catch (error) {
    console.error('[scheduled-send] 数据目录不可用，插件停用：', reasonOf(error))
    return
  }

  const log = (...args) => console.info('[scheduled-send]', ...args)
  /** @type {any} */
  let sessionController
  /** @type {any} */
  let engine
  /** 需要随插件卸载一起释放的 fiber。 */
  const fibers = []

  /**
   * 真发：走 Host 公开的 Session 命令面，等价于用户回车。
   * @param {any} task
   */
  async function deliver(task) {
    if (sessionController === undefined) return { ok: false, error: 'sessionController 尚未就绪' }
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(new Error('delivery timeout')), DELIVER_TIMEOUT_MS)
    try {
      // 会话可能是到点才建的（「新开对话」模式）。此刻先把它建出来：
      // 建完立刻发送，所以它不会停留在 blank 空壳状态，也就不会抢「新会话」。
      let sessionId = task.sessionId
      if (typeof sessionId !== 'string' || sessionId === '') {
        const target = {}
        if (typeof task.workspaceId === 'string' && task.workspaceId !== '') target.workspaceId = task.workspaceId
        else if (typeof task.cwd === 'string' && task.cwd !== '') target.cwd = task.cwd
        const created = await sessionController.create(target)
        sessionId = created.sessionId
        // 回填，便于列表显示与「立即发送」重试保持同一个目标。
        store.update(task.id, { sessionId })
      }

      await sessionController.prompt(
        {
          requestId: randomUUID(),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: task.text }],
          ...(typeof task.timeZone === 'string' && task.timeZone !== '' ? { clientTimeZone: task.timeZone } : {}),
        },
        abort.signal,
      )
      return { ok: true }
    } catch (error) {
      return { ok: false, error: reasonOf(error) }
    } finally {
      clearTimeout(timeout)
    }
  }

  try {
    engine = createEngine({ store, deliver, log })
  } catch (error) {
    console.error('[scheduled-send] 定时引擎创建失败：', reasonOf(error))
    return
  }

  // 定时器：随 sessionController 可用而启动（Host 侧它由 dsh-base 提供）。
  // 用 ctx.inject 直接挂子 fiber：服务缺失时只是这个回调不运行，插件本体不受影响；
  // 子 fiber 会随父 fiber 一起卸载（不要在 ctx.effect 里返回 fiber，那不是合法 effect）。
  try {
    fibers.push(
      ctx.inject(['sessionController'], (child) => {
        try {
          sessionController = child.sessionController
          engine.start()
          log('定时引擎已启动，数据文件：', store.file)
          child.effect(() => () => engine.stop(), 'scheduled-send: timer')
        } catch (error) {
          console.error('[scheduled-send] 定时引擎启动失败：', reasonOf(error))
        }
      }),
    )
  } catch (error) {
    console.error('[scheduled-send] sessionController 注入失败：', reasonOf(error))
  }

  // HTTP 面：给浏览器半件用（创建/列表/取消/改时间/立即发送/重试）。
  try {
    fibers.push(
      ctx.inject(['webServer'], (child) => {
        try {
          const dispose = child.webServer.register({
            kind: 'exact',
            path: ROUTE_PATH,
            handler: async (req, res) => {
              if (!requestAllowed(req)) {
                writeJson(res, 403, { ok: false, error: 'forbidden' })
                return
              }
              const body = await readJsonBody(req)
              if (body === undefined) {
                writeJson(res, 400, { ok: false, error: 'malformed JSON body' })
                return
              }
              try {
                writeJson(res, 200, await handle(body))
              } catch (error) {
                writeJson(res, 200, { ok: false, error: reasonOf(error) })
              }
            },
          })
          child.effect(() => () => dispose(), 'scheduled-send: route')
        } catch (error) {
          console.error('[scheduled-send] 路由注册失败：', reasonOf(error))
        }
      }),
    )
  } catch (error) {
    console.error('[scheduled-send] webServer 注入失败：', reasonOf(error))
  }

  /**
   * 动作分发。
   * @param {any} body
   * @returns {Promise<any>}
   */
  async function handle(body) {
    const action = typeof body?.action === 'string' ? body.action : ''
    switch (action) {
      case 'health':
        return { ok: true, value: { plugin: 'dsh-scheduled-send', dataFile: store.file, tasks: store.list().length } }

      case 'create': {
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (text === '') return { ok: false, error: '消息内容为空' }
        if (text.length > MAX_TEXT_CHARS) return { ok: false, error: '消息内容过长' }
        const at = Date.parse(typeof body.at === 'string' ? body.at : '')
        if (!Number.isFinite(at)) return { ok: false, error: '时间无效' }
        if (at <= Date.now() + 1000) return { ok: false, error: '时间必须晚于当前时间' }
        if (sessionController === undefined) return { ok: false, error: 'sessionController 尚未就绪' }

        // 两种绑定模式：
        //
        // - 给了 sessionId（对话内定时发送）：直接绑到那个已存在的会话。
        // - 没给（新开一个对话）：**此刻就把会话建出来**，并且一条任务独占一个会话。
        //
        // 为什么必须预创建、而不是等投递时再建：
        // 用户明确要求「新会话不要全发到同一个会话里」。若延后创建，每条任务到点各自
        // create 一次，表面看是独立的；但用户希望确认时就能看到那个会话、并能立刻进去
        // 打字，所以这里选择预创建。
        //
        // 预创建有个坑必须处理：DSH 的「新建会话」按钮会复用任何 `blank: true` 的会话
        // （ui-workspace createInWorkspace 按 blank 挑可复用空壳），而 blank 只在产出过
        // turn/start 之后才变 false。所以预创建之后要**立刻触发一次 turn** 让它脱离
        // blank，否则它会顶掉用户自己的「新会话」。
        //
        // 脱离 blank 的方式：发一条极短的占位 prompt，然后立即取消该轮。
        // 这条占位消息会留在历史里（这是预创建的固有代价），因此用一个不可能被
        // 误认为用户意图的固定标记，方便用户识别与清理。
        const boundSessionId = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : undefined

        /** 预创建会话并立即脱离 blank 状态。 */
        const precreate = async () => {
          const target = {}
          if (typeof body.workspaceId === 'string' && body.workspaceId !== '') target.workspaceId = body.workspaceId
          else if (typeof body.cwd === 'string' && body.cwd !== '') target.cwd = body.cwd
          const created = await sessionController.create(target)
          const sessionId = created.sessionId
          // 触发一次 turn 让 blank 变 false：prompt 会被准入并写入 user/message，
          // 紧接着 cancel 停掉这一轮，避免真的消耗一次完整生成。
          try {
            await sessionController.prompt(
              {
                requestId: randomUUID(),
                sessionId,
                mode: 'queue',
                content: [{ type: 'text', text: PLACEHOLDER_TEXT }],
              },
              new AbortController().signal,
            )
            // 取消该轮；失败不影响会话已脱离 blank 的事实。
            try {
              await sessionController.cancel({ sessionId })
            } catch { /* 已自行结束或无可取消 */ }
          } catch (error) {
            // 占位轮失败不算致命：会话已建好，只是可能仍是 blank。
            // 记下原因，便于用户排查「新会话被顶掉」的残留情况。
            console.warn('[scheduled-send] 占位轮失败（会话可能仍是 blank）：', reasonOf(error))
          }
          return sessionId
        }

        let sessionId = boundSessionId
        if (sessionId === undefined) {
          try {
            sessionId = await precreate()
          } catch (error) {
            return { ok: false, error: `新建会话失败：${reasonOf(error)}` }
          }
        }

        const task = {
          id: randomUUID(),
          sessionId,
          text,
          at: new Date(at).toISOString(),
          timeZone: typeof body.timeZone === 'string' ? body.timeZone : '',
          status: ACTIVE,
          createdAt: new Date().toISOString(),
        }

        try {
          store.add(task)
          engine.reschedule()
        } catch (error) {
          return { ok: false, error: `保存定时任务失败：${reasonOf(error)}`, sessionId }
        }
        return { ok: true, value: { task, sessionId } }
      }

      case 'list': {
        const sessionId = typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : undefined
        const includeFinished = body.includeFinished === true
        const tasks = store
          .list()
          .filter((task) => sessionId === undefined || task.sessionId === sessionId)
          .filter((task) => includeFinished || task.status === ACTIVE || task.status === 'sending' || task.status === 'failed')
          .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
        return { ok: true, value: { tasks, now: Date.now() } }
      }

      case 'updateTask': {
        // 正文与时间一起改（编辑态保存）。at 省略则保留原时间。
        const id = typeof body.id === 'string' ? body.id : ''
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (text === '') return { ok: false, error: '消息内容为空' }
        if (text.length > MAX_TEXT_CHARS) return { ok: false, error: '消息内容过长' }
        const task = store.find(id)
        if (task === undefined) return { ok: false, error: '任务不存在' }
        if (task.status !== ACTIVE && task.status !== 'failed') return { ok: false, error: '任务已结束，无法编辑' }

        const patch = { text, editedAt: new Date().toISOString() }
        if (typeof body.at === 'string' && body.at !== '') {
          const at = Date.parse(body.at)
          if (!Number.isFinite(at)) return { ok: false, error: '时间无效' }
          if (at <= Date.now() + 1000) return { ok: false, error: '时间必须晚于当前时间' }
          patch.at = new Date(at).toISOString()
          // 失败项改完时间重新进入待发，否则它仍是终点状态、永远不会被调度。
          if (task.status === 'failed') patch.status = ACTIVE
          patch.error = undefined
        }
        const updated = store.update(id, patch)
        if (patch.at !== undefined) engine.reschedule()
        return { ok: true, value: { task: updated } }
      }

      case 'updateText': {
        // 只改正文，**不动 at**：用户编辑的是文字，没要求改时间。
        // 时间要改走 reschedule，两条路径分开更不容易误伤。
        const id = typeof body.id === 'string' ? body.id : ''
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (text === '') return { ok: false, error: '消息内容为空' }
        if (text.length > MAX_TEXT_CHARS) return { ok: false, error: '消息内容过长' }
        const task = store.find(id)
        if (task === undefined) return { ok: false, error: '任务不存在' }
        // 失败的任务也要能改：失败往往正是内容或目标有问题，编辑后才能重试。
        if (task.status !== ACTIVE && task.status !== 'failed') return { ok: false, error: '任务已结束，无法编辑' }
        const updated = store.update(id, { text, editedAt: new Date().toISOString() })
        return { ok: true, value: { task: updated } }
      }

      case 'cancel': {
        const id = typeof body.id === 'string' ? body.id : ''
        const task = store.find(id)
        if (task === undefined) return { ok: false, error: '任务不存在' }
        // 失败的任务同样允许取消：用户可能只想把这行从列表里清掉。
        if (task.status !== ACTIVE && task.status !== 'failed') return { ok: false, error: '任务已结束，无法取消' }
        store.update(id, { status: 'cancelled', finishedAt: new Date().toISOString() })
        engine.reschedule()
        return { ok: true, value: { task: store.find(id) } }
      }

      case 'reschedule': {
        const id = typeof body.id === 'string' ? body.id : ''
        const at = Date.parse(typeof body.at === 'string' ? body.at : '')
        if (!Number.isFinite(at)) return { ok: false, error: '时间无效' }
        if (at <= Date.now() + 1000) return { ok: false, error: '时间必须晚于当前时间' }
        const task = store.find(id)
        if (task === undefined) return { ok: false, error: '任务不存在' }
        if (task.status !== ACTIVE) return { ok: false, error: '任务已结束，无法改时间' }
        const updated = store.update(id, { at: new Date(at).toISOString(), status: ACTIVE })
        engine.reschedule()
        return { ok: true, value: { task: updated } }
      }

      case 'sendNow':
      case 'retry': {
        const id = typeof body.id === 'string' ? body.id : ''
        const task = store.find(id)
        if (task === undefined) return { ok: false, error: '任务不存在' }
        if (task.status === 'sending') return { ok: false, error: '正在发送中' }
        store.update(id, { status: ACTIVE, at: new Date().toISOString(), error: undefined })
        engine.reschedule()
        await engine.tick()
        return { ok: true, value: { task: store.find(id) } }
      }

      default:
        return { ok: false, error: `未知动作：${action || '(空)'}` }
    }
  }
}
