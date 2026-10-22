import { useCallback, useEffect, useState } from "react";
import type { LogEntry, StateSnapshot } from "../electron/types";
import type { I18nKey, Locale } from "./i18n";
import { translate } from "./i18n";
import { CatalogPage } from "./pages/CatalogPage";
import { LocalPage } from "./pages/LocalPage";
import { LogsPage } from "./pages/LogsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { StatusPage } from "./pages/StatusPage";
import { ActivationPage } from "./pages/ActivationPage";

export type Page = "status" | "local" | "catalog" | "settings" | "logs";
export type TFn = (key: I18nKey, vars?: Record<string, string | number>) => string;

const NAV: { id: Page; label: I18nKey; icon: string }[] = [
  { id: "status", label: "nav.status", icon: "◉" },
  { id: "local", label: "nav.local", icon: "⬡" },
  { id: "catalog", label: "nav.catalog", icon: "▦" },
  { id: "settings", label: "nav.settings", icon: "⚙" },
  { id: "logs", label: "nav.logs", icon: "≡" },
];

export default function App() {
  const [page, setPage] = useState<Page>("status");
  const [locale, setLocale] = useState<Locale>("zh");
  const [state, setState] = useState<StateSnapshot | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  useEffect(() => {
    let mounted = true;
    void window.aegis.getState().then((s) => {
      if (!mounted) return;
      setState(s);
      setLocale(s.config.locale);
    });
    const offState = window.aegis.onState((s) => {
      setState(s);
      setLocale(s.config.locale);
    });
    const offLog = window.aegis.onLog((entry) => {
      setLogs((prev) => [...prev.slice(-499), entry]);
    });
    return () => {
      mounted = false;
      offState();
      offLog();
    };
  }, []);

  const t = useCallback<TFn>((key, vars) => translate(locale, key, vars), [locale]);

  const toggleLocale = useCallback(() => {
    const next: Locale = locale === "zh" ? "en" : "zh";
    setLocale(next);
    void window.aegis.saveConfig({ locale: next }).then(setState).catch(() => {});
  }, [locale]);

  if (!state) {
    return (
      <div className="app-loading">
        <div className="logo">
          <span className="logo-mark">◆</span> Aegis
        </div>
        <p className="muted">{t("app.loading")}</p>
      </div>
    );
  }

  // Item 19: no device key -> the client is not bound to a tenant yet; the
  // activation wizard is the only UI until a valid activation string is used.
  // Standalone (SaaS-less) mode never requires activation.
  if (!state.config.deviceKey && state.config.mode !== "standalone") {
    return <ActivationPage t={t} state={state} locale={locale} onToggleLocale={toggleLocale} />;
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="logo">
          <span className="logo-mark">◆</span> Aegis
        </div>
        <nav className="nav">
          {NAV.map((item) => (
            <button
              key={item.id}
              className={`nav-btn${page === item.id ? " active" : ""}`}
              onClick={() => setPage(item.id)}
            >
              <span className="nav-icon">{item.icon}</span>
              {t(item.label)}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <button className="locale-btn" onClick={toggleLocale} title={t("settings.locale")}>
            {locale === "zh" ? "English" : "中文"}
          </button>
          <span className="version">
            {t("status.version")} {state.version}
          </span>
        </div>
      </aside>
      <main className="content">
        {page === "status" && <StatusPage t={t} state={state} locale={locale} />}
        {page === "local" && <LocalPage t={t} standalone={state.config.mode === "standalone"} />}
        {page === "catalog" && <CatalogPage t={t} state={state} locale={locale} />}
        {page === "settings" && <SettingsPage t={t} state={state} />}
        {page === "logs" && <LogsPage t={t} logs={logs} locale={locale} onClear={() => setLogs([])} />}
      </main>
    </div>
  );
}
