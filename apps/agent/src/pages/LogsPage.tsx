import { useEffect, useRef } from "react";
import type { LogEntry } from "../../electron/types";
import type { TFn } from "../App";
import type { Locale } from "../i18n";
import { fmtClock } from "../format";

interface Props {
  t: TFn;
  logs: LogEntry[];
  locale: Locale;
  onClear: () => void;
}

const LEVEL_KEYS = {
  info: "logs.level.info",
  warn: "logs.level.warn",
  error: "logs.level.error",
} as const;

export function LogsPage({ t, logs, locale, onClear }: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs.length]);

  return (
    <div>
      <div className="page-header">
        <h1>{t("logs.title")}</h1>
        <button className="btn secondary" onClick={onClear}>
          {t("logs.clear")}
        </button>
      </div>
      <div className="panel logs-panel" ref={listRef}>
        {logs.length === 0 ? (
          <div className="muted" style={{ padding: 12 }}>
            {t("logs.empty")}
          </div>
        ) : (
          logs.map((entry, i) => (
            <div className="log-line" key={`${entry.ts}-${i}`}>
              <span className="log-time">{fmtClock(entry.ts, locale)}</span>
              <span className={`log-level level-${entry.level}`}>{t(LEVEL_KEYS[entry.level])}</span>
              <span className="log-kind">{entry.kind}</span>
              <span className="log-msg">{entry.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
