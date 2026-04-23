jest.mock('https-proxy-agent', () => ({
  HttpsProxyAgent: jest.fn(),
}));

import { MarketReward, passesManualSelection, scoreMarket } from '../market-scanner';

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
  it('scores markets by daily rate per min_size with a competitiveness penalty', () => {
    const reward = buildReward({
      rewards_min_size: 25,
      market_competitiveness: 4,
    });

    const scored = scoreMarket(
      reward,
      250,
      new Date('2026-04-22T00:00:00Z'),
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
      )
    ).toBeNull();
  });
});
