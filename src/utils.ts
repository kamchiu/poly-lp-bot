import { OrderBook, OrderBookLevel } from './types';

/**
 * Round price to nearest tick size.
 */
export function roundToTick(price: number, tickSize: number): number {
  return normalizeTick(Math.round((price / tickSize) + 1e-9) * tickSize);
}

/**
 * Round price down to the nearest tick size.
 */
export function roundDownToTick(price: number, tickSize: number): number {
  return normalizeTick(Math.floor((price / tickSize) + 1e-9) * tickSize);
}

/**
 * Calculate midpoint from order book best bid/ask.
 * Returns null if order book is empty.
 */
export function calcMidpoint(bids: OrderBookLevel[], asks: OrderBookLevel[]): number | null {
  if (bids.length === 0 || asks.length === 0) return null;

  // bids sorted descending by price, asks ascending
  const bestBid = Math.max(...bids.map(b => parseFloat(b.price)));
  const bestAsk = Math.min(...asks.map(a => parseFloat(a.price)));

  if (bestBid <= 0 || bestAsk <= 0 || bestBid >= bestAsk) return null;
  return (bestBid + bestAsk) / 2;
}

/**
 * Apply incremental order book delta to snapshot.
 * delta entries with size "0" are removals.
 */
export function applyBookDelta(snapshot: OrderBook, delta: Partial<OrderBook>): OrderBook {
  const result: OrderBook = {
    bids: [...snapshot.bids],
    asks: [...snapshot.asks],
  };

  if (delta.bids) {
    result.bids = mergeLevels(result.bids, delta.bids);
  }
  if (delta.asks) {
    result.asks = mergeLevels(result.asks, delta.asks);
  }

  return result;
}

function mergeLevels(existing: OrderBookLevel[], updates: OrderBookLevel[]): OrderBookLevel[] {
  const map = new Map<string, string>();
  for (const lvl of existing) {
    map.set(lvl.price, lvl.size);
  }
  for (const upd of updates) {
    if (upd.size === '0' || parseFloat(upd.size) === 0) {
      map.delete(upd.price);
    } else {
      map.set(upd.price, upd.size);
    }
  }
  return Array.from(map.entries()).map(([price, size]) => ({ price, size }));
}

function normalizeTick(price: number): number {
  return parseFloat(price.toFixed(10));
}
