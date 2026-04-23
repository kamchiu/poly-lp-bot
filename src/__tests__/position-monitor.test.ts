import { EventEmitter } from 'events';
import { PositionMonitor } from '../position-monitor';
import type { UserWsManager } from '../user-ws-manager';
import logger from '../logger';
import {
  cancelMarketOrders,
  cancelOrder,
  getBestBidAsk,
  getOrderStatus,
  getMarketInfo,
  placeLimitOrder,
  getTokenBalance,
} from '../client';

jest.mock('../client', () => ({
  cancelMarketOrders: jest.fn(),
  cancelOrder: jest.fn(),
  getBestBidAsk: jest.fn(),
  getOrderStatus: jest.fn(),
  getMarketInfo: jest.fn(),
  placeLimitOrder: jest.fn(),
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
const getMarketInfoMock = getMarketInfo as jest.MockedFunction<typeof getMarketInfo>;
const placeLimitOrderMock = placeLimitOrder as jest.MockedFunction<typeof placeLimitOrder>;
const getTokenBalanceMock = getTokenBalance as jest.MockedFunction<typeof getTokenBalance>;

const CONDITION_ID = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN_ID = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
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
  price: 0.4,
  size: 20,
  tokenId: TOKEN_ID,
  side: 'SELL',
  ...overrides,
});

const flushPromises = async (): Promise<void> => {
  await new Promise<void>(resolve => process.nextTick(resolve));
};

describe('PositionMonitor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    cancelMarketOrdersMock.mockReset();
    cancelOrderMock.mockReset();
    getBestBidAskMock.mockReset();
    getOrderStatusMock.mockReset();
    getMarketInfoMock.mockReset();
    placeLimitOrderMock.mockReset();
    getTokenBalanceMock.mockReset();
    getMarketInfoMock.mockResolvedValue({ v: 0.045, tick_size: 0.01 });
    getBestBidAskMock.mockResolvedValue({ bestBid: 0.39, bestAsk: 0.41 });
  });

  it('reports no active close order before closing starts', () => {
    const userWs = new EventEmitter();
    const monitor = new PositionMonitor(CONDITION_ID, userWs as UserWsManager);

    expect(monitor.hasActiveCloseOrder()).toBe(false);

    monitor.stop();
  });

  it('risk locks immediately when same-market LP cancel fails', async () => {
    cancelMarketOrdersMock.mockResolvedValue(false);

    const userWs = new EventEmitter();
    const monitor = new PositionMonitor(CONDITION_ID, userWs as UserWsManager);
    const closeFailed = jest.fn();

    monitor.on('closeFailed', closeFailed);
    monitor.trackOrders([
      { orderId: 'buy-order-1', tokenId: TOKEN_ID, side: 'BUY', price: 0.4, size: 20 },
    ]);

    userWs.emit('fill', {
      orderId: 'buy-order-1',
      assetId: TOKEN_ID,
      conditionId: CONDITION_ID,
      price: 0.4,
      size: 20,
      side: 'BUY',
      feeRateBps: 0,
      eventKey: 'fill-cancel-failed-1',
    });

    await flushPromises();
    await flushPromises();

    expect(closeFailed).toHaveBeenCalledWith('lp-cancel-failed');
    expect(getTokenBalanceMock).not.toHaveBeenCalled();
    expect(placeLimitOrderMock).not.toHaveBeenCalled();

    monitor.stop();
  });

  it('risk locks instead of emitting closeComplete when close order placement fails', async () => {
    cancelMarketOrdersMock.mockResolvedValue(true);
    getTokenBalanceMock.mockResolvedValue(20);
    placeLimitOrderMock.mockResolvedValue(null);

    const userWs = new EventEmitter();
    const monitor = new PositionMonitor(CONDITION_ID, userWs as UserWsManager);
    const fillDetected = jest.fn();
    const closeFailed = jest.fn();
    const closeComplete = jest.fn();

    monitor.on('fillDetected', fillDetected);
    monitor.on('closeFailed', closeFailed);
    monitor.on('closeComplete', closeComplete);
    monitor.trackOrders([
      { orderId: 'buy-order-1', tokenId: TOKEN_ID, side: 'BUY', price: 0.4, size: 20 },
    ]);

    userWs.emit('fill', {
      orderId: 'buy-order-1',
      assetId: TOKEN_ID,
      conditionId: CONDITION_ID,
      price: 0.4,
      size: 20,
      side: 'BUY',
      feeRateBps: 0,
      eventKey: 'fill-1',
    });

    await flushPromises();
    await flushPromises();

    expect(fillDetected).toHaveBeenCalledWith(CONDITION_ID);
    expect(closeFailed).toHaveBeenCalledWith('limit-placement-failed');
    expect(closeComplete).not.toHaveBeenCalled();
    expect(monitor.isClosing()).toBe(true);

    monitor.stop();
  });

  it('reprices an unfilled close order after the timeout window', async () => {
    cancelMarketOrdersMock.mockResolvedValue(true);
    cancelOrderMock.mockResolvedValue(true);
    getTokenBalanceMock.mockResolvedValue(20);
    getBestBidAskMock
      .mockResolvedValueOnce({ bestBid: 0.39, bestAsk: 0.41 })
      .mockResolvedValueOnce({ bestBid: 0.37, bestAsk: 0.38 });
    placeLimitOrderMock
      .mockResolvedValueOnce(buildPlacedOrder('close-order-1'))
      .mockResolvedValueOnce(buildPlacedOrder('close-order-2', { price: 0.38 }));

    const userWs = new EventEmitter();
    const monitor = new PositionMonitor(CONDITION_ID, userWs as UserWsManager);
    monitor.trackOrders([
      { orderId: 'buy-order-1', tokenId: TOKEN_ID, side: 'BUY', price: 0.4, size: 20 },
    ]);

    userWs.emit('fill', {
      orderId: 'buy-order-1',
      assetId: TOKEN_ID,
      conditionId: CONDITION_ID,
      price: 0.4,
      size: 20,
      side: 'BUY',
      feeRateBps: 0,
      eventKey: 'fill-reprice-1',
    });

    await flushPromises();
    await flushPromises();

    expect(placeLimitOrderMock).toHaveBeenNthCalledWith(1, 'SELL', 0.4, 20, TOKEN_ID);

    await (monitor as any).repriceCloseOrder();
    await flushPromises();
    await flushPromises();

    expect(cancelOrderMock).toHaveBeenCalledWith('close-order-1');
    expect(placeLimitOrderMock).toHaveBeenNthCalledWith(2, 'SELL', 0.38, 20, TOKEN_ID);

    monitor.stop();
  });

  it('risk locks when another buy fill arrives while the close order is being placed', async () => {
    cancelMarketOrdersMock.mockResolvedValue(true);
    getTokenBalanceMock.mockResolvedValue(20);

    let resolvePlaceOrder!: (value: NonNullable<Awaited<ReturnType<typeof placeLimitOrder>>> | null) => void;
    placeLimitOrderMock.mockImplementationOnce(() =>
      new Promise(resolve => {
        resolvePlaceOrder = resolve;
      })
    );

    const userWs = new EventEmitter();
    const monitor = new PositionMonitor(CONDITION_ID, userWs as UserWsManager);
    const closeFailed = jest.fn();

    monitor.on('closeFailed', closeFailed);
    monitor.trackOrders([
      { orderId: 'buy-order-1', tokenId: TOKEN_ID, side: 'BUY', price: 0.4, size: 20 },
      { orderId: 'buy-order-2', tokenId: TOKEN_ID, side: 'BUY', price: 0.41, size: 20 },
    ]);

    userWs.emit('fill', {
      orderId: 'buy-order-1',
      assetId: TOKEN_ID,
      conditionId: CONDITION_ID,
      price: 0.4,
      size: 20,
      side: 'BUY',
      feeRateBps: 0,
      eventKey: 'fill-place-race-1',
    });

    await flushPromises();
    await flushPromises();

    userWs.emit('fill', {
      orderId: 'buy-order-2',
      assetId: TOKEN_ID,
      conditionId: CONDITION_ID,
      price: 0.41,
      size: 20,
      side: 'BUY',
      feeRateBps: 0,
      eventKey: 'fill-place-race-2',
    });

    await flushPromises();

    expect(closeFailed).toHaveBeenCalledWith('buy-fill-while-placing-close');

    resolvePlaceOrder(buildPlacedOrder('close-order-1'));
    await flushPromises();

    monitor.stop();
  });

  it('completes the close from immediate matched placement without waiting for a WS fill', async () => {
    cancelMarketOrdersMock.mockResolvedValue(true);
    getTokenBalanceMock.mockResolvedValue(20);
    placeLimitOrderMock.mockResolvedValue(
      buildPlacedOrder('close-order-1', { status: 'matched' })
    );
    getOrderStatusMock.mockResolvedValue({
      sizeMatched: 20,
      originalSize: 20,
      status: 'matched',
      price: 0.4,
      assetId: TOKEN_ID,
    });

    const userWs = new EventEmitter();
    const monitor = new PositionMonitor(CONDITION_ID, userWs as UserWsManager);
    const closeComplete = jest.fn();

    monitor.on('closeComplete', closeComplete);
    monitor.trackOrders([
      { orderId: 'buy-order-1', tokenId: TOKEN_ID, side: 'BUY', price: 0.4, size: 20 },
    ]);

    userWs.emit('fill', {
      orderId: 'buy-order-1',
      assetId: TOKEN_ID,
      conditionId: CONDITION_ID,
      price: 0.4,
      size: 20,
      side: 'BUY',
      feeRateBps: 0,
      eventKey: 'fill-immediate-close-1',
    });

    await flushPromises();
    await flushPromises();

    expect(getOrderStatusMock).toHaveBeenCalledWith('close-order-1');
    expect(closeComplete).toHaveBeenCalled();
    expect(monitor.isClosing()).toBe(false);
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.stringContaining('source=reconcile:close-initial-post-status')
    );

    monitor.stop();
  });
});
