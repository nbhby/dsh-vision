// ============================================================
//  vision-smoke.mjs - dsh-vision self test (distributable)
//  Mounts lib/index.js against mock services and validates:
//    1. module exports shape (apply / inject / name)
//    2. vision_analyze tool registration
//    3. base64 decode/re-encode roundtrip (real 1x1 PNG)
//    4. real OpenAI-compatible API call via curl:
//         - with a real key (env DASHSCOPE_API_KEY): expects a
//           non-empty description (live smoke test)
//         - with the default invalid key: expects an HTTP error
//    5. agent/pre-step pasted-image -> text hint transform
//  Usage: node vision-smoke.mjs            (offline path check)
//         $env:DASHSCOPE_API_KEY=sk-...; node vision-smoke.mjs
//  Exit code 0 = all checks passed.
// ============================================================
import { execFile } from "node:child_process";

const MODULE = new URL("../lib/index.js", import.meta.url).href;
const TEST_KEY = process.env.DASHSCOPE_API_KEY || "";
const LIVE = TEST_KEY.length > 0 && TEST_KEY !== "sk-invalid-test-key";
const INVALID_KEY_MODE = TEST_KEY === "sk-invalid-test-key";

// qwen3.8-max rejects images with a dimension <= 10px, so the API test
// uses a real 32x32 PNG (solid red) instead of a 1x1.
const PNG_32x32 = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAySURBVFhH7c4hAQAACMAw4tA/D13AEwDMxM3VojL7s9jjOgAAAAAAAAAAAAAAAAAAgAEXEqx5FXLUvQAAAABJRU5ErkJggg==";

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? "PASS " : "FAIL ") + label + (detail ? "  -> " + detail : ""));
  if (!ok) failures++;
}

async function main() {
  const mod = await import(MODULE);
  check("module exports", Array.isArray(mod.inject) && typeof mod.apply === "function" && typeof mod.name === "string", mod.name);

  let registered = null;
  let preStepListener = null;

  function spawnMock(spec) {
    const result = new Promise((resolve, reject) => {
      const child = execFile(
        spec.argv[0],
        spec.argv.slice(1),
        { cwd: spec.cwd, env: spec.env, maxBuffer: 64 * 1024 * 1024 },
        (error, stdout, stderr) => {
          resolve({ exitCode: error ? (error.code ?? 1) : 0, signal: null, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        }
      );
      if (spec.stdio && spec.stdio.stdin && spec.stdio.stdin.data !== undefined) {
        child.stdin.end(spec.stdio.stdin.data);
      } else {
        child.stdin.end();
      }
    });
    let out = "";
    let err = "";
    return {
      done: result.then((r) => { out = r.stdout; err = r.stderr; return r; }),
      collected: {
        stdout: { readFrom: () => ({ text: out, lossy: false }) },
        stderr: { readFrom: () => ({ text: err, lossy: false }) },
      },
    };
  }

  const llmMock = {
    async resolveModelInfo(provider) {
      // mirrors the real deepseek adapter (provider id "deepseek-official")
      if (provider === "deepseek-official" || provider === "deepseek") return { provider, id: "deepseek-v4-flash", name: "DeepSeek", inputModalities: ["text"] };
      if (provider === "pi-ai") return { provider, id: "img-model", name: "Pi", inputModalities: ["text", "image"] };
      return { provider, id: "?", name: "?" };
    },
  };

  const ctx = {
    subprocess: {
      async resolveExecutable() { return "C:\\Windows\\System32\\curl.exe"; },
      spawn(spec) { return spawnMock(spec); },
    },
    fs: {
      async resolve(p) { return p; },
      processPath(p) { return p; },
      async stat() { return { size: 67 }; },
      async readBytes() { return new Uint8Array(0); },
      async readText() { return ""; },
    },
    tools: { register(tool) { registered = tool; } },
    on(name, listener) { if (name === "agent/pre-step") preStepListener = listener; },
    get(name) {
      if (name === "credentials") return { resolve: async () => ({ value: TEST_KEY }) };
      if (name === "llm") return llmMock;
      return undefined;
    },
    effect() {},
    logger: { warn() {} },
  };

  await mod.apply(ctx, {
    model: process.env.DSH_VISION_MODEL || "qwen3.8-max",
    baseUrl: process.env.DSH_VISION_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1",
  });
  check("apply() + tool registration", registered !== null && registered.name === "vision_analyze", registered && registered.name);

  // ---- admission bridge: deepseek now advertises image input ----
  const infoDeepseek = await ctx.get("llm").resolveModelInfo("deepseek-official", "deepseek-v4-flash");
  const infoDeepseekLegacy = await ctx.get("llm").resolveModelInfo("deepseek", "deepseek-chat");
  const infoPi = await ctx.get("llm").resolveModelInfo("pi-ai", "img-model");
  check(
    "admission bridge advertises image for deepseek-official",
    Array.isArray(infoDeepseek.inputModalities) && infoDeepseek.inputModalities.includes("image"),
    infoDeepseek.inputModalities && infoDeepseek.inputModalities.join(",")
  );
  check(
    "admission bridge covers legacy deepseek provider id",
    Array.isArray(infoDeepseekLegacy.inputModalities) && infoDeepseekLegacy.inputModalities.includes("image"),
    infoDeepseekLegacy.inputModalities && infoDeepseekLegacy.inputModalities.join(",")
  );
  check("other providers unchanged", Array.isArray(infoPi.inputModalities) && infoPi.inputModalities.includes("image") && infoPi.inputModalities.length === 2, infoPi.inputModalities && infoPi.inputModalities.join(","));

  // ---- 3+4. real API call ----
  const dataUrl = "data:image/png;base64," + PNG_32x32;
  let outcome;
  try {
    const result = await registered.execute({ image: dataUrl, question: "What is in this image? Answer in one short sentence." }, { signal: new AbortController().signal });
    outcome = { ok: true, value: result };
  } catch (error) {
    outcome = { ok: false, message: error.message };
  }
  if (LIVE) {
    check("live API call returns a description", outcome.ok && typeof outcome.value.description === "string" && outcome.value.description.length > 0, outcome.ok ? ("model=" + outcome.value.model + " desc=" + outcome.value.description.slice(0, 80)) : outcome.message);
  } else if (INVALID_KEY_MODE) {
    check("invalid key produces an HTTP error", !outcome.ok && /API \d{3}/.test(outcome.message), outcome.message);
  } else {
    check("unconfigured key produces a clear config error", !outcome.ok && /API Key/.test(outcome.message), outcome.message);
  }

  // ---- 5. pre-step transform ----
  if (preStepListener === null) {
    check("pre-step listener registered", false);
  } else {
    const messages = [
      { id: "m1", role: "user", content: [{ type: "text", text: "look at this" }] },
      {
        id: "m2",
        role: "user",
        content: [
          { type: "text", text: "text above" },
          { type: "image", attachment: { attachmentId: "sha256:abc123", mediaType: "image/png", bytes: 5, width: 640, height: 480, name: "shot.png" } },
        ],
      },
    ];
    const decision = await preStepListener(
      { agent: { session: { requestHeader: () => undefined }, options: { provider: "deepseek-official", model: "deepseek-v4-flash" } }, messages, step: 1, signal: new AbortController().signal },
      async () => ({ kind: "enter", messages })
    );
    const blocks = decision.messages[1].content;
    const ok = decision.kind === "enter" && blocks.length === 2 && blocks[1].type === "text" && blocks[1].text.includes("vision_analyze") && blocks[1].text.includes("sha256:abc123");
    check("pre-step transform", ok, ok ? blocks[1].text.slice(0, 80) + "..." : JSON.stringify(blocks).slice(0, 160));

    // deepseek must convert even though the bridge advertises image input
    const messages2 = [
      {
        id: "m3",
        role: "user",
        content: [
          { type: "text", text: "text" },
          {
            type: "tool-result",
            callId: "call1",
            content: [
              { type: "text", text: "envelope" },
              { type: "image", attachment: { attachmentId: "sha256:def456", mediaType: "image/jpeg", bytes: 9, width: 100, height: 100 } },
            ],
          },
        ],
      },
    ];
    const decision2 = await preStepListener(
      { agent: { session: { requestHeader: () => undefined }, options: { provider: "deepseek-official", model: "deepseek-v4-flash" } }, messages: messages2, step: 2, signal: new AbortController().signal },
      async () => ({ kind: "enter", messages: messages2 })
    );
    const blocks2 = decision2.messages[0].content;
    const nestedOk = blocks2[1].type === "tool-result" && Array.isArray(blocks2[1].content) && blocks2[1].content[1].type === "text" && blocks2[1].content[1].text.includes("vision_analyze") && blocks2[1].content[1].text.includes("sha256:def456");
    check("deepseek tool-result nested image converted", nestedOk, nestedOk ? blocks2[1].content[1].text.slice(0, 80) + "..." : JSON.stringify(blocks2).slice(0, 160));

    // an image-capable route (pi-ai) keeps native image blocks
    const messages3 = [
      {
        id: "m4",
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", attachment: { attachmentId: "sha256:ghi789", mediaType: "image/png", bytes: 5, width: 640, height: 480 } },
        ],
      },
    ];
    const decision3 = await preStepListener(
      { agent: { session: { requestHeader: () => undefined }, options: { provider: "pi-ai", model: "img-model" } }, messages: messages3, step: 1, signal: new AbortController().signal },
      async () => ({ kind: "enter", messages: messages3 })
    );
    const blocks3 = decision3.messages[0].content;
    const piOk = blocks3.length === 2 && blocks3[1].type === "image";
    check("image-capable route (pi-ai) keeps images", piOk, piOk ? "image block preserved" : JSON.stringify(blocks3).slice(0, 160));
  }

  console.log(failures === 0 ? "vision-smoke: ALL CHECKS PASSED" : "vision-smoke: " + failures + " CHECK(S) FAILED");
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("vision-smoke: FATAL " + e);
  process.exit(1);
});
