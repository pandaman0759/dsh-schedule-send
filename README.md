# DSH Schedule Send · 定时发送

<img src="icon.svg" width="96" height="96" alt="DSH Schedule Send">

给 DSH 输入框加一个时钟按钮：写一句话，定好什么时候发，到点它就当成你亲手发出的消息，用纯原话送到这个会话。

## 特性

- 三种发送方式，面板左边选、右边写内容：
  - **本轮结束后发送**：等当前这一轮回答结束（会话真正回到空闲）才发出，不会插进正在跑的轮次里
  - **间隔发送**：每 X 小时 Y 分钟发一次，可设「共发几次」
  - **定时发送**：指定日期时间，可选不重复 / 每天 / 每周几 / 每月几号
- 发出去的**就是正文原话**，不带任何 `[SCHEDULE REMINDER]` 之类的系统信封
- 发送时按 DSH 设置页「繁忙时的发送行为」走：设成排队就排队，设成插话就插话（和你在输入框里手动按回车完全一致）
- 输入框上方挂待发送卡片：倒计时（等轮次的显「本轮结束后」）+ 正文缩略 + 一键删除
- 任务存在 `~/.dsh/schedule-send/tasks.json` 里，重启 DSH 不丢
- 时区取会话所在浏览器的时区，跨夏令时也能算对下一次

## 安装

```
plugin_manager install_bundle target=<本目录>
```

装好后输入框右侧出现小时钟图标。

## 使用

1. 点时钟 → 左列挑模式 → 右边写要发的内容
2. 定时模式再填日期、时间、重复规则
3. 点「创建」，卡片立刻出现在输入框上方
4. 想取消，卡片右边 × 一下，或者打开面板删掉

「本轮结束后发送」在会话空闲时创建，会立刻发出（1 秒后）；会话正忙时创建，会等下这一轮收尾。

## 实现

- Host 半自己维护任务表 + 1 秒 tick 排期，不依赖内置 `schedule` 服务（后者的投递必然包一层 reminder 信封，且它的 `after` 只从创建时刻起算秒数，没有「轮次」概念）
- 投递统一走 `ctx.sessionController.prompt({ sessionId, mode, content: [{ type: 'text', text }] })` —— 和 Web UI 发消息是同一条通道
- 「本轮结束后」靠 `sessionController.state({ sessionId }).running` 判断：running 时任务挂起，tick 看到转空闲才投递
- 发送模式读 `settings.describe()` 里 `ui-conversation` 的 `config.busyEnter`
- 面板与卡片都是 Client slot：`conversation.input.right`（按钮）、`conversation.input.dock`（卡片）

## 目录

```
index.js          Host 半：任务表、排期计算、tick 投递、HTTP 路由、持久化
client.js         Client 半：时钟按钮、设置面板、待发送卡片
cordis.patch.yml  bundle 注册
locale/*.json     中英文案
icon.svg          图标
```

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dsh-schedule-send/list?sessionId=` | 列出该会话的待发送任务，并回当前发送模式 |
| POST | `/api/dsh-schedule-send/create` | 建任务（`mode` / `prompt` / `zone` + 模式参数） |
| POST | `/api/dsh-schedule-send/delete` | 删任务 |
| POST | `/api/dsh-schedule-send/run` | 立刻发一次 |

## License

MIT

---

## English

A clock button for the DSH composer: write a message, pick when it should go out, and it arrives later as a plain message you typed yourself.

- **After this turn**: waits until the session actually goes idle, so it never lands in the middle of a running turn.
- **Interval**: every X hours Y minutes, up to N sends.
- **Scheduled**: a given date and time, optionally repeated daily / on chosen weekdays / on a day of month.
- Delivery follows your DSH "busy send behaviour" setting (`queue` or `steer`), identical to pressing Enter yourself.
- Pending sends show as a countdown card above the composer, with a one-click delete.
- Tasks persist in `~/.dsh/schedule-send/tasks.json` and survive restarts.

Install: `plugin_manager install_bundle target=<this dir>`.

MIT licensed.