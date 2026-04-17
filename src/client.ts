import { ethers } from 'ethers';
import { ClobClient, Side, SignatureType, AssetType } from '@polymarket/clob-client';
import logger from './logger';

export interface MarketInfo {
  v: number;          // max_spread (blue line boundary)
  tick_size: number;
  rewards_daily_rate?: number;
}

let client: ClobClient;
let heartbeatTimer: NodeJS.Timeout;
let lastHeartbeatId: string | null = null;
let storedApiCreds: { key: string; secret: string; passphrase: string } | null = null;

export async function initClient(host: string, chainId: number, privateKey: string): Promise<void> {
  const signer = new ethers.Wallet(privateKey);
  const proxyAddress = process.env.POLYMARKET_PROXY_ADDRESS;

  // Step 1: L1-only client to derive API credentials
  const l1Client = new ClobClient(host, chainId, signer);
  const apiCreds = await l1Client.createOrDeriveApiKey();
  storedApiCreds = { key: apiCreds.key, secret: apiCreds.secret, passphrase: apiCreds.passphrase };
  logger.info('[Client] API credentials derived');

  // Step 2: Full client with correct signature type
  // - POLY_GNOSIS_SAFE (2): Web3 wallet login (OKX, MetaMask) — requires proxyAddress (Polymarket Profile Address)
  // - EOA (0): direct EOA login without proxy
  const sigType = proxyAddress ? SignatureType.POLY_GNOSIS_SAFE : SignatureType.EOA;
  client = new ClobClient(host, chainId, signer, apiCreds, sigType, proxyAddress);
  logger.info(`[Client] Using signatureType=${sigType} proxyAddress=${proxyAddress ?? 'none (EOA mode)'}`);

  // Log USDC balance and allowance so misconfigured accounts are caught early
  try {
    await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    const bal = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }) as any;
    logger.info(`[Client] Raw balance response: ${JSON.stringify(bal)}`);
  } catch (err) {
    logger.warn('[Client] Could not fetch balance/allowance:', err);
  }

  // Heartbeat: post every 5s to keep orders alive.
  // postHeartbeat() requires chaining: pass the previous heartbeat_id back each time.
  // If heartbeats lapse for 10s, the exchange auto-cancels all orders.
  heartbeatTimer = setInterval(async () => {
    try {
      const resp = await client.postHeartbeat(lastHeartbeatId);
      const r = resp as any;
      if (r.error || r.status >= 400) {
        // Chain broke — start a new one
        logger.warn(`[Client] Heartbeat chain invalid, restarting: ${JSON.stringify(r)}`);
        const fresh = await client.postHeartbeat();
        lastHeartbeatId = (fresh as any).heartbeat_id ?? null;
        logger.info(`[Client] New heartbeat chain: ${lastHeartbeatId}`);
      } else {
        lastHeartbeatId = r.heartbeat_id ?? lastHeartbeatId;
        logger.debug(`[Client] Heartbeat OK (id=${lastHeartbeatId})`);
      }
    } catch (err) {
      logger.error('[Client] Heartbeat FAILED:', err);
      // Try to restart chain on next tick
      lastHeartbeatId = null;
    }
  }, 5000);
}

export function stopHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
}

/** Returns the API credentials derived during initClient. Throws if called before initClient. */
export function getApiCreds(): { key: string; secret: string; passphrase: string } {
  if (!storedApiCreds) throw new Error('[Client] getApiCreds called before initClient');
  return storedApiCreds;
}

export async function getMarketInfo(conditionId: string, fallbackV: number): Promise<MarketInfo> {
  try {
    const market = await client.getMarket(conditionId);
    const m = market as any;
    const tick_size = parseFloat(m.minimum_tick_size) || 0.01;

    // max_spread comes from the rewards API, not getMarket
    let v = fallbackV;
    let rewards_daily_rate: number | undefined;
    try {
      const rewardsData = await (client as any).getRawRewardsForMarket(conditionId);
      const reward = Array.isArray(rewardsData) ? rewardsData[0] : rewardsData;
      if (reward?.rewards_max_spread) {
        // rewards_max_spread is in percentage (e.g. 5.5 means 5.5% = 0.055)
        v = reward.rewards_max_spread / 100;
      }
      rewards_daily_rate = reward?.rewards_config?.[0]?.rate_per_day;
    } catch {
      // rewards API not available, use fallback
    }

    logger.info(`[Client] getMarketInfo: v=${v} tick_size=${tick_size} rewards_daily_rate=${rewards_daily_rate}`);
    return { v, tick_size, rewards_daily_rate };
  } catch (err) {
    logger.warn(`[Client] getMarketInfo failed for ${conditionId}, using fallback:`, err);
    return { v: fallbackV, tick_size: 0.01 };
  }
}

export async function getRestMid(tokenId: string): Promise<number | null> {
  try {
    const [bidResp, askResp] = await Promise.all([
      client.getPrice(tokenId, 'BUY'),
      client.getPrice(tokenId, 'SELL'),
    ]);
    logger.info(`[Client] getRestMid token=${tokenId.slice(0, 10)}... bid=${JSON.stringify(bidResp)} ask=${JSON.stringify(askResp)}`);
    const bestBid = parseFloat((bidResp as any).price);
    const bestAsk = parseFloat((askResp as any).price);
    if (!isFinite(bestBid) || !isFinite(bestAsk) || bestBid <= 0 || bestAsk <= 0 || bestBid >= bestAsk) return null;
    return (bestBid + bestAsk) / 2;
  } catch (err) {
    logger.info(`[Client] getRestMid unavailable for token ${tokenId.slice(0, 10)}...:`, err);
    return null;
  }
}

export async function getOpenOrders(conditionId: string): Promise<any[]> {
  const resp = await client.getOpenOrders({ market: conditionId } as any);
  return Array.isArray(resp) ? resp : [];
}

export async function cancelMarketOrders(conditionId: string): Promise<void> {
  try {
    await client.cancelMarketOrders({ market: conditionId } as any);
    logger.info(`[Client] Cancelled orders for market ${conditionId.slice(0, 10)}...`);
  } catch (err) {
    logger.warn(`[Client] cancelMarketOrders failed for ${conditionId}:`, err);
  }
}

export async function placeLimitOrder(
  side: 'BUY' | 'SELL',
  price: number,
  size: number,
  tokenId: string
): Promise<string | null> {
  try {
    const order = await client.createOrder({
      tokenID: tokenId,
      price,
      side: side === 'BUY' ? Side.BUY : Side.SELL,
      size,
    });
    const resp = await client.postOrder(order, 'GTC' as any);
    const r = resp as any;
    logger.info(`[Client] postOrder response ${side}@${price}: ${JSON.stringify(r)}`);
    if (r.error) {
      const msg = r.error ?? r.errorMsg ?? 'unknown error';
      logger.warn(`[Client] placeLimitOrder rejected ${side}@${price}: ${msg} (status=${r.status})`);
      return null;
    }
    const orderId = r.orderID ?? r.order_id ?? 'unknown';
    logger.info(`[Client] Placed ${side} @ ${price} size=${size} token=${tokenId.slice(0, 10)}... → orderId=${orderId}`);
    return orderId;
  } catch (err) {
    logger.warn(`[Client] placeLimitOrder failed ${side}@${price}:`, err);
    return null;
  }
}

export interface OrderStatus {
  sizeMatched: number;
  originalSize: number;
  status: string;
  price: number;
  assetId: string;
}

export async function getOrderStatus(orderId: string): Promise<OrderStatus | null> {
  try {
    const order = await client.getOrder(orderId);
    const o = order as any;
    return {
      sizeMatched: parseFloat(o.size_matched) || 0,
      originalSize: parseFloat(o.original_size) || 0,
      status: o.status ?? '',
      price: parseFloat(o.price) || 0,
      assetId: o.asset_id ?? '',
    };
  } catch (err) {
    logger.warn(`[Client] getOrderStatus failed for ${orderId}:`, err);
    return null;
  }
}

export async function cancelOrder(orderId: string): Promise<void> {
  try {
    await client.cancelOrder({ orderID: orderId });
    logger.info(`[Client] Cancelled order ${orderId}`);
  } catch (err) {
    logger.warn(`[Client] cancelOrder failed for ${orderId}:`, err);
  }
}

export async function getTokenBalance(tokenId: string): Promise<number> {
  try {
    await client.updateBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: tokenId });
    const bal = await client.getBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: tokenId }) as any;
    const balance = parseFloat(bal.balance) || 0;
    logger.debug(`[Client] Token balance for ${tokenId.slice(0, 10)}...: ${balance}`);
    return balance;
  } catch (err) {
    logger.warn(`[Client] getTokenBalance failed for ${tokenId}:`, err);
    return 0;
  }
}
