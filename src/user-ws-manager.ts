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
 *   - 'fill' : { orderId, assetId, conditionId, price, size, side, feeRateBps, source }
 *   - 'connected' : WS opened and subscribed
 *   - 'disconnected' : WS closed
 */
export class UserWsManager extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private staleTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private authenticated = false;
  private readonly assetIds: string[];
  private readonly conditionIds: string[];

  constructor(
    private readonly wsHost: string,
    private readonly creds: UserWsCreds,
    subscription?: {
      /** Asset token IDs we want trade/maker fills for (e.g. YES+NO tokens). */
      assetIds?: string[];
      /** CLOB condition IDs (markets) we want trade/maker fills for. */
      conditionIds?: string[];
    }
  ) {
    super();
    this.assetIds = subscription?.assetIds ?? [];
    this.conditionIds = subscription?.conditionIds ?? [];
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
    this.authenticated = false;
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
      this.authenticated = false;
      this.resetStaleTimer();
      this.startHeartbeat();
      this.sendSubscribe();
    });

    ws.on('message', (data: WebSocket.RawData) => {
      this.resetStaleTimer();
      let raw: string;
      try {
        raw = data.toString();
      } catch (err) {
        logger.warn('[UserWS] Failed to convert message to string:', err);
        return;
      }

      // Polymarket sends "PONG" as a plain string in response to "PING"
      if (raw === 'PONG') {
        logger.debug('[UserWS] Received PONG');
        return;
      }

      let msg: unknown;
      try {
        msg = JSON.parse(raw);
      } catch (err) {
        logger.warn(`[UserWS] JSON parse error: ${(err as Error).message} — raw bytes: ${raw.slice(0, 200)}`);
        return;
      }

      this.handleMessage(msg);
    });

    ws.on('close', (code, reason) => {
      logger.warn(`[UserWS] Closed code=${code} reason=${reason.toString()}`);
      this.clearTimers();
      this.authenticated = false;
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

    // Polymarket user channel: type must be 'user'
    // markets is optional — omit to receive all user events, or pass condition IDs to filter
    const msg = JSON.stringify({
      auth: {
        apiKey: this.creds.key,
        secret: this.creds.secret,
        passphrase: this.creds.passphrase,
      },
      type: 'user',
      markets: this.conditionIds.length > 0 ? this.conditionIds : undefined,
    });
    this.ws.send(msg);
    logger.info(`[UserWS] Subscribe request sent (markets=${this.conditionIds.length || 'all'})`);
  }

  private handleMessage(msg: unknown): void {
    // Server sends a single JSON object per event (not an array).
    // Control messages: { type: 'subscribed' }, { type: 'error', ... }
    // Trade events:    { event_type: 'trade', type: 'TRADE', maker_orders: [...], ... }

    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      logger.debug(`[UserWS] Unexpected message shape: ${JSON.stringify(msg).slice(0, 200)}`);
      return;
    }

    const ev = msg as Record<string, unknown>;
    const eventType = (ev['event_type'] ?? ev['type']) as string | undefined;

    // Some payloads may omit/rename event_type but still include maker_orders.
    // We prefer structural detection to avoid missing fills.
    if (Array.isArray(ev['maker_orders'])) {
      this.handleTradeEvent(ev);
      return;
    }

    // Auth / heartbeat control messages
    if (eventType === 'subscribed') {
      logger.info('[UserWS] Auth confirmed — subscribed to user channel');
      this.authenticated = true;
      this.emit('connected');
      return;
    }
    if (eventType === 'error') {
      const errMsg = ev['message'] ?? ev['error'] ?? JSON.stringify(ev);
      logger.error(`[UserWS] Server returned error: ${errMsg}`);
      this.authenticated = false;
      this.emit('authError', errMsg);
      return;
    }

    // Trade event
    if (eventType === 'trade' || eventType === 'TRADE') {
      this.handleTradeEvent(ev);
      return;
    }

    // Everything else (order placement, cancellation, etc.)
    logger.debug(`[UserWS] Ignoring event_type=${String(eventType)} — ${JSON.stringify(ev).slice(0, 200)}`);
  }

  private handleTradeEvent(trade: Record<string, unknown>): void {
    const conditionId = (trade['market'] as string) ?? '';
    const traderSide = ((trade['trader_side'] as string) ?? '').toUpperCase();
    const makerOrders = trade['maker_orders'];

    if (traderSide === 'TAKER') {
      const orderId = (trade['taker_order_id'] as string) ?? '';
      const assetId = (trade['asset_id'] as string) ?? '';
      const price = parseFloat(trade['price'] as string) || 0;
      const size = parseFloat(trade['size'] as string) || 0;
      const side = ((trade['side'] as string) ?? '').toUpperCase();
      const feeRateBps = parseFloat(trade['fee_rate_bps'] as string) || 0;
      const eventKey = [
        String(trade['id'] ?? ''),
        String(trade['transaction_hash'] ?? trade['tx_hash'] ?? ''),
        String(trade['timestamp'] ?? trade['match_time'] ?? ''),
        conditionId,
        orderId,
        assetId,
        side,
        String(trade['price'] ?? ''),
        String(trade['size'] ?? ''),
      ].join('|');

      if (!orderId || !assetId) {
        logger.warn(
          `[UserWS] taker trade missing taker_order_id or asset_id — dropping: ${JSON.stringify(trade).slice(0, 200)}`
        );
        return;
      }

      this.emitFill({
        role: 'TAKER',
        source: 'user-ws',
        orderId,
        assetId,
        conditionId,
        price,
        size,
        side,
        feeRateBps,
        eventKey,
      });
      return;
    }

    if (!Array.isArray(makerOrders) || makerOrders.length === 0) {
      logger.debug(`[UserWS] Trade event has no maker_orders — ${JSON.stringify(trade).slice(0, 200)}`);
      return;
    }

    for (const mo of makerOrders) {
      if (!mo || typeof mo !== 'object') continue;
      const m = mo as Record<string, unknown>;

      const orderId = (m['order_id'] as string) ?? '';
      const assetId = (m['asset_id'] as string) ?? '';
      const price = parseFloat(m['price'] as string) || 0;
      const size = parseFloat(m['matched_amount'] as string) || 0;
      const side = ((m['side'] as string) ?? '').toUpperCase();
      const feeRateBps = parseFloat(m['fee_rate_bps'] as string) || 0;
      const eventKey = [
        String(trade['id'] ?? ''),
        String(trade['transaction_hash'] ?? trade['tx_hash'] ?? ''),
        String(trade['timestamp'] ?? trade['match_time'] ?? ''),
        String(m['id'] ?? m['trade_id'] ?? ''),
        String(m['transaction_hash'] ?? m['tx_hash'] ?? ''),
        String(m['match_time'] ?? m['timestamp'] ?? ''),
        conditionId,
        orderId,
        assetId,
        side,
        String(m['price'] ?? ''),
        String(m['matched_amount'] ?? ''),
      ].join('|');

      if (!orderId || !assetId) {
        logger.warn(
          `[UserWS] maker_order missing order_id or asset_id — dropping: ${JSON.stringify(m).slice(0, 200)}`
        );
        continue;
      }

      this.emitFill({
        role: 'MAKER',
        source: 'user-ws',
        orderId,
        assetId,
        conditionId,
        price,
        size,
        side,
        feeRateBps,
        eventKey,
      });
    }
  }

  private emitFill(fill: {
    role: 'TAKER' | 'MAKER';
    source: string;
    orderId: string;
    assetId: string;
    conditionId: string;
    price: number;
    size: number;
    side: string;
    feeRateBps: number;
    eventKey: string;
  }): void {
    logger.info(
      `[UserWS] Fill: source=${fill.source} role=${fill.role} orderId=${fill.orderId.slice(0, 10)}… assetId=${fill.assetId.slice(0, 10)}… ` +
      `market=${fill.conditionId.slice(0, 10)}… ${fill.side} size=${fill.size} @ ${fill.price}`
    );

    this.emit('fill', fill);
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
        // Polymarket requires application-level "PING" string, not WebSocket ping frame
        this.ws.send('PING');
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
