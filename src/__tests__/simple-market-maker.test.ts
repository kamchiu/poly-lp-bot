import { EventEmitter } from 'events';
import {
  cancelMarketOrders,
  getMarketInfo,
  getRestMid,
  placeLimitOrder,
} from '../client';
import logger from '../logger';
import { SimpleMarketMaker } from '../simple-market-maker';
import type { ResolvedMarketConfig } from '../types';
import type { WsManager } from '../ws-manager';

jest.mock('../client', () => ({
  cancelMarketOrders: jest.fn(),
  getMarketInfo: jest.fn(),
  getRestMid: jest.fn(),
  placeLimitOrder: jest.fn(),
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
const getMarketInfoMock = getMarketInfo as jest.MockedFunction<typeof getMarketInfo>;
const getRestMidMock = getRestMid as jest.MockedFunction<typeof getRestMid>;
const placeLimitOrderMock = placeLimitOrder as jest.MockedFunction<typeof placeLimitOrder>;
const loggerMock = logger as unknown as {
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
  debug: jest.Mock;
};

const buildPlacedOrder = (orderId: string) => ({
  orderId,
  status: 'live',
  price: 0.46,
  size: 20,
  tokenId: 'token-id',
  side: 'BUY' as const,
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
  refresh_interval_ms: 1_000,
  drift_threshold_factor: 0.25,
  fill_poll_interval_ms: 3_000,
  ws_host: 'wss://example.test/ws',
  ...overrides,
});

describe('SimpleMarketMaker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    cancelMarketOrdersMock.mockReset();
    getMarketInfoMock.mockReset();
    getRestMidMock.mockReset();
    placeLimitOrderMock.mockReset();

    cancelMarketOrdersMock.mockResolvedValue(true);
    getMarketInfoMock.mockResolvedValue({ v: 0.045, tick_size: 0.01 });
    getRestMidMock.mockResolvedValue(0.5);
    placeLimitOrderMock
      .mockResolvedValue(buildPlacedOrder('yes-order'))
      .mockResolvedValue(buildPlacedOrder('no-order'));
  });

  it('reposts orders on the refresh timer using the latest cached mid', async () => {
    jest.useFakeTimers();
    placeLimitOrderMock
      .mockResolvedValueOnce(buildPlacedOrder('yes-order-1'))
      .mockResolvedValueOnce(buildPlacedOrder('no-order-1'))
      .mockResolvedValueOnce(buildPlacedOrder('yes-order-2'))
      .mockResolvedValueOnce(buildPlacedOrder('no-order-2'));

    const cfg = createConfig();
    const wsManager = new EventEmitter();
    const maker = new SimpleMarketMaker(cfg, wsManager as WsManager);

    maker.start();
    await flushPromises();
    await flushPromises();

    expect(cancelMarketOrdersMock).toHaveBeenCalledTimes(1);
    expect(placeLimitOrderMock).toHaveBeenNthCalledWith(1, 'BUY', 0.46, cfg.min_size, cfg.yes_token_id);
    expect(placeLimitOrderMock).toHaveBeenNthCalledWith(2, 'BUY', 0.46, cfg.min_size, cfg.no_token_id);

    wsManager.emit('midUpdate', cfg.yes_token_id, 0.55);

    jest.advanceTimersByTime(cfg.refresh_interval_ms);
    await flushPromises();
    await flushPromises();

    expect(cancelMarketOrdersMock).toHaveBeenCalledTimes(2);
    expect(placeLimitOrderMock).toHaveBeenNthCalledWith(3, 'BUY', 0.51, cfg.min_size, cfg.yes_token_id);
    expect(placeLimitOrderMock).toHaveBeenNthCalledWith(4, 'BUY', 0.41, cfg.min_size, cfg.no_token_id);

    await maker.shutdown();
    jest.useRealTimers();
  });

  it('shutdown cancels orders and stops future refreshes', async () => {
    jest.useFakeTimers();

    const cfg = createConfig();
    const wsManager = new EventEmitter();
    const maker = new SimpleMarketMaker(cfg, wsManager as WsManager);

    maker.start();
    await flushPromises();
    await flushPromises();

    await expect(maker.shutdown()).resolves.toBe(true);

    jest.advanceTimersByTime(cfg.refresh_interval_ms * 3);
    await flushPromises();
    await flushPromises();

    expect(cancelMarketOrdersMock).toHaveBeenCalledTimes(2);
    expect(placeLimitOrderMock).toHaveBeenCalledTimes(2);
    expect(loggerMock.error).not.toHaveBeenCalled();

    jest.useRealTimers();
  });
});
