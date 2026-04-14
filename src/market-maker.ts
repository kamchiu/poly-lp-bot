import {
  getMarketInfo,
  getRestMid,
  cancelMarketOrders,
  placeLimitOrder,
} from './client';
import { WsManager } from './ws-manager';
import { ResolvedMarketConfig } from './types';
import { roundToTick } from './utils';
import logger from './logger';

export class MarketMaker {
  private lastQuotedMid: number | null = null;
  private lastRequoteAt = 0;
  private refreshTimer: NodeJS.Timeout | null = null;
  private cachedMid: number | null = null;
  private shortId: string;

  constructor(
    private readonly cfg: ResolvedMarketConfig,
    private readonly wsManager: WsManager
  ) {
    this.shortId = cfg.condition_id.slice(0, 10);
  }

  start(): void {
    // Trigger 1: WS event-driven
    this.wsManager.on('midUpdate', (tokenId: string, newMid: number) => {
      if (tokenId !== this.cfg.yes_token_id) return;
      this.cachedMid = newMid;
      this.onMidUpdate(newMid);
    });

    // Trigger 2: Periodic fallback timer
    this.refreshTimer = setInterval(() => {
      this.requote('timer').catch(err => logger.error(`[${this.shortId}] timer requote error:`, err));
    }, this.cfg.refresh_interval_ms);

    // Trigger 3: WS reconnect → immediate recheck
    this.wsManager.on('connected', () => {
      this.requote('ws-reconnect').catch(err =>
        logger.error(`[${this.shortId}] ws-reconnect requote error:`, err)
      );
    });

    // Startup: quote immediately
    this.requote('startup').catch(err => logger.error(`[${this.shortId}] startup requote error:`, err));
  }

  stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private onMidUpdate(newMid: number): void {
    const now = Date.now();

    // Rate limit: skip if within cooldown window
    if (now - this.lastRequoteAt < this.cfg.min_requote_interval_ms) return;

    // Edge check
    if (newMid < this.cfg.min_mid_price || newMid > this.cfg.max_mid_price) {
      this.cancelAndSkip(newMid).catch(err =>
        logger.error(`[${this.shortId}] cancelAndSkip error:`, err)
      );
      return;
    }

    // Drift check: requote if no previous mid or drift exceeds threshold
    if (this.lastQuotedMid === null) {
      this.requote('drift').catch(err => logger.error(`[${this.shortId}] drift requote error:`, err));
      return;
    }

    // We need v for drift threshold — use a cached approach via async requote
    // Kick off async drift evaluation
    this.evaluateDrift(newMid).catch(err =>
      logger.error(`[${this.shortId}] evaluateDrift error:`, err)
    );
  }

  private async evaluateDrift(newMid: number): Promise<void> {
    const { v } = await getMarketInfo(this.cfg.condition_id, this.cfg.fallback_v);
    const drift = Math.abs(newMid - (this.lastQuotedMid ?? newMid));
    if (drift > v * this.cfg.drift_threshold_factor) {
      await this.requote('drift');
    }
  }

  private async cancelAndSkip(mid: number): Promise<void> {
    this.lastRequoteAt = Date.now();
    logger.info(`[${this.shortId}] mid=${mid.toFixed(4)} outside [${this.cfg.min_mid_price}, ${this.cfg.max_mid_price}], cancelling orders`);
    await cancelMarketOrders(this.cfg.condition_id);
    this.lastQuotedMid = null;
  }

  private async requote(reason: string): Promise<void> {
    this.lastRequoteAt = Date.now();

    // 1. Fetch market parameters
    const { v, tick_size } = await getMarketInfo(this.cfg.condition_id, this.cfg.fallback_v);

    // 2. Get mid — prefer WS cache, fall back to REST
    let mid = this.cachedMid;
    if (mid === null) {
      mid = await getRestMid(this.cfg.yes_token_id);
    }
    if (mid === null) {
      logger.warn(`[${this.shortId}] requote(${reason}): no mid available, skipping`);
      return;
    }

    // 3. Edge check
    if (mid < this.cfg.min_mid_price || mid > this.cfg.max_mid_price) {
      await this.cancelAndSkip(mid);
      return;
    }

    // 4. Calculate spread: s = v * spread_factor
    const s = v * this.cfg.spread_factor;

    // 5. Calculate bid/ask prices
    const bid = roundToTick(mid - s, tick_size);
    const ask = roundToTick(mid + s, tick_size);

    // Sanity check: prices must be valid
    if (bid <= 0 || ask >= 1 || bid >= ask) {
      logger.warn(`[${this.shortId}] requote(${reason}): invalid bid/ask bid=${bid} ask=${ask}, skipping`);
      return;
    }

    logger.info(
      `[${this.shortId}] requote(${reason}) mid=${mid.toFixed(4)} v=${v} s=${s.toFixed(4)} bid=${bid} ask=${ask}`
    );

    // 6. Cancel existing orders
    await cancelMarketOrders(this.cfg.condition_id);

    // 7. Place new orders
    await Promise.all([
      placeLimitOrder('BUY', bid, this.cfg.min_size, this.cfg.yes_token_id),
      placeLimitOrder('SELL', ask, this.cfg.min_size, this.cfg.yes_token_id),
    ]);

    // 8. Update last quoted mid
    this.lastQuotedMid = mid;
  }
}
