import type { StateSnapshot } from "../../electron/types";
import type { TFn } from "../App";
import type { Locale } from "../i18n";
import { fmtDateTime } from "../format";

interface Props {
  t: TFn;
  state: StateSnapshot;
  locale: Locale;
}

export function CatalogPage({ t, state, locale }: Props) {
  const byId = new Map(state.results.map((r) => [r.endpointId, r]));
  const checking = state.checking;

  return (
    <div>
      <div className="page-header">
        <h1>
          {t("catalog.title")}
          <span className="muted small" style={{ marginLeft: 10, fontWeight: 400 }}>
            {state.catalog.count} {t("status.endpoints")} · {t("catalog.source")}:{" "}
            {state.catalog.source === "bootstrap" ? t("catalog.sourceBootstrap") : t("catalog.sourceBuiltin")}
          </span>
        </h1>
        <button className="btn" disabled={checking} onClick={() => void window.aegis.runCheckNow()}>
          {checking ? t("status.checking") : t("catalog.checkNow")}
        </button>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t("catalog.name")}</th>
              <th>{t("catalog.category")}</th>
              <th>{t("catalog.vendor")}</th>
              <th>{t("catalog.domains")}</th>
              <th>{t("catalog.reachability")}</th>
              <th>{t("catalog.latency")}</th>
              <th>{t("catalog.checkedAt")}</th>
            </tr>
          </thead>
          <tbody>
            {state.catalog.endpoints.map((ep) => {
              const r = byId.get(ep.id);
              return (
                <tr key={ep.id}>
                  <td className="name-cell">{locale === "zh" ? ep.name.zh : ep.name.en}</td>
                  <td className="muted">{locale === "zh" ? ep.category.zh : ep.category.en}</td>
                  <td className="muted">{ep.vendor}</td>
                  <td className="mono small domains-cell">{ep.domains.join(", ")}</td>
                  <td>
                    {!r ? (
                      <span className="badge gray">{t("catalog.unknown")}</span>
                    ) : r.reachable ? (
                      <span className="badge green">{t("catalog.reachable")}</span>
                    ) : (
                      <span className="badge red">{t("catalog.unreachable")}</span>
                    )}
                  </td>
                  <td className="mono small">{r?.latencyMs != null ? `${r.latencyMs} ms` : "—"}</td>
                  <td className="muted small">{fmtDateTime(r?.checkedAt, locale)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
