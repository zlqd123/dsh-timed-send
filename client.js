/**
 * dsh-scheduled-send — browser half.
 *
 * 手写 lazy-CJS 客户端包（DSH Web 的模块工厂格式，无构建步骤）。
 *
 * 界面（按需求「发送按钮上侧、输入框外」）：
 * - 主按钮挂在 `conversation.input.dock`：那是输入框卡片「上方、框外」的整行区域，
 *   正好在发送按钮的上侧。按钮右对齐，紧贴输入框。
 * - 点开是时间面板（相对时间快选 + 具体时刻 + 可编辑正文）。
 * - 确认后：**立刻**新建一个会话页（Host 只创建、不发送任何消息），把正文作为
 *   定时内容绑定到该会话，然后跳过去。因此可以连续点多次，同时挂多个定时会话。
 * - 同一区域还显示本会话的待发定时消息：改时间 / 立即发送 / 取消 / 重试。
 *
 * 安全：
 * - 所有副作用各自 try/catch；任何失败只 console.warn，绝不阻断页面渲染或 DSH 启动。
 * - 顶层 inject 只列 `slots` / `sessions` / `workspaces`（都是稳定核心服务）。
 * - 只 require 平台种子（react 等），不静态依赖 DSH 内部模块。
 */

;(function () {
  'use strict'

  if (typeof window === 'undefined' || !window.__ModuleLoader__) return

  window.__ModuleLoader__.load({
    id: 'dsh-timed-send',
    factory: function (require) {
      /** 可选依赖：拿不到就降级，不能炸页面。 */
      function safeRequire(spec) {
        try {
          return require(spec) || {}
        } catch (error) {
          console.warn('[scheduled-send] 可选依赖缺失：', spec)
          return {}
        }
      }

      var React = safeRequire('react')
      var primitives = safeRequire('@deepseek-ai/dsh-client-ui-primitives')

      var h = React.createElement
      var useState = React.useState
      var useEffect = React.useEffect
      var useRef = React.useRef
      var useCallback = React.useCallback

      var API = '/dsh-timed-send/api'
      var STYLE_ATTR = 'data-dsh-scheduled-send-style'

      /** 文案。 */
      var TEXT = {
        'button.label': '定时发送',
        'button.tip': '定时发送：到点自动发出',
        'panel.title': '定时发送',
        'panel.subtitle': '到点由 Host 真正发出。在对话内则排进本对话；不在对话内则到点新开一个。',
        'panel.emptyDraft': '输入框是空的，请先在下方输入框写好内容。',
        'panel.confirm': '定时发送',
        'panel.cancel': '取消',
        'panel.busy': '正在创建…',
        'panel.invalidTime': '请选择晚于当前时刻的时间。',
        'panel.bumped': '默认时间已过，已顺延为 {time}，请再确认一次。',
        'panel.golden': '最近的谷时',
        'panel.goldenSet': '已设为最近的谷时段起点 {time}。',
        'panel.goldenNow': '当前已在谷时，已设为 {time}。',
        'peak.title': 'DeepSeek',
        'peak.offPeak': '谷',
        'peak.peak': '峰',
        'peak.left': '还剩 {d}',
        'peak.rule': '北京时间工作日 09:00–12:00、14:00–18:00 为高峰；周末与法定节假日全天为谷时（含 2026 年调休安排；2027 年官方未公布，暂按星期判定）。',
        'dock.pendingOne': '1 条待发',
        'dock.pendingMany': '{n} 条待发',
        'dock.sendAt': '将于 {time} 发送',
        'dock.sendNow': '立即发送',
        'dock.cancel': '取消',
        'dock.retry': '重试',
        'dock.failed': '发送失败：{error}',
        'dock.sending': '正在发送…',
        'dock.sent': '已发送',
        'dock.cancelled': '已取消',
        'dock.failedCount': '{n} 条失败',
        'dock.edit': '编辑',
        'dock.save': '保存',
        'dock.discard': '放弃',
        'dock.editing': '编辑中（内容在输入框里）',
      }

      function t(key, params) {
        var text = TEXT[key] !== undefined ? TEXT[key] : key
        if (params === undefined) return text
        return text.replace(/\{(\w+)\}/g, function (match, name) {
          return params[name] !== undefined ? String(params[name]) : match
        })
      }

      // ── 时间工具 ──────────────────────────────────────────────────────────

      function pad2(value) {
        return value < 10 ? '0' + value : String(value)
      }

      /** ISO → 本地 `HH:mm`（跨天时带 `MM-DD`）。 */
      function formatLocal(iso) {
        var date = new Date(iso)
        if (isNaN(date.getTime())) return String(iso)
        var now = new Date()
        var sameDay =
          date.getFullYear() === now.getFullYear() &&
          date.getMonth() === now.getMonth() &&
          date.getDate() === now.getDate()
        var clock = pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds())
        return sameDay ? clock : pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) + ' ' + clock
      }

      /** Date → `<input type="datetime-local">` 的本地字符串（精确到秒）。 */
      function toLocalInputValue(date) {
        return (
          date.getFullYear() +
          '-' + pad2(date.getMonth() + 1) +
          '-' + pad2(date.getDate()) +
          'T' + pad2(date.getHours()) +
          ':' + pad2(date.getMinutes()) +
          ':' + pad2(date.getSeconds())
        )
      }

      /**
       * 会话级「上次手动设置的时间」记忆。
       *
       * 需求：手动改过时间后，关闭面板再打开要保留那个时间；直到下次手动改，
       * 或成功发出一次，才重置。且**仅对当前会话有效**。
       *
       * 用 sessionStorage 按 sessionId 分键：
       * - 天然按会话隔离，不会跨会话串值；
       * - 刷新页面仍在（比内存 state 稳）；
       * - 关浏览器即清（本来就是临时偏好）。
       */
      var TIME_MEMORY_PREFIX = 'dsh-timed-send:lastTime:'

      /** 读取该会话记住的时间（本地 datetime-local 字符串），没有则 undefined。 */
      function readRememberedTime(sessionId) {
        if (typeof sessionId !== 'string' || sessionId === '') return undefined
        try {
          var raw = window.sessionStorage.getItem(TIME_MEMORY_PREFIX + sessionId)
          if (typeof raw !== 'string' || raw === '') return undefined
          // 记忆的值也要能解析，否则当作没有（防止手工改坏 storage 后崩溃）。
          return isFinite(new Date(raw).getTime()) ? raw : undefined
        } catch (error) {
          return undefined
        }
      }

      /** 记住该会话的时间；传 null 清除。 */
      function rememberTime(sessionId, value) {
        if (typeof sessionId !== 'string' || sessionId === '') return
        try {
          if (value === null || value === undefined || value === '') {
            window.sessionStorage.removeItem(TIME_MEMORY_PREFIX + sessionId)
          } else {
            window.sessionStorage.setItem(TIME_MEMORY_PREFIX + sessionId, String(value))
          }
        } catch (error) { /* 隐私模式等禁用 storage 时静默降级 */ }
      }

      /** 面板打开时预填的提前量：当前时间 + 2 分钟。 */
      var DEFAULT_LEAD_MINUTES = 2

      function minutesFromNow(minutes) {
        return new Date(Date.now() + minutes * 60 * 1000)
      }

      /**
       * 默认时刻：当前时间 + 2 分钟。
       *
       * 显示已精确到秒（输入框 step=1），所以不再需要向上取整到整分；
       * 直接 +2 分钟即可，秒数原样保留。
       */
      function defaultWhen() {
        // 保留当前秒数：这样显示出来就是「现在 +2 分钟 + 同样的秒」，
        // 用户能直观看到秒确实生效（否则恰好落在 :00 时会以为没精确到秒）。
        return new Date(Date.now() + DEFAULT_LEAD_MINUTES * 60 * 1000)
      }

      // ── DeepSeek 谷时段 ───────────────────────────────────────────────────
      //
      // 官方口径（api-docs.deepseek.com「模型 & 价格」）：北京时间周一至周五
      // 09:00–12:00、14:00–18:00 为高峰时段，其余时段（含周末全天）为空闲时段，
      // 空闲时段单价为高峰的一半。
      //
      // 注意：法定节假日官方也算空闲，但节假日表无法从客户端可靠获得，这里只按
      // 星期几判断——所以面板上的规则说明要写明「未计法定节假日」，不做假装精确。

      /** 高峰时段：北京时间工作日的这些 [起, 止) 小时区间。 */
      var PEAK_WINDOWS = [
        [9, 12],
        [14, 18],
      ]

      /** 把任意时刻换算成「北京时间的」日期、时/分、星期。 */
      function beijingParts(date) {
        // 北京时间固定 UTC+8，无夏令时；用 UTC 平移把北京墙上时间读成 UTC 字段。
        var shifted = new Date(date.getTime() + 8 * 3600 * 1000)
        return {
          Date: shifted,
          day: shifted.getUTCDay(), // 0=周日 … 6=周六
          minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
        }
      }

      /**
       * 中国法定节假日（放假日期，北京时间整日）。
       *
       * 法定节假日全天算谷时，所以这份表必须参与判定，否则节假日会被误判成
       * 「工作日高峰」。来源：国务院办公厅《关于2026年部分节假日安排的通知》
       * （国办发明电〔2025〕7号）：元旦 1/1–1/3、春节 2/15–2/23、清明 4/4–4/6、
       * 劳动节 5/1–5/5、端午 6/19–6/21、中秋 9/25–9/27、国庆 10/1–10/7。
       *
       * `2027` 官方安排尚未公布，这里留空并让代码在缺表时按「普通星期」处理；
       * 面板上的规则说明会注明年份覆盖范围，不假装已知。
       */
      var HOLIDAY_TABLE = {
        2026: [
          '01-01', '01-02', '01-03',
          '02-15', '02-16', '02-17', '02-18', '02-19', '02-20', '02-21', '02-22', '02-23',
          '04-04', '04-05', '04-06',
          '05-01', '05-02', '05-03', '05-04', '05-05',
          '06-19', '06-20', '06-21',
          '09-25', '09-26', '09-27',
          '10-01', '10-02', '10-03', '10-04', '10-05', '10-06', '10-07',
        ],
      }

      /** 调休上班日（本来该休息的周末要上班，按工作日处理）。 */
      var MAKEUP_WORKDAYS = {
        2026: ['01-04', '02-14', '02-28', '05-09', '09-20', '10-10'],
      }

      /** 该日期（北京时间）是否为法定节假日。 */
      function isHoliday(date) {
        var parts = beijingParts(date)
        var year = parts.Date.getUTCFullYear()
        var table = HOLIDAY_TABLE[year]
        if (table === undefined) return false
        var stamp = pad2(parts.Date.getUTCMonth() + 1) + '-' + pad2(parts.Date.getUTCDate())
        return table.indexOf(stamp) >= 0
      }

      /** 该日期是否为调休上班的周末。 */
      function isMakeupWorkday(date) {
        var parts = beijingParts(date)
        var table = MAKEUP_WORKDAYS[parts.Date.getUTCFullYear()]
        if (table === undefined) return false
        var stamp = pad2(parts.Date.getUTCMonth() + 1) + '-' + pad2(parts.Date.getUTCDate())
        return table.indexOf(stamp) >= 0
      }

      /**
       * 该时刻是否处于 DeepSeek 高峰时段。
       *
       * 判定顺序（官方口径）：先看是否节假日 → 节假日全天谷时；
       * 再看是否周末 → 周末全天谷时，但**调休上班的周末**是工作日；
       * 剩下才是普通工作日，落在 09–12 / 14–18 的点为高峰。
       */
      function isPeakTime(date) {
        if (isHoliday(date)) return false // 法定节假日全天谷时
        var parts = beijingParts(date)
        var weekend = parts.day === 0 || parts.day === 6
        if (weekend && !isMakeupWorkday(date)) return false // 普通周末全天谷时
        for (var i = 0; i < PEAK_WINDOWS.length; i += 1) {
          var start = PEAK_WINDOWS[i][0] * 60
          var end = PEAK_WINDOWS[i][1] * 60
          if (parts.minutes >= start && parts.minutes < end) return true
        }
        return false
      }

      /**
       * 「最近的谷时」目标时刻。
       *
       * 规则（按用户要求，并补上节假/调休）：
       * - 当前已在谷时 → 返回 now + 2 分钟（向上取整到整分，和默认值一致）。
       * - 当前在高峰 → 返回**本次高峰结束的那一刻**（也就是最近谷时段的起点）。
       *   高峰段是 [9,12) 与 [14,18)，所以要么 12:00，要么 18:00。
       *
       * 实现方式：从 now 起逐分钟向前探，第一个「非高峰」的整分就是答案。
       * 逐分钟遍历最多跨一个晚上（周末/节假日可能是整天谷时，此时 immediate 分支
       * 已经命中，走不到这里），所以不存在长循环。
       *
       * @param {Date} now - 参考时刻。
       * @returns {Date} 可填入 datetime-local 的目标时刻（已对齐到整分）。
       */
      function nearestOffPeak(now) {
        if (!isPeakTime(now)) {
          // 已在谷时：+2 分钟（精确到秒，不再取整）。
          return new Date(now.getTime() + DEFAULT_LEAD_MINUTES * 60_000)
        }
        // 高峰中：找最近的状态翻转点（高峰 → 谷时），即本段高峰的结束时刻。
        var cursor = Math.ceil(now.getTime() / 60_000) * 60_000
        var limit = cursor + 26 * 3600_000 // 最长一次高峰 4 小时，留足余量
        while (cursor < limit) {
          cursor += 60_000
          if (!isPeakTime(new Date(cursor))) return new Date(cursor)
        }
        // 理论不可达：兜底给 +2 分钟，绝不返回过期时间。
        return new Date(now.getTime() + DEFAULT_LEAD_MINUTES * 60_000)
      }

      /** 把毫秒差写成「X 小时 Y 分」。 */
      function formatDuration(ms) {
        var total = Math.max(0, Math.floor(ms / 60000))
        var hours = Math.floor(total / 60)
        var minutes = total % 60
        if (hours === 0) return minutes + ' 分钟'
        if (minutes === 0) return hours + ' 小时'
        return hours + ' 小时 ' + minutes + ' 分'
      }

      /**
       * 从 from 起，下一次偏离当前计费状态还剩多久。
       *
       * @returns {{peak: boolean, remainMs: number}} peak 表示 from 此刻是否高峰；
       *   remainMs 是距离状态切换的毫秒数（已封顶 7 天，避免极端情况下的长循环）。
       */
      function billingStateAt(from) {
        var peak = isPeakTime(from)
        // 逐分钟向前找状态翻转点。±1 天内的翻转最多几次，60 次/小时的粒度足够。
        var cursor = from.getTime()
        var limit = cursor + 7 * 24 * 3600 * 1000
        while (cursor < limit) {
          cursor += 60 * 1000
          if (isPeakTime(new Date(cursor)) !== peak) break
        }
        return { peak: peak, remainMs: Math.max(0, cursor - from.getTime()) }
      }

      /** 剩余时间的自然语言。 */
      function describeRemaining(iso, now) {
        var at = new Date(iso).getTime()
        if (isNaN(at)) return ''
        var diff = at - now
        if (diff <= 0) return '即将发送'
        var minutes = Math.floor(diff / 60000)
        if (minutes < 1) return '不到 1 分钟'
        if (minutes < 60) return minutes + ' 分钟后'
        var hours = Math.floor(minutes / 60)
        var rest = minutes % 60
        if (hours < 24) return rest === 0 ? hours + ' 小时后' : hours + ' 小时 ' + rest + ' 分钟后'
        return Math.floor(hours / 24) + ' 天后'
      }

      // ── Host 通信 ─────────────────────────────────────────────────────────

      /** 调 Host 路由；永不抛。 */
      function call(action, payload) {
        var body = Object.assign({ action: action }, payload || {})
        return fetch(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
          .then(function (response) { return response.json() })
          .catch(function (error) {
            return {
              ok: false,
              error: '无法连接 Host：' + (error && error.message ? error.message : String(error)),
            }
          })
      }

      // ── 样式 ──────────────────────────────────────────────────────────────

      var CSS = [
        // 宽度减半并右对齐：状态条只占卡片宽度的一半，贴着右边缘（对齐发送按钮一侧）。
        '.sched-wrap{box-sizing:border-box;width:50%;max-width:calc(var(--dsh-composer-card-max-width) / 2);',
        'min-width:340px;margin-left:auto;margin-right:auto;display:flex;flex-direction:column;align-items:stretch;',
        'gap:6px;position:relative}',
        '.sched-bar{display:flex;align-items:center;justify-content:flex-end;gap:6px}',
        '.sched-btn{box-sizing:border-box;display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 10px;',
        'border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);background:0 0;',
        'color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:18px;line-height:24px}',
        '.sched-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
        '.sched-btn:disabled{opacity:.45;cursor:default}',
        '.sched-btn[data-active=true]{color:var(--dsw-alias-state-business-primary);border-color:currentColor}',
        '.sched-badge{min-width:16px;height:16px;padding:0 4px;border-radius:999px;box-sizing:border-box;',
        'background:var(--dsw-alias-state-business-primary);color:#fff;font-size:16px;line-height:22px;text-align:center}',
        '.sched-panel{position:absolute;right:0;bottom:calc(100% + 6px);width:360px;z-index:60;box-sizing:border-box;',
        // 用 bg-base 而不是 specific-menu：后者实测是 rgba(...,0.58)，叠在对话正文上会透出文字。
        'border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-base);box-shadow:var(--dsw-elevation-panel);',
        'border:.5px solid var(--dsw-alias-border-l1);padding:12px;display:flex;flex-direction:column;gap:10px;',
        'font-size:19px;line-height:26px;color:var(--dsw-alias-label-primary);text-align:left}',
        '.sched-panel h4{margin:0;font-size:19px;font-weight:600;line-height:26px}',
        '.sched-sub{color:var(--dsw-alias-label-tertiary);font-size:18px;line-height:24px}',
        '.sched-preview{box-sizing:border-box;width:100%;border-radius:var(--dsw-radius-md);',
        'border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);',
        'padding:6px 8px;display:flex;flex-direction:column;gap:2px}',
        '.sched-preview-text{color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;',
        'max-height:96px;overflow-y:auto;font-size:18px;line-height:24px}',
        '.sched-peak{box-sizing:border-box;width:100%;border-radius:var(--dsw-radius-md);',
        'background:var(--dsw-alias-bg-module-platform);padding:7px 9px;display:flex;flex-direction:column;gap:4px}',
        '.sched-peak-row{display:flex;align-items:center;gap:6px;font-size:18px;line-height:24px;',
        'color:var(--dsw-alias-label-secondary)}',
        '.sched-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary)}',
        '.sched-dot[data-peak=true]{background:#e5883b}',
        '.sched-dot[data-peak=false]{background:#2f9e6e}',
        '.sched-peak-state{font-weight:500;flex:none}',
        '.sched-peak-state[data-peak=true]{color:#c46a1f}',
        '.sched-peak-state[data-peak=false]{color:#24805a}',
        '.sched-peak-meta{margin-left:auto;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
        '.sched-peak-rule{color:var(--dsw-alias-label-caption);font-size:17px;line-height:22px;margin-top:1px}',
        '.sched-golden{box-sizing:border-box;width:100%;display:inline-flex;align-items:center;justify-content:center;gap:5px;',
        'height:40px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l2);',
        'background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:18px}',
        '.sched-golden:hover{background:var(--dsw-alias-interactive-bg-hover)}',
        '.sched-datetime{width:100%;box-sizing:border-box;border-radius:var(--dsw-radius-md);',
        'border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);',
        'color:var(--dsw-alias-label-primary);padding:5px 8px;font:inherit}',
        '.sched-row{display:flex;gap:8px;justify-content:flex-end;align-items:center}',
        '.sched-primary{border-radius:var(--dsw-radius-md);background:var(--dsw-alias-button-info-fill);color:#fff;',
        'border:none;cursor:pointer;padding:6px 14px;font-size:19px;line-height:26px}',
        '.sched-primary:disabled{opacity:.45;cursor:default}',
        '.sched-plain{border-radius:var(--dsw-radius-md);background:0 0;color:var(--dsw-alias-label-secondary);',
        'border:.5px solid var(--dsw-alias-border-l2);cursor:pointer;padding:6px 12px;font-size:19px;line-height:26px}',
        '.sched-plain:hover{background:var(--dsw-alias-interactive-bg-hover)}',
        '.sched-error{color:var(--dsw-alias-state-danger-primary,#e5484d);font-size:18px;line-height:24px}',
        '.sched-notice{color:var(--dsw-alias-state-business-primary);font-size:18px;line-height:24px}',
        '.sched-list{box-sizing:border-box;width:100%;border-radius:var(--dsw-radius-md);',
        'background:var(--dsw-alias-bg-module-platform);padding:6px 10px;display:flex;flex-direction:column;gap:6px}',
        '.sched-item{display:flex;align-items:center;gap:8px;font-size:18px;line-height:24px;',
        'color:var(--dsw-alias-label-secondary)}',
        '.sched-item-text{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.sched-item-meta{color:var(--dsw-alias-label-tertiary)}',
        '.sched-item-editing{background:var(--dsw-alias-interactive-bg-hover);border-radius:var(--dsw-radius-sm)}',
        '.sched-actions{display:inline-flex;align-items:center;gap:2px;flex:none}',
        '.sched-mini{border:none;background:0 0;color:var(--dsw-alias-state-business-primary);cursor:pointer;',
        'padding:0 2px;font-size:18px;line-height:24px;flex:none}',
        '.sched-mini.muted{color:var(--dsw-alias-label-tertiary)}',
      ].join('')

      function installStyle(doc) {
        try {
          var existing = doc.querySelector('style[' + STYLE_ATTR + ']')
          if (existing !== null) return { node: existing, owned: false }
          var style = doc.createElement('style')
          style.setAttribute(STYLE_ATTR, '')
          style.textContent = CSS
          ;(doc.head || doc.documentElement).appendChild(style)
          return { node: style, owned: style.parentElement !== null }
        } catch (error) {
          return { node: null, owned: false }
        }
      }

      // ── 图标 ──────────────────────────────────────────────────────────────

      function ClockIcon(props) {
        var size = props && props.size ? props.size : 14
        return h(
          'svg',
          { viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': true, style: { flex: 'none' } },
          h('circle', { cx: 8, cy: 8, r: 6.1, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 }),
          h('path', {
            d: 'M8 4.7V8.2L10.5 9.7',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.3,
            strokeLinecap: 'round',
          }),
        )
      }

      // ── 时间选择面板 ──────────────────────────────────────────────────────

      /**
       * 谷时段提示条：显示「现在」的计费状态，以及「你选的发送时间」落在哪一档。
       *
       * 两段信息分开写，是因为它们回答两个不同的问题：
       * 当前状态告诉你「现在发贵不贵」，目标时间告诉你「等会儿发贵不贵」。
       */
      function PeakHint(props) {
        var at = props.at
        var [tick, setTick] = useState(0)

        // 每分钟刷新一次「还剩多久」，让倒计时自己走。
        useEffect(function () {
          var timer = setInterval(function () { setTick(function (value) { return value + 1 }) }, 30000)
          return function () { clearInterval(timer) }
        }, [])

        var now = new Date()
        var current = billingStateAt(now)
        var target = at instanceof Date && !isNaN(at.getTime()) ? { peak: isPeakTime(at), at: at } : null
        void tick

        var rows = [
          h(
            'div',
            { key: 'now', className: 'sched-peak-row' },
            h('span', { className: 'sched-dot', 'data-peak': current.peak ? 'true' : 'false' }),
            h('span', null, t('peak.title')),
            h('span', { className: 'sched-peak-state', 'data-peak': current.peak ? 'true' : 'false' },
              current.peak ? t('peak.peak') : t('peak.offPeak')),
            // 两种状态的倒计时文案已统一为「还剩 X」，直接复用一条键。
            h('span', { className: 'sched-peak-meta' }, t('peak.left', { d: formatDuration(current.remainMs) })),
          ),
        ]

        if (target !== null) {
          rows.push(
            h(
              'div',
              { key: 'target', className: 'sched-peak-row' },
              h('span', { className: 'sched-dot', 'data-peak': target.peak ? 'true' : 'false' }),
              h('span', null, '所选时间'),
              h('span', { className: 'sched-peak-state', 'data-peak': target.peak ? 'true' : 'false' },
                target.peak ? t('peak.peak') : t('peak.offPeak')),
              h('span', { className: 'sched-peak-meta' },
                pad2(target.at.getHours()) + ':' + pad2(target.at.getMinutes()) + ':' + pad2(target.at.getSeconds())),
            ),
          )
        }

        return h(
          'div',
          { className: 'sched-peak', 'data-scheduled-send-peak': '' },
          rows,
          h('div', { className: 'sched-peak-rule' }, t('peak.rule')),
        )
      }

      function TimePanel(props) {
        // 打开面板时的初始时间：优先用「本会话上次手动设置过的时间」，
        // 没有才用默认的「现在 + 2 分钟」。
        var [when, setWhen] = useState(function () {
          var remembered = readRememberedTime(props.sessionId)
          return remembered !== undefined ? remembered : toLocalInputValue(defaultWhen())
        })
        var [busy, setBusy] = useState(false)
        var [error, setError] = useState('')
        var [notice, setNotice] = useState('')
        // 默认值只有 +2 分钟：面板开久了会过期。手动改过就不再替他做主。
        // 有记忆值时也算「用户已经表过态」，同样不替他顺延。
        var touchedRef = useRef(readRememberedTime(props.sessionId) !== undefined)
        var panelRef = useRef(null)

        // 内容不再自己收：实时读原始输入框（外部输入框就是唯一事实来源）。
        var draft = props.getDraft()
        var hasDraft = typeof draft === 'string' && draft.trim() !== ''

        // 面板外点击 / Esc 关闭。capture 阶段监听，避免与卡片自身的 mousedown 抢焦点逻辑打架。
        useEffect(function () {
          function onDown(event) {
            var node = panelRef.current
            if (node === null || node.contains(event.target)) return
            var anchor = props.anchorRef && props.anchorRef.current
            if (anchor && anchor.contains(event.target)) return
            props.onCancel()
          }
          function onKey(event) {
            if (event.key === 'Escape') {
              event.stopPropagation()
              props.onCancel()
            }
          }
          document.addEventListener('mousedown', onDown, true)
          document.addEventListener('keydown', onKey, true)
          return function () {
            document.removeEventListener('mousedown', onDown, true)
            document.removeEventListener('keydown', onKey, true)
          }
        }, [props])

        var parsedAt = function () {
          var at = new Date(when).getTime()
          return isFinite(at) ? new Date(at) : null
        }
        var chosenAt = parsedAt()

        var submit = useCallback(function () {
          if (busy) return
          // 提交时再读一次：用户可能在面板开着的时候继续改输入框。
          var body = String(props.getDraft() || '').trim()
          if (body === '') {
            setError(t('panel.emptyDraft'))
            return
          }
          var at = new Date(when).getTime()
          if (!isFinite(at)) {
            setError(t('panel.invalidTime'))
            return
          }
          if (at <= Date.now()) {
            // 用户自己挑的时间过期了：如实报错，让他重选。
            if (touchedRef.current) {
              setError(t('panel.invalidTime'))
              return
            }
            // 只是默认的 +2 分钟等过期了：顺延到新的 +2 分钟，并明确告诉他。
            var bumped = defaultWhen()
            var bumpedText = toLocalInputValue(bumped)
            setWhen(bumpedText)
            rememberTime(props.sessionId, bumpedText)
            setNotice(t('panel.bumped', { time: pad2(bumped.getHours()) + ':' + pad2(bumped.getMinutes()) + ':' + pad2(bumped.getSeconds()) }))
            setError('')
            return
          }
          setError('')
          setNotice('')
          setBusy(true)
          Promise.resolve(props.onConfirm({ text: body, at: new Date(at).toISOString() }))
            .then(function (result) {
              if (result && result.ok === false) {
                setError(result.error || '创建失败')
                setBusy(false)
              }
            })
            .catch(function (failure) {
              setError(failure && failure.message ? failure.message : String(failure))
              setBusy(false)
            })
        }, [busy, when, props])

        // 不再放正文预览框：内容就在下方输入框里，重复显示反而占地。
        // 只在输入框为空时给一句提示，避免用户点了确认才知道没内容。
        var preview = hasDraft ? null : h('div', { className: 'sched-error' }, t('panel.emptyDraft'))

        return h(
          'div',
          { className: 'sched-panel', ref: panelRef, 'data-scheduled-send-panel': '' },
          h('h4', null, t('panel.title')),
          h('div', { className: 'sched-sub' }, t('panel.subtitle')),
          preview,
          // 「最近的谷时」：一键把时间设到最近的谷时段起点（逻辑见 nearestOffPeak）。
          h(
            'button',
            {
              type: 'button',
              className: 'sched-golden',
              onClick: function () {
                var nowRef = new Date()
                var wasPeak = isPeakTime(nowRef)
                var picked = nearestOffPeak(nowRef)
                touchedRef.current = true
                var pickedText = toLocalInputValue(picked)
                setWhen(pickedText)
                rememberTime(props.sessionId, pickedText)
                setError('')
                setNotice(t(wasPeak ? 'panel.goldenSet' : 'panel.goldenNow', {
                  time: pad2(picked.getHours()) + ':' + pad2(picked.getMinutes()) + ':' + pad2(picked.getSeconds()),
                }))
              },
            },
            h(ClockIcon, { size: 12 }),
            t('panel.golden'),
          ),
          h('input', {
            className: 'sched-datetime',
            type: 'datetime-local',
            step: '1', // 允许秒级输入；默认 step=60 会强制分钟粒度
            value: when,
            min: toLocalInputValue(new Date()),
            onChange: function (event) {
              touchedRef.current = true
              setWhen(event.target.value)
              // 手动改过就记住，关闭面板后下次打开仍是这个时间。
              rememberTime(props.sessionId, event.target.value)
              setError('')
              setNotice('')
            },
          }),
          h(PeakHint, { at: chosenAt }),
          error !== '' ? h('div', { className: 'sched-error' }, error) : null,
          notice !== '' ? h('div', { className: 'sched-notice' }, notice) : null,
          h(
            'div',
            { className: 'sched-row' },
            h(
              'button',
              { type: 'button', className: 'sched-plain', onClick: props.onCancel, disabled: busy },
              t('panel.cancel'),
            ),
            h(
              'button',
              { type: 'button', className: 'sched-primary', onClick: submit, disabled: busy || !hasDraft },
              busy ? t('panel.busy') : t('panel.confirm'),
            ),
          ),
        )
      }

      // ── 待发列表 ──────────────────────────────────────────────────────────

      /**
       * 待发任务列表。
       *
       * 每条右侧三个动作：编辑 / 立即发送 / 取消（失败项为 重试）。
       *
       * 「编辑」的语义：把这条任务的正文塞回**原始输入框**，让它变成可直接改的
       * 普通草稿；按钮就地变成「保存」，再点一下把改后的文字写回任务，
       * **时间保持不变**（用户只要求改正文，不该悄悄动他的定时）。
       */
      function TaskList(props) {
        var tasks = props.tasks
        var now = props.now
        var onAct = props.onAct
        var editingId = props.editingId
        var editingDirty = props.editingDirty
        var onEdit = props.onEdit
        var onSave = props.onSave
        if (tasks.length === 0) return null

        return h(
          'div',
          { className: 'sched-list', 'data-scheduled-send-list': '' },
          tasks.map(function (task) {
            var status = task.status
            var editing = editingId === task.id
            var head = task.text.length > 46 ? task.text.slice(0, 46) + '…' : task.text
            var meta
            if (status === 'failed') meta = t('dock.failed', { error: task.error || '未知错误' })
            else if (status === 'sending') meta = t('dock.sending')
            else meta = t('dock.sendAt', { time: formatLocal(task.at) }) + ' · ' + describeRemaining(task.at, now)

            return h(
              'div',
              { key: task.id, className: 'sched-item' + (editing ? ' sched-item-editing' : '') },
              h(
                'div',
                { className: 'sched-item-text', title: task.text },
                h('span', null, editing ? t('dock.editing') : head),
                h('span', { className: 'sched-item-meta' }, '　' + meta),
              ),
              // 编辑态只留「保存 / 放弃」两个动作：此时正文在输入框里，
              // 再给「立即发送」之类容易让人误操作。
              editing
                ? h(
                    'span',
                    { className: 'sched-actions' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'sched-mini',
                        disabled: !editingDirty,
                        onClick: function () { onSave(task.id) },
                      },
                      t('dock.save'),
                    ),
                    h(
                      'button',
                      { type: 'button', className: 'sched-mini muted', onClick: function () { onEdit(null) } },
                      t('dock.discard'),
                    ),
                  )
                : h(
                    'span',
                    { className: 'sched-actions' },
                    // 失败项也要能编辑和取消：失败不代表内容不能改，也不代表必须留着。
                    status === 'failed'
                      ? h(
                          'span',
                          { className: 'sched-actions' },
                          h('button', { type: 'button', className: 'sched-mini muted', onClick: function () { onEdit(task.id) } }, t('dock.edit')),
                          h('button', { type: 'button', className: 'sched-mini', onClick: function () { onAct('retry', task.id) } }, t('dock.retry')),
                          h('button', { type: 'button', className: 'sched-mini muted', onClick: function () { onAct('cancel', task.id) } }, t('dock.cancel')),
                        )
                      : h(
                          'span',
                          { className: 'sched-actions' },
                          h('button', { type: 'button', className: 'sched-mini muted', onClick: function () { onEdit(task.id) } }, t('dock.edit')),
                          h('button', { type: 'button', className: 'sched-mini', onClick: function () { onAct('sendNow', task.id) } }, t('dock.sendNow')),
                          h('button', { type: 'button', className: 'sched-mini muted', onClick: function () { onAct('cancel', task.id) } }, t('dock.cancel')),
                        ),
                  ),
            )
          }),
        )
      }

      // ── 主入口组件（挂在输入框上方、框外的 dock 区） ──────────────────────

      /**
       * @param {object} props - dock slot 注入的 owner props（session / input）与标准 props。
       */
      function ScheduleDockEntry(props) {
        var sessionId = props.sessionId

        var [open, setOpen] = useState(false)
        var [tasks, setTasks] = useState([])
        var [now, setNow] = useState(Date.now())
        var [refreshToken, setRefreshToken] = useState(0)
        var anchorRef = useRef(null)

        // 原始输入框就是唯一的内容来源：面板不自建文本框，只读这里。
        // dock 每次 input 变化都会重渲染，所以把最新值同步进 ref，
        // getDraft 用稳定身份读 ref —— 面板开着时用户继续改输入框也能拿到最新内容。
        var draftRef = useRef('')
        try {
          draftRef.current = typeof props.input?.draft === 'string' ? props.input.draft : readDraftFromDom()
        } catch (error) {
          draftRef.current = ''
        }
        var getDraft = useCallback(function () {
          return String(draftRef.current || '')
        }, [])

        // 拉取本会话任务；30s 轮询刷新倒计时与状态。
        useEffect(function () {
          if (typeof sessionId !== 'string' || sessionId === '') return undefined
          var alive = true
          var load = function () {
            call('list', { sessionId: sessionId }).then(function (result) {
              if (!alive || !result || !result.ok || !result.value) return
              setTasks(result.value.tasks || [])
            })
          }
          load()
          var poll = setInterval(function () {
            setNow(Date.now())
            load()
          }, 30000)
          return function () {
            alive = false
            clearInterval(poll)
          }
        }, [sessionId, refreshToken])

        var visible = tasks.filter(function (task) {
          return task.status === 'active' || task.status === 'sending' || task.status === 'failed'
        })
        var pending = visible.filter(function (task) { return task.status !== 'failed' }).length
        var failed = visible.length - pending

        var close = useCallback(function () { setOpen(false) }, [])

        /**
         * 核心流程。
         *
         * 分两种目标，**都不在确认时新建会话**：
         * - 已在某个对话里 → 绑到当前对话（sessionId）。
         * - 不在对话里 → 只记下建在哪个 workspace/cwd，等真正到点再由 Host 建。
         *
         * 为什么不预先建：DSH 的「新建会话」按钮会复用任何 `blank: true` 会话，
         * 而 blank 要等 turn/start 才变 false。预建的空会话会被当成可复用空壳，
         * 用户点「新会话」时被它顶掉，表现为「新会话建不出来」。
         */
        /**
         * 判断当前是否处于「创建新会话界面」。
         *
         * 关键点：DSH 在首屏空态下**已经持有一个 blank 会话**（hero 页），它的
         * sessionId 是真实存在的。如果只看 sessionId 有没有值，就会把这个空壳
         * 当成「已有会话」，于是所有定时任务都绑到同一个窗口 —— 正是用户报的现象。
         *
         * 所以必须同时看 summary.blank：
         * - 没有 sessionId，或 summary.blank === true → 视为「新会话界面」，
         *   每条任务各自新建一个会话。
         * - sessionId 存在且 blank === false → 视为「已有对话」，排进当前对话。
         */
        function inExistingConversation() {
          var id = props.sessionId
          if (typeof id !== 'string' || id === '') return false

          try {
            var snapshot = props.sessionsList()
            var row = snapshot && snapshot.byId ? snapshot.byId[id] : undefined
            // 拿不到行信息时保守认为「不是已有对话」，宁可多建也不要把多条挤进同一个。
            if (row === undefined) return false
            if (row.blank === true) return false
            return true
          } catch (error) {
            return false
          }
        }

        /**
         * 核心流程。
         *
         * - 在**已有对话**里 → 绑到当前会话（sessionId），多条都进同一个对话。
         * - 在**新会话界面**（首屏空态 / blank）→ 每条任务各建一个独立会话，
         *   由 Host 预创建并立刻脱离 blank（见 index.mjs 的 precreate）。
         */
        var createScheduled = useCallback(function (payload) {
          var target
          if (inExistingConversation()) {
            target = { sessionId: props.sessionId }
          } else {
            var workspaceId = currentWorkspaceId(props)
            if (workspaceId !== undefined) target = { workspaceId: workspaceId }
            else {
              var cwd = currentCwd(props)
              target = cwd === undefined ? {} : { cwd: cwd }
            }
          }

          return Promise.resolve(props.createTask(Object.assign({}, target, {
            text: payload.text,
            at: payload.at,
          }))).then(function (result) {
            if (!result || result.ok === false) {
              return { ok: false, error: (result && result.error) || '创建定时任务失败' }
            }
            // 内容已登记进定时任务，清掉输入框草稿，避免误发第二遍。
            try {
              if (props.inputActions && typeof props.inputActions.setDraft === 'function') props.inputActions.setDraft('')
            } catch (error) { /* 清空失败无害 */ }
            setOpen(false)
            setRefreshToken(function (value) { return value + 1 })
            // 任务已成功登记：清掉本会话记住的时间，下次打开回到默认 +2 分钟。
            rememberTime(props.sessionId, null)
            // 新建了会话就跳过去，让用户能立刻看到那个新会话。
            if (target.sessionId === undefined && result.value && result.value.sessionId) {
              try {
                if (props.openSession) props.openSession(result.value.sessionId)
              } catch (error) {
                console.warn('[scheduled-send] 打开新会话失败：', error)
              }
            }
            return { ok: true, sessionId: result.value && result.value.sessionId }
          }).catch(function (error) {
            return { ok: false, error: error && error.message ? error.message : String(error) }
          })
        }, [props])

        var onAct = useCallback(function (action, id) {
          call(action, { id: id }).then(function (result) {
            if (result && result.ok) setRefreshToken(function (value) { return value + 1 })
            else if (result && result.error) console.warn('[scheduled-send]', action, result.error)
          })
        }, [])

        // ── 编辑中的任务 ────────────────────────────────────────────────
        // 编辑态只存在浏览器里：正文临时搬进原始输入框，任务本体在 Host 侧不动。
        // 保存才写回 Host，且**只改正文、不动时间**。
        var [editingId, setEditingId] = useState(null)
        var [editingDirty, setEditingDirty] = useState(false)

        var onEdit = useCallback(function (id) {
          if (id === null) {
            // 放弃编辑：把输入框恢复成空，避免留下一条来路不明的草稿
            try {
              if (props.inputActions && typeof props.inputActions.setDraft === 'function') props.inputActions.setDraft('')
            } catch (error) { /* 忽略 */ }
            setEditingId(null)
            setEditingDirty(false)
            return
          }
          var task = visible.filter(function (item) { return item.id === id })[0]
          if (task === undefined) return
          try {
            if (props.inputActions && typeof props.inputActions.setDraft === 'function') {
              props.inputActions.setDraft(task.text)
              // 把键盘交还输入框，用户可以直接开始改
              var node = document.querySelector('[data-input-scroll] [data-composer-input="true"]')
              if (node !== null && typeof node.focus === 'function') node.focus()
            }
          } catch (error) {
            console.warn('[scheduled-send] 载入待编辑内容失败：', error)
            return
          }
          setEditingId(id)
          setEditingDirty(false)
        }, [props, visible])

        // 输入框内容一变就标脏，作为「保存」按钮的可用条件。
        useEffect(function () {
          // 已退出编辑：不再跟踪脏状态（否则清空输入框会被判成「有改动」）。
          if (editingId === null) return
          var current = typeof props.input?.draft === 'string' ? props.input.draft : ''
          var original = visible.filter(function (item) { return item.id === editingId })[0]
          setEditingDirty(original !== undefined && current !== original.text)
        }, [editingId, props.input, visible])

        var onSave = useCallback(function (id) {
          var current = typeof props.input?.draft === 'string' ? props.input.draft : ''
          var body = current.trim()
          if (body === '') return
          call('updateText', { id: id, text: body }).then(function (result) {
            if (!result || result.ok === false) {
              console.warn('[scheduled-send] 保存失败：', result && result.error)
              return
            }
            // 顺序很重要：先退出编辑态，再清空输入框。
            // 若先清空仍有 editingId，下面的同步 effect 会把「任务正文」当作
            // 当前草稿再灌回去，看起来就是「保存了但输入框没清掉」。
            setEditingId(null)
            setEditingDirty(false)
            try {
              if (props.inputActions && typeof props.inputActions.setDraft === 'function') props.inputActions.setDraft('')
            } catch (error) { /* 忽略 */ }
            setRefreshToken(function (value) { return value + 1 })
          })
        }, [props])

        var badge = pending > 0 ? h('span', { className: 'sched-badge' }, String(pending)) : null
        var tooltip = failed > 0 ? t('dock.failedCount', { n: failed }) : t('button.tip')

        var button = h(
          'button',
          {
            type: 'button',
            className: 'sched-btn',
            'aria-label': t('button.label'),
            'aria-haspopup': 'dialog',
            'aria-expanded': open ? 'true' : 'false',
            'data-active': open ? 'true' : 'false',
            onMouseDown: function (event) { event.preventDefault() },
            onClick: function () { setOpen(function (value) { return !value }) },
          },
          h(ClockIcon, { size: 13 }),
          h('span', null, t('button.label')),
          badge,
        )

        var withTooltip = typeof primitives.Tooltip === 'function'
          ? h(primitives.Tooltip, { label: tooltip, side: 'top', delayMs: 500 }, button)
          : button

        var label = pending === 1 ? t('dock.pendingOne') : pending > 0 ? t('dock.pendingMany', { n: pending }) : ''
        if (failed > 0) label = (label === '' ? '' : label + ' · ') + t('dock.failedCount', { n: failed })

        return h(
          'div',
          { className: 'sched-wrap', ref: anchorRef, 'data-scheduled-send': '' },
          h(
            'div',
            { className: 'sched-bar' },
            label !== '' ? h('span', { className: 'sched-sub' }, label) : null,
            withTooltip,
          ),
          h(TaskList, {
            tasks: visible,
            now: now,
            onAct: onAct,
            editingId: editingId,
            editingDirty: editingDirty,
            onEdit: onEdit,
            onSave: onSave,
          }),
          open
            ? h(TimePanel, {
                sessionId: sessionId,
                getDraft: getDraft,
                anchorRef: anchorRef,
                onCancel: close,
                onConfirm: createScheduled,
              })
            : null,
        )
      }

      /** 从输入框 DOM 读当前草稿（仅供 props.input 缺失时兜底）。 */
      function readDraftFromDom() {
        try {
          var node = document.querySelector('[data-input-scroll] [data-composer-input="true"]')
          if (node !== null) {
            var text = node.innerText
            return typeof text === 'string' ? text : ''
          }
          var textarea = document.querySelector('[data-input-scroll] textarea')
          if (textarea !== null) return String(textarea.value || '')
        } catch (error) {
          /* 读不到就空 */
        }
        return ''
      }

      /** 当前会话的 cwd（新会话沿用同一工作目录；没有就交给 Host 默认值）。 */
      function currentCwd(props) {
        try {
          var id = props.sessionId
          if (typeof id !== 'string') return undefined
          var snapshot = props.sessionsList()
          var row = snapshot && snapshot.byId ? snapshot.byId[id] : undefined
          if (row && typeof row.cwd === 'string' && row.cwd !== '') return row.cwd
        } catch (error) {
          /* 忽略 */
        }
        return undefined
      }

      /**
       * 当前会话所属的工作区 id。
       *
       * 关键：新会话必须建在某个工作区里，否则打开它会停在「选择一个工作区开始」
       * 的英雄页、输入框不可用——这会让「连开多个定时会话」变成一串打不开的空页面。
       * 用 workspaceId 建会话时 Host 会顺手 attachSession，页面就正常了。
       */
      function currentWorkspaceId(props) {
        try {
          var id = props.sessionId
          if (typeof id !== 'string') return undefined
          var snapshot = props.workspacesList()
          var items = snapshot && Array.isArray(snapshot.items) ? snapshot.items : []
          for (var i = 0; i < items.length; i += 1) {
            var workspace = items[i]
            if (workspace && Array.isArray(workspace.sessionIds) && workspace.sessionIds.indexOf(id) >= 0) {
              return workspace.workspaceId
            }
          }
        } catch (error) {
          /* 忽略 */
        }
        return undefined
      }

      // ── apply ─────────────────────────────────────────────────────────────

      /** 顶层只列必需服务；会话创建由 Host 在投递时负责。 */
      var CLIENT_INJECT = ['slots', 'sessions', 'workspaces']

      function apply(ctx) {
        var disposers = []

        var style = installStyle(document)
        if (style.owned && style.node) disposers.push(function () { style.node.remove() })

        // uiWorkspace：可选。缺了只是「建完新会话不自动跳过去」，插件本体照常工作。
        var uiWorkspace = null
        try {
          disposers.push(
            ctx.inject(['uiWorkspace'], function (child) {
              try {
                if (child.uiWorkspace) uiWorkspace = child.uiWorkspace
              } catch (error) {
                console.warn('[scheduled-send] uiWorkspace 绑定失败：', error)
              }
            }),
          )
        } catch (error) {
          console.warn('[scheduled-send] uiWorkspace 注入失败：', error)
        }

        // 装在 dock 区：输入框卡片上方、框外，正好在发送按钮上侧。
        try {
          disposers.push(
            ctx.slots.inject('conversation.input.dock', function () {
              return ctx.slots.register(
                {
                  name: 'conversation.input.dock',
                  id: 'scheduled-send',
                  order: 30,
                  label: function () { return t('button.label') },
                },
                function SlotEntry(props) {
                  return h(ScheduleDockEntry, Object.assign({}, props, {
                    // 只登记任务，会话留到投递时再建（见 createScheduled 的注释）。
                    createTask: function (payload) {
                      return call('create', payload)
                    },
                    openSession: function (sessionId) {
                      if (uiWorkspace && typeof uiWorkspace.openSession === 'function') {
                        uiWorkspace.openSession(sessionId)
                      }
                    },
                    sessionsList: function () { return ctx.sessions.list.getSnapshot() },
                    workspacesList: function () {
                      var workspaces = ctx.get('workspaces')
                      return workspaces && workspaces.list ? workspaces.list.getSnapshot() : undefined
                    },
                  }))
                },
              )
            }),
          )
        } catch (error) {
          console.warn('[scheduled-send] conversation.input.dock 注册失败：', error)
        }

        return function cleanup() {
          disposers.forEach(function (dispose) {
            try { dispose() } catch (error) { /* 忽略 */ }
          })
        }
      }

      return { apply: apply, inject: CLIENT_INJECT }
    },
  })
})()
