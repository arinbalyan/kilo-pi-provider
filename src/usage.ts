/**
 * Usage tracking: records tokens and cost per account per model.
 *
 * Accumulates data from assistant messages and provides aggregation
 * functions for the /usage-kilo command display.
 */

import type { Usage } from "@earendil-works/pi-ai";

// ── Types ─────────────────────────────────────────────────────────────────

export interface UsageRecord {
  /** Account identifier (email or access token prefix) */
  accountKey: string;
  /** Account email, if available */
  accountEmail: string | undefined;
  /** Model ID as sent to the API */
  modelId: string;
  /** Token usage */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  /** Cost in USD */
  cost: number;
}

export interface ModelAggregate {
  modelId: string;
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

export interface AccountAggregate {
  accountKey: string;
  accountEmail: string | undefined;
  models: ModelAggregate[];
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

// ── Module-Level State ────────────────────────────────────────────────────

const _usageLog: UsageRecord[] = [];

// ── Recording ─────────────────────────────────────────────────────────────

export function recordUsage(
  accountEmail: string | undefined,
  accessToken: string,
  modelId: string,
  usage: Usage,
): void {
  const accountKey = accountEmail || `acct:${accessToken.slice(0, 8)}`;
  _usageLog.push({
    accountKey,
    accountEmail,
    modelId,
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    cost: usage.cost.total,
  });
}

// ── Aggregation ───────────────────────────────────────────────────────────

export function getUsageByAccount(): AccountAggregate[] {
  const byAccount = new Map<string, UsageRecord[]>();

  for (const record of _usageLog) {
    const list = byAccount.get(record.accountKey);
    if (list) {
      list.push(record);
    } else {
      byAccount.set(record.accountKey, [record]);
    }
  }

  const result: AccountAggregate[] = [];

  for (const [accountKey, records] of byAccount) {
    const byModel = new Map<string, UsageRecord[]>();
    for (const r of records) {
      const list = byModel.get(r.modelId);
      if (list) list.push(r);
      else byModel.set(r.modelId, [r]);
    }

    const models: ModelAggregate[] = [];
    let accountRequests = 0;
    let accountInput = 0;
    let accountOutput = 0;
    let accountCacheRead = 0;
    let accountCacheWrite = 0;
    let accountTotalTokens = 0;
    let accountCost = 0;

    for (const [modelId, modelRecords] of byModel) {
      const agg: ModelAggregate = {
        modelId,
        requests: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: 0,
      };

      for (const r of modelRecords) {
        agg.requests++;
        agg.input += r.input;
        agg.output += r.output;
        agg.cacheRead += r.cacheRead;
        agg.cacheWrite += r.cacheWrite;
        agg.totalTokens += r.totalTokens;
        agg.cost += r.cost;
      }

      models.push(agg);
      accountRequests += agg.requests;
      accountInput += agg.input;
      accountOutput += agg.output;
      accountCacheRead += agg.cacheRead;
      accountCacheWrite += agg.cacheWrite;
      accountTotalTokens += agg.totalTokens;
      accountCost += agg.cost;
    }

    result.push({
      accountKey,
      accountEmail: records[0]!.accountEmail,
      models,
      requests: accountRequests,
      input: accountInput,
      output: accountOutput,
      cacheRead: accountCacheRead,
      cacheWrite: accountCacheWrite,
      totalTokens: accountTotalTokens,
      cost: accountCost,
    });
  }

  return result;
}

export function getTotalRequests(): number {
  return _usageLog.length;
}

export function resetUsage(): void {
  _usageLog.length = 0;
}
