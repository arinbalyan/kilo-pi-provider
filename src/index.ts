/**
 * Kilo Provider Extension — Entry Point
 *
 * Registers the "kilo" provider with pi and wires up account management,
 * model loading, OAuth login, and the custom footer display.
 */

import type {
  Api,
  Model,
  OAuthCredentials,
  OAuthLoginCallbacks,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderModelConfig, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import {
  getEnvOrganizationId,
  getEffectiveOrganizationId,
  readStoredKiloCredentials,
  KILO_TOS_URL,
  KILO_ORG_HEADER,
} from "./constants";
import {
  initAccounts,
  _accounts,
  _lastActiveAccount,
  saveAccounts,
  markAccountFailure,
  pickAccount,
} from "./accounts";
import { fetchKiloProfile, fetchKiloBalance, fetchKiloUsage } from "./api";
import { loginKilo, refreshKiloToken } from "./auth";
import { cleanModelId, fetchKiloModels } from "./models";
import { makeProviderConfig } from "./provider";
import {
  recordUsage,
  getUsageByAccount,
  buildAggregates,
  kiloDailyToUsageRecord,
  type AccountAggregate,
  type UsageRecord as UsageRecordType,
} from "./usage";

// =============================================================================
// Extension Entry Point
// =============================================================================

export default async function (pi: ExtensionAPI) {
  initAccounts();
  const storedCredentials = readStoredKiloCredentials();
  const startupOrganizationId = getEffectiveOrganizationId(storedCredentials);

  let freeModels: ProviderModelConfig[] = [];
  let cachedAllModels: ProviderModelConfig[] = [];

  // Use the first available account for model fetching
  const fetchToken = _accounts[0]?.accessToken ?? storedCredentials?.access;

  try {
    if (fetchToken) {
      cachedAllModels = await fetchKiloModels({
        token: fetchToken,
        organizationId: startupOrganizationId,
      });
      freeModels = cachedAllModels.length > 0 ? cachedAllModels : [];
    } else {
      freeModels = await fetchKiloModels({ freeOnly: true });
    }
  } catch (error) {
    console.warn(
      "[kilo] Failed to fetch models at startup:",
      error instanceof Error ? error.message : error,
    );
    if (freeModels.length === 0) {
      try {
        freeModels = await fetchKiloModels({ freeOnly: true });
      } catch {}
    }
  }

  function makeOAuthConfig() {
    return {
      name: "Kilo",
      login: async (callbacks: OAuthLoginCallbacks) => {
        const cred = await loginKilo(callbacks);
        try {
          const organizationId = getEffectiveOrganizationId(cred);
          cachedAllModels = await fetchKiloModels({
            token: cred.access,
            organizationId,
          });
        } catch (error) {
          console.warn(
            "[kilo] Failed to fetch models after login:",
            error instanceof Error ? error.message : error,
          );
        }
        return cred;
      },
      refreshToken: refreshKiloToken,
      getApiKey: (_cred: OAuthCredentials) => {
        // Round-robin through all registered accounts.
        // Each API request picks the next healthy account.
        const account = pickAccount();
        if (!account) return _cred.access; // fallback to pi-stored cred
        return account.accessToken;
      },
      modifyModels: (models: Model<Api>[], cred: OAuthCredentials) => {
        if (cachedAllModels.length === 0) return models;
        const organizationId = getEffectiveOrganizationId(cred);
        const orgHeaders = organizationId
          ? { [KILO_ORG_HEADER]: organizationId }
          : undefined;
        const template = models.find((m) => m.provider === "kilo");
        if (!template) return models;
        const nonKilo = models.filter((m) => m.provider !== "kilo");
        const fullModels = cachedAllModels.map((m) => ({
          ...template,
          id: cleanModelId(m.id),
          name: m.name,
          api: m.api ?? template.api,
          baseUrl: m.baseUrl ?? template.baseUrl,
          reasoning: m.reasoning,
          input: m.input,
          cost: m.cost,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          thinkingLevelMap: m.thinkingLevelMap,
          headers: orgHeaders,
          compat: m.compat,
        }));
        return [...nonKilo, ...fullModels];
      },
    };
  }

  // ── Provider Registration ──────────────────────────────────────────────

  pi.registerProvider("kilo", {
    ...makeProviderConfig(getEnvOrganizationId()),
    models: freeModels,
    oauth: makeOAuthConfig(),
  });

  // ── Session Start: Health Check + Model Refresh ────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    const cred = ctx.modelRegistry.authStorage.get("kilo");

    if (cred?.type !== "oauth") {
      ctx.ui.setStatus("kilo-credits", undefined);
      return;
    }

    // Health check: fetch balance + backfill email for all accounts
    for (const account of _accounts) {
      try {
        if (!account.email) {
          const profile = await fetchKiloProfile(account.accessToken);
          account.email = profile.user?.email || profile.email;
        }
        const balance = await fetchKiloBalance(
          account.accessToken,
          account.accountId,
        );
        if (balance !== null) {
          account.balance = balance;
          account.consecutiveFailures = 0;
          account.cooldownUntil = 0;
        }
      } catch {
        markAccountFailure(account.accessToken);
      }
    }
    saveAccounts();

    try {
      const firstAccount = _accounts[0];
      if (firstAccount) {
        cachedAllModels = await fetchKiloModels({
          token: firstAccount.accessToken,
          organizationId: getEffectiveOrganizationId(cred),
        });
      }
    } catch (error) {
      console.warn(
        "[kilo] Failed to fetch models at session start:",
        error instanceof Error ? error.message : error,
      );
      return;
    }
    if (cachedAllModels.length > 0) {
      ctx.modelRegistry.registerProvider("kilo", {
        ...makeProviderConfig(getEffectiveOrganizationId(cred)),
        models: freeModels,
        oauth: makeOAuthConfig(),
      });
    }
  });

  // ── Track usage from every assistant message ──────────────────────────
  //
  // Tries multiple strategies (message_end + session scan) to capture usage
  // data even when the event payload doesn't include the expected fields.

  pi.on("message_end", async (event, ctx) => {
    const msg = event.message as any;
    if (msg.role !== "assistant") return;
    if (ctx.model?.provider !== "kilo" && msg.provider !== "kilo") return;
    const account = _lastActiveAccount;
    if (!account || !msg.usage) return;
    recordUsage(
      account.email,
      account.accessToken,
      ctx.model?.id ?? msg.model,
      msg.usage,
    );
  });

  // ── Track rate limits from API responses ────────────────────────────
  //
  // When the Kilo API returns 429 (rate-limited), mark the last-used
  // account as failed so pickAccount() skips it during cooldown.

  pi.on("after_provider_response", async (event) => {
    if (event.status !== 429) return;
    const account = _lastActiveAccount;
    if (!account) return;
    markAccountFailure(account.accessToken);
  });

  // ── Unused event stubs ─────────────────────────────────────────────────

  pi.on("model_select", async (_event, _ctx) => {});
  pi.on("turn_end", async (_event, _ctx) => {});

  // ── ToS Notice ─────────────────────────────────────────────────────────

  let tosShown = false;

  pi.on("before_agent_start", async (_event, ctx) => {
    if (tosShown) return;
    if (ctx.model?.provider !== "kilo") return;

    const cred = ctx.modelRegistry.authStorage.get("kilo");
    if (cred?.type === "oauth") {
      tosShown = true;
      return;
    }

    tosShown = true;

    return {
      message: {
        customType: "kilo",
        content: `By using Kilo, you agree to the Terms of Service: ${KILO_TOS_URL}`,
        display: true,
      },
    };
  });

  // ── Footer Render ──────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

      const formatTokens = (count: number): string => {
        if (count < 1000) return count.toString();
        if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
        if (count < 1000000) return `${Math.round(count / 1000)}k`;
        if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
        return `${Math.round(count / 1000000)}M`;
      };

      return {
        dispose() {
          unsubBranch();
        },
        invalidate() {},
        render(width: number): string[] {
          const model = ctx.model;

          let totalInput = 0;
          let totalOutput = 0;
          let totalCacheRead = 0;
          let totalCacheWrite = 0;
          let totalCost = 0;
          for (const entry of ctx.sessionManager.getEntries()) {
            if (
              entry.type === "message" &&
              entry.message.role === "assistant"
            ) {
              totalInput += entry.message.usage.input;
              totalOutput += entry.message.usage.output;
              totalCacheRead += entry.message.usage.cacheRead;
              totalCacheWrite += entry.message.usage.cacheWrite;
              totalCost += entry.message.usage.cost.total;
            }
          }

          const contextUsage = ctx.getContextUsage();
          const contextWindow =
            contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
          const contextPercentValue = contextUsage?.percent ?? 0;
          const contextPercent =
            contextUsage?.percent !== null
              ? contextPercentValue.toFixed(1)
              : "?";

          let pwd = process.cwd();
          const home = process.env.HOME || process.env.USERPROFILE;
          if (home && pwd.startsWith(home))
            pwd = `~${pwd.slice(home.length)}`;
          const branch = footerData.getGitBranch();
          if (branch) pwd = `${pwd} (${branch})`;
          const sessionName = ctx.sessionManager.getSessionName();
          if (sessionName) pwd = `${pwd} \u2022 ${sessionName}`;

          if (pwd.length > width) {
            const half = Math.floor(width / 2) - 2;
            if (half > 1) {
              pwd = `${pwd.slice(0, half)}...${pwd.slice(-(half - 1))}`;
            } else {
              pwd = pwd.slice(0, Math.max(1, width));
            }
          }

          const statsParts: string[] = [];
          if (totalInput)
            statsParts.push(`\u2191${formatTokens(totalInput)}`);
          if (totalOutput)
            statsParts.push(`\u2193${formatTokens(totalOutput)}`);
          if (totalCacheRead)
            statsParts.push(`R${formatTokens(totalCacheRead)}`);
          if (totalCacheWrite)
            statsParts.push(`W${formatTokens(totalCacheWrite)}`);

          const usingSubscription = model
            ? ctx.modelRegistry.isUsingOAuth(model)
            : false;
          if (totalCost || usingSubscription) {
            statsParts.push(
              `$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`,
            );
          }

          const autoIndicator = " (auto)";
          const contextPercentDisplay =
            contextPercent === "?"
              ? `?/${formatTokens(contextWindow)}${autoIndicator}`
              : `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;

          let contextPercentStr: string;
          if (contextPercentValue > 90) {
            contextPercentStr = theme.fg("error", contextPercentDisplay);
          } else if (contextPercentValue > 70) {
            contextPercentStr = theme.fg("warning", contextPercentDisplay);
          } else {
            contextPercentStr = contextPercentDisplay;
          }
          statsParts.push(contextPercentStr);

          if (_lastActiveAccount && _accounts.length > 0) {
            const a = _lastActiveAccount;
            const idx = _accounts.findIndex(
              (x) => x.accessToken === a.accessToken,
            );
            const num =
              idx >= 0
                ? `#${idx + 1}/${_accounts.length}`
                : `#?/${_accounts.length}`;
            const name = a.email ? a.email.split("@")[0] : null;
            const bal =
              a.balance !== null ? `$${a.balance.toFixed(2)}` : "?";
            statsParts.push(
              name ? `${num}:${name} ${bal}` : `${num} ${bal}`,
            );
          }

          let statsLeft = statsParts.join(" ");
          let statsLeftWidth = visibleWidth(statsLeft);

          const modelName = model?.id || "no-model";
          let rightSideWithoutProvider = modelName;
          if (model?.reasoning) {
            const thinkingLevel = pi.getThinkingLevel() || "off";
            rightSideWithoutProvider =
              thinkingLevel === "off"
                ? `${modelName} \u2022 thinking off`
                : `${modelName} \u2022 ${thinkingLevel}`;
          }

          let rightSide = rightSideWithoutProvider;
          if (footerData.getAvailableProviderCount() > 1 && model) {
            rightSide = `(${model.provider}) ${rightSideWithoutProvider}`;
            if (statsLeftWidth + 2 + visibleWidth(rightSide) > width) {
              rightSide = rightSideWithoutProvider;
            }
          }

          if (statsLeftWidth > width) {
            const plainStatsLeft = statsLeft.replace(/\x1b\[[0-9;]*m/g, "");
            statsLeft = `${plainStatsLeft.substring(0, width - 3)}...`;
            statsLeftWidth = visibleWidth(statsLeft);
          }

          const rightSideWidth = visibleWidth(rightSide);
          const totalNeeded = statsLeftWidth + 2 + rightSideWidth;

          let statsLine: string;
          if (totalNeeded <= width) {
            const padding = " ".repeat(
              width - statsLeftWidth - rightSideWidth,
            );
            statsLine = statsLeft + padding + rightSide;
          } else {
            const availableForRight = width - statsLeftWidth - 2;
            if (availableForRight > 3) {
              const plainRight = rightSide.replace(/\x1b\[[0-9;]*m/g, "");
              const truncatedRight = plainRight.substring(
                0,
                availableForRight,
              );
              const padding = " ".repeat(
                width - statsLeftWidth - truncatedRight.length,
              );
              statsLine = statsLeft + padding + truncatedRight;
            } else {
              statsLine = statsLeft;
            }
          }

          const dimStatsLeft = theme.fg("dim", statsLeft);
          const remainder = statsLine.slice(statsLeft.length);
          const dimRemainder = theme.fg("dim", remainder);

          return [theme.fg("dim", pwd), dimStatsLeft + dimRemainder];
        },
      };
    });
  });

  // =============================================================================
  // Usage Report Command
  // =============================================================================

  const SCOPES = [
    { key: "1h",  label: "Last 1 Hour",         since: Date.now() - 60 * 60 * 1000 },
    { key: "24h", label: "Last 24 Hours",       since: Date.now() - 24 * 60 * 60 * 1000 },
    { key: "7d",  label: "Last 7 Days",         since: Date.now() - 7 * 24 * 60 * 60 * 1000 },
  ] as const;

  class UsageReportComponent {
    private scopeAggs: { key: string; label: string; items: AccountAggregate[] }[];
    private dataSource: "api" | "fallback";
    private theme: Theme;
    private onClose: () => void;

    constructor(
      scopeAggs: { key: string; label: string; items: AccountAggregate[] }[],
      dataSource: "api" | "fallback",
      theme: Theme,
      onClose: () => void,
    ) {
      this.scopeAggs = scopeAggs;
      this.dataSource = dataSource;
      this.theme = theme;
      this.onClose = onClose;
    }

    handleInput(data: string): void {
      if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
        this.onClose();
      }
    }

    render(width: number): string[] {
      const lines: string[] = [];
      const th = this.theme;

      // ── Header ───────────────────────────────────────────────────────
      lines.push("");
      const title = `${th.fg("accent", " Kilo Usage Report ")}`;
      const titleWidth = visibleWidth(title);
      const sideLen = Math.max(0, Math.floor((width - titleWidth - 2) / 2));
      const sep = th.fg("borderMuted", "─".repeat(sideLen));
      lines.push(truncateToWidth(`${sep}${title}${sep}`, width));

      // ── Sub-header: data source ──────────────────────────────────────
      const sourceBadge =
        this.dataSource === "api"
          ? th.fg("success", " Kilo API ")
          : th.fg("warning", " fallback (API unavailable) ");
      lines.push(truncateToWidth(`  ${sourceBadge}`, width));
      lines.push("");

      const fmtNum = (n: number): string => {
        if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
        if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
        return n.toLocaleString();
      };

      let anyData = false;

      for (const scope of this.scopeAggs) {
        lines.push(
          truncateToWidth(
            `  ${th.fg("accent", scope.label)}`,
            width,
          ),
        );

        if (scope.items.length === 0) {
          lines.push(
            truncateToWidth(
              `    ${th.fg("dim", "No requests in this period.")}`,
              width,
            ),
          );
          lines.push("");
          continue;
        }

        anyData = true;

        for (const acct of scope.items) {
          const email = acct.accountEmail || th.fg("dim", acct.accountKey);
          // Account health indicator
          const ka = _accounts.find((a) => a.email === acct.accountEmail);
          let healthBadge = "";
          if (ka) {
            const now = Date.now();
            if (ka.cooldownUntil > now) {
              const remaining = Math.ceil((ka.cooldownUntil - now) / 1000);
              healthBadge = th.fg("warning", ` ⏸${remaining}s `);
            } else if (ka.consecutiveFailures >= 3 || (ka.balance !== null && ka.balance <= 0 && ka.cooldownUntil === 0)) {
              healthBadge = th.fg("error", " ✗ ");
            } else {
              healthBadge = th.fg("success", " ✓ ");
            }
          }
          lines.push(
            truncateToWidth(
              `  ${th.fg("accent", "▶")}${healthBadge} ${email}`,
              width,
            ),
          );

          for (const m of acct.models) {
            const modelLabel = th.fg("muted", m.modelId);
            const inputStr = th.fg("text", fmtNum(m.input));
            const outputStr = th.fg("text", fmtNum(m.output));
            const crStr =
              m.cacheRead > 0 ? th.fg("muted", `R:${fmtNum(m.cacheRead)}`) : "";
            const cwStr =
              m.cacheWrite > 0 ? th.fg("muted", `W:${fmtNum(m.cacheWrite)}`) : "";
            const totalStr = th.fg("text", fmtNum(m.totalTokens));
            const costStr =
              m.cost > 0
                ? th.fg("muted", `$${m.cost.toFixed(4)}`)
                : th.fg("dim", "$0");
            const reqStr = th.fg("dim", `${m.requests}x`);

            let detail = `${reqStr} ${modelLabel}`;
            detail += `  ↑${inputStr} ↓${outputStr}`;
            if (crStr) detail += ` ${crStr}`;
            if (cwStr) detail += ` ${cwStr}`;
            detail += `  →${totalStr}`;
            detail += `  ${th.fg("borderMuted", "|")}  ${costStr}`;

            lines.push(truncateToWidth(`    ${detail}`, width));
          }

          const acctTotal = th.fg("text", fmtNum(acct.totalTokens));
          const acctCostStr =
            acct.cost > 0 ? `$${acct.cost.toFixed(4)}` : "$0";
          lines.push(
            truncateToWidth(
              `  ${th.fg("borderMuted", "─".repeat(3))}  ${th.fg("accent", `total: ${acctTotal} tokens, ${acctCostStr}`)}`,
              width,
            ),
          );
          lines.push("");
        }
      }

      if (!anyData) {
        lines.push(
          truncateToWidth(
            `  ${th.fg("dim", "No usage data yet. Start a conversation with a Kilo model.")}`,
            width,
          ),
        );
        lines.push("");
      }

      lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
      lines.push("");
      return lines;
    }

    invalidate(): void {}
  }

  pi.registerCommand("usage-kilo", {
    description: "Show token usage per account and per model across Last 1 Hour, Last 24 Hours, and Last 7 Days",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/usage-kilo requires interactive mode", "error");
        return;
      }

      // ═══════════════════════════════════════════════════════════════
      // 1. Always scan session entries for per-model per-request data
      //    (has real timestamps so 1h/24h/7d filtering is accurate)
      // ═══════════════════════════════════════════════════════════════
      const allRecords: UsageRecordType[] = [];

      for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type !== "message") continue;
        const msg = entry.message as any;
        if (msg.role !== "assistant") continue;
        // Kilo models have IDs like "google/gemini-2.0-flash" (with "/").
        // Accept if: current model is Kilo, OR message has "kilo" provider,
        // OR model name has "/" (OpenRouter-style, used by Kilo).
        const msgModel = msg.model ?? "";
        const hasSlash = msgModel.includes("/");
        if (ctx.model?.provider !== "kilo" && msg.provider !== "kilo" && !hasSlash) continue;
        if (!msg.usage) continue;
        if (!msgModel) continue;

        // Use the first account for attribution (most accurate available)
        const account = _accounts[0] ?? _lastActiveAccount;
        if (!account) continue;

        allRecords.push({
          accountKey: account.email || `acct:${account.accessToken.slice(0, 8)}`,
          accountEmail: account.email,
          modelId: msgModel,
          input: msg.usage.input,
          output: msg.usage.output,
          cacheRead: msg.usage.cacheRead,
          cacheWrite: msg.usage.cacheWrite,
          totalTokens: msg.usage.totalTokens,
          cost: msg.usage.cost.total,
          requestCount: 1,
          timestamp: new Date(entry.timestamp).getTime(),
        });
      }

      // ═══════════════════════════════════════════════════════════════
      // 2. ALSO fetch Kilo API daily aggregates for overall totals
      //    (per-account, not per-model — marked as "↑all models↑")
      // ═══════════════════════════════════════════════════════════════
      let apiSucceeded = false;
      for (const account of _accounts) {
        if (!account.accessToken) continue;
        const dailyData = await fetchKiloUsage(
          account.accessToken,
          account.accountId,
        );
        for (const day of dailyData) {
          apiSucceeded = true;
          allRecords.push(kiloDailyToUsageRecord(day, account.email, account.accessToken));
        }
      }

      // ═══════════════════════════════════════════════════════════════
      // 3. Build per-scope aggregates
      // ═══════════════════════════════════════════════════════════════
      const scopeAggs = SCOPES.map((s) => ({
        key: s.key,
        label: s.label,
        items: buildAggregates(allRecords, s.since),
      }));

      const dataSource: "api" | "fallback" = apiSucceeded ? "api" : "fallback";

      await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
        return new UsageReportComponent(
          scopeAggs,
          dataSource,
          theme,
          () => done(),
        );
      });
    },
  });
}
