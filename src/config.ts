import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { AppConfig, ResolvedMarketConfig } from './types';

export function loadConfig(path: string): AppConfig {
  const raw = fs.readFileSync(path, 'utf8');
  return yaml.load(raw) as AppConfig;
}

export function resolveMarketConfig(
  market: AppConfig['markets'][0],
  defaults: AppConfig['defaults']
): ResolvedMarketConfig {
  return {
    condition_id: market.condition_id,
    yes_token_id: market.yes_token_id,
    min_size: market.min_size,
    fallback_v: market.fallback_v,
    spread_factor: market.spread_factor ?? defaults.spread_factor,
    refresh_interval_ms: market.refresh_interval_ms ?? defaults.refresh_interval_ms,
    min_requote_interval_ms: market.min_requote_interval_ms ?? defaults.min_requote_interval_ms,
    drift_threshold_factor: market.drift_threshold_factor ?? defaults.drift_threshold_factor,
    min_mid_price: market.min_mid_price ?? defaults.min_mid_price,
    max_mid_price: market.max_mid_price ?? defaults.max_mid_price,
    ws_host: defaults.ws_host,
  };
}
