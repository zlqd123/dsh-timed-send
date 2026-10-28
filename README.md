# dsh-timed-send · DSH 定时发送

给 DSH Web 聊天框加一个**定时发送**按钮：点一下选定时间，到点由 Host 把消息真正发出去。

- 位置：输入框卡片**上方、框外**、右对齐，正对原生发送按钮的上侧。
- **默认在对话内发送**：你在哪个对话里点，消息就回到那个对话。只有不在任何对话里时（如首屏空态）才新建会话。
- 点确认后**不发送**，只是登记成待发任务；到点才真正发出，所以可以同时挂多条。
- 浏览器关掉也不影响：定时器在 Host 进程里，任务落盘到 `~/.dsh/data/scheduled-send/tasks.json`；DSH 重启后会补发停机期间到期的任务。

## 界面

| 位置 | 内容 |
| --- | --- |
| 输入框上方（框外）右侧 | 「⏱ 定时发送」按钮，带待发数量角标 |
| 点开面板 | **只选时间**：默认「当前时间 + 2 分钟」，可改；上方有「最近的谷时」一键按钮；下方是谷时段提示。正文不在这里写 |
| 同一行下方 | 本会话待发列表（**半宽、右对齐**）：`将于 13:28 发送 · 4 分钟后`，带「编辑 / 立即发送 / 取消」；失败项带「编辑 / 重试 / 取消」 |

面板是**不透明**的实色底（`--dsw-alias-bg-base`），不会透出下面的对话正文。
默认时间会**向上取整到整分**，保证实际间隔不短于 2 分钟；如果面板开着放置超过 2 分钟导致默认时刻已过，
点确认时会自动顺延到新的 +2 分钟并提示你「已顺延，请再确认一次」（手动改过的时间过期则直接报错，不替你改）。

面板里**不再有正文预览框**：内容就在下方原始输入框里，重复显示只是占地方。
输入框为空时确认按钮直接禁用，改内容直接回输入框改（面板开着也能改）。

确认后的实际行为：

1. 读取**原始输入框**的当前内容作为定时消息。
2. 绑定目标（按你所在的位置自动区分）：
   - **已有对话里** → 每条都绑到**当前对话**，不新建、不跳转。
   - **创建新会话界面**（首屏空态，或进入的会话本身是定时发送自动建的）→ **每条各建一个独立新会话**，并跳过去。
     判断依据是 Host 侧的 `autoCreated` 标记 + 会话的 `blank` 状态，不靠 sessionId 有无（首屏空态本身就持有一个 blank 会话）。
     预创建后会立即用一条极短占位消息触发一次 turn 并马上取消，使会话脱离 `blank`——
     否则它会被 DSH 的「新会话」按钮当成可复用空壳收走（见下方「为什么要预创建还要占位」）。
3. 把内容登记为定时任务。
4. 清空原输入框草稿（防止误发第二遍）。

> 之前版本是「点一次就新建一个会话」。现在改成默认在当前对话内发送，因为这才是常见意图；
> 需要连开多个独立定时会话时，先「新会话」再各自排一条即可。

### 为什么要预创建还要占位

DSH 的「新建会话」按钮逻辑是（`ui-workspace` 的 `createInWorkspace`）：找**第一个** `blank: true` 的会话复用。
而 `blank` 只有在会话产出过 `turn/start` 事件之后才变 `false`（`sessionListMetadata` 投影）。

所以单纯预创建一个空会话，它永远是 `blank: true`，会被你点「新会话」时直接收走，
表现就是「新会话建不出来」。因此预创建后必须**立刻触发一次 turn**让它脱 blank。
最省的办法是发一条占位消息再取消——代价是历史里会留下一条 `（定时发送占位）` 消息，
这是预创建模式的固有代价（其它同类插件也都有）。

需要严格干净的会话历史时，可以在对话内定时发送（不预创建，只绑当前对话）。

### 「最近的谷时」按钮

时间框上方一个按钮，点一下自动把时间设到**最近的谷时段起点**：

- **当前已在谷时** → 设为当前时间 + 2 分钟（整分向上取整，与默认值一致）。
- **当前在高峰** → 设为**本段高峰结束的那一刻**，也就是最近谷时段的起点（12:00 或 18:00）。

### DeepSeek 谷时段提示

时间框正下方实时显示两行：

```
● DeepSeek 谷时段    谷时段 · 5 折    还剩 26 分钟 转高峰
● 所选时间           谷时段 · 5 折    13:49
```

- 第一行是**现在**的状态与距下次切换的倒计时；第二行是**你选的发送时刻**落在哪一档。
- 口径来自 [DeepSeek 官方定价页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)：北京时间**工作日 09:00–12:00、14:00–18:00** 为高峰（原价），其余时段与**周末全天**为空闲时段（5 折）。
- **法定节假日**按 [国务院办公厅《关于2026年部分节假日安排的通知》](https://www.gov.cn/zhengce/content/202511/content_7047090.htm)（国办发明电〔2025〕7号）内置：
  元旦 1/1–1/3、春节 2/15–2/23、清明 4/4–4/6、劳动节 5/1–5/5、端午 6/19–6/21、中秋 9/25–9/27、国庆 10/1–10/7；假期全天算谷时。
- **调休上班日**（1/4、2/14、2/28、5/9、9/20、10/10）按工作日处理，高峰照常。
- 2027 年安排官方尚未公布，届时按普通星期判定；面板说明里已注明覆盖年份。

## 安装

从 npm 安装（发布后可用）：

```bash
dsh plugin --profile web add dsh-timed-send
```

或从本地源码安装：

```bash
cd <插件所在目录>
dsh plugin --profile web add ./dsh-timed-send
```

或手动（本机已用这种方式装好）：

1. `~/.dsh/profiles/web/package.json` 的 `dependencies` 加
   `"dsh-timed-send": "link:D:/tool/deepseek/3/dsh-timed-send"`
2. 同文件 `dsh.profile.bundles` 追加 `"dsh-timed-send"`
3. `~/.dsh/profiles/web/node_modules/dsh-timed-send` 指向源码目录

改完 **重启 `dsh web`**，浏览器 **Ctrl+Shift+R** 硬刷新。

## 测试

```bash
node --test test/engine.test.mjs   # 22 个纯逻辑用例
```

## 出问题怎么清除影响（重要）

这个插件的所有失败路径都被 try/catch 包住，**正常情况下不会让 DSH 起不来**。但万一真的起不来，按下面的顺序处理，从轻到重：

### 0. 先看现象

```bash
dsh web
```

- 只打印 `warning: N entries did not activate` 并照常给出 URL → **DSH 照常可用**，只是插件没生效。可以继续用，然后按第 1 步排查。
- 打印 `startup failed: N required plugins did not activate` → DSH 起不来。本插件**不在 required 列表里**（required 只有 `webserver` 等核心条目），所以启动失败基本不是它单独造成的；但如果你刚装完就炸了，按第 1 步禁用最稳。

浏览器端（Host 正常、页面异常）看 F12 Console，本插件所有报错都带 `[scheduled-send]` 前缀。

### 1. 最快：禁用条目（不用卸载，10 秒）

编辑 `~/.dsh/profiles/web/cordis.patch.yml`，**追加**一段（追加在文件末尾即可，后应用的补丁覆盖前面的）：

```yaml
- id: scheduled-send
  disabled: true
```

保存后**重启 `dsh web`**。`cordis.patch.yml` 被 DSH 热重载，但禁用条目这种结构性改动仍建议重启确认。

这一步只屏蔽 Host 条目；浏览器端那个客户端包会因为没有对应 Host 条目而不参与组合，`conversation.input.dock` 上的按钮随之消失。

### 2. 彻底停用：从 profile 摘掉

编辑 `~/.dsh/profiles/web/package.json`：

- `dsh.profile.bundles` 数组里删掉 `"dsh-timed-send"`
- `dependencies` 里删掉 `"dsh-timed-send": "link:..."`

再删掉 profile 里的链接目录：

```powershell
Remove-Item "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-timed-send" -Recurse -Force
```

然后 `dsh web`。此时插件完全不参与启动。

> 本机安装时已备份：`package.json.bak-before-scheduled-send`、`cordis.patch.yml.bak-before-scheduled-send`（同在 `~/.dsh/profiles/web/`）。想一键回到安装前：
> ```powershell
> cd "$env:USERPROFILE\.dsh\profiles\web"
> Copy-Item package.json.bak-before-scheduled-send package.json -Force
> Copy-Item cordis.patch.yml.bak-before-scheduled-send cordis.patch.yml -Force
> ```

### 3. 清数据（可选）

```powershell
Remove-Item "$env:USERPROFILE\.dsh\data\scheduled-send" -Recurse -Force
```

里面有 `tasks.json`。删掉 = 丢弃所有定时任务。若只想丢掉坏掉的记录又不想全删，把 `tasks.json` 改名备份即可 —— 插件启动时读不到文件会从空表开始，**不会因此报错**（这本身也是它的容错设计：坏 JSON 会被自动改名为 `tasks.json.broken-<时间戳>` 后从空表继续）。

### 4. 应急：整个 profile 重置

只在 profile 被彻底搞坏时用（会丢掉该 profile 的所有插件配置，慎重）：

```bash
dsh rescue --from-default-profile web
```

它会用出厂模板重建 `rescue` profile 并启动，你的 `web` profile 目录不受影响，可以从容排查。

### 排查命令

```bash
# 看组合后的配置树里有没有这个条目、是否 disabled
dsh --profile web --dump-config | Select-String -Context 1,2 scheduled-send

# 起一个不冲突端口的临时实例，看插件日志
dsh web --port 28101 --no-open
```

Host 侧正常时日志里会有：

```
[scheduled-send] 定时引擎已启动，数据文件：C:\Users\...\.dsh\data\scheduled-send\tasks.json
[scheduled-send] 已发送 <任务id> → 会话 <会话id>
```

## 工作机制

```
浏览器                                    Host
──────────────────────────────────────────────────────────────
点「定时发送」→ 选时间 → 确认
  ├─ sessions.create({workspaceId}) ─────▶ 建会话（不发送）
  ├─ POST /dsh-timed-send/api
  │    {action:"create", sessionId, text, at} ─▶ 写 tasks.json + 排定时器
  └─ uiWorkspace.openSession(新会话)
                                          到点：sessionController.prompt()
                                                （= 用户回车，走同一条准入路径）
```

- Host 路由 `POST /dsh-timed-send/api`，动作：`health` / `create` / `list` / `cancel` / `reschedule` / `sendNow` / `retry`。
- 只接受**本机同源** POST：拒绝 `sec-fetch-site: cross-site`、拒绝与 Host 不一致的 `Origin`、loopback Host 还要求连接来自 loopback。
- 投递失败标 `failed` 并留错误文本，**不自动重试**（避免一个挂掉的会话把定时队列堵死）；用面板上的「重试」手动重发。
- 单次投递超时 120 秒；定时器最长睡 60 秒就醒来重算一次，所以改系统时钟、休眠唤醒都能纠正。
- 已结束任务保留 7 天；`active` 任务无论多久都保留（等引擎补发）。

## 已知限制

- 只支持**纯文本**定时发送。附件、图片不参与定时；输入框里的 `/xxx` 会按普通文本发出（不会当斜杠命令执行）。
- 面板复用原始输入框，所以定时内容取自**点确认那一刻**输入框里的文本；登记后会清空该输入框。
- 同一对话可以排多条定时任务，按时间先后依次发出。
- **编辑**：点待发条目的「编辑」，正文会被放进原始输入框、按钮变成「保存」；改完点保存写回任务，**时间保持不变**。点「放弃」清空输入框并退出编辑。失败的任务同样可编辑、可取消。
- 界面字号比 DSH 默认大 6 号（正文 12→18、标题 13→19），面板宽度加宽到 420px。
- 时间精确到**秒**（输入框 `step=1`），显示格式为 `HH:mm:ss`。
- 点「保存」写回正文后，输入框会清空并退出编辑态。
- 定时任务绑定的是**会话**，不是会话里的位置：到点时以新的 user 消息追加进该会话。
- 如果到点时该会话正被别处删除/归档，投递会失败并在列表里显示原因。
- 待发列表每 30 秒轮询一次，倒计时不是秒级刷新。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.mjs` | Host 半件：存储、定时引擎、HTTP 路由、真实发送 |
| `client.js` | 浏览器半件：按钮、时间面板、待发列表 |
| `cordis.patch.yml` | bundle 补丁，插入 `id: scheduled-send` 条目 |
| `test/engine.test.mjs` | 纯逻辑单测（22 例：存储 / 定时引擎 / 请求守卫 / 谷时段 / 节假日 / 最近的谷时 / 延后创建） |
| `test/e2e_check.py` | Playwright 端到端验证脚本（临时实例用） |
