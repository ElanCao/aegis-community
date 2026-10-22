import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { LocalAgentRow, LocalCredentialRow, LocalMcpRow, LocalPriceRow, LocalSkillRow, LocalSnapshot } from "../api";
import { VENDOR_CATALOG, vendorLogo, vendorOf } from "../vendor-catalog";
import type { TFn } from "../App";

type Tab = "agents" | "credentials" | "mcp" | "skills" | "prices";

const TABS: { id: Tab; icon: string }[] = [
  { id: "agents", icon: "◉" },
  { id: "credentials", icon: "⚿" },
  { id: "mcp", icon: "⬡" },
  { id: "skills", icon: "✦" },
  { id: "prices", icon: "¥" },
];

type ActionFn = (p: Promise<unknown>, ok: string) => Promise<void>;

// Local capability repository, split into five focused sub-pages (Agent /
// model keys / MCP / Skill / prices) so each stays scannable. In standalone
// mode this is the entire capability source; when connected it merges with
// the SaaS-pushed views, local entries winning on name collision.
export function LocalPage({ t, standalone }: { t: TFn; standalone: boolean }) {
  const [tab, setTab] = useState<Tab>("agents");
  const [data, setData] = useState<LocalSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    window.aegis.getLocal().then(setData).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(load, [load]);

  const run = useCallback(
    async (action: Promise<unknown>, okText: string) => {
      setError(null);
      setNotice(null);
      try {
        await action;
        load();
        setNotice(okText);
        setTimeout(() => setNotice(null), 2000);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [load]
  );

  const counts: Record<Tab, number> = data
    ? { agents: data.agents.length, credentials: data.credentials.length, mcp: data.mcp.length, skills: data.skills.length, prices: data.prices.length }
    : { agents: 0, credentials: 0, mcp: 0, skills: 0, prices: 0 };

  return (
    <div>
      <div className="page-header">
        <h1>{t("local.title")}</h1>
        <div className="row">
          {notice ? <span className="badge green">{notice}</span> : null}
          {standalone ? <span className="badge blue">{t("local.standaloneBadge")}</span> : <span className="badge gray">{t("local.connectedBadge")}</span>}
        </div>
      </div>
      <p className="muted small" style={{ marginBottom: 12 }}>
        {t("local.subtitle")}
      </p>
      {error ? <div className="panel" style={{ marginBottom: 12, color: "var(--red, #c0392b)" }}>{error}</div> : null}

      <div className="stat-grid">
        {TABS.map(({ id }) => (
          <button key={id} type="button" className={`stat-card${tab === id ? " active" : ""}`} onClick={() => setTab(id)}>
            <div className="num">{counts[id]}</div>
            <div className="lbl">{t(`local.tab.${id}`)}</div>
          </button>
        ))}
      </div>

      <div className="local-layout">
        <nav className="local-nav">
          {TABS.map(({ id, icon }) => (
            <button key={id} type="button" className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
              <span>
                {icon} {t(`local.tab.${id}`)}
              </span>
              <span className="count">{counts[id]}</span>
            </button>
          ))}
        </nav>

        <div>
          {!data ? (
            <div className="muted">{t("app.loading")}</div>
          ) : tab === "agents" ? (
            <AgentsTab t={t} rows={data.agents} onAction={run} />
          ) : tab === "credentials" ? (
            <CredentialsTab t={t} rows={data.credentials} onAction={run} />
          ) : tab === "mcp" ? (
            <McpTab t={t} rows={data.mcp} onAction={run} />
          ) : tab === "skills" ? (
            <SkillsTab t={t} rows={data.skills} onAction={run} />
          ) : (
            <PricesTab t={t} rows={data.prices} onAction={run} />
          )}
        </div>
      </div>
    </div>
  );
}

// ---- shared chrome ---------------------------------------------------------

function PanelHead({ title, desc, actionLabel, onAction }: { title: string; desc: string; actionLabel: string; onAction: () => void }) {
  return (
    <div className="panel-head">
      <div>
        <h2>{title}</h2>
        <div className="desc">{desc}</div>
      </div>
      <button type="button" className="btn" onClick={onAction}>
        ＋ {actionLabel}
      </button>
    </div>
  );
}

function RepoTable({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="panel" style={{ padding: "6px 10px" }}>
      <table className="data-table">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
            <th style={{ width: 1 }} />
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

function EmptyRow({ colSpan, text }: { colSpan: number; text: string }) {
  return (
    <tr>
      <td colSpan={colSpan} className="muted" style={{ textAlign: "center", padding: "22px 0" }}>
        {text}
      </td>
    </tr>
  );
}

function VendorLogo({ code, size = 18 }: { code: string; size?: number }) {
  const src = vendorLogo(vendorOf(code)?.domain ?? "");
  if (!src) return <span className="chip">{code}</span>;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
      <img src={src} alt="" width={size} height={size} style={{ borderRadius: 3 }} loading="lazy" />
      <span>{vendorOf(code)?.name ?? code}</span>
    </span>
  );
}

function RowActions({ t, onEdit, onDelete }: { t: TFn; onEdit: () => void; onDelete: () => void }) {
  return (
    <div className="row-actions">
      <button type="button" className="btn" onClick={onEdit}>
        {t("local.edit")}
      </button>{" "}
      <button
        type="button"
        className="btn btn-danger"
        onClick={() => {
          if (window.confirm) {
            if (!window.confirm(t("local.deleteConfirm"))) return;
          }
          onDelete();
        }}
      >
        {t("local.delete")}
      </button>
    </div>
  );
}

// ---- Agents ----------------------------------------------------------------

const EMPTY_AGENT = { name: "", type: "SHARED", models: "" };

function AgentsTab({ t, rows, onAction }: { t: TFn; rows: LocalAgentRow[]; onAction: ActionFn }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_AGENT);
  const [issued, setIssued] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const submit = async () => {
    setIssued(null);
    const savePromise = window.aegis.saveLocalAgent({
      name: form.name,
      type: form.type,
      models: form.models.split(",").map((s) => s.trim()).filter(Boolean),
    });
    await onAction(savePromise, t("local.saved"));
    const res = (await savePromise) as { rows: unknown[]; token: string };
    if (res?.token) {
      setIssued(res.token);
      setForm(EMPTY_AGENT);
      setOpen(false);
    }
  };

  return (
    <div>
      <PanelHead title={t("local.tab.agents")} desc={t("local.tabDesc.agents")} actionLabel={t("local.agent.issue")} onAction={() => setOpen((v) => !v)} />
      {open ? (
        <div className="form-panel">
          <div className="form-title">{t("local.agent.issue")}</div>
          <div className="form-row-inline" style={{ gridTemplateColumns: "2fr 1fr 2fr auto" }}>
            <div className="form-row">
              <label>{t("local.agent.name")}</label>
              <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder={t("local.agent.nameHint")} />
            </div>
            <div className="form-row">
              <label>{t("local.agent.type")}</label>
              <select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))}>
                <option value="SHARED">SHARED</option>
                <option value="USER_SIDE">USER_SIDE</option>
                <option value="CLOUD">CLOUD</option>
                <option value="OTHER">OTHER</option>
              </select>
            </div>
            <div className="form-row">
              <label>{t("local.cred.models")}</label>
              <input value={form.models} onChange={(e) => setForm((f) => ({ ...f, models: e.target.value }))} placeholder={t("local.agent.modelsHint")} />
            </div>
            <div className="form-row" style={{ justifyContent: "flex-end" }}>
              <button type="button" className="btn" onClick={() => void submit()}>
                {t("local.add")}
              </button>
            </div>
          </div>
          <div className="hint" style={{ marginTop: 6 }}>{t("local.agent.hint")}</div>
        </div>
      ) : null}

      {issued ? (
        <div className="panel" style={{ marginBottom: 12, border: "1px solid var(--accent)" }}>
          <div className="small" style={{ marginBottom: 6 }}>
            {t("local.agent.issued")}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <code className="mono" style={{ flex: 1, wordBreak: "break-all" }}>
              {issued}
            </code>
            <button
              type="button"
              className="btn"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(issued);
                } catch {
                  /* ignore */
                }
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? t("local.agent.copied") : t("local.agent.copy")}
            </button>
          </div>
        </div>
      ) : null}

      <RepoTable head={[t("local.agent.name"), t("local.agent.type"), t("local.agent.key"), t("local.cred.models"), t("local.updated")]}>
        {rows.length === 0 ? (
          <EmptyRow colSpan={5} text={t("local.empty")} />
        ) : (
          rows.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td>
                <span className="chip">{r.type}</span>
              </td>
              <td className="mono">{r.keyPrefix}…</td>
              <td className="small">{r.models.join(", ") || "∞"}</td>
              <td className="muted small">{new Date(r.createdAt).toLocaleDateString()}</td>
            </tr>
          ))
        )}
      </RepoTable>
    </div>
  );
}

// ---- Model credentials -----------------------------------------------------

const EMPTY_CRED = { id: "", provider: "DEEPSEEK", label: "", baseUrl: "", apiKey: "", modelsText: "", chips: [] as string[] };

function CredentialsTab({ t, rows, onAction }: { t: TFn; rows: LocalCredentialRow[]; onAction: ActionFn }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_CRED);
  const editing = Boolean(form.id);
  const vendor = vendorOf(form.provider);
  const set = (patch: Partial<typeof EMPTY_CRED>) => setForm((f) => ({ ...f, ...patch }));

  const pickVendor = (code: string) => {
    const v = vendorOf(code);
    setForm((f) => ({ ...f, provider: code, baseUrl: v?.baseUrl || f.baseUrl }));
  };

  const toggleChip = (m: string) =>
    setForm((f) => ({ ...f, chips: f.chips.includes(m) ? f.chips.filter((x) => x !== m) : [...f.chips, m] }));

  const submit = async () => {
    const models = Array.from(new Set([...form.chips, ...form.modelsText.split(",").map((s) => s.trim()).filter(Boolean)]));
    await onAction(
      window.aegis.saveLocalCredential({
        id: form.id || undefined,
        provider: form.provider,
        label: form.label,
        baseUrl: form.baseUrl,
        models,
        apiKey: form.apiKey || undefined,
      }),
      t("local.saved")
    );
    setForm(EMPTY_CRED);
    setOpen(false);
  };

  return (
    <div>
      <PanelHead title={t("local.tab.credentials")} desc={t("local.tabDesc.credentials")} actionLabel={t("local.add")} onAction={() => { setForm(EMPTY_CRED); setOpen((v) => !v); }} />
      {open ? (
        <div className="form-panel">
          <div className="form-title">{editing ? t("local.update") : t("local.tab.credentials")}</div>
          <div className="form-row-inline" style={{ gridTemplateColumns: "1fr 1fr 2fr" }}>
            <div className="form-row">
              <label>{t("local.cred.provider")}</label>
              <select value={form.provider} onChange={(e) => pickVendor(e.target.value)}>
                {VENDOR_CATALOG.map((v) => (
                  <option key={v.code} value={v.code}>
                    {v.name}
                  </option>
                ))}
                {!VENDOR_CATALOG.some((v) => v.code === form.provider) ? <option value={form.provider}>{form.provider}</option> : null}
              </select>
            </div>
            <div className="form-row">
              <label>{t("local.cred.label")}</label>
              <input value={form.label} onChange={(e) => set({ label: e.target.value })} placeholder={t("local.cred.labelHint")} />
            </div>
            <div className="form-row">
              <label>{t("local.cred.baseUrl")}</label>
              <input value={form.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://api.deepseek.com" />
            </div>
          </div>
          <div className="form-row">
            <label>{t("local.cred.models")}</label>
            {vendor && vendor.models.length > 0 ? (
              <div className="model-chips">
                {vendor.models.map((m) => (
                  <label key={m} className={form.chips.includes(m) ? "on" : ""}>
                    <input type="checkbox" checked={form.chips.includes(m)} onChange={() => toggleChip(m)} />
                    {m}
                  </label>
                ))}
              </div>
            ) : null}
            <input
              value={form.modelsText}
              onChange={(e) => set({ modelsText: e.target.value })}
              placeholder={t("local.cred.customModels")}
              style={{ marginTop: vendor && vendor.models.length > 0 ? 8 : 0 }}
            />
            <div className="hint">{t("local.cred.modelsHint")}</div>
          </div>
          <div className="form-row" style={{ display: "flex", justifyContent: "flex-end", gap: 6, alignItems: "flex-end" }}>
            <div className="form-row" style={{ flex: 1, maxWidth: 320, marginBottom: 0 }}>
              <label>{t("local.cred.apiKey")}</label>
              <input type="password" autoComplete="off" value={form.apiKey} onChange={(e) => set({ apiKey: e.target.value })} placeholder={editing ? t("local.cred.keepHint") : "sk-…"} />
            </div>
            <button type="button" className="btn" onClick={() => void submit()}>
              {editing ? t("local.update") : t("local.add")}
            </button>
            {editing ? (
              <button type="button" className="btn" onClick={() => { setForm(EMPTY_CRED); setOpen(false); }}>
                {t("local.cancel")}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <RepoTable head={[t("local.cred.provider"), t("local.cred.label"), t("local.cred.baseUrl"), t("local.cred.models")]}>
        {rows.length === 0 ? (
          <EmptyRow colSpan={4} text={t("local.empty")} />
        ) : (
          rows.map((r) => (
            <tr key={r.id}>
              <td>
                <VendorLogo code={r.provider} />
              </td>
              <td>{r.label}</td>
              <td className="mono">{r.baseUrl}</td>
              <td className="small">{r.models.join(", ") || "∞"}</td>
              <RowActions
                t={t}
                onEdit={() => {
                  const v = vendorOf(r.provider);
                  const listed = new Set(v?.models ?? []);
                  setForm({
                    id: r.id,
                    provider: r.provider,
                    label: r.label,
                    baseUrl: r.baseUrl,
                    apiKey: "",
                    chips: r.models.filter((m) => listed.has(m)),
                    modelsText: r.models.filter((m) => !listed.has(m)).join(", "),
                  });
                  setOpen(true);
                }}
                onDelete={() => void onAction(window.aegis.deleteLocalCredential(r.id), t("local.deleted"))}
              />
            </tr>
          ))
        )}
      </RepoTable>
    </div>
  );
}

// ---- MCP servers -----------------------------------------------------------

const EMPTY_MCP = { id: "", name: "", endpoint: "", transport: "STREAMABLE_HTTP", riskLevel: "MEDIUM", authType: "NONE", authToken: "" };

function McpTab({ t, rows, onAction }: { t: TFn; rows: LocalMcpRow[]; onAction: ActionFn }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_MCP);
  const editing = Boolean(form.id);
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    await onAction(
      window.aegis.saveLocalMcp({
        id: form.id || undefined,
        name: form.name,
        endpoint: form.endpoint,
        transport: form.transport,
        riskLevel: form.riskLevel,
        authType: form.authType,
        authToken: form.authToken || undefined,
        allowedAgentIds: [],
      }),
      t("local.saved")
    );
    setForm(EMPTY_MCP);
    setOpen(false);
  };

  return (
    <div>
      <PanelHead title={t("local.tab.mcp")} desc={t("local.tabDesc.mcp")} actionLabel={t("local.add")} onAction={() => { setForm(EMPTY_MCP); setOpen((v) => !v); }} />
      {open ? (
        <div className="form-panel">
          <div className="form-title">{editing ? t("local.update") : t("local.tab.mcp")}</div>
          <div className="form-row-inline" style={{ gridTemplateColumns: "1fr 2fr 1fr" }}>
            <div className="form-row">
              <label>{t("local.mcp.name")}</label>
              <input value={form.name} onChange={(e) => set("name", e.target.value)} />
            </div>
            <div className="form-row">
              <label>{t("local.mcp.endpoint")}</label>
              <input value={form.endpoint} onChange={(e) => set("endpoint", e.target.value)} placeholder="https://mcp.example.com/mcp" />
            </div>
            <div className="form-row">
              <label>{t("local.mcp.risk")}</label>
              <select value={form.riskLevel} onChange={(e) => set("riskLevel", e.target.value)}>
                {["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="form-row-inline" style={{ gridTemplateColumns: "1fr 1fr 1fr auto" }}>
            <div className="form-row">
              <label>{t("local.mcp.transport")}</label>
              <select value={form.transport} onChange={(e) => set("transport", e.target.value)}>
                <option value="STREAMABLE_HTTP">STREAMABLE_HTTP</option>
                <option value="STDIO">STDIO</option>
              </select>
              <div className="hint">{t("local.mcp.transportHint")}</div>
            </div>
            <div className="form-row">
              <label>{t("local.mcp.authType")}</label>
              <select value={form.authType} onChange={(e) => set("authType", e.target.value)}>
                <option value="NONE">NONE</option>
                <option value="API_KEY">API_KEY</option>
              </select>
            </div>
            <div className="form-row">
              <label>{t("local.mcp.authToken")}</label>
              <input type="password" autoComplete="off" value={form.authToken} onChange={(e) => set("authToken", e.target.value)} placeholder={editing ? t("local.cred.keepHint") : "Bearer …"} />
            </div>
            <div className="form-row" style={{ justifyContent: "flex-end", gap: 6 }}>
              <button type="button" className="btn" onClick={() => void submit()}>
                {editing ? t("local.update") : t("local.add")}
              </button>
              {editing ? (
                <button type="button" className="btn" onClick={() => { setForm(EMPTY_MCP); setOpen(false); }}>
                  {t("local.cancel")}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <RepoTable head={[t("local.mcp.name"), t("local.mcp.endpoint"), t("local.mcp.transport"), t("local.mcp.risk"), t("local.mcp.auth")]}>
        {rows.length === 0 ? (
          <EmptyRow colSpan={5} text={t("local.empty")} />
        ) : (
          rows.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td className="mono">{r.endpoint}</td>
              <td>
                <span className="chip">{r.transport}</span>
              </td>
              <td className="small">{r.riskLevel}</td>
              <td className="small">{r.authType}</td>
              <RowActions
                t={t}
                onEdit={() => {
                  setForm({ id: r.id, name: r.name, endpoint: r.endpoint, transport: r.transport, riskLevel: r.riskLevel, authType: r.authType, authToken: "" });
                  setOpen(true);
                }}
                onDelete={() => void onAction(window.aegis.deleteLocalMcp(r.id), t("local.deleted"))}
              />
            </tr>
          ))
        )}
      </RepoTable>
    </div>
  );
}

// ---- Skills ----------------------------------------------------------------

const EMPTY_SKILL = { id: "", name: "", description: "", version: "1.0.0", format: "MARKDOWN", content: "" };

function SkillsTab({ t, rows, onAction }: { t: TFn; rows: LocalSkillRow[]; onAction: ActionFn }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_SKILL);
  const editing = Boolean(form.id);
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    await onAction(
      window.aegis.saveLocalSkill({
        id: form.id || undefined,
        name: form.name,
        description: form.description,
        version: form.version,
        format: form.format,
        content: form.content,
      }),
      t("local.saved")
    );
    setForm(EMPTY_SKILL);
    setOpen(false);
  };

  return (
    <div>
      <PanelHead title={t("local.tab.skills")} desc={t("local.tabDesc.skills")} actionLabel={t("local.add")} onAction={() => { setForm(EMPTY_SKILL); setOpen((v) => !v); }} />
      {open ? (
        <div className="form-panel">
          <div className="form-title">{editing ? t("local.update") : t("local.tab.skills")}</div>
          <div className="form-row-inline" style={{ gridTemplateColumns: "2fr 1fr 1fr" }}>
            <div className="form-row">
              <label>{t("local.skill.name")}</label>
              <input value={form.name} onChange={(e) => set("name", e.target.value)} />
            </div>
            <div className="form-row">
              <label>{t("local.skill.version")}</label>
              <input value={form.version} onChange={(e) => set("version", e.target.value)} />
            </div>
            <div className="form-row">
              <label>{t("local.skill.format")}</label>
              <select value={form.format} onChange={(e) => set("format", e.target.value)}>
                <option value="MARKDOWN">MARKDOWN</option>
                <option value="CODE">CODE</option>
              </select>
            </div>
          </div>
          <div className="form-row">
            <label>{t("local.skill.description")}</label>
            <input value={form.description} onChange={(e) => set("description", e.target.value)} />
          </div>
          <div className="form-row">
            <label>{t("local.skill.content")}</label>
            <textarea
              rows={7}
              value={form.content}
              onChange={(e) => set("content", e.target.value)}
              style={{ width: "100%", background: "var(--panel-2)", border: "1px solid var(--border)", color: "var(--text)", borderRadius: 6, padding: "8px 10px", fontFamily: "monospace", fontSize: 12, resize: "vertical" }}
            />
          </div>
          <div className="form-row" style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
            <button type="button" className="btn" onClick={() => void submit()}>
              {editing ? t("local.update") : t("local.add")}
            </button>
            {editing ? (
              <button type="button" className="btn" onClick={() => { setForm(EMPTY_SKILL); setOpen(false); }}>
                {t("local.cancel")}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      <RepoTable head={[t("local.skill.name"), t("local.skill.description"), t("local.skill.version"), t("local.updated")]}>
        {rows.length === 0 ? (
          <EmptyRow colSpan={4} text={t("local.empty")} />
        ) : (
          rows.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td className="small">{r.description}</td>
              <td>
                <span className="chip">v{r.version}</span>
              </td>
              <td className="muted small">{new Date(r.updatedAt).toLocaleDateString()}</td>
              <RowActions
                t={t}
                onEdit={() => {
                  setForm({ id: r.id, name: r.name, description: r.description, version: r.version, format: r.format, content: r.content });
                  setOpen(true);
                }}
                onDelete={() => void onAction(window.aegis.deleteLocalSkill(r.id), t("local.deleted"))}
              />
            </tr>
          ))
        )}
      </RepoTable>
    </div>
  );
}

// ---- Prices ----------------------------------------------------------------

const EMPTY_PRICE = { id: "", model: "", inputPrice: "", outputPrice: "", cacheHitPrice: "" };

function PricesTab({ t, rows, onAction }: { t: TFn; rows: LocalPriceRow[]; onAction: ActionFn }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_PRICE);
  const editing = Boolean(form.id);
  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    await onAction(
      window.aegis.saveLocalPrice({
        id: form.id || undefined,
        model: form.model,
        inputPrice: Number(form.inputPrice) || 0,
        outputPrice: Number(form.outputPrice) || 0,
        cacheHitPrice: form.cacheHitPrice === "" ? null : Number(form.cacheHitPrice),
      }),
      t("local.saved")
    );
    setForm(EMPTY_PRICE);
    setOpen(false);
  };

  return (
    <div>
      <PanelHead title={t("local.tab.prices")} desc={t("local.tabDesc.prices")} actionLabel={t("local.add")} onAction={() => { setForm(EMPTY_PRICE); setOpen((v) => !v); }} />
      {open ? (
        <div className="form-panel">
          <div className="form-title">{editing ? t("local.update") : t("local.tab.prices")}</div>
          <div className="form-row-inline" style={{ gridTemplateColumns: "2fr 1fr 1fr 1fr auto" }}>
            <div className="form-row">
              <label>{t("local.price.model")}</label>
              <input value={form.model} onChange={(e) => set("model", e.target.value)} placeholder="deepseek-chat" />
            </div>
            <div className="form-row">
              <label>{t("local.price.input")}</label>
              <input type="number" min={0} step="0.1" value={form.inputPrice} onChange={(e) => set("inputPrice", e.target.value)} />
            </div>
            <div className="form-row">
              <label>{t("local.price.output")}</label>
              <input type="number" min={0} step="0.1" value={form.outputPrice} onChange={(e) => set("outputPrice", e.target.value)} />
            </div>
            <div className="form-row">
              <label>{t("local.price.cacheHit")}</label>
              <input type="number" min={0} step="0.1" value={form.cacheHitPrice} onChange={(e) => set("cacheHitPrice", e.target.value)} placeholder="—" />
            </div>
            <div className="form-row" style={{ justifyContent: "flex-end", gap: 6 }}>
              <button type="button" className="btn" onClick={() => void submit()}>
                {editing ? t("local.update") : t("local.add")}
              </button>
              {editing ? (
                <button type="button" className="btn" onClick={() => { setForm(EMPTY_PRICE); setOpen(false); }}>
                  {t("local.cancel")}
                </button>
              ) : null}
            </div>
          </div>
          <div className="hint" style={{ marginTop: 6 }}>
            {t("local.price.hint")}
          </div>
        </div>
      ) : null}

      <RepoTable head={[t("local.price.model"), t("local.price.input"), t("local.price.output"), t("local.price.cacheHit")]}>
        {rows.length === 0 ? (
          <EmptyRow colSpan={4} text={t("local.price.empty")} />
        ) : (
          rows.map((r) => (
            <tr key={r.id}>
              <td className="mono">{r.model}</td>
              <td>¥{r.inputPrice}</td>
              <td>¥{r.outputPrice}</td>
              <td>{r.cacheHitPrice === null ? "—" : `¥${r.cacheHitPrice}`}</td>
              <RowActions
                t={t}
                onEdit={() => {
                  setForm({ id: r.id, model: r.model, inputPrice: String(r.inputPrice), outputPrice: String(r.outputPrice), cacheHitPrice: r.cacheHitPrice === null ? "" : String(r.cacheHitPrice) });
                  setOpen(true);
                }}
                onDelete={() => void onAction(window.aegis.deleteLocalPrice(r.id), t("local.deleted"))}
              />
            </tr>
          ))
        )}
      </RepoTable>
    </div>
  );
}
