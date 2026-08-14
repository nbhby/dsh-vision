# dsh-vision

**Give text-only LLMs vision — a persistent, one-click installable plugin for DeepSeek Harness (DSH).**

**让纯文本模型"看图"——DeepSeek Harness（DSH）长期可用、一键安装的识图插件。**

This plugin gives any DSH agent (DeepSeek and other text-only models) image understanding by forwarding images to an external vision model (default preset **`qwen3.8-max`**, DashScope OpenAI-compatible endpoint) and returning plain-text descriptions.

本项目让任意 DSH 智能体（DeepSeek 等纯文本模型）获得识图能力：把图片转发给外部视觉模型（默认预设 **`qwen3.8-max`**，阿里云百炼 OpenAI 兼容接口），返回文字描述。

---

## Credits / 致谢

This project is a migration of [**asuojun/claude-vision-skill**](https://github.com/asuojun/claude-vision-skill) (2k+ ⭐). It follows the same core idea from the original `vision.js` — *image → base64 → OpenAI-compatible vision API → text description* — rewritten as a native DSH plugin with persistent installation, pasted-image support, and the platform's credential seam.

本项目迁移自 [**asuojun/claude-vision-skill**](https://github.com/asuojun/claude-vision-skill)（2k+ ⭐）。核心思路沿用原仓库 `vision.js` 的"图片 → base64 → OpenAI 兼容识图接口 → 文字描述"，重写为 DSH 原生插件，并增加了持久化安装、粘贴图片自动处理、平台凭据服务等能力。**感谢原仓库及作者 asuojun 的思路与实现参考。**

---

## Features / 特性

- **`vision_analyze` tool, global for every session** — analyzes images from a local path, an http(s) URL, a `data:` URL, or a pasted-image attachment reference; works with any text-only model. / 全局 `vision_analyze` 工具：支持本地路径、URL、data URL、粘贴图片附件引用，任何纯文本模型都能用。
- **Pasted images just work** — an `agent/pre-step` listener rewrites pasted-image blocks into analysis hints carrying the attachment ref, so text-only routes (DeepSeek) never crash on image content. Skipped automatically when the routed model already declares image input. / 粘贴图片直接可用：`agent/pre-step` 监听器把图片块改写为带附件引用的分析提示，纯文本路由不再因图片内容报错；路由模型本身支持图片时自动跳过。
- **Persistent & modular** — installs into the DSH store + profile patch, survives restarts, removable with one command. / 持久化、模块化：安装进 DSH store + profile patch，重启不丢，一条命令卸载。
- **No manual key editing** — the API key is stored through the platform credential seam (`DASHSCOPE_API_KEY`: env > `<DSH_HOME>/.credentials.yaml` > `.env`) and resolved per call; rotation needs no restart. / Key 零手动编辑：走平台凭据服务，每次调用实时解析，轮换无需重启。
- **Works with both deployment styles** — npx installs and git-clone installs are both auto-detected. / 兼容两种部署：npx 安装与 git clone 安装都能自动发现并安装。
- **Self-verifying** — the installer runs a module-load check and an optional live API smoke test. / 自验证：安装器带模块加载检查与可选的真实 API 冒烟测试。

---

## One-click install / 一键安装

The installer copies the package, mounts the profile patch row, and writes the API key automatically — no manual YAML editing.

安装器自动完成：复制插件包、挂载 profile 配置行、写入 API Key——无需手动编辑任何 YAML。

### Option A — remote one-liner (any machine with DSH) / 远程一行命令

```powershell
irm https://raw.githubusercontent.com/nbhby/dsh-vision/main/install-vision.ps1 | iex
```

The script prompts for your `DASHSCOPE_API_KEY` (paste it once), downloads the package, installs it, and prints instructions. Restart dsh web afterwards.

脚本会提示输入 `DASHSCOPE_API_KEY`（粘贴一次即可），自动下载插件包并安装。之后重启 dsh web 生效。

### Option B — git clone / 克隆安装

```powershell
git clone https://github.com/nbhby/dsh-vision.git
cd dsh-vision
powershell -NoProfile -ExecutionPolicy Bypass -File install-vision.ps1 -ApiKey sk-ws-你的Key
```

### Option C — local files / 本地文件

Keep `install-vision.ps1` next to the `dsh-vision/` package folder (the repo layout), then:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install-vision.ps1 -ApiKey sk-ws-你的Key   # install
powershell -NoProfile -ExecutionPolicy Bypass -File install-vision.ps1                         # prompts for the key
powershell -NoProfile -ExecutionPolicy Bypass -File install-vision.ps1 -Test                    # + live API smoke test
powershell -NoProfile -ExecutionPolicy Bypass -File install-vision.ps1 -Remove                  # uninstall (keeps the key)
```

Restart dsh web afterwards (close the launcher window, rerun the launcher bat).

完成后重启 dsh web（关闭启动器窗口 → 重新运行启动器）。

---

## Deployment styles / 两种部署方式

| Style / 方式 | Store the package lands in / 安装位置 | Detection / 发现机制 |
|---|---|---|
| **npx** (`%LOCALAPPDATA%\npm-cache\_npx\...`) | `node_modules/@deepseek-ai` inside the npm cache | auto-scan the npm cache / 自动扫描 npm 缓存 |
| **git clone** (dsh cloned anywhere) | `node_modules/@deepseek-ai` inside the clone | ① auto: junction targets in `<DSH_HOME>/profiles/node_modules`; ② auto: `dsh` on PATH; ③ manual: `-DshInstall <clone-root>` |

For a git-clone deployment you may also pass the clone root explicitly:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install-vision.ps1 -ApiKey sk-ws-你的Key -DshInstall D:\code\dsh
```

---

## Configuration / 配置

The mounted profile row in `<DSH_HOME>/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: vision
      name: '@deepseek-ai/dsh-vision'
      config:
        model: qwen3.8-max            # vision model preset / 视觉模型预设
        baseUrl: https://dashscope.aliyuncs.com/compatible-mode/v1   # OpenAI-compatible endpoint
        maxTokens: 2048               # max output tokens
        maxImageBytes: 10485760       # per-image cap (10MB)
        convertPastedImages: true     # rewrite pasted images into analysis hints
        # apiKey: sk-xxx              # optional; prefer the credentials seam
```

API key priority / Key 优先级: `config.apiKey` → env `DASHSCOPE_API_KEY` → `<DSH_HOME>/.credentials.yaml` → project `.env`. Get a key at [https://bailian.console.aliyun.com/](https://bailian.console.aliyun.com/) (free quota for new users). `sk-ws-...` keys from the QwenAI platform work too.

---

## Usage / 使用

Once installed and the key is configured, just send an image:

- **Paste an image** into the chat → the agent automatically calls `vision_analyze` (the image is shown as a hint with its attachment ref; bytes stay in the attachment store). / 聊天框**粘贴图片** → 智能体自动调用 `vision_analyze`。
- Give the agent an **image file path** or an **http(s) URL** / 给智能体**图片路径**或 **URL**。
- Ask explicitly: `用 vision_analyze 看一下 <path>，问它 <question>`.

Tool parameters / 工具参数: `image` (required — path / URL / `data:` URL / attachment-ref JSON), `question` (optional), `model` (optional override).

---

## Architecture / 架构

```
host process (dsh-vision, lib/index.js)
├─ vision_analyze tool → ctx.tools (global)
│    ├─ image sources: fs (local path) | curl (URL, proxy-aware) | attachments.readImage (pasted)
│    └─ request: curl POST {baseUrl}/chat/completions (OpenAI-compatible, base64 data URL)
├─ systemPrompt.section: vision guidance (order 150)
└─ agent/pre-step waterfall: image blocks → text hints (skipped for image-capable routes)
     API key: ctx.credentials.resolve(DASHSCOPE_API_KEY) at call time
```

---

## Verification / 验证

- The installer runs a module-load check automatically. / 安装器自动做模块加载检查。
- `-Test` runs `dsh-vision/test/vision-smoke.mjs`: base64 roundtrip, tool registration, pre-step transform, and a **live API call** (with a valid key it expects a real description). / `-Test` 运行冒烟测试：包含一次真实 API 调用。
- After restart, `vision_analyze` appears in every session's tool list. / 重启后 `vision_analyze` 出现在所有会话的工具列表中。

---

## License / 许可

MIT. See [LICENSE](LICENSE). The original idea comes from [asuojun/claude-vision-skill](https://github.com/asuojun/claude-vision-skill) (MIT).
