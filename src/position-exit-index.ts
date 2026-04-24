import * as dotenv from 'dotenv';
import {
  getCurrentPositionForMarket,
  getPositionsUserAddress,
  initClient,
  stopHeartbeat,
} from './client';
import { resolveMarketIds } from './config';
import logger from './logger';
import { PositionExitManager } from './position-exit-manager';
import { ManagedPosition, MarketConfig } from './types';
import { WsManager } from './ws-manager';

dotenv.config();

const POSITION_EXIT_CONFIG = {
  // Set one or more Polymarket market URLs here before running the script.
  marketUrls: [
    'https://polymarket.com/event/what-will-be-said-on-iceman/will-no-no-no-be-said-on-iceman',
    'https://polymarket.com/event/lol-lcp-2026-split-2-winner/will-fukuoka-softbank-hawks-gaming-win-lcp-2026-split-2'
  ] as string[],
};

async function main(): Promise<void> {
  const marketUrls = normalizeMarketUrls(POSITION_EXIT_CONFIG.marketUrls);
  const privateKey = process.env.PRIVATE_KEY;
  const chainId = parseInt(process.env.CHAIN_ID ?? '137', 10);
  const clobHost = process.env.CLOB_HOST ?? 'https://clob.polymarket.com';
  const wsHost = process.env.POSITION_EXIT_WS_HOST ?? 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

  if (marketUrls.length === 0) {
    throw new Error('[PositionExitMain] POSITION_EXIT_CONFIG.marketUrls is empty');
  }
  if (!privateKey) {
    throw new Error('[PositionExitMain] PRIVATE_KEY not set in environment');
  }

  await initClient(clobHost, chainId, privateKey);

  const userAddress = getPositionsUserAddress(privateKey);
  const positions = await resolveManagedPositions(marketUrls, userAddress);

  if (positions.length === 0) {
    logger.info('[PositionExitMain] No open YES/NO positions found for configured markets');
    stopHeartbeat();
    process.exit(0);
  }

  const wsManager = new WsManager(wsHost);
  const exitManagers = positions.map(position => new PositionExitManager(position, wsManager));
  let remainingManagers = exitManagers.length;

  let stopInProgress = false;

  async function shutdown(reason: string, exitCode: number): Promise<void> {
    if (stopInProgress) return;
    stopInProgress = true;

    logger.warn(`[PositionExitMain] Stopping: ${reason}`);
    for (const exitManager of exitManagers) {
      exitManager.stop();
    }
    wsManager.disconnect();
    stopHeartbeat();
    process.exit(exitCode);
  }

  for (const exitManager of exitManagers) {
    exitManager.on('exitPlaced', (event) => {
      remainingManagers -= 1;
      logger.info(
        `[PositionExitMain] Exit order submitted orderId=${event.orderId} price=${event.price} ` +
        `size=${event.size} status=${event.status} remaining=${remainingManagers}`
      );

      if (remainingManagers > 0) {
        return;
      }

      shutdown('all-exits-submitted', 0).catch(err =>
        logger.error('[PositionExitMain] Failed to stop after exit placement:', err)
      );
    });

    exitManager.on('fatal', (err) => {
      shutdown(`fatal:${String(err)}`, 1).catch(stopErr =>
        logger.error('[PositionExitMain] Failed to stop after fatal error:', stopErr)
      );
    });

    exitManager.start();
  }

  process.on('SIGINT', () => {
    shutdown('SIGINT', 0).catch(err =>
      logger.error('[PositionExitMain] Failed to stop on SIGINT:', err)
    );
  });

  process.on('SIGTERM', () => {
    shutdown('SIGTERM', 0).catch(err =>
      logger.error('[PositionExitMain] Failed to stop on SIGTERM:', err)
    );
  });

  wsManager.connect();
  logger.info(
    `[PositionExitMain] Monitoring ${positions.length} open position(s) across ${marketUrls.length} market URL(s)`
  );
}

if (require.main === module) {
  main().catch(err => {
    logger.error('[PositionExitMain] Fatal error:', err);
    stopHeartbeat();
    process.exit(1);
  });
}

async function resolveManagedPositions(
  marketUrls: string[],
  userAddress: string,
): Promise<ManagedPosition[]> {
  const markets: MarketConfig[] = marketUrls.map(url => ({ url }));
  await resolveMarketIds(markets);

  const positions = await Promise.all(markets.map(async market => {
    if (!market.url || !market.condition_id || !market.yes_token_id || !market.no_token_id) {
      throw new Error(`[PositionExitMain] Failed to resolve market IDs from marketUrl: ${market.url ?? 'unknown'}`);
    }

    logger.info(
      `[PositionExitMain] Looking up positions user=${userAddress} market=${market.condition_id.slice(0, 10)}...`
    );

    return getCurrentPositionForMarket(
      userAddress,
      market.condition_id,
      market.yes_token_id,
      market.no_token_id,
    );
  }));

  return positions.filter((position): position is ManagedPosition => position !== null);
}

function normalizeMarketUrls(marketUrls: string[]): string[] {
  return [...new Set(marketUrls.map(url => url.trim()).filter(Boolean))];
}

export { POSITION_EXIT_CONFIG, main, normalizeMarketUrls, resolveManagedPositions };
