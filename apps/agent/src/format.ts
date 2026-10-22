import type { Locale } from "./i18n";

export function fmtDateTime(iso: string | null | undefined, locale: Locale): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(locale === "zh" ? "zh-CN" : "en-US", { hour12: false });
}

export function fmtClock(ts: number, locale: Locale): string {
  return new Date(ts).toLocaleTimeString(locale === "zh" ? "zh-CN" : "en-US", { hour12: false });
}
