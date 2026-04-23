/**
 * market-scanner.ts
 *
 * Discovers Polymarket CLOB rewards markets that match configurable criteria,
 * scores them by expected LP profitability, and writes the top N into config.yaml.
 *
 * Run: npx ts-node src/market-scanner.ts [--count N]
 *      npm run scan -- --count 5
 *
 * No private key or CLOB auth required — all data comes from the public
 * /rewards/markets/multi endpoint which includes token IDs, prices, slugs, and
 * market_competitiveness directly.
 */

import * as fs from 'fs';
import * as https from 'https';
import * as yaml from 'js-yaml';

// ---------------------------------------------------------------------------
// Tunable constants — edit here instead of using CLI flags
// ---------------------------------------------------------------------------

/** Minimum aggregate daily reward rate in USDC to consider a market (inclusive). */
const MIN_DAILY_RATE = 20;

/** Maximum aggregate daily reward rate in USDC to consider a market (inclusive). */
const MAX_DAILY_RATE = 1500;

/** Maximum rewards_min_size (shares) a market may require. */
const MAX_MIN_SHARES = 50;

/**
 * 24-hour volume range (USD). Too low → thin book, snipe risk. Too high → hot/volatile market.
 */
const MIN_VOLUME_24H = 800;
const MAX_VOLUME_24H = 800_000;

/** Mid-price must stay inside [MIN_MID, MAX_MID] to avoid near-resolved markets. */
const MIN_MID = 0.1;
const MAX_MID = 0.9;

/**
 * Maximum market_competitiveness value (from CLOB API).
 * Maps to the 5-bar progress shown on Polymarket UI — lower = less crowded.
 * ≤30 ≈ 1–2 bars (low competition). Raise if you want to include busier markets.
 */
const MAX_COMPETITIVENESS = 15;

/** Exclude markets whose catalyst / resolution date is too close. */
const MIN_DAYS_TO_EVENT = 14;

/** Optional exact slug filters. Empty = no manual allow/deny list. */
const WHITELIST_SLUGS: string[] = [];
const BLACKLIST_SLUGS: string[] = [];

/** Optional substring filters matched against question / event_slug / market_slug. */
const WHITELIST_KEYWORDS: string[] = [];
const BLACKLIST_KEYWORDS: string[] = [];

/** Default number of markets to write into config.yaml (overridden by --count). */
const DEFAULT_COUNT = 5;

// ---------------------------------------------------------------------------
// Public CLOB REST base (no auth needed)
// ---------------------------------------------------------------------------
const CLOB_HOST = 'https://clob.polymarket.com';

// ---------------------------------------------------------------------------
// Proxy support (mirrors config.ts)
// ---------------------------------------------------------------------------
const proxyUrl = process.env.https_proxy ?? process.env.HTTPS_PROXY;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const proxyAgent = proxyUrl ? new (require('https-proxy-agent').HttpsProxyAgent)(proxyUrl) : undefined;

function httpsGet(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const options: https.RequestOptions = proxyAgent ? { agent: proxyAgent } : {};
    const req = https.get(url, options, res => {
      let raw = '';
      res.on('data', chunk => (raw += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error(`JSON parse error for ${url}: ${(e as Error).message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error(`Timeout: ${url}`)));
  });
}

// ---------------------------------------------------------------------------
// CLOB /rewards/markets/multi types
// ---------------------------------------------------------------------------
interface RewardsConfig {
  asset_address: string;
  start_date: string;
  end_date: string;    // "2500-12-31" = perpetual/no fixed expiry
  rate_per_day: number;
  total_rewards: number;
  id: number;
}

interface MarketToken {
  token_id: string;
  outcome: string;  // "Yes" | "No"
  price: number;
}

export interface MarketReward {
  condition_id: string;
  market_id?: string;
  question?: string;
  market_slug?: string;
  event_slug?: string;
  market_competitiveness: number;
  rewards_config: RewardsConfig[];
  rewards_max_spread: number;  // percentage, e.g. 3.5 → blue line at 0.035
  rewards_min_size: number;
  tokens: MarketToken[];       // always populated in /multi endpoint
  volume_24hr: number;
  end_date?: string;           // e.g. "2025-12-31 12:00:00+00"
  spread?: number;             // current orderbook ask−bid (decimal, e.g. 0.01)
}

interface PaginationPayload {
  limit: number;
  count: number;
  next_cursor: string;
  data: MarketReward[];
}

// ---------------------------------------------------------------------------
// Fetch all rewards markets from /rewards/markets/multi (paginated)
// ---------------------------------------------------------------------------
async function fetchAllMultiRewards(): Promise<MarketReward[]> {
  const PAGE_SIZE = 500;
  const END_CURSOR = 'LTE=';

  let results: MarketReward[] = [];
  let next_cursor = 'MA==';

  while (next_cursor !== END_CURSOR) {
    const url = `${CLOB_HOST}/rewards/markets/multi?page_size=${PAGE_SIZE}&next_cursor=${encodeURIComponent(next_cursor)}`;
    const resp = await httpsGet(url) as PaginationPayload;
    if (!Array.isArray(resp.data) || resp.data.length === 0) break;
    results = [...results, ...resp.data];
    next_cursor = resp.next_cursor ?? END_CURSOR;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Scored market result
// ---------------------------------------------------------------------------
interface ScoredMarket {
  reward: MarketReward;   // representative condition_id for this token
  mid: number;
  dailyRate: number;      // aggregate rate across all sponsors for this token
  competitiveness: number;
  score: number;
  yesTokenId: string;
  noTokenId: string;
}

interface ManualSelectionFilters {
  whitelistSlugs?: string[];
  blacklistSlugs?: string[];
  whitelistKeywords?: string[];
  blacklistKeywords?: string[];
  minDaysToEvent?: number;
}

const DEFAULT_MANUAL_FILTERS: Required<ManualSelectionFilters> = {
  whitelistSlugs: WHITELIST_SLUGS,
  blacklistSlugs: BLACKLIST_SLUGS,
  whitelistKeywords: WHITELIST_KEYWORDS,
  blacklistKeywords: BLACKLIST_KEYWORDS,
  minDaysToEvent: MIN_DAYS_TO_EVENT,
};

function normalizeText(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  if (isNaN(date.getTime()) || date.getUTCFullYear() >= 2400) return null;
  return date;
}

function getMarketText(reward: MarketReward): string {
  return [
    reward.question,
    reward.market_slug,
    reward.event_slug,
  ].map(normalizeText).join(' ');
}

export function passesManualSelection(
  reward: MarketReward,
  filters: ManualSelectionFilters = DEFAULT_MANUAL_FILTERS
): boolean {
  const whitelistSlugs = (filters.whitelistSlugs ?? []).map(normalizeText).filter(Boolean);
  const blacklistSlugs = (filters.blacklistSlugs ?? []).map(normalizeText).filter(Boolean);
  const whitelistKeywords = (filters.whitelistKeywords ?? []).map(normalizeText).filter(Boolean);
  const blacklistKeywords = (filters.blacklistKeywords ?? []).map(normalizeText).filter(Boolean);

  const marketSlug = normalizeText(reward.market_slug);
  const eventSlug = normalizeText(reward.event_slug);
  const marketText = getMarketText(reward);

  if (blacklistSlugs.includes(marketSlug) || blacklistSlugs.includes(eventSlug)) return false;
  if (blacklistKeywords.some(keyword => marketText.includes(keyword))) return false;

  const hasWhitelist = whitelistSlugs.length > 0 || whitelistKeywords.length > 0;
  if (!hasWhitelist) return true;

  return (
    whitelistSlugs.includes(marketSlug) ||
    whitelistSlugs.includes(eventSlug) ||
    whitelistKeywords.some(keyword => marketText.includes(keyword))
  );
}

export function getDaysToEvent(reward: MarketReward, now: Date = new Date()): number | null {
  const candidateDates = [
    parseDate(reward.end_date),
    ...reward.rewards_config.map(cfg => parseDate(cfg.end_date)),
  ].filter((date): date is Date => date !== null);

  if (candidateDates.length === 0) return null;

  const eventDate = candidateDates.reduce((earliest, current) =>
    current.getTime() < earliest.getTime() ? current : earliest
  );
  return (eventDate.getTime() - now.getTime()) / 86_400_000;
}

export function isNearCatalyst(
  reward: MarketReward,
  now: Date = new Date(),
  minDaysToEvent: number = MIN_DAYS_TO_EVENT
): boolean {
  const daysToEvent = getDaysToEvent(reward, now);
  return daysToEvent !== null && daysToEvent < minDaysToEvent;
}

/**
 * Validate and score a market.
 * `aggregateDailyRate` is the sum of rate_per_day across ALL condition_ids that
 * share the same underlying YES token (multiple sponsors of the same market).
 */
export function scoreMarket(
  reward: MarketReward,
  aggregateDailyRate: number,
  now: Date = new Date()
): ScoredMarket | null {
  // --- Filter: aggregate daily rate range ---
  if (aggregateDailyRate < MIN_DAILY_RATE || aggregateDailyRate > MAX_DAILY_RATE) return null;

  // --- Filter: manual allow/deny lists + near-event catalyst windows ---
  if (!passesManualSelection(reward)) return null;
  if (isNearCatalyst(reward, now, MIN_DAYS_TO_EVENT)) return null;

  // --- Filter: min_size ---
  if (reward.rewards_min_size > MAX_MIN_SHARES) return null;

  // --- Filter: competitiveness ---
  if (reward.market_competitiveness > MAX_COMPETITIVENESS) return null;

  // --- Filter: 24h volume ---
  if (reward.volume_24hr < MIN_VOLUME_24H || reward.volume_24hr > MAX_VOLUME_24H) return null;

  // --- Token IDs from tokens[] (always populated in /multi) ---
  const yesToken = reward.tokens.find(t => t.outcome === 'Yes') ?? reward.tokens[0];
  const noToken  = reward.tokens.find(t => t.outcome === 'No')  ?? reward.tokens[1];
  if (!yesToken) return null;

  const yesTokenId = yesToken.token_id;
  const noTokenId  = noToken?.token_id ?? '';

  // --- Mid price: YES token price ---
  const mid = yesToken.price;
  if (mid < MIN_MID || mid > MAX_MID) return null;

  // --- Score: higher aggregate rate × lower competitiveness = better ---
  const competition = Math.min(reward.market_competitiveness / MAX_COMPETITIVENESS, 1.0);
  const score = aggregateDailyRate * (1 - competition);

  return {
    reward,
    mid,
    dailyRate: aggregateDailyRate,
    competitiveness: reward.market_competitiveness,
    score,
    yesTokenId,
    noTokenId,
  };
}

// ---------------------------------------------------------------------------
// Config writing
// ---------------------------------------------------------------------------
interface ConfigYaml {
  defaults: Record<string, unknown>;
  markets: unknown[];
}

function buildMarketEntry(sm: ScoredMarket): Record<string, unknown> {
  const reward = sm.reward;
  const maxSpread = (reward.rewards_max_spread ?? 5) / 100;

  // Build Polymarket URL from event_slug + market_slug
  let url: string | undefined;
  if (reward.event_slug && reward.market_slug) {
    url = `https://polymarket.com/event/${reward.event_slug}/${reward.market_slug}`;
  } else if (reward.market_slug) {
    url = `https://polymarket.com/event/${reward.market_slug}`;
  }

  const entry: Record<string, unknown> = {
    condition_id: reward.condition_id,
    yes_token_id: sm.yesTokenId,
    no_token_id:  sm.noTokenId,
    min_size:     reward.rewards_min_size,
    fallback_v:   parseFloat(maxSpread.toFixed(4)),
  };

  if (url) entry.url = url;

  return entry;
}

function writeConfig(configPath: string, markets: ScoredMarket[]): void {
  const raw = fs.readFileSync(configPath, 'utf8');

  // Strip any existing auto-gen comment header before parsing
  const stripped = raw.replace(/^#.*\n/gm, '').trimStart();
  const cfg = yaml.load(stripped) as ConfigYaml;

  cfg.markets = markets.map(buildMarketEntry);

  const dumped = yaml.dump(cfg, { lineWidth: 120, quotingType: '"', forceQuotes: false });
  const header = [
    `# Auto-generated by market-scanner.ts on ${new Date().toISOString()}`,
    `# Top ${markets.length} market(s) by score = daily_rate × (1 - competition)`,
    '',
  ].join('\n');

  fs.writeFileSync(configPath, header + dumped, 'utf8');
  console.log(`\nWrote ${markets.length} market(s) to ${configPath}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const countIdx = args.indexOf('--count');
  const count = countIdx !== -1 ? parseInt(args[countIdx + 1], 10) : DEFAULT_COUNT;

  console.log('=== Polymarket LP Market Scanner ===');
  console.log(
    `Filters: daily_rate=${MIN_DAILY_RATE}–${MAX_DAILY_RATE} USDC/day | ` +
    `min_size≤${MAX_MIN_SHARES} | ` +
    `vol_24h=${MIN_VOLUME_24H.toLocaleString()}–${MAX_VOLUME_24H.toLocaleString()} | ` +
    `competitiveness≤${MAX_COMPETITIVENESS} | ` +
    `days_to_event≥${MIN_DAYS_TO_EVENT}`
  );
  if (WHITELIST_SLUGS.length > 0 || WHITELIST_KEYWORDS.length > 0) {
    console.log(
      `Whitelist: slugs=${WHITELIST_SLUGS.length} keywords=${WHITELIST_KEYWORDS.length}`
    );
  }
  if (BLACKLIST_SLUGS.length > 0 || BLACKLIST_KEYWORDS.length > 0) {
    console.log(
      `Blacklist: slugs=${BLACKLIST_SLUGS.length} keywords=${BLACKLIST_KEYWORDS.length}`
    );
  }
  console.log(`Target: top ${count} market(s)\n`);

  // 1. Fetch all markets from /rewards/markets/multi (paginated)
  process.stdout.write('Fetching rewards markets from CLOB...');
  const allRewards = await fetchAllMultiRewards();
  console.log(` ${allRewards.length} total`);

  // 2. Cheap pre-filter: min_size only.
  //    Do NOT filter by rate yet — the same underlying market can have multiple
  //    condition_ids from different sponsors; we must sum rates per token first.
  const cheapFiltered = allRewards.filter(r => r.rewards_min_size <= MAX_MIN_SHARES);
  console.log(`After min_size filter: ${cheapFiltered.length} candidate(s)`);

  if (cheapFiltered.length === 0) {
    console.log(`No markets with min_size ≤ ${MAX_MIN_SHARES}. Try raising MAX_MIN_SHARES.`);
    process.exit(1);
  }

  // 3. Resolve token IDs (from tokens[] — always populated in /multi).
  //    Group by YES token ID and sum rates across all sponsors.
  interface RawEntry {
    reward: MarketReward;
    yesTokenId: string;
    rate: number;
  }

  const rawEntries: RawEntry[] = cheapFiltered.flatMap(reward => {
    const yesToken = reward.tokens.find(t => t.outcome === 'Yes') ?? reward.tokens[0];
    if (!yesToken?.token_id) return [];
    const rate = reward.rewards_config?.[0]?.rate_per_day ?? 0;
    return [{ reward, yesTokenId: yesToken.token_id, rate }];
  });

  // 4. Group by yesTokenId, sum rates, pick best representative condition_id.
  //    Best = lowest min_size, then widest max_spread as tiebreaker.
  interface TokenGroup {
    representative: RawEntry;
    totalRate: number;
  }

  const tokenGroups = new Map<string, TokenGroup>();
  for (const entry of rawEntries) {
    const existing = tokenGroups.get(entry.yesTokenId);
    if (!existing) {
      tokenGroups.set(entry.yesTokenId, { representative: entry, totalRate: entry.rate });
    } else {
      existing.totalRate += entry.rate;
      const curBetter =
        entry.reward.rewards_min_size < existing.representative.reward.rewards_min_size ||
        (entry.reward.rewards_min_size === existing.representative.reward.rewards_min_size &&
         (entry.reward.rewards_max_spread ?? 5) > (existing.representative.reward.rewards_max_spread ?? 5));
      if (curBetter) existing.representative = entry;
    }
  }
  console.log(`Unique underlying tokens: ${tokenGroups.size}`);

  // 5. Score all groups — all filters applied here (rate, competitiveness, volume, mid).
  const now = new Date();
  const scored: ScoredMarket[] = [];
  for (const { representative: entry, totalRate } of tokenGroups.values()) {
    const result = scoreMarket(entry.reward, totalRate, now);
    if (result !== null) scored.push(result);
  }
  console.log(`After all filters: ${scored.length} market(s) pass`);

  if (scored.length === 0) {
    console.log('No markets passed all filters. Try relaxing thresholds (competitiveness, volume, rate range).');
    process.exit(1);
  }

  // 6. Sort by score descending, pick top N
  scored.sort((a, b) => b.score - a.score);
  const selected = scored.slice(0, count);

  // 7. Print summary table
  console.log('\nSelected markets:');
  console.log('  #  Score   Rate/day  Compet   D/Event   Mid    Question');
  console.log('  -- ------  --------  -------  -------  -----  --------');
  for (let i = 0; i < selected.length; i++) {
    const s = selected[i];
    const daysToEvent = getDaysToEvent(s.reward, now);
    const daysToEventText = daysToEvent === null ? 'n/a' : Math.ceil(daysToEvent).toString();
    const question = (s.reward.question ?? '').slice(0, 55);
    console.log(
      `  ${String(i + 1).padStart(2)}  ${s.score.toFixed(1).padStart(6)}  ` +
      `$${s.dailyRate.toFixed(0).padStart(7)}  ${s.competitiveness.toFixed(1).padStart(7)}  ` +
      `${daysToEventText.padStart(7)}  ${s.mid.toFixed(2)}   ${question}`
    );
  }

  // 8. Write config.yaml
  const configPath = `${process.cwd()}/config.yaml`;
  writeConfig(configPath, selected);
}

if (require.main === module) {
  main().catch(err => {
    console.error('Scanner failed:', err);
    process.exit(1);
  });
}
