import { useState, type FormEvent } from "react";
import type { StateSnapshot } from "../../electron/types";
import type { TFn } from "../App";
import type { Locale } from "../i18n";

function errorText(t: TFn, code: string | undefined, message: string | undefined): string {
  switch (code) {
    case "INVALID_ACTIVATION_CODE":
      return t("activate.error.INVALID_ACTIVATION_CODE");
    case "ACTIVATION_CODE_EXPIRED":
      return t("activate.error.ACTIVATION_CODE_EXPIRED");
    case "ACTIVATION_CODE_USED":
      return t("activate.error.ACTIVATION_CODE_USED");
    case "NETWORK_ERROR":
      return t("activate.error.NETWORK_ERROR");
    case "VALIDATION":
      return t("activate.error.VALIDATION");
    default:
      return t("activate.error.fallback", { msg: message ?? "?" });
  }
}

// First-run onboarding (update.md §4.1: SaaS is optional). The user picks a
// deployment shape up front:
//   - Community / standalone: fully on-premise, no activation, no SaaS
//   - Connected: pair with a control plane via an activation string
export function ActivationPage({
  t,
  state,
  locale,
  onToggleLocale,
}: {
  t: TFn;
  state: StateSnapshot;
  locale: Locale;
  onToggleLocale: () => void;
}) {
  const [choice, setChoice] = useState<"menu" | "connected">("menu");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enterStandalone = async () => {
    setBusy(true);
    setError(null);
    try {
      await window.aegis.saveConfig({ mode: "standalone", deviceKey: "" });
      // State push swaps this wizard for the normal UI (mode=standalone).
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="activate-screen">
      <div className="activate-card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div className="logo">
            <span className="logo-mark">◆</span> Aegis
          </div>
          <button type="button" className="locale-btn" onClick={onToggleLocale} title={t("settings.locale")}>
            {locale === "zh" ? "English" : "中文"}
          </button>
        </div>

        {choice === "menu" ? (
          <>
            <h1 className="activate-title">{t("activate.choiceTitle")}</h1>
            <p className="muted small" style={{ lineHeight: 1.7 }}>
              {t("activate.choiceSubtitle")}
            </p>
            {error ? <div className="banner warn">{error}</div> : null}
            <div style={{ display: "grid", gap: 12, marginTop: 8 }}>
              <button type="button" className="panel" style={{ textAlign: "left", cursor: "pointer", padding: "14px 16px" }} disabled={busy} onClick={() => void enterStandalone()}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>{t("activate.communityTitle")}</div>
                <div className="muted small" style={{ lineHeight: 1.7 }}>{t("activate.communityDesc")}</div>
                <div className="small" style={{ marginTop: 8, color: "var(--accent)" }}>{busy ? t("activate.submitting") : t("activate.communityCta")} →</div>
              </button>
              <button type="button" className="panel" style={{ textAlign: "left", cursor: "pointer", padding: "14px 16px" }} onClick={() => setChoice("connected")}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>{t("activate.connectedTitle")}</div>
                <div className="muted small" style={{ lineHeight: 1.7 }}>{t("activate.connectedDesc")}</div>
                <div className="small" style={{ marginTop: 8, color: "var(--accent)" }}>{t("activate.connectedCta")} →</div>
              </button>
            </div>
          </>
        ) : (
          <ConnectedForm t={t} state={state} onBack={() => setChoice("menu")} />
        )}
      </div>
    </div>
  );
}

function ConnectedForm({ t, state, onBack }: { t: TFn; state: StateSnapshot; onBack: () => void }) {
  const [platformUrl, setPlatformUrl] = useState(state.config.controlPlaneUrl);
  const [code, setCode] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await window.aegis.activate({ platformUrl, code, deviceName });
      if (!res.ok) {
        setError(errorText(t, res.error?.code, res.error?.message));
        setBusy(false);
      }
      // On success the main process persists the device key and pushes a new
      // state snapshot; App then swaps this wizard for the normal UI.
    } catch (err) {
      setError(errorText(t, "NETWORK_ERROR", err instanceof Error ? err.message : String(err)));
      setBusy(false);
    }
  };

  return (
    <>
      <h1 className="activate-title">{t("activate.title")}</h1>
      <p className="muted small" style={{ lineHeight: 1.7 }}>
        {t("activate.subtitle")}
      </p>
      <form onSubmit={submit} className="activate-form">
        <div className="form-row">
          <label>{t("activate.platformUrl")}</label>
          <input
            required
            value={platformUrl}
            placeholder="http://localhost:3000"
            onChange={(e) => setPlatformUrl(e.target.value)}
          />
        </div>
        <div className="form-row">
          <label>{t("activate.code")}</label>
          <input
            required
            value={code}
            placeholder="aac_…"
            autoComplete="off"
            onChange={(e) => setCode(e.target.value)}
          />
        </div>
        <div className="form-row">
          <label>{t("activate.deviceName")}</label>
          <input
            value={deviceName}
            maxLength={100}
            onChange={(e) => setDeviceName(e.target.value)}
          />
          <div className="hint">{t("activate.deviceNameHint")}</div>
        </div>
        {error ? <div className="banner warn">{error}</div> : null}
        <div className="row" style={{ gap: 8 }}>
          <button className="btn" type="button" onClick={onBack}>
            ← {t("activate.back")}
          </button>
          <button className="btn" type="submit" disabled={busy}>
            {busy ? t("activate.submitting") : t("activate.submit")}
          </button>
        </div>
      </form>
    </>
  );
}
