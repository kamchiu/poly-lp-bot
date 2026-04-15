import * as fs from 'fs';
import * as https from 'https';
import * as yaml from 'js-yaml';
import { AppConfig, MarketConfig, ResolvedMarketConfig } from './types';
import logger from './logger';

const GAMMA_API = 'https://gamma-api.polymarket.com';

// Honour https_proxy / HTTPS_PROXY env vars (Node built-in fetch ignores them)
const proxyUrl = process.env.https_proxy ?? process.env.HTTPS_PROXY;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const proxyAgent = proxyUrl ? new (require('https-proxy-agent').HttpsProxyAgent)(proxyUrl) : undefined;

/** Minimal proxy-aware GET that returns parsed JSON. */
function httpsGet(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const options: https.RequestOptions = proxyAgent ? { agent: proxyAgent } : {};
    const req = https.get(url, options, res => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error(`JSON parse error for ${url}: ${(e as Error).message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => { req.destroy(new Error(`Request timed out: ${url}`)); });
  });
}

export function loadConfig(path: string): AppConfig {
  const raw = fs.readFileSync(path, 'utf8');
  return yaml.load(raw) as AppConfig;
}

/**
 * Extract slugs from a Polymarket URL.
 * Handles: /event/<eventSlug>/<marketSlug>, /event/<slug>, /market/<slug>
 * Returns { eventSlug, marketSlug } — marketSlug may be undefined.
 */
function extractSlugs(url: string): { eventSlug: string; marketSlug?: string } {
  // /event/<eventSlug>/<marketSlug>
  const eventMatch = url.match(/polymarket\.com\/event\/([^/?#]+)(?:\/([^/?#]+))?/);
  if (eventMatch) {
    return { eventSlug: eventMatch[1], marketSlug: eventMatch[2] };
  }
  // /market/<slug>
  const marketMatch = url.match(/polymarket\.com\/market\/([^/?#]+)/);
  if (marketMatch) {
    return { eventSlug: marketMatch[1] };
  }
  throw new Error(`Cannot extract slug from URL: ${url}`);
}

interface GammaMarket {
  conditionId: string;
  clobTokenIds: string[] | string;  // API returns JSON-encoded string or array
  question?: string;
}

interface GammaEvent {
  markets: GammaMarket[];
  slug?: string;
  title?: string;
}

/**
 * Resolve condition_id and yes_token_id from a Polymarket URL via Gamma API.
 * For binary markets, clobTokenIds[0] is the YES token.
 * For events with multiple markets, picks the first active binary market.
 */
/** Normalise clobTokenIds — Gamma API returns it as a JSON-encoded string in some endpoints. */
function parseClobTokenIds(raw: string[] | string): string[] {
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw); } catch { return []; }
}

async function resolveIdsFromUrl(url: string): Promise<{ condition_id: string; yes_token_id: string; no_token_id: string }> {
  const { eventSlug, marketSlug } = extractSlugs(url);

  // Try /events first (event slugs) then /markets (market slugs)
  for (const endpoint of [`${GAMMA_API}/events?slug=${encodeURIComponent(eventSlug)}`, `${GAMMA_API}/markets?slug=${encodeURIComponent(marketSlug ?? eventSlug)}`]) {
    const data = await httpsGet(endpoint) as GammaEvent[] | GammaMarket[];
    if (!Array.isArray(data) || data.length === 0) continue;

    // /events returns [{markets: [...], ...}]; /markets returns [{conditionId, clobTokenIds, ...}]
    const first = data[0] as any;
    if (first.markets) {
      // Event with nested markets
      const eventMarkets: GammaMarket[] = first.markets;
      let market: GammaMarket | undefined;

      if (marketSlug) {
        // Match by sub-market slug
        market = eventMarkets.find(m => (m as any).slug === marketSlug);
      }
      if (!market) {
        // Fallback: first binary market with >= 2 token IDs
        market = eventMarkets.find(m => parseClobTokenIds(m.clobTokenIds).length >= 2) ?? eventMarkets[0];
      }

      const tokenIds = market ? parseClobTokenIds(market.clobTokenIds) : [];
      if (market?.conditionId && tokenIds[0]) {
        logger.info(`[Config] Resolved via event slug "${eventSlug}"${marketSlug ? ` market="${marketSlug}"` : ''}: conditionId=${market.conditionId.slice(0, 10)}... yes=${tokenIds[0].slice(0, 10)}... no=${tokenIds[1]?.slice(0, 10) ?? 'N/A'}...`);
        return { condition_id: market.conditionId, yes_token_id: tokenIds[0], no_token_id: tokenIds[1] ?? '' };
      }
    } else if (first.conditionId && parseClobTokenIds(first.clobTokenIds)[0]) {
      // Direct market result
      const tokenIds = parseClobTokenIds(first.clobTokenIds);
      logger.info(`[Config] Resolved via market slug "${marketSlug ?? eventSlug}": conditionId=${first.conditionId.slice(0, 10)}... yes=${tokenIds[0].slice(0, 10)}... no=${tokenIds[1]?.slice(0, 10) ?? 'N/A'}...`);
      return { condition_id: first.conditionId, yes_token_id: tokenIds[0], no_token_id: tokenIds[1] ?? '' };
    }
  }

  throw new Error(`Could not resolve market IDs for URL: ${url}\nCheck that the URL is a valid Polymarket market or event link. Ensure no_token_id is set.`);
}

/**
 * Fill in condition_id and yes_token_id for any market entries that specify a URL.
 * Mutates the MarketConfig objects in place.
 */
export async function resolveMarketIds(markets: MarketConfig[]): Promise<void> {
  const pending = markets.filter(m => m.url && (!m.condition_id || !m.yes_token_id));
  if (pending.length === 0) return;

  logger.info(`[Config] Resolving IDs for ${pending.length} market(s) from Polymarket URLs...`);
  await Promise.all(
    pending.map(async m => {
      const ids = await resolveIdsFromUrl(m.url!);
      m.condition_id = ids.condition_id;
      m.yes_token_id = ids.yes_token_id;
      m.no_token_id = ids.no_token_id;
    })
  );
}

export function resolveMarketConfig(
  market: MarketConfig,
  defaults: AppConfig['defaults']
): ResolvedMarketConfig {
  if (!market.condition_id || !market.yes_token_id) {
    throw new Error(
      `Market is missing condition_id or yes_token_id. ` +
      `Provide either a "url" field or both IDs directly.`
    );
  }
  if (!market.no_token_id) {
    throw new Error(
      `Market is missing no_token_id. ` +
      `Provide it directly in config.yaml or via a "url" field (resolved automatically).`
    );
  }
  return {
    condition_id: market.condition_id,
    yes_token_id: market.yes_token_id,
    no_token_id: market.no_token_id,
    min_size: market.min_size,
    fallback_v: market.fallback_v,
    spread_factor: market.spread_factor ?? defaults.spread_factor,
    refresh_interval_ms: market.refresh_interval_ms ?? defaults.refresh_interval_ms,
    drift_threshold_factor: market.drift_threshold_factor ?? defaults.drift_threshold_factor,
    fill_poll_interval_ms: market.fill_poll_interval_ms ?? defaults.fill_poll_interval_ms,
    close_limit_timeout_ms: market.close_limit_timeout_ms ?? defaults.close_limit_timeout_ms,
    ws_host: defaults.ws_host,
  };
}
