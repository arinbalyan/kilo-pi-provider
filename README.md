# Kilo Provider for Pi (Multi-Account)

Provider extension for [Pi](https://pi.dev) that adds **multi-account round-robin** support for Kilo Gateway models. Rotates through multiple authenticated accounts to distribute rate limits and balance usage.

Forked from [Kilo-Org/kilo-pi-provider](https://github.com/Kilo-Org/kilo-pi-provider).

## Features

- **Multi-account round-robin** — add multiple accounts and distribute requests across them
- **Auto-failover** — on 429 rate limit, account goes into 60s cooldown; next account is picked automatically
- **Balance tracking** — health checks all accounts on session start; depleted accounts are skipped
- **Kilo device auth** — browser-based OAuth login for each account
- **Free models** — use without signing in (limited catalog)
- **Full model catalog** — login to unlock 300+ models

## Prerequisites

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

## Installation

```bash
pi install git:github.com/arinbalyan/kilo-pi-provider
```

## Usage

### Quick start (free models)

```bash
pi
```

Free models work immediately without authentication.

### Add accounts (recommended)

Run `/login kilo` for **each** account you want to add:

```text
/login kilo
```

This opens your browser for device authorization. Repeat for every account. Accounts are stored in `~/.pi/agent/kilo-accounts.json`.

### Strategy

Set which account-selection strategy to use:

```bash
export KILO_STRATEGY=round-robin   # default — cycles through all accounts equally
export KILO_STRATEGY=fill-first    # pick the account with the highest balance
```

### API key fallback

```bash
export KILO_API_KEY=your-key-here
```

### Organization billing

```bash
export KILO_ORG_ID=org_abc123
# or
export KILOCODE_ORGANIZATION_ID=org_abc123
```

### Status indicator

Pi's footer shows account health: `2/4 accts $12.50` means 2 of 4 accounts are healthy with $12.50 total balance.

## How it works

### Account management

Accounts are stored in `~/.pi/agent/kilo-accounts.json` as a JSON array. Each `/login kilo` call adds a new entry. The file is auto-created when the first account is added.

### Request rotation

Every API call goes through `getApiKey()`, which calls `pickAccount()`:

1. Filters out expired, cooldown, or zero-balance accounts
2. If all are excluded, falls back to the full list (ignoring cooldown/balance)
3. Applies strategy: `round-robin` cycles via modulo counter; `fill-first` sorts by balance descending
4. Advances `roundRobinIndex` on every pick

### Rate-limit handling

When a 429 is detected, the account gets a 60s cooldown. After 3 consecutive failures, its balance is set to $0. Success resets the failure counter.

### Balance health checks

On `session_start`, every account's balance is fetched in parallel from `GET /api/profile/balance`. Accounts with $0 balance are excluded until replenished.

## Files

Only three files are shipped:

| File | Purpose |
|---|---|
| `kilo.ts` | Provider extension — ~1100 lines |
| `package.json` | Package metadata and Pi extension registration |
| `README.md` | This file |

## License

[Boost Software License 1.0](https://www.boost.org/LICENSE_1_0.txt)

Derivative of [mrexodia/kilo-pi-provider](https://github.com/mrexodia/kilo-pi-provider) and [Kilo-Org/kilo-pi-provider](https://github.com/Kilo-Org/kilo-pi-provider).
