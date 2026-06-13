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
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

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
import { fetchKiloProfile, fetchKiloBalance } from "./api";
import { loginKilo, refreshKiloToken } from "./auth";
import { cleanModelId, fetchKiloModels } from "./models";
import { makeProviderConfig } from "./provider";

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
}
