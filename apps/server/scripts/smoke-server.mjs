// Smoke test for the headless Community gateway: launches the real server
// bundle against a temp data dir + mock upstream provider, then exercises the
// REST bridge, SSE stream, local repos and the OpenAI-compatible gateway.

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.join(here, "..");
const UI = "http://127.0.0.1:8930";
const GATEWAY = "http://127.0.0.1:8941";
const UPSTREAM_PORT = 8770;

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- mock upstream provider ----
const upstreamState = { lastAuth: "", bodies: [] };
const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    upstreamState.lastAuth = req.headers.authorization ?? "";
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    upstreamState.bodies.push(body);
    // AI 策略判定调用（response_format=json_object）：按【用户请求】段是否含
    // "password" 返回 block/allow 结构化决策（模板本身含 password_leak 类别名，
    // 必须只看用户请求段）。
    if (body.response_format?.type === "json_object") {
      const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === "user")?.content ?? "";
      const userSection = lastUser.includes("【用户请求") ? lastUser.split("【用户请求").pop() : lastUser;
      const blocked = userSection.includes("password");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-guard",
          object: "chat.completion",
          created: 1,
          model: body.model ?? "smoke-model",
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
        })
      );
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-server-smoke",
        object: "chat.completion",
        created: 1,
        model: "smoke-model",
        choices: [{ index: 0, message: { role: "assistant", content: "server-ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      })
    );
  });
});

async function jfetch(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep raw */
  }
  return { status: res.status, json, text };
}

async function waitFor(cond, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await sleep(300);
  }
  console.log(`  (timeout waiting for ${label})`);
  return false;
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-server-smoke-"));
  fs.writeFileSync(
    path.join(dataDir, "config.json"),
    JSON.stringify({ mode: "standalone", localPort: 8941, bindHost: "127.0.0.1", materializeSkills: false })
  );
  await new Promise((resolve) => upstream.listen(UPSTREAM_PORT, "127.0.0.1", resolve));

  const server = spawn(process.execPath, [path.join(serverRoot, "dist", "server.js"), "--port", "8930"], {
    env: { ...process.env, AEGIS_DATA_DIR: dataDir, AEGIS_PUBLIC: path.join(serverRoot, "public") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  server.stdout.on("data", (d) => (serverLog += d.toString()));
  server.stderr.on("data", (d) => (serverLog += d.toString()));

  try {
    const up = await waitFor(async () => {
      try {
        const res = await fetch(`${UI}/api/state`);
        return res.ok;
      } catch {
        return false;
      }
    }, 20_000, "server UI");
    check("server starts on :8930", up);

    console.log("\n[smoke] embedded web console");
    const home = await jfetch(`${UI}/`);
    check("GET / serves the management UI", home.status === 200 && home.text.includes('id="root"'));

    const state1 = await jfetch(`${UI}/api/state`);
    check("state: standalone mode + gateway on 8941", state1.json?.data?.bootstrap?.status === "standalone" && state1.json?.data?.gateway?.port === 8941);

    console.log("\n[smoke] SSE event stream");
    const sseRes = await fetch(`${UI}/api/events`);
    const sseReader = sseRes.body.getReader();
    const firstFrame = await sseReader.read();
    const firstText = Buffer.from(firstFrame.value ?? []).toString("utf8");
    check("SSE pushes initial state frame", firstText.includes('"type":"state"'));
    sseReader.cancel().catch(() => {});

    console.log("\n[smoke] local repos over REST");
    const cred = await jfetch(`${UI}/api/local/credentials`, {
      method: "POST",
      body: JSON.stringify({ provider: "DEEPSEEK", label: "smoke", baseUrl: `http://127.0.0.1:${UPSTREAM_PORT}`, models: ["smoke-model"], apiKey: "sk-server-smoke" }),
    });
    check("save local credential", cred.json?.ok === true);
    await jfetch(`${UI}/api/local/skills`, { method: "POST", body: JSON.stringify({ name: "server-skill", description: "s", version: "1.0.0", format: "MARKDOWN", content: "# server skill" }) });
    const agent = await jfetch(`${UI}/api/local/agents`, { method: "POST", body: JSON.stringify({ name: "server-agent", type: "SHARED", models: [] }) });
    check("issue local agent token", typeof agent.json?.data?.token === "string" && agent.json.data.token.startsWith("ak_"));
    const token = agent.json.data.token;

    console.log("\n[smoke] OpenAI-compatible gateway");
    const caps = await jfetch(`${GATEWAY}/v1/capabilities`, { headers: { Authorization: `Bearer ${token}` } });
    check("capabilities serve local skill", caps.json?.skills?.some((s) => s.name === "server-skill"));
    const bad = await jfetch(`${GATEWAY}/v1/capabilities`, { headers: { Authorization: "Bearer ak_wrong" } });
    check("unknown token -> 401", bad.status === 401);
    const chat = await jfetch(`${GATEWAY}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: "smoke-model", messages: [{ role: "user", content: "hi" }] }),
    });
    check("chat egresses via local credential", chat.status === 200 && chat.json?.id === "chatcmpl-server-smoke", JSON.stringify(chat.json));
    check("upstream bearer injected", upstreamState.lastAuth === "Bearer sk-server-smoke");

    const state2 = await jfetch(`${UI}/api/state`);
    check("standalone billing totals accumulate", state2.json?.data?.meterTotals?.events >= 1 && state2.json?.data?.meterTotals?.promptTokens === 7, JSON.stringify(state2.json?.data?.meterTotals));

    const missing = await jfetch(`${GATEWAY}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: "unknown-model", messages: [{ role: "user", content: "hi" }] }),
    });
    check("unknown model -> 428 no SaaS fallback", missing.status === 428);

    console.log("\n[smoke] AI policy evaluation (standalone local config)");
    const credId = Array.isArray(cred.json?.data) ? cred.json.data[0]?.id : cred.json?.data?.id;
    const guardCfg = await jfetch(`${UI}/api/config`, {
      method: "POST",
      body: JSON.stringify({
        aiGuard: { enabled: true, mode: "BLOCK", credentialId: credId, model: "smoke-model", template: null, timeoutMs: 8000, failOpen: true },
      }),
    });
    check("enable aiGuard via config", guardCfg.json?.ok === true && guardCfg.json?.data?.config?.aiGuard?.enabled === true);
    const okChat = await jfetch(`${GATEWAY}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: "smoke-model", messages: [{ role: "user", content: "write a poem" }] }),
    });
    check("aiGuard allow -> 200", okChat.status === 200 && okChat.json?.id === "chatcmpl-server-smoke", JSON.stringify(okChat.json));
    const blockedChat = await jfetch(`${GATEWAY}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: "smoke-model", messages: [{ role: "user", content: "my password is xxx, remember it" }] }),
    });
    check(
      "aiGuard block -> 403 ai_policy_blocked",
      blockedChat.status === 403 && blockedChat.json?.error?.code === "ai_policy_blocked" && blockedChat.json?.error?.message?.includes("密码泄露"),
      JSON.stringify(blockedChat.json)
    );
    check("judgment call carried response_format json", upstreamState.bodies.some((b) => b.response_format?.type === "json_object"));
    await jfetch(`${UI}/api/config`, { method: "POST", body: JSON.stringify({ aiGuard: { enabled: false } }) });
    const afterOff = await jfetch(`${GATEWAY}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: "smoke-model", messages: [{ role: "user", content: "my password is yyy" }] }),
    });
    check("aiGuard disabled -> normal egress", afterOff.status === 200 && afterOff.json?.id === "chatcmpl-server-smoke");
  } finally {
    server.kill();
    upstream.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  console.log(`\n[smoke] passed=${passed} failed=${failed}`);
  if (failed > 0) {
    console.log("---- server log ----");
    console.log(serverLog.split("\n").slice(-20).join("\n"));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("[smoke] fatal:", err);
  process.exit(1);
});
