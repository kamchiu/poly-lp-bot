import { EventEmitter } from 'events';
import { placeLimitOrder, getTokenBalance } from './client';
import { notifyFill, notifyClosePlaced, notifyCloseComplete } from './notifier';
import { UserWsManager } from './user-ws-manager';
import { TrackedOrder } from './types';
import logger from './logger';

/** Markup applied to the fill price when placing the close limit order. */
const CLOSE_PRICE_MARKUP = 0.05; // +5%

interface CloseState {
  tokenId: string;
  sizeTarget: number;   // total size we need the close order to fill
  sizeFilled: number;   // accumulated close fills received so far
  fillPrice: number;
  closePrice: number;
  closeOrderId: string | null;
}

/**
 * Monitors tracked orders for fills via the authenticated `/ws/user` WebSocket channel
 * and auto-closes resulting positions.
 *
 * Strategy:
 *   1. Detect fill via `fill` events from UserWsManager (real-time, no polling)
 *   2. Place SELL limit order at fillPrice × (1 + CLOSE_PRICE_MARKUP) (+5%)
 *   3. Accumulate close-order fill events until sizeFilled >= sizeTarget
 *   4. Only then does 'closeComplete' fire and quoting resume
 *
 * Events emitted:
 *   - 'fillDetected'  : a fill was detected, closing is about to start
 *   - 'closeComplete' : close limit order fully filled; safe to resume quoting
 */
export class PositionMonitor extends EventEmitter {
  private trackedOrders: TrackedOrder[] = [];
  /** orderIds of our active LP orders — exact match prevents spurious triggers. */
  private watchedOrderIds = new Set<string>();
  /** Fills already accumulated per orderId — prevents double-counting on replay. */
  private processedFill = new Map<string, number>();
  private closing: CloseState | null = null;
  private shortId: string;

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
    logger.debug(`[${this.shortId}] Tracking ${orders.length} order(s): ${orders.map(o => o.orderId).join(', ')}`);
  }

  /** Whether a close operation is in progress (MarketMaker should defer requote). */
  isClosing(): boolean {
    return this.closing !== null;
  }

  /**
   * Full stop: remove WS listener and clear all state.
   * Call this on shutdown or when pausing a market that has NO active close.
   */
  stop(): void {
    this.userWs.off('fill', this.onWsFill);
    this.clearCloseState();
    this.trackedOrders = [];
    this.watchedOrderIds.clear();
    this.processedFill.clear();
  }

  /**
   * Stop tracking LP orders only — does NOT remove the WS fill listener.
   * Use this when THIS market's LP order has filled and we are waiting for
   * the close order fill. The WS listener must stay alive to catch it.
   */
  stopTracking(): void {
    this.trackedOrders = [];
    this.watchedOrderIds.clear();
    this.processedFill.clear();
  }

  private clearCloseState(): void {
    this.closing = null;
  }

  private handleFill(event: WsFillEvent): void {
    logger.debug(
      `[${this.shortId}] handleFill: orderId=${event.orderId.slice(0, 10)}… ` +
      `eventConditionId=${event.conditionId?.slice(0, 10) || 'null'}… ` +
      `thisConditionId=${this.conditionId.slice(0, 10)}… ` +
      `watched=${this.watchedOrderIds.has(event.orderId)} closing=${!!this.closing}`
    );

    // Filter to fills in our market (conditionId match)
    if (event.conditionId && event.conditionId !== this.conditionId) {
      logger.debug(`[${this.shortId}] Skipping fill: conditionId mismatch`);
      return;
    }

    // Case 1: fill on one of our tracked LP (buy) orders — exact orderId match
    if (this.watchedOrderIds.has(event.orderId) && !this.closing) {
      this.handleBuyFill(event);
      return;
    }

    // Case 2: fill on our close (SELL) order
    if (this.closing?.closeOrderId && event.orderId === this.closing.closeOrderId) {
      this.handleCloseFill(event);
    }
  }

  private handleBuyFill(event: WsFillEvent): void {
    const alreadyProcessed = this.processedFill.get(event.orderId) ?? 0;
    const newFillSize = event.size;

    if (newFillSize <= 0) return;

    const totalProcessed = alreadyProcessed + newFillSize;
    this.processedFill.set(event.orderId, totalProcessed);

    logger.info(
      `[${this.shortId}] Buy fill detected: orderId=${event.orderId} assetId=${event.assetId.slice(0, 10)}… ` +
      `side=${event.side} size=${newFillSize} total=${totalProcessed} @ ${event.price}`
    );

    // Stop watching for more LP-order fills — we are now managing a close.
    // WS listener stays registered (stopTracking, not stop).
    this.stopTracking();

    // Pause all markets via index.ts listener.
    // index.ts will call pauseForClose() on THIS market (keeps listener alive)
    // and pause() on other markets (cancels their LP orders).
    this.emit('fillDetected', this.conditionId);

    notifyFill({
      conditionId: this.conditionId,
      side: event.side as 'BUY' | 'SELL',
      tokenId: event.assetId,
      size: newFillSize,
      price: event.price,
      orderId: event.orderId,
    }).catch(() => {/* ignore notification errors */});

    this.closePosition(event.assetId, totalProcessed, event.price).catch(err => {
      logger.error(`[${this.shortId}] closePosition error:`, err);
    });
  }

  private handleCloseFill(event: WsFillEvent): void {
    if (!this.closing) return;

    this.closing.sizeFilled += event.size;
    logger.info(
      `[${this.shortId}] Close fill: orderId=${event.orderId} size=${event.size} ` +
      `filled=${this.closing.sizeFilled}/${this.closing.sizeTarget} @ ${event.price}`
    );

    if (this.closing.sizeFilled >= this.closing.sizeTarget) {
      this.finishClose('limit-filled');
    }
  }

  private async closePosition(tokenId: string, size: number, fillPrice: number): Promise<void> {
    const closePrice = parseFloat((fillPrice * (1 + CLOSE_PRICE_MARKUP)).toFixed(4));

    logger.info(
      `[${this.shortId}] Closing position: SELL ${size} token=${tokenId.slice(0, 10)}… ` +
      `fillPrice=${fillPrice} closePrice=${closePrice} (+${(CLOSE_PRICE_MARKUP * 100).toFixed(0)}%)`
    );

    // Wait for token balance to arrive (settlement delay after fill)
    const maxWaitMs = 30000; // 30s timeout
    const pollIntervalMs = 1000; // check every 1s
    const startTime = Date.now();
    let balance = 0;

    while (Date.now() - startTime < maxWaitMs) {
      balance = await getTokenBalance(tokenId);
      if (balance >= size) {
        logger.info(`[${this.shortId}] Token balance confirmed: ${balance} >= ${size}`);
        break;
      }
      logger.debug(`[${this.shortId}] Waiting for balance: ${balance}/${size} (${Math.floor((Date.now() - startTime) / 1000)}s)`);
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    if (balance < size) {
      logger.warn(`[${this.shortId}] Balance timeout: ${balance}/${size} after ${maxWaitMs}ms — abandoning position`);
      this.finishClose('balance-timeout');
      return;
    }

    const closeOrderId = await placeLimitOrder('SELL', closePrice, size, tokenId);

    this.closing = {
      tokenId,
      sizeTarget: size,
      sizeFilled: 0,
      fillPrice,
      closePrice,
      closeOrderId,
    };

    if (!closeOrderId) {
      logger.warn(`[${this.shortId}] Close limit order placement failed — abandoning position`);
      this.finishClose('limit-placement-failed');
      return;
    }

    logger.info(`[${this.shortId}] Close limit order placed: ${closeOrderId} — waiting for WS fill event`);

    await notifyClosePlaced({
      conditionId: this.conditionId,
      tokenId,
      size,
      closePrice,
      fillPrice,
      orderId: closeOrderId,
    });
  }

  private finishClose(reason: string): void {
    logger.info(`[${this.shortId}] Close complete (${reason})`);
    notifyCloseComplete({ conditionId: this.conditionId, reason }).catch(() => {/* ignore */});
    this.clearCloseState();
    this.emit('closeComplete');
  }
}

interface WsFillEvent {
  orderId: string;
  assetId: string;
  conditionId: string;
  price: number;
  size: number;
  side: string;
  feeRateBps: number;
}
