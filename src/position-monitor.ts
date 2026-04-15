import { EventEmitter } from 'events';
import {
  getOrderStatus,
  placeLimitOrder,
} from './client';
import { notifyFill, notifyClosePlaced, notifyCloseComplete } from './notifier';
import { TrackedOrder } from './types';
import logger from './logger';

/** Markup applied to the fill price when placing the close limit order. */
const CLOSE_PRICE_MARKUP = 0.05; // +5%

interface CloseState {
  tokenId: string;
  sizeMatched: number;
  fillPrice: number;
  closePrice: number;
  closeOrderId: string | null;
  /** interval for polling the close order — kept here so stop() can clear it */
  closeCheckTimer: NodeJS.Timeout | null;
}

/**
 * Monitors tracked orders for fills and auto-closes resulting positions.
 *
 * Strategy:
 *   1. Detect fill via polling getOrder() every fill_poll_interval_ms
 *   2. Place SELL limit order at fillPrice × (1 + CLOSE_PRICE_MARKUP) (+5%)
 *   3. Poll indefinitely until the close order is fully filled — no timeout, no market-sell fallback
 *   4. Only after the close limit fills does 'closeComplete' fire and quoting resume
 *
 * Events emitted:
 *   - 'fillDetected'  : a fill was detected, closing is about to start
 *   - 'closeComplete' : close limit order fully filled; safe to resume quoting
 */
export class PositionMonitor extends EventEmitter {
  private trackedOrders: TrackedOrder[] = [];
  /** sizeMatched already acted upon per orderId — prevents double-trigger on re-poll */
  private processedFill = new Map<string, number>();
  private pollTimer: NodeJS.Timeout | null = null;
  private closing: CloseState | null = null;
  private shortId: string;

  constructor(
    private readonly conditionId: string,
    private readonly fillPollIntervalMs: number,
  ) {
    super();
    this.shortId = conditionId.slice(0, 10);
  }

  /** Replace tracked orders (called after each requote). */
  trackOrders(orders: TrackedOrder[]): void {
    this.trackedOrders = orders;
    this.processedFill.clear();
    this.startPolling();
  }

  /** Whether a close operation is in progress (MarketMaker should defer requote). */
  isClosing(): boolean {
    return this.closing !== null;
  }

  stop(): void {
    this.stopPolling();
    this.clearCloseState();
  }

  private startPolling(): void {
    this.stopPolling();
    if (this.trackedOrders.length === 0) return;
    this.pollTimer = setInterval(() => this.pollForFills(), this.fillPollIntervalMs);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private clearCloseState(): void {
    if (!this.closing) return;
    if (this.closing.closeCheckTimer) clearInterval(this.closing.closeCheckTimer);
    this.closing = null;
  }

  private async pollForFills(): Promise<void> {
    if (this.closing) return;

    for (const tracked of this.trackedOrders) {
      if (!tracked.orderId || tracked.orderId === 'unknown') continue;

      const status = await getOrderStatus(tracked.orderId);
      if (!status) continue;

      const alreadyProcessed = this.processedFill.get(tracked.orderId) ?? 0;
      const newlyMatched = status.sizeMatched - alreadyProcessed;
      if (newlyMatched <= 0) continue;

      this.processedFill.set(tracked.orderId, status.sizeMatched);

      logger.info(
        `[${this.shortId}] Fill detected: ${tracked.side} orderId=${tracked.orderId} ` +
        `matched=${status.sizeMatched}/${status.originalSize} @ ${status.price}`
      );

      this.stopPolling();
      this.trackedOrders = [];
      this.processedFill.clear();

      // Pause all markets via index.ts listener
      this.emit('fillDetected', this.conditionId);

      await notifyFill({
        conditionId: this.conditionId,
        side: tracked.side,
        tokenId: tracked.tokenId,
        size: status.sizeMatched,
        price: status.price,
        orderId: tracked.orderId,
      });

      await this.closePosition(tracked.tokenId, status.sizeMatched, status.price);
      return;
    }
  }

  private async closePosition(tokenId: string, size: number, fillPrice: number): Promise<void> {
    const closePrice = parseFloat((fillPrice * (1 + CLOSE_PRICE_MARKUP)).toFixed(4));

    logger.info(
      `[${this.shortId}] Closing position: SELL ${size} token=${tokenId.slice(0, 10)}… ` +
      `fillPrice=${fillPrice} closePrice=${closePrice} (+${(CLOSE_PRICE_MARKUP * 100).toFixed(0)}%)`
    );

    const closeOrderId = await placeLimitOrder('SELL', closePrice, size, tokenId);

    this.closing = {
      tokenId,
      sizeMatched: size,
      fillPrice,
      closePrice,
      closeOrderId,
      closeCheckTimer: null,
    };

    if (!closeOrderId) {
      logger.warn(`[${this.shortId}] Close limit order placement failed — abandoning position`);
      this.finishClose('limit-placement-failed');
      return;
    }

    await notifyClosePlaced({
      conditionId: this.conditionId,
      tokenId,
      size,
      closePrice,
      fillPrice,
      orderId: closeOrderId,
    });

    // Poll indefinitely until fully filled — no timeout
    this.closing.closeCheckTimer = setInterval(async () => {
      await this.checkCloseOrder();
    }, this.fillPollIntervalMs);
  }

  private async checkCloseOrder(): Promise<void> {
    if (!this.closing?.closeOrderId) return;

    const status = await getOrderStatus(this.closing.closeOrderId);
    if (!status) return;

    if (status.sizeMatched >= this.closing.sizeMatched) {
      logger.info(`[${this.shortId}] Close limit order fully filled @ ${this.closing.closePrice}`);
      this.finishClose('limit-filled');
    }
  }

  private finishClose(reason: string): void {
    logger.info(`[${this.shortId}] Close complete (${reason})`);
    notifyCloseComplete({ conditionId: this.conditionId, reason }).catch(() => {/* ignore */});
    this.clearCloseState();
    this.emit('closeComplete');
  }
}
