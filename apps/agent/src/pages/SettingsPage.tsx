import { useEffect, useState } from "react";
import type { AgentConfig, StateSnapshot } from "../../electron/types";
import type { LocalCredentialRow } from "../api";
import type { TFn } from "../App";

interface Props {
  t: TFn;
  state: StateSnapshot;
}

export function SettingsPage({ t, state }: Props) {
  const [form, setForm] = useState<AgentConfig>(state.config);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);
  const [credentials, setCredentials] = useState<LocalCredentialRow[]>([]);

  useEffect(() => {
    setForm(state.config);
  }, [state.config]);

  useEffect(() => {
    window.aegis
      .getLocal()
      .then((l) => setCredentials(l.credentials))
      .catch(() => setCredentials([]));
  }, [state.local.credentials]);

  const set = <K extends keyof AgentConfig>(key: K, value: AgentConfig[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setFailed(false);
    try {
      await window.aegis.saveConfig({
        controlPlaneUrl: form.controlPlaneUrl,
        deviceKey: form.deviceKey,
        gatewayApiKey: form.gatewayApiKey,
        localPort: Number(form.localPort) || 8931,
        bindHost: form.bindHost,
        locale: form.locale,
        checkIntervalMinutes: Number(form.checkIntervalMinutes) || 15,
        mode: form.mode,
        materializeSkills: form.materializeSkills,
        materializeClaude: form.materializeClaude,
        materializeWorkBuddy: form.materializeWorkBuddy,
        contentSafety: form.contentSafety,
        limits: {
          rpmPerKey: Math.max(0, Math.floor(Number(form.limits.rpmPerKey) || 0)),
          dailyTokenBudget: Math.max(0, Math.floor(Number(form.limits.dailyTokenBudget) || 0)),
          budgetHardStop: form.limits.budgetHardStop,
        },
        aiGuard: {
          ...form.aiGuard,
          credentialId: form.aiGuard.credentialId || null,
          model: form.aiGuard.model.trim(),
          template: form.aiGuard.template?.trim() ? form.aiGuard.template : null,
          timeoutMs: Math.max(100, Math.floor(Number(form.aiGuard.timeoutMs) || 8000)),
        },
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  const setSafety = (patch: Partial<typeof form.contentSafety>) =>
    setForm((prev) => ({ ...prev, contentSafety: { ...prev.contentSafety, ...patch } }));
  const setSafetyCheck = (key: keyof typeof form.contentSafety.checks, value: boolean) =>
    setForm((prev) => ({ ...prev, contentSafety: { ...prev.contentSafety, checks: { ...prev.contentSafety.checks, [key]: value } } }));
  const setLimits = (patch: Partial<typeof form.limits>) =>
    setForm((prev) => ({ ...prev, limits: { ...prev.limits, ...patch } }));
  const setGuard = (patch: Partial<typeof form.aiGuard>) =>
    setForm((prev) => ({ ...prev, aiGuard: { ...prev.aiGuard, ...patch } }));
  const guardCredential = credentials.find((c) => c.id === form.aiGuard.credentialId);

  const keywordText = form.contentSafety.customKeywords.join("\n");
  const regexText = form.contentSafety.customRegexes.join("\n");
  const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  const regexInvalid = form.contentSafety.customRegexes.some((re) => {
    try {
      new RegExp(re);
      return false;
    } catch {
      return true;
    }
  });

  return (
    <div>
      <div className="page-header">
        <h1>{t("settings.title")}</h1>
        <div className="row">
          {saved && <span className="badge green">{t("settings.saved")}</span>}
          {failed && <span className="badge red">{t("settings.saveFailed")}</span>}
          <button className="btn" disabled={saving} onClick={() => void save()}>
            {saving ? t("settings.saving") : t("settings.save")}
          </button>
        </div>
      </div>

      {/* Flow grid: 1 column on narrow windows, 2 at ~1280px, 3 at ~1920px;
          cards align to the top of each row so uneven heights never gap. The
          top save button still persists every panel in one config write. */}
      <div className="settings-grid">
        <div className="panel form-panel">
          <div className="form-title">{t("settings.section.mode")}</div>
          <div className="form-row">
            <label>{t("settings.mode")}</label>
            <select value={form.mode} onChange={(e) => set("mode", e.target.value as AgentConfig["mode"])}>
              <option value="connected">{t("settings.modeConnected")}</option>
              <option value="standalone">{t("settings.modeStandalone")}</option>
            </select>
            <div className="hint">{form.mode === "standalone" ? t("settings.modeStandaloneHint") : t("settings.modeConnectedHint")}</div>
          </div>
          {form.mode === "connected" ? (
            <>
              <div className="form-row">
                <label>{t("settings.controlPlaneUrl")}</label>
                <input
                  value={form.controlPlaneUrl}
                  placeholder={t("settings.controlPlaneUrlHint")}
                  onChange={(e) => set("controlPlaneUrl", e.target.value)}
                />
              </div>
              <div className="form-row">
                <label>{t("settings.deviceKey")}</label>
                <input
                  value={form.deviceKey}
                  placeholder="akd_…"
                  onChange={(e) => set("deviceKey", e.target.value)}
                />
                <div className="hint">{t("settings.deviceKeyHint")}</div>
              </div>
              <div className="form-row">
                <label>{t("settings.gatewayApiKey")}</label>
                <input
                  value={form.gatewayApiKey}
                  placeholder="ak_…"
                  onChange={(e) => set("gatewayApiKey", e.target.value)}
                />
                <div className="hint">{t("settings.gatewayApiKeyHint")}</div>
              </div>
            </>
          ) : null}
        </div>

        <div className="panel form-panel">
          <div className="form-title">{t("settings.section.local")}</div>
          <div className="form-row-inline cols-2">
            <div className="form-row">
              <label>{t("settings.localPort")}</label>
              <input
                type="number"
                min={1024}
                max={65535}
                value={form.localPort}
                onChange={(e) => set("localPort", Number(e.target.value))}
              />
            </div>
            <div className="form-row">
              <label>{t("settings.bindHost")}</label>
              <input
                value={form.bindHost}
                placeholder="127.0.0.1"
                onChange={(e) => set("bindHost", e.target.value)}
              />
              <div className="hint">{t("settings.bindHostHint")}</div>
            </div>
            <div className="form-row">
              <label>{t("settings.checkInterval")}</label>
              <input
                type="number"
                min={1}
                max={1440}
                value={form.checkIntervalMinutes}
                onChange={(e) => set("checkIntervalMinutes", Number(e.target.value))}
              />
            </div>
            <div className="form-row">
              <label>{t("settings.locale")}</label>
              <select value={form.locale} onChange={(e) => set("locale", e.target.value as AgentConfig["locale"])}>
                <option value="zh">{t("settings.localeZh")}</option>
                <option value="en">{t("settings.localeEn")}</option>
              </select>
            </div>
          </div>
        </div>

        <div className="panel form-panel">
          <div className="form-title">{t("settings.section.materialize")}</div>
          <div className="check-row">
            <label className="check">
              <input
                type="checkbox"
                checked={form.materializeSkills}
                onChange={(e) => set("materializeSkills", e.target.checked)}
              />
              <span>{t("settings.materializeSkills")}</span>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={form.materializeClaude}
                onChange={(e) => set("materializeClaude", e.target.checked)}
              />
              <span>{t("settings.materializeClaude")}</span>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={form.materializeWorkBuddy}
                onChange={(e) => set("materializeWorkBuddy", e.target.checked)}
              />
              <span>{t("settings.materializeWorkBuddy")}</span>
            </label>
          </div>
          <div className="hint">{t("settings.materializeHint")}</div>
        </div>

        <div className="panel form-panel">
          <div className="form-title">{t("settings.section.safety")}</div>
          <div className="hint" style={{ marginTop: 0, marginBottom: 10 }}>{t("settings.guardrailsHint")}</div>
          <div className="check-row">
            <label className="check">
              <input
                type="checkbox"
                checked={form.contentSafety.enabled}
                onChange={(e) => setSafety({ enabled: e.target.checked })}
              />
              <span>{t("settings.csEnabled")}</span>
            </label>
            <select
              value={form.contentSafety.mode}
              disabled={!form.contentSafety.enabled}
              onChange={(e) => setSafety({ mode: e.target.value as "BLOCK" | "AUDIT_ONLY" })}
            >
              <option value="BLOCK">{t("settings.csModeBlock")}</option>
              <option value="AUDIT_ONLY">{t("settings.csModeAudit")}</option>
            </select>
          </div>
          <div className="check-row">
            {(
              [
                ["phone", t("settings.csPhone")],
                ["idCard", t("settings.csIdCard")],
                ["bankCard", t("settings.csBankCard")],
                ["ipAddress", t("settings.csIp")],
                ["keywords", t("settings.csKeywords")],
                ["customRegex", t("settings.csCustomRegex")],
              ] as const
            ).map(([key, label]) => (
              <label className="check" key={key}>
                <input
                  type="checkbox"
                  checked={form.contentSafety.checks[key]}
                  disabled={!form.contentSafety.enabled}
                  onChange={(e) => setSafetyCheck(key, e.target.checked)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
          <label className="muted small">{t("settings.csKeywordsLabel")}</label>
          <textarea
            rows={3}
            value={keywordText}
            disabled={!form.contentSafety.enabled}
            onChange={(e) => setSafety({ customKeywords: lines(e.target.value) })}
          />
          <label className="muted small">{t("settings.csRegexLabel")}</label>
          <textarea
            rows={3}
            value={regexText}
            disabled={!form.contentSafety.enabled}
            onChange={(e) => setSafety({ customRegexes: lines(e.target.value) })}
          />
          {regexInvalid ? <div className="hint">{t("settings.regexInvalid")}</div> : null}
        </div>

        <div className="panel form-panel">
          <div className="form-title">{t("settings.section.limits")}</div>
          <div className="check-row">
            <label className="check">
              <input
                type="number"
                min={0}
                style={{ width: 90 }}
                value={form.limits.rpmPerKey}
                onChange={(e) => setLimits({ rpmPerKey: Number(e.target.value) })}
              />
              <span>{t("settings.rpmPerKey")}</span>
            </label>
            <label className="check">
              <input
                type="number"
                min={0}
                style={{ width: 110 }}
                value={form.limits.dailyTokenBudget}
                onChange={(e) => setLimits({ dailyTokenBudget: Number(e.target.value) })}
              />
              <span>{t("settings.dailyTokenBudget")}</span>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={form.limits.budgetHardStop}
                onChange={(e) => setLimits({ budgetHardStop: e.target.checked })}
              />
              <span>{t("settings.budgetHardStop")}</span>
            </label>
          </div>
        </div>

        <div className="panel form-panel">
          <div className="form-title">{t("settings.aiGuard")}</div>
          <div className="hint" style={{ marginTop: 0, marginBottom: 10 }}>{t("settings.aiGuardHint")}</div>
          <div className="check-row">
            <label className="check">
              <input
                type="checkbox"
                checked={form.aiGuard.enabled}
                onChange={(e) => setGuard({ enabled: e.target.checked })}
              />
              <span>{t("settings.aiGuardEnabled")}</span>
            </label>
            <select
              value={form.aiGuard.mode}
              disabled={!form.aiGuard.enabled}
              onChange={(e) => setGuard({ mode: e.target.value as "BLOCK" | "AUDIT_ONLY" })}
            >
              <option value="BLOCK">{t("settings.aiGuardModeBlock")}</option>
              <option value="AUDIT_ONLY">{t("settings.aiGuardModeAudit")}</option>
            </select>
          </div>
          <div className="form-row-inline cols-2">
            <div className="form-row">
              <label>{t("settings.aiGuardCredential")}</label>
              <select
                value={form.aiGuard.credentialId ?? ""}
                disabled={!form.aiGuard.enabled}
                onChange={(e) => {
                  const id = e.target.value || null;
                  const cred = credentials.find((c) => c.id === id);
                  setGuard({ credentialId: id, model: cred?.models[0] ?? "" });
                }}
              >
                <option value="">{t("settings.aiGuardCredentialNone")}</option>
                {credentials.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label} — {c.models.join(", ") || "any"}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-row">
              <label>{t("settings.aiGuardModel")}</label>
              <input
                list="aegis-guard-models"
                value={form.aiGuard.model}
                disabled={!form.aiGuard.enabled || !form.aiGuard.credentialId}
                onChange={(e) => setGuard({ model: e.target.value })}
              />
              <datalist id="aegis-guard-models">
                {(guardCredential?.models ?? []).map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              <div className="hint">{t("settings.aiGuardModelHint")}</div>
            </div>
          </div>
          <label className="muted small">{t("settings.aiGuardTemplate")}</label>
          <textarea
            rows={5}
            value={form.aiGuard.template ?? ""}
            disabled={!form.aiGuard.enabled}
            placeholder={t("settings.aiGuardTemplateHint")}
            onChange={(e) => setGuard({ template: e.target.value })}
          />
          <div className="form-row-inline">
            <div className="form-row">
              <label>{t("settings.aiGuardTimeout")}</label>
              <input
                type="number"
                min={100}
                max={120000}
                style={{ width: 110 }}
                value={form.aiGuard.timeoutMs}
                disabled={!form.aiGuard.enabled}
                onChange={(e) => setGuard({ timeoutMs: Number(e.target.value) })}
              />
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={form.aiGuard.failOpen}
                disabled={!form.aiGuard.enabled}
                onChange={(e) => setGuard({ failOpen: e.target.checked })}
              />
              <span>{t("settings.aiGuardFailOpen")}</span>
            </label>
          </div>
        </div>
      </div>

      <div className="muted small">{t("settings.note")}</div>
    </div>
  );
}
