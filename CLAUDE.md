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
# Edit config.yaml with Polymarket market URLs (preferred) or explicit market IDs
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

**`client.ts`** is a module-level singleton (not a class). `initClient()` must be called once before any other exported functions are used. Auth requires two CLOB V2 `ClobClient` instances: the first (L1 only) calls `createOrDeriveApiKey()`, then a second is constructed with those creds. EOA mode uses `SignatureTypeV2.EOA`; `POLYMARKET_PROXY_ADDRESS` defaults to `SignatureTypeV2.POLY_GNOSIS_SAFE` with `funderAddress`. `POLYMARKET_SIGNATURE_TYPE` can override the signature type when a proxy wallet needs type 1 or 3.

**`WsManager`** subscribes to the `book` channel for all token IDs over a single connection. It handles: exponential backoff reconnect (1s → 60s max), stale detection (30s no message → terminate), and WS-level ping every 10s. On reconnect it re-sends the subscribe message and emits `'connected'` so all `MarketMaker` instances requote immediately.

**`MarketMaker.requote()`** is the single authoritative path for order placement. The WS `onMidUpdate` path is rate-limited by `min_requote_interval_ms` and gated by a drift threshold (`|newMid - lastQuotedMid| > v × drift_threshold_factor`). When mid is outside `[min_mid_price, max_mid_price]`, existing orders are cancelled and no new ones are placed.

**`config.yaml`** has a `defaults` block and a `markets` array. The recommended setup is to put shared values like `min_size`, `fallback_v`, and timing knobs in `defaults`, then list markets by `url`. `resolveMarketIds()` fills in token/condition IDs from the URL, and `resolveMarketConfig()` merges defaults with any per-market overrides into a `ResolvedMarketConfig`.

### `@polymarket/clob-client-v2` notes

- `initClient()` builds a viem wallet client with `privateKeyToAccount()` and passes a V2 options object into `new ClobClient(...)`
- Market tick size comes from `getClobMarketInfo(conditionId).mts`; rewards spread still comes from `getRawRewardsForMarket(conditionId)`
- `cancelMarketOrders({ market: conditionId })` — requires the `market` key
- `placeLimitOrder()` uses `createAndPostOrder(..., OrderType.GTC)` and passes cached `{ tickSize }` when available
- Order ID in response is `orderID` or `order_id` depending on version
