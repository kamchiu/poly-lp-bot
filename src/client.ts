import { ethers } from 'ethers';
import { ClobClient, Side, SignatureType } from '@polymarket/clob-client';
import logger from './logger';

export interface MarketInfo {
  v: number;          // max_spread (blue line boundary)
  tick_size: number;
  rewards_daily_rate?: number;
}

let client: ClobClient;
let heartbeatTimer: NodeJS.Timeout;

export async function initClient(host: string, chainId: number, privateKey: string): Promise<void> {
  const signer = new ethers.Wallet(privateKey);

  // Step 1: L1-only client to derive API credentials
  const l1Client = new ClobClient(host, chainId, signer);
  const apiCreds = await l1Client.createOrDeriveApiKey();
  logger.info('[Client] API credentials derived');

  // Step 2: Full client with L2 auth credentials
  client = new ClobClient(host, chainId, signer, apiCreds, SignatureType.EOA);

  // Heartbeat: post every 5s to keep orders alive
  heartbeatTimer = setInterval(async () => {
    try {
      await client.postHeartbeat();
    } catch (err) {
      logger.warn('[Client] Heartbeat failed:', err);
    }
  }, 5000);
}

export function stopHeartbeat(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
}

export async function getMarketInfo(conditionId: string, fallbackV: number): Promise<MarketInfo> {
  try {
    const market = await client.getMarket(conditionId);
    const v = (market as any).max_spread ?? fallbackV;
    const tick_size = (market as any).minimum_tick_size ?? 0.01;
    const rewards_daily_rate = (market as any).rewards_daily_rate;
    return { v, tick_size, rewards_daily_rate };
  } catch (err) {
    logger.warn(`[Client] getMarketInfo failed for ${conditionId}, using fallback:`, err);
    return { v: fallbackV, tick_size: 0.01 };
  }
}

export async function getRestMid(tokenId: string): Promise<number | null> {
  try {
    const book = await client.getOrderBook(tokenId);
    const bids: Array<{ price: string; size: string }> = (book as any).bids ?? [];
    const asks: Array<{ price: string; size: string }> = (book as any).asks ?? [];
    if (bids.length === 0 || asks.length === 0) return null;
    const bestBid = Math.max(...bids.map(b => parseFloat(b.price)));
    const bestAsk = Math.min(...asks.map(a => parseFloat(a.price)));
    if (bestBid <= 0 || bestAsk <= 0 || bestBid >= bestAsk) return null;
    return (bestBid + bestAsk) / 2;
  } catch (err) {
    logger.warn(`[Client] getRestMid failed for token ${tokenId}:`, err);
    return null;
  }
}

export async function cancelMarketOrders(conditionId: string): Promise<void> {
  try {
    await client.cancelMarketOrders({ market: conditionId } as any);
    logger.debug(`[Client] Cancelled orders for market ${conditionId.slice(0, 10)}...`);
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
    const orderId = (resp as any).orderID ?? (resp as any).order_id ?? 'unknown';
    logger.debug(`[Client] Placed ${side} @ ${price} size=${size} → orderId=${orderId}`);
    return orderId;
  } catch (err) {
    logger.warn(`[Client] placeLimitOrder failed ${side}@${price}:`, err);
    return null;
  }
}
