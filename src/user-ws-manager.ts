import { EventEmitter } from 'events';
import WebSocket from 'ws';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { HttpsProxyAgent } = require('https-proxy-agent');
import logger from './logger';

const WS_HEARTBEAT_INTERVAL_MS = 10_000;
const WS_STALE_TIMEOUT_MS = 45_000;
const WS_MAX_RECONNECT_DELAY_MS = 60_000;

/** Credentials required to authenticate on the user channel. */
export interface UserWsCreds {
  key: string;
  secret: string;
  passphrase: string;
}

/**
 * Connects to the Polymarket authenticated `/ws/user` WebSocket channel and
 * emits `fill` events when orders are matched.
 *
 * Events emitted:
 *   - 'fill' : { orderId, assetId, conditionId, price, size, side, feeRateBps }
 *   - 'connected' : WS opened and subscribed
 *   - 'disconnected' : WS closed
 */
export class UserWsManager extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private staleTimer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(
    private readonly wsHost: string,
    private readonly creds: UserWsCreds,
  ) {
    super();
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
    logger.info('[UserWS] Disconnected');
  }

  private openConnection(): void {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.terminate();
    }

    logger.info(`[UserWS] Connecting (attempt=${this.reconnectAttempt})...`);
    const proxyUrl = process.env.https_proxy ?? process.env.HTTPS_PROXY ?? process.env.http_proxy ?? process.env.HTTP_PROXY;
    const wsOptions = proxyUrl ? { agent: new HttpsProxyAgent(proxyUrl) } : {};
    const ws = new WebSocket(this.wsHost, wsOptions);
    this.ws = ws;

    ws.on('open', () => {
      logger.info('[UserWS] Connected');
      this.reconnectAttempt = 0;
      this.resetStaleTimer();
      this.startHeartbeat();
      this.sendSubscribe();
      this.emit('connected');
    });

    ws.on('message', (data: WebSocket.RawData) => {
      this.resetStaleTimer();
      try {
        const raw = data.toString();
        const msg = JSON.parse(raw);
        this.handleMessage(msg);
      } catch {
        // ignore parse errors
      }
    });

    ws.on('pong', () => {
      this.resetStaleTimer();
    });

    ws.on('close', (code, reason) => {
      logger.warn(`[UserWS] Closed code=${code} reason=${reason.toString()}`);
      this.clearTimers();
      this.emit('disconnected');
      if (!this.stopping) this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      logger.error('[UserWS] Error:', err.message);
      // close event will fire after error, triggering reconnect
    });
  }

  private sendSubscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // Polymarket user channel auth — send the API credentials in the auth block
    const msg = JSON.stringify({
      auth: {
        apiKey: this.creds.key,
        secret: this.creds.secret,
        passphrase: this.creds.passphrase,
      },
      type: 'subscribe',
      channel: 'user',
      markets: [],
      assets_ids: [],
    });
    this.ws.send(msg);
    logger.info('[UserWS] Subscribed to user channel');
  }

  private handleMessage(msg: any): void {
    // The user channel sends arrays of event objects:
    // [{ event_type: "fill", order_id, market, asset_id, price, size, side, ... }, ...]
    // It may also send other event types (order_placement, trade, etc.) — we only care about fills.

    const events: any[] = Array.isArray(msg) ? msg : [msg];

    for (const event of events) {
      if (!event || typeof event !== 'object') continue;
      const type = event.event_type ?? event.type;

      if (type === 'fill') {
        const orderId: string = event.order_id ?? '';
        const assetId: string = event.asset_id ?? '';
        const conditionId: string = event.market ?? '';
        const price = parseFloat(event.price) || 0;
        const size = parseFloat(event.size) || 0;
        const side: string = (event.side ?? '').toUpperCase();
        const feeRateBps = parseFloat(event.fee_rate_bps) || 0;

        if (!orderId || !assetId) continue;

        logger.info(
          `[UserWS] Fill: orderId=${orderId} assetId=${assetId.slice(0, 10)}… ` +
          `market=${conditionId.slice(0, 10)}… ${side} size=${size} @ ${price}`
        );

        this.emit('fill', { orderId, assetId, conditionId, price, size, side, feeRateBps });
      }
    }
  }

  private scheduleReconnect(): void {
    this.reconnectAttempt++;
    const delay = Math.min(Math.pow(2, this.reconnectAttempt - 1) * 1000, WS_MAX_RECONNECT_DELAY_MS);
    logger.info(`[UserWS] Reconnecting attempt=${this.reconnectAttempt} in ${delay}ms`);
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
      logger.warn('[UserWS] Stale connection detected, terminating for reconnect');
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
