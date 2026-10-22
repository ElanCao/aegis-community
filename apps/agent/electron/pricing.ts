import type { LocalStores } from "./localstore";

// Local cost engine (standalone billing). Prices are CNY per 1M tokens, same
// convention as the control plane's PriceVersion. The operator-maintained
// local price table wins; bundled defaults cover DeepSeek's official CNY
// pricing so a fresh standalone proxy bills common models out of the box.

export interface BundledPrice {
  inputPrice: number;
  outputPrice: number;
  cacheHitPrice: number | null;
}

export const BUNDLED_PRICES: Record<string, BundledPrice> = {
  "deepseek-chat": { inputPrice: 2.0, outputPrice: 8.0, cacheHitPrice: 0.5 },
  "deepseek-flash": { inputPrice: 2.0, outputPrice: 8.0, cacheHitPrice: 0.5 },
  "deepseek-reasoner": { inputPrice: 4.0, outputPrice: 16.0, cacheHitPrice: null },
};

export interface UsageSlice {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

export function computeLocalCost(local: LocalStores, model: string, usage: UsageSlice): number {
  const custom = local.listPrices().find((p) => p.model === model);
  const price = custom
    ? { inputPrice: custom.inputPrice, outputPrice: custom.outputPrice, cacheHitPrice: custom.cacheHitPrice }
    : BUNDLED_PRICES[model];
  if (!price) return 0;
  const cached = Math.min(Math.max(0, usage.cachedTokens), usage.promptTokens);
  const inputRate = price.inputPrice;
  const hitRate = price.cacheHitPrice ?? price.inputPrice;
  const cost =
    (cached / 1_000_000) * hitRate +
    ((usage.promptTokens - cached) / 1_000_000) * inputRate +
    (usage.completionTokens / 1_000_000) * price.outputPrice;
  return Math.round(cost * 1_000_000) / 1_000_000;
}
