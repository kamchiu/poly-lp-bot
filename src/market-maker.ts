import {
  getMarketInfo,
  getRestMid,
  cancelMarketOrders,
  placeLimitOrder,
} from './client';
import { WsManager } from './ws-manager';
import { UserWsManager } from './user-ws-manager';
import { PositionMonitor } from './position-monitor';
import { QuoteUpdate, ResolvedMarketConfig, TrackedOrder } from './types';
import { roundDownToTick } from './utils';
import logger from './logger';

const MAX_CACHED_MID_AGE_MS = 15_000;
const DRIFT_REQUOTE_DEBOUNCE_MS = 3_000;
const DRIFT_REQUOTE_RETRY_MS = 250;
const FLOAT_EPSILON = 1e-9;

interface LiveQuoteState {
  bestBid: number | null;
  bestAsk: number | null;
}

interface ActiveQuoteState {
  yesBid: number | null;
  noBid: number | null;
  tickSize: number;
}

export class MarketMaker {
  private lastQuotedMid: number | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private driftDebounceTimer: NodeJS.Timeout | null = null;
  private cachedMid: number | null = null;
  private cachedMidUpdatedAt: number | null = null;
  private isRequoting = false;
  private paused = false;
  private started = false;
  private hasActiveOrders = false;
  private cancelInFlight = false;
  private protectiveCancelInFlight = false;
  private cancelPromise: Promise<boolean> | null = null;
  private yesQuote: LiveQuoteState | null = null;
  private noQuote: LiveQuoteState | null = null;
  private activeQuoteState: ActiveQuoteState | null = null;
  private shortId: string;
  readonly positionMonitor: PositionMonitor;

  private readonly onWsMidUpdate: (tokenId: string, newMid: number) => void;
  private readonly onWsQuoteUpdate: (update: QuoteUpdate) => void;
  private readonly onWsConnected: () => void;

  constructor(
    private readonly cfg: ResolvedMarketConfig,
    private readonly wsManager: WsManager,
    userWsManager: UserWsManager,
  ) {
    this.shortId = cfg.condition_id.slice(0, 10);
    this.positionMonitor = new PositionMonitor(
      cfg.condition_id,
      userWsManager,
    );

    this.onWsMidUpdate = (tokenId: string, newMid: number) => {
      if (tokenId !== this.cfg.yes_token_id) return;
      this.cachedMid = newMid;
      this.cachedMidUpdatedAt = Date.now();
      this.onMidUpdate(newMid);
    };

    this.onWsQuoteUpdate = (update: QuoteUpdate) => {
      this.handleQuoteUpdate(update);
    };

    this.onWsConnected = () => {
      const cacheAgeMs = this.cachedMidUpdatedAt === null ? null : Date.now() - this.cachedMidUpdatedAt;
      logger.info(`[${this.shortId}] WS connected event, cachedMid=${this.cachedMid} cacheAgeMs=${cacheAgeMs}`);

      if (this.cachedMid !== null && cacheAgeMs !== null && cacheAgeMs <= MAX_CACHED_MID_AGE_MS) {
        this.triggerRequote('ws-reconnect');
        return;
      }

      this.cachedMid = null;
      this.cachedMidUpdatedAt = null;
      this.triggerRequote('ws-reconnect');
    };

    // When a close completes, trigger a fresh requote (unless externally paused)
    this.positionMonitor.on('closeComplete', () => {
      logger.info(`[${this.shortId}] Close complete, triggering fresh requote`);
      this.triggerRequote('close-complete');
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.wsManager.on('midUpdate', this.onWsMidUpdate);
    this.wsManager.on('quoteUpdate', this.onWsQuoteUpdate);
    this.wsManager.on('connected', this.onWsConnected);

    // Startup — kick off first requote immediately via REST mid fallback.
    // Inactive markets may never emit midUpdate, so don't wait for WS.
    this.triggerRequote('startup');
  }

  stop(): void {
    if (this.started) {
      this.wsManager.off('midUpdate', this.onWsMidUpdate);
      this.wsManager.off('quoteUpdate', this.onWsQuoteUpdate);
      this.wsManager.off('connected', this.onWsConnected);
      this.started = false;
    }
    this.resetQuoteProtectionState();
    this.clearRefreshTimer();
    this.clearDriftDebounce();
    this.positionMonitor.stop();
  }

  /**
   * Pause quoting: cancel all LP orders, stop timers and WS tracking.
   * Called when a *different* market fills — this market has no active close.
   */
  async pause(): Promise<boolean> {
    if (this.paused) return true;
    this.paused = true;
    this.resetQuoteProtectionState();
    this.clearRefreshTimer();
    this.clearDriftDebounce();

    const cancelled = await this.cancelOrders('pause');
    logger.info(
      `[${this.shortId}] Paused${cancelled ? ' — orders cancelled' : ' — order cancel failed or still in flight'}`
    );
    return cancelled;
  }

  /**
   * Pause quoting timers only — do NOT cancel orders or remove WS listeners.
   * Called when THIS market's LP order fills, so the close order must remain
   * active and the PositionMonitor must keep listening for the close fill.
   */
  pauseForClose(): void {
    if (this.paused) return;
    this.paused = true;
    this.resetQuoteProtectionState();
    this.clearRefreshTimer();
    this.clearDriftDebounce();
    logger.info(`[${this.shortId}] Paused for close — quoting stopped, WS listener kept`);
  }

  async pauseForRisk(reason: string): Promise<void> {
    this.paused = true;
    this.resetQuoteProtectionState();
    this.clearRefreshTimer();
    this.clearDriftDebounce();

    if (this.positionMonitor.hasActiveCloseOrder()) {
      logger.error(
        `[${this.shortId}] Risk pause (${reason}) — close order is active, leaving it on exchange`
      );
      return;
    }

    const cancelled = await this.cancelOrders(`risk:${reason}`);
    logger.error(
      `[${this.shortId}] Risk pause (${reason})${cancelled ? ' — orders cancelled' : ' — order cancel failed or still in flight'}`
    );
  }

  async shutdown(): Promise<{ safeToExit: boolean; reason?: string }> {
    this.paused = true;
    this.resetQuoteProtectionState();
    this.clearRefreshTimer();
    this.clearDriftDebounce();

    const hadClosingState = this.positionMonitor.isClosing();
    const hasActiveCloseOrder = this.positionMonitor.hasActiveCloseOrder();

    if (hasActiveCloseOrder) {
      logger.error(
        `[${this.shortId}] Shutdown requested while close order is active — refusing clean exit`
      );
      this.positionMonitor.stop();
      return { safeToExit: false, reason: 'close-order-active' };
    }

    const cancelled = await this.cancelOrders('shutdown');
    this.positionMonitor.stop();

    if (!cancelled) {
      return { safeToExit: false, reason: 'shutdown-cancel-failed' };
    }

    if (hadClosingState) {
      return { safeToExit: false, reason: 'position-monitor-active' };
    }

    return { safeToExit: true };
  }

  /** Resume quoting after a cross-market pause. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.resetQuoteProtectionState();
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

  private clearDriftDebounce(): void {
    if (this.driftDebounceTimer) {
      clearTimeout(this.driftDebounceTimer);
      this.driftDebounceTimer = null;
    }
  }

  private resetQuoteProtectionState(): void {
    this.protectiveCancelInFlight = false;
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
    if (this.cancelInFlight || this.protectiveCancelInFlight) {
      logger.debug(`[${this.shortId}] triggerRequote(${reason}): skipped, cancel in flight`);
      return;
    }
    logger.info(`[${this.shortId}] triggerRequote(${reason}): firing`);
    this.clearRefreshTimer();
    this.requote(reason).catch(err =>
      logger.error(`[${this.shortId}] requote(${reason}) error:`, err)
    );
  }

  private handleQuoteUpdate(update: QuoteUpdate): void {
    if (update.tokenId !== this.cfg.yes_token_id && update.tokenId !== this.cfg.no_token_id) {
      return;
    }

    const nextState: LiveQuoteState = {
      bestBid: update.bestBid,
      bestAsk: update.bestAsk,
    };

    if (update.tokenId === this.cfg.yes_token_id) {
      this.yesQuote = nextState;
      if (update.bestBid !== null && update.bestAsk !== null && update.bestBid < update.bestAsk) {
        this.cachedMid = (update.bestBid + update.bestAsk) / 2;
        this.cachedMidUpdatedAt = Date.now();
      }
    } else {
      this.noQuote = nextState;
    }

    const proximityReason = this.getProximityReason();
    if (proximityReason) {
      this.beginProtectiveRequote(proximityReason).catch(err =>
        logger.error(`[${this.shortId}] protective requote (${proximityReason}) error:`, err)
      );
    }
  }

  private onMidUpdate(newMid: number): void {
    // First update ever: requote immediately (no orders to cancel yet)
    if (this.lastQuotedMid === null) {
      logger.info(`[${this.shortId}] onMidUpdate: first mid=${newMid.toFixed(4)}, triggering requote`);
      this.triggerRequote('first-mid');
      return;
    }

    const drift = Math.abs(newMid - this.lastQuotedMid);
    const threshold = this.cfg.fallback_v * this.cfg.drift_threshold_factor;
    if (drift <= threshold) return;

    if (this.hasActiveOrders) {
      logger.info(
        `[${this.shortId}] onMidUpdate: drift=${drift.toFixed(4)} > threshold=${threshold.toFixed(4)}, requoting now`
      );
      this.beginProtectiveRequote('drift').catch(err =>
        logger.error(`[${this.shortId}] protective requote (drift) error:`, err)
      );
      return;
    }

    logger.debug(
      `[${this.shortId}] onMidUpdate: drift=${drift.toFixed(4)} > threshold=${threshold.toFixed(4)}, ` +
      `resetting debounce (no active orders)`
    );

    this.clearDriftDebounce();
    this.clearRefreshTimer();
    this.driftDebounceTimer = setTimeout(() => {
      this.driftDebounceTimer = null;
      this.triggerDriftRequoteWhenReady();
    }, DRIFT_REQUOTE_DEBOUNCE_MS);
  }

  private getProximityReason(): string | null {
    if (!this.hasActiveOrders || this.activeQuoteState === null) return null;
    if (this.isRequoting || this.cancelInFlight || this.protectiveCancelInFlight) {
      return null;
    }

    const { yesBid, noBid, tickSize } = this.activeQuoteState;
    const yesQuote = this.yesQuote;
    const noQuote = this.noQuote;

    if (
      yesBid !== null &&
      yesQuote !== null &&
      yesQuote.bestAsk !== null &&
      yesQuote.bestAsk - yesBid <= tickSize + FLOAT_EPSILON
    ) {
      return 'proximity-yes';
    }

    if (
      noBid !== null &&
      noQuote !== null &&
      noQuote.bestAsk !== null &&
      noQuote.bestAsk - noBid <= tickSize + FLOAT_EPSILON
    ) {
      return 'proximity-no';
    }

    return null;
  }

  private async beginProtectiveRequote(reason: string): Promise<void> {
    if (this.paused || !this.hasActiveOrders || this.protectiveCancelInFlight) {
      return;
    }

    this.protectiveCancelInFlight = true;
    this.clearRefreshTimer();
    this.clearDriftDebounce();

    try {
      const cancelled = await this.cancelOrders(reason);
      if (!cancelled) {
        logger.warn(`[${this.shortId}] ${reason}: protective cancel failed, skipping requote`);
        return;
      }
    } finally {
      this.protectiveCancelInFlight = false;
    }

    this.triggerRequote(reason);
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

      // 4. Calculate prices:
      //    BUY YES @ (mid - s)
      //    BUY NO  @ (1 - (mid + s))
      //    Both consume USDC — no token inventory required.
      const yesBid = roundDownToTick(mid - s, tick_size);
      const noPrice = roundDownToTick(1 - (mid + s), tick_size);

      if (yesBid <= 0 || yesBid >= 1 || noPrice <= 0 || noPrice >= 1) {
        logger.warn(`[${this.shortId}] requote(${reason}): invalid prices yesBid=${yesBid} noPrice=${noPrice}, skipping`);
        return;
      }

      logger.info(
        `[${this.shortId}] requote(${reason}) mid=${mid.toFixed(4)} v=${v} s=${s.toFixed(4)} ` +
        `BUY YES@${yesBid} BUY NO@${noPrice}`
      );

      // 5. Cancel existing orders
      const cancelled = await this.cancelOrders(`requote:${reason}`);
      if (!cancelled) {
        logger.warn(`[${this.shortId}] requote(${reason}): cancel failed, skipping placement`);
        return;
      }

      // 6. Place new orders: BUY YES + BUY NO (both use USDC as collateral)
      const [yesBidOrder, noBidOrder] = await Promise.all([
        placeLimitOrder('BUY', yesBid, this.cfg.min_size, this.cfg.yes_token_id),
        placeLimitOrder('BUY', noPrice, this.cfg.min_size, this.cfg.no_token_id),
      ]);

      if (!yesBidOrder || !noBidOrder) {
        logger.warn(
          `[${this.shortId}] requote(${reason}): placement incomplete — ` +
          `BUY YES=${yesBidOrder?.orderId ?? 'FAILED'} BUY NO=${noBidOrder?.orderId ?? 'FAILED'}`
        );
      }

      // 7. Track orders for fill detection
      const tracked: TrackedOrder[] = [];
      if (yesBidOrder) {
        tracked.push({
          orderId: yesBidOrder.orderId,
          tokenId: this.cfg.yes_token_id,
          side: 'BUY',
          price: yesBid,
          size: this.cfg.min_size,
        });
      }
      if (noBidOrder) {
        tracked.push({
          orderId: noBidOrder.orderId,
          tokenId: this.cfg.no_token_id,
          side: 'BUY',
          price: noPrice,
          size: this.cfg.min_size,
        });
      }
      this.positionMonitor.trackOrders(tracked);
      this.hasActiveOrders = tracked.length > 0;
      this.activeQuoteState = tracked.length > 0
        ? {
          yesBid: yesBidOrder ? yesBid : null,
          noBid: noBidOrder ? noPrice : null,
          tickSize: tick_size,
        }
        : null;

      if (this.hasActiveOrders) {
        this.lastQuotedMid = mid;
      }
    } finally {
      this.isRequoting = false;
      // Always schedule next refresh after requote completes (success or failure)
      this.scheduleRefresh();
    }
  }

  private async cancelOrders(reason: string): Promise<boolean> {
    if (this.cancelPromise) {
      logger.debug(`[${this.shortId}] cancelOrders(${reason}): awaiting existing cancel`);
      return this.cancelPromise;
    }

    this.cancelInFlight = true;
    this.cancelPromise = (async () => {
      logger.info(
        `[${this.shortId}] cancelOrders(${reason}) start hasActive=${this.hasActiveOrders} ` +
        `closing=${this.positionMonitor.isClosing()}`
      );
      const cancelled = await cancelMarketOrders(this.cfg.condition_id);
      if (!cancelled) {
        logger.warn(`[${this.shortId}] cancelOrders(${reason}) failed`);
        return false;
      }

      logger.info(`[${this.shortId}] cancelOrders(${reason}) confirmed — source=reconcile:market-maker:${reason}`);
      await this.positionMonitor.reconcileTrackedOrders(`market-maker:${reason}`);
      this.hasActiveOrders = false;
      this.activeQuoteState = null;
      if (!this.positionMonitor.isClosing()) {
        this.positionMonitor.stopTracking();
      }
      return true;
    })().finally(() => {
      this.cancelInFlight = false;
      this.cancelPromise = null;
    });

    return this.cancelPromise;
  }

  private triggerDriftRequoteWhenReady(): void {
    if (this.cancelInFlight || this.protectiveCancelInFlight) {
      this.driftDebounceTimer = setTimeout(() => {
        this.driftDebounceTimer = null;
        this.triggerDriftRequoteWhenReady();
      }, DRIFT_REQUOTE_RETRY_MS);
      return;
    }

    this.triggerRequote('drift');
  }
}
