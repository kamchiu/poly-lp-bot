export interface MarketConfig {
  /** Polymarket market/event URL — alternative to specifying condition_id + yes_token_id directly */
  url?: string;
  condition_id?: string;
  yes_token_id?: string;
  no_token_id?: string;
  min_size: number;
  fallback_v: number;
  // optional per-market overrides
  spread_factor?: number;
  refresh_interval_ms?: number;
  drift_threshold_factor?: number;
}

export interface Defaults {
  spread_factor: number;
  refresh_interval_ms: number;
  drift_threshold_factor: number;
  ws_host: string;
}

export interface AppConfig {
  defaults: Defaults;
  markets: MarketConfig[];
}

export interface ResolvedMarketConfig extends Omit<Required<MarketConfig>, 'url'> {
  ws_host: string;
}

export interface OrderBookLevel {
  price: string;
  size: string;
}

export interface OrderBook {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}
