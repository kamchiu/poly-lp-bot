import { EventEmitter } from 'events';
import {
  cancelMarketOrders,
  cancelOrder,
  getBestBidAsk,
  getOrderStatus,
  getMarketInfo,
  placeLimitOrder,
  getTokenBalance,
} from './client';
import { notifyFill, notifyClosePlaced, notifyCloseComplete, notifyCloseFailed } from './notifier';
import { UserWsManager } from './user-ws-manager';
import { TrackedOrder } from './types';
import { roundToTick } from './utils';
import logger from './logger';

/** Start by aiming for a small edge, then chase the market down if it does not fill. */
const INITIAL_CLOSE_MARKUP = 0.01; // +1%
const CLOSE_REPRICE_STEP = 0.01; // tighten by 1pp on each retry
const MIN_CLOSE_MARKUP = -0.02; // allow up to 2% loss for a fast exit
const CLOSE_REPRICE_INTERVAL_MS = 5000;

interface CloseState {
  tokenId: string;
  sizeTarget: number;   // total size we need the close order to fill
  sizeFilled: number;   // accumulated close fills received so far
  fillPrice: number;
  closePrice: number;
  closeOrderId: string | null;
  closeOrderIds: string[];
  closeAttempt: number;
  phase: 'cancelling-lp' | 'awaiting-balance' | 'placing-limit' | 'waiting-close-fill' | 'risk-locked';
}

/**
 * Monitors tracked orders for fills via the authenticated `/ws/user` WebSocket channel
 * and auto-closes resulting positions.
 *
 * Strategy:
 *   1. Detect fill via `fill` events from UserWsManager (real-time, no polling)
 *   2. Cancel remaining LP orders in the same market before placing the close
 *   3. Place a fast SELL close order near the live book with a small target edge
 *   4. Reprice the close order on a timer until it fills or we risk-lock
 *   5. Accumulate close-order fill events until sizeFilled >= sizeTarget
 *   6. Only then does 'closeComplete' fire and quoting resume
 *
 * Events emitted:
 *   - 'fillDetected'  : a fill was detected, closing is about to start
 *   - 'closeComplete' : close limit order fully filled; safe to resume quoting
 *   - 'closeFailed'   : position state is unsafe; quoting must remain paused
 */
export class PositionMonitor extends EventEmitter {
  private trackedOrders: TrackedOrder[] = [];
  /** orderIds of our active LP orders — exact match prevents spurious triggers. */
  private watchedOrderIds = new Set<string>();
  /** Fills already accumulated per orderId — caps processing at the original order size. */
  private processedFill = new Map<string, number>();
  /** Idempotency keys for buy-order fills delivered via user WS replay. */
  private processedBuyEvents = new Set<string>();
  /** Orders already reconciled via REST after cancel, so later WS replay should be ignored. */
  private reconciledBuyOrderIds = new Set<string>();
  /** Idempotency keys for close-order fills delivered via user WS replay. */
  private processedCloseEvents = new Set<string>();
  /** Close orders already reconciled via REST, so later WS replay should be ignored. */
  private reconciledCloseOrderIds = new Set<string>();
  private closing: CloseState | null = null;
  private riskLockReason: string | null = null;
  private closeWorkflow: Promise<void> | null = null;
  private fillDetectedEmitted = false;
  private shortId: string;
  private closeRepriceTimer: NodeJS.Timeout | null = null;

  /** Bound listener reference — kept so we can cleanly remove it on stop(). */
  private readonly onWsFill: (event: WsFillEvent) => void;

  constructor(
    private readonly conditionId: string,
    private readonly userWs: UserWsManager,
  ) {
    super();
    this.shortId = conditionId.slice(0, 10);

    this.onWsFill = (event: WsFillEvent) => this.handleFill(event);
    this.userWs.on('fill', this.onWsFill);
  }

  /** Replace tracked orders (called after each requote). */
  trackOrders(orders: TrackedOrder[]): void {
    this.trackedOrders = orders;
    this.watchedOrderIds = new Set(orders.map(o => o.orderId));
    this.processedFill.clear();
    this.processedBuyEvents.clear();
    this.reconciledBuyOrderIds.clear();
    logger.debug(`[${this.shortId}] Tracking ${orders.length} order(s): ${orders.map(o => o.orderId).join(', ')}`);
  }

  /** Whether a close operation is in progress (MarketMaker should defer requote). */
  isClosing(): boolean {
    return this.closing !== null || this.riskLockReason !== null;
  }

  hasActiveCloseOrder(): boolean {
    return this.closing?.closeOrderId != null;
  }

  isRiskLocked(): boolean {
    return this.riskLockReason !== null;
  }

  /**
   * Full stop: remove WS listener and clear all state.
   * Call this on shutdown or when pausing a market that has NO active close.
   */
  stop(): void {
    this.userWs.off('fill', this.onWsFill);
    this.resetAllState();
  }

  /**
   * Stop tracking LP orders only — does NOT remove the WS fill listener.
   * Use this only after order cancellation is confirmed.
   */
  stopTracking(): void {
    this.trackedOrders = [];
    this.watchedOrderIds.clear();
    this.processedFill.clear();
    this.processedBuyEvents.clear();
    this.reconciledBuyOrderIds.clear();
  }

  private clearCloseState(): void {
    this.clearCloseRepriceTimer();
    this.closing = null;
    this.processedCloseEvents.clear();
    this.reconciledCloseOrderIds.clear();
    this.closeWorkflow = null;
    this.fillDetectedEmitted = false;
  }

  private resetAllState(): void {
    this.stopTracking();
    this.clearCloseState();
    this.riskLockReason = null;
  }

  private clearCloseRepriceTimer(): void {
    if (this.closeRepriceTimer) {
      clearTimeout(this.closeRepriceTimer);
      this.closeRepriceTimer = null;
    }
  }

  private handleFill(event: WsFillEvent): void {
    const fillSource = event.source ?? 'unknown';
    logger.debug(
      `[${this.shortId}] handleFill: orderId=${event.orderId.slice(0, 10)}… ` +
      `source=${fillSource} ` +
      `eventConditionId=${event.conditionId?.slice(0, 10) || 'null'}… ` +
      `thisConditionId=${this.conditionId.slice(0, 10)}… ` +
      `watched=${this.watchedOrderIds.has(event.orderId)} closing=${this.isClosing()}`
    );

    // Filter to fills in our market (conditionId match)
    if (event.conditionId && event.conditionId !== this.conditionId) {
      logger.debug(`[${this.shortId}] Skipping fill: conditionId mismatch`);
      return;
    }

    // Case 1: fill on one of our tracked LP (buy) orders — exact orderId match
    if (this.watchedOrderIds.has(event.orderId)) {
      this.handleBuyFill(event);
      return;
    }

    // Case 2: fill on our close (SELL) order
    if (this.closing?.closeOrderIds.includes(event.orderId)) {
      this.handleCloseFill(event);
    }
  }

  private handleBuyFill(event: WsFillEvent): void {
    const tracked = this.trackedOrders.find(order => order.orderId === event.orderId);
    if (!tracked) return;
    const fillSource = event.source ?? 'unknown';

    if (this.reconciledBuyOrderIds.has(event.orderId)) {
      logger.debug(`[${this.shortId}] Ignoring reconciled buy fill replay for ${event.orderId} source=${fillSource}`);
      return;
    }

    if (this.processedBuyEvents.has(event.eventKey)) {
      logger.debug(`[${this.shortId}] Ignoring duplicate buy fill event ${event.eventKey} source=${fillSource}`);
      return;
    }
    this.processedBuyEvents.add(event.eventKey);

    const alreadyProcessed = this.processedFill.get(event.orderId) ?? 0;
    const remainingForOrder = Math.max(0, tracked.size - alreadyProcessed);
    const appliedFillSize = Math.min(event.size, remainingForOrder);

    if (appliedFillSize <= 0) {
      logger.debug(
        `[${this.shortId}] Ignoring buy fill: source=${fillSource} raw=${event.size} ` +
        `remaining=${remainingForOrder} orderId=${event.orderId}`
      );
      return;
    }

    if (this.riskLockReason) {
      logger.error(
        `[${this.shortId}] Buy fill received while risk-locked (${this.riskLockReason}) orderId=${event.orderId}`
      );
      return;
    }

    if (this.closing?.phase === 'placing-limit') {
      this.enterRiskLock('buy-fill-while-placing-close');
      return;
    }

    if (this.closing?.closeOrderId) {
      this.enterRiskLock('buy-fill-after-close-placed');
      return;
    }

    if (this.closing && this.closing.tokenId !== event.assetId) {
      this.enterRiskLock('multiple-token-fills');
      return;
    }

    this.processedFill.set(event.orderId, alreadyProcessed + appliedFillSize);

    if (!this.closing) {
      this.closing = {
        tokenId: event.assetId,
        sizeTarget: appliedFillSize,
        sizeFilled: 0,
        fillPrice: event.price,
        closePrice: event.price,
        closeOrderId: null,
        closeOrderIds: [],
        closeAttempt: 0,
        phase: 'cancelling-lp',
      };
    } else {
      this.closing.sizeTarget += appliedFillSize;
      if (event.price > this.closing.fillPrice) {
        this.closing.fillPrice = event.price;
      }
    }

    logger.info(
      `[${this.shortId}] Buy fill detected: source=${fillSource} orderId=${event.orderId} assetId=${event.assetId.slice(0, 10)}… ` +
      `side=${event.side} size=${appliedFillSize} orderFilled=${this.processedFill.get(event.orderId)}/${tracked.size} ` +
      `closeTarget=${this.closing.sizeTarget} @ ${event.price}`
    );

    if (!this.fillDetectedEmitted) {
      this.fillDetectedEmitted = true;
      this.emit('fillDetected', this.conditionId);
    }

    notifyFill({
      conditionId: this.conditionId,
      side: event.side as 'BUY' | 'SELL',
      tokenId: event.assetId,
      size: appliedFillSize,
      price: event.price,
      orderId: event.orderId,
    }).catch(() => {/* ignore notification errors */});

    if (!this.closeWorkflow) {
      this.closeWorkflow = this.beginCloseWorkflow().catch(err => {
        logger.error(`[${this.shortId}] closePosition error:`, err);
        this.enterRiskLock('close-workflow-error');
      }).finally(() => {
        this.closeWorkflow = null;
      });
    }
  }

  private handleCloseFill(event: WsFillEvent): void {
    if (!this.closing) return;
    const fillSource = event.source ?? 'unknown';

    if (this.reconciledCloseOrderIds.has(event.orderId)) {
      logger.debug(`[${this.shortId}] Ignoring reconciled close fill replay for ${event.orderId} source=${fillSource}`);
      return;
    }

    if (this.processedCloseEvents.has(event.eventKey)) {
      logger.debug(`[${this.shortId}] Ignoring duplicate close fill event ${event.eventKey} source=${fillSource}`);
      return;
    }
    this.processedCloseEvents.add(event.eventKey);

    const remainingToClose = Math.max(0, this.closing.sizeTarget - this.closing.sizeFilled);
    const appliedFillSize = Math.min(event.size, remainingToClose);
    if (appliedFillSize <= 0) {
      logger.debug(
        `[${this.shortId}] Ignoring close fill: source=${fillSource} raw=${event.size} ` +
        `remaining=${remainingToClose} orderId=${event.orderId}`
      );
      return;
    }

    this.closing.sizeFilled += appliedFillSize;
    logger.info(
      `[${this.shortId}] Close fill: source=${fillSource} orderId=${event.orderId} size=${appliedFillSize} ` +
      `filled=${this.closing.sizeFilled}/${this.closing.sizeTarget} @ ${event.price}`
    );

    if (this.closing.sizeFilled >= this.closing.sizeTarget) {
      if (this.riskLockReason) {
        logger.warn(
          `[${this.shortId}] Close filled but market remains risk-locked (${this.riskLockReason})`
        );
        this.stopTracking();
        this.clearCloseState();
        return;
      }
      this.finishClose('limit-filled');
    }
  }

  private async computeClosePrice(): Promise<number> {
    if (!this.closing) {
      throw new Error('computeClosePrice called without active closing state');
    }

    const { tick_size } = await getMarketInfo(this.conditionId, 0.01);
    const { bestBid, bestAsk } = await getBestBidAsk(this.closing.tokenId);
    const markup = Math.max(
      INITIAL_CLOSE_MARKUP - (this.closing.closeAttempt * CLOSE_REPRICE_STEP),
      MIN_CLOSE_MARKUP,
    );
    const targetPrice = this.closing.fillPrice * (1 + markup);

    let candidatePrice = targetPrice;
    if (bestBid !== null && bestAsk !== null && bestBid < bestAsk) {
      candidatePrice = Math.min(bestAsk, Math.max(bestBid, targetPrice));
    } else if (bestAsk !== null) {
      candidatePrice = Math.min(bestAsk, targetPrice);
    } else if (bestBid !== null) {
      candidatePrice = Math.max(bestBid, targetPrice);
    }

    const boundedPrice = Math.min(Math.max(candidatePrice, tick_size), 1 - tick_size);
    return roundToTick(boundedPrice, tick_size);
  }

  private async beginCloseWorkflow(): Promise<void> {
    if (!this.closing) return;

    logger.info(
      `[${this.shortId}] Closing position: SELL ${this.closing.sizeTarget} token=${this.closing.tokenId.slice(0, 10)}… ` +
      `fillPrice=${this.closing.fillPrice}`
    );

    const cancelled = await cancelMarketOrders(this.conditionId);
    if (!cancelled) {
      this.enterRiskLock('lp-cancel-failed');
      return;
    }
    if (!this.closing) return;

    logger.info(`[${this.shortId}] LP cancel confirmed — source=reconcile:close-workflow-cancel`);
    await this.reconcileTrackedOrders('close-workflow-cancel');
    if (!this.closing || this.riskLockReason) return;

    this.closing.phase = 'awaiting-balance';

    // Wait for token balance to arrive (settlement delay after fill)
    const maxWaitMs = 30000; // 30s timeout
    const pollIntervalMs = 1000; // check every 1s
    const startTime = Date.now();
    let balance = 0;

    while (Date.now() - startTime < maxWaitMs) {
      if (!this.closing) return;
      balance = await getTokenBalance(this.closing.tokenId);
      if (balance >= this.closing.sizeTarget) {
        logger.info(`[${this.shortId}] Token balance confirmed: ${balance} >= ${this.closing.sizeTarget}`);
        break;
      }
      logger.debug(
        `[${this.shortId}] Waiting for balance: ${balance}/${this.closing.sizeTarget} ` +
        `(${Math.floor((Date.now() - startTime) / 1000)}s)`
      );
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    if (!this.closing) return;
    if (balance < this.closing.sizeTarget) {
      logger.warn(
        `[${this.shortId}] Balance timeout: ${balance}/${this.closing.sizeTarget} after ${maxWaitMs}ms — risk locking`
      );
      this.enterRiskLock('balance-timeout');
      return;
    }

    await this.placeCloseOrder('initial');
  }

  private async placeCloseOrder(reason: 'initial' | 'reprice'): Promise<void> {
    if (!this.closing) return;

    const remainingToClose = Math.max(0, this.closing.sizeTarget - this.closing.sizeFilled);
    if (remainingToClose <= 0) {
      this.finishClose('already-filled');
      return;
    }

    this.closing.phase = 'placing-limit';
    const closePrice = await this.computeClosePrice();
    const placedOrder = await placeLimitOrder(
      'SELL',
      closePrice,
      remainingToClose,
      this.closing.tokenId,
    );

    if (!placedOrder) {
      logger.warn(`[${this.shortId}] Close ${reason} placement failed — risk locking`);
      this.enterRiskLock(reason === 'initial' ? 'limit-placement-failed' : 'close-reprice-placement-failed');
      return;
    }

    if (!this.closing) return;
    const closeOrderId = placedOrder.orderId;
    this.closing.closeOrderId = closeOrderId;
    this.closing.closePrice = closePrice;
    this.closing.closeOrderIds.push(closeOrderId);
    this.closing.closeAttempt += 1;
    this.closing.phase = 'waiting-close-fill';

    if (reason === 'initial') {
      logger.info(
        `[${this.shortId}] Close limit order placed: ${closeOrderId} @ ${closePrice} ` +
        `status=${placedOrder.status || 'unknown'} — waiting for fill`
      );
      await notifyClosePlaced({
        conditionId: this.conditionId,
        tokenId: this.closing.tokenId,
        size: remainingToClose,
        closePrice: this.closing.closePrice,
        fillPrice: this.closing.fillPrice,
        orderId: closeOrderId,
      });
    } else {
      logger.info(
        `[${this.shortId}] Close limit order repriced: ${closeOrderId} @ ${closePrice} ` +
        `status=${placedOrder.status || 'unknown'} remaining=${remainingToClose}`
      );
    }

    if (!this.isLiveOrderStatus(placedOrder.status)) {
      await this.reconcileCloseOrder(closeOrderId, `close-${reason}-post-status`, placedOrder.status);
      if (!this.closing || this.riskLockReason || this.closing.closeOrderId !== closeOrderId) {
        return;
      }
    }

    this.scheduleCloseReprice();
  }

  private scheduleCloseReprice(): void {
    this.clearCloseRepriceTimer();

    if (!this.closing || this.riskLockReason) return;

    this.closeRepriceTimer = setTimeout(() => {
      this.closeRepriceTimer = null;
      this.repriceCloseOrder().catch(err => {
        logger.error(`[${this.shortId}] close repricing error:`, err);
        this.enterRiskLock('close-reprice-error');
      });
    }, CLOSE_REPRICE_INTERVAL_MS);
  }

  private async repriceCloseOrder(): Promise<void> {
    if (!this.closing || this.riskLockReason) return;

    const remainingToClose = Math.max(0, this.closing.sizeTarget - this.closing.sizeFilled);
    if (remainingToClose <= 0) {
      this.finishClose('limit-filled');
      return;
    }

    const currentCloseOrderId = this.closing.closeOrderId;
    if (!currentCloseOrderId) {
      this.enterRiskLock('close-order-missing');
      return;
    }

    const cancelled = await cancelOrder(currentCloseOrderId);
    if (!cancelled) {
      this.enterRiskLock('close-reprice-cancel-failed');
      return;
    }

    if (!this.closing) return;
    this.closing.closeOrderId = null;
    await this.placeCloseOrder('reprice');
  }

  private enterRiskLock(reason: string): void {
    if (this.riskLockReason) return;

    this.clearCloseRepriceTimer();
    this.riskLockReason = reason;
    if (this.closing) {
      this.closing.phase = 'risk-locked';
    }

    logger.error(`[${this.shortId}] Risk lock (${reason})`);
    notifyCloseFailed({ conditionId: this.conditionId, reason }).catch(() => {/* ignore */});
    this.emit('closeFailed', reason);
  }

  private finishClose(reason: string): void {
    logger.info(`[${this.shortId}] Close complete (${reason})`);
    notifyCloseComplete({ conditionId: this.conditionId, reason }).catch(() => {/* ignore */});
    this.stopTracking();
    this.clearCloseState();
    this.riskLockReason = null;
    this.emit('closeComplete');
  }

  async reconcileTrackedOrders(reason: string): Promise<void> {
    const reconcileSource = `reconcile:${reason}`;
    logger.info(`[${this.shortId}] Reconcile start: source=${reconcileSource} tracked=${this.trackedOrders.length}`);

    for (const tracked of this.trackedOrders) {
      const status = await getOrderStatus(tracked.orderId);
      if (!status) continue;

      if (this.isLiveOrderStatus(status.status)) {
        logger.debug(
          `[${this.shortId}] Reconcile ${reason}: source=${reconcileSource} order ${tracked.orderId} still live ` +
          `(matched=${status.sizeMatched}/${status.originalSize})`
        );
        continue;
      }

      const alreadyProcessed = this.processedFill.get(tracked.orderId) ?? 0;
      const delta = Math.max(0, status.sizeMatched - alreadyProcessed);
      if (delta <= 0) continue;

      logger.info(
        `[${this.shortId}] Reconcile ${reason}: source=${reconcileSource} orderId=${tracked.orderId} ` +
        `status=${status.status} matched=${status.sizeMatched}/${status.originalSize}`
      );

      this.handleBuyFill({
        source: reconcileSource,
        orderId: tracked.orderId,
        assetId: status.assetId || tracked.tokenId,
        conditionId: this.conditionId,
        price: status.price || tracked.price,
        size: delta,
        side: tracked.side,
        feeRateBps: 0,
        eventKey: `reconcile-buy|${reason}|${tracked.orderId}|${status.sizeMatched}|${status.status}`,
      });
      this.reconciledBuyOrderIds.add(tracked.orderId);
    }
  }

  private async reconcileCloseOrder(
    orderId: string,
    reason: string,
    initialStatus: string,
  ): Promise<void> {
    const reconcileSource = `reconcile:${reason}`;
    const status = await getOrderStatus(orderId);
    if (!status) return;

    if (this.isLiveOrderStatus(status.status)) {
      logger.debug(
        `[${this.shortId}] Close order ${orderId} returned status=${initialStatus}, ` +
        `source=${reconcileSource}, ` +
        `but getOrderStatus is still live`
      );
      return;
    }

    if (status.sizeMatched > 0) {
      logger.info(
        `[${this.shortId}] Reconcile close order ${orderId}: source=${reconcileSource} ` +
        `status=${status.status} matched=${status.sizeMatched}/${status.originalSize}`
      );
      this.handleCloseFill({
        source: reconcileSource,
        orderId,
        assetId: status.assetId || this.closing?.tokenId || '',
        conditionId: this.conditionId,
        price: status.price || this.closing?.closePrice || 0,
        size: status.sizeMatched,
        side: 'SELL',
        feeRateBps: 0,
        eventKey: `reconcile-close|${orderId}|${status.sizeMatched}|${status.status}`,
      });
      this.reconciledCloseOrderIds.add(orderId);
    } else {
      logger.warn(
        `[${this.shortId}] Close order ${orderId} is non-live without matched size ` +
        `(source=${reconcileSource} status=${status.status})`
      );
    }

    if (!this.closing || this.riskLockReason) return;

    if (this.closing.closeOrderId === orderId) {
      this.closing.closeOrderId = null;
    }

    const remainingToClose = Math.max(0, this.closing.sizeTarget - this.closing.sizeFilled);
    if (remainingToClose > 0 && !this.closing.closeOrderId) {
      await this.placeCloseOrder('reprice');
    }
  }

  private isLiveOrderStatus(status: string): boolean {
    return status.trim().toLowerCase() === 'live';
  }
}

interface WsFillEvent {
  source?: string;
  orderId: string;
  assetId: string;
  conditionId: string;
  price: number;
  size: number;
  side: string;
  feeRateBps: number;
  eventKey: string;
}
