jest.mock('https-proxy-agent', () => ({
  HttpsProxyAgent: jest.fn(),
}));

jest.mock('@polymarket/clob-client-v2', () => ({
  ClobClient: jest.fn(),
  Side: { BUY: 'BUY', SELL: 'SELL' },
  SignatureTypeV2: { EOA: 0, POLY_PROXY: 1, POLY_GNOSIS_SAFE: 2, POLY_1271: 3 },
  AssetType: { COLLATERAL: 'COLLATERAL', CONDITIONAL: 'CONDITIONAL' },
  OrderType: { GTC: 'GTC', FOK: 'FOK', GTD: 'GTD', FAK: 'FAK' },
  Chain: { POLYGON: 137, AMOY: 80002 },
}));

jest.mock('viem', () => ({
  createWalletClient: jest.fn().mockReturnValue({ wallet: true }),
  http: jest.fn().mockReturnValue({ transport: true }),
}));

jest.mock('viem/accounts', () => ({
  privateKeyToAccount: jest.fn().mockReturnValue({
    address: '0xeoa000000000000000000000000000000000000',
  }),
}));

jest.mock('viem/chains', () => ({
  polygon: { id: 137, name: 'Polygon' },
  polygonAmoy: { id: 80002, name: 'Polygon Amoy' },
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
import { ClobClient } from '@polymarket/clob-client-v2';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import * as https from 'https';
import {
  getCurrentPositionForMarket,
  getMarketInfo,
  getPositionsUserAddress,
  initClient,
  placeLimitOrder,
  stopHeartbeat,
} from '../client';

const httpsGetMock = https.get as jest.MockedFunction<typeof https.get>;
const ClobClientMock = ClobClient as jest.MockedClass<typeof ClobClient>;
const createWalletClientMock = createWalletClient as jest.MockedFunction<typeof createWalletClient>;
const httpMock = http as jest.MockedFunction<typeof http>;
const privateKeyToAccountMock = privateKeyToAccount as jest.MockedFunction<typeof privateKeyToAccount>;

const creds = {
  key: 'api-key',
  secret: 'api-secret',
  passphrase: 'api-passphrase',
};

function buildL1ClientMock() {
  return {
    createOrDeriveApiKey: jest.fn().mockResolvedValue(creds),
  };
}

function buildL2ClientMock(overrides: Record<string, unknown> = {}) {
  return {
    updateBalanceAllowance: jest.fn().mockResolvedValue(undefined),
    getBalanceAllowance: jest.fn().mockResolvedValue({ balance: '100', allowance: '100' }),
    createAndPostOrder: jest.fn(),
    getClobMarketInfo: jest.fn(),
    getRawRewardsForMarket: jest.fn(),
    ...overrides,
  };
}

async function initWithMocks(l2Overrides: Record<string, unknown> = {}) {
  const l1Client = buildL1ClientMock();
  const l2Client = buildL2ClientMock(l2Overrides);

  ClobClientMock
    .mockImplementationOnce(() => l1Client as unknown as ClobClient)
    .mockImplementationOnce(() => l2Client as unknown as ClobClient);

  await initClient('https://clob.polymarket.com', 137, 'abc123');

  return { l1Client, l2Client };
}

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
  const originalSignatureType = process.env.POLYMARKET_SIGNATURE_TYPE;

  beforeEach(() => {
    httpsGetMock.mockReset();
    ClobClientMock.mockReset();
    createWalletClientMock.mockClear();
    httpMock.mockClear();
    privateKeyToAccountMock.mockClear();
    privateKeyToAccountMock.mockReturnValue({
      address: '0xeoa000000000000000000000000000000000000',
    } as unknown as ReturnType<typeof privateKeyToAccount>);
    delete process.env.POLYMARKET_PROXY_ADDRESS;
    delete process.env.POLYMARKET_SIGNATURE_TYPE;
  });

  afterEach(() => {
    stopHeartbeat();
  });

  afterAll(() => {
    if (originalProxyAddress === undefined) {
      delete process.env.POLYMARKET_PROXY_ADDRESS;
    } else {
      process.env.POLYMARKET_PROXY_ADDRESS = originalProxyAddress;
    }

    if (originalSignatureType === undefined) {
      delete process.env.POLYMARKET_SIGNATURE_TYPE;
    } else {
      process.env.POLYMARKET_SIGNATURE_TYPE = originalSignatureType;
    }
  });

  it('prefers POLYMARKET_PROXY_ADDRESS for position lookups', () => {
    process.env.POLYMARKET_PROXY_ADDRESS = '0xproxy000000000000000000000000000000000000';

    expect(getPositionsUserAddress('0xprivate')).toBe('0xproxy000000000000000000000000000000000000');
  });

  it('falls back to the private key wallet address for position lookups', () => {
    expect(getPositionsUserAddress('0xprivate')).toBe('0xeoa000000000000000000000000000000000000');
  });

  it('initializes the V2 client in EOA mode', async () => {
    await initWithMocks();

    expect(privateKeyToAccountMock).toHaveBeenCalledWith('0xabc123');
    expect(httpMock).toHaveBeenCalledTimes(1);
    expect(createWalletClientMock).toHaveBeenCalledWith({
      account: { address: '0xeoa000000000000000000000000000000000000' },
      chain: { id: 137, name: 'Polygon' },
      transport: { transport: true },
    });
    expect(ClobClientMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      host: 'https://clob.polymarket.com',
      chain: 137,
      signer: { wallet: true },
      signatureType: 0,
      funderAddress: undefined,
    }));
    expect(ClobClientMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      host: 'https://clob.polymarket.com',
      chain: 137,
      signer: { wallet: true },
      creds,
      signatureType: 0,
      funderAddress: undefined,
      retryOnError: true,
    }));
  });

  it('initializes the V2 client with proxy wallet signing when configured', async () => {
    process.env.POLYMARKET_PROXY_ADDRESS = '0xproxy000000000000000000000000000000000000';

    await initWithMocks();

    expect(ClobClientMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      signatureType: 2,
      funderAddress: '0xproxy000000000000000000000000000000000000',
    }));
    expect(ClobClientMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      signatureType: 2,
      funderAddress: '0xproxy000000000000000000000000000000000000',
    }));
  });

  it('honors an explicit V2 signature type override', async () => {
    process.env.POLYMARKET_PROXY_ADDRESS = '0xproxy000000000000000000000000000000000000';
    process.env.POLYMARKET_SIGNATURE_TYPE = '1';

    await initWithMocks();

    expect(ClobClientMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      signatureType: 1,
      funderAddress: '0xproxy000000000000000000000000000000000000',
    }));
    expect(ClobClientMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      signatureType: 1,
      funderAddress: '0xproxy000000000000000000000000000000000000',
    }));
  });

  it('rejects proxy signature types without a proxy address', async () => {
    process.env.POLYMARKET_SIGNATURE_TYPE = '1';
    const l1Client = buildL1ClientMock();
    ClobClientMock.mockImplementationOnce(() => l1Client as unknown as ClobClient);

    await expect(initClient('https://clob.polymarket.com', 137, 'abc123')).rejects.toThrow(
      'POLYMARKET_PROXY_ADDRESS is required'
    );
  });

  it('uses the Amoy viem chain for Amoy CLOB chain IDs', async () => {
    const l1Client = buildL1ClientMock();
    const l2Client = buildL2ClientMock();

    ClobClientMock
      .mockImplementationOnce(() => l1Client as unknown as ClobClient)
      .mockImplementationOnce(() => l2Client as unknown as ClobClient);

    await initClient('https://clob.polymarket.com', 80002, 'abc123');

    expect(createWalletClientMock).toHaveBeenCalledWith({
      account: { address: '0xeoa000000000000000000000000000000000000' },
      chain: { id: 80002, name: 'Polygon Amoy' },
      transport: { transport: true },
    });
  });

  it('places GTC orders through the V2 atomic create/post API', async () => {
    const { l2Client } = await initWithMocks({
      createAndPostOrder: jest.fn().mockResolvedValue({
        success: true,
        orderID: 'order-1',
        status: 'live',
      }),
    });

    await expect(placeLimitOrder('BUY', 0.4, 10, 'token-1')).resolves.toEqual({
      orderId: 'order-1',
      status: 'live',
      price: 0.4,
      size: 10,
      tokenId: 'token-1',
      side: 'BUY',
    });

    expect(l2Client.createAndPostOrder).toHaveBeenCalledWith(
      {
        tokenID: 'token-1',
        price: 0.4,
        side: 'BUY',
        size: 10,
      },
      undefined,
      'GTC',
    );
  });

  it('uses the cached V2 market tick size when placing orders', async () => {
    const { l2Client } = await initWithMocks({
      getClobMarketInfo: jest.fn().mockResolvedValue({
        c: '0xcondition',
        mts: 0.01,
        nr: false,
        t: [{ t: 'yes-token', o: 'Yes' }, { t: 'no-token', o: 'No' }],
      }),
      getRawRewardsForMarket: jest.fn().mockResolvedValue([
        {
          rewards_max_spread: 5,
          rewards_config: [{ rate_per_day: 10 }],
        },
      ]),
      createAndPostOrder: jest.fn().mockResolvedValue({
        success: true,
        orderID: 'order-2',
        status: 'live',
      }),
    });

    await expect(getMarketInfo('0xcondition', 0.04)).resolves.toEqual({
      v: 0.05,
      tick_size: 0.01,
      rewards_daily_rate: 10,
    });
    await placeLimitOrder('SELL', 0.6, 11, 'yes-token');

    expect(l2Client.createAndPostOrder).toHaveBeenCalledWith(
      {
        tokenID: 'yes-token',
        price: 0.6,
        side: 'SELL',
        size: 11,
      },
      { tickSize: '0.01' },
      'GTC',
    );
  });

  it('returns null when the V2 order response is unsuccessful', async () => {
    await initWithMocks({
      createAndPostOrder: jest.fn().mockResolvedValue({
        success: false,
        errorMsg: 'invalid order',
        status: 'rejected',
      }),
    });

    await expect(placeLimitOrder('SELL', 0.6, 10, 'token-2')).resolves.toBeNull();
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
