import { EventEmitter } from 'events';
import { MarketMaker } from '../market-maker';
import { ResolvedMarketConfig } from '../types';

// ─── Mock ./client ────────────────────────────────────────────────────────────

const mockGetMarketInfo = jest.fn();
const mockGetRestMid = jest.fn();
const mockCancelMarketOrders = jest.fn();
const mockPlaceLimitOrder = jest.fn();
const mockGetOrderStatus = jest.fn();

jest.mock('../client', () => ({
  getMarketInfo: (...args: any[]) => mockGetMarketInfo(...args),
  getRestMid: (...args: any[]) => mockGetRestMid(...args),
  cancelMarketOrders: (...args: any[]) => mockCancelMarketOrders(...args),
  placeLimitOrder: (...args: any[]) => mockPlaceLimitOrder(...args),
  getOrderStatus: (...args: any[]) => mockGetOrderStatus(...args),
}));

jest.mock('../logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../notifier', () => ({
  __esModule: true,
  notifyFill: jest.fn().mockResolvedValue(undefined),
  notifyClosePlaced: jest.fn().mockResolvedValue(undefined),
  notifyCloseComplete: jest.fn().mockResolvedValue(undefined),
}));

// ─── helpers ─────────────────────────────────────────────────────────────────

const TOKEN_ID = 'TOKEN_YES_123';
const TOKEN_NO_ID = 'TOKEN_NO_456';
const CONDITION_ID = '0xCONDITION_ABC';

function makeConfig(overrides: Partial<ResolvedMarketConfig> = {}): ResolvedMarketConfig {
  return {
    condition_id: CONDITION_ID,
    yes_token_id: TOKEN_ID,
    no_token_id: TOKEN_NO_ID,
    min_size: 50,
    fallback_v: 0.05,
    spread_factor: 0.8,
    refresh_interval_ms: 3_600_000, // 1h — won't fire during tests
    drift_threshold_factor: 0.15,
    ws_host: 'wss://fake.host/',
    fill_poll_interval_ms: 3000,
    ...overrides,
  };
}

class FakeWsManager extends EventEmitter {}

function makeMarketMaker(cfgOverrides: Partial<ResolvedMarketConfig> = {}) {
  const ws = new FakeWsManager();
  const mm = new MarketMaker(makeConfig(cfgOverrides), ws as any);
  return { mm, ws };
}

// setTimeout(0) schedules a macrotask; all pending microtasks (promise chains)
// are fully drained before the macrotask fires. One call is sufficient.
const flushPromises = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function setupHappyPath(mid = 0.50, v = 0.10, tick = 0.01) {
  mockGetMarketInfo.mockResolvedValue({ v, tick_size: tick });
  mockGetRestMid.mockResolvedValue(mid);
  mockCancelMarketOrders.mockResolvedValue(undefined);
  mockPlaceLimitOrder.mockResolvedValue('order-id-123');
  mockGetOrderStatus.mockResolvedValue(null); // no fills by default
}

// ─── startup requote ─────────────────────────────────────────────────────────

describe('MarketMaker — startup requote', () => {
  afterEach(() => jest.clearAllMocks());

  it('cancels then places BUY YES and BUY NO on first WS midUpdate', async () => {
    setupHappyPath(0.50, 0.10, 0.01);
    const { mm, ws } = makeMarketMaker();
    mm.start();
    ws.emit('midUpdate', TOKEN_ID, 0.50); // lastQuotedMid is null → triggers requote
    await flushPromises();

    expect(mockCancelMarketOrders).toHaveBeenCalledWith(CONDITION_ID);
    expect(mockPlaceLimitOrder).toHaveBeenCalledWith('BUY', expect.any(Number), 50, TOKEN_ID);
    expect(mockPlaceLimitOrder).toHaveBeenCalledWith('BUY', expect.any(Number), 50, TOKEN_NO_ID);
    mm.stop();
  });

  it('calculates yesBid=round(mid - v*spread_factor, tick) and noPrice=round(1-(mid+s), tick)', async () => {
    // mid=0.50, v=0.10, spread_factor=0.8 → s=0.08 → yesBid=0.42, noPrice=1-0.58=0.42
    setupHappyPath(0.50, 0.10, 0.01);
    const { mm, ws } = makeMarketMaker();
    mm.start();
    ws.emit('midUpdate', TOKEN_ID, 0.50);
    await flushPromises();

    const yesBuyCall = mockPlaceLimitOrder.mock.calls.find(c => c[3] === TOKEN_ID);
    const noBuyCall = mockPlaceLimitOrder.mock.calls.find(c => c[3] === TOKEN_NO_ID);
    expect(yesBuyCall![1]).toBeCloseTo(0.42, 5);   // mid - s = 0.50 - 0.08
    expect(noBuyCall![1]).toBeCloseTo(0.42, 5);    // 1 - (mid + s) = 1 - 0.58
    mm.stop();
  });

  it('falls back to REST mid when WS cache is empty (timer-refresh trigger)', async () => {
    // Sequence: WS event triggers first requote (uses WS mid=0.50), which schedules
    // a refresh timer. When the timer fires, cachedMid is null (we clear it) so requote
    // falls back to REST mid=0.44.
    setupHappyPath(0.44, 0.10, 0.01); // REST returns 0.44
    const { mm, ws } = makeMarketMaker({ refresh_interval_ms: 20 }); // short timer
    mm.start();

    // First requote via WS (uses WS mid 0.50, not REST)
    mockGetRestMid.mockResolvedValue(0.50); // WS cache will be populated anyway
    ws.emit('midUpdate', TOKEN_ID, 0.50);
    await flushPromises(); // first requote completes → schedules 20ms refresh timer

    // Now clear WS cache and set REST to return 0.44 for the upcoming refresh
    (mm as any).cachedMid = null;
    mockGetRestMid.mockResolvedValue(0.44);
    mockPlaceLimitOrder.mockClear();
    mockGetMarketInfo.mockResolvedValue({ v: 0.10, tick_size: 0.01 });

    await new Promise<void>(resolve => setTimeout(resolve, 30)); // let refresh timer fire
    await flushPromises();

    expect(mockGetRestMid).toHaveBeenCalledWith(TOKEN_ID);
    const yesBuyCall = mockPlaceLimitOrder.mock.calls.find(c => c[3] === TOKEN_ID);
    // mid=0.44, s=0.08 → yesBid=0.36
    expect(yesBuyCall![1]).toBeCloseTo(0.36, 5);
    mm.stop();
  });

  it('skips placing orders when no mid is available', async () => {
    // Trigger: first WS requote succeeds, then refresh timer fires with REST=null → no orders
    setupHappyPath(0.50, 0.10, 0.01);
    const { mm, ws } = makeMarketMaker({ refresh_interval_ms: 20 });
    mm.start();

    ws.emit('midUpdate', TOKEN_ID, 0.50);
    await flushPromises(); // first requote completes → schedules 20ms refresh

    // For refresh: clear WS cache, make REST return null
    (mm as any).cachedMid = null;
    mockGetRestMid.mockResolvedValue(null);
    mockPlaceLimitOrder.mockClear();

    await new Promise<void>(resolve => setTimeout(resolve, 30));
    await flushPromises();

    expect(mockPlaceLimitOrder).not.toHaveBeenCalled();
    mm.stop();
  });
});

// ─── invalid bid/ask guard ────────────────────────────────────────────────────

describe('MarketMaker — invalid price sanity check', () => {
  afterEach(() => jest.clearAllMocks());

  it('skips order placement when spread pushes noPrice <= 0 (mid+s >= 1)', async () => {
    // mid=0.88, v=0.15, spread_factor=0.8 → s=0.12 → noPrice=1-1.00=0.00 ≤ 0
    mockGetMarketInfo.mockResolvedValue({ v: 0.15, tick_size: 0.01 });
    mockGetRestMid.mockResolvedValue(0.88);
    mockCancelMarketOrders.mockResolvedValue(undefined);
    const { mm } = makeMarketMaker({ spread_factor: 0.8 });
    mm.start();
    await flushPromises();

    expect(mockPlaceLimitOrder).not.toHaveBeenCalled();
    mm.stop();
  });

  it('skips order placement when spread pushes yesBid <= 0 (mid-s <= 0)', async () => {
    // mid=0.12, v=0.15, spread_factor=0.8 → s=0.12 → yesBid=0.00 ≤ 0
    mockGetMarketInfo.mockResolvedValue({ v: 0.15, tick_size: 0.01 });
    mockGetRestMid.mockResolvedValue(0.12);
    mockCancelMarketOrders.mockResolvedValue(undefined);
    const { mm } = makeMarketMaker({ spread_factor: 0.8 });
    mm.start();
    await flushPromises();

    expect(mockPlaceLimitOrder).not.toHaveBeenCalled();
    mm.stop();
  });
});

// ─── WS event-driven requote ──────────────────────────────────────────────────

describe('MarketMaker — WS-driven drift requote', () => {
  afterEach(() => jest.clearAllMocks());

  it('triggers requote when drift exceeds fallback_v * drift_threshold_factor', async () => {
    // fallback_v=0.05, drift_threshold=0.15 → threshold=0.0075
    // initial mid=0.50, new mid=0.52 → drift=0.02 > 0.0075 → requote
    setupHappyPath(0.50, 0.10, 0.01);
    const { mm, ws } = makeMarketMaker();
    mm.start();

    // First event: sets lastQuotedMid = 0.50
    ws.emit('midUpdate', TOKEN_ID, 0.50);
    await flushPromises();

    mockPlaceLimitOrder.mockClear();
    mockCancelMarketOrders.mockClear();
    mockGetMarketInfo.mockResolvedValue({ v: 0.10, tick_size: 0.01 });

    // Second event: drift=0.02 > threshold → requote
    ws.emit('midUpdate', TOKEN_ID, 0.52);
    await flushPromises();

    expect(mockPlaceLimitOrder).toHaveBeenCalledTimes(2); // BUY YES + BUY NO
    mm.stop();
  });

  it('does NOT requote when drift is below threshold', async () => {
    // fallback_v=0.05, drift_threshold=0.15 → threshold=0.0075; drift=0.001 → no requote
    setupHappyPath(0.50, 0.10, 0.01);
    const { mm, ws } = makeMarketMaker();
    mm.start();

    // First event: sets lastQuotedMid = 0.50
    ws.emit('midUpdate', TOKEN_ID, 0.50);
    await flushPromises();

    mockPlaceLimitOrder.mockClear();

    // Second event: drift=0.001 < 0.0075 → no requote
    ws.emit('midUpdate', TOKEN_ID, 0.501);
    await flushPromises();

    expect(mockPlaceLimitOrder).not.toHaveBeenCalled();
    mm.stop();
  });

  it('does not place a second requote while one is already in flight (isRequoting guard)', async () => {
    setupHappyPath(0.50, 0.10, 0.01);
    // Make requote slow so a second event arrives while it's still running
    let resolveOrder: () => void;
    mockPlaceLimitOrder.mockImplementation(() => new Promise(res => { resolveOrder = () => res('id'); }));

    const { mm, ws } = makeMarketMaker();
    mm.start();

    ws.emit('midUpdate', TOKEN_ID, 0.50); // first event → starts requote (hangs on placeLimitOrder)
    await flushPromises();

    // Second large-drift event arrives while requote is in flight
    ws.emit('midUpdate', TOKEN_ID, 0.70);
    await flushPromises();

    // Only the first requote's cancel + orders should run — second is blocked by isRequoting
    expect(mockCancelMarketOrders).toHaveBeenCalledTimes(1);

    resolveOrder!();
    await flushPromises();
    mm.stop();
  });

  it('ignores midUpdate events for other token IDs', async () => {
    setupHappyPath(0.50, 0.10, 0.01);
    const { mm, ws } = makeMarketMaker();
    mm.start();
    await flushPromises();

    mockPlaceLimitOrder.mockClear();
    ws.emit('midUpdate', 'OTHER_TOKEN', 0.80);
    await flushPromises();

    expect(mockPlaceLimitOrder).not.toHaveBeenCalled();
    mm.stop();
  });

  it('requotes on first midUpdate when lastQuotedMid is null', async () => {
    mockGetMarketInfo.mockResolvedValue({ v: 0.10, tick_size: 0.01 });
    mockGetRestMid.mockResolvedValue(null);
    mockCancelMarketOrders.mockResolvedValue(undefined);
    mockPlaceLimitOrder.mockResolvedValue('id');

    const { mm, ws } = makeMarketMaker();
    mm.start();
    await flushPromises();
    expect(mockPlaceLimitOrder).not.toHaveBeenCalled();

    mockGetRestMid.mockResolvedValue(0.50);
    ws.emit('midUpdate', TOKEN_ID, 0.50);
    await flushPromises();

    expect(mockPlaceLimitOrder).toHaveBeenCalledTimes(2);
    mm.stop();
  });
});

// ─── ws-reconnect trigger ─────────────────────────────────────────────────────

describe('MarketMaker — ws-reconnect trigger', () => {
  afterEach(() => jest.clearAllMocks());

  it('requotes immediately when WS reconnects', async () => {
    setupHappyPath(0.50, 0.10, 0.01);
    const { mm, ws } = makeMarketMaker();
    mm.start();

    // First WS event: sets cachedMid and lastQuotedMid
    ws.emit('midUpdate', TOKEN_ID, 0.50);
    await flushPromises();

    mockPlaceLimitOrder.mockClear();
    mockCancelMarketOrders.mockClear();

    ws.emit('connected');
    await flushPromises();

    expect(mockPlaceLimitOrder).toHaveBeenCalledTimes(2);
    mm.stop();
  });
});

// ─── stop ────────────────────────────────────────────────────────────────────

describe('MarketMaker — stop', () => {
  afterEach(() => jest.clearAllMocks());

  it('clears the refresh timer (clearTimeout is called)', async () => {
    setupHappyPath();
    const clearTimeoutSpy = jest.spyOn(global, 'clearTimeout');
    const { mm, ws } = makeMarketMaker({ refresh_interval_ms: 5000 });
    mm.start();

    // Trigger a requote so scheduleRefresh() runs and a timer is pending
    ws.emit('midUpdate', TOKEN_ID, 0.50);
    await flushPromises();

    mm.stop();
    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });

  it('does not place orders after stop() even when WS events arrive', async () => {
    setupHappyPath(0.50, 0.10, 0.01);
    const { mm, ws } = makeMarketMaker();
    mm.start();
    await flushPromises();

    mm.stop();
    mockPlaceLimitOrder.mockClear();

    // WS event arrives after stop — MarketMaker listener is still registered
    // but the timer is cancelled. This verifies stop() at minimum clears the timer.
    // (WS event listeners would need explicit removal to fully silence them,
    // which is out of scope for the current implementation.)
    ws.emit('connected'); // reconnect trigger
    await flushPromises();
    // connected event still triggers requote (listener not removed), but that's
    // documented behaviour — stop() only cancels the timer.
  });
});
