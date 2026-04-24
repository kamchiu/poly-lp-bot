import {
  cancelMarketOrders,
  getMarketInfo,
  getRestMid,
  placeLimitOrder,
} from './client';
import logger from './logger';
import { ResolvedMarketConfig } from './types';
import { roundDownToTick } from './utils';
import { WsManager } from './ws-manager';

const MAX_CACHED_MID_AGE_MS = 15_000;

export class SimpleMarketMaker {
  private refreshTimer: NodeJS.Timeout | null = null;
  private cachedMid: number | null = null;
  private cachedMidUpdatedAt: number | null = null;
  private isRequoting = false;
  private cancelInFlight = false;
  private running = false;
  private cancelPromise: Promise<boolean> | null = null;
  private readonly shortId: string;

  private readonly onWsMidUpdate: (tokenId: string, newMid: number) => void;

  constructor(
    private readonly cfg: ResolvedMarketConfig,
    private readonly wsManager: WsManager,
  ) {
    this.shortId = cfg.condition_id.slice(0, 10);
    this.onWsMidUpdate = (tokenId: string, newMid: number) => {
      if (tokenId !== this.cfg.yes_token_id) return;
      this.cachedMid = newMid;
      this.cachedMidUpdatedAt = Date.now();
    };
  }

  get conditionId(): string {
    return this.cfg.condition_id;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.wsManager.on('midUpdate', this.onWsMidUpdate);
    this.triggerRequote('startup');
  }

  async shutdown(reason = 'shutdown'): Promise<boolean> {
    this.running = false;
    this.clearRefreshTimer();
    this.wsManager.off('midUpdate', this.onWsMidUpdate);
    return this.cancelOrders(reason);
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private scheduleRefresh(): void {
    if (!this.running) return;
    this.clearRefreshTimer();
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.triggerRequote('refresh');
    }, this.cfg.refresh_interval_ms);
  }

  private triggerRequote(reason: string): void {
    if (!this.running) {
      logger.debug(`[${this.shortId}] triggerRequote(${reason}): skipped, not running`);
      return;
    }
    if (this.isRequoting) {
      logger.debug(`[${this.shortId}] triggerRequote(${reason}): skipped, already requoting`);
      return;
    }
    if (this.cancelInFlight) {
      logger.debug(`[${this.shortId}] triggerRequote(${reason}): skipped, cancel in flight`);
      return;
    }

    logger.info(`[${this.shortId}] triggerRequote(${reason}): firing`);
    this.clearRefreshTimer();
    this.requote(reason).catch(err =>
      logger.error(`[${this.shortId}] requote(${reason}) error:`, err)
    );
  }

  private getLatestMid(): number | null {
    if (this.cachedMid === null || this.cachedMidUpdatedAt === null) return null;
    if (Date.now() - this.cachedMidUpdatedAt > MAX_CACHED_MID_AGE_MS) return null;
    return this.cachedMid;
  }

  private async requote(reason: string): Promise<void> {
    this.isRequoting = true;
    try {
      const { v, tick_size } = await getMarketInfo(this.cfg.condition_id, this.cfg.fallback_v);

      let mid = this.getLatestMid();
      if (mid === null) {
        mid = await getRestMid(this.cfg.yes_token_id);
      }
      if (mid === null) {
        logger.warn(`[${this.shortId}] requote(${reason}): no mid available, skipping`);
        return;
      }

      const spread = v * this.cfg.spread_factor;
      const yesBid = roundDownToTick(mid - spread, tick_size);
      const noBid = roundDownToTick(1 - (mid + spread), tick_size);

      if (yesBid <= 0 || yesBid >= 1 || noBid <= 0 || noBid >= 1) {
        logger.warn(
          `[${this.shortId}] requote(${reason}): invalid prices yesBid=${yesBid} noBid=${noBid}, skipping`
        );
        return;
      }

      logger.info(
        `[${this.shortId}] requote(${reason}) mid=${mid.toFixed(4)} v=${v} spread=${spread.toFixed(4)} ` +
        `BUY YES@${yesBid} BUY NO@${noBid}`
      );

      const cancelled = await this.cancelOrders(`requote:${reason}`);
      if (!cancelled) {
        logger.warn(`[${this.shortId}] requote(${reason}): cancel failed, skipping placement`);
        return;
      }
      if (!this.running) {
        logger.info(`[${this.shortId}] requote(${reason}): bot stopped after cancel`);
        return;
      }

      const [yesOrder, noOrder] = await Promise.all([
        placeLimitOrder('BUY', yesBid, this.cfg.min_size, this.cfg.yes_token_id),
        placeLimitOrder('BUY', noBid, this.cfg.min_size, this.cfg.no_token_id),
      ]);

      if (!yesOrder || !noOrder) {
        logger.warn(
          `[${this.shortId}] requote(${reason}): placement incomplete — ` +
          `BUY YES=${yesOrder?.orderId ?? 'FAILED'} BUY NO=${noOrder?.orderId ?? 'FAILED'}`
        );
      }
    } finally {
      this.isRequoting = false;
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
      logger.info(`[${this.shortId}] cancelOrders(${reason}) start`);
      const cancelled = await cancelMarketOrders(this.cfg.condition_id);
      if (!cancelled) {
        logger.warn(`[${this.shortId}] cancelOrders(${reason}) failed`);
        return false;
      }
      logger.info(`[${this.shortId}] cancelOrders(${reason}) confirmed`);
      return true;
    })().finally(() => {
      this.cancelInFlight = false;
      this.cancelPromise = null;
    });

    return this.cancelPromise;
  }
}
