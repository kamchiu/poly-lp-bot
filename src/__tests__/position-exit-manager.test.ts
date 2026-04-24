import { EventEmitter } from 'events';
import { getOrderStatus, placeLimitOrder } from '../client';
import { PositionExitManager } from '../position-exit-manager';
import { ManagedPosition } from '../types';
import type { WsManager } from '../ws-manager';

jest.mock('../client', () => ({
  placeLimitOrder: jest.fn(),
  getOrderStatus: jest.fn(),
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

const placeLimitOrderMock = placeLimitOrder as jest.MockedFunction<typeof placeLimitOrder>;
const getOrderStatusMock = getOrderStatus as jest.MockedFunction<typeof getOrderStatus>;

const basePosition: ManagedPosition = {
  conditionId: '0xcondition',
  tokenId: 'token-yes',
  outcome: 'YES',
  size: 15,
  avgPrice: 0.4,
};

const buildPlacedOrder = (
  orderId: string,
): NonNullable<Awaited<ReturnType<typeof placeLimitOrder>>> => ({
  orderId,
  status: 'live',
  price: 0.41,
  size: 15,
  tokenId: 'token-yes',
  side: 'SELL',
});

const flushPromises = async (): Promise<void> => {
  await new Promise<void>(resolve => process.nextTick(resolve));
};

function createWsManagerStub(): EventEmitter & Pick<WsManager, 'subscribe' | 'connect' | 'disconnect'> {
  const emitter = new EventEmitter() as EventEmitter & Pick<WsManager, 'subscribe' | 'connect' | 'disconnect'>;
  emitter.subscribe = jest.fn();
  emitter.connect = jest.fn();
  emitter.disconnect = jest.fn();
  return emitter;
}

describe('PositionExitManager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    placeLimitOrderMock.mockReset();
    getOrderStatusMock.mockReset();
    getOrderStatusMock.mockResolvedValue({
      sizeMatched: 15,
      originalSize: 15,
      status: 'matched',
      price: 0.41,
      assetId: 'token-yes',
    });
  });

  it('subscribes to the managed token and places a SELL order once best bid exceeds avgPrice', async () => {
    placeLimitOrderMock.mockResolvedValue(buildPlacedOrder('exit-order-1'));

    const wsManager = createWsManagerStub();
    const manager = new PositionExitManager(basePosition, wsManager as unknown as WsManager);
    const exitPlaced = jest.fn();

    manager.on('exitPlaced', exitPlaced);
    manager.start();

    expect(wsManager.subscribe).toHaveBeenCalledWith(['token-yes']);
    expect(wsManager.connect).not.toHaveBeenCalled();

    wsManager.emit('quoteUpdate', {
      tokenId: 'token-yes',
      bestBid: 0.41,
      bestAsk: 0.42,
      book: null,
    });

    await flushPromises();
    await flushPromises();

    expect(placeLimitOrderMock).toHaveBeenCalledWith('SELL', 0.41, 15, 'token-yes');
    expect(getOrderStatusMock).toHaveBeenCalledWith('exit-order-1');
    expect(exitPlaced).toHaveBeenCalledWith({
      orderId: 'exit-order-1',
      price: 0.41,
      size: 15,
      status: 'matched',
    });
    expect(wsManager.disconnect).not.toHaveBeenCalled();
    expect(manager.hasSubmittedExit()).toBe(true);
  });

  it('ignores quotes that do not beat avgPrice or belong to another token', async () => {
    const wsManager = createWsManagerStub();
    const manager = new PositionExitManager(basePosition, wsManager as unknown as WsManager);

    manager.start();

    wsManager.emit('quoteUpdate', {
      tokenId: 'token-no',
      bestBid: 0.8,
      bestAsk: 0.81,
      book: null,
    });
    wsManager.emit('quoteUpdate', {
      tokenId: 'token-yes',
      bestBid: 0.4,
      bestAsk: 0.41,
      book: null,
    });

    await flushPromises();

    expect(placeLimitOrderMock).not.toHaveBeenCalled();

    manager.stop();
  });

  it('keeps monitoring after a rejected exit placement and retries on the next trigger', async () => {
    placeLimitOrderMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(buildPlacedOrder('exit-order-2'));

    const wsManager = createWsManagerStub();
    const manager = new PositionExitManager(basePosition, wsManager as unknown as WsManager);

    manager.start();

    wsManager.emit('quoteUpdate', {
      tokenId: 'token-yes',
      bestBid: 0.405,
      bestAsk: 0.41,
      book: null,
    });

    await flushPromises();
    expect(placeLimitOrderMock).toHaveBeenCalledTimes(1);
    expect(manager.hasSubmittedExit()).toBe(false);
    expect(wsManager.disconnect).not.toHaveBeenCalled();

    wsManager.emit('quoteUpdate', {
      tokenId: 'token-yes',
      bestBid: 0.415,
      bestAsk: 0.42,
      book: null,
    });

    await flushPromises();
    await flushPromises();

    expect(placeLimitOrderMock).toHaveBeenCalledTimes(2);
    expect(placeLimitOrderMock).toHaveBeenNthCalledWith(2, 'SELL', 0.415, 15, 'token-yes');
    expect(manager.hasSubmittedExit()).toBe(true);
    expect(wsManager.disconnect).not.toHaveBeenCalled();
  });
});
