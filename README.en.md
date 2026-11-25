# dsh-chatdemo

Chat inside DeepSeek Harness (DSH) with the **request shape of DeepSeek's
open-source chat-demo**: one-line system prompt, `safety_check`, server-side
`deepseek_web_search` / `deepseek_read_url`, and no `max_tokens` /
`temperature` / `output_config`. Answers stay in your normal DSH sessions.

This is not a UI panel: it is a provider plus a preset. If you want the
chat-demo interface instead, use a panel plugin such as chat-in-dsh.

## Install

Requires DSH `>= 0.2.2-rc.1 < 0.3.0`.

```bash
dsh plugin --profile desktop add dsh-chatdemo-preset
# or: Plugins -> Add plugin -> dsh-chatdemo-preset
```

If an older local build (`@local/dsh-chatdemo-provider` / `-preset`) is
installed, remove it first: both declare preset id `chatdemo`.

## Credentials

No secret is stored by this plugin, and there is nothing to configure. Each
request resolves, in order:

1. your signed-in DSH account (OAuth, `x-dsh-auth-token`), or
2. the `DEEPSEEK_API_KEY` credential reference shared with DSH's official route.

A 401 in account mode tells DSH to clear the stale grant.

## Use

1. New session → preset **ChatDemo 语气**.
2. The model is selected automatically (`ChatDemo 1:1`).
3. Chat.

`ChatDemo 1:1` enables server-side search; `ChatDemo 1:1（不联网）` disables
`deepseek_web_search`. Deep thinking follows the reasoning-effort control.

Switching back to another preset restores the model you had before (or DSH's
deployment default when there is no memory); a session never stays on the 1:1
route by accident.

## Who it is for

- people who moved to DSH after web limits but still want chat-demo's one-line
  persona, server-side search and citations;
- chat-first use rather than agent work: role-play, companion chat, writing, Q&A;
- phones: install the plugin on the DSH host (or on-device engine) and use it
  through DSH Go;
- anyone already signed in to DeepSeek in DSH: install and chat, no separate
  API key.

## On a phone (DSH Go)

The plugin is a normal DSH bundle, so place it where the DSH engine runs — the
desktop host, or the on-device engine in DSH Go. Then open the session, choose
the ChatDemo preset and the model switches by itself. No extra mobile-only
manifest is needed.

## Limits

- Chat only: no client tools, no files (images only).
- A `refusal` cannot be retracted once streamed.
- Reminder text stays zh-CN with an empty location.
- Session titles come from DSH's own title plugin.

## Privacy

Requests go only to `https://api.deepseek.com`. No telemetry, no files written,
tokens resolved per request and never logged.

Unofficial; not affiliated with DeepSeek.

Wire contract: [docs/SPEC.md](docs/SPEC.md). License: MIT, see [NOTICE](NOTICE).
