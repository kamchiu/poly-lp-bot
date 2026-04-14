export interface MarketConfig {
  condition_id: string;
  yes_token_id: string;
  min_size: number;
  fallback_v: number;
  // optional per-market overrides
  spread_factor?: number;
  refresh_interval_ms?: number;
  min_requote_interval_ms?: number;
  drift_threshold_factor?: number;
  min_mid_price?: number;
  max_mid_price?: number;
}

export interface Defaults {
  spread_factor: number;
  refresh_interval_ms: number;
  min_requote_interval_ms: number;
  drift_threshold_factor: number;
  min_mid_price: number;
  max_mid_price: number;
  ws_host: string;
}

export interface AppConfig {
  defaults: Defaults;
  markets: MarketConfig[];
}

export interface ResolvedMarketConfig extends Required<MarketConfig> {
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
