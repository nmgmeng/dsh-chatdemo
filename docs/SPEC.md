# chat-demo 1:1 wire spec

来源：`github.com/deepseek-ai/chat-demo`（main，commit `8ad7b56`）的客户端源码。
本文件是 dsh-chatdemo 的实现依据，不是推测；服务端字段变化时以源码为准更新这里。

## 1. 请求信封

`POST https://api.deepseek.com/anthropic/v1/messages`，header：

```
x-api-key: <key>                        # 账户模式改为 x-dsh-auth-token
Content-Type: application/json
Accept: text/event-stream
User-Agent: deepseek-harness (+https://github.com/deepseek-ai/deepseek-harness)
anthropic-beta: files-api-2025-04-14    # 仅当请求里带 file_id 引用或上传文件
```

demo 客户端**不发送 `anthropic-version`**；也不要发 DSH 内置适配器会发的
`output_config` / `max_tokens`。

body：

```json
{
  "model": "deepseek-flash",
  "system": "该助手为DeepSeek，由深度求索公司创造。",
  "messages": [],
  "thinking": { "type": "enabled" },
  "tools": [
    { "type": "deepseek_read_url",  "name": "deepseek_read_url" },
    { "type": "deepseek_web_search", "name": "deepseek_web_search" }
  ],
  "safety_check": { "level": "high" },
  "stream": true
}
```

- `system` 是常量，`safety_check` 恒为 high。
- `tools`：`deepseek_read_url` 恒在；`deepseek_web_search` 只在“智能搜索”打开时追加。
- `thinking` 由“深度思考”开关决定（本插件映射到模型选择器的推理强度）。
- `title` 只在会话还没有标题时由 demo 发送；DSH 侧无法写回标题，本插件不发。
- **不发** `max_tokens`、`temperature`、`output_config`、`stop_sequences`。

## 2. messages 构造

- 只保留「user 提问 + 可用 assistant 回答」成对的轮次；失败的、没有正文的轮次不进上下文。
- reminder 在「内容与上一条不同」时插到对应 user 之前。
- 当前提问之后，续写场景才追加一条末尾 assistant（`prefix`），普通提问不追加。

### 2.1 user 消息

```jsonc
// 无文件
{ "role": "user", "content": "帮我判作业" }
// 有文件：文件在前，文本在后
{ "role": "user", "content": [
  { "type": "image", "source": { "type": "file", "file_id": "file-..." } },
  { "type": "text", "text": "帮我判作业" }
] }
```

非图片附件用 `document` 块；扩展模式（带工具/安全审查）下服务端**不支持 document**，会 400。
图片先按长边 4096 压缩再上传。

### 2.2 assistant 消息（回放规则，最容易做错）

| 块 | 回放 |
|---|---|
| `thinking` | 历史不回传；只有续写时保留本轮非空思考 + signature |
| `text` | 回传，但去掉 citations；相邻文本直接拼接；被思考/工具隔开的文本之间补空行；空文本丢弃 |
| `server_tool_use` | 只回传 `kind === "read_link"` 的 |
| `web_search_tool_result` | 不回传 |
| `web_fetch_tool_result` | 只回传 `kind === "read_link"` 且 `signature` 非空的 |
| 失败轮次 / refusal 轮次 | 整轮不回传 |

也就是说：deep_search 的搜索结果对下一轮不可见；只有 read_link 的网页正文靠
signature 恢复。签名缺失时调用与结果都不回传。

### 2.3 latest_reminder

```
<YYYY-MM-DD>,<星期的本地化全称>,<城市或地区名>,,Web,中文
```

- 日期与星期用本地时区；地点没有就是空串。
- 实例：`2026-11-23,星期日,,Web,中文`。
- 存储：挂在 assistant 回答上，下一轮重建历史时用它决定是否插入；同一提醒不重复插入。

## 3. 响应

SSE，事件名 = JSON 的 `type`，以 `message_stop` 结束，**没有 `[DONE]`**。

- `thinking`：`{thinking, signature}`；signature 经 `signature_delta` 增量下发。
- `text`：`{text, citations?}`；引用经 `citations_delta` 下发；挂过引用的文本块之后另起新块。
- `server_tool_use`：`{id, name, input, caller, kind}`；`content_block_start` 即带完整 input。
- `web_search_tool_result`：`{tool_use_id, content:[...], kind}`；`encrypted_content` 客户端无法解密。
- `web_fetch_tool_result`：`{tool_use_id, content, kind, signature?}`；read_link 的正文加密在 signature 里。

`message_delta.delta`：`stop_reason` ∈ `end_turn | max_tokens | tool_use | refusal`。
`usage`：`input_tokens / cache_creation_input_tokens / cache_read_input_tokens / output_tokens`。

**refusal**：`stop_reason === "refusal"` 时客户端丢弃本轮 thinking/text；DSH 的流式协议
无法撤回已经下发的内容，本插件按正常结束收尾并在 README 说明。

## 4. 错误与重试

- 非 2xx：读 JSON 的 `error.message`。
- 流内错误帧：`{error:{message,type}}`。
- 失败码映射见 `src/errors.js`：401 → `AUTH` / `ACCOUNT_TOKEN_INVALID`，402 → `QUOTA`，
  429 → `RATE_LIMIT`，5xx → `SERVER`，超时 → `TIMEOUT`，网络 → `TRANSPORT`。
- 重试交给 `dsh-llm-retry`（`providerRetryPolicy` 声明可重试码与退避）。

## 5. 对 DSH 适配器的直接结论

1. 不需要回放 thinking 签名（历史不回传）。
2. 需要持久化的原生块只有 read_link 对（server_tool_use + web_fetch_tool_result + signature）。
3. reminder 挂在 assistant 的 `replayState` 上：
   `{kind:"chatdemo-messages", version:1, model, reminder, readLinks:[...]}`。
4. 图片必须走 Files API `file_id`（demo 从不发 base64）。
5. 服务端工具块在 DSH 的 StreamChunk 里没有对应类型：只取 thinking/text，
   联网过程合并成一个推理块展示，不伪造 tool_calls。
6. 两个开关（深度思考/智能搜索）在 demo 里是每条消息的；DSH 里深度思考由推理强度表达，
   智能搜索由模型变体（`chatdemo-flash` / `chatdemo-flash-nosearch`）表达。
