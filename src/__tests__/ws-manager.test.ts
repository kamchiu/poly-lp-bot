jest.mock('../logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('https-proxy-agent', () => ({
  HttpsProxyAgent: jest.fn(),
}));

import { WsManager } from '../ws-manager';

describe('WsManager', () => {
  it('keeps a local book and emits quote updates from snapshot plus deltas', () => {
    const manager = new WsManager('wss://example.test/ws');
    const quoteUpdates: any[] = [];
    const midUpdates: Array<{ tokenId: string; mid: number }> = [];

    manager.on('quoteUpdate', update => {
      quoteUpdates.push(update);
    });
    manager.on('midUpdate', (tokenId: string, mid: number) => {
      midUpdates.push({ tokenId, mid });
    });

    (manager as any).handleMessage([
      {
        asset_id: 'token-1',
        bids: [{ price: '0.45', size: '10' }],
        asks: [{ price: '0.50', size: '12' }],
      },
    ]);

    (manager as any).handleMessage({
      price_changes: [
        {
          asset_id: 'token-1',
          side: 'BUY',
          price: '0.46',
          size: '20',
          best_bid: '0.46',
          best_ask: '0.47',
        },
      ],
    });

    expect(quoteUpdates).toHaveLength(1);
    expect(quoteUpdates[0]).toEqual({
      tokenId: 'token-1',
      bestBid: 0.46,
      bestAsk: 0.47,
      book: {
        bids: [
          { price: '0.46', size: '20' },
          { price: '0.45', size: '10' },
        ],
        asks: [
          { price: '0.5', size: '12' },
        ],
      },
    });
    expect(midUpdates).toHaveLength(1);
    expect(midUpdates[0].tokenId).toBe('token-1');
    expect(midUpdates[0].mid).toBeCloseTo(0.465, 10);
  });
});
