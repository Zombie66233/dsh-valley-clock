# dsh-valley-clock · 峰谷时钟

装在 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 会话标题栏右上角的一个小时钟：

- 常驻显示**北京时间**（时分秒），不依赖本机时区
- 只在 **DeepSeek 官方通道**下按峰谷定价给时间上色：高峰红、空闲绿
- 点开浮层能看：当前时段、距下次切换的倒计时、当前模型、**API 余额**（四家提供商）

> **第三方插件，非 DeepSeek 官方。** 接口、定价与政策都归各自公司，本项目只是按公开规则读取与计算。

## 关于这个项目（作者自述）

先把话说明白，省得后来的人有错误期待：

- **作者没有编程基础**，这是纯 **Vibe Coding** 产物：需求、判断、验收由作者完成，代码由 AI 生成（DeepSeek Harness 的「创造模式」，对话过程可回溯）。
- **主要用途是自用**。开源的属性更接近**公域留档**——把能跑的版本放出来，免得哪天本机出问题就没了。
- **维护极少**：不承诺响应 issue，不承诺跟 DeepSeek 的政策变化，也不承诺合并 PR。能用就拿走，不能用就 fork，都不用打招呼。
- **已经内置了「不维护也不骗人」的设计**：节假日表只到 2027 年。从 2028-01-01 起，时钟会自己变成中性色，并写明「作者只维护到 2027 年，之后不再判断峰谷时段」（见「表用完了会怎样」）。一个在元旦当天还自信地说「高峰」的时钟，比一个承认自己不知道的时钟更糟。
- 基于 MIT，随便用，但没有值守承诺。

## 行为

| 场景 | 时间颜色 |
| --- | --- |
| 当前模型走 DeepSeek 官方通道，高峰时段 | 红（`--dsw-alias-state-error-primary`） |
| 当前模型走 DeepSeek 官方通道，空闲时段 | 绿（`--dsw-alias-state-success-primary`） |
| 其它任何渠道（OpenAI / 通义 / 硅基流动转售的 deepseek 模型……） | 常规文字色（`--dsw-alias-label-primary`） |
| 官方通道，但已超出节假日表覆盖的年份（表到 2027，则 2028 起） | 常规文字色，浮层改说「作者只维护到 2027 年……」 |

浮层内容：大号北京时间；**官方 DeepSeek 通道**下是时段（含「周末」「法定节假日」标注）+ 距下次切换的倒计时；**其它通道**在同一位置换成一句「非 DeepSeek 官方通道，不适用峰谷价」，不显示倒计时。分割线以下两种通道完全一致：当前模型、API 余额。
按钮再点一次、点击浮层外、按 Esc、窗口失焦都会关闭。

**「是不是官方通道」只看 provider id，模型名从不参与判定。** 这一点必须守住：大模型名字会被一堆中转平台转售（硅基流动的 `deepseek-ai/DeepSeek-V3`、OpenRouter 的 `deepseek/...`），而各家的价格政策互不相同——硅基流动根本不是 DeepSeek 那套峰谷时钟。用模型名去猜通道，等于在一个从没有过半价时段的渠道上宣称「现在半价」。
provider id 认不出来时一律按「非官方通道」处理，这是刻意选的安全侧：错说成「高峰价」会误导你对钱的判断，错说成「非官方」只是多一句实话。私有/组合出来的 provider id 可以靠 `config.deepseekProviders` 显式认领。

## 峰谷规则

来自 [DeepSeek 官方定价页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)：
北京时间周一至周五（不含中国法定节假日）9:00-12:00、14:00-18:00 为高峰；其余（含周末与法定节假日全天）为空闲，空闲价为高峰价的一半。
**12:00 整与 18:00 整按空闲计**（区间左闭右开）。

## 时区

时钟不依赖本机时区：用 `Intl.DateTimeFormat` 固定按 `Asia/Shanghai` 取值。
中国不实行夏令时，所以「下一次切换时刻」可以直接用固定 `+08:00` 换算成绝对时间。

## 两条请求：时段一条，钱包一条

时钟的颜色只需要「当前 provider 是谁」+「表覆盖到哪年」，这两件事都在 Host 进程内算得出来，**不该等网络**。所以：

- `POST /valley-clock/status` —— 毫秒级返回，**完全不出网**（测试断言它的出网请求数必须为 0）
- `POST /valley-clock/balance` —— 允许慢；Host 侧对钱包调用有 `requestTimeoutMs` 兜底，客户端 30 秒放弃
- 客户端：状态没拿到时按 **250ms → 500ms → 1s → 2s → 4s → 8s → 15s → 60s** 退避，拿到之后 60 秒一次；钱包同一时刻只允许一个请求在飞

**重试链必须先排定时器、再等结果。** 曾经写成"await 结果 → 再排下一次"，于是一次永远不返回的请求就让整条链停摆——表现是"重启后时钟一直黑/白，点一下浮层才变色"。定时器与 Promise 无关地存在，这条链才不会断。

**不能只靠定时器。** 浏览器会节流隐藏窗口里的定时器（藏久了重到一分钟一次）。表现就是"重启后一直白、点一下才变绿"，而且**多个已挂载的时钟会一起变绿**——它们都在等同一个被节流的队列放行。所以状态未就绪时还有三条唤醒路径会立即重试：`visibilitychange`（页面转为可见）、`window.focus`、`document pointerdown`（用户第一次操作页面）。定时器只是兜底，唤醒才是主路径。

**命名会话绝不借用"默认模型"。** 一个带了 `sessionId`、但 Host 此刻还读不到那次会话的请求（启动水合窗口），返回的是「不知道」（`routeSource: 'none'`），而不是 profile 里的默认模型。默认模型是**新会话**的起点，不是老会话的计费口径——拿它顶替会在启动瞬间把 DeepSeek 会话标成中转渠道，时钟掉色，然后要等下一次 60 秒轮询才恢复。
真正来自默认模型的答案会带 `routeSource: 'default'`，客户端一律当**猜的**处理：不上色、不说渠道、继续快速重试，模型行显示「未知」、余额显示「读取中…」。宁可什么都不说，也不说一句错的。

**未就绪时自己说出来**：把鼠标停在时钟上，tooltip 会给出卡点——`HTTP 404`（启动竞态）、`HTTP 403`（门禁）、`AbortError`（挂住）、`no route`（连上了但认不出通道）。连续 3 次拿不到可用答案时，控制台还会打一行 `[valley-clock] status still unavailable after 3 attempts: …`。

## 节假日表

内置 2026、2027 两年，逐年一段，来源都是国务院办公厅的正式通知：

| 年份 | 依据 | 假期 |
| --- | --- | --- |
| 2026 | 国办发明电〔2025〕7号（2025-11-04） | 元旦 1/1-1/3、春节 2/15-2/23、清明 4/4-4/6、劳动节 5/1-5/5、端午 6/19-6/21、中秋 9/25-9/27、国庆 10/1-10/7 |
| 2027 | 国办发明电〔2026〕10号（2026-11-05） | 元旦 1/1-1/3、春节 2/5-2/13、清明 4/3-4/5、劳动节 5/1-5/5、端午 6/9、中秋 9/15、国庆 10/1-10/7 |

周末本身已是空闲价，所以表里列出假期内的每一天即可，不必区分「调休上班日」——调休日若落在周末仍按周末算空闲，与官方规则一致（2027 年的 1/31、2/14、5/8、9/26、10/9 都是周末）。

### 表用完了会怎样

覆盖范围**从表本身推导**（`coveredThroughOf()` 取表里最大的年份），不另写常量，所以「表到哪年」和「判定认哪年」不可能对不上。**超出覆盖年份的那一天起**：

- 时钟不再上红/绿，回到常规文字色（浅色主题下是黑、深色主题下是白）
- 浮层里那句时段读数换成 **「作者只维护到 2027 年，之后不再判断峰谷时段」**
- 不再显示倒计时——不知道的东西不给倒计时

这是刻意的取舍。想恢复只需在 `DEFAULT_HOLIDAYS` 里加下一年的段落，或整表覆盖：

```yaml
- id: valley-clock
  name: dsh-valley-clock
  config:
    holidays: ['2028-01-01', '2028-01-02']
```

覆盖后 `coveredThrough` 会自动跟着新表走。**别只写一半年份的日期**：表里的最大年份就是承诺的范围。

（同类插件 `dsh-peak` 在这里分得更细——表外的工作日说「未知」，表外的周末仍确定答「空闲」。本项目把整年都按「不判断」处理，因为一旦跨年，连「下一个高峰」都要跨过未知区间，干脆整段不猜。）

## 余额来源

Host 端按以下顺序取值，取到即止；全部失败时只报告原因，绝不显示一个假的 0：

1. **DeepSeek 官方账号钱包**：`ctx.deepseekAccount.getBalance()`（登录 DeepSeek 账号时可用，优先于 API Key）
2. **显式配置的 Key**：`config.apiKeys`
3. **本 provider 自己配置的环境变量名**：其设置分支里的 `apiKeyEnv`（可写成字符串或数组），经凭据层解析 —— 凭据层会先查凭据库、再退回进程环境与 `.env`
4. **运行期 provider 目录**：`llm.listConfigurableProviders()` 报出的 `nativeAuth.env`
5. **内置候选名**：`DEEPSEEK_API_KEY` / `MOONSHOT_API_KEY` / `OPENROUTER_API_KEY` / `NOVITA_API_KEY` 等
6. **本 provider 设置分支里的字面 Key**：形如 `apiKey` / `key` / `token` 的字段

第 3～6 步**一律只在本 provider 自己的设置分支里找**，绝不扫描整行。所有 provider 共用同一个设置行，整行扫描会把别家的 Key 发给这一家，而对方会回一个完全"合理"的 401 —— 改这条逻辑时务必保留「拿不到就不猜」这个行为。

已支持的余额接口：

| 提供商 | 接口 | 币种 |
| --- | --- | --- |
| DeepSeek | `GET https://api.deepseek.com/user/balance` | CNY |
| Moonshot / Kimi | `GET https://api.moonshot.cn/v1/users/me/balance` | CNY |
| OpenRouter | `GET https://openrouter.ai/api/v1/credits` | USD |
| Novita AI | `GET https://api.novita.ai/openapi/v1/billing/balance/detail` | USD |

> Novita 的金额是 **1/10000 美元**的整数（`10000` = $1.00），必须在解析时除以 10000，否则 $100 会显示成 `$1000000.00`。这条写在 `toUsd()` 里，别绕过它。

其余渠道显示「当前调用的 API 不支持显示余额」；支持但没找到凭据时显示「未找到该服务的 API Key」。

**读失败时会带出原因**，不再是一句笼统的"余额读取失败"：

| 显示 | 含义 |
| --- | --- |
| `该服务已下线余额接口 · HTTP 410` | 对方把余额接口**永久下线**了（410 Gone，另含 404/501），不是读取失败，也不是 Key 的问题。这个结论会缓存 6 小时，不再反复探活 |
| `余额读取失败 · HTTP 401 · Token is invalid.` | 接口认这把 Key 失败（Key 过期/无权/抓错了别家的 Key），后一段是对方自己给的原话（≤48 字符才带） |
| `余额读取失败 · 响应里没有余额字段` | 200 但拿不到 `totalBalance` 这类字段，通常是账号未充值/未实名 |
| `余额读取失败 · 响应无法解析` | 200 但不是 JSON（网关错误页之类） |
| `余额读取失败 · 请求超时` / `· 网络错误` | 连不上或不响应 |

### 为什么没有硅基流动

官方公告（2026-08-11，`[API Service Adjustment] /user/info Endpoint Deprecation`，
见 [更新公告](https://docs.siliconflow.cn/docs/release-notes/overview)）写明 `/user/info` 于
**2026-08-14（周五）正式下线**，并说明后续推出的账户接口会是**新端点**、届时在该页公布。

实测该路径现在返回 **410 Gone**。因此它被从余额来源里移除，而不是保留成一个永远失败的请求：
调用硅基流动时会显示「当前调用的 API 不支持显示余额」，这才是此刻真实的状态。
等新端点公布后，按 `BALANCE_SOURCES` 的格式加一条即可恢复（**不要**把旧的 `/user/info` 加回来）。

## 配置项

全部可选，写在本插件行的 `config` 里：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `holidays` | 内置 2026+2027 表 | `YYYY-MM-DD` 数组，替换整张节假日表 |
| `deepseekProviders` | `['deepseek']` | 视为 DeepSeek 官方通道的 provider id 片段（小写、包含匹配） |
| `apiKeys` | `{}` | `{ deepseek: 'sk-...' }`，优先级最高 |
| `extraEnvKeys` | `{}` | `{ moonshot: ['MY_KIMI_KEY'] }`，额外查找的环境变量名 |
| `requestTimeoutMs` | `8000` | 单次余额请求超时 |
| `balanceCacheMs` | `300000` | 成功余额的复用时长（失败只缓存 30 秒） |

例：给 DeepSeek 填一个专用 Key

```yaml
- id: valley-clock
  name: dsh-valley-clock
  config:
    apiKeys:
      deepseek: sk-xxxxxxxx
```

## 安装

在 DSH 里让我装（推荐）：

```
plugin_manager  action: install_bundle  target: dsh-valley-clock
```

或直接指向仓库：

```
plugin_manager  action: install_bundle  target: github:Zombie66233/dsh-valley-clock
```

或本地目录（开发调试）：

```
plugin_manager  action: install_bundle  target: D:/path/to/dsh-valley-clock
```

装完**刷新页面**。替换已装版本需要重启 DSH 才会加载新的 Host 半边。

> 注意：DSH 的 web 载体是先监听、插件后注册路由，所以**重启后的第一次请求会撞 404**，这是正常现象——客户端会在 250ms 内自动重试并恢复。

## 结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半边：`POST /valley-clock/status`（时段，纯进程内计算，毫秒级）与 `POST /valley-clock/balance`（钱包，可能很慢）；两条都经 `ctx.webServer` 注册、过 `ctx.connection.requestRejection` 同一道门禁 |
| `client.js` | 客户端半边：注册进 `conversation.session.header.utilities`（order 60），自绘时钟与浮层，每秒本地走时 |
| `cordis.patch.yml` | 往 profile 里插一行插件 |
| `locale/*.json` | 插件管理页显示的标题与描述 |
| `icon.svg` | 上红下绿的表盘图标（高峰 / 空闲） |

浮层用 `document.body` 上的 portal + `fixed` 定位，位置由按钮的 `getBoundingClientRect()` 算出；标题栏的行内绝对定位会被它自己的截断规则裁掉。
控件样式走 `--dsw-alias-*` 主题令牌，几何与配色是内联样式（不依赖 `styles` 内置），`styles.insert` 只补 hover/focus/过渡。

## 和同类插件的区别

这个品类已经有好几个，各有取向，列在这里方便你挑：

| 项目 | 位置 | 特点 |
| --- | --- | --- |
| **本项目** | 会话标题栏（常驻） | 不占输入框、不遮挡内容；四家 API 余额；节假日表到期会自己承认不知道 |
| `dsh-peak` | 输入框工具行 | 胶囊 + 卡片；跨年分得更细（表外工作日说「未知」、周末仍确定）；有切换前提醒 |
| `dsh-clock` | 浮动窗 | 可拖拽缩放；高峰闪红灯；颜色与闪烁可设置 |
| `deepseek-time-price` | 浮动窗 | 远程拉节假日数据；估算「本项目」累计花费 |

判定规则大家是一致的（都按官方峰谷窗口 + 国办节假日通知）。本项目的取舍是：**宁可少说，不说错**——宁可显示「不知道」，也不猜一个可能说错的档位。

## License

[MIT](LICENSE)
