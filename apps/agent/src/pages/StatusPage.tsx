import { useState } from "react";
import type { StateSnapshot } from "../../electron/types";
import type { TFn } from "../App";
import type { Locale } from "../i18n";
import { fmtDateTime } from "../format";

interface Props {
  t: TFn;
  state: StateSnapshot;
  locale: Locale;
}

export function StatusPage({ t, state, locale }: Props) {
  const [copied, setCopied] = useState(false);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const checking = state.checking;
  const update = state.update;

  const copyGateway = async () => {
    try {
      await navigator.clipboard.writeText(state.gateway.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  const connectionBadge =
    state.bootstrap.status === "standalone" ? (
      <span className="badge blue">{t("status.modeStandalone")}</span>
    ) : state.bootstrap.status === "ok" && state.online ? (
      <span className="badge green">{t("status.online")}</span>
    ) : state.bootstrap.status === "none" ? (
      <span className="badge gray">{t("status.notConfigured")}</span>
    ) : (
      <span className="badge red">{t("status.offline")}</span>
    );

  return (
    <div>
      <div className="page-header">
        <h1>{t("status.title")}</h1>
        <div className="row">
          <button className="btn secondary" onClick={() => void window.aegis.refreshBootstrap()}>
            {t("status.refreshPolicies")}
          </button>
          <button className="btn" disabled={checking} onClick={() => void window.aegis.runCheckNow()}>
            {checking ? t("status.checking") : t("status.checkNow")}
          </button>
        </div>
      </div>

      {state.bootstrap.status === "error" && (
        <div className="banner warn">{t("status.offlineHint")}</div>
      )}

      {update && update.updateAvailable && !updateDismissed && (
        <div className="banner info">
          <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <div>
                {t("update.newVersion", { latest: update.latestVersion })}
                <span className="muted"> · {t("update.currentVersion", { current: update.currentVersion })}</span>
              </div>
              {update.notes ? (
                <div className="muted" style={{ marginTop: 6, whiteSpace: "pre-line" }}>
                  {t("update.releaseNotes")}: {update.notes}
                </div>
              ) : null}
              {update.downloadUrl ? (
                <button
                  className="btn mini"
                  style={{ marginTop: 8 }}
                  onClick={() => void window.aegis.openExternal(update.downloadUrl)}
                >
                  {t("update.download")}
                </button>
              ) : null}
            </div>
            <button
              type="button"
              className="btn mini secondary"
              onClick={() => setUpdateDismissed(true)}
              title={t("update.dismiss")}
            >
              ✕
            </button>
          </div>
        </div>
      )}

      <div className="cards">
        <div className="card">
          <div className="label">{t("status.connection")}</div>
          <div className="value row" style={{ gap: 8 }}>
            {connectionBadge}
          </div>
          <div className="muted small" style={{ marginTop: 8 }}>
            {state.device ? (
              <>
                <div>
                  {t("status.deviceName")}: {state.device.name}
                </div>
                <div className="mono">{state.device.tenantId}</div>
              </>
            ) : (
              <div>{t("status.device")}: —</div>
            )}
            <div>
              {t("status.lastSuccess")}: {fmtDateTime(state.bootstrap.at, locale)}
            </div>
            {state.bootstrap.error && <div className="error-text">{state.bootstrap.error}</div>}
          </div>
        </div>

        <div className="card">
          <div className="label">{t("status.localGateway")}</div>
          <div className="value">
            <span className={`badge ${state.gateway.running ? "green" : "red"}`}>
              {state.gateway.running ? t("status.gatewayRunning") : t("status.gatewayStopped")}
            </span>
          </div>
          <div className="muted small" style={{ marginTop: 8 }}>
            <div className="row">
              <span className="mono gateway-url">{state.gateway.url}</span>
              <button className="btn mini secondary" onClick={() => void copyGateway()}>
                {copied ? t("status.copied") : t("status.copy")}
              </button>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="label">{t("status.policyCache")}</div>
          <div className="value">
            {state.policies.count} <span className="muted">{t("status.policies")}</span>
          </div>
          <div className="muted small" style={{ marginTop: 8 }}>
            {state.policies.cachedAt ? fmtDateTime(state.policies.cachedAt, locale) : t("status.noCache")}
          </div>
        </div>

        <div className="card">
          <div className="label">{t("status.publicAiCatalog")}</div>
          <div className="value">
            {state.catalog.count} <span className="muted">{t("status.endpoints")}</span>
          </div>
          <div className="muted small" style={{ marginTop: 8 }}>
            {state.catalog.source === "bootstrap"
              ? t("catalog.sourceBootstrap")
              : t("catalog.sourceBuiltin")}
          </div>
        </div>

        <div className="card">
          <div className="label">{t("status.lastCheck")}</div>
          <div className="value">
            {state.lastCheck.at ? (
              <>
                <span className="ok-text">{state.lastCheck.reachable}</span>
                <span className="muted"> {t("status.reachable")} / </span>
                <span className="error-text">{state.lastCheck.unreachable}</span>
                <span className="muted"> {t("status.unreachable")}</span>
              </>
            ) : (
              <span className="muted">{t("status.neverChecked")}</span>
            )}
          </div>
          <div className="muted small" style={{ marginTop: 8 }}>
            {fmtDateTime(state.lastCheck.at, locale)}
          </div>
        </div>

        <div className="card">
          <div className="label">{t("status.mode")}</div>
          <div className="value">
            <span className={`badge ${state.edge.mode === "edge" ? "green" : "gray"}`}>
              {state.edge.mode === "edge" ? t("status.modeEdge") : t("status.modeRelay")}
            </span>{" "}
            <span className={`badge ${state.config.mode === "standalone" ? "blue" : "gray"}`}>
              {state.config.mode === "standalone" ? t("status.modeStandalone") : t("status.modeConnected")}
            </span>
          </div>
          <div className="muted small" style={{ marginTop: 8 }}>
            <div>
              {state.edge.credentials} {t("status.credentials")} · {t("status.mcpSkills", { m: state.edge.mcp, s: state.edge.skills })}
              {" · "}
              {t("status.localRepo", { c: state.local.credentials, m: state.local.mcp, s: state.local.skills })}
            </div>
            <div>
              {t("status.localEndpoint")}: {state.endpoint.hostIp || "—"}:{state.endpoint.gatewayPort}
            </div>
            <div>
              {state.edge.meterPending > 0 ? (
                <span className="badge yellow">{t("status.meterPending", { n: state.edge.meterPending })}</span>
              ) : (
                <span className="muted">{t("status.meterSynced")}</span>
              )}
            </div>
            <div>
              {state.license ? (
                <span className={`badge ${state.license.valid ? "green" : "red"}`}>
                  {t("status.license", { plan: state.license.plan || "?" })}
                </span>
              ) : (
                <span className="muted">{t("status.noLicense")}</span>
              )}{" "}
              <span className={`badge ${state.snapshotVerified ? "green" : "yellow"}`}>
                {state.snapshotVerified ? t("status.snapshotOk") : t("status.snapshotUnverified")}
              </span>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="label">{t("status.syncQueue")}</div>
          <div className="value">
            {state.queue.pending > 0 ? (
              <span className="badge yellow">{t("status.queuePending", { n: state.queue.pending })}</span>
            ) : (
              <span className="badge green">{t("status.queueEmpty")}</span>
            )}
          </div>
        </div>

        <div className="card">
          <div className="label">{t("status.usage")}</div>
          <div className="value">{t("status.usageCost", { cost: state.meterTotals.totalCost.toFixed(4) })}</div>
          <div className="muted small" style={{ marginTop: 8 }}>
            {t("status.usageDetail", {
              n: state.meterTotals.events,
              p: state.meterTotals.promptTokens,
              c: state.meterTotals.completionTokens,
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
