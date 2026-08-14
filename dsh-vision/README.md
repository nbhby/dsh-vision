# dsh-vision — DSH 识图插件（vision_analyze）

把 [claude-vision-skill](https://github.com/asuojun/claude-vision-skill) 迁移为 DeepSeek Harness 的**长期可用、随重启保留、可模块化安装**的全局插件：让 DeepSeek 这类没有视觉能力的模型也能"看图"。

- **vision_analyze 工具**：把图片（本地路径 / http(s) URL / data URL / 聊天里粘贴的图片附件）发给外部视觉模型（默认预设 **`qwen3.8-max`**，阿里云百炼 OpenAI 兼容接口），返回文字描述。对所有会话全局可用。
- **粘贴图片自动处理**：在聊天框直接粘贴图片时，`agent/pre-step` 会把图片块改写为"请用 vision_analyze 分析"的文字提示（携带附件引用），**避免纯文本模型因图片内容报错**；若当前路由的模型本身支持图片输入（`inputModalities` 含 `image`），则不做改写。
- **系统提示引导**：全局注册一条识图指引段，让智能体知道该调用 `vision_analyze`。
- **API Key 走凭据服务**：`ctx.credentials` 解析 `DASHSCOPE_API_KEY`（环境变量 > `~/.dsh/.credentials.yaml` > 启动目录 `.env` > `~/.dsh/.env`），配置不落盘密钥。

## 安装 / 卸载（一键，无需手动配 Key）

```powershell
# 一键安装：自动复制插件、挂载配置行、写入 API Key 到凭据文件
powershell -NoProfile -ExecutionPolicy Bypass -File install-vision.ps1 -ApiKey sk-ws-你的Key

# 不带 -ApiKey 时：自动读环境变量 DASHSCOPE_API_KEY → 已有凭据 → 交互式提示输入
powershell -NoProfile -ExecutionPolicy Bypass -File install-vision.ps1

# 安装后立即做真实 API 冒烟测试（1x1 图片 → qwen3.8-max）
powershell -NoProfile -ExecutionPolicy Bypass -File install-vision.ps1 -ApiKey sk-ws-你的Key -Test

# 卸载（保留 Key）
powershell -NoProfile -ExecutionPolicy Bypass -File install-vision.ps1 -Remove
```

脚本会自动完成三件事，**用户不需要手动编辑任何 YAML 文件**：

1. 把 `dsh-vision` 包复制到所有 DSH 的 `node_modules/@deepseek-ai` 存储；
2. 在 `<DSH_HOME>/profiles/web/cordis.patch.yml` 挂载一行（`id: vision`，含模型预设 `qwen3.8-max`）；
3. 把 API Key 写入 `<DSH_HOME>/.credentials.yaml`（`DASHSCOPE_API_KEY`，仅追加/替换该行，保留其它凭据；若环境变量已设置则不再写文件）。

### 两种部署方式都支持

| 部署方式 | 插件安装位置 | 发现方式 |
|---|---|---|
| **npx**（`%LOCALAPPDATA%\npm-cache\_npx\...`） | npx 缓存里的 `node_modules/@deepseek-ai` | 自动扫描 npm 缓存 |
| **git clone**（任意目录克隆的 dsh 源码树） | clone 目录下的 `node_modules/@deepseek-ai` | ① 自动：通过 `<DSH_HOME>/profiles/node_modules` 里的 junction 目标反查安装根；② 自动：PATH 上的 `dsh` 命令向上溯源；③ 手动：`-DshInstall <clone根目录>` |

git clone 部署示例：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File install-vision.ps1 -ApiKey sk-ws-你的Key -DshInstall D:\code\dsh
```

之后重启 dsh web 即生效。其它可选参数：`-Model`、`-BaseUrl`、`-DshHome`（默认 `$env:DSH_HOME` 或 `~/.dsh`）、`-Profile`（默认 `web`）、`-PatchFile`、`-SkipKey`。卸载即删除包与配置行（`-Remove`），可随时重装；Key 保留。

## 配置

### 1. API Key（必填）

任选其一（推荐前两种）：

- 环境变量：启动 dsh 前 `set DASHSCOPE_API_KEY=sk-xxx`
- 凭据文件：在 `~/.dsh/.credentials.yaml` 里写一行（格式为严格的 `引用: 值` 映射）：
  ```yaml
  DASHSCOPE_API_KEY: sk-xxx
  ```
- 插件配置 `config.apiKey`（见下）

获取 Key：https://bailian.console.aliyun.com/ （新用户有免费额度）。改配置后**无需重启**，每次调用都会重新解析。

### 2. 模型预设与其它（可选）

编辑 `~/.dsh/profiles/web/cordis.patch.yml` 中的 `vision` 行：

```yaml
- insert:
    - id: vision
      name: '@deepseek-ai/dsh-vision'
      config:
        model: qwen3.8-max            # 视觉模型预设（默认 qwen3.8-max）
        baseUrl: https://dashscope.aliyuncs.com/compatible-mode/v1   # OpenAI 兼容地址
        maxTokens: 2048               # 单次回答最大 token
        maxImageBytes: 10485760       # 单张图片上限（10MB）
        convertPastedImages: true     # 粘贴图片自动改写为分析提示
        # apiKey: sk-xxx              # 可选：不推荐，密钥请走凭据服务
```

改完重启 dsh web 生效。

## 使用

安装并配置好 Key 后，直接发图片或提"帮我看看这张图"即可：

- 聊天框**粘贴图片** → 智能体自动调用 `vision_analyze` 分析（会话中图片会以文字提示显示，原图保存在附件库，可通过提示里的附件引用 JSON 分析）。
- 给智能体**图片文件路径**（如 `C:\Users\me\Pictures\a.png`）或 **http(s) URL**。
- 也可以手动要求：`用 vision_analyze 看一下 <路径>，问它 <问题>`。

工具参数：`image`（必填，路径 / URL / data URL / 附件引用 JSON）、`question`（可选提问）、`model`（可选覆盖预设）。

## 架构

```
host 进程（dsh-vision, lib/index.js）
├─ vision_analyze 工具 → ctx.tools（全局）
│    ├─ 图片解析：fs（本地路径）| curl（URL，走代理）| attachments.readImage（粘贴附件）
│    └─ 请求：curl POST {baseUrl}/chat/completions（OpenAI 兼容，qwen3.8-max，base64 data URL）
├─ systemPrompt.section：识图引导段（order 150）
└─ agent/pre-step waterfall：图片块 → 文字提示（路由支持图片时跳过）
     API Key：ctx.credentials.resolve(DASHSCOPE_API_KEY)
```

## 验证

1. 重启后，在任意会话的工具列表里应能看到 `vision_analyze`。
2. 发一张图片或给一个图片路径，AI 应调用 `vision_analyze` 并给出描述。
3. 未配置 Key 时工具会返回明确的中文错误提示（含获取地址）。

## 已知边界

- 粘贴的图片在会话历史中显示为文字提示（含附件引用），不再显示缩略图——这是纯文本路由下避免请求报错的取舍；图片字节本身仍持久保存在附件库。
- 视频、音频暂不支持（`qwen3.8-max` 支持视频，后续可扩展 `vision_analyze_video`）。
- 如果某个会话换用了支持图片的模型（如 pi-ai 图像模型），`agent/pre-step` 会自动跳过改写，图片按原生方式处理。
