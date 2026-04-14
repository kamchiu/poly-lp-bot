import { WsManager } from '../ws-manager';

// ─── Mock the 'ws' module ────────────────────────────────────────────────────
// FakeWS MUST be defined inside the factory to avoid the TDZ hoisting issue
// (jest.mock is hoisted above class declarations in TypeScript).

let fakeWs: any;

jest.mock('ws', () => {
  const { EventEmitter } = require('events');

  class FakeWS extends EventEmitter {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 1;          // OPEN
    sentMessages: string[] = [];
    send(data: string) { this.sentMessages.push(data); }
    ping() { /* no-op */ }
    terminate() {
      this.readyState = 3;   // CLOSED
      this.emit('close', 1000, Buffer.from(''));
    }
  }

  const Constructor = jest.fn().mockImplementation(() => {
    fakeWs = new FakeWS();
    return fakeWs;
  });
  (Constructor as any).OPEN = 1;
  (Constructor as any).CLOSED = 3;
  return Constructor;
});

jest.mock('../logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeManager(tokens: string[] = ['TOKEN1']) {
  const mgr = new WsManager('wss://fake.host/ws/');
  mgr.subscribe(tokens);
  return mgr;
}

function simulateOpen() {
  fakeWs.emit('open');
}

function simulateMessage(payload: object) {
  fakeWs.emit('message', Buffer.from(JSON.stringify(payload)));
}

// ─── subscribe & connect ─────────────────────────────────────────────────────

describe('WsManager — connect & subscribe', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.useRealTimers(); jest.clearAllMocks(); });

  it('sends subscribe message with correct shape on open', () => {
    const mgr = makeManager(['TOKEN1', 'TOKEN2']);
    mgr.connect();
    simulateOpen();

    expect(fakeWs.sentMessages).toHaveLength(1);
    const msg = JSON.parse(fakeWs.sentMessages[0]);
    expect(msg.type).toBe('subscribe');
    expect(msg.channels).toHaveLength(1);
    expect(msg.channels[0].name).toBe('book');
    expect(msg.channels[0].token_ids).toEqual(expect.arrayContaining(['TOKEN1', 'TOKEN2']));

    mgr.disconnect();
  });

  it('deduplicates token IDs when subscribing twice', () => {
    const mgr = new WsManager('wss://fake.host/ws/');
    mgr.subscribe(['TOKEN1']);
    mgr.subscribe(['TOKEN1', 'TOKEN2']);
    mgr.connect();
    simulateOpen();

    const msg = JSON.parse(fakeWs.sentMessages[0]);
    expect(msg.channels[0].token_ids).toHaveLength(2);

    mgr.disconnect();
  });

  it('emits "connected" event on open', () => {
    const mgr = makeManager();
    const spy = jest.fn();
    mgr.on('connected', spy);
    mgr.connect();
    simulateOpen();
    expect(spy).toHaveBeenCalledTimes(1);
    mgr.disconnect();
  });
});

// ─── midUpdate emission ───────────────────────────────────────────────────────

describe('WsManager — midUpdate events', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.useRealTimers(); jest.clearAllMocks(); });

  it('emits midUpdate from book_snapshot event (event_type field)', () => {
    const mgr = makeManager(['TOKEN1']);
    const spy = jest.fn();
    mgr.on('midUpdate', spy);
    mgr.connect();
    simulateOpen();

    simulateMessage({
      event_type: 'book_snapshot',
      asset_id: 'TOKEN1',
      bids: [{ price: '0.40', size: '100' }],
      asks: [{ price: '0.60', size: '100' }],
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('TOKEN1', 0.50);
    mgr.disconnect();
  });

  it('emits midUpdate from book event (type field)', () => {
    const mgr = makeManager(['TOKEN1']);
    const spy = jest.fn();
    mgr.on('midUpdate', spy);
    mgr.connect();
    simulateOpen();

    simulateMessage({
      type: 'book',
      asset_id: 'TOKEN1',
      bids: [{ price: '0.42', size: '50' }],
      asks: [{ price: '0.58', size: '50' }],
    });

    expect(spy).toHaveBeenCalledWith('TOKEN1', 0.50);
    mgr.disconnect();
  });

  it('uses market field as tokenId fallback when asset_id is absent', () => {
    const mgr = makeManager();
    const spy = jest.fn();
    mgr.on('midUpdate', spy);
    mgr.connect();
    simulateOpen();

    simulateMessage({
      event_type: 'book_snapshot',
      market: 'TOKEN1',
      bids: [{ price: '0.40', size: '10' }],
      asks: [{ price: '0.60', size: '10' }],
    });

    expect(spy).toHaveBeenCalledWith('TOKEN1', 0.50);
    mgr.disconnect();
  });

  it('does NOT emit midUpdate when bids and asks are both empty', () => {
    const mgr = makeManager();
    const spy = jest.fn();
    mgr.on('midUpdate', spy);
    mgr.connect();
    simulateOpen();

    simulateMessage({
      event_type: 'book_snapshot',
      asset_id: 'TOKEN1',
      bids: [],
      asks: [],
    });

    expect(spy).not.toHaveBeenCalled();
    mgr.disconnect();
  });

  it('does NOT emit midUpdate when book is crossed (bid >= ask)', () => {
    const mgr = makeManager();
    const spy = jest.fn();
    mgr.on('midUpdate', spy);
    mgr.connect();
    simulateOpen();

    simulateMessage({
      event_type: 'book_snapshot',
      asset_id: 'TOKEN1',
      bids: [{ price: '0.70', size: '100' }],
      asks: [{ price: '0.60', size: '100' }],
    });

    expect(spy).not.toHaveBeenCalled();
    mgr.disconnect();
  });

  it('ignores unknown event types', () => {
    const mgr = makeManager();
    const spy = jest.fn();
    mgr.on('midUpdate', spy);
    mgr.connect();
    simulateOpen();

    simulateMessage({ event_type: 'trade', asset_id: 'TOKEN1', price: '0.50' });

    expect(spy).not.toHaveBeenCalled();
    mgr.disconnect();
  });

  it('ignores malformed JSON without throwing', () => {
    const mgr = makeManager();
    mgr.connect();
    simulateOpen();
    expect(() => fakeWs.emit('message', Buffer.from('{bad json}'))).not.toThrow();
    mgr.disconnect();
  });
});

// ─── reconnect ────────────────────────────────────────────────────────────────

describe('WsManager — reconnect behaviour', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.useRealTimers(); jest.clearAllMocks(); });

  it('emits "disconnected" when socket closes unexpectedly', () => {
    const mgr = makeManager();
    const spy = jest.fn();
    mgr.on('disconnected', spy);
    mgr.connect();
    simulateOpen();

    mgr['stopping'] = false;
    fakeWs.readyState = 3;
    fakeWs.emit('close', 1001, Buffer.from(''));

    expect(spy).toHaveBeenCalledTimes(1);
    mgr.disconnect();
  });

  it('schedules reconnect after close when not stopping', () => {
    const WS = require('ws') as jest.Mock;
    WS.mockClear();

    const mgr = makeManager();
    mgr.connect();
    simulateOpen();
    expect(WS).toHaveBeenCalledTimes(1);

    mgr['stopping'] = false;
    fakeWs.readyState = 3;
    fakeWs.emit('close', 1006, Buffer.from(''));

    // First reconnect delay = 2^0 * 1000 = 1000ms
    jest.advanceTimersByTime(1100);
    expect(WS).toHaveBeenCalledTimes(2);

    mgr.disconnect();
  });

  it('does NOT reconnect after explicit disconnect()', () => {
    const WS = require('ws') as jest.Mock;
    WS.mockClear();

    const mgr = makeManager();
    mgr.connect();
    simulateOpen();
    mgr.disconnect();

    jest.advanceTimersByTime(65000);
    expect(WS).toHaveBeenCalledTimes(1);
  });

  it('re-sends subscribe after reconnect', () => {
    const mgr = makeManager(['TOKEN1']);
    mgr.connect();
    simulateOpen();
    const firstWsMessages = fakeWs.sentMessages.length;
    expect(firstWsMessages).toBe(1);

    mgr['stopping'] = false;
    fakeWs.readyState = 3;
    fakeWs.emit('close', 1006, Buffer.from(''));

    jest.advanceTimersByTime(1100);
    // new fakeWs is now set; fire its open event
    simulateOpen();

    expect(fakeWs.sentMessages).toHaveLength(1);
    const msg = JSON.parse(fakeWs.sentMessages[0]);
    expect(msg.channels[0].token_ids).toContain('TOKEN1');

    mgr.disconnect();
  });
});

// ─── stale timer ─────────────────────────────────────────────────────────────

describe('WsManager — stale connection detection', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => { jest.useRealTimers(); jest.clearAllMocks(); });

  it('terminates connection after 30s of silence', () => {
    const mgr = makeManager();
    const disconnectSpy = jest.fn();
    mgr.on('disconnected', disconnectSpy);
    mgr.connect();
    simulateOpen();

    jest.advanceTimersByTime(31000);

    expect(disconnectSpy).toHaveBeenCalled();
    mgr.disconnect();
  });

  it('resets stale timer when a message arrives', () => {
    const mgr = makeManager();
    const disconnectSpy = jest.fn();
    mgr.on('disconnected', disconnectSpy);
    mgr.connect();
    simulateOpen();

    jest.advanceTimersByTime(25000);
    simulateMessage({ event_type: 'book_snapshot', asset_id: 'TOKEN1', bids: [], asks: [] });

    jest.advanceTimersByTime(25000); // total 50s but timer reset at 25s → only 25s elapsed
    expect(disconnectSpy).not.toHaveBeenCalled();

    mgr.disconnect();
  });
});
