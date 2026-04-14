import { EventEmitter } from 'events';
import WebSocket from 'ws';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { HttpsProxyAgent } = require('https-proxy-agent');
import logger from './logger';

const WS_HEARTBEAT_INTERVAL_MS = 10_000;
const WS_STALE_TIMEOUT_MS = 30_000;
const WS_MAX_RECONNECT_DELAY_MS = 60_000;

export class WsManager extends EventEmitter {
  private ws: WebSocket | null = null;
  private tokenIds: string[] = [];
  private reconnectAttempt = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private staleTimer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(private readonly wsHost: string) {
    super();
  }

  subscribe(tokenIds: string[]): void {
    this.tokenIds = [...new Set([...this.tokenIds, ...tokenIds])];
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscribe();
    }
  }

  connect(): void {
    this.stopping = false;
    this.openConnection();
  }

  disconnect(): void {
    this.stopping = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.terminate();
      this.ws = null;
    }
    logger.info('[WS] Disconnected');
  }

  private openConnection(): void {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.terminate();
    }

    logger.info(`[WS] Connecting (attempt=${this.reconnectAttempt})...`);
    const proxyUrl = process.env.https_proxy ?? process.env.HTTPS_PROXY ?? process.env.http_proxy ?? process.env.HTTP_PROXY;
    const wsOptions = proxyUrl ? { agent: new HttpsProxyAgent(proxyUrl) } : {};
    const ws = new WebSocket(this.wsHost, wsOptions);
    this.ws = ws;

    ws.on('open', () => {
      logger.info('[WS] Connected');
      this.reconnectAttempt = 0;
      this.resetStaleTimer();
      this.startHeartbeat();
      this.sendSubscribe();
      this.emit('connected');
    });

    ws.on('message', (data: WebSocket.RawData) => {
      this.resetStaleTimer();
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch {
        // ignore parse errors
      }
    });

    ws.on('pong', () => {
      this.resetStaleTimer();
    });

    ws.on('close', (code, reason) => {
      logger.warn(`[WS] Closed code=${code} reason=${reason.toString()}`);
      this.clearTimers();
      this.emit('disconnected');
      if (!this.stopping) this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      logger.error('[WS] Error:', err.message);
      // close event will fire after error, triggering reconnect
    });
  }

  private sendSubscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.tokenIds.length === 0) return;

    const msg = JSON.stringify({
      auth: {},
      type: 'subscribe',
      channel: 'book',
      markets: [],
      assets_ids: this.tokenIds,
    });
    this.ws.send(msg);
    logger.info(`[WS] Subscribed to ${this.tokenIds.length} token(s)`);
  }

  private handleMessage(msg: any): void {
    // The CLOB WS sends two shapes:
    //
    // 1. Book snapshot — JSON array, sent once on subscribe:
    //    [{ market, asset_id, bids: [{price,size},...], asks: [...] }]
    //    NOTE: bids/asks contain the full sparse depth (eg. bid=0.01, ask=0.99
    //    for neg_risk markets). Do NOT compute mid from these — the first
    //    price_changes message carries the authoritative best_bid / best_ask.
    //
    // 2. Price-change update — single object sent on every trade/quote change:
    //    { market, price_changes: [{ asset_id, side, price, size, best_bid, best_ask }] }

    if (Array.isArray(msg)) {
      // Shape 1: snapshot — subscription confirmed, discard for mid purposes
      return;
    }

    if (msg.price_changes && Array.isArray(msg.price_changes)) {
      // Shape 2: incremental update with authoritative best_bid / best_ask
      for (const change of msg.price_changes) {
        const tokenId: string = change.asset_id;
        if (!tokenId) continue;
        const bestBid = parseFloat(change.best_bid);
        const bestAsk = parseFloat(change.best_ask);
        if (isFinite(bestBid) && isFinite(bestAsk) && bestBid > 0 && bestAsk > 0 && bestBid < bestAsk) {
          const mid = (bestBid + bestAsk) / 2;
          this.emit('midUpdate', tokenId, mid);
        }
      }
    }
  }

  private scheduleReconnect(): void {
    this.reconnectAttempt++;
    const delay = Math.min(Math.pow(2, this.reconnectAttempt - 1) * 1000, WS_MAX_RECONNECT_DELAY_MS);
    logger.info(`[WS] Reconnecting attempt=${this.reconnectAttempt} in ${delay}ms`);
    setTimeout(() => {
      if (!this.stopping) this.openConnection();
    }, delay);
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, WS_HEARTBEAT_INTERVAL_MS);
  }

  private resetStaleTimer(): void {
    if (this.staleTimer) clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => {
      logger.warn('[WS] Stale connection detected, terminating for reconnect');
      this.ws?.terminate();
    }, WS_STALE_TIMEOUT_MS);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearHeartbeat();
    if (this.staleTimer) {
      clearTimeout(this.staleTimer);
      this.staleTimer = null;
    }
  }
}
