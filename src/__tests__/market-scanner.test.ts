jest.mock('https-proxy-agent', () => ({
  HttpsProxyAgent: jest.fn(),
}));

import { MarketReward, passesManualSelection, scoreMarket, selectMarkets } from '../market-scanner';

function buildReward(overrides: Partial<MarketReward> = {}): MarketReward {
  return {
    condition_id: '0xscanner-test',
    question: 'Will example market resolve yes?',
    market_slug: 'example-market',
    event_slug: 'example-event',
    market_competitiveness: 5,
    rewards_config: [
      {
        asset_address: '0xasset',
        start_date: '2026-05-01T00:00:00Z',
        end_date: '2026-06-30T00:00:00Z',
        rate_per_day: 100,
        total_rewards: 1000,
        id: 1,
      },
    ],
    rewards_max_spread: 4.5,
    rewards_min_size: 20,
    tokens: [
      { token_id: 'yes-token', outcome: 'Yes', price: 0.5 },
      { token_id: 'no-token', outcome: 'No', price: 0.5 },
    ],
    volume_24hr: 100_000,
    end_date: '2026-06-30T00:00:00Z',
    spread: 0.02,
    ...overrides,
  };
}

describe('market-scanner manual filters', () => {
  it('keeps only explicitly whitelisted markets when a whitelist is provided', () => {
    const reward = buildReward({ market_slug: 'keep-me' });

    expect(
      passesManualSelection(reward, {
        whitelistSlugs: ['keep-me'],
        whitelistKeywords: [],
        blacklistSlugs: [],
        blacklistKeywords: [],
        minDaysToEvent: 14,
      })
    ).toBe(true);

    expect(
      passesManualSelection(reward, {
        whitelistSlugs: ['different-market'],
        whitelistKeywords: [],
        blacklistSlugs: [],
        blacklistKeywords: [],
        minDaysToEvent: 14,
      })
    ).toBe(false);
  });

  it('drops markets that match a blacklist keyword', () => {
    const reward = buildReward({ question: 'Will the Fed cut rates next week?' });

    expect(
      passesManualSelection(reward, {
        whitelistSlugs: [],
        whitelistKeywords: [],
        blacklistSlugs: [],
        blacklistKeywords: ['fed cut rates'],
        minDaysToEvent: 14,
      })
    ).toBe(false);
  });
});

describe('market-scanner catalyst filter', () => {
  it('supports exact competitiveness matching for runtime scans', () => {
    const reward = buildReward({ market_competitiveness: 0 });

    expect(
      scoreMarket(
        reward,
        100,
        new Date('2026-04-22T00:00:00Z'),
        { exactCompetitiveness: 0 },
        { bestBid: 0.45, bestAsk: 0.55 }
      )
    ).not.toBeNull();

    expect(
      scoreMarket(
        buildReward({ market_competitiveness: 1 }),
        100,
        new Date('2026-04-22T00:00:00Z'),
        { exactCompetitiveness: 0 },
        { bestBid: 0.45, bestAsk: 0.55 }
      )
    ).toBeNull();
  });

  it('scores markets by daily rate per min_size with a competitiveness penalty', () => {
    const reward = buildReward({
      rewards_min_size: 25,
      market_competitiveness: 4,
    });

    const scored = scoreMarket(
      reward,
      250,
      new Date('2026-04-22T00:00:00Z'),
      {},
      { bestBid: 0.45, bestAsk: 0.55 }
    );

    expect(scored).not.toBeNull();
    expect(scored?.score).toBeCloseTo((250 / 25) * (1 / (1 + 4)));
  });

  it('rejects markets with non-positive min_size', () => {
    const reward = buildReward({ rewards_min_size: 0 });

    expect(
      scoreMarket(
        reward,
        100,
        new Date('2026-04-22T00:00:00Z'),
        {},
        { bestBid: 0.45, bestAsk: 0.55 }
      )
    ).toBeNull();
  });

  it('does not reject a market only because the current spread exceeds rewards_max_spread', () => {
    const reward = buildReward({
      spread: 0.06,
      rewards_max_spread: 4.5,
    });

    expect(
      scoreMarket(
        reward,
        100,
        new Date('2026-04-22T00:00:00Z'),
        {},
        { bestBid: 0.45, bestAsk: 0.55 }
      )
    ).not.toBeNull();
  });

  it('rejects markets whose event date is too close', () => {
    const reward = buildReward({
      end_date: '2026-04-30T00:00:00Z',
      rewards_config: [
        {
          asset_address: '0xasset',
          start_date: '2026-05-01T00:00:00Z',
          end_date: '2026-04-30T00:00:00Z',
          rate_per_day: 100,
          total_rewards: 1000,
          id: 1,
        },
      ],
    });

    expect(
      scoreMarket(
        reward,
        100,
        new Date('2026-04-22T00:00:00Z'),
        {},
        { bestBid: 0.45, bestAsk: 0.55 }
      )
    ).toBeNull();
  });

  it('filters on best bid and best ask ranges instead of midpoint', () => {
    const reward = buildReward({
      tokens: [
        { token_id: 'yes-token', outcome: 'Yes', price: 0.95 },
        { token_id: 'no-token', outcome: 'No', price: 0.05 },
      ],
    });

    expect(
      scoreMarket(
        reward,
        100,
        new Date('2026-04-22T00:00:00Z'),
        {
          minMid: 0,
          maxMid: 1,
          minBestBid: 0.1,
          maxBestBid: 0.9,
          minBestAsk: 0.1,
          maxBestAsk: 0.9,
        },
        { bestBid: 0.4, bestAsk: 0.6 }
      )
    ).not.toBeNull();

    expect(
      scoreMarket(
        reward,
        100,
        new Date('2026-04-22T00:00:00Z'),
        {
          minMid: 0,
          maxMid: 1,
          minBestBid: 0.1,
          maxBestBid: 0.9,
          minBestAsk: 0.1,
          maxBestAsk: 0.9,
        },
        { bestBid: 0.05, bestAsk: 0.6 }
      )
    ).toBeNull();
  });
});

describe('selectMarkets', () => {
  it('returns all passing markets when count is omitted', async () => {
    const selected = await selectMarkets(
      [
        buildReward({
          condition_id: 'cond-1',
          market_slug: 'market-1',
          event_slug: 'event-1',
          tokens: [
            { token_id: 'yes-1', outcome: 'Yes', price: 0.5 },
            { token_id: 'no-1', outcome: 'No', price: 0.5 },
          ],
        }),
        buildReward({
          condition_id: 'cond-2',
          market_slug: 'market-2',
          event_slug: 'event-2',
          tokens: [
            { token_id: 'yes-2', outcome: 'Yes', price: 0.55 },
            { token_id: 'no-2', outcome: 'No', price: 0.45 },
          ],
          market_competitiveness: 0,
        }),
      ],
      {
        now: new Date('2026-04-22T00:00:00Z'),
        minDailyRate: 20,
        maxMinShares: 20,
      }
    );

    expect(selected).toHaveLength(2);
  });

  it('runtime-style scan options keep explicit requirements plus best bid/ask filters', async () => {
    const selected = await selectMarkets(
      [
        buildReward({
          condition_id: 'cond-runtime',
          market_competitiveness: 0,
          rewards_min_size: 20,
          rewards_config: [
            {
              asset_address: '0xasset',
              start_date: '2026-05-01T00:00:00Z',
              end_date: '2026-04-23T00:00:00Z',
              rate_per_day: 5000,
              total_rewards: 1000,
              id: 1,
            },
          ],
          tokens: [
            { token_id: 'yes-runtime', outcome: 'Yes', price: 0.5 },
            { token_id: 'no-runtime', outcome: 'No', price: 0.5 },
          ],
          volume_24hr: 1,
          end_date: '2026-04-23T00:00:00Z',
        }),
      ],
      {
        now: new Date('2026-04-22T00:00:00Z'),
        minDailyRate: 20,
        maxDailyRate: Number.POSITIVE_INFINITY,
        maxMinShares: 20,
        minVolume24h: 0,
        maxVolume24h: Number.POSITIVE_INFINITY,
        minDaysToEvent: Number.NEGATIVE_INFINITY,
        minMid: 0,
        maxMid: 1,
        minBestBid: 0.1,
        maxBestBid: 0.9,
        minBestAsk: 0.1,
        maxBestAsk: 0.9,
        exactCompetitiveness: 0,
        bestPricesByTokenId: {
          'yes-runtime': { bestBid: 0.4, bestAsk: 0.6 },
        },
      }
    );

    expect(selected).toHaveLength(1);
  });
});
