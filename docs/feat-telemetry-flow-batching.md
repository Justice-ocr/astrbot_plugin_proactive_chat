# Commit 3 交接文档：遥测弹性打包 + 熔断缓冲 + 低频恢复同步

## 原因分析

插件每次执行一次完整的主动消息流程（从任务触发到消息发送），会依次产生 4-5 个 `track_feature` 事件：

```
proactive_task_started → llm_context_prepared → llm_generate_result → llm_response_ready → message_send_result
```

每个事件都通过 `asyncio.create_task` 立即发起一个独立的 HTTP 请求。当插件同时服务多个群/私聊时，短时间内可能密集产生十几个请求，容易触发服务端的频率限制（429）。

Commit 2 引入的熔断器解决了"不再白发请求"的问题，但熔断期间所有事件直接丢弃（`return False`），导致遥测数据出现大段空白——对插件作者分析功能使用率、错误趋势、LLM 调用成功率等指标造成影响。

核心矛盾：**请求频率过高** vs **数据完整性**。

## 修复思路

从三个层面同时解决：

### 1. 弹性打包（降频）

采用"阈值 OR 超时"双触发机制，不依赖流程边界，对调用方完全透明：

- **阈值触发**：`_feature_buffer` 中事件数达到 `_FLUSH_THRESHOLD`（5 条）时立即打包发送
- **超时触发**：首条事件入 buffer 后启动 `_FLUSH_TIMEOUT`（15 秒）计时器，到期后强制 flush

这种设计的优势：
- 不需要调用方配对 `begin_flow()`/`end_flow()`，消除了并发流程覆盖 buffer 的风险
- 高频场景（多群同时触发）：5 条一批，请求量降低约 80%
- 低频场景（偶尔一条 feature）：最多等 15 秒就发出，不会无限积压

服务端 ingest API 原生支持 `batch` 数组，无需任何服务端改动。

### 2. 熔断缓冲（不丢数据）

熔断期间事件不再直接丢弃，而是存入 `_backlog`（`collections.deque`，`maxlen=200`）。超出上限时自动淘汰最旧的事件，防止内存无限增长。

所有事件类型（feature、error、startup、config、heartbeat）在熔断期间都会进入 backlog。

### 3. 低频恢复同步（不再次触发限流）

当熔断冷却结束、下一次 `_send_batch` 成功后，检查 backlog 是否有积压。若有，启动后台 `_drain_backlog` 任务：

- 每次从队列头部取最多 10 条事件打包发送
- 每批之间间隔 5 秒
- 若发送失败（再次被限流），立即停止 drain，事件放回队列
- 同一时刻只允许一个 drain 任务运行

## 修复前后行为对比

| 场景 | 修复前（Commit 2） | 修复后（Commit 3） |
|------|-------------------|-------------------|
| 一次主动消息流程 | 产生 4-5 个独立 HTTP 请求 | 攒满 5 条打包为 1 个请求 |
| 5 个群同时触发 | 瞬间 20-25 个请求，大概率触发 429 | 约 4-5 个请求（每 5 条一批） |
| 低频单条 feature | 立即发送 | 最多等 15 秒后发送 |
| 熔断期间的事件 | 直接丢弃（`return False`） | 存入 backlog，最多保留 200 条 |
| 熔断恢复后 | 无补发，数据永久丢失 | 后台低频逐批补发（每 5s 一批） |
| 恢复瞬间 | 无特殊处理 | 限速发送，不会再次触发 429 |
| 插件关闭时 | 积压事件随进程消失 | 取消计时器 → 合并 buffer 到 backlog → 最后一次 flush |
| track_error 行为 | 熔断时丢弃 | 熔断时存入 backlog，恢复后补发 |
| 内存占用 | 无额外占用 | 最多 200 条事件 × ~1KB ≈ 200KB |

## 弹性打包状态机

| 当前状态 | track_feature 行为 |
|----------|-------------------|
| 正常 + buffer 未满 | 追加到 `_feature_buffer`，确保超时计时器在运行 |
| 正常 + buffer 达到阈值 | 立即 flush 整个 buffer（取消计时器） |
| 正常 + 超时到期 | 计时器回调强制 flush 当前 buffer |
| 熔断中 | 直接存入 `_backlog`，不进入 buffer |
| 恢复中 | 正常进入 buffer + 后台 drain backlog |

## 可能造成的影响

### 正面

- 请求频率大幅降低，几乎不会再触发 429
- 遥测数据完整性显著提升，熔断期间不再有数据空洞
- 事件循环更干净，减少无效网络 IO 对 WebUI 的干扰
- 对调用方完全透明，无需配对 begin/end 调用

### 需要注意

- **feature 事件最多延迟 15 秒上报**：对于实时性要求不高的遥测统计来说完全可接受。error/startup/config/heartbeat 等非 feature 事件仍然立即发送。
- **backlog 上限 200 条**：如果熔断持续很长时间（>5 分钟）且插件非常活跃，最旧的事件会被 deque 自动淘汰。这是有意为之的内存保护，不是 bug。
- **drain 任务与 shutdown 的竞争**：`close()` 方法先取消计时器、再 cancel drain、再合并 buffer、最后 flush，确保不会在 session 关闭后仍有后台请求。但如果 flush 本身超时（5 秒），积压事件会丢失。这是可接受的——shutdown 阶段不应无限等待网络。
- **计时器生命周期**：`_flush_timer_task` 在首条事件入 buffer 时启动，flush 后自动清理。如果 flush 由阈值触发（攒满 5 条），会主动 cancel 尚未到期的计时器，避免重复 flush 空 buffer。

## 涉及文件

| 文件 | 变更内容 |
|------|----------|
| `core/telemetry_manager.py` | 移除 `begin_flow()`/`end_flow()`，新增 `_FLUSH_THRESHOLD`/`_FLUSH_TIMEOUT` 常量、`_feature_buffer`/`_flush_timer_task` 状态、`_flush_feature_buffer()`/`_flush_timer_expired()`/`_cancel_flush_timer()`/`_ensure_flush_timer()` 方法、重写 `track_feature()` 为弹性打包、更新 `close()` 处理计时器与 buffer 清理 |
| `core/chat_flow.py` | 移除 `begin_flow()`/`end_flow()` 调用（弹性打包对调用方透明，无需流程边界标记） |
