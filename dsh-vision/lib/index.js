// ============================================================
//  dsh-vision — HOST half (global, persistent vision plugin)
//  DIY migration of https://github.com/asuojun/claude-vision-skill
//
//  - vision_analyze : analyze an image (local path / http(s) URL /
//    data: URL / pasted-image attachment ref) with an external
//    vision model through an OpenAI-compatible endpoint and return
//    a plain-text description. Default model preset: qwen3.8-max
//    (DashScope compatible-mode).
//  - agent/pre-step : rewrites pasted-image blocks in user messages
//    into text hints that carry the attachment ref, so text-only
//    routes (DeepSeek) never crash on image content. Skipped when
//    the routed model already declares image input.
//  - systemPrompt guidance section: agents learn to call the tool.
//
//  API key resolution: config.apiKey -> credentials seam
//  (DASHSCOPE_API_KEY: env > ~/.dsh/.credentials.yaml > .env).
//
//  Installer: install-vision.ps1 (one-click, see repository README)
//  Repository: github.com/nbhby/dsh-vision
// ============================================================
import { defineTool } from "@deepseek-ai/dsh-tools";
import { credentialRef } from "@deepseek-ai/dsh-credentials";

/** Stable Cordis plugin name. */
const name = "dsh-vision";

/** Services the host half reads as ctx properties (cordis requires declarations). */
const inject = ["subprocess", "fs", "tools"];

const DEFAULT_MODEL = "qwen3.8-max";
const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_QUESTION = "请详细描述这张图片的内容：画面中的物体、人物、文字、场景，以及任何值得注意的细节。";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Encode bytes as standard base64 (no Buffer dependency). */
function toBase64(bytes) {
  let out = "";
  const n = bytes.length;
  let i = 0;
  while (i + 2 < n) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63];
    i += 3;
  }
  if (i < n) {
    const rest = n - i;
    const v = (bytes[i] << 16) | (i + 1 < n ? bytes[i + 1] << 8 : 0);
    out += B64[(v >> 18) & 63] + B64[(v >> 12) & 63];
    if (rest === 2) out += B64[(v >> 6) & 63] + "=";
    else out += "==";
  }
  return out;
}

/** Decode standard base64 into bytes (for data: URLs). */
function fromBase64(text) {
  const clean = String(text).replace(/[^A-Za-z0-9+/=]/g, "");
  const out = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (c === "=") break;
    const v = B64.indexOf(c);
    if (v < 0) continue;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/**
 * Host plugin body: probe the environment (curl, temp dir, proxy),
 * register the vision_analyze tool, add the guidance section, and
 * wire the pasted-image conversion. Async apply is fine: cordis
 * awaits the returned promise.
 */
async function apply(ctx, config) {
  const cfg = config ?? {};
  const subprocess = ctx.subprocess;
  const fs = ctx.fs;
  const credentials = ctx.get("credentials");
  const attachments = ctx.get("attachments");
  const llm = ctx.get("llm");
  const systemPrompt = ctx.get("systemPrompt");

  const modelPreset = typeof cfg.model === "string" && cfg.model.trim().length > 0 ? cfg.model.trim() : DEFAULT_MODEL;
  const baseUrl = typeof cfg.baseUrl === "string" && cfg.baseUrl.trim().length > 0 ? cfg.baseUrl.trim() : DEFAULT_BASE_URL;
  const maxTokens = Number.isFinite(Number(cfg.maxTokens)) && Number(cfg.maxTokens) > 0 ? Math.floor(Number(cfg.maxTokens)) : DEFAULT_MAX_TOKENS;
  const maxImageBytes = Number.isFinite(Number(cfg.maxImageBytes)) && Number(cfg.maxImageBytes) > 0 ? Math.floor(Number(cfg.maxImageBytes)) : DEFAULT_MAX_IMAGE_BYTES;
  const convertPastedImages = cfg.convertPastedImages !== false;

  // ── startup probes (one-time, cached) ──────────────────────────────
  let curlPath = null;
  let tempDir = null;
  let envProxy = null;
  let workspaceCwd = null;

  async function runCollect(argv, opts = {}) {
    const { maxOut = 8 * 1024 * 1024, maxErr = 65536, graceMs = 5000, env, signal, cwd = workspaceCwd, stdinData } = opts;
    const handle = subprocess.spawn({
      argv,
      cwd,
      stdio: {
        stdin: stdinData !== undefined ? { data: stdinData } : "ignore",
        stdout: { maxBytes: 65536, spill: { maxBytes: maxOut } },
        stderr: { maxBytes: maxErr },
      },
      graceMs,
      ...(env ? { env } : {}),
      ...(signal ? { signal } : {}),
    });
    const outcome = await handle.done;
    let stdoutText = "";
    let truncated = false;
    const r = handle.collected.stdout.readFrom(0);
    if (r.lossy && r.spillPath) {
      try {
        const t = await fs.resolve(r.spillPath);
        stdoutText = await fs.readText(t);
      } catch {
        stdoutText = r.text;
        truncated = r.lossy;
      }
    } else {
      stdoutText = r.text;
      truncated = r.lossy;
    }
    const errR = handle.collected.stderr.readFrom(0);
    return { exitCode: outcome.exitCode, signal: outcome.signal, stdout: stdoutText, stderr: errR.text, truncated };
  }

  async function probeEnvironment() {
    try {
      const t = await fs.resolve(".");
      workspaceCwd = fs.processPath(t);
    } catch {
      workspaceCwd = "C:\\Windows";
    }
    try {
      curlPath = await subprocess.resolveExecutable("curl.exe");
    } catch {
      curlPath = "C:\\Windows\\System32\\curl.exe";
    }
    try {
      const out = await runCollect(["cmd.exe", "/d", "/c", "set"]);
      for (const line of String(out.stdout).split(/\r?\n/)) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
        if (!m) continue;
        const key = m[1].toUpperCase();
        const val = m[2];
        if ((key === "TEMP" || key === "TMP") && tempDir === null && val.length > 0) tempDir = val;
        else if ((key === "HTTP_PROXY" || key === "HTTPS_PROXY" || key === "ALL_PROXY") && envProxy === null && /^https?:\/\//i.test(val)) envProxy = val;
      }
    } catch {
      // ignore probe failures
    }
    if (tempDir === null) tempDir = workspaceCwd;
  }

  await probeEnvironment();

  // ── API key ────────────────────────────────────────────────────────
  async function resolveApiKey() {
    if (typeof cfg.apiKey === "string" && cfg.apiKey.trim().length > 0) return cfg.apiKey.trim();
    if (credentials !== undefined) {
      const hit = await credentials.resolve(credentialRef("DASHSCOPE_API_KEY"));
      if (hit !== undefined && typeof hit.value === "string" && hit.value.length > 0) return hit.value;
    }
    throw new Error(
      "vision_analyze: 未配置 API Key。请设置 DASHSCOPE_API_KEY（推荐：写入 ~/.dsh/.credentials.yaml，或设置环境变量 / 项目 .env），" +
      "或在插件 config.apiKey 中配置。获取地址：https://bailian.console.aliyun.com/"
    );
  }

  // ── image loading ──────────────────────────────────────────────────
  function parseDataUrl(raw) {
    const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(raw);
    if (!m || m[2] !== ";base64") throw new Error("vision_analyze: 仅支持 base64 编码的 data: URL");
    const bytes = fromBase64(m[3]);
    if (bytes.length > maxImageBytes) throw new Error("vision_analyze: 图片过大 (" + bytes.length + " 字节, 上限 " + maxImageBytes + ")");
    return { mime: m[1] && m[1].length > 0 ? m[1] : "image/png", bytes };
  }

  async function loadUrl(raw, signal) {
    const outFile = tempDir.replace(/[\\/]+$/, "") + "\\dsh_vision_dl.bin";
    const proxyArg = envProxy;
    const args = [
      curlPath, "-sS", "-L", "--compressed", "--max-redirs", "5",
      "--connect-timeout", "10", "--max-time", "60",
      "--retry", "1", "--retry-delay", "1",
      "-A", UA,
      ...(proxyArg ? ["--proxy", proxyArg] : []),
      "-w", "\n__VISION_META__%{http_code}|%{content_type}|%{url_effective}",
      "-o", outFile,
      raw,
    ];
    const res = await runCollect(args, { maxOut: 65536, maxErr: 65536, signal });
    if (res.exitCode !== 0) throw new Error("vision_analyze: 图片下载失败 (curl exit " + res.exitCode + "): " + (res.stderr || "").slice(0, 300));
    let contentType = "";
    let finalUrl = raw;
    const stdout = String(res.stdout || "");
    const lastLine = stdout.split("\n").filter((l) => l.length > 0).pop() || "";
    if (lastLine.startsWith("__VISION_META__")) {
      const parts = lastLine.slice("__VISION_META__".length).split("|");
      contentType = (parts[1] || "").trim();
      finalUrl = parts.slice(2).join("|") || raw;
    }
    let target;
    try {
      target = await fs.resolve(outFile);
    } catch {
      throw new Error("vision_analyze: 无法访问下载文件: " + outFile);
    }
    const st = await fs.stat(target);
    if (!st) throw new Error("vision_analyze: 图片下载失败（无输出文件）");
    if (st.size > maxImageBytes) throw new Error("vision_analyze: 图片过大 (" + st.size + " 字节, 上限 " + maxImageBytes + ")");
    const bytes = await fs.readBytes(target, signal, st.size);
    const cm = /^image\/(png|jpeg|jpg|webp|gif|bmp)/i.exec(contentType);
    let mime = cm ? "image/" + (cm[1] === "jpg" ? "jpeg" : cm[1].toLowerCase()) : null;
    if (mime === null) {
      const ext = ("." + finalUrl.split(/[?#]/)[0].split(".").pop()).toLowerCase();
      mime = MIME_BY_EXT[ext] || "image/jpeg";
    }
    return { mime, bytes };
  }

  async function loadAttachment(ref, signal) {
    if (attachments === undefined) throw new Error("vision_analyze: 附件服务不可用，无法读取粘贴的图片");
    if (ref.bytes > maxImageBytes) throw new Error("vision_analyze: 图片过大 (" + ref.bytes + " 字节, 上限 " + maxImageBytes + ")");
    const { data } = await attachments.readImage(ref, signal);
    return { mime: typeof ref.mediaType === "string" && ref.mediaType.length > 0 ? ref.mediaType : "image/png", bytes: data };
  }

  async function loadPath(raw, signal) {
    const target = await fs.resolve(raw);
    const st = await fs.stat(target);
    if (!st) throw new Error("vision_analyze: 文件不存在: " + raw);
    if (st.size > maxImageBytes) throw new Error("vision_analyze: 图片过大 (" + st.size + " 字节, 上限 " + maxImageBytes + ")");
    const bytes = await fs.readBytes(target, signal, st.size);
    const ext = ("." + raw.split(/[\\/]/).pop().split(".").pop()).toLowerCase();
    return { mime: MIME_BY_EXT[ext] || "image/jpeg", bytes };
  }

  async function loadImageSource(image, signal) {
    const raw = String(image ?? "").trim();
    if (raw.length === 0) throw new Error("vision_analyze: image 参数为空");
    if (raw.startsWith("data:")) return parseDataUrl(raw);
    if (/^https?:\/\//i.test(raw)) return loadUrl(raw, signal);
    try {
      const parsed = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && typeof parsed.attachmentId === "string") {
        return loadAttachment(parsed, signal);
      }
    } catch {
      // not JSON — treat as a file path
    }
    return loadPath(raw, signal);
  }

  // ── vision API call ────────────────────────────────────────────────
  async function callVision(model, dataUrl, question, apiKey, signal) {
    const endpoint = baseUrl.replace(/\/+$/, "") + "/chat/completions";
    const body = JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: dataUrl } },
            { type: "text", text: question },
          ],
        },
      ],
      max_tokens: maxTokens,
      stream: false,
    });
    const args = [
      curlPath, "-sS", "--max-time", "100",
      "--retry", "1", "--retry-delay", "1", "--retry-connrefused",
      "--noproxy", "*",
      "-H", "Authorization: Bearer " + apiKey,
      "-H", "Content-Type: application/json",
      "-A", UA,
      "-w", "\n__VISION_META__%{http_code}",
      "--data-binary", "@-",
      endpoint,
    ];
    const res = await runCollect(args, { maxOut: 8 * 1024 * 1024, maxErr: 65536, stdinData: body, signal });
    if (res.exitCode !== 0) {
      throw new Error("vision_analyze: 请求失败 (curl exit " + res.exitCode + "): " + (res.stderr || "").slice(0, 300));
    }
    const stdout = String(res.stdout || "");
    const lines = stdout.split("\n").filter((l) => l.length > 0);
    const lastLine = lines.length > 0 ? lines[lines.length - 1] : "";
    let status = 0;
    let jsonText = stdout;
    const metaIdx = stdout.lastIndexOf("\n__VISION_META__");
    if (metaIdx >= 0) jsonText = stdout.slice(0, metaIdx);
    else if (lastLine.startsWith("__VISION_META__")) jsonText = stdout.slice(0, stdout.lastIndexOf(lastLine));
    if (lastLine.startsWith("__VISION_META__")) status = parseInt(lastLine.slice("__VISION_META__".length), 10) || 0;
    if (status >= 400) {
      throw new Error("vision_analyze: API " + status + ": " + jsonText.trim().slice(0, 300));
    }
    let content = jsonText.trim();
    try {
      const parsed = JSON.parse(jsonText);
      const c = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message && parsed.choices[0].message.content;
      if (typeof c === "string" && c.length > 0) content = c;
    } catch {
      // non-JSON body — keep raw text
    }
    if (content.length === 0) throw new Error("vision_analyze: 模型返回了空结果");
    if (content.length > 200000) content = content.slice(0, 200000) + "\n…(truncated)";
    return content;
  }

  // ── tool registration ──────────────────────────────────────────────
  const visionTool = defineTool({
    name: "vision_analyze",
    description: "Analyze an image with an external vision model (default preset: qwen3.8-max via DashScope compatible-mode) and return its plain-text description. Use this whenever an image is involved — a pasted image (attachment-reference JSON), a local file path, or an http(s) URL — because the current chat model has no vision. Works with any text-only model.",
    parameters: {
      image: {
        type: "string",
        required: true,
        description: "The image to analyze: a file path (resolved by the filesystem backend), an http(s) URL, a data: URL, or an attachment-reference JSON object such as {\"attachmentId\":\"sha256:...\",\"mediaType\":\"image/png\",\"bytes\":123,\"width\":640,\"height\":480} (exactly what pasted images carry).",
      },
      question: {
        type: "string",
        description: "Optional question about the image. Omit for a general detailed description.",
      },
      model: {
        type: "string",
        description: "Optional vision model override (default: configured preset, qwen3.8-max).",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          model: { type: "string", required: true },
          description: { type: "string", required: true },
          question: { type: "string" },
          source: { type: "string" },
        },
      },
      render(args, value) {
        const lines = ["vision_analyze (" + value.model + ")"];
        if (value.question) lines.push("问题: " + value.question);
        lines.push(value.description);
        lines.push("来源: " + value.source);
        return [{ type: "text", text: lines.join("\n\n") }];
      },
    },
    timeoutMs: 180000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const image = String(args.image || "").trim();
      if (image.length === 0) throw new Error("image must be a non-empty string");
      const model = typeof args.model === "string" && args.model.trim().length > 0 ? args.model.trim() : modelPreset;
      const question = typeof args.question === "string" && args.question.trim().length > 0 ? args.question.trim() : DEFAULT_QUESTION;
      const apiKey = await resolveApiKey();
      logFirstUse(model);
      const { mime, bytes } = await loadImageSource(image, exec.signal);
      const dataUrl = "data:" + mime + ";base64," + toBase64(bytes);
      const description = await callVision(model, dataUrl, question, apiKey, exec.signal);
      return { model, description, question, source: image };
    },
  });

  ctx.tools.register(visionTool);

  // ── guidance section (global, host layer) ──────────────────────────
  if (systemPrompt !== undefined) {
    systemPrompt.section({
      name: "vision:guidance",
      order: 150,
      text: "识图：当前模型不能直接读取图片。当用户粘贴图片、提供图片路径或图片 URL、或要求看图/识图/描述图片时，调用 vision_analyze 工具（image 参数传图片路径、URL，或粘贴图片附带的附件引用 JSON），用返回的文字描述回答用户。默认视觉模型预设为 qwen3.8-max。",
    });
  }

  // ── pasted-image conversion (text-only routes) ─────────────────────
  function toHintText(ref) {
    const slim = { attachmentId: ref.attachmentId, mediaType: ref.mediaType, bytes: ref.bytes };
    if (typeof ref.width === "number") slim.width = ref.width;
    if (typeof ref.height === "number") slim.height = ref.height;
    if (typeof ref.name === "string" && ref.name.length > 0) slim.name = ref.name;
    const label = typeof ref.name === "string" && ref.name.length > 0 ? '"' + ref.name + '"' : "一张图片";
    return "[用户粘贴了" + label + "（" + (ref.mediaType || "image") + "，" + (ref.bytes ?? "?") + " 字节）。当前模型不能直接查看图片，请调用 vision_analyze 工具，并把 image 参数设置为这个附件引用 JSON：" + JSON.stringify(slim) + "]";
  }

  function transformUserMessages(messages) {
    let changed = false;
    const out = [];
    for (const message of messages) {
      if (message === null || typeof message !== "object" || message.role !== "user" || !Array.isArray(message.content)) {
        out.push(message);
        continue;
      }
      const content = message.content;
      const hasImage = content.some(
        (block) => block !== null && typeof block === "object" && block.type === "image" && block.attachment !== undefined
      );
      if (!hasImage) {
        out.push(message);
        continue;
      }
      changed = true;
      const nextContent = [];
      for (const block of content) {
        if (block !== null && typeof block === "object" && block.type === "image" && block.attachment !== undefined) {
          nextContent.push({ type: "text", text: toHintText(block.attachment) });
        } else {
          nextContent.push(block);
        }
      }
      out.push({ ...message, content: nextContent });
    }
    return changed ? out : null;
  }

  async function routeAcceptsImages(agent, signal) {
    if (llm === undefined) return false;
    let provider;
    let model;
    try {
      const header = agent.session.requestHeader();
      const routed = header && header.config;
      provider = (routed && routed.provider) ?? agent.options?.provider;
      model = (routed && routed.model) ?? agent.options?.model;
    } catch {
      return false;
    }
    if (!provider || !model) return false;
    try {
      const info = await llm.resolveModelInfo(provider, model, signal);
      return Array.isArray(info && info.inputModalities) && info.inputModalities.includes("image");
    } catch {
      return false;
    }
  }

  if (convertPastedImages) {
    ctx.on("agent/pre-step", async ({ agent, messages, step, signal }, next) => {
      const decision = await next();
      if (decision === undefined || decision.kind !== "enter") return decision;
      try {
        if (await routeAcceptsImages(agent, signal)) return decision;
        const transformed = transformUserMessages(decision.messages);
        if (transformed === null) return decision;
        return { kind: "enter", messages: transformed };
      } catch (error) {
        if (ctx.logger && ctx.logger.warn) ctx.logger.warn("[vision] pre-step transform skipped: " + ((error && error.message) || String(error)));
        return decision;
      }
    });
  }

  // ── startup log ────────────────────────────────────────────────────
  // The credentials seam may not be ready when this plugin activates
  // (activation order is dependency-driven, credentials is optional
  // here), so the key state is reported lazily on first tool use
  // instead of at apply time — same pattern as dsh-llm-deepseek.
  let firstUseLogged = false;
  function logFirstUse(model, apiKeySource) {
    if (firstUseLogged) return;
    firstUseLogged = true;
    console.log("[vision] first use OK: model=" + model + " key=" + (apiKeySource ? apiKeySource : "configured"));
  }

  console.log("[vision] ready: model=" + modelPreset + " base=" + baseUrl + " convertPastedImages=" + convertPastedImages + " (key resolved on first use)");
}

export { apply, inject, name };
