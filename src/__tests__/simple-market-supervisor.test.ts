import { EventEmitter } from 'events';
import logger from '../logger';
import {
  buildSimpleRuntimeScanOptions,
  SimpleMarketSupervisor,
} from '../simple-market-supervisor';
import type {
  Defaults,
  ResolvedMarketConfig,
} from '../types';

jest.mock('https-proxy-agent', () => ({
  HttpsProxyAgent: jest.fn(),
}));

jest.mock('../client', () => ({
  cancelMarketOrders: jest.fn(),
  getOpenOrders: jest.fn(),
  getTokenBalanceStrict: jest.fn(),
  stopHeartbeat: jest.fn(),
}));

jest.mock('../config', () => ({
  resolveMarketConfig: jest.fn(),
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

const loggerMock = logger as unknown as {
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
  debug: jest.Mock;
};

const defaults: Defaults = {
  min_size: 20,
  fallback_v: 0.045,
  spread_factor: 0.7,
  refresh_interval_ms: 120_000,
  drift_threshold_factor: 0.25,
  ws_host: 'wss://example.test/ws/market',
  ws_user_host: 'wss://example.test/ws/user',
  fill_poll_interval_ms: 3_000,
};

const creds = {
  key: 'key',
  secret: 'secret',
  passphrase: 'passphrase',
};

function createConfig(conditionId: string): ResolvedMarketConfig {
  const suffix = conditionId.slice(-2);

  return {
    condition_id: conditionId,
    yes_token_id: `yes-token-${suffix}`,
    no_token_id: `no-token-${suffix}`,
    min_size: 20,
    fallback_v: 0.045,
    spread_factor: 0.7,
    refresh_interval_ms: 120_000,
    drift_threshold_factor: 0.25,
    fill_poll_interval_ms: 3_000,
    ws_host: defaults.ws_host,
  };
}

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

class FakeWsManager {
  subscribe = jest.fn<void, [string[]]>();
  connect = jest.fn<void, []>();
  disconnect = jest.fn<void, []>();
}

class FakeUserWsManager extends EventEmitter {
  connect = jest.fn<void, []>();
  disconnect = jest.fn<void, []>();
}

interface FakeMaker {
  conditionId: string;
  start: jest.Mock<void, []>;
  shutdown: jest.Mock<Promise<boolean>, [string?]>;
}

function createFakeMaker(conditionId: string): FakeMaker {
  return {
    conditionId,
    start: jest.fn(),
    shutdown: jest.fn().mockResolvedValue(true),
  };
}

describe('SimpleMarketSupervisor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('replaces all markets on a successful interval scan', async () => {
    const firstMarket = createConfig('condition-01');
    const secondMarket = createConfig('condition-02');
    const thirdMarket = createConfig('condition-03');

    const scanMarketsMock = jest.fn()
      .mockResolvedValueOnce([firstMarket])
      .mockResolvedValueOnce([secondMarket, thirdMarket]);
    const getTokenBalanceStrictMock = jest.fn().mockResolvedValue(0);
    const getOpenOrdersMock = jest.fn().mockResolvedValue([]);
    const cancelMarketOrdersMock = jest.fn().mockResolvedValue(true);
    const stopHeartbeatMock = jest.fn();

    const wsManagers: FakeWsManager[] = [];
    const userWsManagers: FakeUserWsManager[] = [];
    const makers: FakeMaker[] = [];

    const supervisor = new SimpleMarketSupervisor(
      { defaults, creds, scanIntervalMs: 1_000 },
      {
        scanMarkets: scanMarketsMock,
        createWsManager: () => {
          const manager = new FakeWsManager();
          wsManagers.push(manager);
          return manager;
        },
        createUserWsManager: () => {
          const manager = new FakeUserWsManager();
          userWsManagers.push(manager);
          return manager;
        },
        createMaker: (cfg) => {
          const maker = createFakeMaker(cfg.condition_id);
          makers.push(maker);
          return maker;
        },
        getOpenOrders: getOpenOrdersMock,
        cancelMarketOrders: cancelMarketOrdersMock,
        getTokenBalanceStrict: getTokenBalanceStrictMock,
        stopHeartbeat: stopHeartbeatMock,
      }
    );

    await supervisor.start();
    await flushPromises();

    expect(makers).toHaveLength(1);
    expect(makers[0].start).toHaveBeenCalledTimes(1);
    expect(wsManagers).toHaveLength(1);
    expect(userWsManagers).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(1_000);
    await flushPromises();

    expect(makers[0].shutdown).toHaveBeenCalledWith('scan:interval');
    expect(makers).toHaveLength(3);
    expect(makers[1].start).toHaveBeenCalledTimes(1);
    expect(makers[2].start).toHaveBeenCalledTimes(1);
    expect(wsManagers).toHaveLength(2);
    expect(userWsManagers).toHaveLength(2);
    expect(wsManagers[0].disconnect).toHaveBeenCalledTimes(1);
    expect(userWsManagers[0].disconnect).toHaveBeenCalledTimes(1);
    expect(cancelMarketOrdersMock).not.toHaveBeenCalled();
  });

  it('keeps current makers when the interval scan fails', async () => {
    const firstMarket = createConfig('condition-11');

    const scanMarketsMock = jest.fn()
      .mockResolvedValueOnce([firstMarket])
      .mockRejectedValueOnce(new Error('scan failed'));

    const makers: FakeMaker[] = [];

    const supervisor = new SimpleMarketSupervisor(
      { defaults, creds, scanIntervalMs: 1_000 },
      {
        scanMarkets: scanMarketsMock,
        createWsManager: () => new FakeWsManager(),
        createUserWsManager: () => new FakeUserWsManager(),
        createMaker: (cfg) => {
          const maker = createFakeMaker(cfg.condition_id);
          makers.push(maker);
          return maker;
        },
        getOpenOrders: jest.fn().mockResolvedValue([]),
        cancelMarketOrders: jest.fn().mockResolvedValue(true),
        getTokenBalanceStrict: jest.fn().mockResolvedValue(0),
        stopHeartbeat: jest.fn(),
      }
    );

    await supervisor.start();
    await flushPromises();

    await jest.advanceTimersByTimeAsync(1_000);
    await flushPromises();

    expect(makers).toHaveLength(1);
    expect(makers[0].shutdown).not.toHaveBeenCalled();
    expect(loggerMock.error).toHaveBeenCalledWith(
      '[SimpleSupervisor] market scan (interval) failed:',
      expect.any(Error)
    );
  });

  it('keeps current makers when the interval scan returns no markets', async () => {
    const firstMarket = createConfig('condition-21');

    const scanMarketsMock = jest.fn()
      .mockResolvedValueOnce([firstMarket])
      .mockResolvedValueOnce([]);

    const makers: FakeMaker[] = [];

    const supervisor = new SimpleMarketSupervisor(
      { defaults, creds, scanIntervalMs: 1_000 },
      {
        scanMarkets: scanMarketsMock,
        createWsManager: () => new FakeWsManager(),
        createUserWsManager: () => new FakeUserWsManager(),
        createMaker: (cfg) => {
          const maker = createFakeMaker(cfg.condition_id);
          makers.push(maker);
          return maker;
        },
        getOpenOrders: jest.fn().mockResolvedValue([]),
        cancelMarketOrders: jest.fn().mockResolvedValue(true),
        getTokenBalanceStrict: jest.fn().mockResolvedValue(0),
        stopHeartbeat: jest.fn(),
      }
    );

    await supervisor.start();
    await flushPromises();

    await jest.advanceTimersByTimeAsync(1_000);
    await flushPromises();

    expect(makers).toHaveLength(1);
    expect(makers[0].shutdown).not.toHaveBeenCalled();
    expect(loggerMock.warn).toHaveBeenCalledWith(
      '[SimpleSupervisor] market scan (interval) returned no runnable markets; keeping current makers'
    );
  });

  it('stops only the filled market and keeps the others running', async () => {
    const firstMarket = createConfig('condition-31');
    const secondMarket = createConfig('condition-32');
    const makers = new Map<string, FakeMaker>();
    const userWsManagers: FakeUserWsManager[] = [];

    const supervisor = new SimpleMarketSupervisor(
      { defaults, creds, scanIntervalMs: 1_000 },
      {
        scanMarkets: jest.fn().mockResolvedValue([firstMarket, secondMarket]),
        createWsManager: () => new FakeWsManager(),
        createUserWsManager: () => {
          const manager = new FakeUserWsManager();
          userWsManagers.push(manager);
          return manager;
        },
        createMaker: (cfg) => {
          const maker = createFakeMaker(cfg.condition_id);
          makers.set(cfg.condition_id, maker);
          return maker;
        },
        getOpenOrders: jest.fn().mockResolvedValue([]),
        cancelMarketOrders: jest.fn().mockResolvedValue(true),
        getTokenBalanceStrict: jest.fn().mockResolvedValue(0),
        stopHeartbeat: jest.fn(),
      }
    );

    await supervisor.start();
    await flushPromises();

    userWsManagers[0].emit('fill', { conditionId: firstMarket.condition_id });
    await flushPromises();

    expect(makers.get(firstMarket.condition_id)?.shutdown).toHaveBeenCalledWith(
      `fill:${firstMarket.condition_id.slice(0, 10)}`
    );
    expect(makers.get(secondMarket.condition_id)?.shutdown).not.toHaveBeenCalled();
  });
});

describe('buildSimpleRuntimeScanOptions', () => {
  it('adds a count limit when market_count is a positive number', () => {
    const options = buildSimpleRuntimeScanOptions(5);
    expect(options.count).toBe(5);
    expect(options.minVolume24h).toBe(0);
    expect(options.maxVolume24h).toBe(100);
  });

  it('leaves count unset when market_count is null or invalid', () => {
    expect(buildSimpleRuntimeScanOptions(null).count).toBeUndefined();
    expect(buildSimpleRuntimeScanOptions(0).count).toBeUndefined();
  });
});
