var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/worker.js
var UPSTREAM_BASE = "https://integrate.api.nvidia.com/v1";
var ALLOWED_PATHS = /* @__PURE__ */ new Set(["/models", "/chat/completions", "/embeddings"]);
var MAX_BODY_BYTES = 64 * 1024;
var MODEL_CACHE_TTL = 300;
function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers }
  });
}
__name(jsonResponse, "jsonResponse");
function cacheKey(request) {
  const url = new URL(request.url);
  url.search = "";
  return new Request(url.toString(), { method: "GET" });
}
__name(cacheKey, "cacheKey");
async function fetchModels(apiKey, request) {
  const cache = caches.default;
  const key = cacheKey(request);
  const cached = await cache.match(key);
  if (cached) return cached;
  const response = await fetch(`${UPSTREAM_BASE}/models`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }
  });
  if (response.ok) {
    const cachedResponse = new Response(response.body, response);
    cachedResponse.headers.set("Cache-Control", `public, max-age=${MODEL_CACHE_TTL}`);
    await cache.put(key, cachedResponse.clone());
    return cachedResponse;
  }
  return response;
}
__name(fetchModels, "fetchModels");
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS?.fetch(request) || new Response("Not Found", { status: 404 });
    }
    if (url.pathname === "/api/health") {
      return jsonResponse({ hasServerKey: Boolean(env.NVIDIA_API_KEY), requiresToken: Boolean(env.ACCESS_TOKEN) }, 200, { "Cache-Control": "no-store" });
    }
    if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405, { Allow: "POST" });
    if (env.ACCESS_TOKEN && request.headers.get("x-access-token") !== env.ACCESS_TOKEN) {
      return jsonResponse({ error: "unauthorized", detail: "\u8BBF\u95EE\u53E3\u4EE4\u7F3A\u5931\u6216\u4E0D\u6B63\u786E" }, 401);
    }
    const path = url.pathname.slice("/api".length);
    if (!ALLOWED_PATHS.has(path)) return jsonResponse({ error: "not_allowed" }, 404);
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > MAX_BODY_BYTES) return jsonResponse({ error: "payload_too_large" }, 413);
    let apiKey = (env.NVIDIA_API_KEY || "").trim();
    let payload = {};
    const raw = await request.text();
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        return jsonResponse({ error: "invalid_json" }, 400);
      }
    }
    if (typeof payload.apiKey === "string" && payload.apiKey.trim()) apiKey = payload.apiKey.trim();
    delete payload.apiKey;
    delete payload.timeoutMs;
    if (!apiKey) return jsonResponse({ error: "missing_api_key", detail: "\u9875\u9762\u672A\u586B Key\uFF0C\u4E14\u670D\u52A1\u7AEF\u672A\u914D\u7F6E NVIDIA_API_KEY" }, 400);
    try {
      if (path === "/models") return fetchModels(apiKey, request);
      return fetch(new Request(`${UPSTREAM_BASE}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: payload.stream ? "text/event-stream" : "application/json" },
        body: JSON.stringify(payload)
      }));
    } catch (error) {
      return jsonResponse({ error: "upstream_unreachable", detail: String(error) }, 502);
    }
  }
};
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
