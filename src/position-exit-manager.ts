import { EventEmitter } from 'events';
import { getOrderStatus, placeLimitOrder } from './client';
import logger from './logger';
import { ManagedPosition, QuoteUpdate } from './types';
import { WsManager } from './ws-manager';

export interface ExitPlacedEvent {
  orderId: string;
  price: number;
  size: number;
  status: string;
}

export class PositionExitManager extends EventEmitter {
  private exitInFlight = false;
  private exitSubmitted = false;
  private started = false;

  private readonly onQuoteUpdate = (update: QuoteUpdate) => {
    this.handleQuoteUpdate(update).catch(err => {
      logger.error('[PositionExit] Fatal quote handling error:', err);
      this.emit('fatal', err);
      this.stop();
    });
  };

  constructor(
    private readonly position: ManagedPosition,
    private readonly wsManager: WsManager,
  ) {
    super();
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    this.wsManager.on('quoteUpdate', this.onQuoteUpdate);
    this.wsManager.subscribe([this.position.tokenId]);

    logger.info(
      `[PositionExit] Watching ${this.position.outcome} token=${this.position.tokenId.slice(0, 10)}... ` +
      `size=${this.position.size} avgPrice=${this.position.avgPrice}`
    );
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;

    this.wsManager.off('quoteUpdate', this.onQuoteUpdate);
  }

  hasSubmittedExit(): boolean {
    return this.exitSubmitted;
  }

  private async handleQuoteUpdate(update: QuoteUpdate): Promise<void> {
    if (!this.started || this.exitSubmitted || this.exitInFlight) return;
    if (update.tokenId !== this.position.tokenId) return;

    const bestBid = update.bestBid;
    if (bestBid === null || bestBid <= this.position.avgPrice) {
      return;
    }

    this.exitInFlight = true;

    try {
      logger.info(
        `[PositionExit] Trigger met token=${this.position.tokenId.slice(0, 10)}... ` +
        `bestBid=${bestBid} avgPrice=${this.position.avgPrice}`
      );

      const order = await placeLimitOrder(
        'SELL',
        bestBid,
        this.position.size,
        this.position.tokenId,
      );

      if (!order) {
        logger.warn('[PositionExit] Exit order placement failed, continuing to monitor');
        return;
      }

      this.exitSubmitted = true;
      const orderStatus = await getOrderStatus(order.orderId);
      const status = orderStatus?.status || order.status || 'unknown';

      logger.info(
        `[PositionExit] Exit order submitted orderId=${order.orderId} price=${order.price} ` +
        `size=${order.size} status=${status}`
      );

      this.emit('exitPlaced', {
        orderId: order.orderId,
        price: order.price,
        size: order.size,
        status,
      } satisfies ExitPlacedEvent);

      this.stop();
    } finally {
      this.exitInFlight = false;
    }
  }
}
