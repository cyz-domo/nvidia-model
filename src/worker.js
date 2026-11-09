const UPSTREAM_BASE = "https://integrate.api.nvidia.com/v1";
const ALLOWED_PATHS = new Set(["/models", "/chat/completions", "/embeddings"]);
const MAX_BODY_BYTES = 64 * 1024;
const MODEL_CACHE_TTL = 300;

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

// Only responses fetched with the server-owned key may be cached, and even then
// under a fixed dedicated key: the old code derived the cache key from the
// caller's request URL, so visitors passing their own API key shared (and
// leaked) each other's cached /models responses on a multi-tenant worker.
function serverKeyCacheRequest() {
  return new Request(`${UPSTREAM_BASE}/models`, { method: "GET" });
}

async function fetchModels(apiKey, useServerKey) {
  const upstream = () =>
    fetch(`${UPSTREAM_BASE}/models`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });

  if (!useServerKey) return upstream();

  const cache = caches.default;
  const key = serverKeyCacheRequest();
  const cached = await cache.match(key);
  if (cached) return cached;

  const response = await upstream();
  if (response.ok) {
    const cachedResponse = new Response(response.body, response);
    cachedResponse.headers.set("Cache-Control", `public, max-age=${MODEL_CACHE_TTL}`);
    await cache.put(key, cachedResponse.clone());
    return cachedResponse;
  }
  return response;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS?.fetch(request) || new Response("Not Found", { status: 404 });
    }

    if (url.pathname === "/api/health") {
      return jsonResponse(
        {
          hasServerKey: Boolean(env.NVIDIA_API_KEY),
          requiresToken: Boolean(env.ACCESS_TOKEN),
        },
        200,
        { "Cache-Control": "no-store" },
      );
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "method_not_allowed" }, 405, { Allow: "POST" });
    }

    if (env.ACCESS_TOKEN && request.headers.get("x-access-token") !== env.ACCESS_TOKEN) {
      return jsonResponse({ error: "unauthorized", detail: "访问口令缺失或不正确" }, 401);
    }

    const path = url.pathname.slice("/api".length);
    if (!ALLOWED_PATHS.has(path)) return jsonResponse({ error: "not_allowed" }, 404);

    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > MAX_BODY_BYTES) return jsonResponse({ error: "payload_too_large" }, 413);

    let payload = {};
    const raw = await request.text();
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        return jsonResponse({ error: "invalid_json" }, 400);
      }
    }

    const clientKey = typeof payload.apiKey === "string" ? payload.apiKey.trim() : "";
    delete payload.apiKey;
    delete payload.timeoutMs;

    const serverKey = (env.NVIDIA_API_KEY || "").trim();
    const apiKey = clientKey || serverKey;
    if (!apiKey) {
      return jsonResponse(
        { error: "missing_api_key", detail: "页面未填 Key，且服务端未配置 NVIDIA_API_KEY" },
        400,
      );
    }

    try {
      if (path === "/models") return fetchModels(apiKey, !clientKey);
      return fetch(
        new Request(`${UPSTREAM_BASE}${path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            Accept: payload.stream ? "text/event-stream" : "application/json",
          },
          body: JSON.stringify(payload),
        }),
      );
    } catch (error) {
      return jsonResponse({ error: "upstream_unreachable", detail: String(error) }, 502);
    }
  },
};
