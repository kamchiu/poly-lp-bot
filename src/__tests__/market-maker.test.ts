import { EventEmitter } from 'events';
import { MarketMaker } from '../market-maker';
import type { UserWsManager } from '../user-ws-manager';
import type { WsManager } from '../ws-manager';
import logger from '../logger';
import {
  cancelMarketOrders,
  cancelOrder,
  getBestBidAsk,
  getOrderStatus,
  placeLimitOrder,
  getMarketInfo,
  getRestMid,
  getTokenBalance,
} from '../client';
import { ResolvedMarketConfig } from '../types';

jest.mock('../client', () => ({
  cancelMarketOrders: jest.fn(),
  cancelOrder: jest.fn(),
  getBestBidAsk: jest.fn(),
  getOrderStatus: jest.fn(),
  placeLimitOrder: jest.fn(),
  getMarketInfo: jest.fn(),
  getRestMid: jest.fn(),
  getTokenBalance: jest.fn(),
}));

jest.mock('../notifier', () => ({
  notifyFill: jest.fn().mockResolvedValue(undefined),
  notifyClosePlaced: jest.fn().mockResolvedValue(undefined),
  notifyCloseComplete: jest.fn().mockResolvedValue(undefined),
  notifyCloseFailed: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const cancelMarketOrdersMock = cancelMarketOrders as jest.MockedFunction<typeof cancelMarketOrders>;
const cancelOrderMock = cancelOrder as jest.MockedFunction<typeof cancelOrder>;
const getBestBidAskMock = getBestBidAsk as jest.MockedFunction<typeof getBestBidAsk>;
const getOrderStatusMock = getOrderStatus as jest.MockedFunction<typeof getOrderStatus>;
const placeLimitOrderMock = placeLimitOrder as jest.MockedFunction<typeof placeLimitOrder>;
const getMarketInfoMock = getMarketInfo as jest.MockedFunction<typeof getMarketInfo>;
const getRestMidMock = getRestMid as jest.MockedFunction<typeof getRestMid>;
const getTokenBalanceMock = getTokenBalance as jest.MockedFunction<typeof getTokenBalance>;
const loggerMock = logger as unknown as {
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
  debug: jest.Mock;
};

const buildPlacedOrder = (
  orderId: string,
  overrides: Partial<NonNullable<Awaited<ReturnType<typeof placeLimitOrder>>>> = {},
): NonNullable<Awaited<ReturnType<typeof placeLimitOrder>>> => ({
  orderId,
  status: 'live',
  price: 0.45,
  size: 20,
  tokenId: 'token-id',
  side: 'BUY',
  ...overrides,
});

const flushPromises = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
};

const createConfig = (overrides: Partial<ResolvedMarketConfig> = {}): ResolvedMarketConfig => ({
  condition_id: '0x1111111111111111111111111111111111111111111111111111111111111111',
  yes_token_id: '0x2222222222222222222222222222222222222222222222222222222222222222',
  no_token_id: '0x3333333333333333333333333333333333333333333333333333333333333333',
  min_size: 20,
  fallback_v: 0.045,
  spread_factor: 0.7,
  refresh_interval_ms: 70000,
  drift_threshold_factor: 0.25,
  fill_poll_interval_ms: 3000,
  ws_host: 'wss://example.test/ws',
  ...overrides,
});

const emitQuote = (
  wsManager: EventEmitter,
  tokenId: string,
  bestBid: number,
  bestAsk: number,
  bidDepth: number,
): void => {
  wsManager.emit('quoteUpdate', {
    tokenId,
    bestBid,
    bestAsk,
    book: {
      bids: [
        { price: bestBid.toString(), size: bidDepth.toString() },
      ],
      asks: [
        { price: bestAsk.toString(), size: '25' },
      ],
    },
  });
};

describe('MarketMaker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    cancelMarketOrdersMock.mockReset();
    cancelOrderMock.mockReset();
    getBestBidAskMock.mockReset();
    getOrderStatusMock.mockReset();
    placeLimitOrderMock.mockReset();
    getMarketInfoMock.mockReset();
    getRestMidMock.mockReset();
    getTokenBalanceMock.mockReset();
    cancelOrderMock.mockResolvedValue(true);
    getBestBidAskMock.mockResolvedValue({ bestBid: 0.45, bestAsk: 0.47 });
  });

  it('allows clean shutdown when no close order is active', async () => {
    cancelMarketOrdersMock.mockResolvedValue(true);

    const cfg = createConfig();
    const wsManager = new EventEmitter();
    const userWsManager = new EventEmitter();
    const maker = new MarketMaker(cfg, wsManager as WsManager, userWsManager as UserWsManager);

    await expect(maker.shutdown()).resolves.toEqual({ safeToExit: true });
    expect(cancelMarketOrdersMock).toHaveBeenCalledWith(cfg.condition_id);
  });

  it('cancels on proximity and requotes immediately', async () => {
    cancelMarketOrdersMock.mockResolvedValue(true);
    getMarketInfoMock.mockResolvedValue({ v: 0.045, tick_size: 0.01 });
    getRestMidMock.mockResolvedValue(0.5);
    placeLimitOrderMock
      .mockResolvedValueOnce(buildPlacedOrder('yes-order-1'))
      .mockResolvedValueOnce(buildPlacedOrder('no-order-1'))
      .mockResolvedValueOnce(buildPlacedOrder('yes-order-2'))
      .mockResolvedValueOnce(buildPlacedOrder('no-order-2'));

    const cfg = createConfig();
    const wsManager = new EventEmitter();
    const userWsManager = new EventEmitter();
    const maker = new MarketMaker(cfg, wsManager as WsManager, userWsManager as UserWsManager);

    maker.start();
    await flushPromises();
    await flushPromises();

    expect(placeLimitOrderMock).toHaveBeenCalledTimes(2);

    emitQuote(wsManager, cfg.no_token_id, 0.53, 0.54, 120);
    emitQuote(wsManager, cfg.yes_token_id, 0.46, 0.47, 120);
    await flushPromises();
    await flushPromises();

    expect(cancelMarketOrdersMock).toHaveBeenCalledTimes(3);
    expect(placeLimitOrderMock).toHaveBeenCalledTimes(4);

    maker.stop();
  });

  it('requotes on proximity even when market depth would previously block a cooldown gate', async () => {
    cancelMarketOrdersMock.mockResolvedValue(true);
    getMarketInfoMock.mockResolvedValue({ v: 0.045, tick_size: 0.01 });
    getRestMidMock.mockResolvedValue(0.5);
    placeLimitOrderMock
      .mockResolvedValueOnce(buildPlacedOrder('yes-order-1'))
      .mockResolvedValueOnce(buildPlacedOrder('no-order-1'))
      .mockResolvedValueOnce(buildPlacedOrder('yes-order-2'))
      .mockResolvedValueOnce(buildPlacedOrder('no-order-2'));

    const cfg = createConfig({
      condition_id: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      yes_token_id: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      no_token_id: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    });
    const wsManager = new EventEmitter();
    const userWsManager = new EventEmitter();
    const maker = new MarketMaker(cfg, wsManager as WsManager, userWsManager as UserWsManager);

    maker.start();
    await flushPromises();
    await flushPromises();

    emitQuote(wsManager, cfg.no_token_id, 0.53, 0.54, 5);
    emitQuote(wsManager, cfg.yes_token_id, 0.46, 0.47, 5);
    await flushPromises();
    await flushPromises();

    expect(cancelMarketOrdersMock).toHaveBeenCalledTimes(3);
    expect(placeLimitOrderMock).toHaveBeenCalledTimes(4);

    maker.stop();
  });

  it('keeps fill tracking alive while a drift cancel is still in flight', async () => {
    getMarketInfoMock.mockResolvedValue({ v: 0.045, tick_size: 0.01 });
    getRestMidMock.mockResolvedValue(0.5);
    getTokenBalanceMock.mockResolvedValue(20);

    let resolveDriftCancel!: (value: boolean) => void;
    const driftCancelPromise = new Promise<boolean>(resolve => {
      resolveDriftCancel = resolve;
    });

    cancelMarketOrdersMock
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(() => driftCancelPromise)
      .mockResolvedValue(true);

    placeLimitOrderMock
      .mockResolvedValueOnce(buildPlacedOrder('yes-order-1'))
      .mockResolvedValueOnce(buildPlacedOrder('no-order-1'))
      .mockResolvedValueOnce(null);

    const cfg = createConfig({
      condition_id: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      yes_token_id: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      no_token_id: '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    });

    const wsManager = new EventEmitter();
    const userWsManager = new EventEmitter();
    const maker = new MarketMaker(cfg, wsManager as WsManager, userWsManager as UserWsManager);
    const fillDetected = jest.fn();
    maker.positionMonitor.on('fillDetected', fillDetected);

    maker.start();
    await flushPromises();
    await flushPromises();

    wsManager.emit('midUpdate', cfg.yes_token_id, 0.62);
    await flushPromises();

    userWsManager.emit('fill', {
      orderId: 'yes-order-1',
      assetId: cfg.yes_token_id,
      conditionId: cfg.condition_id,
      price: 0.46,
      size: 20,
      side: 'BUY',
      feeRateBps: 0,
      eventKey: 'mid-cancel-fill-1',
    });

    await flushPromises();
    await flushPromises();

    expect(fillDetected).toHaveBeenCalledWith(cfg.condition_id);

    resolveDriftCancel(true);
    await flushPromises();

    maker.stop();
  });

  it('waits for an in-flight cancel when pausing another market', async () => {
    getMarketInfoMock.mockResolvedValue({ v: 0.045, tick_size: 0.01 });
    getRestMidMock.mockResolvedValue(0.5);
    getTokenBalanceMock.mockResolvedValue(20);

    let resolveDriftCancel!: (value: boolean) => void;
    const driftCancelPromise = new Promise<boolean>(resolve => {
      resolveDriftCancel = resolve;
    });

    cancelMarketOrdersMock
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(() => driftCancelPromise);

    placeLimitOrderMock
      .mockResolvedValueOnce(buildPlacedOrder('yes-order-1'))
      .mockResolvedValueOnce(buildPlacedOrder('no-order-1'));

    const cfg = createConfig({
      condition_id: '0x9999999999999999999999999999999999999999999999999999999999999999',
      yes_token_id: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      no_token_id: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    });

    const wsManager = new EventEmitter();
    const userWsManager = new EventEmitter();
    const maker = new MarketMaker(cfg, wsManager as WsManager, userWsManager as UserWsManager);

    maker.start();
    await flushPromises();
    await flushPromises();

    wsManager.emit('midUpdate', cfg.yes_token_id, 0.62);
    await flushPromises();

    const pausePromise = maker.pause();
    await flushPromises();

    resolveDriftCancel(true);

    await expect(pausePromise).resolves.toBe(true);

    maker.stop();
  });

  it('reconciles a tracked LP fill after cancel succeeds', async () => {
    cancelMarketOrdersMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    getMarketInfoMock.mockResolvedValue({ v: 0.045, tick_size: 0.01 });
    getRestMidMock.mockResolvedValue(0.5);
    getTokenBalanceMock.mockResolvedValue(20);
    placeLimitOrderMock
      .mockResolvedValueOnce(buildPlacedOrder('yes-order-1', { tokenId: createConfig().yes_token_id }))
      .mockResolvedValueOnce(buildPlacedOrder('no-order-1', { tokenId: createConfig().no_token_id }))
      .mockResolvedValueOnce(buildPlacedOrder('close-order-1', {
        status: 'live',
        price: 0.46,
        tokenId: createConfig().yes_token_id,
        side: 'SELL',
      }));
    getOrderStatusMock
      .mockResolvedValueOnce({
        sizeMatched: 20,
        originalSize: 20,
        status: 'matched',
        price: 0.46,
        assetId: createConfig().yes_token_id,
      })
      .mockResolvedValueOnce({
        sizeMatched: 0,
        originalSize: 20,
        status: 'cancelled',
        price: 0.43,
        assetId: createConfig().no_token_id,
      })
      .mockResolvedValue(null);

    const cfg = createConfig();
    const wsManager = new EventEmitter();
    const userWsManager = new EventEmitter();
    const maker = new MarketMaker(cfg, wsManager as WsManager, userWsManager as UserWsManager);
    const fillDetected = jest.fn();

    maker.positionMonitor.on('fillDetected', fillDetected);
    maker.start();
    await flushPromises();
    await flushPromises();

    await (maker as any).cancelOrders('reconcile-test');
    await flushPromises();
    await flushPromises();

    expect(fillDetected).toHaveBeenCalledWith(cfg.condition_id);
    expect(getOrderStatusMock).toHaveBeenCalledWith('yes-order-1');
    expect(placeLimitOrderMock).toHaveBeenCalledWith('SELL', 0.46, 20, cfg.yes_token_id);
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.stringContaining('source=reconcile:market-maker:reconcile-test')
    );

    maker.stop();
  });
});
