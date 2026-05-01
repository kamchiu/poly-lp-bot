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
const MAX_COMPETITIVENESS = 8;
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

function httpsPost(url: string, body: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const parsedUrl = new URL(url);
    const options: https.RequestOptions = {
      method: 'POST',
      hostname: parsedUrl.hostname,
      port: parsedUrl.port ? parseInt(parsedUrl.port, 10) : undefined,
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      agent: proxyAgent,
    };

    const req = https.request(options, res => {
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
    req.write(payload);
    req.end();
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

export function buildMultiRewardsUrl(
  options: {
    minVolume24h?: number;
    maxVolume24h?: number;
    nextCursor?: string;
    pageSize?: number;
  } = {}
): string {
  const params = new URLSearchParams();
  params.set('page_size', String(options.pageSize ?? 500));
  params.set('next_cursor', options.nextCursor ?? 'MA==');

  if (typeof options.minVolume24h === 'number' && Number.isFinite(options.minVolume24h)) {
    params.set('min_volume_24hr', String(options.minVolume24h));
  }
  if (typeof options.maxVolume24h === 'number' && Number.isFinite(options.maxVolume24h)) {
    params.set('max_volume_24hr', String(options.maxVolume24h));
  }

  return `${CLOB_HOST}/rewards/markets/multi?${params.toString()}`;
}

async function fetchAllMultiRewards(options: {
  minVolume24h?: number;
  maxVolume24h?: number;
} = {}): Promise<MarketReward[]> {
  const pageSize = 500;
  const endCursor = 'LTE=';

  let results: MarketReward[] = [];
  let nextCursor = 'MA==';

  while (nextCursor !== endCursor) {
    const url = buildMultiRewardsUrl({
      pageSize,
      nextCursor,
      minVolume24h: options.minVolume24h,
      maxVolume24h: options.maxVolume24h,
    });
    const resp = await httpsGet(url) as PaginationPayload;
    if (!Array.isArray(resp.data) || resp.data.length === 0) break;
    results.push(...resp.data);
    nextCursor = resp.next_cursor ?? endCursor;
  }

  return results;
}

export interface ScoredMarket {
  reward: MarketReward;
  mid: number | null;
  bestBid: number;
  bestAsk: number;
  dailyRate: number;
  competitiveness: number;
  score: number;
  yesTokenId: string;
  noTokenId: string;
}

export interface BestPrices {
  bestBid: number | null;
  bestAsk: number | null;
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
  minBestBid?: number;
  maxBestBid?: number;
  minBestAsk?: number;
  maxBestAsk?: number;
  maxCompetitiveness?: number;
  exactCompetitiveness?: number;
}

export interface ScanMarketsOptions extends ScanFilters {
  count?: number;
  now?: Date;
  bestPricesByTokenId?: Record<string, BestPrices>;
}

interface ResolvedScanFilters {
  minDailyRate: number;
  maxDailyRate: number;
  maxMinShares: number;
  minVolume24h: number;
  maxVolume24h: number;
  minMid: number;
  maxMid: number;
  minBestBid?: number;
  maxBestBid?: number;
  minBestAsk?: number;
  maxBestAsk?: number;
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
  minBestBid: undefined,
  maxBestBid: undefined,
  minBestAsk: undefined,
  maxBestAsk: undefined,
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
    minBestBid: filters.minBestBid ?? DEFAULT_SCAN_FILTERS.minBestBid,
    maxBestBid: filters.maxBestBid ?? DEFAULT_SCAN_FILTERS.maxBestBid,
    minBestAsk: filters.minBestAsk ?? DEFAULT_SCAN_FILTERS.minBestAsk,
    maxBestAsk: filters.maxBestAsk ?? DEFAULT_SCAN_FILTERS.maxBestAsk,
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

interface CandidateMarket {
  reward: MarketReward;
  aggregateDailyRate: number;
  yesTokenId: string;
  noTokenId: string;
}

function hasBestPriceFilters(filters: ResolvedScanFilters): boolean {
  return (
    filters.minBestBid !== undefined ||
    filters.maxBestBid !== undefined ||
    filters.minBestAsk !== undefined ||
    filters.maxBestAsk !== undefined
  );
}

function parseNumericValue(value: unknown): number | null {
  const parsed = parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function setSidePrice(
  pricesByTokenId: Record<string, BestPrices>,
  tokenId: string,
  side: string,
  price: unknown
): void {
  const parsedPrice = parseNumericValue(price);
  if (parsedPrice === null) return;

  const next = pricesByTokenId[tokenId] ?? { bestBid: null, bestAsk: null };
  const normalizedSide = side.toUpperCase();
  if (normalizedSide === 'BUY') next.bestBid = parsedPrice;
  if (normalizedSide === 'SELL') next.bestAsk = parsedPrice;
  pricesByTokenId[tokenId] = next;
}

function mergeBatchPrices(
  pricesByTokenId: Record<string, BestPrices>,
  payload: unknown
): void {
  if (Array.isArray(payload)) {
    for (const entry of payload) {
      if (!entry || typeof entry !== 'object') continue;
      const tokenId = String((entry as Record<string, unknown>)['token_id'] ?? '');
      const side = String((entry as Record<string, unknown>)['side'] ?? '');
      const price = (entry as Record<string, unknown>)['price'];
      if (tokenId && side) setSidePrice(pricesByTokenId, tokenId, side, price);
    }
    return;
  }

  if (!payload || typeof payload !== 'object') return;

  for (const [tokenId, value] of Object.entries(payload as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const sideMap = value as Record<string, unknown>;
    setSidePrice(pricesByTokenId, tokenId, 'BUY', sideMap['BUY'] ?? sideMap['buy']);
    setSidePrice(pricesByTokenId, tokenId, 'SELL', sideMap['SELL'] ?? sideMap['sell']);
  }
}

async function fetchBestPricesByTokenId(tokenIds: string[]): Promise<Record<string, BestPrices>> {
  const uniqueTokenIds = [...new Set(tokenIds)].filter(Boolean);
  const pricesByTokenId: Record<string, BestPrices> = {};
  const chunkSize = 250;

  const requests: Promise<unknown>[] = [];
  for (let start = 0; start < uniqueTokenIds.length; start += chunkSize) {
    const chunk = uniqueTokenIds.slice(start, start + chunkSize);
    requests.push(
      httpsPost(
        `${CLOB_HOST}/prices`,
        chunk.flatMap(tokenId => [
          { token_id: tokenId, side: 'BUY' },
          { token_id: tokenId, side: 'SELL' },
        ])
      )
    );
  }

  const responses = await Promise.all(requests);
  for (const response of responses) {
    mergeBatchPrices(pricesByTokenId, response);
  }

  return pricesByTokenId;
}

function passesStaticFilters(
  reward: MarketReward,
  aggregateDailyRate: number,
  now: Date,
  filters: ResolvedScanFilters
): boolean {
  if (aggregateDailyRate < filters.minDailyRate || aggregateDailyRate > filters.maxDailyRate) {
    return false;
  }

  if (!passesManualSelection(reward, filters)) return false;
  if (isNearCatalyst(reward, now, filters.minDaysToEvent)) return false;

  if (reward.rewards_min_size <= 0 || reward.rewards_min_size > filters.maxMinShares) {
    return false;
  }

  if (filters.exactCompetitiveness !== undefined) {
    if (reward.market_competitiveness !== filters.exactCompetitiveness) return false;
  } else if (reward.market_competitiveness > filters.maxCompetitiveness) {
    return false;
  }

  if (reward.volume_24hr < filters.minVolume24h || reward.volume_24hr > filters.maxVolume24h) {
    return false;
  }

  return true;
}

export function scoreMarket(
  reward: MarketReward,
  aggregateDailyRate: number,
  now: Date = new Date(),
  filters: ScanFilters = {},
  bestPrices: BestPrices | null = null
): ScoredMarket | null {
  const resolvedFilters = resolveScanFilters(filters);
  if (!passesStaticFilters(reward, aggregateDailyRate, now, resolvedFilters)) return null;

  const yesToken = reward.tokens.find(t => t.outcome === 'Yes') ?? reward.tokens[0];
  const noToken = reward.tokens.find(t => t.outcome === 'No') ?? reward.tokens[1];
  if (!yesToken) return null;

  const bestBid = bestPrices?.bestBid ?? null;
  const bestAsk = bestPrices?.bestAsk ?? null;
  const bookMid =
    bestBid !== null &&
    bestAsk !== null &&
    bestBid > 0 &&
    bestAsk > 0 &&
    bestBid < bestAsk
      ? (bestBid + bestAsk) / 2
      : null;
  const fallbackMid = parseNumericValue(yesToken.price);
  const mid = bookMid ?? fallbackMid;

  if (resolvedFilters.minBestBid !== undefined && (bestBid === null || bestBid < resolvedFilters.minBestBid)) {
    return null;
  }
  if (resolvedFilters.maxBestBid !== undefined && (bestBid === null || bestBid > resolvedFilters.maxBestBid)) {
    return null;
  }
  if (resolvedFilters.minBestAsk !== undefined && (bestAsk === null || bestAsk < resolvedFilters.minBestAsk)) {
    return null;
  }
  if (resolvedFilters.maxBestAsk !== undefined && (bestAsk === null || bestAsk > resolvedFilters.maxBestAsk)) {
    return null;
  }

  if (mid === null || mid < resolvedFilters.minMid || mid > resolvedFilters.maxMid) {
    return null;
  }

  const crowdPenalty = 1 / (1 + Math.max(reward.market_competitiveness, 0));
  const score = (aggregateDailyRate / reward.rewards_min_size) * crowdPenalty;

  return {
    reward,
    bestBid: bestBid ?? 0,
    bestAsk: bestAsk ?? 0,
    mid,
    dailyRate: aggregateDailyRate,
    competitiveness: reward.market_competitiveness,
    score,
    yesTokenId: yesToken.token_id,
    noTokenId: noToken?.token_id ?? '',
  };
}

export async function selectMarkets(
  rewards: MarketReward[],
  options: ScanMarketsOptions = {}
): Promise<ScoredMarket[]> {
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
    noTokenId: string;
    rate: number;
  }

  const rawEntries: RawEntry[] = cheapFiltered.flatMap(reward => {
    const yesToken = reward.tokens.find(t => t.outcome === 'Yes') ?? reward.tokens[0];
    const noToken = reward.tokens.find(t => t.outcome === 'No') ?? reward.tokens[1];
    if (!yesToken?.token_id) return [];
    const rate = reward.rewards_config?.[0]?.rate_per_day ?? 0;
    return [{ reward, yesTokenId: yesToken.token_id, noTokenId: noToken?.token_id ?? '', rate }];
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

  const candidates: CandidateMarket[] = [];
  for (const { representative, totalRate } of tokenGroups.values()) {
    if (!passesStaticFilters(representative.reward, totalRate, now, resolvedFilters)) continue;
    candidates.push({
      reward: representative.reward,
      aggregateDailyRate: totalRate,
      yesTokenId: representative.yesTokenId,
      noTokenId: representative.noTokenId,
    });
  }

  const needsBookPrices = hasBestPriceFilters(resolvedFilters) || options.bestPricesByTokenId !== undefined;
  const bestPricesByTokenId = needsBookPrices
    ? (options.bestPricesByTokenId ?? await fetchBestPricesByTokenId(candidates.map(candidate => candidate.yesTokenId)))
    : {};

  const scored: ScoredMarket[] = [];
  for (const candidate of candidates) {
    const result = scoreMarket(
      candidate.reward,
      candidate.aggregateDailyRate,
      now,
      resolvedFilters,
      bestPricesByTokenId[candidate.yesTokenId] ?? null
    );
    if (result !== null) {
      result.yesTokenId = candidate.yesTokenId;
      result.noTokenId = candidate.noTokenId;
      scored.push(result);
    }
  }

  scored.sort((left, right) => right.score - left.score);
  return scored.slice(0, count);
}

export async function scanMarkets(
  options: ScanMarketsOptions = {}
): Promise<ScoredMarket[]> {
  const resolvedFilters = resolveScanFilters(options);
  const rewards = await fetchAllMultiRewards({
    minVolume24h: resolvedFilters.minVolume24h,
    maxVolume24h: resolvedFilters.maxVolume24h,
  });
  return await selectMarkets(rewards, {
    ...options,
    ...resolvedFilters,
  });
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
  const bestBidRange =
    filters.minBestBid !== undefined || filters.maxBestBid !== undefined
      ? `best_bid=${filters.minBestBid ?? 0}–${filters.maxBestBid ?? 1}`
      : null;
  const bestAskRange =
    filters.minBestAsk !== undefined || filters.maxBestAsk !== undefined
      ? `best_ask=${filters.minBestAsk ?? 0}–${filters.maxBestAsk ?? 1}`
      : null;

  return [
    `daily_rate=${filters.minDailyRate}–${filters.maxDailyRate} USDC/day | ` +
    `min_size<=${filters.maxMinShares} | ` +
    `vol_24h=${filters.minVolume24h.toLocaleString()}–${filters.maxVolume24h.toLocaleString()} | ` +
    `${competitiveness} | ` +
    `days_to_event>=${filters.minDaysToEvent}`,
    bestBidRange,
    bestAskRange,
  ].filter(Boolean).join(' | ');
}

function formatPriceCell(price: number): string {
  return price > 0 ? price.toFixed(2) : 'n/a';
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

  const selected = await selectMarkets(allRewards, scanOptions);
  console.log(`After all filters: ${selected.length} market(s) pass`);

  if (selected.length === 0) {
    console.log('No markets passed all filters. Try relaxing thresholds.');
    process.exit(1);
  }

  console.log('\nSelected markets:');
  console.log('  #  Score   Rate/day  Compet   D/Event   Bid    Ask    Question');
  console.log('  -- ------  --------  -------  -------  -----  -----  --------');

  const now = scanOptions.now ?? new Date();
  for (let i = 0; i < selected.length; i++) {
    const scored = selected[i];
    const daysToEvent = getDaysToEvent(scored.reward, now);
    const daysToEventText = daysToEvent === null ? 'n/a' : Math.ceil(daysToEvent).toString();
    const question = (scored.reward.question ?? '').slice(0, 55);

    console.log(
      `  ${String(i + 1).padStart(2)}  ${scored.score.toFixed(1).padStart(6)}  ` +
      `$${scored.dailyRate.toFixed(0).padStart(7)}  ${scored.competitiveness.toFixed(1).padStart(7)}  ` +
      `${daysToEventText.padStart(7)}  ${formatPriceCell(scored.bestBid).padStart(5)}  ` +
      `${formatPriceCell(scored.bestAsk).padStart(5)}  ${question}`
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
