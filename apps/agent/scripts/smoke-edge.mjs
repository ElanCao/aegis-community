// Smoke test for edge-direct mode: stands up a mock control plane (bootstrap
// with edge credentials, usage ingest, reachability) plus a mock upstream
// provider on 127.0.0.1:3210, launches the Electron agent against it and
// exercises the local gateway end-to-end. Run: node scripts/smoke-edge.mjs
import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electronBin = require("electron"); // resolves to the electron executable path

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const isWin = process.platform === "win32";
const MOCK_PORT = 3210;
const GATEWAY = "http://127.0.0.1:8931";
const DATA_KEY = "smoke-data-key-0123456789abcdef0123456789abcdef";
const userData = path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "@aegis", "agent");

// ---- crypto mirror (must match electron/crypto.ts) ----
function dataKey() {
  const raw = DATA_KEY;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  return createHash("sha256").update(raw, "utf8").digest();
}
function encryptSecret(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
}

// ---- commercial layer mirror (must match shared/license.ts + snapshot.ts) ----
const LICENSE_SECRET = "dev-aegis-license-secret-change-me";
const SNAP_PRIV_PEM = Buffer.from(
  "LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCk1DNENBUUF3QlFZREsyVndCQ0lFSUUzMTlUaS9xUXNUbGVQNTVhNmVnWnlralBKTURGZTl5TXExTjZhcWZiZkUKLS0tLS1FTkQgUFJJVkFURSBLRVktLS0tLQo=",
  "base64",
).toString("utf8");

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

function smokeLicense(tenantId) {
  const body = b64url(JSON.stringify({
    tenantId, plan: "CLOUD_PRO", features: ["gateway", "materialize"], expiresAt: "", nonce: "smoke-nonce",
  }));
  const sig = b64url(createHmac("sha256", LICENSE_SECRET).update(body).digest());
  return `v1.${body}.${sig}`;
}

function smokeSnapshotSignature(tenantId, version) {
  const { createPrivateKey, sign } = require("node:crypto");
  return sign(null, Buffer.from(`${tenantId}:${version}`, "utf8"), createPrivateKey(SNAP_PRIV_PEM)).toString("base64");
}

// ---- mock control plane + upstream provider ----
const state = {
  usageEvents: [], bootstrapHits: 0, reachabilityHits: 0, activateHits: 0,
  activatedName: "", lastChatBody: null,
  // Edge governance-event ingest (per-call audit channel): events grouped by
  // type; the mock is idempotent on eventId like the real control plane.
  auditEvents: [], auditSeen: new Set(), auditDeviceModes: new Set(),
  // Guardrail config served via bootstrap; the guardrails smoke section flips
  // these and re-bootstraps to push them into the proxy cache.
  safetyCfg: {
    enabled: false, mode: "BLOCK",
    checks: { phone: false, idCard: false, bankCard: false, ipAddress: false, keywords: false, customRegex: false },
    customKeywords: [], customRegexes: [],
  },
  limitsCfg: { rpmPerKey: 0, dailyTokenBudget: 0, budgetHardStop: false },
  // AI 决策式策略评估（bootstrap 下发；aiGuard smoke 段翻转后重拉）。
  guardCfg: { enabled: false, mode: "BLOCK", credentialId: null, model: "", template: null, timeoutMs: 8000, failOpen: true },
};

const CREDENTIAL = {
  id: "cred_smoke_1",
  provider: "DEEPSEEK",
  label: "smoke-deepseek",
  baseUrl: `http://127.0.0.1:${MOCK_PORT}/deepseek`,
  models: ["deepseek-chat"],
  apiKeyEnc: encryptSecret("sk-edge-fake-key"),
};

function bootstrapPayload() {
  return {
    ok: true,
    data: {
      device: { id: "dev_smoke_1", name: "smoke-device", tenantId: "ten_smoke" },
      mode: "edge",
      gatewayUrl: "/api/gateway/v1",
      policies: [
        { id: "p1", name: "allow-all", effect: "ALLOW", action: "model:invoke", subjectType: "EVERYONE", subjectId: "", resource: "*", env: "prod" },
        { id: "p2", name: "deny-banned", effect: "DENY", action: "model:invoke", subjectType: "EVERYONE", subjectId: "", resource: "banned-model", env: "prod" },
        { id: "p3", name: "allow-mcp-invoke", effect: "ALLOW", action: "mcp:invoke", subjectType: "EVERYONE", subjectId: "", resource: "*", env: "prod" },
        { id: "p4", name: "allow-tool-execute", effect: "ALLOW", action: "tool:execute", subjectType: "EVERYONE", subjectId: "", resource: "*", env: "prod" },
        { id: "p5", name: "allow-skill-use", effect: "ALLOW", action: "skill:use", subjectType: "EVERYONE", subjectId: "", resource: "*", env: "prod" },
        { id: "p6", name: "allow-mcp-discover", effect: "ALLOW", action: "mcp:discover", subjectType: "EVERYONE", subjectId: "", resource: "*", env: "prod" },
        { id: "p7", name: "deny-conditional-model", effect: "DENY", action: "model:invoke", subjectType: "EVERYONE", subjectId: "", resource: "*", env: "prod", conditions: { expr: "model.startsWith('cond-')" } },
      ],
      credentials: [CREDENTIAL],
      mcp: [
        { id: "mcp1", name: "weather", endpoint: `http://127.0.0.1:${MOCK_PORT}/mcp/weather`, transport: "STREAMABLE_HTTP", riskLevel: "LOW", authType: "API_KEY", authTokenEnc: encryptSecret("mcp-upstream-token"), allowedAgentIds: [], tools: [{ name: "get_weather", requiresApproval: false, riskLevel: "LOW" }] },
        { id: "mcp2", name: "hr", endpoint: `http://127.0.0.1:${MOCK_PORT}/mcp/hr`, transport: "STREAMABLE_HTTP", riskLevel: "HIGH", authType: "NONE", authTokenEnc: "", allowedAgentIds: ["agent-hr"], tools: [{ name: "lookup", requiresApproval: true, riskLevel: "HIGH" }] },
        { id: "mcp3", name: "local-fs", endpoint: "npx -y @example/fs-mcp", transport: "STDIO", riskLevel: "MEDIUM", authType: "NONE", authTokenEnc: "", allowedAgentIds: [], tools: [] },
      ],
      toolApprovals: [],
      skills: [
        { id: "sk1", name: "summarize", source: "builtin", allowedAgentIds: [], activeVersion: { version: "1.0.0", content: "# summarize skill", format: "markdown" } },
        { id: "sk2", name: "hr-report", source: "custom", allowedAgentIds: ["agent-x"], activeVersion: { version: "2.1.0", content: "# hr report skill", format: "markdown" } },
      ],
      publicAiCatalog: [],
      contentSafety: state.safetyCfg,
      limits: state.limitsCfg,
      aiGuard: state.guardCfg,
      snapshotVersion: "smoke-snap-1",
      snapshotSignature: smokeSnapshotSignature("ten_smoke", "smoke-snap-1"),
      license: smokeLicense("ten_smoke"),
    },
  };
}

function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(null);
      }
    });
  });
}

const mock = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const json = (status, payload, headers = {}) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
    res.end(JSON.stringify(payload));
  };

  if (url.pathname === "/deepseek/chat/completions" && req.method === "POST") {
    const auth = req.headers.authorization ?? "";
    if (auth !== "Bearer sk-edge-fake-key") {
      return json(401, { error: { message: "bad upstream key", type: "auth", code: "401" } });
    }
    const body = await readJson(req);
    state.lastChatBody = body;
    // AI 策略判定调用（response_format=json_object）：按【用户请求】段是否含
    // "password" 返回 block/allow 结构化决策（模板本身含 password_leak 类别名，
    // 必须只看用户请求段）。
    if (body?.response_format?.type === "json_object") {
      const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === "user")?.content ?? "";
      const userSection = lastUser.includes("【用户请求") ? lastUser.split("【用户请求").pop() : lastUser;
      const blocked = userSection.includes("password");
      return json(200, {
        id: "chatcmpl-guard",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body?.model ?? "deepseek-chat",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                decision: blocked ? "block" : "allow",
                categories: blocked ? ["password_leak"] : ["none"],
                confidence: 0.9,
                reason: blocked ? "用户请求涉及密码泄露" : "正常办公请求",
              }),
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      });
    }
    if (body?.stream === true) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write('data: {"id":"chatcmpl-edge-chunk","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant","content":"hel"}}]}\n\n');
      res.write('data: {"id":"chatcmpl-edge-chunk","choices":[{"delta":{"content":"lo"}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n');
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    return json(200, {
      id: "chatcmpl-edge-mock",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body?.model ?? "deepseek-chat",
      choices: [{ index: 0, message: { role: "assistant", content: "edge-ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  }

  if ((url.pathname === "/mcp/weather" || url.pathname === "/mcp/hr") && req.method === "POST") {
    const body = await readJson(req);
    const toolName = url.pathname.endsWith("weather") ? "get_weather" : "lookup";
    if (body?.method === "tools/list") {
      return json(200, {
        jsonrpc: "2.0",
        id: body.id ?? 1,
        result: { tools: [{ name: toolName, description: `${toolName} mock`, inputSchema: { type: "object", properties: {} } }] },
      });
    }
    if (body?.method === "tools/call") {
      return json(200, {
        jsonrpc: "2.0",
        id: body.id ?? 1,
        result: { content: [{ type: "text", text: `called ${body.params?.name} auth=${req.headers.authorization ?? ""}` }] },
      });
    }
    return json(200, { proxied: true, path: url.pathname, tool: body?.tool ?? null });
  }

  const auth = req.headers.authorization ?? "";

  // Public endpoints (Item 19/20): no device key required.
  if (url.pathname === "/api/agent/activate" && req.method === "POST") {
    const body = await readJson(req);
    if (body?.code === "aac_bad") {
      return json(403, { ok: false, error: { code: "INVALID_ACTIVATION_CODE", message: "bad code" } });
    }
    state.activateHits += 1;
    state.activatedName = body?.deviceName ?? "";
    return json(201, {
      ok: true,
      data: {
        deviceKey: "akd_activated_smoke",
        device: { id: "dev_activated", name: body?.deviceName || "Aegis Client", status: "ACTIVE" },
      },
    });
  }
  if (url.pathname === "/api/releases/latest" && req.method === "GET") {
    return json(200, {
      ok: true,
      data: { version: "99.1.0-smoke", downloadUrl: "https://example.com/aegis-agent.zip", notes: "smoke release" },
    });
  }

  if (!auth.startsWith("Bearer akd_")) {
    return json(401, { ok: false, error: { code: "BAD_DEVICE_KEY", message: "bad device key" } });
  }

  if (url.pathname === "/api/agent/bootstrap" && req.method === "GET") {
    state.bootstrapHits += 1;
    return json(200, bootstrapPayload());
  }
  if (url.pathname === "/api/agent/usage" && req.method === "POST") {
    const body = await readJson(req);
    const events = Array.isArray(body?.events) ? body.events : [];
    state.usageEvents.push(...events);
    return json(200, { ok: true, data: { accepted: events.length, duplicates: 0 } });
  }
  if (url.pathname === "/api/agent/audit" && req.method === "POST") {
    const body = await readJson(req);
    const events = Array.isArray(body?.events) ? body.events : [];
    let accepted = 0;
    let duplicates = 0;
    if (typeof body?.deviceMode === "string") state.auditDeviceModes.add(body.deviceMode);
    for (const e of events) {
      if (state.auditSeen.has(e.eventId)) {
        duplicates++;
        continue;
      }
      state.auditSeen.add(e.eventId);
      state.auditEvents.push(e);
      accepted++;
    }
    return json(200, { ok: true, data: { accepted, duplicates } });
  }
  if (url.pathname === "/api/agent/reachability" && req.method === "POST") {
    state.reachabilityHits += 1;
    return json(200, { ok: true, data: { received: 0 } });
  }
  json(404, { ok: false, error: { code: "NOT_FOUND", message: url.pathname } });
});

// ---- helpers ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function check(name, cond, extra = "") {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name} ${extra}`);
  }
}

async function waitFor(cond, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await sleep(500);
  }
  console.log(`  (timeout waiting for ${label})`);
  return false;
}

async function post(pathname, body, headers = {}) {
  const res = await fetch(`${GATEWAY}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep raw */
  }
  return { status: res.status, headers: res.headers, json, text };
}

async function get(pathname, headers = {}) {
  const res = await fetch(`${GATEWAY}${pathname}`, { headers });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep raw */
  }
  return { status: res.status, headers: res.headers, json, text };
}

function killTree(child) {
  if (!child?.pid) return;
  if (isWin) {
    try {
      execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], () => {});
    } catch { /* ignore */ }
  } else {
    try {
      child.kill("SIGTERM");
    } catch { /* ignore */ }
  }
}

// ---- CDP helper: drive the renderer through the same window.aegis bridge
// the activation wizard uses (Item 19 smoke coverage). ----
const devToolsPortFile = path.join(userData, "DevToolsActivePort");

async function connectCdp() {
  const hasPortFile = await waitFor(() => fs.existsSync(devToolsPortFile), 20_000, "DevToolsActivePort");
  if (!hasPortFile) throw new Error("DevToolsActivePort not written");
  const port = Number(fs.readFileSync(devToolsPortFile, "utf8").split("\n")[0]);
  let target = null;
  const found = await waitFor(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      target = (list ?? []).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      return !!target;
    } catch {
      return false;
    }
  }, 15_000, "cdp page target");
  if (!found) throw new Error("no CDP page target");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("CDP websocket failed"));
  });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  return (expression) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, (msg) => (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)));
      ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    });
}

// ---- main ----
let cleanup = () => {};

async function main() {
  console.log(`[smoke] userData=${userData}`);
  await new Promise((resolve) => mock.listen(MOCK_PORT, "127.0.0.1", resolve));
  console.log(`[smoke] mock control plane on :${MOCK_PORT}`);

  // Back up + write smoke config.
  const backups = {};
  for (const file of ["config.json", "policy-cache.json", "usage-queue.json", "audit-queue.json"]) {
    const full = path.join(userData, file);
    backups[file] = fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
  }
  fs.mkdirSync(userData, { recursive: true });
  fs.rmSync(devToolsPortFile, { force: true });
  fs.writeFileSync(
    path.join(userData, "config.json"),
    JSON.stringify(
      {
        controlPlaneUrl: `http://127.0.0.1:${MOCK_PORT}`,
        deviceKey: "akd_smoke_edge",
        gatewayApiKey: "",
        localPort: 8931,
        locale: "zh",
        checkIntervalMinutes: 15,
      },
      null,
      2
    )
  );
  for (const file of ["policy-cache.json", "usage-queue.json", "audit-queue.json"]) {
    fs.rmSync(path.join(userData, file), { force: true });
  }

  const electron = spawn(
    electronBin,
    [".", "--remote-debugging-port=0", "--remote-allow-origins=*"],
    {
      cwd: root,
      env: { ...process.env, DATA_KEY },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let electronLog = "";
  electron.stdout.on("data", (d) => (electronLog += d.toString()));
  electron.stderr.on("data", (d) => (electronLog += d.toString()));
  electron.on("error", (err) => console.error("[smoke] electron spawn error:", err.message));

  let cleanedUp = false;
  // Standalone-mode test artifacts: only files that did not exist before the
  // test are removed afterwards, so a developer's real local repo survives.
  const localArtifacts = [
    path.join(userData, "local", "credentials.json"),
    path.join(userData, "local", "mcp.json"),
    path.join(userData, "local", "skills.json"),
    path.join(userData, "local", "prices.json"),
    path.join(userData, "local", "agents.json"),
    path.join(userData, "local", ".key"),
    path.join(userData, "usage-totals.json"),
    path.join(userData, "skills"),
  ];
  const preexistingLocal = new Set(localArtifacts.filter((f) => fs.existsSync(f)));
  cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    killTree(electron);
    fs.rmSync(devToolsPortFile, { force: true });
    for (const file of localArtifacts) {
      if (preexistingLocal.has(file)) continue;
      fs.rmSync(file, { recursive: true, force: true });
    }
    for (const [file, content] of Object.entries(backups)) {
      const full = path.join(userData, file);
      if (content === null) fs.rmSync(full, { force: true });
      else fs.writeFileSync(full, content);
    }
  };
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });

  try {
    const up = await waitFor(
      async () => {
        try {
          const res = await fetch(`${GATEWAY}/v1/models`);
          return res.status === 428; // gateway alive, no relay key configured
        } catch {
          return false;
        }
      },
      30_000,
      "local gateway"
    );
    check("gateway starts on 127.0.0.1:8931", up);
    await waitFor(async () => state.bootstrapHits >= 1, 15_000, "bootstrap");
    await sleep(1500); // let bootstrap cache flush to disk

    console.log("\n[smoke] chat completions — edge direct");
    const r1 = await post("/v1/chat/completions", { model: "deepseek-chat", messages: [{ role: "user", content: "hi" }] });
    check("non-stream 200 from edge upstream", r1.status === 200 && r1.json?.id === "chatcmpl-edge-mock", JSON.stringify(r1.json));
    check("x-aegis-mode=edge header", r1.headers.get("x-aegis-mode") === "edge");
    check("x-aegis-trace present", !!r1.headers.get("x-aegis-trace"));

    const r2 = await post("/v1/chat/completions", { model: "deepseek-chat", messages: [{ role: "user", content: "hi" }], stream: true });
    check("stream 200 SSE", r2.status === 200 && (r2.headers.get("content-type") ?? "").startsWith("text/event-stream"));
    check("stream body has chunks + [DONE]", r2.text.includes("chatcmpl-edge-chunk") && r2.text.includes("[DONE]"));

    console.log("\n[smoke] Anthropic /v1/messages adapter (edge)");
    const a1 = await post("/v1/messages", { model: "deepseek-chat", max_tokens: 8, messages: [{ role: "user", content: "hi" }] });
    check("anthropic non-stream 200 message shape", a1.status === 200 && a1.json?.type === "message" && Array.isArray(a1.json?.content), JSON.stringify(a1.json));
    check("anthropic text block + usage mapping", a1.json?.content?.some((b) => b.type === "text") && a1.json?.usage?.input_tokens === 10 && a1.json?.usage?.output_tokens === 5, JSON.stringify(a1.json?.usage));
    const a2 = await post("/v1/messages", { model: "deepseek-chat", max_tokens: 8, messages: [{ role: "user", content: "hi" }], stream: true });
    check("anthropic stream SSE events", a2.status === 200 && a2.text.includes("message_start") && a2.text.includes("content_block_delta") && a2.text.includes("message_stop"), a2.text.slice(0, 120));

    console.log("\n[smoke] local policy enforcement");
    const r3 = await post("/v1/chat/completions", { model: "banned-model", messages: [{ role: "user", content: "hi" }] });
    check("DENY beats ALLOW -> 403 policy_denied", r3.status === 403 && r3.json?.error?.type === "policy_denied", JSON.stringify(r3.json));

    console.log("\n[smoke] conditions expressions (ABAC)");
    const c1 = await post("/v1/chat/completions", { model: "cond-secret", messages: [{ role: "user", content: "hi" }] });
    check("expr match (startsWith) -> 403 policy_denied", c1.status === 403 && c1.json?.error?.type === "policy_denied", JSON.stringify(c1.json));
    const c2 = await post("/v1/chat/completions", { model: "other-model", messages: [{ role: "user", content: "hi" }] });
    check("expr miss -> not policy_denied", c2.status !== 403 || c2.json?.error?.type !== "policy_denied", JSON.stringify(c2.json));

    console.log("\n[smoke] SaaS relay fallback");
    const r4 = await post("/v1/chat/completions", { model: "other-model", messages: [{ role: "user", content: "hi" }] });
    check("no credential match -> relay fallback -> 428 no_api_key", r4.status === 428 && r4.json?.error?.type === "no_api_key", JSON.stringify(r4.json));

    console.log("\n[smoke] usage metering upload (idempotent batch)");
    const metered = await waitFor(async () => state.usageEvents.length >= 2, 20_000, "usage upload");
    check("usage events uploaded to /api/agent/usage", metered, `got ${state.usageEvents.length}`);
    const mine = state.usageEvents.filter((e) => e.apiKeyId === "cred_smoke_1" && e.model === "deepseek-chat");
    check("metered provider/model/token counts", mine.length >= 2 && mine.every((e) => e.provider === "DEEPSEEK" && e.promptTokens === 10 && e.totalTokens === 15 && e.status === "SUCCESS"), JSON.stringify(mine));
    check("eventIds unique (trace ids)", new Set(mine.map((e) => e.eventId)).size === mine.length);
    const frozen = state.usageEvents.length;
    await sleep(4000);
    check("no duplicate re-upload after drain", state.usageEvents.length === frozen, `${frozen} -> ${state.usageEvents.length}`);

    console.log("\n[smoke] skill entitlements");
    const s1 = await post("/v1/skills/use", { skillId: "sk1" });
    check("open skill 200 with content", s1.status === 200 && s1.json?.content === "# summarize skill", JSON.stringify(s1.json));
    const s2 = await post("/v1/skills/use", { skillId: "sk2" });
    check("restricted skill without agentId -> 403 skill_forbidden", s2.status === 403 && s2.json?.error?.type === "skill_denied", JSON.stringify(s2.json));
    const s3 = await post("/v1/skills/use", { skillId: "sk2", agentId: "agent-x" });
    check("restricted skill with allowed agentId -> 200", s3.status === 200 && s3.json?.version === "2.1.0", JSON.stringify(s3.json));
    const s4 = await post("/v1/skills/use", { skillId: "ghost" });
    check("unknown skill -> 403 skill_not_authorized", s4.status === 403 && s4.json?.error?.message?.includes("skill_not_authorized"), JSON.stringify(s4.json));

    console.log("\n[smoke] mcp entitlements");
    const m1 = await post("/v1/mcp/invoke", { mcpId: "mcp1", tool: "get_weather", arguments: {} });
    check("open mcp proxied to instance endpoint", m1.status === 200 && m1.json?.proxied === true && m1.json?.tool === "get_weather", JSON.stringify(m1.json));
    const m2 = await post("/v1/mcp/invoke", { mcpId: "mcp2", tool: "lookup" });
    check("restricted mcp without agentId -> 403 mcp_forbidden", m2.status === 403 && m2.json?.error?.type === "mcp_denied", JSON.stringify(m2.json));
    const m3 = await post("/v1/mcp/invoke", { mcpId: "mcp2", agentId: "agent-hr", tool: "lookup" });
    check("restricted mcp with allowed agentId -> proxied", m3.status === 200 && m3.json?.path === "/mcp/hr", JSON.stringify(m3.json));
    const m4 = await post("/v1/mcp/invoke", { mcpId: "ghost" });
    check("unknown mcp -> 403 mcp_not_authorized", m4.status === 403 && m4.json?.error?.message?.includes("mcp_not_authorized"), JSON.stringify(m4.json));

    console.log("\n[smoke] capability delivery (native client loading)");
    const cap = await get("/v1/capabilities");
    check("capabilities 200", cap.status === 200 && cap.json?.gateway === "aegis-edge", JSON.stringify(cap.json));
    check("capabilities include skill content", cap.json?.skills?.some((s) => s.id === "sk1" && s.content === "# summarize skill"), JSON.stringify(cap.json?.skills));
    check("capabilities honor entitlements + list STDIO", cap.json?.mcp?.length === 2 && cap.json?.mcp?.some((m) => m.transport === "STDIO") && !cap.json?.mcp?.some((m) => m.id === "mcp2"), JSON.stringify(cap.json?.mcp));
    const capHr = await get("/v1/capabilities", { "x-aegis-agent": "agent-hr" });
    check("capabilities with x-aegis-agent include restricted mcp", capHr.json?.mcp?.some((m) => m.id === "mcp2"), JSON.stringify(capHr.json?.mcp));
    check("capabilities never leak upstream token", !cap.text.includes("mcp-upstream-token"));

    const skillFile = path.join(userData, "skills", "summarize", "SKILL.md");
    const skillDoc = fs.existsSync(skillFile) ? fs.readFileSync(skillFile, "utf8") : "";
    check("skill materialized to userData/skills", skillDoc.includes("# summarize skill") && skillDoc.includes("name: summarize"), skillFile);
    check("materialized skill carries aegis marker", fs.existsSync(path.join(userData, "skills", "summarize", ".aegis.json")));

    console.log("\n[smoke] aggregated MCP endpoint (/mcp, streamable HTTP)");
    const init = await post("/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    check("initialize -> protocolVersion + serverInfo", init.status === 200 && init.json?.result?.protocolVersion === "2025-06-18" && init.json?.result?.serverInfo?.name === "aegis-gateway", JSON.stringify(init.json));
    const note = await post("/mcp", { jsonrpc: "2.0", method: "notifications/initialized" });
    check("notification -> 202", note.status === 202);
    const tlAnon = await post("/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const anonNames = (tlAnon.json?.result?.tools ?? []).map((t) => t.name);
    check("tools/list anonymous: open server only, STDIO excluded", anonNames.includes("weather__get_weather") && !anonNames.includes("hr__lookup") && !anonNames.some((n) => n.startsWith("local_fs")), JSON.stringify(anonNames));
    const tlHr = await post("/mcp", { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }, { "x-aegis-agent": "agent-hr" });
    const hrNames = (tlHr.json?.result?.tools ?? []).map((t) => t.name);
    check("tools/list with x-aegis-agent: hr server included", hrNames.includes("hr__lookup") && hrNames.includes("weather__get_weather"), JSON.stringify(hrNames));
    check("high-risk source flagged in description", (tlHr.json?.result?.tools ?? []).find((t) => t.name === "hr__lookup")?.description?.includes("[HIGH]"));
    const call = await post("/mcp", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "weather__get_weather", arguments: {} } });
    check("tools/call routed + result returned", call.status === 200 && call.json?.result?.content?.[0]?.text?.includes("called get_weather"), JSON.stringify(call.json));
    check("upstream bearer token injected by gateway", call.json?.result?.content?.[0]?.text?.includes("Bearer mcp-upstream-token"));
    const badCall = await post("/mcp", { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "ghost__nope", arguments: {} } });
    check("unknown tool -> -32602", badCall.status === 200 && badCall.json?.error?.code === -32602, JSON.stringify(badCall.json));
    const gated = await post("/mcp", { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "hr__lookup", arguments: {} } }, { "x-aegis-agent": "agent-hr" });
    check("approval-gated tool denied offline (-32003)", gated.status === 200 && gated.json?.error?.code === -32003, JSON.stringify(gated.json));

    console.log("\n[smoke] skill injection into chat (x-aegis-inject-skills)");
    state.lastChatBody = null;
    await post("/v1/chat/completions", { model: "deepseek-chat", messages: [{ role: "user", content: "hi" }] }, { "x-aegis-inject-skills": "1" });
    const sysBlocks = (state.lastChatBody?.messages ?? []).filter((m) => m.role === "system").map((m) => String(m.content));
    check("skills appended as trailing system block", sysBlocks.some((c) => c.includes("## Aegis Skills") && c.includes("summarize")), JSON.stringify(sysBlocks).slice(0, 200));

    console.log("\n[smoke] guardrails (content safety + per-key rate limit)");
    const cdp = await connectCdp();
    const rebootstrap = async (expected) => {
      const before = state.bootstrapHits;
      await cdp(`window.aegis.refreshBootstrap()`);
      await waitFor(async () => state.bootstrapHits >= before + 1, 15_000, `re-bootstrap #${expected}`);
      await sleep(800); // let the bootstrap cache flush to disk
    };
    const phonePrompt = { model: "deepseek-chat", messages: [{ role: "user", content: "我的手机号是13812345678，请记录下来" }] };

    state.safetyCfg = { enabled: true, mode: "BLOCK", checks: { phone: true, idCard: false, bankCard: false, ipAddress: false, keywords: true, customRegex: false }, customKeywords: [], customRegexes: [] };
    await rebootstrap(1);
    const g1 = await post("/v1/chat/completions", phonePrompt);
    check("content BLOCK: phone hit -> 403 content_blocked", g1.status === 403 && g1.json?.error?.type === "content_blocked", JSON.stringify(g1.json));
    check("content BLOCK body names the check category only", typeof g1.json?.error?.message === "string" && g1.json.error.message.includes("phone") && !g1.text.includes("13812345678"));

    state.safetyCfg = { ...state.safetyCfg, mode: "AUDIT_ONLY" };
    await rebootstrap(2);
    const g2 = await post("/v1/chat/completions", phonePrompt);
    check("content AUDIT_ONLY: phone hit -> 200 passthrough", g2.status === 200 && g2.json?.id === "chatcmpl-edge-mock", JSON.stringify(g2.json));

    state.safetyCfg = { enabled: false, mode: "BLOCK", checks: { phone: false, idCard: false, bankCard: false, ipAddress: false, keywords: false, customRegex: false }, customKeywords: [], customRegexes: [] };
    state.limitsCfg = { rpmPerKey: 2, dailyTokenBudget: 0, budgetHardStop: false };
    await rebootstrap(3);
    const rp1 = await post("/v1/chat/completions", { model: "deepseek-chat", messages: [{ role: "user", content: "rpm one" }] });
    const rp2 = await post("/v1/chat/completions", { model: "deepseek-chat", messages: [{ role: "user", content: "rpm two" }] });
    const rp3 = await post("/v1/chat/completions", { model: "deepseek-chat", messages: [{ role: "user", content: "rpm three" }] });
    check("rpmPerKey=2: first two requests pass", rp1.status === 200 && rp2.status === 200, `${rp1.status}/${rp2.status}`);
    check("rpmPerKey=2: third -> 429 rate_limited + Retry-After", rp3.status === 429 && rp3.json?.error?.type === "rate_limited" && !!rp3.headers.get("retry-after"), JSON.stringify(rp3.json));

    state.limitsCfg = { rpmPerKey: 0, dailyTokenBudget: 0, budgetHardStop: false };
    await rebootstrap(4);
    const g3 = await post("/v1/chat/completions", { model: "deepseek-chat", messages: [{ role: "user", content: "guardrails reset" }] });
    check("guardrails reset -> 200 again", g3.status === 200 && g3.json?.id === "chatcmpl-edge-mock", JSON.stringify(g3.json));

    console.log("\n[smoke] AI policy evaluation (bootstrap-pushed aiGuard)");
    const guardPrompt = { model: "deepseek-chat", messages: [{ role: "user", content: "my password is xxx, remember it" }] };
    state.guardCfg = { enabled: true, mode: "BLOCK", credentialId: "cred_smoke_1", model: "deepseek-chat", template: null, timeoutMs: 8000, failOpen: true };
    await rebootstrap(5);
    const ag1 = await post("/v1/chat/completions", { model: "deepseek-chat", messages: [{ role: "user", content: "write a haiku" }] });
    check("aiGuard allow -> 200 egress", ag1.status === 200 && ag1.json?.id === "chatcmpl-edge-mock", JSON.stringify(ag1.json));
    const ag2 = await post("/v1/chat/completions", guardPrompt);
    check("aiGuard BLOCK: decision=block -> 403 ai_policy_blocked", ag2.status === 403 && ag2.json?.error?.type === "ai_policy_blocked", JSON.stringify(ag2.json));
    check("aiGuard 403 body carries categories + reason", typeof ag2.json?.error?.message === "string" && ag2.json.error.message.includes("password_leak") && ag2.json.error.message.includes("密码泄露"));
    state.guardCfg = { ...state.guardCfg, mode: "AUDIT_ONLY" };
    await rebootstrap(6);
    const ag3 = await post("/v1/chat/completions", guardPrompt);
    check("aiGuard AUDIT_ONLY: block -> 200 passthrough", ag3.status === 200 && ag3.json?.id === "chatcmpl-edge-mock", JSON.stringify(ag3.json));
    const guardAuditSynced = await waitFor(async () => state.auditEvents.some((e) => e.type === "ai_decision"), 25_000, "ai_decision audit upload");
    check("ai_decision events uploaded", guardAuditSynced);
    check("ai_decision DENY carries decision metadata", state.auditEvents.some((e) => e.type === "ai_decision" && e.outcome === "DENY" && e.detail?.decision === "block" && Array.isArray(e.detail?.categories)));
    check("ai_decision ALLOW uploaded for pass-through call", state.auditEvents.some((e) => e.type === "ai_decision" && e.outcome === "ALLOW"));
    const guardMetered = await waitFor(async () => state.usageEvents.some((e) => e.metadata?.aiGuard === true && e.model === "deepseek-chat"), 25_000, "aiGuard meter upload");
    check("judgment tokens metered with aiGuard flag", guardMetered, JSON.stringify(state.usageEvents.map((e) => e.metadata)));
    state.guardCfg = { enabled: false, mode: "BLOCK", credentialId: null, model: "", template: null, timeoutMs: 8000, failOpen: true };
    await rebootstrap(7);
    const ag4 = await post("/v1/chat/completions", guardPrompt);
    check("aiGuard disabled -> 200 again", ag4.status === 200 && ag4.json?.id === "chatcmpl-edge-mock", JSON.stringify(ag4.json));

    console.log("\n[smoke] edge governance-event upload (per-call audit channel)");
    const auditSynced = await waitFor(async () => {
      const types = new Set(state.auditEvents.map((e) => e.type));
      return types.has("model_response") && types.has("policy_evaluated") && types.has("content_blocked") && types.has("tool_invoked") && types.has("rate_limited");
    }, 25_000, "audit upload");
    check("audit events uploaded to /api/agent/audit", auditSynced, `got ${state.auditEvents.length}`);
    check("deviceMode=connected on reports", state.auditDeviceModes.size === 1 && state.auditDeviceModes.has("connected"), JSON.stringify([...state.auditDeviceModes]));
    const auditTypes = new Set(state.auditEvents.map((e) => e.type));
    check("policy_evaluated covers DENY + ALLOW", state.auditEvents.some((e) => e.type === "policy_evaluated" && e.outcome === "DENY") && state.auditEvents.some((e) => e.type === "policy_evaluated" && e.outcome === "ALLOW"));
    check("policy_evaluated DENY carries reason metadata", state.auditEvents.some((e) => e.type === "policy_evaluated" && e.outcome === "DENY" && typeof e.detail?.reason === "string" && e.detail.reason.length > 0));
    check("content_blocked DENY carries check categories only", state.auditEvents.some((e) => e.type === "content_blocked" && e.outcome === "DENY" && Array.isArray(e.detail?.checks)));
    check("model_response carries trace + token metadata", state.auditEvents.some((e) => e.type === "model_response" && e.traceId && e.detail?.totalTokens === 15 && e.model === "deepseek-chat"));
    check("rate_limited DENY uploaded", auditTypes.has("rate_limited") && state.auditEvents.some((e) => e.type === "rate_limited" && e.outcome === "DENY"));
    check("tool_invoked SUCCESS uploaded for tools/call", state.auditEvents.some((e) => e.type === "tool_invoked" && e.outcome === "SUCCESS" && e.tool === "weather__get_weather"));
    check("tool_invoked DENY uploaded for approval-gated tool", state.auditEvents.some((e) => e.type === "tool_invoked" && e.outcome === "DENY" && e.tool === "hr__lookup"));
    check("eventIds unique (idempotency keys)", new Set(state.auditEvents.map((e) => e.eventId)).size === state.auditEvents.length);
    // No eventId may ever arrive twice: the buffer only re-sends a batch after
    // a non-2xx, and the mock dedupes exactly like the real control plane.
    check("no eventId uploaded twice (idempotent re-upload)", state.auditSeen.size === state.auditEvents.length, `${state.auditSeen.size}/${state.auditEvents.length}`);

    console.log("\n[smoke] update check via public release channel (Item 20)");
    const bridgeReady = await cdp(`typeof window.aegis`);
    check("renderer exposes window.aegis bridge", bridgeReady?.result?.value === "object");
    const updateState = await cdp(`(async () => (await window.aegis.getState()).update)()`);
    const update = updateState?.result?.value;
    check(
      "update info fetched from /api/releases/latest",
      update?.latestVersion === "99.1.0-smoke" && update?.downloadUrl === "https://example.com/aegis-agent.zip",
      JSON.stringify(update)
    );
    check("newer version marked available", update?.updateAvailable === true && update?.currentVersion === "0.1.0");

    console.log("\n[smoke] activation flow via wizard bridge (Item 19)");
    const bad = await cdp(
      `(async () => window.aegis.activate({ platformUrl: "http://127.0.0.1:${MOCK_PORT}", code: "aac_bad", deviceName: "smoke-wizard" }))()`
    );
    check(
      "invalid code -> INVALID_ACTIVATION_CODE, no key stored",
      bad?.result?.value?.ok === false && bad?.result?.value?.error?.code === "INVALID_ACTIVATION_CODE",
      JSON.stringify(bad?.result?.value)
    );
    check("invalid code never reached activate success path", state.activateHits === 0);
    const good = await cdp(
      `(async () => window.aegis.activate({ platformUrl: "http://127.0.0.1:${MOCK_PORT}", code: "aac_good", deviceName: "smoke-wizard" }))()`
    );
    check(
      "valid code -> device issued and returned",
      good?.result?.value?.ok === true && good?.result?.value?.device?.name === "smoke-wizard",
      JSON.stringify(good?.result?.value)
    );
    check("activate endpoint called exactly once (bad code rejected client-side by server)", state.activateHits === 1 && state.activatedName === "smoke-wizard");
    const savedConfig = JSON.parse(fs.readFileSync(path.join(userData, "config.json"), "utf8"));
    check("device key persisted to config.json", savedConfig.deviceKey === "akd_activated_smoke", JSON.stringify(savedConfig));
    check("platform URL persisted to config.json", savedConfig.controlPlaneUrl === `http://127.0.0.1:${MOCK_PORT}`);
    await waitFor(async () => state.bootstrapHits >= 2, 15_000, "re-bootstrap after activation");
    check("bootstrap re-runs with the activated device key", state.bootstrapHits >= 2, `hits=${state.bootstrapHits}`);

    console.log("\n[smoke] commercial layer (license + signed snapshot)");
    const licState = await cdp(`(async () => (await window.aegis.getState()).license)()`);
    const lic = licState?.result?.value;
    check("license verified offline (plan + valid)", lic?.valid === true && lic?.plan === "CLOUD_PRO", JSON.stringify(lic));
    const snapState = await cdp(`(async () => (await window.aegis.getState()).snapshotVerified)()`);
    check("snapshot signature verified", snapState?.result?.value === true, JSON.stringify(snapState?.result?.value));

    console.log("\n[smoke] standalone mode (SaaS-less on-premise autonomy)");
    await cdp(`window.aegis.saveConfig({ mode: "standalone", deviceKey: "" })`);
    const st = await cdp(`(async () => { const s = await window.aegis.getState(); return { mode: s.config.mode, boot: s.bootstrap.status, local: s.local }; })()`);
    check("mode switched to standalone", st?.result?.value?.mode === "standalone", JSON.stringify(st?.result?.value));
    check("bootstrap status standalone (no SaaS calls)", st?.result?.value?.boot === "standalone");

    await cdp(`window.aegis.saveLocalCredential({ provider: "DEEPSEEK", label: "local-prod", baseUrl: "http://127.0.0.1:${MOCK_PORT}/deepseek", models: ["deepseek-chat", "local-model"], apiKey: "sk-edge-fake-key" })`);
    await cdp(`window.aegis.saveLocalSkill({ name: "local-review", description: "local skill", version: "1.0.0", format: "MARKDOWN", content: "# local review skill" })`);
    await cdp(`window.aegis.saveLocalMcp({ name: "local-hr", endpoint: "http://127.0.0.1:${MOCK_PORT}/mcp/hr", transport: "STREAMABLE_HTTP", riskLevel: "HIGH", authType: "NONE", allowedAgentIds: [] })`);
    await cdp(`window.aegis.saveLocalPrice({ model: "local-model", inputPrice: 2, outputPrice: 8, cacheHitPrice: 1 })`);
    await sleep(500);

    console.log("\n[smoke] community local agent registry (offline identity)");
    const issue = await cdp(`(async () => window.aegis.saveLocalAgent({ name: "smoke-agent", type: "SHARED", models: ["deepseek-chat"] }))()`);
    const localToken = issue?.result?.value?.token;
    const localAgentId = issue?.result?.value?.rows?.[0]?.id;
    check("local agent token issued", typeof localToken === "string" && localToken.startsWith("ak_"), JSON.stringify(issue?.result?.value?.rows));
    const capAuth = await get("/v1/capabilities", { authorization: `Bearer ${localToken}` });
    check("local token authenticates against proxy", capAuth.status === 200, `${capAuth.status}`);
    const badAuth = await get("/v1/capabilities", { authorization: "Bearer ak_wrong" });
    check("unknown token -> 401", badAuth.status === 401);
    const denied = await post("/v1/chat/completions", { model: "local-model", messages: [{ role: "user", content: "hi" }] }, { authorization: `Bearer ${localToken}` });
    check("local agent model boundary -> 403", denied.status === 403 && denied.json?.error?.type === "agent_model_denied", JSON.stringify(denied.json));
    const allowed = await post("/v1/chat/completions", { model: "deepseek-chat", messages: [{ role: "user", content: "hi" }] }, { authorization: `Bearer ${localToken}` });
    check("local agent allowed model -> 200 + bound id", allowed.status === 200 && state.lastChatBody?.model === "deepseek-chat", `${allowed.status} agent=${localAgentId?.slice(0, 8)}`);

    const caps2 = await get("/v1/capabilities");
    check("standalone capabilities serve local skill", caps2.json?.skills?.some((s) => s.name === "local-review" && s.content === "# local review skill"), JSON.stringify(caps2.json?.skills));
    const models2 = await get("/v1/models");
    check("standalone /v1/models synthesized from local credentials", models2.json?.data?.some((m) => m.id === "local-model"), JSON.stringify(models2.json?.data));

    state.lastChatBody = null;
    const sc = await post("/v1/chat/completions", { model: "local-model", messages: [{ role: "user", content: "hi" }] }, { "x-aegis-inject-skills": "1" });
    check("standalone chat egresses via local credential", sc.status === 200 && sc.json?.id === "chatcmpl-edge-mock", JSON.stringify(sc.json));
    const sys2 = (state.lastChatBody?.messages ?? []).filter((m) => m.role === "system").map((m) => String(m.content));
    check("standalone skill injection from local repo", sys2.some((c) => c.includes("local-review")), JSON.stringify(sys2).slice(0, 160));
    const noCred = await post("/v1/chat/completions", { model: "unknown-model", messages: [{ role: "user", content: "hi" }] });
    check("standalone unknown model -> 428 no local credential (no SaaS fallback)", noCred.status === 428 && noCred.json?.error?.type === "standalone_no_credential", JSON.stringify(noCred.json));

    const tl2 = await post("/mcp", { jsonrpc: "2.0", id: 7, method: "tools/list", params: {} }, { "x-aegis-agent": "agent-hr" });
    const names2 = (tl2.json?.result?.tools ?? []).map((t) => t.name);
    check("standalone mcp aggregate merges local + cached views", names2.includes("local_hr__lookup") && names2.includes("weather__get_weather"), JSON.stringify(names2));
    const totals = await cdp(`(async () => (await window.aegis.getState()).meterTotals)()`);
    check(
      "standalone billing totals accumulated with local price",
      totals?.result?.value?.events >= 1 && totals?.result?.value?.totalCost > 0 && totals?.result?.value?.promptTokens > 0,
      JSON.stringify(totals?.result?.value)
    );
    const localTrail = fs.existsSync(path.join(userData, "audit-queue.json"))
      ? JSON.parse(fs.readFileSync(path.join(userData, "audit-queue.json"), "utf8"))
      : [];
    check(
      "standalone keeps audit trail local (nothing uploaded as standalone)",
      Array.isArray(localTrail) && localTrail.length > 0 && !state.auditDeviceModes.has("standalone"),
      `queued=${Array.isArray(localTrail) ? localTrail.length : "?"} modes=${JSON.stringify([...state.auditDeviceModes])}`
    );
  } finally {
    cleanup();
    mock.close();
  }

  console.log(`\n[smoke] passed=${passed} failed=${failed}`);
  if (failed > 0) {
    console.log("---- last electron output ----");
    console.log(electronLog.split("\n").slice(-30).join("\n"));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[smoke] fatal:", err);
  try {
    cleanup();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
