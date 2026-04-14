import { roundToTick, calcMidpoint, applyBookDelta } from '../utils';
import { OrderBook } from '../types';

// ─── roundToTick ────────────────────────────────────────────────────────────

describe('roundToTick', () => {
  it('rounds to exact tick boundary (no-op when already aligned)', () => {
    expect(roundToTick(0.50, 0.01)).toBeCloseTo(0.50);
  });

  it('rounds up when price is above midpoint of tick interval', () => {
    // 0.556 → nearest 0.01 tick → 0.56
    expect(roundToTick(0.556, 0.01)).toBeCloseTo(0.56);
  });

  it('rounds down when price is below midpoint of tick interval', () => {
    // 0.554 → nearest 0.01 tick → 0.55
    expect(roundToTick(0.554, 0.01)).toBeCloseTo(0.55);
  });

  it('handles tick size of 0.001', () => {
    expect(roundToTick(0.6543, 0.001)).toBeCloseTo(0.654);
  });

  it('rounds up with tick size of 0.1', () => {
    // 0.36 / 0.1 = 3.6 → rounds to 4 → 0.4
    expect(roundToTick(0.36, 0.1)).toBeCloseTo(0.4);
  });

  it('returns 0 when price is 0', () => {
    expect(roundToTick(0, 0.01)).toBe(0);
  });
});

// ─── calcMidpoint ────────────────────────────────────────────────────────────

describe('calcMidpoint', () => {
  it('computes (bestBid + bestAsk) / 2 for a simple book', () => {
    const bids = [{ price: '0.40', size: '100' }];
    const asks = [{ price: '0.60', size: '100' }];
    expect(calcMidpoint(bids, asks)).toBeCloseTo(0.50);
  });

  it('picks the best bid among multiple levels', () => {
    const bids = [
      { price: '0.38', size: '50' },
      { price: '0.42', size: '50' },
    ];
    const asks = [{ price: '0.58', size: '100' }];
    expect(calcMidpoint(bids, asks)).toBeCloseTo(0.50); // (0.42 + 0.58) / 2
  });

  it('picks the best ask among multiple levels', () => {
    const bids = [{ price: '0.40', size: '100' }];
    const asks = [
      { price: '0.62', size: '50' },
      { price: '0.58', size: '50' },
    ];
    expect(calcMidpoint(bids, asks)).toBeCloseTo(0.49); // (0.40 + 0.58) / 2
  });

  it('returns null when bids array is empty', () => {
    expect(calcMidpoint([], [{ price: '0.60', size: '100' }])).toBeNull();
  });

  it('returns null when asks array is empty', () => {
    expect(calcMidpoint([{ price: '0.40', size: '100' }], [])).toBeNull();
  });

  it('returns null when both arrays are empty', () => {
    expect(calcMidpoint([], [])).toBeNull();
  });

  it('returns null when bestBid >= bestAsk (crossed book)', () => {
    const bids = [{ price: '0.70', size: '100' }];
    const asks = [{ price: '0.60', size: '100' }];
    expect(calcMidpoint(bids, asks)).toBeNull();
  });

  it('returns null when bestBid equals bestAsk', () => {
    const bids = [{ price: '0.50', size: '100' }];
    const asks = [{ price: '0.50', size: '100' }];
    expect(calcMidpoint(bids, asks)).toBeNull();
  });
});

// ─── applyBookDelta ──────────────────────────────────────────────────────────

describe('applyBookDelta', () => {
  const baseSnapshot: OrderBook = {
    bids: [
      { price: '0.40', size: '100' },
      { price: '0.38', size: '200' },
    ],
    asks: [
      { price: '0.60', size: '100' },
      { price: '0.62', size: '200' },
    ],
  };

  it('does not mutate the original snapshot', () => {
    const original = JSON.parse(JSON.stringify(baseSnapshot)) as OrderBook;
    applyBookDelta(baseSnapshot, { bids: [{ price: '0.40', size: '150' }] });
    expect(baseSnapshot).toEqual(original);
  });

  it('updates an existing bid level', () => {
    const result = applyBookDelta(baseSnapshot, {
      bids: [{ price: '0.40', size: '150' }],
    });
    const level = result.bids.find(b => b.price === '0.40');
    expect(level?.size).toBe('150');
    // other level unchanged
    expect(result.bids.find(b => b.price === '0.38')?.size).toBe('200');
  });

  it('adds a new bid level', () => {
    const result = applyBookDelta(baseSnapshot, {
      bids: [{ price: '0.36', size: '300' }],
    });
    expect(result.bids).toHaveLength(3);
    expect(result.bids.find(b => b.price === '0.36')?.size).toBe('300');
  });

  it('removes a bid level when size is "0"', () => {
    const result = applyBookDelta(baseSnapshot, {
      bids: [{ price: '0.40', size: '0' }],
    });
    expect(result.bids.find(b => b.price === '0.40')).toBeUndefined();
    expect(result.bids).toHaveLength(1);
  });

  it('removes a bid level when size is numeric 0', () => {
    // Some WS feeds send size as "0.0"
    const result = applyBookDelta(baseSnapshot, {
      bids: [{ price: '0.40', size: '0.0' }],
    });
    expect(result.bids.find(b => b.price === '0.40')).toBeUndefined();
  });

  it('updates ask levels independently of bids', () => {
    const result = applyBookDelta(baseSnapshot, {
      asks: [{ price: '0.60', size: '999' }],
    });
    expect(result.asks.find(a => a.price === '0.60')?.size).toBe('999');
    // bids unchanged
    expect(result.bids).toEqual(baseSnapshot.bids);
  });

  it('handles delta with no bids or asks key (no-op)', () => {
    const result = applyBookDelta(baseSnapshot, {});
    expect(result.bids).toEqual(baseSnapshot.bids);
    expect(result.asks).toEqual(baseSnapshot.asks);
  });

  it('handles delta that updates both sides simultaneously', () => {
    const result = applyBookDelta(baseSnapshot, {
      bids: [{ price: '0.40', size: '0' }],
      asks: [{ price: '0.60', size: '0' }],
    });
    expect(result.bids).toHaveLength(1);
    expect(result.asks).toHaveLength(1);
  });
});
