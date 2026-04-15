import * as dotenv from 'dotenv';
import * as path from 'path';
import { loadConfig, resolveMarketConfig, resolveMarketIds } from './config';
import { initClient, stopHeartbeat, cancelMarketOrders } from './client';
import { WsManager } from './ws-manager';
import { MarketMaker } from './market-maker';
import logger from './logger';

dotenv.config();

async function main() {
  // 1. Load configuration
  const configPath = path.resolve(process.cwd(), 'config.yaml');
  const appConfig = loadConfig(configPath);

  const privateKey = process.env.PRIVATE_KEY;
  const chainId = parseInt(process.env.CHAIN_ID ?? '137', 10);
  const clobHost = process.env.CLOB_HOST ?? 'https://clob.polymarket.com';

  if (!privateKey) {
    logger.error('PRIVATE_KEY not set in environment');
    process.exit(1);
  }

  // 2. Init REST client, derive API key, start heartbeat
  await initClient(clobHost, chainId, privateKey);

  // 3. Resolve market IDs from URLs (if any), then build per-market configs
  await resolveMarketIds(appConfig.markets);
  const resolvedMarkets = appConfig.markets.map(m =>
    resolveMarketConfig(m, appConfig.defaults)
  );

  // 4. Init WS manager and subscribe to all token IDs (YES + NO)
  const wsManager = new WsManager(appConfig.defaults.ws_host);
  const tokenIds = resolvedMarkets.flatMap(m => [m.yes_token_id, m.no_token_id]);
  wsManager.subscribe(tokenIds);
  wsManager.connect();

  // 5. Create and start a MarketMaker per market
  const makers = resolvedMarkets.map(cfg => {
    const mm = new MarketMaker(cfg, wsManager);
    mm.start();
    return { mm, cfg };
  });

  // 6. Cross-market fill coordination:
  //    When any market gets a fill, pause ALL other markets (cancel their orders)
  //    to free up capital for closing. Resume all after close completes.
  for (const { mm } of makers) {
    mm.positionMonitor.on('fillDetected', (filledConditionId: string) => {
      logger.info(`[Main] Fill detected in ${filledConditionId.slice(0, 10)}... — pausing other markets`);
      for (const { mm: other } of makers) {
        if (other.conditionId !== filledConditionId) {
          other.pause().catch(err =>
            logger.error(`[Main] Failed to pause ${other.conditionId.slice(0, 10)}...:`, err)
          );
        }
      }
    });

    mm.positionMonitor.on('closeComplete', () => {
      logger.info(`[Main] Close complete in ${mm.conditionId.slice(0, 10)}... — resuming all markets`);
      for (const { mm: other } of makers) {
        if (other.conditionId !== mm.conditionId) {
          other.resume();
        }
      }
    });
  }

  logger.info(`[Main] Started ${makers.length} market maker(s)`);

  // 6. Graceful shutdown
  async function shutdown(signal: string) {
    logger.info(`[Main] Received ${signal}, shutting down...`);

    // Stop timers
    makers.forEach(({ mm }) => mm.stop());

    // Cancel all open orders
    await Promise.allSettled(
      resolvedMarkets.map(cfg => cancelMarketOrders(cfg.condition_id))
    );

    // Disconnect WS and stop heartbeat
    wsManager.disconnect();
    stopHeartbeat();

    logger.info('[Main] Shutdown complete');
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  logger.error('[Main] Fatal error:', err);
  process.exit(1);
});
