jest.mock('https-proxy-agent', () => ({
  HttpsProxyAgent: jest.fn(),
}));

jest.mock('@polymarket/clob-client', () => ({
  ClobClient: jest.fn(),
  Side: { BUY: 'BUY', SELL: 'SELL' },
  SignatureType: { EOA: 0, POLY_GNOSIS_SAFE: 2 },
  AssetType: { COLLATERAL: 'COLLATERAL', CONDITIONAL: 'CONDITIONAL' },
}));

jest.mock('ethers', () => ({
  ethers: {
    Wallet: jest.fn().mockImplementation(() => ({
      address: '0xeoa000000000000000000000000000000000000',
    })),
  },
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
import { getCurrentPositionForMarket, getPositionsUserAddress } from '../client';

const httpsGetMock = https.get as jest.MockedFunction<typeof https.get>;

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

describe('client position helpers', () => {
  const originalProxyAddress = process.env.POLYMARKET_PROXY_ADDRESS;

  beforeEach(() => {
    httpsGetMock.mockReset();
    delete process.env.POLYMARKET_PROXY_ADDRESS;
  });

  afterAll(() => {
    if (originalProxyAddress === undefined) {
      delete process.env.POLYMARKET_PROXY_ADDRESS;
      return;
    }

    process.env.POLYMARKET_PROXY_ADDRESS = originalProxyAddress;
  });

  it('prefers POLYMARKET_PROXY_ADDRESS for position lookups', () => {
    process.env.POLYMARKET_PROXY_ADDRESS = '0xproxy000000000000000000000000000000000000';

    expect(getPositionsUserAddress('0xprivate')).toBe('0xproxy000000000000000000000000000000000000');
  });

  it('falls back to the private key wallet address for position lookups', () => {
    expect(getPositionsUserAddress('0xprivate')).toBe('0xeoa000000000000000000000000000000000000');
  });

  it('returns a YES position when the API asset matches the YES token', async () => {
    queueJsonResponse([
      {
        conditionId: '0xcondition',
        asset: 'yes-token',
        size: '12.5',
        avgPrice: '0.44',
        outcome: 'Yes',
      },
    ]);

    await expect(
      getCurrentPositionForMarket('0xuser', '0xcondition', 'yes-token', 'no-token')
    ).resolves.toEqual({
      conditionId: '0xcondition',
      tokenId: 'yes-token',
      outcome: 'YES',
      size: 12.5,
      avgPrice: 0.44,
    });

    expect(String(httpsGetMock.mock.calls[0][0])).toContain('user=0xuser');
    expect(String(httpsGetMock.mock.calls[0][0])).toContain('market=0xcondition');
    expect(String(httpsGetMock.mock.calls[0][0])).toContain('sizeThreshold=0');
  });

  it('falls back to outcome when asset is missing from the API payload', async () => {
    queueJsonResponse([
      {
        condition_id: '0xcondition',
        size: '8',
        avg_price: '0.39',
        outcome: 'NO',
      },
    ]);

    await expect(
      getCurrentPositionForMarket('0xuser', '0xcondition', 'yes-token', 'no-token')
    ).resolves.toEqual({
      conditionId: '0xcondition',
      tokenId: 'no-token',
      outcome: 'NO',
      size: 8,
      avgPrice: 0.39,
    });
  });

  it('rejects when both YES and NO positions are returned for the same market', async () => {
    queueJsonResponse([
      {
        conditionId: '0xcondition',
        asset: 'yes-token',
        size: '5',
        avgPrice: '0.41',
      },
      {
        conditionId: '0xcondition',
        asset: 'no-token',
        size: '7',
        avgPrice: '0.43',
      },
    ]);

    await expect(
      getCurrentPositionForMarket('0xuser', '0xcondition', 'yes-token', 'no-token')
    ).rejects.toThrow('Expected at most one open position');
  });
});
