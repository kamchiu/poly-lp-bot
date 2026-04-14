# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Run via ts-node (no build step needed)
npm run build     # Compile TypeScript → dist/
npm run start     # Run compiled output (requires build first)
npm test          # Run all tests (Jest + ts-jest)
npm run test:watch      # Watch mode
npm run test:coverage   # With coverage report
npx tsc --noEmit  # Type-check without emitting
```

There is no test suite or linter configured.

## Setup

```bash
cp .env.example .env        # Fill in PRIVATE_KEY, CHAIN_ID, CLOB_HOST
# Edit config.yaml with real condition_id and yes_token_id values
npm install
npm run dev
```

## Architecture

The bot places resting limit orders on the Polymarket CLOB on both sides (BUY + SELL) around the market midpoint to earn LP rewards. The scoring formula is `S(v,s) = ((v-s)/v)² × b` where `v` is the market's max allowed spread and `s = v × spread_factor`.

### Data flow

```
WsManager (EventEmitter)
  └─ emits 'midUpdate'(tokenId, mid) → MarketMaker.onMidUpdate()
  └─ emits 'connected'              → MarketMaker.requote('ws-reconnect')

MarketMaker (one per market)
  ├─ Trigger 1: WS midUpdate → drift check → requote('drift')
  ├─ Trigger 2: setInterval  → requote('timer')   [fallback, default 3min]
  └─ requote() → cancelMarketOrders() → placeLimitOrder(BUY) + placeLimitOrder(SELL)

client.ts (module-level singleton)
  └─ Two-step init: L1 ClobClient → deriveApiKey → L2 ClobClient with creds
  └─ REST heartbeat every 5s (required or all orders are auto-cancelled by exchange)
```

### Key design decisions

**`client.ts`** is a module-level singleton (not a class). `initClient()` must be called once before any other exported functions are used. Auth requires two `ClobClient` instances: the first (L1 only) calls `createOrDeriveApiKey()`, then a second is constructed with those creds and `SignatureType.EOA`.

**`WsManager`** subscribes to the `book` channel for all token IDs over a single connection. It handles: exponential backoff reconnect (1s → 60s max), stale detection (30s no message → terminate), and WS-level ping every 10s. On reconnect it re-sends the subscribe message and emits `'connected'` so all `MarketMaker` instances requote immediately.

**`MarketMaker.requote()`** is the single authoritative path for order placement. The WS `onMidUpdate` path is rate-limited by `min_requote_interval_ms` and gated by a drift threshold (`|newMid - lastQuotedMid| > v × drift_threshold_factor`). When mid is outside `[min_mid_price, max_mid_price]`, existing orders are cancelled and no new ones are placed.

**`config.yaml`** has a `defaults` block and a `markets` array. Any field in `defaults` can be overridden per-market. `resolveMarketConfig()` in `config.ts` merges these into a `ResolvedMarketConfig` (all fields required).

### `@polymarket/clob-client` notes

- Market fields accessed as `any` casts: `max_spread`, `minimum_tick_size`, `rewards_daily_rate`
- `cancelMarketOrders({ market: conditionId })` — requires the `market` key
- `postOrder(order, 'GTC')` — time-in-force passed as string with `as any`
- Order ID in response is `orderID` or `order_id` depending on version
