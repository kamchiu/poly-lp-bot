import {
  getMarketInfo,
  getRestMid,
  cancelMarketOrders,
  placeLimitOrder,
} from './client';
import { WsManager } from './ws-manager';
import { PositionMonitor } from './position-monitor';
import { ResolvedMarketConfig, TrackedOrder } from './types';
import { roundToTick } from './utils';
import logger from './logger';

export class MarketMaker {
  private lastQuotedMid: number | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private cachedMid: number | null = null;
  private isRequoting = false;
  private paused = false;
  private shortId: string;
  readonly positionMonitor: PositionMonitor;

  constructor(
    private readonly cfg: ResolvedMarketConfig,
    private readonly wsManager: WsManager
  ) {
    this.shortId = cfg.condition_id.slice(0, 10);
    this.positionMonitor = new PositionMonitor(
      cfg.condition_id,
      cfg.fill_poll_interval_ms,
    );

    // When a close completes, trigger a fresh requote (unless externally paused)
    this.positionMonitor.on('closeComplete', () => {
      logger.info(`[${this.shortId}] Close complete, triggering fresh requote`);
      this.triggerRequote('close-complete');
    });
  }

  start(): void {
    // Trigger 1: WS event-driven — drift check on YES token mid updates
    this.wsManager.on('midUpdate', (tokenId: string, newMid: number) => {
      if (tokenId !== this.cfg.yes_token_id) return;
      this.cachedMid = newMid;
      this.onMidUpdate(newMid);
    });

    // Trigger 2: WS reconnect → requote immediately if we have a cached mid
    this.wsManager.on('connected', () => {
      logger.info(`[${this.shortId}] WS connected event, cachedMid=${this.cachedMid}`);
      if (this.cachedMid !== null) {
        this.triggerRequote('ws-reconnect');
      }
    });

    // Trigger 3: Startup — kick off first requote immediately via REST mid fallback.
    // Inactive markets may never emit midUpdate, so don't wait for WS.
    this.triggerRequote('startup');
  }

  stop(): void {
    this.clearRefreshTimer();
    this.positionMonitor.stop();
  }

  /** Pause quoting: cancel all orders, stop timers and polling. Called when another market fills. */
  async pause(): Promise<void> {
    if (this.paused) return;
    this.paused = true;
    this.clearRefreshTimer();
    this.positionMonitor.stop();
    await cancelMarketOrders(this.cfg.condition_id);
    logger.info(`[${this.shortId}] Paused — orders cancelled`);
  }

  /** Resume quoting after a cross-market pause. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    logger.info(`[${this.shortId}] Resumed`);
    this.triggerRequote('resume');
  }

  get conditionId(): string {
    return this.cfg.condition_id;
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /** Schedule the next refresh after the current requote completes. */
  private scheduleRefresh(): void {
    this.clearRefreshTimer();
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.triggerRequote('refresh');
    }, this.cfg.refresh_interval_ms);
  }

  /**
   * Cancel any pending refresh and kick off an immediate requote.
   * No-ops if a requote is already in flight.
   */
  private triggerRequote(reason: string): void {
    if (this.paused) {
      logger.debug(`[${this.shortId}] triggerRequote(${reason}): skipped, paused`);
      return;
    }
    if (this.isRequoting) {
      logger.debug(`[${this.shortId}] triggerRequote(${reason}): skipped, already requoting`);
      return;
    }
    if (this.positionMonitor.isClosing()) {
      logger.info(`[${this.shortId}] triggerRequote(${reason}): deferred, close in progress`);
      return;
    }
    logger.info(`[${this.shortId}] triggerRequote(${reason}): firing`);
    this.clearRefreshTimer();
    this.requote(reason).catch(err =>
      logger.error(`[${this.shortId}] requote(${reason}) error:`, err)
    );
  }

  private onMidUpdate(newMid: number): void {
    // First update ever: requote immediately
    if (this.lastQuotedMid === null) {
      logger.info(`[${this.shortId}] onMidUpdate: first mid=${newMid.toFixed(4)}, triggering requote`);
      this.triggerRequote('first-mid');
      return;
    }

    // Drift check: requote if price moved beyond threshold
    const drift = Math.abs(newMid - this.lastQuotedMid);
    const threshold = this.cfg.fallback_v * this.cfg.drift_threshold_factor;
    if (drift > threshold) {
      logger.info(`[${this.shortId}] onMidUpdate: drift=${drift.toFixed(4)} > threshold=${threshold.toFixed(4)}, triggering requote`);
      this.triggerRequote('drift');
    }
  }

  private async requote(reason: string): Promise<void> {
    this.isRequoting = true;
    try {
      // 1. Fetch market parameters
      const { v, tick_size } = await getMarketInfo(this.cfg.condition_id, this.cfg.fallback_v);

      // 2. Get mid from YES token — prefer WS cache, fall back to REST
      let mid = this.cachedMid;
      if (mid === null) {
        mid = await getRestMid(this.cfg.yes_token_id);
      }
      if (mid === null) {
        logger.warn(`[${this.shortId}] requote(${reason}): no mid available, skipping`);
        return;
      }

      // 3. Calculate spread: s = v * spread_factor
      const s = v * this.cfg.spread_factor;

      // 5. Calculate prices:
      //    BUY YES @ (mid - s)
      //    BUY NO  @ (1 - (mid + s))
      //    Both consume USDC — no token inventory required.
      const yesBid = roundToTick(mid - s, tick_size);
      const noPrice = roundToTick(1 - (mid + s), tick_size);

      // Sanity check
      if (yesBid <= 0 || yesBid >= 1 || noPrice <= 0 || noPrice >= 1) {
        logger.warn(`[${this.shortId}] requote(${reason}): invalid prices yesBid=${yesBid} noPrice=${noPrice}, skipping`);
        return;
      }

      logger.info(
        `[${this.shortId}] requote(${reason}) mid=${mid.toFixed(4)} v=${v} s=${s.toFixed(4)} ` +
        `BUY YES@${yesBid} BUY NO@${noPrice}`
      );

      // 6. Cancel existing orders
      await cancelMarketOrders(this.cfg.condition_id);

      // 7. Place new orders: BUY YES + BUY NO (both use USDC as collateral)
      const [yesBidId, noBidId] = await Promise.all([
        placeLimitOrder('BUY', yesBid, this.cfg.min_size, this.cfg.yes_token_id),
        placeLimitOrder('BUY', noPrice, this.cfg.min_size, this.cfg.no_token_id),
      ]);

      if (!yesBidId || !noBidId) {
        logger.warn(
          `[${this.shortId}] requote(${reason}): placement incomplete — ` +
          `BUY YES=${yesBidId ?? 'FAILED'} BUY NO=${noBidId ?? 'FAILED'}`
        );
      }

      // 8. Track orders for fill detection
      const tracked: TrackedOrder[] = [];
      if (yesBidId && yesBidId !== 'unknown') {
        tracked.push({ orderId: yesBidId, tokenId: this.cfg.yes_token_id, side: 'BUY', price: yesBid, size: this.cfg.min_size });
      }
      if (noBidId && noBidId !== 'unknown') {
        tracked.push({ orderId: noBidId, tokenId: this.cfg.no_token_id, side: 'BUY', price: noPrice, size: this.cfg.min_size });
      }
      this.positionMonitor.trackOrders(tracked);

      // 9. Update last quoted mid
      this.lastQuotedMid = mid;
    } finally {
      this.isRequoting = false;
      // Always schedule next refresh after requote completes (success or failure)
      this.scheduleRefresh();
    }
  }
}
