import { EventEmitter } from 'events';
import { PositionMonitor } from '../position-monitor';
import { TrackedOrder } from '../types';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockPlaceLimitOrder = jest.fn();
jest.mock('../client', () => ({
  placeLimitOrder: (...args: any[]) => mockPlaceLimitOrder(...args),
}));

jest.mock('../logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockNotifyFill = jest.fn().mockResolvedValue(undefined);
const mockNotifyClosePlaced = jest.fn().mockResolvedValue(undefined);
const mockNotifyCloseComplete = jest.fn().mockResolvedValue(undefined);
jest.mock('../notifier', () => ({
  notifyFill: (...args: any[]) => mockNotifyFill(...args),
  notifyClosePlaced: (...args: any[]) => mockNotifyClosePlaced(...args),
  notifyCloseComplete: (...args: any[]) => mockNotifyCloseComplete(...args),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

const CONDITION_ID = '0xABC123';
const YES_TOKEN = 'TOKEN_YES';
const NO_TOKEN = 'TOKEN_NO';
const ORDER_YES = 'order-yes-001';
const ORDER_NO = 'order-no-001';
const CLOSE_ORDER = 'close-order-001';

const flushPromises = () => new Promise<void>(resolve => setTimeout(resolve, 0));

class FakeUserWs extends EventEmitter {}

function makePm() {
  const userWs = new FakeUserWs();
  const pm = new PositionMonitor(CONDITION_ID, userWs as any);
  return { pm, userWs };
}

function makeTracked(overrides: Partial<TrackedOrder>[] = []): TrackedOrder[] {
  const base: TrackedOrder[] = [
    { orderId: ORDER_YES, tokenId: YES_TOKEN, side: 'BUY', price: 0.45, size: 50 },
    { orderId: ORDER_NO,  tokenId: NO_TOKEN,  side: 'BUY', price: 0.55, size: 50 },
  ];
  return base.map((o, i) => ({ ...o, ...(overrides[i] ?? {}) }));
}

function emitFill(userWs: FakeUserWs, partial: Partial<{
  orderId: string; assetId: string; conditionId: string;
  price: number; size: number; side: string; feeRateBps: number;
}>) {
  userWs.emit('fill', {
    orderId: ORDER_YES,
    assetId: YES_TOKEN,
    conditionId: CONDITION_ID,
    price: 0.45,
    size: 50,
    side: 'BUY',
    feeRateBps: 0,
    ...partial,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockPlaceLimitOrder.mockResolvedValue(CLOSE_ORDER);
});

describe('PositionMonitor — buy-fill detection', () => {
  it('emits fillDetected when a tracked orderId fills', async () => {
    const { pm, userWs } = makePm();
    pm.trackOrders(makeTracked());

    const fillDetected = jest.fn();
    pm.on('fillDetected', fillDetected);

    emitFill(userWs, { orderId: ORDER_YES, size: 50 });
    await flushPromises();

    expect(fillDetected).toHaveBeenCalledWith(CONDITION_ID);
  });

  it('ignores fill for an untracked orderId (Bug 4)', async () => {
    const { pm, userWs } = makePm();
    pm.trackOrders(makeTracked());

    const fillDetected = jest.fn();
    pm.on('fillDetected', fillDetected);

    // Different orderId — should be silently ignored
    emitFill(userWs, { orderId: 'UNKNOWN_ORDER', assetId: YES_TOKEN, size: 50 });
    await flushPromises();

    expect(fillDetected).not.toHaveBeenCalled();
    expect(mockPlaceLimitOrder).not.toHaveBeenCalled();
  });

  it('ignores fill for a different market conditionId', async () => {
    const { pm, userWs } = makePm();
    pm.trackOrders(makeTracked());

    const fillDetected = jest.fn();
    pm.on('fillDetected', fillDetected);

    emitFill(userWs, { orderId: ORDER_YES, conditionId: '0xOTHER' });
    await flushPromises();

    expect(fillDetected).not.toHaveBeenCalled();
  });

  it('places a close SELL order after buy fill', async () => {
    const { pm, userWs } = makePm();
    pm.trackOrders(makeTracked());

    emitFill(userWs, { orderId: ORDER_YES, assetId: YES_TOKEN, price: 0.40, size: 50 });
    await flushPromises();

    // Close price = 0.40 * 1.05 = 0.42
    expect(mockPlaceLimitOrder).toHaveBeenCalledWith('SELL', 0.42, 50, YES_TOKEN);
  });

  it('does not trigger second fillDetected if already closing', async () => {
    const { pm, userWs } = makePm();
    pm.trackOrders(makeTracked());

    const fillDetected = jest.fn();
    pm.on('fillDetected', fillDetected);

    // First fill
    emitFill(userWs, { orderId: ORDER_YES, size: 50 });
    await flushPromises();

    // Second fill for the same (or another) order — should be ignored
    emitFill(userWs, { orderId: ORDER_NO, size: 50 });
    await flushPromises();

    expect(fillDetected).toHaveBeenCalledTimes(1);
    expect(mockPlaceLimitOrder).toHaveBeenCalledTimes(1);
  });
});

describe('PositionMonitor — close-fill accumulation (Bug 2)', () => {
  async function setupCloseInProgress() {
    const { pm, userWs } = makePm();
    pm.trackOrders(makeTracked());

    pm.on('fillDetected', () => {/* pause handled externally */});

    emitFill(userWs, { orderId: ORDER_YES, assetId: YES_TOKEN, price: 0.40, size: 50 });
    await flushPromises(); // drains: stopTracking + emit + closePosition async
    return { pm, userWs };
  }

  it('does not emit closeComplete on a partial close fill', async () => {
    const { pm, userWs } = await setupCloseInProgress();
    expect(pm.isClosing()).toBe(true);

    const closeComplete = jest.fn();
    pm.on('closeComplete', closeComplete);

    // Only 30 of 50 filled
    emitFill(userWs, { orderId: CLOSE_ORDER, size: 30 });
    await flushPromises();

    expect(closeComplete).not.toHaveBeenCalled();
    expect(pm.isClosing()).toBe(true);
  });

  it('emits closeComplete only when accumulated size reaches target', async () => {
    const { pm, userWs } = await setupCloseInProgress();

    const closeComplete = jest.fn();
    pm.on('closeComplete', closeComplete);

    // Two partial fills summing to 50
    emitFill(userWs, { orderId: CLOSE_ORDER, size: 30 });
    await flushPromises();
    expect(closeComplete).not.toHaveBeenCalled();

    emitFill(userWs, { orderId: CLOSE_ORDER, size: 20 });
    await flushPromises();
    expect(closeComplete).toHaveBeenCalledTimes(1);
    expect(pm.isClosing()).toBe(false);
  });

  it('emits closeComplete on a single fill that exactly matches target', async () => {
    const { pm, userWs } = await setupCloseInProgress();

    const closeComplete = jest.fn();
    pm.on('closeComplete', closeComplete);

    emitFill(userWs, { orderId: CLOSE_ORDER, size: 50 });
    await flushPromises();

    expect(closeComplete).toHaveBeenCalledTimes(1);
  });

  it('ignores fill for wrong close orderId', async () => {
    const { pm, userWs } = await setupCloseInProgress();

    const closeComplete = jest.fn();
    pm.on('closeComplete', closeComplete);

    emitFill(userWs, { orderId: 'WRONG_CLOSE_ORDER', size: 50 });
    await flushPromises();

    expect(closeComplete).not.toHaveBeenCalled();
  });
});

describe('PositionMonitor — stopTracking vs stop (Bug 1)', () => {
  it('stopTracking keeps the WS listener so close fills are still received', async () => {
    const { pm, userWs } = makePm();
    pm.trackOrders(makeTracked());
    pm.on('fillDetected', () => {/* handled externally */});

    // Simulate buy fill
    emitFill(userWs, { orderId: ORDER_YES, assetId: YES_TOKEN, size: 50 });
    await flushPromises();

    // stopTracking is called internally by handleBuyFill; WS listener must still be active
    expect(pm.isClosing()).toBe(true);

    const closeComplete = jest.fn();
    pm.on('closeComplete', closeComplete);

    // Close fill arrives — listener must still fire
    emitFill(userWs, { orderId: CLOSE_ORDER, size: 50 });
    await flushPromises();

    expect(closeComplete).toHaveBeenCalledTimes(1);
  });

  it('stop() removes the WS listener so no more events are processed', async () => {
    const { pm, userWs } = makePm();
    pm.trackOrders(makeTracked());

    const fillDetected = jest.fn();
    pm.on('fillDetected', fillDetected);

    pm.stop();

    emitFill(userWs, { orderId: ORDER_YES, size: 50 });
    await flushPromises();

    expect(fillDetected).not.toHaveBeenCalled();
  });
});

describe('PositionMonitor — finishClose on placement failure', () => {
  it('emits closeComplete immediately if close order placement fails', async () => {
    mockPlaceLimitOrder.mockResolvedValue(null); // simulate failure

    const { pm, userWs } = makePm();
    pm.trackOrders(makeTracked());

    const closeComplete = jest.fn();
    pm.on('closeComplete', closeComplete);
    pm.on('fillDetected', () => {});

    emitFill(userWs, { orderId: ORDER_YES, size: 50 });
    await flushPromises();

    expect(closeComplete).toHaveBeenCalledTimes(1);
    expect(pm.isClosing()).toBe(false);
  });
});
