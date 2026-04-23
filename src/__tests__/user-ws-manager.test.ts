jest.mock('https-proxy-agent', () => ({
  HttpsProxyAgent: jest.fn(),
}));

import { UserWsManager } from '../user-ws-manager';
import logger from '../logger';

jest.mock('../logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const CREDS = {
  key: 'key',
  secret: 'secret',
  passphrase: 'passphrase',
};

const loggerMock = logger as unknown as {
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
  debug: jest.Mock;
};

describe('UserWsManager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('emits taker fills with taker_order_id', () => {
    const manager = new UserWsManager('wss://example.test/ws/user', CREDS);
    const onFill = jest.fn();

    manager.on('fill', onFill);
    (manager as any).handleTradeEvent({
      id: 'trade-1',
      market: 'condition-1',
      trader_side: 'TAKER',
      taker_order_id: 'taker-order-1',
      asset_id: 'asset-1',
      side: 'SELL',
      size: '20',
      price: '0.44',
      fee_rate_bps: '0',
      transaction_hash: '0xtx',
      match_time: '1711111111',
      maker_orders: [
        {
          order_id: 'maker-order-1',
          asset_id: 'asset-1',
          side: 'BUY',
          matched_amount: '20',
          price: '0.44',
          fee_rate_bps: '0',
        },
      ],
    });

    expect(onFill).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 'taker-order-1',
      assetId: 'asset-1',
      conditionId: 'condition-1',
      source: 'user-ws',
      side: 'SELL',
      size: 20,
      price: 0.44,
    }));
    expect(loggerMock.info).toHaveBeenCalledWith(expect.stringContaining('source=user-ws role=TAKER'));
  });

  it('emits maker fills from maker_orders', () => {
    const manager = new UserWsManager('wss://example.test/ws/user', CREDS);
    const onFill = jest.fn();

    manager.on('fill', onFill);
    (manager as any).handleTradeEvent({
      id: 'trade-2',
      market: 'condition-2',
      trader_side: 'MAKER',
      maker_orders: [
        {
          order_id: 'maker-order-2',
          asset_id: 'asset-2',
          side: 'BUY',
          matched_amount: '15',
          price: '0.51',
          fee_rate_bps: '5',
          transaction_hash: '0xtx2',
          match_time: '1711112222',
        },
      ],
    });

    expect(onFill).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 'maker-order-2',
      assetId: 'asset-2',
      conditionId: 'condition-2',
      source: 'user-ws',
      side: 'BUY',
      size: 15,
      price: 0.51,
      feeRateBps: 5,
    }));
  });
});
