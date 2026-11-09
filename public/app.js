// NVIDIA 免费模型探活台 前端逻辑。
// 同时作为 ES module 被测试导入：所有 DOM 初始化收敛在 IS_BROWSER 判断之后。

const IS_BROWSER = typeof window !== "undefined" && typeof document !== "undefined";

const FALLBACK_MODELS = [
  "deepseek-ai/deepseek-coder-6.7b-instruct",
  "deepseek-ai/deepseek-v4-flash",
  "deepseek-ai/deepseek-v4-pro",
  "google/gemma-2-2b-it",
  "google/gemma-3-4b-it",
  "google/gemma-3-12b-it",
  "google/gemma-3n-e2b-it",
  "google/gemma-3n-e4b-it",
  "google/gemma-4-31b-it",
  "ibm/granite-3.0-3b-a800m-instruct",
  "ibm/granite-3.0-8b-instruct",
  "meta/llama-3.1-8b-instruct",
  "meta/llama-3.1-70b-instruct",
  "meta/llama-3.2-1b-instruct",
  "meta/llama-3.2-3b-instruct",
  "meta/llama-3.2-11b-vision-instruct",
  "meta/llama-3.2-90b-vision-instruct",
  "meta/llama-3.3-70b-instruct",
  "meta/llama-4-maverick-17b-128e-instruct",
  "microsoft/phi-3.5-moe-instruct",
  "mistralai/mistral-7b-instruct-v0.3",
  "mistralai/mistral-large",
  "mistralai/mistral-large-2-instruct",
  "mistralai/mistral-medium-3.5-128b",
  "mistralai/mistral-nemotron",
  "mistralai/mistral-small-4-119b-2603",
  "moonshotai/kimi-k2.6",
  "nvidia/llama-3.1-nemotron-51b-instruct",
  "nvidia/llama-3.1-nemotron-70b-instruct",
  "nvidia/llama-3.3-nemotron-super-49b-v1",
  "nvidia/llama-3.3-nemotron-super-49b-v1.5",
  "nvidia/nemotron-4-340b-instruct",
  "nvidia/nemotron-mini-4b-instruct",
  "nvidia/nvidia-nemotron-nano-9b-v2",
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
  "qwen/qwen3-next-80b-a3b-instruct",
  "qwen/qwen3.5-122b-a10b",
  "qwen/qwen3.5-397b-a17b",
  "stepfun-ai/step-3.5-flash",
  "stepfun-ai/step-3.7-flash",
  "z-ai/glm-5.2",
  "baai/bge-m3",
  "nvidia/embed-qa-4",
  "nvidia/llama-3.2-nv-embedqa-1b-v1",
  "nvidia/llama-nemotron-embed-1b-v2",
  "nvidia/llama-nemotron-embed-vl-1b-v2",
  "nvidia/nemotron-3-embed-1b",
  "nvidia/nv-embed-v1",
  "nvidia/nv-embedcode-7b-v1",
  "nvidia/nv-embedqa-e5-v5",
  "nvidia/nv-embedqa-mistral-7b-v2",
].map((id) => ({ id, owned_by: id.split("/")[0], source: "fallback" }));

const presetModels = [
  "deepseek-ai/deepseek-v4-flash",
  "z-ai/glm-5.2",
  "meta/llama-3.1-8b-instruct",
  "meta/llama-3.3-70b-instruct",
  "qwen/qwen3-next-80b-a3b-instruct",
  "mistralai/mistral-nemotron",
  "nvidia/llama-3.1-nemotron-70b-instruct",
  "openai/gpt-oss-20b",
  "baai/bge-m3",
  "nvidia/nv-embed-v1",
];

const STORAGE_KEYS = {
  history: "nvidia-model-probe-history-v2",
  legacyHistory: "nvidia-model-probe-history-v1",
  settings: "nvidia-model-probe-settings-v1",
  models: "nvidia-model-probe-models-v1",
};

const MAX_HISTORY_SESSIONS = 5;
const MODELS_CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000;

const BASELINE_HEALTH_CHECKS = [
  { model: "meta/llama-3.1-8b-instruct", message: "2026-07-19 的旧记录：当时测通。模型可能已退役，以实际测试为准。", source: "baseline" },
  { model: "z-ai/glm-5.2", message: "2026-07-19 的旧记录：当时测通。模型可能已退役，以实际测试为准。", source: "baseline" },
  { model: "nvidia/nv-embed-v1", message: "2026-07-19 的旧记录：当时测通。模型可能已退役，以实际测试为准。", source: "baseline" },
];

const HTTP_HINTS = {
  401: "API Key 无效",
  402: "账户额度不足",
  403: "没有该模型的访问权限",
  404: "模型不存在或已下线",
  408: "上游请求超时",
  410: "模型已退役（end of life），需在 build.nvidia.com 换新模型",
  429: "触发限流",
  500: "服务端错误",
  502: "上游网关错误",
  503: "服务暂不可用",
  504: "上游超时",
};

// 探测结果状态。limited/queue 不算失败——NVIDIA 免费层的排队和限流是常态，
// 把它们和真实故障混在一起正是"探活结果忽准忽不准"的主要来源。
const STATUS_META = {
  ok: { label: "可用", cls: "ok" },
  limited: { label: "限流/排队", cls: "limited" },
  fail: { label: "失败", cls: "fail" },
  skip: { label: "跳过", cls: "skip" },
};

const RETRYABLE_HTTP_STATUSES = new Set([500, 502, 503, 504]);
const MAX_PROBE_ATTEMPTS = 3;
const RETRY_BASE_MS = 1200;
const RATE_LIMIT_BASE_MS = 3000;
const OPENAI_BASE_URL = "https://integrate.api.nvidia.com/v1";

const state = {
  models: [],
  selected: new Set(),
  results: [],
  resultsFilter: "all",
  modelSource: "none",
  healthChecks: BASELINE_HEALTH_CHECKS,
  historySessions: [],
  activeHistoryId: null,
  serverHasKey: false,
  requiresToken: false,
  running: false,
  runController: null,
};

let refs = null;

/* ================= 工具函数 ================= */

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function formatMs(ms) {
  if (ms == null) return "—";
  if (ms >= 10000) return `${Math.round(ms / 1000)}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function formatDateTime(isoString) {
  const date = new Date(isoString);
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function clipText(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const MODEL_CATEGORIES = {
  chat: { label: "聊天 / 推理", rank: 10 },
  code: { label: "代码", rank: 20 },
  vision: { label: "视觉", rank: 30 },
  embedding: { label: "向量", rank: 40 },
  rerank: { label: "重排", rank: 50 },
  safety: { label: "安全", rank: 60 },
  audio: { label: "语音 / 音频", rank: 70 },
  image: { label: "图像生成", rank: 80 },
  other: { label: "其他", rank: 90 },
};

function classifyModel(modelId) {
  const value = String(modelId).toLowerCase();
  const matches = (terms) => terms.some((term) => value.includes(term));
  const categories = [];
  const add = (key) => { if (!categories.includes(key)) categories.push(key); };
  if (matches(["rerank", "reranker", "rankqa"])) add("rerank");
  if (matches(["guard", "safety", "shield", "moderation", "content-safety", "nemoguard", "prompt-guard"])) add("safety");
  if (matches(["embed", "embedding", "retrieval", "e5-", "bge-", "nv-qa"])) add("embedding");
  if (matches(["vision", "-vl", "/vl", "kosmos", "fuyu", "neva", "vila", "deplot", "ocr"])) add("vision");
  if (matches(["code", "coder", "starcoder", "codestral", "codegemma", "codellama", "devstral"])) add("code");
  if (matches(["audio", "speech", "whisper", "parakeet", "canary", "tts", "asr"])) add("audio");
  if (matches(["diffusion", "stable-diffusion", "flux", "imagen", "image-generation"])) add("image");
  const primary = categories[0] || "chat";
  if (!["embedding", "rerank", "audio", "image"].includes(primary)) add("chat");
  return { primary, categories, ...MODEL_CATEGORIES[primary] };
}

function categoryLabel(key) {
  return MODEL_CATEGORIES[key]?.label || MODEL_CATEGORIES.other.label;
}

function compareModels(a, b) {
  const categoryDelta = classifyModel(a.id).rank - classifyModel(b.id).rank;
  return categoryDelta || (a.owned_by || "").localeCompare(b.owned_by || "") || a.id.localeCompare(b.id);
}

function getModelEndpoints(model) {
  const raw = model.supported_endpoints || model.supportedEndpoints || model.supported_apis || model.supportedApis;
  return Array.isArray(raw) ? raw.map((item) => String(item).toLowerCase()) : null;
}

// 决定用哪个接口探测、还是根本不该探测。名字猜接口经常出错，
// 所以在线目录里的 supported_endpoints 优先于名字启发式。
function pickProbeStrategy(model) {
  const fallbackCategory = classifyModel(model.id).primary;
  const endpoints = getModelEndpoints(model);
  if (endpoints) {
    if (endpoints.some((item) => item.includes("embed"))) return { kind: "embedding", capability: fallbackCategory === "embedding" ? "embedding" : "embedding" };
    if (endpoints.some((item) => item.includes("chat") || item.includes("completion") || item.includes("vision"))) {
      return { kind: "chat", capability: fallbackCategory };
    }
    return {
      kind: "skip",
      capability: fallbackCategory,
      message: `该模型只暴露 ${endpoints.join(" / ")} 接口，本工具只代理 chat 与 embeddings，无法据此判断可用性`,
    };
  }
  if (["rerank", "audio", "image"].includes(fallbackCategory)) {
    return {
      kind: "skip",
      capability: fallbackCategory,
      message: `${categoryLabel(fallbackCategory)}类模型不走 chat/embeddings 接口，已跳过（不代表模型不可用）`,
    };
  }
  return { kind: fallbackCategory === "embedding" ? "embedding" : "chat", capability: fallbackCategory };
}

function summarizeUpstreamError(status, text) {
  const parsed = safeJsonParse(text, null);
  const detail =
    parsed?.detail ||
    parsed?.error?.message ||
    (typeof parsed?.error === "string" ? parsed.error : "") ||
    parsed?.message ||
    parsed?.title ||
    "";
  let hint = HTTP_HINTS[status] ? `（${HTTP_HINTS[status]}）` : "";
  if (status === 403 && /authorization failed/i.test(detail)) {
    hint = "（Key 无推理权限，或免费额度已用尽，可到 build.nvidia.com 重新生成 Key）";
  }
  const short = clipText(detail || text || "", 220);
  return `HTTP ${status}${hint}${short ? "：" + short : ""}`;
}

class ProbeError extends Error {
  constructor(message, { status, kind = "http", detail = "" } = {}) {
    super(message);
    this.name = "ProbeError";
    this.status = status;
    this.kind = kind; // http | retryable-http | rate-limit | no-content | truncated | timeout | abort | upstream-stream-error
    this.detail = detail;
  }
}

const QUEUE_PATTERN = /queue|busy|loading|not ready|upstream|冷启动|排队/i;

// 把 ProbeError 归类成界面状态：真实失败 vs 限流/排队（结果不可信）。
function classifyProbeError(error) {
  const kind = error?.kind;
  const text = String(error?.detail || error?.message || "");
  const queueish = QUEUE_PATTERN.test(text);

  if (kind === "rate-limit") {
    return { status: "limited", reason: queueish ? "queue" : "rate_limit", message: error.message };
  }
  if ((kind === "retryable-http" || kind === "upstream-stream-error") && queueish) {
    return { status: "limited", reason: "queue", message: error.message };
  }
  if (kind === "no-content") {
    return {
      status: "fail",
      reason: "empty",
      message: "HTTP 200 但多次均无内容返回——模型很可能在排队加载或已停止服务，建议稍后重试",
    };
  }
  if (kind === "truncated") {
    return { status: "fail", reason: "network", message: "流式响应未正常结束（连接中断或超时截断）" };
  }
  if (kind === "timeout") {
    return { status: "fail", reason: "timeout", message: error.message };
  }
  if (kind === "abort") {
    return { status: "fail", reason: "aborted", message: "已手动中止" };
  }
  const status = error?.status;
  if (status === 401 || status === 402 || status === 403) {
    return { status: "fail", reason: "auth", message: error.message };
  }
  if (status === 404 || status === 410) {
    return { status: "fail", reason: "gone", message: error.message };
  }
  if (status === 408) {
    return { status: "fail", reason: "timeout", message: error.message };
  }
  if (kind === "retryable-http" || (typeof status === "number" && status >= 500)) {
    return { status: "fail", reason: "server", message: error.message };
  }
  if (kind === "upstream-stream-error") {
    return { status: "fail", reason: "upstream", message: error.message };
  }
  return { status: "fail", reason: "other", message: error?.message || "未知错误" };
}

function makeRequestSignal(runSignal, timeoutMs) {
  const controller = new AbortController();
  const onRunAbort = () => controller.abort(new ProbeError("已手动中止", { kind: "abort" }));
  const timer = setTimeout(
    () => controller.abort(new ProbeError(`请求超时（>${Math.round(timeoutMs / 1000)} 秒）`, { kind: "timeout" })),
    timeoutMs,
  );
  if (runSignal) {
    if (runSignal.aborted) onRunAbort();
    else runSignal.addEventListener("abort", onRunAbort, { once: true });
  }
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer);
      runSignal?.removeEventListener("abort", onRunAbort);
    },
  };
}

function throwIfAborted(runSignal) {
  if (!runSignal?.aborted) return;
  const reason = runSignal.reason;
  if (reason instanceof ProbeError) throw reason;
  throw new ProbeError("已手动中止", { kind: "abort" });
}

function abortableSleep(ms, runSignal, sleep) {
  const wait = sleep ?? ((duration) => new Promise((resolve) => setTimeout(resolve, duration)));
  return new Promise((resolve, reject) => {
    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
      reject(runSignal.reason instanceof ProbeError ? runSignal.reason : new ProbeError("已手动中止", { kind: "abort" }));
    };
    runSignal?.addEventListener("abort", onAbort, { once: true });
    wait(ms).then(() => {
      if (!cancelled) resolve();
    });
  });
}

function errorStatusOf(value, fallback) {
  const code = Number(value);
  return Number.isInteger(code) && code >= 100 && code <= 599 ? code : fallback;
}

function kindForStatus(status) {
  if (status === 429) return "rate-limit";
  if (RETRYABLE_HTTP_STATUSES.has(status)) return "retryable-http";
  return "http";
}

/* ================= 探测核心（可测试，纯依赖注入） ================= */

async function requestChat(apiKey, model, prompt, timeoutMs, runSignal, stream, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? (() => performance.now());
  const { signal, done } = makeRequestSignal(runSignal, timeoutMs);
  const startedAt = now();
  const body = JSON.stringify({
    apiKey,
    model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 32,
    temperature: 0,
    stream,
  });

  try {
    const response = await fetchImpl("/api/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ProbeError(summarizeUpstreamError(response.status, text), {
        status: response.status,
        kind: kindForStatus(response.status),
        detail: text,
      });
    }

    const contentType = response.headers?.get?.("content-type") || "";
    // 有些模型收到 stream:true 仍返回 JSON（可能是错误，也可能干脆不支持流式）。
    if (stream && contentType.includes("application/json")) {
      return await readNonStreaming(response, now, startedAt);
    }

    if (!stream) {
      return await readNonStreaming(response, now, startedAt);
    }

    if (!response.body) throw new ProbeError("响应缺少流式内容", { kind: "truncated" });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let reasoning = "";
    let ttftMs = null;
    let sawDone = false;
    let sawContentDelta = false;

    while (true) {
      const { done: readDone, value } = await reader.read();
      if (readDone) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        if (line.startsWith("event:")) {
          if (/error/i.test(line.slice(6))) {
            throw new ProbeError("流式响应携带 error 事件", { kind: "upstream-stream-error" });
          }
          continue;
        }
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === "[DONE]") {
          sawDone = true;
          continue;
        }
        if (ttftMs === null) ttftMs = Math.round(now() - startedAt);
        const chunk = safeJsonParse(data, null);
        if (!chunk) {
          if (/error/i.test(data)) throw new ProbeError(`流式错误：${clipText(data, 160)}`, { kind: "upstream-stream-error" });
          continue;
        }
        if (chunk.error) {
          const errStatus = errorStatusOf(chunk.error.code ?? chunk.error.status, 0);
          throw new ProbeError(`流内错误 HTTP ${errStatus || "?"}：${clipText(chunk.error.message || chunk.error.type || "", 200)}`, {
            status: errStatus || undefined,
            kind: errStatus ? kindForStatus(errStatus) : "upstream-stream-error",
            detail: JSON.stringify(chunk.error),
          });
        }
        const choice = chunk.choices?.[0];
        const delta = choice?.delta || choice?.message;
        if (typeof delta?.content === "string" && delta.content) {
          content += delta.content;
          sawContentDelta = true;
        }
        if (typeof delta?.reasoning_content === "string" && delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          sawContentDelta = true;
        }
      }
    }

    if (!sawContentDelta) {
      // 关键修复：HTTP 200 + 空流以前会被当成"可用"。NVIDIA 排队/未部署时正是这个表现。
      throw new ProbeError("空流式响应", { status: 200, kind: sawDone ? "no-content" : "truncated" });
    }

    return { content: content || reasoning, ttftMs: ttftMs ?? Math.round(now() - startedAt), elapsedMs: Math.round(now() - startedAt) };
  } finally {
    done();
  }
}

async function readNonStreaming(response, now, startedAt) {
  const text = await response.text();
  const payload = safeJsonParse(text, null);
  if (payload?.error) {
    const errStatus = errorStatusOf(payload.error.code ?? payload.error.status, 0);
    throw new ProbeError(`HTTP ${errStatus || "?"}：${clipText(payload.error.message || "", 200)}`, {
      status: errStatus || undefined,
      kind: errStatus ? kindForStatus(errStatus) : "http",
      detail: JSON.stringify(payload.error),
    });
  }
  const message = payload?.choices?.[0]?.message;
  const content = message?.content || message?.reasoning_content || "";
  if (!content) {
    throw new ProbeError("响应没有可用内容", { status: 200, kind: "no-content" });
  }
  const elapsedMs = Math.round(now() - startedAt);
  return { content, ttftMs: elapsedMs, elapsedMs };
}

async function probeChat(apiKey, model, prompt, timeoutMs, runSignal, deps = {}) {
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_PROBE_ATTEMPTS; attempt += 1) {
    throwIfAborted(runSignal);
    try {
      return await requestChat(apiKey, model, prompt, timeoutMs, runSignal, true, deps);
    } catch (error) {
      if (error?.kind === "abort" || error?.kind === "timeout") throw error;
      lastError = error;

      // 400 常见原因是模型不支持 stream，直接转非流式，不必反复重试。
      if (error?.status === 400 && error?.kind !== "no-content") {
        try {
          return await requestChat(apiKey, model, prompt, timeoutMs, runSignal, false, deps);
        } catch (fallbackError) {
          // 非流式的证据更贴近模型真实状态。
          throw fallbackError;
        }
      }

      const retryable = ["retryable-http", "rate-limit", "no-content", "truncated"].includes(error?.kind);
      if (!retryable || attempt === MAX_PROBE_ATTEMPTS) {
        if (error?.kind === "http") throw error;
        if (!retryable) throw error;
        break; // 重试用尽，最后再试一次非流式
      }

      const base = error.kind === "rate-limit" ? RATE_LIMIT_BASE_MS : RETRY_BASE_MS;
      const waitMs = base * 2 ** (attempt - 1) + Math.floor(Math.random() * 300);
      await abortableSleep(waitMs, runSignal, sleep);
    }
  }

  throwIfAborted(runSignal);
  try {
    return await requestChat(apiKey, model, prompt, timeoutMs, runSignal, false, deps);
  } catch (error) {
    if (error?.kind === "abort" || error?.kind === "timeout") throw error;
    // 非流式失败时保留流式最后一次的判断依据（多为限流/空返回）。
    throw lastError?.kind && error?.kind === "no-content" && lastError.kind !== "no-content" ? lastError : error;
  }
}

async function probeEmbedding(apiKey, model, prompt, timeoutMs, runSignal, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? (() => performance.now());
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_PROBE_ATTEMPTS; attempt += 1) {
    throwIfAborted(runSignal);
    const { signal, done } = makeRequestSignal(runSignal, timeoutMs);
    const startedAt = now();
    try {
      const response = await fetchImpl("/api/embeddings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey, model, input: [prompt], encoding_format: "float" }),
        signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new ProbeError(summarizeUpstreamError(response.status, text), {
          status: response.status,
          kind: kindForStatus(response.status),
          detail: text,
        });
      }
      const payload = safeJsonParse(text, null);
      if (payload?.error) {
        const errStatus = errorStatusOf(payload.error.code, response.status);
        throw new ProbeError(`HTTP ${errStatus}：${clipText(payload.error.message || "", 200)}`, {
          status: errStatus,
          kind: kindForStatus(errStatus),
          detail: JSON.stringify(payload.error),
        });
      }
      const first = payload?.data?.[0]?.embedding;
      if (!Array.isArray(first) || first.length === 0) {
        throw new ProbeError("embedding 返回为空", { status: 200, kind: "no-content" });
      }
      return {
        content: `embedding 维度: ${first.length}`,
        ttftMs: null,
        elapsedMs: Math.round(now() - startedAt),
      };
    } catch (error) {
      if (error?.kind === "abort" || error?.kind === "timeout") throw error;
      lastError = error;
      const retryable = ["retryable-http", "rate-limit", "no-content"].includes(error?.kind);
      if (!retryable) throw error;
      if (attempt < MAX_PROBE_ATTEMPTS) {
        const base = error.kind === "rate-limit" ? RATE_LIMIT_BASE_MS : RETRY_BASE_MS;
        await abortableSleep(base * 2 ** (attempt - 1), runSignal, sleep);
      }
    } finally {
      done();
    }
  }
  throw lastError;
}

async function testModel(model, { apiKey, prompt, timeoutMs, runSignal }, deps = {}) {
  const now = deps.now ?? (() => performance.now());
  const startedAt = now();
  const strategy = pickProbeStrategy(model);
  const base = {
    model: model.id,
    capability: strategy.capability,
    elapsedMs: 0,
    ttftMs: null,
    response: "",
  };

  if (strategy.kind === "skip") {
    return { ...base, status: "skip", reason: "unsupported", message: strategy.message, elapsedMs: 0 };
  }

  try {
    const result =
      strategy.kind === "embedding"
        ? await probeEmbedding(apiKey, model.id, prompt, timeoutMs, runSignal, deps)
        : await probeChat(apiKey, model.id, prompt, timeoutMs, runSignal, deps);
    return {
      ...base,
      status: "ok",
      reason: null,
      elapsedMs: result.elapsedMs,
      ttftMs: result.ttftMs,
      message: "请求成功",
      response: result.content,
    };
  } catch (error) {
    const classified = classifyProbeError(error);
    return {
      ...base,
      status: classified.status,
      reason: classified.reason,
      elapsedMs: Math.round(now() - startedAt),
      message: classified.message,
    };
  }
}

/* ================= 复制/下载 ================= */

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const succeeded = document.execCommand("copy");
    area.remove();
    return succeeded;
  }
}

function downloadJson(data, filename = `nvidia-model-test-${Date.now()}.json`) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/* ================= 设置持久化 ================= */

function loadSettings() {
  const raw = safeJsonParse(localStorage.getItem(STORAGE_KEYS.settings) || "{}", {});
  if (typeof raw.apiKey === "string") refs.apiKeyInput.value = raw.apiKey;
  if (typeof raw.token === "string") refs.tokenInput.value = raw.token;
  if (raw.concurrency) refs.concurrencyInput.value = String(raw.concurrency);
  if (raw.timeout) refs.timeoutInput.value = String(raw.timeout);
  if (typeof raw.prompt === "string" && raw.prompt) refs.promptInput.value = raw.prompt;
  if (typeof raw.capability === "string" && raw.capability) refs.capabilitySelect.value = raw.capability;
}

function persistSettings() {
  localStorage.setItem(
    STORAGE_KEYS.settings,
    JSON.stringify({
      apiKey: refs.apiKeyInput.value,
      token: refs.tokenInput.value,
      concurrency: refs.concurrencyInput.value,
      timeout: refs.timeoutInput.value,
      prompt: refs.promptInput.value,
      capability: refs.capabilitySelect.value,
    }),
  );
}

/* ================= 模型列表缓存（比硬编码快照新） ================= */

function saveModelCache(models) {
  try {
    localStorage.setItem(
      STORAGE_KEYS.models,
      JSON.stringify({
        savedAt: new Date().toISOString(),
        models: models.map((model) => ({
          id: model.id,
          owned_by: model.owned_by,
          supported_endpoints: model.supported_endpoints,
          description: clipText(model.description || "", 200) || undefined,
        })),
      }),
    );
    return true;
  } catch {
    return false;
  }
}

function loadModelCache() {
  const parsed = safeJsonParse(localStorage.getItem(STORAGE_KEYS.models) || "null", null);
  if (!parsed || !Array.isArray(parsed.models) || !parsed.models.length) return null;
  const age = Date.now() - new Date(parsed.savedAt || 0).getTime();
  if (!Number.isFinite(age) || age > MODELS_CACHE_TTL_MS) return null;
  return parsed;
}

/* ================= 服务端信息 ================= */

async function loadServerInfo() {
  try {
    const response = await fetch(getApiPath("/health"));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const info = await response.json();
    state.serverHasKey = Boolean(info.hasServerKey);
    state.requiresToken = Boolean(info.requiresToken);
  } catch {
    state.serverHasKey = false;
    state.requiresToken = false;
  }
  renderServerInfo();
  // 服务端配了 Key 就自动同步，省掉"先点同步再点测试"这一步。
  if (state.serverHasKey && refs.loadModelsBtn && !refs.loadModelsBtn.disabled) {
    refs.loadModelsBtn.click();
  }
}

function renderServerInfo() {
  const pill = refs.serverKeyPill;
  if (state.serverHasKey) {
    pill.textContent = "服务端已配置 Key";
    pill.className = "pill live";
  } else {
    pill.textContent = "未配置服务端 Key，请在下方填写";
    pill.className = "pill warn";
  }
  refs.keyOptionalNote.textContent = state.serverHasKey ? "（可选）" : "（必填）";
  refs.apiKeyInput.placeholder = state.serverHasKey ? "留空则使用服务端配置的 Key" : "nvapi-…";
  refs.tokenField.classList.toggle("hidden", !state.requiresToken);
}

function getApiPath(path) {
  return `/api${path}`;
}

/* ================= 历史记录（v2：带 status/reason） ================= */

function migrateLegacySessions() {
  const legacy = safeJsonParse(localStorage.getItem(STORAGE_KEYS.legacyHistory) || "[]", []);
  if (!Array.isArray(legacy) || !legacy.length) return [];
  localStorage.removeItem(STORAGE_KEYS.legacyHistory);
  return legacy.slice(0, MAX_HISTORY_SESSIONS).map((session) => ({
    ...session,
    version: 2,
    results: (session.results || []).map((item) => ({
      ...item,
      status: item.status || (item.ok ? "ok" : "fail"),
      reason: item.reason || (item.ok ? null : "other"),
    })),
  }));
}

function getActiveHistorySession() {
  return (
    state.historySessions.find((session) => session.id === state.activeHistoryId) ||
    state.historySessions[0] ||
    null
  );
}

function getLatestModelResult(modelId) {
  const inCurrentRun = state.results.find((item) => item.model === modelId);
  if (inCurrentRun) return inCurrentRun;
  const latestSession = state.historySessions[0];
  if (!latestSession) return null;
  const result = latestSession.results.find((item) => item.model === modelId);
  if (!result) return null;
  return { ...result, testedAt: latestSession.createdAt };
}

function loadHistorySessions() {
  const parsed = safeJsonParse(localStorage.getItem(STORAGE_KEYS.history) || "[]", []);
  let sessions = Array.isArray(parsed) ? parsed.slice(0, MAX_HISTORY_SESSIONS) : [];
  if (!sessions.length) sessions = migrateLegacySessions();
  state.historySessions = sessions;
  state.activeHistoryId = sessions[0]?.id || null;
}

function persistHistorySessions() {
  localStorage.setItem(
    STORAGE_KEYS.history,
    JSON.stringify(state.historySessions.slice(0, MAX_HISTORY_SESSIONS)),
  );
}

function countByStatus(results) {
  const counts = { ok: 0, limited: 0, fail: 0, skip: 0 };
  results.forEach((item) => {
    if (counts[item.status] !== undefined) counts[item.status] += 1;
  });
  return counts;
}

function updateHealthChecksFromHistory() {
  const latestSession = state.historySessions[0];
  if (!latestSession) {
    state.healthChecks = BASELINE_HEALTH_CHECKS.map((item) => ({ ...item }));
    return;
  }
  state.healthChecks = latestSession.results
    .filter((item) => item.status === "ok")
    .map((item) => ({
      model: item.model,
      source: "test",
      message: `${formatDateTime(latestSession.createdAt)} 实测可用 · ${
        item.ttftMs != null && item.capability === "chat" ? `首字 ${formatMs(item.ttftMs)} · ` : ""
      }总耗时 ${formatMs(item.elapsedMs)} · 回复「${clipText(item.response, 60)}」`,
    }));
}

function saveHistorySession(results, selectedModels) {
  const counts = countByStatus(results);
  const session = {
    version: 2,
    id: `session-${Date.now()}`,
    createdAt: new Date().toISOString(),
    selectedModels,
    total: results.length,
    okCount: counts.ok,
    limitedCount: counts.limited,
    failCount: counts.fail,
    skipCount: counts.skip,
    results,
  };
  state.historySessions = [session, ...state.historySessions].slice(0, MAX_HISTORY_SESSIONS);
  state.activeHistoryId = session.id;
  persistHistorySessions();
  updateHealthChecksFromHistory();
  renderHealthChecks();
  renderHistory();
}

function clearHistorySessions() {
  state.historySessions = [];
  state.activeHistoryId = null;
  localStorage.removeItem(STORAGE_KEYS.history);
  localStorage.removeItem(STORAGE_KEYS.legacyHistory);
  updateHealthChecksFromHistory();
  renderHealthChecks();
  renderHistory();
  renderModels();
}

/* ================= 渲染 ================= */

function setStatus(message, mode = "idle") {
  refs.statusBar.textContent = message;
  refs.statusBar.className = `status-bar ${mode}`;
}

function setProgress(fraction) {
  if (fraction == null) {
    refs.progressBar.classList.remove("active");
    refs.progressFill.style.width = "0%";
    return;
  }
  refs.progressBar.classList.add("active");
  refs.progressFill.style.width = `${Math.min(100, Math.max(0, fraction * 100))}%`;
}

function updateStats() {
  refs.totalModelsStat.textContent = String(state.models.length);
  refs.selectedModelsStat.textContent = String(state.selected.size);
  const counts = countByStatus(state.results);
  refs.okModelsStat.textContent = String(counts.ok);
  refs.failModelsStat.textContent = String(counts.fail);
}

function renderServerBadge() {
  const badge = refs.modelSourceBadge;
  if (state.modelSource === "live") {
    badge.textContent = "online";
    badge.className = "badge live";
    refs.modelSourceText.textContent = "来源：NVIDIA 在线模型列表";
  } else if (state.modelSource === "cached") {
    const cache = safeJsonParse(localStorage.getItem(STORAGE_KEYS.models) || "null", null);
    badge.textContent = "cached";
    badge.className = "badge live";
    refs.modelSourceText.textContent = `来源：${cache?.savedAt ? formatDateTime(cache.savedAt) : "上次"}同步的本地缓存，点「同步」刷新`;
  } else {
    badge.textContent = "snapshot";
    badge.className = "badge fallback";
    refs.modelSourceText.textContent = "来源：2026-07-19 核对过的免费模型快照";
  }
}

function statusChipHtml(modelId) {
  const latest = getLatestModelResult(modelId);
  if (!latest) return `<span class="status-chip neutral">未测试</span><span class="status-time">暂无记录</span>`;
  const meta = STATUS_META[latest.status] || STATUS_META.fail;
  const timeText = latest.testedAt
    ? `${formatDateTime(latest.testedAt)} · ${formatMs(latest.elapsedMs)}`
    : `本轮 · ${formatMs(latest.elapsedMs)}`;
  return `<span class="status-chip ${meta.cls}">${meta.label}</span><span class="status-time">${escapeHtml(timeText)}</span>`;
}

function matchesSearch(model, query) {
  if (!query) return true;
  const haystack = `${model.id} ${model.owned_by || ""} ${model.description || ""} ${model.name || ""}`.toLowerCase();
  return haystack.includes(query);
}

function getFilteredModels() {
  const query = refs.searchInput.value.trim().toLowerCase();
  const capabilityFilter = refs.capabilitySelect.value;
  const statusFilter = refs.statusFilterSelect.value;

  return state.models
    .filter((model) => {
      const classification = classifyModel(model.id);
      if (capabilityFilter !== "auto" && !classification.categories.includes(capabilityFilter)) return false;
      if (!matchesSearch(model, query)) return false;
      if (statusFilter !== "all") {
        const latest = getLatestModelResult(model.id);
        const status = latest ? latest.status : "untested";
        if (status === "limited" && statusFilter !== "limited") return false;
        if (status === "skip" && statusFilter !== "skip") return false;
        if (statusFilter === "ok" && status !== "ok") return false;
        if (statusFilter === "fail" && status !== "fail") return false;
        if (statusFilter === "untested" && status !== "untested") return false;
        if (["limited", "skip"].includes(statusFilter) && status !== statusFilter) return false;
      }
      return true;
    })
    .sort(compareModels);
}

function renderModels() {
  const filtered = getFilteredModels();

  if (!filtered.length) {
    refs.modelList.innerHTML = `<div class="empty-state">没有匹配到模型，换个筛选条件试试。</div>`;
    updateStats();
    return;
  }

  const groups = new Map();
  filtered.forEach((model) => {
    const key = classifyModel(model.id).primary;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(model);
  });

  refs.modelList.innerHTML = [...groups.entries()].map(([groupKey, models]) => {
    const allSelected = models.every((model) => state.selected.has(model.id));
    return `
    <section class="model-group" data-group-key="${groupKey}">
      <div class="model-group-header">
        <label class="group-select-all">
          <input type="checkbox" data-group-toggle="${groupKey}" ${allSelected ? "checked" : ""} />
          <span>${escapeHtml(categoryLabel(groupKey))}</span>
        </label>
        <span class="model-group-count">${models.length}</span>
      </div>
      <div class="model-group-list">${models.map((model) => {
        const classification = classifyModel(model.id);
        const checked = state.selected.has(model.id) ? "checked" : "";
        const safeId = escapeHtml(model.id);
        const desc = model.description ? `<div class="model-desc">${escapeHtml(clipText(model.description, 90))}</div>` : "";
        return `<div class="model-item" data-item-id="${safeId}">
          <input id="model-${safeId}" type="checkbox" data-model-id="${safeId}" ${checked} />
          <label class="model-main" for="model-${safeId}">
            <div class="model-name">${safeId}</div>
            ${desc || `<div class="model-meta">owned by ${escapeHtml(model.owned_by || "unknown")}</div>`}
          </label>
          <div class="row-actions">
            <button class="quick-test-btn" type="button" data-test-model="${safeId}" title="只测这个模型">⚡ 测</button>
            <button class="copy-model-btn" type="button" data-copy-model="${safeId}" title="复制模型 ID">复制</button>
          </div>
          <div class="model-status" data-status-for="${safeId}">${statusChipHtml(model.id)}</div>
          <div class="model-tags">${classification.categories.map((key) => `<span class="tag ${key}">${escapeHtml(categoryLabel(key))}</span>`).join("")}</div>
        </div>`;
      }).join("")}</div>
    </section>`;
  }).join("");

  bindModelListEvents();
  updateStats();
}

function bindModelListEvents() {
  refs.modelList.querySelectorAll('input[type="checkbox"][data-model-id]').forEach((checkbox) => {
    checkbox.addEventListener("change", (event) => {
      const modelId = event.currentTarget.dataset.modelId;
      if (event.currentTarget.checked) state.selected.add(modelId);
      else state.selected.delete(modelId);
      updateStats();
      syncGroupCheckboxes();
    });
  });

  refs.modelList.querySelectorAll("input[data-group-toggle]").forEach((checkbox) => {
    checkbox.addEventListener("change", (event) => {
      const groupKey = event.currentTarget.dataset.groupToggle;
      const models = getFilteredModels().filter((model) => classifyModel(model.id).primary === groupKey);
      models.forEach((model) => {
        if (event.currentTarget.checked) state.selected.add(model.id);
        else state.selected.delete(model.id);
      });
      renderModels();
    });
  });

  refs.modelList.querySelectorAll("[data-copy-model]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      const modelId = event.currentTarget.dataset.copyModel;
      if (await copyText(modelId)) {
        button.textContent = "已复制";
        button.classList.add("copied");
        setStatus(`已复制模型 ID：${modelId}`, "done");
        setTimeout(() => {
          button.textContent = "复制";
          button.classList.remove("copied");
        }, 1200);
      } else setStatus("复制失败，请手动选择模型名称。", "error");
    });
  });

  refs.modelList.querySelectorAll("[data-test-model]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      const modelId = event.currentTarget.dataset.testModel;
      button.disabled = true;
      runModelTests([modelId], { mini: true, title: "快速测试" }).finally(() => {
        button.disabled = state.running;
      });
    });
  });
}

function syncGroupCheckboxes() {
  refs.modelList.querySelectorAll("input[data-group-toggle]").forEach((checkbox) => {
    const groupKey = checkbox.dataset.groupToggle;
    const models = getFilteredModels().filter((model) => classifyModel(model.id).primary === groupKey);
    checkbox.checked = models.length > 0 && models.every((model) => state.selected.has(model.id));
  });
}

function updateRowStatus(modelId) {
  const slot = refs.modelList.querySelector(`[data-status-for="${CSS.escape(modelId)}"] .model-status`) ||
    refs.modelList.querySelector(`.model-status[data-status-for="${CSS.escape(modelId)}"]`);
  if (slot) slot.innerHTML = statusChipHtml(modelId);
}

function getAvailableModelNames() {
  return state.healthChecks.map((item) => item.model).sort((a, b) => a.localeCompare(b));
}

function renderHealthChecks() {
  const items = state.healthChecks;
  if (!items.length) {
    refs.healthList.innerHTML = `<div class="empty-state">还没有已验证可用的模型。跑一轮测试，或点「同步模型列表」后测试。</div>`;
    return;
  }
  const hasBaseline = items.some((item) => item.source === "baseline");
  const note = hasBaseline
    ? `<div class="subtle health-note">带「旧记录」标记的是内置快照，未经本轮实测。</div>`
    : "";
  refs.healthList.innerHTML =
    note +
    items
      .map(
        (item) => `
        <div class="health-item">
          <div class="health-head">
            <div class="health-model">${escapeHtml(item.model)}</div>
            <span class="badge ok">${item.source === "baseline" ? "旧记录" : "实测可用"}</span>
          </div>
          <div class="subtle">${escapeHtml(item.message)}</div>
          <div class="row-actions">
            <button class="quick-test-btn" type="button" data-test-model="${escapeHtml(item.model)}">⚡ 复测</button>
            <button class="copy-model-btn" type="button" data-copy-model="${escapeHtml(item.model)}">复制</button>
          </div>
        </div>`,
      )
      .join("");

  refs.healthList.querySelectorAll("[data-test-model]").forEach((button) => {
    button.addEventListener("click", () => {
      button.disabled = true;
      runModelTests([button.dataset.testModel], { mini: true, title: "复测" }).finally(() => {
        button.disabled = state.running;
      });
    });
  });
  refs.healthList.querySelectorAll("[data-copy-model]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (await copyText(button.dataset.copyModel)) {
        button.textContent = "已复制";
        setTimeout(() => { button.textContent = "复制"; }, 1200);
      }
    });
  });
}

const STATUS_ORDER = { ok: 0, limited: 1, fail: 2, skip: 3 };

function sortResults(results) {
  return [...results].sort(
    (a, b) =>
      (STATUS_ORDER[a.status ?? (a.ok ? "ok" : "fail")] ?? 9) - (STATUS_ORDER[b.status ?? (b.ok ? "ok" : "fail")] ?? 9) ||
      a.model.localeCompare(b.model),
  );
}

const RESULT_FILTERS = [
  ["all", "全部"],
  ["ok", "可用"],
  ["limited", "限流/排队"],
  ["fail", "失败"],
  ["skip", "跳过"],
];

function renderResultChips() {
  const counts = countByStatus(state.results);
  refs.resultChips.innerHTML = RESULT_FILTERS.map(([key, label]) => {
    const count = key === "all" ? state.results.length : counts[key];
    const active = state.resultsFilter === key ? " active" : "";
    return `<button class="filter-chip${active}" type="button" data-result-filter="${key}">${label} ${count}</button>`;
  }).join("");
  refs.resultChips.querySelectorAll("[data-result-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.resultsFilter = button.dataset.resultFilter;
      renderResults();
    });
  });
}

function renderResults() {
  renderResultChips();

  if (!state.results.length) {
    refs.resultList.className = "result-list empty-state";
    refs.resultList.textContent = "还没有结果。勾选模型后点「开始测试」，或用行内的 ⚡ 单测某个模型。";
    refs.resultMeta.textContent = "结果分四种状态：可用 / 限流排队（不算失败）/ 失败 / 跳过（接口不适用）。";
    updateStats();
    return;
  }

  const counts = countByStatus(state.results);
  const okResults = state.results.filter((item) => item.status === "ok");
  const avgElapsed = okResults.length
    ? Math.round(okResults.reduce((sum, item) => sum + item.elapsedMs, 0) / okResults.length)
    : null;
  refs.resultMeta.textContent =
    `共 ${state.results.length} 个 · 可用 ${counts.ok} · 限流/排队 ${counts.limited} · 失败 ${counts.fail} · 跳过 ${counts.skip}` +
    (avgElapsed != null ? ` · 可用平均耗时 ${formatMs(avgElapsed)}` : "");

  const visible = state.resultsFilter === "all"
    ? state.results
    : state.results.filter((item) => item.status === state.resultsFilter);

  refs.resultList.className = "result-list";
  if (!visible.length) {
    refs.resultList.innerHTML = `<div class="empty-state">这个状态下没有结果。</div>`;
    updateStats();
    return;
  }

  refs.resultList.innerHTML = visible.map((item) => {
    const meta = STATUS_META[item.status] || STATUS_META.fail;
    const latency =
      item.capability === "chat" && item.ttftMs != null
        ? `首字 ${formatMs(item.ttftMs)} · 总耗时 ${formatMs(item.elapsedMs)}`
        : `总耗时 ${formatMs(item.elapsedMs)}`;
    const bodyText = item.status === "ok" ? item.response || item.message : item.message;
    const collapsible = String(bodyText || "").length > 240;
    const reasonChip = item.reason && item.status !== "ok"
      ? `<span class="tag reason">原因：${escapeHtml(item.reason)}</span>` : "";
    const retryBtn = item.status !== "skip"
      ? `<button class="ghost-btn small" type="button" data-retry-model="${escapeHtml(item.model)}">重试</button>` : "";
    return `
        <article class="result-item ${meta.cls}">
          <div class="result-head">
            <div class="result-title">${escapeHtml(item.model)}</div>
            <div class="result-head-side">${retryBtn}<span class="badge ${meta.cls}">${meta.label}</span></div>
          </div>
          <div class="result-body${collapsible ? " clamp" : ""}">${escapeHtml(bodyText)}</div>
          ${collapsible ? `<button class="expand-btn" type="button">展开全文</button>` : ""}
          <div class="result-foot">
            <span class="tag ${item.capability}">${item.capability}</span>
            ${reasonChip}
            <span class="model-meta">${escapeHtml(latency)}</span>
          </div>
        </article>`;
  }).join("");

  refs.resultList.querySelectorAll(".expand-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const body = button.previousElementSibling;
      const expanded = body.classList.toggle("clamp") === false;
      button.textContent = expanded ? "收起" : "展开全文";
    });
  });
  refs.resultList.querySelectorAll("[data-retry-model]").forEach((button) => {
    button.addEventListener("click", () => {
      runModelTests([button.dataset.retryModel], { mini: true, title: "重试" });
    });
  });

  updateStats();
}

function truncateNameList(names, max = 3) {
  return names.slice(0, max).join("、") + (names.length > max ? ` 等 ${names.length} 个` : "");
}

function sessionOkNames(session) {
  return session.results.filter((item) => item.status === "ok").map((item) => item.model);
}

function renderHistoryDiff() {
  const active = getActiveHistorySession();
  const activeIndex = state.historySessions.findIndex((session) => session.id === active?.id);
  const older = activeIndex >= 0 ? state.historySessions[activeIndex + 1] : null;

  if (!active || !older) {
    refs.historyDiff.classList.add("hidden");
    refs.historyDiff.innerHTML = "";
    return;
  }

  const okNow = new Set(sessionOkNames(active));
  const okPrev = new Set(sessionOkNames(older));
  const newlyOk = [...okNow].filter((model) => !okPrev.has(model));
  const newlyFail = [...okPrev].filter((model) => !okNow.has(model));

  const parts = [];
  if (newlyOk.length) parts.push(`<span class="up">新增可用 ${newlyOk.length}（${escapeHtml(truncateNameList(newlyOk))}）</span>`);
  if (newlyFail.length) parts.push(`<span class="down">不再可用 ${newlyFail.length}（${escapeHtml(truncateNameList(newlyFail))}）</span>`);

  refs.historyDiff.classList.remove("hidden");
  refs.historyDiff.innerHTML = `对比上一次（${escapeHtml(formatDateTime(older.createdAt))}）：${
    parts.length ? parts.join(" · ") : "可用集合没有变化"
  }`;
}

function renderHistory() {
  if (!state.historySessions.length) {
    refs.historyTabs.innerHTML = "";
    refs.historySummary.className = "history-summary empty-inline";
    refs.historySummary.textContent = "还没有历史测试记录。";
    refs.historyList.className = "history-list empty-state";
    refs.historyList.textContent = "先跑一轮测试，历史会出现在这里。";
    refs.historyDiff.classList.add("hidden");
    return;
  }

  const activeSession = getActiveHistorySession();
  refs.historyTabs.innerHTML = state.historySessions
    .map((session, index) => {
      const active = session.id === activeSession?.id ? "active" : "";
      const label = index === 0 ? "最新" : formatDateTime(session.createdAt);
      const tag = session.selectedModels?.length === 1 ? " ·单测" : "";
      return `<button class="history-tab ${active}" type="button" data-session-id="${escapeHtml(session.id)}">${escapeHtml(label + tag)}</button>`;
    })
    .join("");

  refs.historyTabs.querySelectorAll(".history-tab").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeHistoryId = button.dataset.sessionId;
      renderHistory();
    });
  });

  const counts = countByStatus(activeSession.results);
  refs.historySummary.className = "history-summary";
  refs.historySummary.innerHTML = `
    <div class="mini-stat"><span class="stat-label">测试时间</span><strong>${escapeHtml(formatDateTime(activeSession.createdAt))}</strong></div>
    <div class="mini-stat"><span class="stat-label">模型数量</span><strong>${activeSession.total}</strong></div>
    <div class="mini-stat"><span class="stat-label">可用</span><strong>${counts.ok}</strong></div>
    <div class="mini-stat"><span class="stat-label">限流/排队</span><strong>${counts.limited}</strong></div>
    <div class="mini-stat"><span class="stat-label">失败</span><strong>${counts.fail}</strong></div>
    <div class="mini-stat"><span class="stat-label">跳过</span><strong>${counts.skip}</strong></div>
  `;

  renderHistoryDiff();

  refs.historyList.className = "history-list";
  refs.historyList.innerHTML = sortResults(activeSession.results)
    .map((item) => {
      const meta = STATUS_META[item.status] || STATUS_META.fail;
      const latency =
        item.capability === "chat" && item.ttftMs != null
          ? `首字 ${formatMs(item.ttftMs)} · 总耗时 ${formatMs(item.elapsedMs)}`
          : `总耗时 ${formatMs(item.elapsedMs)}`;
      return `
        <article class="history-item">
          <div class="history-head">
            <div class="history-title">${escapeHtml(item.model)}</div>
            <span class="badge ${meta.cls}">${meta.label}</span>
          </div>
          <div class="result-body clamp">${escapeHtml(item.status === "ok" ? item.response || item.message : item.message)}</div>
          <div class="result-foot">
            <span class="tag ${item.capability}">${item.capability}</span>
            <span class="model-meta">${escapeHtml(latency)}</span>
          </div>
        </article>`;
    })
    .join("");

  refs.historyList.querySelectorAll(".result-body.clamp").forEach((body) => {
    body.addEventListener("click", () => body.classList.toggle("clamp"));
  });
}

/* ================= 模型列表加载 ================= */

async function fetchModelList(apiKey, timeoutMs = 20000) {
  const { signal, done } = makeRequestSignal(null, timeoutMs);
  try {
    const response = await fetch(getApiPath("/models"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey }),
      signal,
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new ProbeError(summarizeUpstreamError(response.status, text), { status: response.status });
      throw error;
    }
    const payload = safeJsonParse(text, {});
    const items = Array.isArray(payload.data) ? payload.data : [];
    return items
      .filter((item) => item && typeof item.id === "string")
      .map((item) => ({
        ...item,
        owned_by: item.owned_by || item.id.split("/")[0],
        supported_endpoints: item.supported_endpoints || item.supported_apis,
      }));
  } finally {
    done();
  }
}

function applyModelList(models, source) {
  state.models = [...models].sort(compareModels);
  const validIds = new Set(state.models.map((model) => model.id));
  state.selected = new Set([...state.selected].filter((modelId) => validIds.has(modelId)));
  state.modelSource = source;
  if (!state.selected.size) {
    presetModels.forEach((model) => {
      if (state.models.some((item) => item.id === model)) state.selected.add(model);
    });
  }
  renderModels();
  renderServerBadge();
}

/* ================= 批量/单次测试编排 ================= */

async function runWithConcurrency(tasks, limit, signal, onProgress) {
  const results = [];
  let index = 0;

  async function next() {
    while (!signal?.aborted && index < tasks.length) {
      const current = index++;
      const result = await tasks[current]();
      results.push(result);
      onProgress?.(results.length, tasks.length, result);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, tasks.length));
  await Promise.all(Array.from({ length: workerCount }, () => next()));
  return results;
}

function getProbeSettings() {
  const apiKey = refs.apiKeyInput.value.trim();
  if (!apiKey && !state.serverHasKey) {
    setStatus("先填 API Key，或在服务端配置 NVIDIA_API_KEY。", "error");
    return null;
  }
  const prompt = refs.promptInput.value.trim() || "请只回复 ok";
  const concurrency = Math.max(1, Math.min(8, Number(refs.concurrencyInput.value) || 3));
  const timeoutSeconds = Math.max(5, Math.min(120, Number(refs.timeoutInput.value) || 30));
  return { apiKey, prompt, concurrency, timeoutMs: timeoutSeconds * 1000 };
}

async function runModelTests(modelIds, { mini = false, title = "测试" } = {}) {
  if (state.running || !modelIds.length) return;
  const settings = getProbeSettings();
  if (!settings) return;

  const modelMap = new Map(state.models.map((model) => [model.id, model]));
  const targets = modelIds.map((id) => modelMap.get(id) || { id, owned_by: id.split("/")[0] });

  const controller = new AbortController();
  state.running = true;
  state.runController = controller;
  refs.testSelectedBtn.disabled = true;
  refs.abortBtn.classList.remove("hidden");

  if (!mini) {
    state.results = [];
    state.resultsFilter = "all";
    setProgress(0);
    setStatus(
      `${title} ${targets.length} 个模型（并发 ${settings.concurrency}，超时 ${Math.round(settings.timeoutMs / 1000)}s，失败自动重试 ${MAX_PROBE_ATTEMPTS - 1} 次）…`,
      "running",
    );
  } else {
    setStatus(`${title}：${targets[0].id} …`, "running");
  }

  const startedModelIds = new Set(targets.map((model) => model.id));

  try {
    const tasks = targets.map(
      (model) => () =>
        testModel(model, {
          apiKey: settings.apiKey,
          prompt: settings.prompt,
          timeoutMs: settings.timeoutMs,
          runSignal: controller.signal,
        }),
    );

    await runWithConcurrency(tasks, mini ? 1 : settings.concurrency, controller.signal, (doneCount, total, latest) => {
      if (!mini) setProgress(doneCount / total);
      // 同名模型以最新结果替换，其余保留（快速复测不会清空整表）。
      state.results = sortResults([...state.results.filter((item) => item.model !== latest.model), latest]);
      renderResults();
      updateRowStatus(latest.model);
      setStatus(
        `${mini ? latest.model : `进行中 ${doneCount}/${total}：${latest.model}`} ${STATUS_META[latest.status]?.label || ""}`,
        "running",
      );
    });
  } finally {
    state.running = false;
    state.runController = null;
    refs.testSelectedBtn.disabled = false;
    refs.abortBtn.classList.add("hidden");
    setProgress(null);
  }

  state.results = sortResults(state.results);
  const runResults = state.results.filter((item) => startedModelIds.has(item.model));
  const runCounts = countByStatus(runResults);
  if (runResults.length) {
    saveHistorySession(runResults, targets.map((model) => model.id));
  }
  renderResults();
  renderModels();

  if (controller.signal.aborted) {
    setStatus(`已中止：本轮完成 ${runResults.length}/${targets.length}，可用 ${runCounts.ok}。`, "error");
  } else {
    const limitedNote = runCounts.limited ? `，另有 ${runCounts.limited} 个限流/排队（稍后复测）` : "";
    setStatus(`测试完成：可用 ${runCounts.ok} · 失败 ${runCounts.fail}${limitedNote}`, "done");
  }
}

/* ================= 事件绑定 ================= */

function bindEvents() {
  refs.toggleKeyBtn.addEventListener("click", () => {
    const hidden = refs.apiKeyInput.type === "password";
    refs.apiKeyInput.type = hidden ? "text" : "password";
  });

  [refs.apiKeyInput, refs.tokenInput, refs.concurrencyInput, refs.timeoutInput, refs.promptInput].forEach(
    (element) => element.addEventListener("change", persistSettings),
  );

  refs.searchInput.addEventListener("input", renderModels);
  refs.capabilitySelect.addEventListener("change", () => {
    persistSettings();
    renderModels();
  });
  refs.statusFilterSelect.addEventListener("change", renderModels);

  refs.selectPresetBtn.addEventListener("click", () => {
    presetModels.forEach((model) => {
      if (state.models.some((item) => item.id === model)) state.selected.add(model);
    });
    renderModels();
    setStatus("已勾选推荐组合（覆盖聊天/代码/向量）。", "done");
  });

  refs.selectAvailableBtn.addEventListener("click", () => {
    const availableIds = getAvailableModelNames();
    availableIds.forEach((modelId) => state.selected.add(modelId));
    renderModels();
    setStatus(
      availableIds.length ? `已勾选 ${availableIds.length} 个最近可用的模型。` : "还没有可用记录，先跑一轮测试。",
      availableIds.length ? "done" : "error",
    );
  });

  refs.selectAllBtn.addEventListener("click", () => {
    getFilteredModels().forEach((model) => state.selected.add(model.id));
    renderModels();
    setStatus(`已勾选当前筛选结果 ${getFilteredModels().length} 个模型。`, "done");
  });

  refs.clearSelectionBtn.addEventListener("click", () => {
    state.selected.clear();
    renderModels();
  });

  refs.retryFailedBtn.addEventListener("click", () => {
    const failed = state.results.filter((item) => item.status === "fail").map((item) => item.model);
    if (!failed.length) {
      setStatus("没有失败的模型需要重试。", "done");
      return;
    }
    runModelTests(failed, { mini: true, title: "重试失败项" });
  });

  refs.loadModelsBtn.addEventListener("click", async () => {
    if (refs.loadModelsBtn.disabled) return;
    const apiKey = refs.apiKeyInput.value.trim();
    if (!apiKey && !state.serverHasKey) {
      setStatus("先填 API Key，或在服务端配置 NVIDIA_API_KEY。", "error");
      return;
    }

    refs.loadModelsBtn.disabled = true;
    setStatus("正在同步 NVIDIA 在线模型列表…", "running");
    try {
      const models = await fetchModelList(apiKey);
      applyModelList(models, "live");
      saveModelCache(models);
      setStatus(`已从 NVIDIA 在线同步 ${models.length} 个模型。`, "done");
    } catch (error) {
      if (!state.models.length) applyModelList(FALLBACK_MODELS, "fallback");
      setStatus(`在线同步失败（${error.message || "未知错误"}），已保留当前列表。`, "error");
    } finally {
      refs.loadModelsBtn.disabled = false;
    }
  });

  refs.abortBtn.addEventListener("click", () => {
    state.runController?.abort(new ProbeError("已手动中止", { kind: "abort" }));
  });

  refs.testSelectedBtn.addEventListener("click", () => {
    const selectedModels = Array.from(state.selected);
    if (!selectedModels.length) {
      setStatus("先勾选要测试的模型。", "error");
      return;
    }
    runModelTests(selectedModels, { title: "开始测试" });
  });

  refs.exportJsonBtn.addEventListener("click", () => {
    if (!state.results.length) {
      setStatus("还没有可导出的结果。", "error");
      return;
    }
    downloadJson({ exportedAt: new Date().toISOString(), results: state.results });
  });

  refs.copyAvailableBtn.addEventListener("click", async () => {
    const models = getAvailableModelNames();
    if (!models.length) {
      setStatus("当前没有可复制的可用模型。", "error");
      return;
    }
    const succeeded = await copyText(models.join("\n"));
    setStatus(succeeded ? `已复制 ${models.length} 个可用模型名称。` : "复制失败，请手动导出 JSON。", succeeded ? "done" : "error");
  });

  refs.copyConfigBtn.addEventListener("click", async () => {
    const models = getAvailableModelNames();
    const config = {
      base_url: OPENAI_BASE_URL,
      api_key: refs.apiKeyInput.value.trim() || "<你的 nvapi Key 或经代理免 Key>",
      models,
    };
    const succeeded = await copyText(JSON.stringify(config, null, 2));
    setStatus(succeeded ? "已复制 OpenAI 兼容配置（含可用模型清单）。" : "复制失败。", succeeded ? "done" : "error");
  });

  refs.exportAvailableJsonBtn.addEventListener("click", () => {
    const models = getAvailableModelNames();
    if (!models.length) {
      setStatus("当前没有可导出的可用模型。", "error");
      return;
    }
    downloadJson(
      { exportedAt: new Date().toISOString(), base_url: OPENAI_BASE_URL, source: state.modelSource, total: models.length, models },
      `nvidia-available-models-${Date.now()}.json`,
    );
    setStatus(`已导出 ${models.length} 个可用模型名称。`, "done");
  });

  refs.clearHistoryBtn.addEventListener("click", () => {
    if (!state.historySessions.length) {
      setStatus("现在没有可清空的历史记录。", "error");
      return;
    }
    clearHistorySessions();
    setStatus("历史测试已清空，当前可用性已退回基线状态。", "done");
  });
}

/* ================= 初始化 ================= */

function collectRefs() {
  const $ = (selector) => document.querySelector(selector);
  refs = {
    serverKeyPill: $("#serverKeyPill"),
    toggleKeyBtn: $("#toggleKeyBtn"),
    apiKeyInput: $("#apiKeyInput"),
    keyOptionalNote: $("#keyOptionalNote"),
    tokenField: $("#tokenField"),
    tokenInput: $("#tokenInput"),
    concurrencyInput: $("#concurrencyInput"),
    timeoutInput: $("#timeoutInput"),
    promptInput: $("#promptInput"),
    loadModelsBtn: $("#loadModelsBtn"),
    testSelectedBtn: $("#testSelectedBtn"),
    abortBtn: $("#abortBtn"),
    selectPresetBtn: $("#selectPresetBtn"),
    selectAvailableBtn: $("#selectAvailableBtn"),
    selectAllBtn: $("#selectAllBtn"),
    clearSelectionBtn: $("#clearSelectionBtn"),
    retryFailedBtn: $("#retryFailedBtn"),
    searchInput: $("#searchInput"),
    capabilitySelect: $("#capabilitySelect"),
    statusFilterSelect: $("#statusFilterSelect"),
    modelSourceBadge: $("#modelSourceBadge"),
    modelSourceText: $("#modelSourceText"),
    modelList: $("#modelList"),
    copyAvailableBtn: $("#copyAvailableBtn"),
    copyConfigBtn: $("#copyConfigBtn"),
    exportAvailableJsonBtn: $("#exportAvailableJsonBtn"),
    healthList: $("#healthList"),
    resultChips: $("#resultChips"),
    resultMeta: $("#resultMeta"),
    resultList: $("#resultList"),
    exportJsonBtn: $("#exportJsonBtn"),
    historyTabs: $("#historyTabs"),
    historySummary: $("#historySummary"),
    historyDiff: $("#historyDiff"),
    historyList: $("#historyList"),
    clearHistoryBtn: $("#clearHistoryBtn"),
    progressBar: $("#progressBar"),
    progressFill: $("#progressFill"),
    statusBar: $("#statusBar"),
    totalModelsStat: $("#totalModelsStat"),
    selectedModelsStat: $("#selectedModelsStat"),
    okModelsStat: $("#okModelsStat"),
    failModelsStat: $("#failModelsStat"),
  };
}

function init() {
  collectRefs();
  loadSettings();
  loadHistorySessions();

  const cached = loadModelCache();
  if (cached) {
    applyModelList(cached.models, "cached");
  } else {
    applyModelList(FALLBACK_MODELS, "fallback");
  }

  updateHealthChecksFromHistory();
  renderResults();
  renderHealthChecks();
  renderHistory();
  bindEvents();
  loadServerInfo();
  setStatus(
    `已加载 ${state.models.length} 个模型（${state.modelSource === "cached" ? "上次同步缓存" : "内置快照"}）。点「同步模型列表」获取最新目录，或开始测试。`,
    "idle",
  );
}

if (IS_BROWSER) init();

export {
  classifyModel,
  pickProbeStrategy,
  summarizeUpstreamError,
  classifyProbeError,
  requestChat,
  probeChat,
  probeEmbedding,
  testModel,
  STATUS_META,
  FALLBACK_MODELS,
  state,
};
