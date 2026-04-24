/**
 * market-scanner.ts
 *
 * Discovers Polymarket CLOB rewards markets that match configurable criteria,
 * scores them by expected LP profitability, and optionally writes the top N
 * into config.yaml.
 *
 * Run: npx ts-node src/market-scanner.ts [--count N]
 *      npm run scan -- --count 5
 *
 * No private key or CLOB auth required. All data comes from the public
 * /rewards/markets/multi endpoint.
 */

import * as fs from 'fs';
import * as https from 'https';
import * as yaml from 'js-yaml';
import { MarketConfig } from './types';

// ---------------------------------------------------------------------------
// Tunable defaults used by the CLI and as the runtime scanner baseline.
// ---------------------------------------------------------------------------

const MIN_DAILY_RATE = 20;
const MAX_DAILY_RATE = 1500;
const MAX_MIN_SHARES = 50;
const MIN_VOLUME_24H = 800;
const MAX_VOLUME_24H = 800_000;
const MIN_MID = 0.1;
const MAX_MID = 0.9;
const MAX_COMPETITIVENESS = 15;
const MIN_DAYS_TO_EVENT = 14;
const WHITELIST_SLUGS: string[] = [];
const BLACKLIST_SLUGS: string[] = [];
const WHITELIST_KEYWORDS: string[] = [];
const BLACKLIST_KEYWORDS: string[] = [];
const DEFAULT_COUNT = 5;

const CLOB_HOST = 'https://clob.polymarket.com';

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

interface RewardsConfig {
  asset_address: string;
  start_date: string;
  end_date: string;
  rate_per_day: number;
  total_rewards: number;
  id: number;
}

interface MarketToken {
  token_id: string;
  outcome: string;
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
  rewards_max_spread: number;
  rewards_min_size: number;
  tokens: MarketToken[];
  volume_24hr: number;
  end_date?: string;
  spread?: number;
}

interface PaginationPayload {
  limit: number;
  count: number;
  next_cursor: string;
  data: MarketReward[];
}

async function fetchAllMultiRewards(): Promise<MarketReward[]> {
  const pageSize = 500;
  const endCursor = 'LTE=';

  let results: MarketReward[] = [];
  let nextCursor = 'MA==';

  while (nextCursor !== endCursor) {
    const url = `${CLOB_HOST}/rewards/markets/multi?page_size=${pageSize}&next_cursor=${encodeURIComponent(nextCursor)}`;
    const resp = await httpsGet(url) as PaginationPayload;
    if (!Array.isArray(resp.data) || resp.data.length === 0) break;
    results = [...results, ...resp.data];
    nextCursor = resp.next_cursor ?? endCursor;
  }

  return results;
}

export interface ScoredMarket {
  reward: MarketReward;
  mid: number;
  dailyRate: number;
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

export interface ScanFilters extends ManualSelectionFilters {
  minDailyRate?: number;
  maxDailyRate?: number;
  maxMinShares?: number;
  minVolume24h?: number;
  maxVolume24h?: number;
  minMid?: number;
  maxMid?: number;
  maxCompetitiveness?: number;
  exactCompetitiveness?: number;
}

export interface ScanMarketsOptions extends ScanFilters {
  count?: number;
  now?: Date;
}

interface ResolvedScanFilters {
  minDailyRate: number;
  maxDailyRate: number;
  maxMinShares: number;
  minVolume24h: number;
  maxVolume24h: number;
  minMid: number;
  maxMid: number;
  maxCompetitiveness: number;
  exactCompetitiveness?: number;
  whitelistSlugs: string[];
  blacklistSlugs: string[];
  whitelistKeywords: string[];
  blacklistKeywords: string[];
  minDaysToEvent: number;
}

const DEFAULT_MANUAL_FILTERS: Required<ManualSelectionFilters> = {
  whitelistSlugs: WHITELIST_SLUGS,
  blacklistSlugs: BLACKLIST_SLUGS,
  whitelistKeywords: WHITELIST_KEYWORDS,
  blacklistKeywords: BLACKLIST_KEYWORDS,
  minDaysToEvent: MIN_DAYS_TO_EVENT,
};

export const DEFAULT_SCAN_FILTERS: Readonly<ResolvedScanFilters> = {
  minDailyRate: MIN_DAILY_RATE,
  maxDailyRate: MAX_DAILY_RATE,
  maxMinShares: MAX_MIN_SHARES,
  minVolume24h: MIN_VOLUME_24H,
  maxVolume24h: MAX_VOLUME_24H,
  minMid: MIN_MID,
  maxMid: MAX_MID,
  maxCompetitiveness: MAX_COMPETITIVENESS,
  whitelistSlugs: WHITELIST_SLUGS,
  blacklistSlugs: BLACKLIST_SLUGS,
  whitelistKeywords: WHITELIST_KEYWORDS,
  blacklistKeywords: BLACKLIST_KEYWORDS,
  minDaysToEvent: MIN_DAYS_TO_EVENT,
};

function resolveScanFilters(filters: ScanFilters = {}): ResolvedScanFilters {
  return {
    minDailyRate: filters.minDailyRate ?? DEFAULT_SCAN_FILTERS.minDailyRate,
    maxDailyRate: filters.maxDailyRate ?? DEFAULT_SCAN_FILTERS.maxDailyRate,
    maxMinShares: filters.maxMinShares ?? DEFAULT_SCAN_FILTERS.maxMinShares,
    minVolume24h: filters.minVolume24h ?? DEFAULT_SCAN_FILTERS.minVolume24h,
    maxVolume24h: filters.maxVolume24h ?? DEFAULT_SCAN_FILTERS.maxVolume24h,
    minMid: filters.minMid ?? DEFAULT_SCAN_FILTERS.minMid,
    maxMid: filters.maxMid ?? DEFAULT_SCAN_FILTERS.maxMid,
    maxCompetitiveness: filters.maxCompetitiveness ?? DEFAULT_SCAN_FILTERS.maxCompetitiveness,
    exactCompetitiveness: filters.exactCompetitiveness,
    whitelistSlugs: filters.whitelistSlugs ?? DEFAULT_SCAN_FILTERS.whitelistSlugs,
    blacklistSlugs: filters.blacklistSlugs ?? DEFAULT_SCAN_FILTERS.blacklistSlugs,
    whitelistKeywords: filters.whitelistKeywords ?? DEFAULT_SCAN_FILTERS.whitelistKeywords,
    blacklistKeywords: filters.blacklistKeywords ?? DEFAULT_SCAN_FILTERS.blacklistKeywords,
    minDaysToEvent: filters.minDaysToEvent ?? DEFAULT_SCAN_FILTERS.minDaysToEvent,
  };
}

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

export function scoreMarket(
  reward: MarketReward,
  aggregateDailyRate: number,
  now: Date = new Date(),
  filters: ScanFilters = {}
): ScoredMarket | null {
  const resolvedFilters = resolveScanFilters(filters);

  if (
    aggregateDailyRate < resolvedFilters.minDailyRate ||
    aggregateDailyRate > resolvedFilters.maxDailyRate
  ) {
    return null;
  }

  if (!passesManualSelection(reward, resolvedFilters)) return null;
  if (isNearCatalyst(reward, now, resolvedFilters.minDaysToEvent)) return null;

  if (
    reward.rewards_min_size <= 0 ||
    reward.rewards_min_size > resolvedFilters.maxMinShares
  ) {
    return null;
  }

  if (resolvedFilters.exactCompetitiveness !== undefined) {
    if (reward.market_competitiveness !== resolvedFilters.exactCompetitiveness) return null;
  } else if (reward.market_competitiveness > resolvedFilters.maxCompetitiveness) {
    return null;
  }

  if (
    reward.volume_24hr < resolvedFilters.minVolume24h ||
    reward.volume_24hr > resolvedFilters.maxVolume24h
  ) {
    return null;
  }

  const yesToken = reward.tokens.find(t => t.outcome === 'Yes') ?? reward.tokens[0];
  const noToken = reward.tokens.find(t => t.outcome === 'No') ?? reward.tokens[1];
  if (!yesToken) return null;

  const mid = yesToken.price;
  if (mid < resolvedFilters.minMid || mid > resolvedFilters.maxMid) return null;

  const crowdPenalty = 1 / (1 + Math.max(reward.market_competitiveness, 0));
  const score = (aggregateDailyRate / reward.rewards_min_size) * crowdPenalty;

  return {
    reward,
    mid,
    dailyRate: aggregateDailyRate,
    competitiveness: reward.market_competitiveness,
    score,
    yesTokenId: yesToken.token_id,
    noTokenId: noToken?.token_id ?? '',
  };
}

export function selectMarkets(
  rewards: MarketReward[],
  options: ScanMarketsOptions = {}
): ScoredMarket[] {
  const resolvedFilters = resolveScanFilters(options);
  const now = options.now ?? new Date();
  const count =
    typeof options.count === 'number' && Number.isFinite(options.count) && options.count > 0
      ? Math.floor(options.count)
      : Number.POSITIVE_INFINITY;

  const cheapFiltered = rewards.filter(reward =>
    reward.rewards_min_size <= resolvedFilters.maxMinShares
  );

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

  interface TokenGroup {
    representative: RawEntry;
    totalRate: number;
  }

  const tokenGroups = new Map<string, TokenGroup>();
  for (const entry of rawEntries) {
    const existing = tokenGroups.get(entry.yesTokenId);
    if (!existing) {
      tokenGroups.set(entry.yesTokenId, {
        representative: entry,
        totalRate: entry.rate,
      });
      continue;
    }

    existing.totalRate += entry.rate;
    const currentSpread = existing.representative.reward.rewards_max_spread ?? 5;
    const nextSpread = entry.reward.rewards_max_spread ?? 5;
    const isBetterRepresentative =
      entry.reward.rewards_min_size < existing.representative.reward.rewards_min_size ||
      (
        entry.reward.rewards_min_size === existing.representative.reward.rewards_min_size &&
        nextSpread > currentSpread
      );

    if (isBetterRepresentative) {
      existing.representative = entry;
    }
  }

  const scored: ScoredMarket[] = [];
  for (const { representative, totalRate } of tokenGroups.values()) {
    const result = scoreMarket(representative.reward, totalRate, now, resolvedFilters);
    if (result !== null) scored.push(result);
  }

  scored.sort((left, right) => right.score - left.score);
  return scored.slice(0, count);
}

export async function scanMarkets(
  options: ScanMarketsOptions = {}
): Promise<ScoredMarket[]> {
  const rewards = await fetchAllMultiRewards();
  return selectMarkets(rewards, options);
}

export function buildMarketConfigEntry(scoredMarket: ScoredMarket): MarketConfig {
  const reward = scoredMarket.reward;
  const maxSpread = (reward.rewards_max_spread ?? 5) / 100;

  let url: string | undefined;
  if (reward.event_slug && reward.market_slug) {
    url = `https://polymarket.com/event/${reward.event_slug}/${reward.market_slug}`;
  } else if (reward.market_slug) {
    url = `https://polymarket.com/event/${reward.market_slug}`;
  }

  return {
    condition_id: reward.condition_id,
    yes_token_id: scoredMarket.yesTokenId,
    no_token_id: scoredMarket.noTokenId,
    min_size: reward.rewards_min_size,
    fallback_v: parseFloat(maxSpread.toFixed(4)),
    url,
  };
}

interface ConfigYaml {
  defaults: Record<string, unknown>;
  markets: unknown[];
}

function writeConfig(configPath: string, markets: ScoredMarket[]): void {
  const raw = fs.readFileSync(configPath, 'utf8');
  const stripped = raw.replace(/^#.*\n/gm, '').trimStart();
  const cfg = yaml.load(stripped) as ConfigYaml;

  cfg.markets = markets.map(buildMarketConfigEntry);

  const dumped = yaml.dump(cfg, { lineWidth: 120, quotingType: '"', forceQuotes: false });
  const header = [
    `# Auto-generated by market-scanner.ts on ${new Date().toISOString()}`,
    `# Top ${markets.length} market(s) by score = (daily_rate / min_size) × (1 / (1 + competitiveness))`,
    '',
  ].join('\n');

  fs.writeFileSync(configPath, header + dumped, 'utf8');
  console.log(`\nWrote ${markets.length} market(s) to ${configPath}`);
}

function formatFilterSummary(filters: ResolvedScanFilters): string {
  const competitiveness =
    filters.exactCompetitiveness !== undefined
      ? `competitiveness=${filters.exactCompetitiveness}`
      : `competitiveness<=${filters.maxCompetitiveness}`;

  return (
    `daily_rate=${filters.minDailyRate}–${filters.maxDailyRate} USDC/day | ` +
    `min_size<=${filters.maxMinShares} | ` +
    `vol_24h=${filters.minVolume24h.toLocaleString()}–${filters.maxVolume24h.toLocaleString()} | ` +
    `${competitiveness} | ` +
    `days_to_event>=${filters.minDaysToEvent}`
  );
}

async function main() {
  const args = process.argv.slice(2);
  const countIdx = args.indexOf('--count');
  const count = countIdx !== -1 ? parseInt(args[countIdx + 1], 10) : DEFAULT_COUNT;
  const scanOptions: ScanMarketsOptions = { count };
  const resolvedFilters = resolveScanFilters(scanOptions);

  console.log('=== Polymarket LP Market Scanner ===');
  console.log(`Filters: ${formatFilterSummary(resolvedFilters)}`);
  console.log(`Target: top ${count} market(s)\n`);

  process.stdout.write('Fetching rewards markets from CLOB...');
  const allRewards = await fetchAllMultiRewards();
  console.log(` ${allRewards.length} total`);

  const selected = selectMarkets(allRewards, scanOptions);
  console.log(`After all filters: ${selected.length} market(s) pass`);

  if (selected.length === 0) {
    console.log('No markets passed all filters. Try relaxing thresholds.');
    process.exit(1);
  }

  console.log('\nSelected markets:');
  console.log('  #  Score   Rate/day  Compet   D/Event   Mid    Question');
  console.log('  -- ------  --------  -------  -------  -----  --------');

  const now = scanOptions.now ?? new Date();
  for (let i = 0; i < selected.length; i++) {
    const scored = selected[i];
    const daysToEvent = getDaysToEvent(scored.reward, now);
    const daysToEventText = daysToEvent === null ? 'n/a' : Math.ceil(daysToEvent).toString();
    const question = (scored.reward.question ?? '').slice(0, 55);

    console.log(
      `  ${String(i + 1).padStart(2)}  ${scored.score.toFixed(1).padStart(6)}  ` +
      `$${scored.dailyRate.toFixed(0).padStart(7)}  ${scored.competitiveness.toFixed(1).padStart(7)}  ` +
      `${daysToEventText.padStart(7)}  ${scored.mid.toFixed(2)}   ${question}`
    );
  }

  const configPath = `${process.cwd()}/config.yaml`;
  writeConfig(configPath, selected);
}

if (require.main === module) {
  main().catch(err => {
    console.error('Scanner failed:', err);
    process.exit(1);
  });
}
