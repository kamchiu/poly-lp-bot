import { EventEmitter } from 'events';
import {
  getOrderStatus,
  placeLimitOrder,
  placeMarketSellOrder,
  cancelOrder,
} from './client';
import { TrackedOrder } from './types';
import logger from './logger';

interface CloseState {
  tokenId: string;
  sizeMatched: number;
  fillPrice: number;
  closeOrderId: string | null;
  timeout: NodeJS.Timeout | null;
}

/**
 * Monitors tracked orders for fills and auto-closes resulting positions.
 *
 * Strategy:
 *   1. Detect fill via polling getOrder() every fill_poll_interval_ms
 *   2. Place SELL limit order at fill price (break-even attempt)
 *   3. If not filled within close_limit_timeout_ms, cancel and market sell (FOK)
 *
 * Events emitted:
 *   - 'fillDetected': a fill was detected, closing is about to start
 *   - 'closeComplete': position fully closed, safe to requote
 */
export class PositionMonitor extends EventEmitter {
  private trackedOrders: TrackedOrder[] = [];
  private pollTimer: NodeJS.Timeout | null = null;
  private closing: CloseState | null = null;
  private shortId: string;

  constructor(
    private readonly conditionId: string,
    private readonly fillPollIntervalMs: number,
    private readonly closeLimitTimeoutMs: number,
  ) {
    super();
    this.shortId = conditionId.slice(0, 10);
  }

  /** Replace tracked orders (called after each requote). */
  trackOrders(orders: TrackedOrder[]): void {
    this.trackedOrders = orders;
    this.startPolling();
  }

  /** Whether a close operation is in progress (MarketMaker should defer requote). */
  isClosing(): boolean {
    return this.closing !== null;
  }

  stop(): void {
    this.stopPolling();
    if (this.closing?.timeout) {
      clearTimeout(this.closing.timeout);
    }
    this.closing = null;
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

  private async pollForFills(): Promise<void> {
    // Don't poll if already closing a position
    if (this.closing) return;

    for (const tracked of this.trackedOrders) {
      if (!tracked.orderId || tracked.orderId === 'unknown') continue;

      const status = await getOrderStatus(tracked.orderId);
      if (!status) continue;

      if (status.sizeMatched > 0) {
        logger.info(
          `[${this.shortId}] Fill detected: ${tracked.side} orderId=${tracked.orderId} ` +
          `matched=${status.sizeMatched}/${status.originalSize} @ ${status.price}`
        );

        // Stop polling — we'll resume after close completes
        this.stopPolling();
        this.trackedOrders = [];

        // Notify listeners (e.g. index.ts) so other markets can be paused
        this.emit('fillDetected', this.conditionId);

        await this.closePosition(tracked.tokenId, status.sizeMatched, status.price);
        return; // Process one fill at a time
      }
    }
  }

  private async closePosition(tokenId: string, size: number, fillPrice: number): Promise<void> {
    // Step 1: Place SELL limit at fill price (break-even attempt)
    logger.info(
      `[${this.shortId}] Closing position: SELL ${size} token=${tokenId.slice(0, 10)}... @ ${fillPrice}`
    );

    const closeOrderId = await placeLimitOrder('SELL', fillPrice, size, tokenId);

    this.closing = {
      tokenId,
      sizeMatched: size,
      fillPrice,
      closeOrderId,
      timeout: null,
    };

    if (!closeOrderId) {
      // Limit order failed — go straight to market sell
      logger.warn(`[${this.shortId}] Close limit order failed, falling back to market sell`);
      await this.marketSellFallback();
      return;
    }

    // Step 2: Set timeout — if limit doesn't fill, escalate to market sell
    this.closing.timeout = setTimeout(async () => {
      await this.onCloseLimitTimeout();
    }, this.closeLimitTimeoutMs);

    // Step 3: Poll the close order to see if it fills before timeout
    this.pollCloseOrder();
  }

  private async pollCloseOrder(): Promise<void> {
    if (!this.closing?.closeOrderId) return;

    const checkInterval = setInterval(async () => {
      if (!this.closing?.closeOrderId) {
        clearInterval(checkInterval);
        return;
      }

      const status = await getOrderStatus(this.closing.closeOrderId);
      if (!status) return;

      if (status.sizeMatched >= this.closing.sizeMatched) {
        // Fully filled — close complete
        logger.info(
          `[${this.shortId}] Close limit order fully filled at ${this.closing.fillPrice}`
        );
        clearInterval(checkInterval);
        this.finishClose('limit-filled');
      }
    }, this.fillPollIntervalMs);

    // Clean up interval if closing state is cleared
    const cleanup = () => {
      clearInterval(checkInterval);
    };
    this.once('closeComplete', cleanup);
  }

  private async onCloseLimitTimeout(): Promise<void> {
    if (!this.closing) return;

    logger.info(
      `[${this.shortId}] Close limit order timed out after ${this.closeLimitTimeoutMs}ms, ` +
      `falling back to market sell`
    );

    // Cancel the limit order
    if (this.closing.closeOrderId) {
      await cancelOrder(this.closing.closeOrderId);
    }

    // Check how much is still unfilled
    if (this.closing.closeOrderId) {
      const status = await getOrderStatus(this.closing.closeOrderId);
      if (status && status.sizeMatched >= this.closing.sizeMatched) {
        // Actually filled in the meantime
        logger.info(`[${this.shortId}] Close limit order filled just before timeout`);
        this.finishClose('limit-filled-at-timeout');
        return;
      }
      // Adjust remaining size
      if (status) {
        this.closing.sizeMatched -= status.sizeMatched;
      }
    }

    await this.marketSellFallback();
  }

  private async marketSellFallback(): Promise<void> {
    if (!this.closing || this.closing.sizeMatched <= 0) {
      this.finishClose('nothing-to-sell');
      return;
    }

    logger.info(
      `[${this.shortId}] Market selling ${this.closing.sizeMatched} of token=${this.closing.tokenId.slice(0, 10)}...`
    );

    const result = await placeMarketSellOrder(this.closing.tokenId, this.closing.sizeMatched);
    if (result) {
      logger.info(`[${this.shortId}] Market sell placed → orderId=${result}`);
    } else {
      logger.error(`[${this.shortId}] Market sell FAILED — position may still be open`);
    }

    this.finishClose('market-sell');
  }

  private finishClose(reason: string): void {
    if (this.closing?.timeout) {
      clearTimeout(this.closing.timeout);
    }
    logger.info(`[${this.shortId}] Close complete (${reason})`);
    this.closing = null;
    this.emit('closeComplete');
  }
}
