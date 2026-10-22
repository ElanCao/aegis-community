// Per-tenant rate limiting + daily token budget (PRD: 限流与预算熔断).
// Both the SaaS relay and each enterprise proxy enforce these locally with
// in-process counters — deliberately NOT distributed: every gateway instance
// applies its own window, which is the documented operational model.

export interface TenantLimits {
  /** 每 API key 每分钟请求上限；0 = 不限。 */
  rpmPerKey: number;
  /** 租户每日 token 预算（input+output 合计）；0 = 不限。 */
  dailyTokenBudget: number;
  /** true = 超预算硬断（429）；false = 只告警一次。 */
  budgetHardStop: boolean;
}

export const DEFAULT_LIMITS: TenantLimits = { rpmPerKey: 0, dailyTokenBudget: 0, budgetHardStop: false };

function nonNegInt(value: unknown, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), max);
}

/** Tolerant parser: any garbage in -> defaults (everything unlimited). */
export function normalizeLimits(raw: unknown): TenantLimits {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_LIMITS };
  const r = raw as Record<string, unknown>;
  return {
    rpmPerKey: nonNegInt(r.rpmPerKey, 1_000_000),
    dailyTokenBudget: nonNegInt(r.dailyTokenBudget, Number.MAX_SAFE_INTEGER),
    budgetHardStop: r.budgetHardStop === true,
  };
}

export interface RateDecision {
  allowed: boolean;
  /** 窗口最早一条记录滑出所需的秒数（超限响应的 Retry-After）。 */
  retryAfterSec: number;
  /** 当前窗口内已计数请求数。 */
  current: number;
}

/** In-process fixed sliding window per key (default 60s). Not distributed. */
export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly windowMs = 60_000,
    private readonly maxKeys = 10_000
  ) {}

  allow(key: string, limitPerMinute: number, now = Date.now()): RateDecision {
    if (!Number.isFinite(limitPerMinute) || limitPerMinute <= 0) {
      return { allowed: true, retryAfterSec: 0, current: 0 };
    }
    let arr = this.hits.get(key);
    const cutoff = now - this.windowMs;
    if (arr) {
      while (arr.length > 0 && arr[0]! <= cutoff) arr.shift();
    } else {
      arr = [];
    }
    if (arr.length >= limitPerMinute) {
      const retryAfterSec = Math.max(1, Math.ceil((arr[0]! + this.windowMs - now) / 1000));
      this.hits.set(key, arr);
      return { allowed: false, retryAfterSec, current: arr.length };
    }
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > this.maxKeys) {
      // bound memory: drop the oldest inserted key (insertion order approximates age)
      const oldest = this.hits.keys().next().value;
      if (oldest !== undefined) this.hits.delete(oldest);
    }
    return { allowed: true, retryAfterSec: 0, current: arr.length };
  }
}

export interface BudgetAddResult {
  used: number;
  /** 本次入账是否首次跨过 80% 阈值（触发一次 budget_threshold 告警）。 */
  crossed80: boolean;
  /** 本次入账是否首次跨过 100% 阈值。 */
  crossed100: boolean;
}

/** In-process per-scope (tenant) daily token counter; resets at local midnight. */
export class DailyTokenBudget {
  private day = "";
  private readonly used = new Map<string, number>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  private roll(): void {
    const d = this.now();
    const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    if (key !== this.day) {
      this.day = key;
      this.used.clear();
    }
  }

  current(scope: string): number {
    this.roll();
    return this.used.get(scope) ?? 0;
  }

  add(scope: string, tokens: number, budget: number): BudgetAddResult {
    this.roll();
    const before = this.used.get(scope) ?? 0;
    const after = before + Math.max(0, Math.floor(tokens));
    this.used.set(scope, after);
    const hasBudget = Number.isFinite(budget) && budget > 0;
    return {
      used: after,
      crossed80: hasBudget && before < budget * 0.8 && after >= budget * 0.8,
      crossed100: hasBudget && before < budget && after >= budget,
    };
  }

  /** Hard-stop gate: budget 已用尽（budget<=0 永不限）。 */
  exhausted(scope: string, budget: number): boolean {
    this.roll();
    return Number.isFinite(budget) && budget > 0 && (this.used.get(scope) ?? 0) >= budget;
  }
}
