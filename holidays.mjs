/**
 * 节假日联网同步（Host 半件）。
 *
 * 目标：不用每次国务院发通知就发新版插件。
 *
 * 策略：**内置表是兜底，联网数据是优选**。
 * - 启动时异步拉一次；成功就缓存到磁盘，下次启动先用缓存（离线/N 天没过期也够用）。
 * - 拉到比内置表更新的年份才覆盖；拉不到就什么都不做，绝不让内置表退化。
 * - 全程超时 + try/catch，且**不阻塞插件启动**——网络问题不能影响定时功能本身。
 *
 * 数据源（任一成功即可，先到先用）：
 * 1. timor.tech —— 免费、无需 key、返回结构固定
 *    `{holiday: {"01-01": {holiday: bool, name: "元旦", ...}}}`
 * 2. NateScarlet/holiday-cn —— GitHub 上的 JSON，community 维护，含调休
 *
 * 注意：这些是**第三方**数据，可能滞后（实测 2027 年国务院已公布，timor 仍为空）。
 * 所以内置表必须保持完整，联网只是补未知年份/纠正笔误。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 单次请求超时：节假日数据不值得让启动等太久。 */
const FETCH_TIMEOUT_MS = 8000
/** 缓存多久算新鲜：超过就不再信任，但仍可作为兜底（宁可旧也不要空）。 */
const CACHE_FRESH_MS = 30 * 24 * 60 * 60 * 1000

/** 数据源定义：每个返回 `{ holidays, makeup }`，失败抛错。 */
const SOURCES = [
  {
    id: 'timor',
    url: (year) => `https://timor.tech/api/holiday/year/${year}/`,
    parse: parseTimor,
  },
  {
    id: 'holiday-cn',
    url: (year) => `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`,
    parse: parseHolidayCn,
  },
]

/** 规范化成 `{holidays: {'MM-DD': true}}` 中间形态。 */
function emptyYear() {
  return { holidays: new Set(), makeup: new Set() }
}

/** timor.tech：`holiday` 是 `MM-DD -> {holiday: bool, name}` 的字典。 */
function parseTimor(raw, year) {
  const out = new Map()
  const holiday = raw && typeof raw === 'object' ? raw.holiday : null
  if (holiday === null || typeof holiday !== 'object') return out
  const bucket = emptyYear()
  for (const [key, entry] of Object.entries(holiday)) {
    // key 形如 "01-01"；也兼容 "01-01-2027" 这种写法，取前 5 位。
    const stamp = String(key).slice(0, 5)
    if (!/^\d{2}-\d{2}$/.test(stamp)) continue
    if (entry && entry.holiday === true) bucket.holidays.add(stamp)
    // timor 把「调休补班」也放在同一张表里：holiday=false 且带 name 的即补班日。
    else if (entry && entry.holiday === false && entry.name) bucket.makeup.add(stamp)
  }
  // year 由调用方给定（API 响应体里不一定带年份）。
  if (bucket.holidays.size > 0 || bucket.makeup.size > 0) out.set(String(year), bucket)
  return out
}

/**
 * holiday-cn：数组，每项 `{date: '2027-01-01', isOffDay: bool, name}`。
 * 这个格式最干净——日期完整、isOffDay 明确。
 */
function parseHolidayCn(raw, year) {
  const list = raw && typeof raw === 'object' && Array.isArray(raw.days) ? raw.days : (Array.isArray(raw) ? raw : [])
  const out = new Map()
  const bucket = emptyYear()
  for (const day of list) {
    const date = String(day?.date ?? '')
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
    if (match === null) continue
    if (Number(match[1]) !== Number(year)) continue
    const stamp = `${match[2]}-${match[3]}`
    if (day.isOffDay === true) bucket.holidays.add(stamp)
    else bucket.makeup.add(stamp)
  }
  if (bucket.holidays.size > 0) out.set(String(year), bucket)
  return out
}

/** 把 Map 形态收敛成可 JSON 化的普通对象。 */
function toPlain(map) {
  const holidays = {}
  const makeup = {}
  for (const [year, bucket] of map) {
    if (bucket.holidays.size > 0) holidays[year] = [...bucket.holidays].sort()
    if (bucket.makeup.size > 0) makeup[year] = [...bucket.makeup].sort()
  }
  return { holidays, makeup }
}

/** 带超时的 fetch，返回解析后的 JSON；失败抛错。 */
async function fetchJson(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'dsh-timed-send (+https://github.com/zlqd123/dsh-timed-send)' },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 创建同步器。
 *
 * @param {object} options
 * @param {string} options.cacheFile - 缓存落盘路径。
 * @param {number} [options.years] - 要同步的未来年数（含今年）。
 * @param {(...args: any[]) => void} [options.log] - 日志。
 */
export function createHolidaySync({ cacheFile, years = 2, log = () => {} }) {
  /** 内存中的当前数据：`{holidays, makeup, fetchedAt, source}` */
  let current = null

  function readCache() {
    try {
      const parsed = JSON.parse(readFileSync(cacheFile, 'utf8'))
      if (parsed === null || typeof parsed !== 'object') return null
      if (typeof parsed.holidays !== 'object' || typeof parsed.makeup !== 'object') return null
      return parsed
    } catch (error) {
      if (error?.code !== 'ENOENT') log('缓存读取失败（忽略）:', error?.message ?? String(error))
      return null
    }
  }

  function writeCache(value) {
    try {
      mkdirSync(dirname(cacheFile), { recursive: true })
      const tmp = `${cacheFile}.tmp-${process.pid}-${Date.now()}`
      writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
      renameSync(tmp, cacheFile)
    } catch (error) {
      log('缓存写入失败（忽略）:', error?.message ?? String(error))
    }
  }

  /** 该年的数据是否已经有足够覆盖（至少 1 个法定假日）。 */
  function coversYear(value, year) {
    const list = value && value.holidays ? value.holidays[year] : undefined
    return Array.isArray(list) && list.length > 0
  }

  /**
   * 同步一年：按顺序尝试各数据源，第一个有数据的就用。
   *
   * @param {number} year
   * @returns {Promise<{year: number, holidays: string[], makeup: string[], source: string} | null>}
   */
  async function syncYear(year) {
    for (const source of SOURCES) {
      try {
        const raw = await fetchJson(source.url(year))
        const parsed = source.parse(raw, year)
        const plain = toPlain(parsed)
        const holidays = plain.holidays[String(year)] ?? []
        if (holidays.length === 0) {
          log(`${source.id} ${year} 无数据，试下一个源`)
          continue
        }
        return {
          year,
          holidays,
          makeup: plain.makeup[String(year)] ?? [],
          source: source.id,
        }
      } catch (error) {
        log(`${source.id} ${year} 拉取失败：`, error?.message ?? String(error))
      }
    }
    return null
  }
  return {
    /** 当前生效数据（可能是缓存，也可能是刚拉到的）。 */
    get() {
      return current
    },

    /**
     * 启动时调用：先用缓存，再后台拉新。
     *
     * 不 await 联网部分——启动不能被网络拖住。返回缓存快照供调用方立即使用。
     */
    loadCache() {
      const cached = readCache()
      if (cached !== null) {
        current = { ...cached, origin: 'cache' }
        const age = Date.now() - Number(cached.fetchedAt ?? 0)
        log(`节假日缓存已载入（${age > CACHE_FRESH_MS ? '已过期，仍作为兜底' : '新鲜'}）`)
      }
      return current
    },

    /**
     * 后台刷新：拉未来 `years` 年，合并进现有数据并落盘。
     * 任何一年都没拉到就原样保留，不做破坏性写入。
     */
    async refresh(now = new Date()) {
      // 从「当前年份」开始往后拉：跨年前后两个月都可能需要明年数据。
      const baseYear = now.getFullYear()
      const targets = []
      for (let i = 0; i < years; i += 1) targets.push(baseYear + i)

      const merged = {
        holidays: { ...(current?.holidays ?? {}) },
        makeup: { ...(current?.makeup ?? {}) },
        fetchedAt: Date.now(),
        source: current?.source ?? 'none',
      }
      let touched = false
      const sources = new Set()
      for (const year of targets) {
        // 每年最多试 2 轮：网络瞬断很常见（DNS 未就绪、连接被重置），
        // 单次失败就直接放弃会让「自动联网」形同虚设。
        let got = await syncYear(year)
        if (got === null) {
          await new Promise((resolve) => setTimeout(resolve, 1500))
          got = await syncYear(year)
        }
        if (got === null) continue
        merged.holidays[String(year)] = got.holidays
        merged.makeup[String(year)] = got.makeup
        sources.add(got.source)
        touched = true
        log(`节假日 ${year} 已更新：${got.holidays.length} 个休假日（来源 ${got.source}）`)
      }
      if (!touched) {
        log('节假日联网更新未取到新数据，继续使用内置/缓存表')
        return current
      }
      merged.source = [...sources].join('+')
      current = { ...merged, origin: 'remote' }
      writeCache(merged)
      return current
    },

    /** 供 HTTP 动作把当前数据交给浏览器。 */
    snapshot() {
      return current === null ? null : {
        holidays: current.holidays ?? {},
        makeup: current.makeup ?? {},
        fetchedAt: current.fetchedAt ?? null,
        source: current.source ?? null,
      }
    },
  }
}
