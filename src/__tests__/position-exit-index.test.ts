jest.mock('https-proxy-agent', () => ({
  HttpsProxyAgent: jest.fn(),
}));

jest.mock('../client', () => ({
  getCurrentPositionForMarket: jest.fn(),
  getPositionsUserAddress: jest.fn(),
  initClient: jest.fn(),
  stopHeartbeat: jest.fn(),
}));

jest.mock('../config', () => ({
  resolveMarketIds: jest.fn(),
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

import { resolveMarketIds } from '../config';
import { getCurrentPositionForMarket } from '../client';
import { normalizeMarketUrls, resolveManagedPositions } from '../position-exit-index';

const resolveMarketIdsMock = resolveMarketIds as jest.MockedFunction<typeof resolveMarketIds>;
const getCurrentPositionForMarketMock = getCurrentPositionForMarket as jest.MockedFunction<typeof getCurrentPositionForMarket>;

describe('position-exit-index helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resolveMarketIdsMock.mockReset();
    getCurrentPositionForMarketMock.mockReset();
  });

  it('normalizes market URLs by trimming, dropping empties, and de-duplicating', () => {
    expect(
      normalizeMarketUrls([
        ' https://polymarket.com/event/a ',
        '',
        'https://polymarket.com/event/b',
        'https://polymarket.com/event/a',
      ])
    ).toEqual([
      'https://polymarket.com/event/a',
      'https://polymarket.com/event/b',
    ]);
  });

  it('resolves managed positions across multiple market URLs and skips empty markets', async () => {
    resolveMarketIdsMock.mockImplementation(async markets => {
      markets[0].condition_id = '0xmarket-1';
      markets[0].yes_token_id = 'yes-1';
      markets[0].no_token_id = 'no-1';
      markets[1].condition_id = '0xmarket-2';
      markets[1].yes_token_id = 'yes-2';
      markets[1].no_token_id = 'no-2';
      markets[2].condition_id = '0xmarket-3';
      markets[2].yes_token_id = 'yes-3';
      markets[2].no_token_id = 'no-3';
    });

    getCurrentPositionForMarketMock
      .mockResolvedValueOnce({
        conditionId: '0xmarket-1',
        tokenId: 'yes-1',
        outcome: 'YES',
        size: 11,
        avgPrice: 0.41,
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        conditionId: '0xmarket-3',
        tokenId: 'no-3',
        outcome: 'NO',
        size: 7,
        avgPrice: 0.38,
      });

    await expect(
      resolveManagedPositions(
        [
          'https://polymarket.com/event/market-1',
          'https://polymarket.com/event/market-2',
          'https://polymarket.com/event/market-3',
        ],
        '0xuser',
      )
    ).resolves.toEqual([
      {
        conditionId: '0xmarket-1',
        tokenId: 'yes-1',
        outcome: 'YES',
        size: 11,
        avgPrice: 0.41,
      },
      {
        conditionId: '0xmarket-3',
        tokenId: 'no-3',
        outcome: 'NO',
        size: 7,
        avgPrice: 0.38,
      },
    ]);

    expect(resolveMarketIdsMock).toHaveBeenCalledTimes(1);
    expect(resolveMarketIdsMock.mock.calls[0][0].map(market => market.url)).toEqual([
      'https://polymarket.com/event/market-1',
      'https://polymarket.com/event/market-2',
      'https://polymarket.com/event/market-3',
    ]);
    expect(getCurrentPositionForMarketMock).toHaveBeenNthCalledWith(
      1,
      '0xuser',
      '0xmarket-1',
      'yes-1',
      'no-1',
    );
    expect(getCurrentPositionForMarketMock).toHaveBeenNthCalledWith(
      2,
      '0xuser',
      '0xmarket-2',
      'yes-2',
      'no-2',
    );
    expect(getCurrentPositionForMarketMock).toHaveBeenNthCalledWith(
      3,
      '0xuser',
      '0xmarket-3',
      'yes-3',
      'no-3',
    );
  });
});
