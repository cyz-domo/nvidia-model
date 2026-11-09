import { describe, expect, test } from "bun:test";
import { pickProbeStrategy, summarizeUpstreamError, testModel } from "../public/app.js";

const fastDeps = { now: () => 0, sleep: async () => {} };

function sse(lines) {
  return new Response(lines.map((line) => line + "\n").join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function chatStream(text) {
  return sse([
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}`,
    "data: [DONE]",
  ]);
}

function streamError(code, message) {
  return sse([`data: ${JSON.stringify({ error: { code: String(code), message } })}`]);
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function scriptedFetch(scripts) {
  const calls = [];
  let i = 0;
  const f = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const step = scripts[i++];
    if (!step) throw new Error(`unexpected fetch #${i}`);
    return step;
  };
  return { f, calls, count: () => i };
}

const chatModel = { id: "meta/llama-3.3-70b-instruct" };

describe("探活判定", () => {
  test("HTTP 200 但流里没有任何内容 → fail/empty（旧版误判为可用）", async () => {
    const empty = () => sse(["data: {\"note\":\"queued\"}", "data: [DONE]"]);
    const deps = {
      ...fastDeps,
      fetch: async () => empty(),
    };
    const r = await testModel(chatModel, { apiKey: "k", prompt: "hi", timeoutMs: 5000 }, deps);
    expect(r.status).toBe("fail");
    expect(r.reason).toBe("empty");
  });

  test("流内 error 事件 429 → limited，不再算作失败", async () => {
    const deps = {
      ...fastDeps,
      fetch: async () => streamError(429, "Too Many Requests"),
    };
    const r = await testModel(chatModel, { apiKey: "k", prompt: "hi", timeoutMs: 5000 }, deps);
    expect(r.status).toBe("limited");
    expect(r.reason).toBe("rate_limit");
  });

  test("流内 error 事件带排队文案 → limited/queue", async () => {
    const deps = {
      ...fastDeps,
      fetch: async () => streamError(503, "The model is loading, please retry"),
    };
    const r = await testModel(chatModel, { apiKey: "k", prompt: "hi", timeoutMs: 5000 }, deps);
    expect(r.status).toBe("limited");
    expect(r.reason).toBe("queue");
  });

  test("429 后复测成功 → ok（旧版一次抖动就误判失败）", async () => {
    const { f, count } = scriptedFetch([streamError(429, "Too Many Requests"), chatStream("ok!")]);
    const r = await testModel(chatModel, { apiKey: "k", prompt: "hi", timeoutMs: 5000 }, { ...fastDeps, fetch: f });
    expect(r.status).toBe("ok");
    expect(r.response).toBe("ok!");
    expect(count()).toBe(2);
  });

  test("流式 400 自动降级非流式，成功则判 ok", async () => {
    const { f, calls } = scriptedFetch([
      json({ error: { message: "streaming unsupported" } }, 400),
      json({ choices: [{ message: { content: "pong" } }] }),
    ]);
    const r = await testModel(chatModel, { apiKey: "k", prompt: "hi", timeoutMs: 5000 }, { ...fastDeps, fetch: f });
    expect(r.status).toBe("ok");
    expect(r.response).toBe("pong");
    expect(calls[0].body.stream).toBe(true);
    expect(calls[1].body.stream).toBe(false);
  });

  test("非流式 HTTP 200 但 payload.error → fail", async () => {
    const { f } = scriptedFetch([
      json({ error: { message: "bad" } }, 400),
      json({ error: { code: 404, message: "model removed" } }),
    ]);
    const r = await testModel(chatModel, { apiKey: "k", prompt: "hi", timeoutMs: 5000 }, { ...fastDeps, fetch: f });
    expect(r.status).toBe("fail");
    expect(r.reason).toBe("gone");
  });

  test("5xx 自动重试后成功 → ok", async () => {
    const { f, count } = scriptedFetch([json({ error: { message: "unavailable" } }, 503), chatStream("late ok")]);
    const r = await testModel(chatModel, { apiKey: "k", prompt: "hi", timeoutMs: 5000 }, { ...fastDeps, fetch: f });
    expect(r.status).toBe("ok");
    expect(count()).toBe(2);
  });

  test("embedding 模型走 embeddings 接口并校验维度", async () => {
    const { f, calls } = scriptedFetch([json({ data: [{ embedding: [0.1, 0.2, 0.3] }] })]);
    const r = await testModel({ id: "baai/bge-m3" }, { apiKey: "k", prompt: "hi", timeoutMs: 5000 }, { ...fastDeps, fetch: f });
    expect(r.status).toBe("ok");
    expect(r.response).toBe("embedding 维度: 3");
    expect(calls[0].url).toBe("/api/embeddings");
  });

  test("410 模型退役 → fail/gone 且提示退役信息", async () => {
    const deps = {
      ...fastDeps,
      fetch: async () =>
        json(
          { detail: "The model has reached its end of life on 2026-08-26 and is no longer available." },
          410,
        ),
    };
    const r = await testModel(chatModel, { apiKey: "k", prompt: "hi", timeoutMs: 5000 }, deps);
    expect(r.status).toBe("fail");
    expect(r.reason).toBe("gone");
    expect(r.message).toContain("HTTP 410");
  });

  test("超时归为 fail/timeout", async () => {
    const deps = {
      now: () => 0,
      sleep: async () => {},
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason));
        }),
    };
    const r = await testModel(chatModel, { apiKey: "k", prompt: "hi", timeoutMs: 20 }, deps);
    expect(r.status).toBe("fail");
    expect(r.reason).toBe("timeout");
  });
});

describe("探测策略选择", () => {
  test("名字启发式：rerank/audio/image 直接跳过而不是判失败", () => {
    expect(pickProbeStrategy({ id: "nvidia/rerank-qa-mistral-4b" }).kind).toBe("skip");
    expect(pickProbeStrategy({ id: "nvidia/canary-1b-asr" }).kind).toBe("skip");
    expect(pickProbeStrategy({ id: "stability/stable-diffusion-xl" }).kind).toBe("skip");
    expect(pickProbeStrategy({ id: "meta/llama-3.3-70b-instruct" }).kind).toBe("chat");
    expect(pickProbeStrategy({ id: "baai/bge-m3" }).kind).toBe("embedding");
  });

  test("supported_endpoints 元数据优先于名字猜测", () => {
    const asChat = { id: "nvidia/mystery-thing", supported_endpoints: ["chat"] };
    expect(pickProbeStrategy(asChat).kind).toBe("chat");
    const embed = { id: "someorg/some-name", supported_endpoints: ["embeddings"] };
    expect(pickProbeStrategy(embed).kind).toBe("embedding");
    const nonChat = { id: "nvidia/tts-model", supported_endpoints: ["audio"] };
    expect(pickProbeStrategy(nonChat).kind).toBe("skip");
  });

  test("skip 结果不发起请求", async () => {
    let called = 0;
    const deps = { ...fastDeps, fetch: async () => { called++; return json({}); } };
    const r = await testModel({ id: "nvidia/rerank-qa-mistral-4b" }, { apiKey: "k", prompt: "hi", timeoutMs: 5000 }, deps);
    expect(r.status).toBe("skip");
    expect(called).toBe(0);
  });
});

describe("错误文案", () => {
  test("summarizeUpstreamError 包含状态码与中文提示", () => {
    const msg = summarizeUpstreamError(429, JSON.stringify({ detail: "rate limited" }));
    expect(msg).toContain("HTTP 429");
    expect(msg).toContain("限流");
    expect(msg).toContain("rate limited");
  });
});
