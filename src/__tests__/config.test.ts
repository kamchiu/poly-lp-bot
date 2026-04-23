jest.mock('https-proxy-agent', () => ({
  HttpsProxyAgent: jest.fn(),
}));

jest.mock('https', () => ({
  get: jest.fn(),
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

import { EventEmitter } from 'events';
import * as https from 'https';
import { resolveMarketConfig, resolveMarketIds } from '../config';
import { Defaults, MarketConfig } from '../types';

const httpsGetMock = https.get as jest.MockedFunction<typeof https.get>;

const defaults: Defaults = {
  min_size: 20,
  fallback_v: 0.045,
  spread_factor: 0.7,
  refresh_interval_ms: 70_000,
  drift_threshold_factor: 0.25,
  ws_host: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
  ws_user_host: 'wss://ws-subscriptions-clob.polymarket.com/ws/user',
  fill_poll_interval_ms: 3_000,
};

function queueJsonResponse(payload: unknown): void {
  httpsGetMock.mockImplementationOnce(((url: string, options: unknown, callback: (res: EventEmitter) => void) => {
    const req = new EventEmitter() as EventEmitter & {
      setTimeout: jest.Mock;
      destroy: jest.Mock;
    };
    req.setTimeout = jest.fn();
    req.destroy = jest.fn();

    process.nextTick(() => {
      const res = new EventEmitter();
      callback(res);
      res.emit('data', JSON.stringify(payload));
      res.emit('end');
    });

    return req as unknown as ReturnType<typeof https.get>;
  }) as typeof https.get);
}

describe('resolveMarketIds', () => {
  beforeEach(() => {
    httpsGetMock.mockReset();
  });

  it('resolves localized event URLs with query strings and hashes', async () => {
    queueJsonResponse([
      {
        slug: 'wti-closes-above-on-april-23-2026',
        markets: [
          {
            slug: 'different-market',
            conditionId: '0xother',
            clobTokenIds: ['other-yes', 'other-no'],
          },
          {
            slug: 'wti-closes-above-93-on-april-23-2026',
            conditionId: '0xwti',
            clobTokenIds: ['yes-token', 'no-token'],
          },
        ],
      },
    ]);

    const markets: MarketConfig[] = [
      {
        url: 'https://polymarket.com/zh/event/wti-closes-above-on-april-23-2026/wti-closes-above-93-on-april-23-2026?tid=12#book',
      },
    ];

    await resolveMarketIds(markets);

    expect(markets[0].condition_id).toBe('0xwti');
    expect(markets[0].yes_token_id).toBe('yes-token');
    expect(markets[0].no_token_id).toBe('no-token');
    expect(String(httpsGetMock.mock.calls[0][0])).toContain('/events?slug=wti-closes-above-on-april-23-2026');
  });

  it('falls back to direct market lookup for localized /market URLs', async () => {
    queueJsonResponse([]);
    queueJsonResponse([
      {
        conditionId: '0xmarket',
        clobTokenIds: '["yes-token","no-token"]',
      },
    ]);

    const markets: MarketConfig[] = [
      {
        url: 'https://polymarket.com/zh/market/wti-closes-above-93-on-april-23-2026',
      },
    ];

    await resolveMarketIds(markets);

    expect(markets[0].condition_id).toBe('0xmarket');
    expect(markets[0].yes_token_id).toBe('yes-token');
    expect(markets[0].no_token_id).toBe('no-token');
    expect(httpsGetMock).toHaveBeenCalledTimes(2);
    expect(String(httpsGetMock.mock.calls[1][0])).toContain('/markets?slug=wti-closes-above-93-on-april-23-2026');
  });

  it('re-resolves URL-backed markets when no_token_id is missing', async () => {
    queueJsonResponse([
      {
        slug: 'wti-closes-above-on-april-23-2026',
        markets: [
          {
            slug: 'wti-closes-above-93-on-april-23-2026',
            conditionId: '0xfresh',
            clobTokenIds: ['fresh-yes', 'fresh-no'],
          },
        ],
      },
    ]);

    const markets: MarketConfig[] = [
      {
        url: 'https://polymarket.com/event/wti-closes-above-on-april-23-2026/wti-closes-above-93-on-april-23-2026',
        condition_id: '0xstale',
        yes_token_id: 'stale-yes',
      },
    ];

    await resolveMarketIds(markets);

    expect(markets[0].condition_id).toBe('0xfresh');
    expect(markets[0].yes_token_id).toBe('fresh-yes');
    expect(markets[0].no_token_id).toBe('fresh-no');
  });

  it('rejects non-Polymarket URLs before making network calls', async () => {
    await expect(
      resolveMarketIds([{ url: 'https://example.com/event/foo/bar' }])
    ).rejects.toThrow('Cannot extract slug from URL: https://example.com/event/foo/bar');

    expect(httpsGetMock).not.toHaveBeenCalled();
  });
});

describe('resolveMarketConfig', () => {
  it('inherits min_size and fallback_v from defaults', () => {
    const resolved = resolveMarketConfig(
      {
        condition_id: '0xcond',
        yes_token_id: 'yes-token',
        no_token_id: 'no-token',
      },
      defaults
    );

    expect(resolved.min_size).toBe(20);
    expect(resolved.fallback_v).toBe(0.045);
  });

  it('prefers per-market overrides over defaults', () => {
    const resolved = resolveMarketConfig(
      {
        condition_id: '0xcond',
        yes_token_id: 'yes-token',
        no_token_id: 'no-token',
        min_size: 50,
        fallback_v: 0.035,
      },
      defaults
    );

    expect(resolved.min_size).toBe(50);
    expect(resolved.fallback_v).toBe(0.035);
  });

  it('throws when min_size is missing from both market and defaults', () => {
    const missingMinDefaults = { ...defaults, min_size: undefined } as unknown as Defaults;

    expect(() =>
      resolveMarketConfig(
        {
          condition_id: '0xcond',
          yes_token_id: 'yes-token',
          no_token_id: 'no-token',
        },
        missingMinDefaults
      )
    ).toThrow('Market is missing min_size. Provide it directly in config.yaml or via defaults.min_size.');
  });

  it('throws when fallback_v is missing from both market and defaults', () => {
    const missingFallbackDefaults = { ...defaults, fallback_v: undefined } as unknown as Defaults;

    expect(() =>
      resolveMarketConfig(
        {
          condition_id: '0xcond',
          yes_token_id: 'yes-token',
          no_token_id: 'no-token',
        },
        missingFallbackDefaults
      )
    ).toThrow('Market is missing fallback_v. Provide it directly in config.yaml or via defaults.fallback_v.');
  });
});
