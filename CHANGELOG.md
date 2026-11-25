# Changelog

## 0.1.1 — 2026-11-25

兼容性下限下调，无代码、wire 契约或行为变化。

- `engines.dsh` 由 `>=0.2.2-rc.3` 改为 `>=0.2.2-rc.1`：本插件用到的扩展点
  （`ctx.llm.registerAdapter`、`agent.model`、`agentPresets.presetForSession`、
  `ctx.tools.restrict`、`ctx.systemPrompt.context`、预设子插件）在 rc.1 与 rc.3
  上的签名一致，DSH 的 v0.2.2-rc.1 升级说明里也没有涉及这些面的破坏性变更。
  开发与实测仍在 `0.2.2-rc.3` 上完成，未在 rc.1 运行时做过冒烟。

## 0.1.0 — 2026-11-25

首个可发布版本。

- 新增 `chatdemo` provider：注册 `chatdemo-flash` 与 `chatdemo-flash-nosearch`
  两个模型，按 chat-demo 的 wire 形状发请求（一句话 system、`safety_check`、
  服务端搜索工具、`latest_reminder`、不发 `max_tokens`/`temperature`/`output_config`）。
- 新增「ChatDemo 语气」预设（id `chatdemo`）：清空客户端工具、只保留一句话身份；
  模型由插件自动选中，不再需要手选；切回其它预设时恢复进入前的模型
  （没有记忆时回退到 DSH 部署默认模型）。
- 自动选择不依赖单一事件：`agent/created`、`agent-preset/selected`、会话事件
  与 1.5 秒低频扫描共同兜底；首轮之后不再改用户手选。
- 凭据复用：DSH 账户登录态（`x-dsh-auth-token`，401 时清除失效登录）或
  `DEEPSEEK_API_KEY` 凭据引用；插件不保存密钥。
- 失败码对齐 DSH 的 `LLM_FAILURE_CODES`：401/402/429/5xx/超时/网络分别映射为
  `AUTH`（账户为 `ACCOUNT_TOKEN_INVALID`）、`QUOTA`、`RATE_LIMIT`、`SERVER`、
  `TIMEOUT`、`TRANSPORT`；重试交给 `dsh-llm-retry`。
- SSE 空闲超时（默认 300 秒，可配）、图片上传超时、取消信号贯穿请求与上传。
- 图片：Files API 上传 + 长边 4096 压缩（Electron 环境）。
- 打包：单包三行插件、中英 locale、图标、详情页、SPEC、CI 与打包守卫。
- npm 包名为 `dsh-chatdemo-preset`：`dsh-chatdemo` 与既有第三方包 `dsh-chat-demo`
  过于相似，被 npm 的防混淆机制拒绝；安装命令因此为
  `dsh plugin add dsh-chatdemo-preset`。GitHub 仓库名仍为 `dsh-chatdemo`。
- 已知限制：无客户端工具；附件只支持图片；`refusal` 无法撤回；reminder 固定 zh-CN。
