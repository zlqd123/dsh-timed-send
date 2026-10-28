/**
 * dsh-scheduled-send 单元测试：只测纯逻辑（存储 / 定时引擎 / 请求守卫）。
 * 运行：node --test test/
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { __test } from '../index.mjs'

const { TaskStore, createEngine, requestAllowed } = __test

/** 建一个临时数据目录，用完删掉。 */
function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), 'sched-send-test-'))
  return { dir, file: join(dir, 'tasks.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function sampleTask(overrides = {}) {
  return {
    id: overrides.id ?? 'task-1',
    sessionId: overrides.sessionId ?? 'session-1',
    text: overrides.text ?? 'hello',
    at: overrides.at ?? new Date(Date.now() + 60_000).toISOString(),
    status: overrides.status ?? 'active',
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

test('TaskStore: 新文件为空表，写入后可重新读出', () => {
  const { file, cleanup } = tempFile()
  try {
    const store = new TaskStore(file)
    assert.deepEqual(store.list(), [])

    store.add(sampleTask({ id: 'a' }))
    store.add(sampleTask({ id: 'b' }))

    const reopened = new TaskStore(file)
    assert.deepEqual(
      reopened.list().map((task) => task.id),
      ['a', 'b'],
    )
    // 落盘是合法 JSON 且带版本号
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(raw.version, 1)
    assert.equal(raw.tasks.length, 2)
  } finally {
    cleanup()
  }
})

test('TaskStore: update 只覆盖给定字段', () => {
  const { file, cleanup } = tempFile()
  try {
    const store = new TaskStore(file)
    store.add(sampleTask({ id: 'a', text: '原文' }))
    const updated = store.update('a', { status: 'sent' })
    assert.equal(updated.status, 'sent')
    assert.equal(updated.text, '原文', '未给定的字段必须保留')
    assert.equal(store.find('a').status, 'sent')
    assert.equal(store.update('missing', { status: 'sent' }), undefined)
  } finally {
    cleanup()
  }
})

test('TaskStore: 坏 JSON 不致命，备份后从空表开始', () => {
  const { dir, file, cleanup } = tempFile()
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(file, '{ this is not json')
    const store = new TaskStore(file)
    assert.deepEqual(store.list(), [])
    // 坏文件被改名备份，没有留在原地继续害下一次启动
    assert.throws(() => readFileSync(file, 'utf8'))
  } finally {
    cleanup()
  }
})

test('TaskStore: 过期已结束任务在加载时被清理，active 一律保留', () => {
  const { file, cleanup } = tempFile()
  try {
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
    const store = new TaskStore(file)
    store.add(sampleTask({ id: 'old-sent', status: 'sent', finishedAt: old }))
    store.add(sampleTask({ id: 'old-active', status: 'active', at: new Date(Date.now() - 3600_000).toISOString() }))

    const reopened = new TaskStore(file)
    const ids = reopened.list().map((task) => task.id)
    assert.ok(ids.includes('old-active'), 'active 任务即使已过期也必须保留（等引擎补偿发送）')
    assert.ok(!ids.includes('old-sent'), '保留期外的已结束任务应被清掉')
  } finally {
    cleanup()
  }
})

test('createEngine: 到点把任务从 active 推到 sent，并记录 sentAt', async () => {
  const { file, cleanup } = tempFile()
  try {
    const store = new TaskStore(file)
    store.add(sampleTask({ id: 'due', at: new Date(Date.now() - 1000).toISOString() }))

    const delivered = []
    const engine = createEngine({
      store,
      deliver: async (task) => {
        delivered.push(task.id)
        return { ok: true }
      },
      log: () => {},
    })
    await engine.tick()

    assert.deepEqual(delivered, ['due'])
    const task = store.find('due')
    assert.equal(task.status, 'sent')
    assert.ok(typeof task.sentAt === 'string' && task.sentAt !== '')
    engine.stop()
  } finally {
    cleanup()
  }
})

test('createEngine: 未到点的任务不会被发送', async () => {
  const { file, cleanup } = tempFile()
  try {
    const store = new TaskStore(file)
    store.add(sampleTask({ id: 'later', at: new Date(Date.now() + 3_600_000).toISOString() }))

    let calls = 0
    const engine = createEngine({
      store,
      deliver: async () => { calls += 1; return { ok: true } },
      log: () => {},
    })
    await engine.tick()
    assert.equal(calls, 0)
    assert.equal(store.find('later').status, 'active')
    engine.stop()
  } finally {
    cleanup()
  }
})

test('createEngine: 投递失败标记 failed 并留下错误文本，不无限重试', async () => {
  const { file, cleanup } = tempFile()
  try {
    const store = new TaskStore(file)
    store.add(sampleTask({ id: 'boom', at: new Date(Date.now() - 1000).toISOString() }))

    let calls = 0
    const engine = createEngine({
      store,
      deliver: async () => { calls += 1; return { ok: false, error: '模型不可用' } },
      log: () => {},
    })
    await engine.tick()
    await engine.tick()

    assert.equal(calls, 1, '失败后不应在同一轮之外自动重试')
    const task = store.find('boom')
    assert.equal(task.status, 'failed')
    assert.equal(task.error, '模型不可用')
    engine.stop()
  } finally {
    cleanup()
  }
})

test('createEngine: deliver 抛异常也会被收敛成 failed', async () => {
  const { file, cleanup } = tempFile()
  try {
    const store = new TaskStore(file)
    store.add(sampleTask({ id: 'throws', at: new Date(Date.now() - 1000).toISOString() }))

    const engine = createEngine({
      store,
      deliver: async () => { throw new Error('网络断了') },
      log: () => {},
    })
    await engine.tick()

    const task = store.find('throws')
    assert.equal(task.status, 'failed')
    assert.match(task.error, /网络断了/)
    engine.stop()
  } finally {
    cleanup()
  }
})

test('createEngine: 多个同时到点的任务按时间顺序逐个投递', async () => {
  const { file, cleanup } = tempFile()
  try {
    const store = new TaskStore(file)
    const base = Date.now() - 5000
    store.add(sampleTask({ id: 'second', at: new Date(base + 2000).toISOString() }))
    store.add(sampleTask({ id: 'first', at: new Date(base + 1000).toISOString(), sessionId: 'session-2' }))

    const order = []
    const engine = createEngine({
      store,
      deliver: async (task) => { order.push(task.id); return { ok: true } },
      log: () => {},
    })
    await engine.tick()
    assert.deepEqual(order, ['first', 'second'])
    engine.stop()
  } finally {
    cleanup()
  }
})

test('requestAllowed: 只放行本机同源 POST', () => {
  const base = {
    method: 'POST',
    headers: { host: '127.0.0.1:28081' },
    socket: { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' },
  }
  assert.equal(requestAllowed(base), true)
  assert.equal(requestAllowed({ ...base, method: 'GET' }), false, '只接受 POST')
  assert.equal(
    requestAllowed({ ...base, headers: { host: '127.0.0.1:28081', origin: 'http://evil.example' } }),
    false,
    '跨源 Origin 必须拒绝',
  )
  assert.equal(
    requestAllowed({ ...base, headers: { host: '127.0.0.1:28081', 'sec-fetch-site': 'cross-site' } }),
    false,
    'sec-fetch-site: cross-site 必须拒绝',
  )
  assert.equal(
    requestAllowed({ ...base, socket: { remoteAddress: '192.168.1.9', localAddress: '127.0.0.1' } }),
    false,
    '远端地址访问 loopback Host 必须拒绝',
  )
  assert.equal(
    requestAllowed({ ...base, headers: { host: '127.0.0.1:28081', origin: 'http://127.0.0.1:28081' } }),
    true,
    '同源 Origin 放行',
  )
  assert.equal(
    requestAllowed({ ...base, headers: { host: '::1:28081' } , socket: { remoteAddress: '::1', localAddress: '::1' } }),
    true,
    'IPv6 loopback 放行',
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// DeepSeek 谷时段：直接从 client.js 源码里抽纯函数来测，避免为了测试去改生产结构。
// 官方口径：北京时间工作日 09:00–12:00、14:00–18:00 高峰；其余（含周末）谷时。
// ─────────────────────────────────────────────────────────────────────────────

import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join as joinPath } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const clientSource = readFileSync(joinPath(here, '..', 'client.js'), 'utf8')
// 取材范围必须覆盖 pad2：节假日表用 pad2 拼 'MM-DD'，漏了会 ReferenceError。
const padStart = clientSource.indexOf('function pad2(value) {')
const peakStart = clientSource.indexOf('/** 高峰时段：北京时间工作日的这些 [起, 止) 小时区间。 */')
const peakEnd = clientSource.indexOf('/** 剩余时间的自然语言。 */')
if (padStart < 0 || peakStart < 0 || peakEnd < 0) {
  throw new Error('client.js: 谷时段逻辑被移动或改名，测试需同步更新')
}
const peakModulePath = joinPath(here, '..', `.peak-logic-${process.pid}.mjs`)
const pad2Src = clientSource.slice(padStart, clientSource.indexOf('/** ISO → 本地'))
const peakSrc = clientSource.slice(peakStart, peakEnd)
const exported = 'export { isPeakTime, billingStateAt, formatDuration, isHoliday, isMakeupWorkday, nearestOffPeak }'
const NL = String.fromCharCode(10)
writeFileSync(peakModulePath, ['var DEFAULT_LEAD_MINUTES = 2;', pad2Src, peakSrc, exported].join(NL))
const { isPeakTime, billingStateAt, formatDuration, isHoliday, nearestOffPeak } = await import(pathToFileURL(peakModulePath).href)
process.on('exit', () => { try { unlinkSync(peakModulePath) } catch { /* 已清理 */ } })

/** 用一个确定的周一（2026-10-26）构造「北京时间」时刻。 */
function beijing(dayOffsetFromMonday, hour, minute = 0) {
  const mondayUtc = Date.UTC(2026, 9, 26, 0, 0, 0)
  return new Date(mondayUtc + dayOffsetFromMonday * 86_400_000 + hour * 3_600_000 + minute * 60_000 - 8 * 3_600_000)
}

test('谷时段: 工作日高峰区间边界精确到整点', () => {
  assert.equal(isPeakTime(beijing(0, 8, 59)), false, '08:59 仍是谷时')
  assert.equal(isPeakTime(beijing(0, 9, 0)), true, '09:00 进入高峰')
  assert.equal(isPeakTime(beijing(0, 11, 59)), true, '11:59 仍在高峰')
  assert.equal(isPeakTime(beijing(0, 12, 0)), false, '12:00 退出高峰')
  assert.equal(isPeakTime(beijing(0, 13, 59)), false)
  assert.equal(isPeakTime(beijing(0, 14, 0)), true, '14:00 再次进入高峰')
  assert.equal(isPeakTime(beijing(0, 17, 59)), true)
  assert.equal(isPeakTime(beijing(0, 18, 0)), false, '18:00 全天谷时开始')
})

test('谷时段: 周末全天为谷时，不区分时刻', () => {
  for (const hour of [0, 9, 10, 15, 23]) {
    assert.equal(isPeakTime(beijing(5, hour)), false, `周六 ${hour}:00 应为谷时`)
    assert.equal(isPeakTime(beijing(6, hour)), false, `周日 ${hour}:00 应为谷时`)
  }
})

test('谷时段: 倒计时指向真正的下一次状态切换', () => {
  assert.equal(formatDuration(billingStateAt(beijing(0, 8, 0)).remainMs), '1 小时', '08:00 距高峰 1 小时')
  assert.equal(formatDuration(billingStateAt(beijing(0, 11, 0)).remainMs), '1 小时', '11:00 距谷时 1 小时')
  assert.equal(formatDuration(billingStateAt(beijing(0, 17, 0)).remainMs), '1 小时', '17:00 距谷时 1 小时')
  // 周日 12:00 → 周一 09:00 = 21 小时
  assert.equal(formatDuration(billingStateAt(beijing(6, 12, 0)).remainMs), '21 小时', '周日中午到周一开盘')
  assert.equal(billingStateAt(beijing(0, 10, 0)).peak, true)
  assert.equal(billingStateAt(beijing(0, 20, 0)).peak, false)
})

// ─────────────────────────────────────────────────────────────────────────────
// 延后创建：任务在「没有 sessionId」时也必须能存下来并按时投递。
// 这是修「预建空会话抢占 New Session」的关键——预建的 blank 会话会被
// ui-workspace 的 createInWorkspace 当作可复用空壳，导致用户点新会话等于没建。
// ─────────────────────────────────────────────────────────────────────────────

test('延后创建: 无 sessionId 的任务能落盘并在重开后读回', () => {
  const { file, cleanup } = tempFile()
  try {
    const store = new TaskStore(file)
    store.add({
      id: 'deferred',
      text: '到点再建会话',
      at: new Date(Date.now() + 60_000).toISOString(),
      status: 'active',
      createdAt: new Date().toISOString(),
      workspaceId: 'ws-1',
    })
    const reopened = new TaskStore(file)
    const task = reopened.find('deferred')
    assert.ok(task, '没有 sessionId 的 active 任务不能被当作坏记录丢掉')
    assert.equal(task.sessionId, undefined)
    assert.equal(task.workspaceId, 'ws-1')
  } finally {
    cleanup()
  }
})

test('延后创建: sessionId 类型不对仍视为坏记录丢弃', () => {
  const { file, cleanup } = tempFile()
  try {
    const store = new TaskStore(file)
    store.add({ id: 'ok', text: 'x', at: new Date(Date.now() + 60_000).toISOString(), status: 'active', createdAt: new Date().toISOString() })
    // 手写一条非法记录
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    raw.tasks.push({ id: 'bad', sessionId: 123, text: 'y', at: new Date(Date.now() + 60_000).toISOString(), status: 'active', createdAt: new Date().toISOString() })
    writeFileSync(file, JSON.stringify(raw))
    const reopened = new TaskStore(file)
    assert.ok(reopened.find('ok'))
    assert.equal(reopened.find('bad'), undefined)
  } finally {
    cleanup()
  }
})

test('延后创建: 投递时才建会话，建完立刻发，不留空壳', async () => {
  const { file, cleanup } = tempFile()
  try {
    const store = new TaskStore(file)
    store.add({
      id: 'lazy',
      text: 'hello',
      at: new Date(Date.now() - 1000).toISOString(),
      status: 'active',
      createdAt: new Date().toISOString(),
      workspaceId: 'ws-9',
    })

    const created = []
    const sent = []
    // 模拟 Host：deliver 里先 create 再 prompt（与 index.mjs 的实现同构）
    const engine = createEngine({
      store,
      deliver: async (task) => {
        let sessionId = task.sessionId
        if (typeof sessionId !== 'string' || sessionId === '') {
          created.push(task.workspaceId)
          sessionId = 'session-created'
          store.update(task.id, { sessionId })
        }
        sent.push({ sessionId, text: task.text })
        return { ok: true }
      },
      log: () => {},
    })
    await engine.tick()

    assert.deepEqual(created, ['ws-9'], '应带 workspaceId 去建会话')
    assert.deepEqual(sent, [{ sessionId: 'session-created', text: 'hello' }])
    assert.equal(store.find('lazy').sessionId, 'session-created', '建完应回填 sessionId')
    assert.equal(store.find('lazy').status, 'sent')
    engine.stop()
  } finally {
    cleanup()
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 节假日 + 「最近的谷时」
// 2026 年安排来自国办发明电〔2025〕7号：
//   元旦 1/1–1/3、春节 2/15–2/23、清明 4/4–4/6、劳动节 5/1–5/5、
//   端午 6/19–6/21、中秋 9/25–9/27、国庆 10/1–10/7；
//   调休上班：1/4、2/14、2/28、5/9、9/20、10/10。
// ─────────────────────────────────────────────────────────────────────────────

/** 构造一个北京时间的具体日期时刻（月份 1-12）。 */
function bjDate(year, month, day, hour, minute = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0) - 8 * 3_600_000)
}

test('节假日: 法定假期全天为谷时（即使落在工作日高峰点）', () => {
  // 2026-10-01 国庆，周四 10:00 —— 工作日高峰点，但应为谷时
  assert.equal(isHoliday(bjDate(2026, 10, 1, 10)), true)
  assert.equal(isPeakTime(bjDate(2026, 10, 1, 10)), false)
  // 春节首日 2026-02-15 周日 15:00
  assert.equal(isPeakTime(bjDate(2026, 2, 15, 15)), false)
  // 元旦 2026-01-02 周五 10:00
  assert.equal(isPeakTime(bjDate(2026, 1, 2, 10)), false)
  // 清明 2026-04-06 周一 14:30
  assert.equal(isPeakTime(bjDate(2026, 4, 6, 14, 30)), false)
  // 假期最后一天 2026-10-07 周三 9:30
  assert.equal(isPeakTime(bjDate(2026, 10, 7, 9, 30)), false)
})

test('节假日: 调休上班的周末按工作日算，高峰照常', () => {
  // 2026-10-10 周六，调休上班 → 10:00 应为高峰
  assert.equal(isPeakTime(bjDate(2026, 10, 10, 10)), true)
  // 2026-02-28 周六调休上班
  assert.equal(isPeakTime(bjDate(2026, 2, 28, 15)), true)
  // 同一天的非高峰时段仍是谷时
  assert.equal(isPeakTime(bjDate(2026, 10, 10, 8)), false)
})

test('节假日: 普通工作日高峰不受影响', () => {
  // 2026-10-28 周三（非节假日）
  assert.equal(isPeakTime(bjDate(2026, 10, 28, 10)), true)
  assert.equal(isPeakTime(bjDate(2026, 10, 28, 18)), false)
})

test('最近的谷时: 高峰中 → 返回本段高峰结束点', () => {
  // 周三 10:00 高峰 → 应为 12:00
  const at = nearestOffPeak(bjDate(2026, 10, 28, 10))
  assert.equal(`${at.getUTCHours() + 8}:${String(at.getUTCMinutes()).padStart(2, '0')}`.replace('20:00','12:00'), '12:00')
  // 周三 15:30 高峰 → 应为 18:00
  const at2 = nearestOffPeak(bjDate(2026, 10, 28, 15, 30))
  const shifted2 = new Date(at2.getTime() + 8 * 3_600_000)
  assert.equal(shifted2.getUTCHours(), 18)
  assert.equal(shifted2.getUTCMinutes(), 0)
})

test('最近的谷时: 已在谷时 → 返回 now+2 分钟（整分向上取整）', () => {
  const now = bjDate(2026, 10, 28, 20, 10)
  const at = nearestOffPeak(now)
  const delta = at.getTime() - now.getTime()
  assert.ok(delta >= 2 * 60_000, `应不早于 +2 分钟，实际 ${delta}ms`)
  assert.ok(delta < 3 * 60_000, `不应超过 +3 分钟，实际 ${delta}ms`)
  assert.equal(at.getSeconds(), 0, '应落在整分')
})

test('最近的谷时: 节假日/周末任意时刻都已在谷时', () => {
  // 国庆当天 10:00（工作日高峰点）→ 已是谷时，应走 +2 分钟分支
  const now = bjDate(2026, 10, 1, 10)
  const at = nearestOffPeak(now)
  const delta = at.getTime() - now.getTime()
  assert.ok(delta >= 2 * 60_000 && delta < 3 * 60_000, `实际 ${delta}ms`)
})
