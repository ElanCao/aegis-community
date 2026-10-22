# Aegis Community Edition

开源的企业级 AI 网关与 Agent 治理数据面（Apache-2.0）。完全本地运行：模型密钥、MCP/Skill 仓库、策略执行、用量计费全部留在你的环境里，无需注册、无需激活、无需联网。

## 包含什么

```
apps/
  server/    社区版无头网关：OpenAI/Anthropic 兼容网关 + Web 管理界面，单 Node 进程
             （UI :8929，网关 :8931，可 --port 调整）
  agent/     桌面企业代理（Electron）：同样的网关核心 + 本地仓库管理界面
packages/
  shared/    共享协议与算法：策略表达式引擎、内容安全规则、License 校验、
             MCP 聚合、Anthropic 适配
```

## 快速开始

无头网关（推荐，开箱即用）：

```bash
npm install
npm run build -w packages/shared
npm run gateway
# 打开 http://127.0.0.1:8929 选择「社区版 · 独立模式」，免激活
# Agent 接入 http://127.0.0.1:8931/v1（OpenAI 兼容）
```

桌面代理（Electron）：

```bash
npm run desktop
```

## 社区版能力

- **统一网关**：代理所有 LLM 调用，OpenAI + Anthropic 双协议，MCP 聚合端点，多上游凭证 failover
- **本地仓库**：模型密钥（AES-256-GCM 本地加密）、MCP 服务器、Skill 仓库、价格表
- **治理执行**：表达式策略（ABAC，每次调用求值，默认拒绝）、内容安全检查（PII/敏感词/自定义正则）、限流与预算熔断、AI 策略评估（决策模型结构化判定）
- **Agent 纳管**：本地 Agent 注册与 ak_ 令牌签发、模型边界、工具审批门
- **计量计费**：内置官方价格 + 自定义价格表，本地用量统计
- **离线可用**：全部能力不依赖任何云端服务

## 许可证

Apache License 2.0（见各目录 LICENSE）。可自由用于商业环境。

## 升级到商业版

Aegis 提供可选的 SaaS 控制面（多数据面仪表盘、策略统一下发、审计聚合、账单），
通过 License Key 解锁，按数据面数量计费。社区版与商业版共用同一数据面核心，
升级无需迁移。详见 [官网文档](https://aegis.example.com/docs)。
