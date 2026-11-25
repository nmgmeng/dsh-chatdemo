# dsh-chatdemo

在 DeepSeek Harness（DSH）里，用 **chat-demo 的请求形状**聊天。

不是换一个界面，而是换一份请求：把 DeepSeek 官方开源前端
[chat-demo](https://github.com/deepseek-ai/chat-demo) 发给服务端的那份 body
（一句话 system、`safety_check`、服务端 `deepseek_web_search` / `deepseek_read_url`、
不发 `max_tokens` / `temperature` / `output_config`）原样搬进 DSH 的会话里。
输出仍然长在 DSH 自己的会话、历史、导出与搜索里。

| | 本插件 | 面板类插件（如 chat-in-dsh） | 纯提示词预设 |
|---|---|---|---|
| 界面 | DSH 原生会话 | 独立面板 / 自己的会话列表 | DSH 原生会话 |
| 请求 | **与 chat-demo 同一份 wire** | chat-demo 前端 + 代理 | DSH 内置适配器 + 提示词 |
| 联网 | 服务端搜索，带引用 | 服务端搜索（前端里） | 客户端工具 |
| 工具 | 无（纯聊天） | 无 | 保留部分工具 |
| 凭据 | DSH 登录态或 API key 引用 | DSH 账户 | 任意 |

## 安装

装之前确认 DSH 版本在支持范围内（`dsh >= 0.2.2-rc.1 < 0.3.0`）。

**方式 A：插件页**

左侧「插件」→「添加插件」→ 填包名 `dsh-chatdemo-preset` → 安装 → 立即启用。

**方式 B：命令行**

```bash
dsh plugin --profile desktop add dsh-chatdemo-preset   # Desktop
dsh plugin --profile web add dsh-chatdemo-preset       # Web
```

> 如果你以前装过本地的 `@local/dsh-chatdemo-provider` / `@local/dsh-chatdemo-preset`，
> 先卸载它们再装本包——两者都声明 preset id `chatdemo`，同时存在会因重复 id 加载失败。
> 旧会话日志不受影响。

## 凭据

插件**不保存任何密钥**，也不要求你填任何 key；每次请求现取：

1. **DSH 已登录的账户**（OAuth，推荐）：直接复用登录态，请求走 `x-dsh-auth-token`。
2. **DSH 凭据库里的 API key**：沿用 DSH 官方 DeepSeek 路由的同一个凭据引用
   `DEEPSEEK_API_KEY`。插件不会读取任何 `.env` 文件，也不会把 key 写进任何文件。

两者都没有时，首轮会明确报「没有可用的 DEEPSEEK_API_KEY 凭据」，并提示两条出路。
账户登录失效（401）时插件会通知 DSH 清除失效令牌，下一次登录后自动恢复。

## 使用

1. 新建会话，预设选 **「ChatDemo 语气」**；
2. 模型会**自动选中** `ChatDemo 1:1`，不用再手选；
3. 正常提问即可。

两个模型变体就是两个开关：

| 模型 | 深度思考 | 智能搜索 |
|---|---|---|
| `ChatDemo 1:1` | 由推理强度选（开启/关闭） | 开 |
| `ChatDemo 1:1（不联网）` | 同上 | 关（不声明 `deepseek_web_search`） |

搜索过程会以 `[联网] 搜索：…` 的形式合并成一段，出现在「思考」折叠面板里；
正文里的 `[reference:N]` 引用标记保留，便于对照来源。

**模型自动选择**的范围：新建会话且预设为 ChatDemo；或在首轮之前把会话切到该预设。
切换到其它预设时，插件会把模型**恢复**成进入前的那个（没有记忆时回退到 DSH 的
部署默认模型），不会把会话永久留在 1:1 路由上。恢复旧会话、或你之后手动换过模型，
都不会被覆盖。

## 适合谁

- 网页版被限额后转到 DSH，但仍想要 chat-demo 那种一句话人设、服务端搜索和引用的人；
- 需要“纯聊天”而不是 agent 的人：角色扮演、陪伴聊天、写作、答疑；
- 手机端装 DSH Go 的用户：插件是普通 DSH bundle，装在引擎所在设备即可；
- 已经在 DSH 登录 DeepSeek 的用户：装完即用，不需要再单独申请 API key。

## 在手机上（DSH Go）

插件装在 DSH 引擎所在的位置——电脑上的 Host，或 DSH Go 的本机引擎。装好后
打开会话、选「ChatDemo 语气」，模型会自己切过去；不需要额外的移动端清单或配置。

## 请求差异（为什么叫 1:1）

| 项 | chat-demo / 本插件 | DSH 内置适配器 |
|---|---|---|
| system | 只有 `该助手为DeepSeek，由深度求索公司创造。` | 系统提示 + 工具目录 + 运行时上下文 |
| `max_tokens` / `temperature` | **不发** | 固定发送 |
| `output_config` | **不发** | 发送推理强度 |
| 工具 | 服务端 `deepseek_web_search` / `deepseek_read_url` | 客户端工具 |
| 安全审查 | `safety_check: high` | 无 |
| 时间提醒 | `latest_reminder` 五段式 | 无 |
| 历史回放 | 只回正文 + read_link，思考不回传 | 回放思考与工具调用 |

完整的 wire 契约（字段、回放规则、错误与签名）见 [docs/SPEC.md](docs/SPEC.md)。

## 限制（请先读）

- **纯聊天，没有工具**：不能读写文件、跑命令、用 MCP。要干活请切回普通预设。
- **附件只支持图片**：DSH 把 `@` 文件投影成路径文本，而本模式没有工具读取；
  发文件会被明确拒绝，不静默失败。
- **`refusal` 无法撤回**：服务端判定拒绝时，已经流式显示的文字收不回来，
  只能按正常结束收尾（DSH 流协议没有撤回操作）。
- **reminder 语言固定中文、地点留空**：与 chat-demo 的 zh-CN 默认一致；
  英文首页下这两段仍是中文。
- **会话标题**由 DSH 自己的标题插件生成，与网页版的标题生成不同。
- **图片压缩**依赖 Electron 的 `nativeImage`：Web profile 下会跳过压缩直接上传，
  极大图片可能被 Files API 拒绝。

## 隐私

- 请求只发往 `https://api.deepseek.com`；插件不含遥测、不写日志文件、不落盘对话。
- 令牌每次请求现取，不进日志、不进错误信息、不写入配置。
- 错误信息只含状态码与上游返回的 `error.message`，不含请求体。
- 卸载插件即可完全移除；不留下配置或凭据。

非官方项目，与 DeepSeek 无隶属关系。使用你自己的账户/额度。

## 兼容性

- 最低版本：DSH `0.2.2-rc.1`；开发与实测环境为 `0.2.2-rc.3`，两者的扩展点一致。
- `engines.dsh` 限定 `>=0.2.2-rc.1 <0.3.0`；每个新 RC 会先跑单测与打包守卫再发版。
- 只依赖 DSH 自带的扩展点（`ctx.llm.registerAdapter`、`agent.model`、预设子插件），
  不修改 profile、不依赖任何第三方运行时库。

## 卸载

```bash
# 插件页点卸载，或
dsh plugin --profile desktop remove dsh-chatdemo-preset
```

## 开发

```bash
npm test          # 单测（离线，无密钥）
npm run check     # node --check 全部源码
npm run pack:check  # 检查将要发布的内容
```

本地冒烟需要真实凭据，只从环境变量读取，不读文件：

```bash
# Windows PowerShell
$env:DEEPSEEK_API_KEY = '...'
node dev/smoke.mjs
```

冒烟脚本不随包发布（`files` 白名单外）。

## License

MIT。行为契约来自 MIT 许可的 chat-demo 公开源码，实现独立完成；
见 [NOTICE](NOTICE) 与 [LICENSE](LICENSE)。
