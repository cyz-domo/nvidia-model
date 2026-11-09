# nvidia-model · NVIDIA 免费模型探活台

基于 Cloudflare Worker 的 NVIDIA 免费模型可用性探测工具：同步 [NVIDIA API Catalog](https://integrate.api.nvidia.com) 模型目录，批量流式探测模型可用性、首字延迟（TTFT）与失败原因，结果保存在浏览器本地。

线上地址：<https://nvidia-model.cyz13.workers.dev>

## 探活状态说明

| 状态 | 含义 |
| --- | --- |
| 可用 | 接口真实返回了内容（流式带 `error` 事件、空返回均不算可用） |
| 限流/排队 | 429 或模型冷启动排队，重试后仍受限——不代表模型故障，建议稍后复测 |
| 失败 | 带原因分类：`auth` 权限 / `gone` 退役(404/410) / `empty` 空返回 / `timeout` 超时 / `server`、`network`、`upstream` 等 |
| 跳过 | rerank / 音频 / 图像类模型不走 chat/embeddings 接口，无法据此判断 |

探测策略：优先 SSE 流式（可测 TTFT）；429/5xx/空返回指数退避重试最多 3 次；400 自动降级非流式；在线目录的 `supported_endpoints` 元数据优先于模型名启发式。

## 结构

```
src/worker.js       # Worker 代理：Key 注入、路径白名单、/models 服务端缓存
public/             # 静态前端（原生 ESM，无构建步骤），app.js 内含可测试的探测核心
tests/probe.test.ts # bun test：探测判定逻辑（mock fetch）
reference/          # v1 线上 bundle 存档
wrangler.jsonc      # Worker + Assets 配置
```

## 开发与部署

```bash
bun install                 # 安装 wrangler
bun test                    # 跑探测逻辑单元测试
cp .dev.vars.example .dev.vars   # 本地测试填入自己的 nvapi Key（可选）
bunx wrangler dev           # 本地预览 http://127.0.0.1:8799
bunx wrangler deploy        # 部署（需要 gh auth login 或 CLOUDFLARE_API_TOKEN）
```

生产环境的 `NVIDIA_API_KEY` 以 Secret 配置在 Worker 上，`wrangler deploy` 不会清除它。页面 API Key 输入框留空即走服务端 Key。

## 说明

- 页面数据（结果、历史、设置）仅存浏览器 localStorage，不上传
- Worker 仅代理 `/models`、`/chat/completions`、`/embeddings` 三个路径
- 内置模型快照核对于 2026-07-19，仅作离线兜底，以在线同步为准
