import * as dotenv from 'dotenv';
import * as path from 'path';
import { loadConfig, resolveMarketConfig, resolveMarketIds } from './config';
import { initClient, stopHeartbeat, cancelMarketOrders, getApiCreds, getOpenOrders, getTokenBalanceStrict } from './client';
import { WsManager } from './ws-manager';
import { UserWsManager } from './user-ws-manager';
import { MarketMaker } from './market-maker';
import { initNotifier } from './notifier';
import logger from './logger';

dotenv.config();

const STARTUP_INVENTORY_EPSILON = 1e-6;

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

  // 3. Init Telegram notifier (silent no-op if env vars not set)
  initNotifier();

  // 3. Resolve market IDs from URLs (if any), then build per-market configs
  await resolveMarketIds(appConfig.markets);
  const resolvedMarkets = appConfig.markets.map(m =>
    resolveMarketConfig(m, appConfig.defaults)
  );

  for (const cfg of resolvedMarkets) {
    const shortId = cfg.condition_id.slice(0, 10);
    const openOrders = await getOpenOrders(cfg.condition_id);

    if (openOrders.length > 0) {
      logger.warn(
        `[Main] Startup reconcile: found ${openOrders.length} open order(s) in ${shortId}…, cancelling before start`
      );

      const cancelled = await cancelMarketOrders(cfg.condition_id);
      if (!cancelled) {
        throw new Error(`[Main] Startup reconcile failed for ${shortId}…: stale-order-cancel-failed`);
      }

      const remainingOrders = await getOpenOrders(cfg.condition_id);
      if (remainingOrders.length > 0) {
        throw new Error(
          `[Main] Startup reconcile failed for ${shortId}…: ${remainingOrders.length} open order(s) remain after cancel`
        );
      }
    }

    const [yesBalance, noBalance] = await Promise.all([
      getTokenBalanceStrict(cfg.yes_token_id),
      getTokenBalanceStrict(cfg.no_token_id),
    ]);

    if (yesBalance > STARTUP_INVENTORY_EPSILON || noBalance > STARTUP_INVENTORY_EPSILON) {
      throw new Error(
        `[Main] Startup reconcile failed for ${shortId}…: residual inventory yes=${yesBalance} no=${noBalance}`
      );
    }
  }

  logger.info('[Main] Startup reconcile passed');

  // 4. Init WS manager and subscribe to all token IDs (YES + NO)
  const wsManager = new WsManager(appConfig.defaults.ws_host);
  const tokenIds = resolvedMarkets.flatMap(m => [m.yes_token_id, m.no_token_id]);
  wsManager.subscribe(tokenIds);
  wsManager.connect();

  // 4b. Init authenticated user WS (fill events)
  const userWsManager = new UserWsManager(appConfig.defaults.ws_user_host, getApiCreds(), {
    // Subscribe only to markets/assets we actively quote.
    assetIds: tokenIds,
    conditionIds: resolvedMarkets.map(m => m.condition_id),
  });

  // 5. Create and start a MarketMaker per market
  const makers = resolvedMarkets.map(cfg => {
    const mm = new MarketMaker(cfg, wsManager, userWsManager);
    mm.start();
    return { mm, cfg };
  });

  let started = true;
  let riskPaused = false;
  let shuttingDown = false;
  let userWsAuthenticated = false;

  async function pauseAllForRisk(reason: string): Promise<void> {
    if (shuttingDown || riskPaused) return;
    riskPaused = true;

    logger.error(`[Main] Entering risk pause: ${reason}`);
    await Promise.allSettled(
      makers.map(({ mm }) => mm.pauseForRisk(reason))
    );
  }

  userWsManager.on('connected', () => {
    if (!userWsAuthenticated) {
      userWsAuthenticated = true;
      logger.info('[Main] User WS authenticated');
      return;
    }

    if (riskPaused) {
      logger.warn('[Main] User WS reconnected during risk pause — manual intervention required');
      return;
    }

    logger.info('[Main] User WS reconnected');
  });

  userWsManager.on('disconnected', () => {
    userWsAuthenticated = false;
    if (started) {
      pauseAllForRisk('user-ws-disconnected').catch(err =>
        logger.error('[Main] Failed to enter risk pause after user WS disconnect:', err)
      );
    }
  });

  userWsManager.on('authError', (err) => {
    pauseAllForRisk(`user-ws-auth-error: ${String(err)}`).catch(error =>
      logger.error('[Main] Failed to enter risk pause after user WS auth error:', error)
    );
  });

  userWsManager.connect();

  // 6. Cross-market fill coordination:
  //    When any market fills, pause ALL markets (including the filled one) to free
  //    up capital for the close order. Resume all after the close completes.
  for (const { mm } of makers) {
    mm.positionMonitor.on('fillDetected', (filledConditionId: string) => {
      logger.info(`[Main] Fill in ${filledConditionId.slice(0, 10)}… — pausing ALL markets`);
      const pausePromises: Array<Promise<boolean>> = [];
      for (const { mm: other } of makers) {
        if (other.conditionId === filledConditionId) {
          // This market's LP order filled — keep PositionMonitor WS listener alive
          // so it can detect the close order fill. Only stop quoting timers.
          other.pauseForClose();
        } else {
          pausePromises.push(other.pause());
        }
      }

      if (pausePromises.length === 0) return;

      Promise.allSettled(pausePromises)
        .then(results => {
          const pauseFailed = results.some(result =>
            result.status === 'rejected' || !result.value
          );

          if (!pauseFailed) return;

          return pauseAllForRisk(`cross-market-pause-failed:${filledConditionId.slice(0, 10)}`);
        })
        .catch(err =>
          logger.error(
            `[Main] Failed while pausing peer markets after fill in ${filledConditionId.slice(0, 10)}…:`,
            err
          )
        );
    });

    mm.positionMonitor.on('closeComplete', () => {
      if (riskPaused) {
        logger.warn(`[Main] Close complete in ${mm.conditionId.slice(0, 10)}… but risk pause is active`);
        return;
      }
      logger.info(`[Main] Close complete in ${mm.conditionId.slice(0, 10)}… — resuming ALL markets`);
      for (const { mm: other } of makers) {
        other.resume();
      }
    });

    mm.positionMonitor.on('closeFailed', (reason: string) => {
      pauseAllForRisk(`close-failed:${mm.conditionId.slice(0, 10)}:${reason}`).catch(err =>
        logger.error(`[Main] Failed to enter risk pause after close failure in ${mm.conditionId.slice(0, 10)}…:`, err)
      );
    });
  }

  logger.info(`[Main] Started ${makers.length} market maker(s)`);

  // 6. Graceful shutdown
  async function shutdown(signal: string) {
    logger.info(`[Main] Received ${signal}, shutting down...`);
    shuttingDown = true;

    const shutdownResults = await Promise.allSettled(
      makers.map(async ({ mm }) => ({
        conditionId: mm.conditionId,
        result: await mm.shutdown(),
      }))
    );

    let exitCode = 0;
    for (const outcome of shutdownResults) {
      if (outcome.status === 'rejected') {
        exitCode = 1;
        logger.error('[Main] Market maker shutdown failed:', outcome.reason);
        continue;
      }

      if (!outcome.value.result.safeToExit) {
        exitCode = 1;
        logger.error(
          `[Main] Unsafe shutdown for ${outcome.value.conditionId.slice(0, 10)}…: ${outcome.value.result.reason}`
        );
      }
    }

    // Disconnect WS and stop heartbeat
    wsManager.disconnect();
    userWsManager.disconnect();
    stopHeartbeat();

    logger.info(`[Main] Shutdown complete (exitCode=${exitCode})`);
    process.exit(exitCode);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  logger.error('[Main] Fatal error:', err);
  process.exit(1);
});
