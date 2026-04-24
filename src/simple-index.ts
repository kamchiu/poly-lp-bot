import * as dotenv from 'dotenv';
import * as path from 'path';
import { loadConfig, resolveMarketConfig, resolveMarketIds } from './config';
import {
  cancelMarketOrders,
  getApiCreds,
  getOpenOrders,
  getTokenBalanceStrict,
  initClient,
  stopHeartbeat,
} from './client';
import { initNotifier } from './notifier';
import logger from './logger';
import { SimpleMarketMaker } from './simple-market-maker';
import { UserWsManager } from './user-ws-manager';
import { WsManager } from './ws-manager';

dotenv.config();

const STARTUP_INVENTORY_EPSILON = 1e-6;

async function main() {
  const configPath = path.resolve(process.cwd(), process.env.CONFIG_PATH ?? 'config.yaml');
  const appConfig = loadConfig(configPath);

  const privateKey = process.env.PRIVATE_KEY;
  const chainId = parseInt(process.env.CHAIN_ID ?? '137', 10);
  const clobHost = process.env.CLOB_HOST ?? 'https://clob.polymarket.com';

  if (!privateKey) {
    logger.error('[SimpleMain] PRIVATE_KEY not set in environment');
    process.exit(1);
  }

  await initClient(clobHost, chainId, privateKey);
  initNotifier();

  await resolveMarketIds(appConfig.markets);
  const resolvedMarkets = appConfig.markets.map(m =>
    resolveMarketConfig(m, appConfig.defaults)
  );

  for (const cfg of resolvedMarkets) {
    const shortId = cfg.condition_id.slice(0, 10);
    const openOrders = await getOpenOrders(cfg.condition_id);

    if (openOrders.length > 0) {
      logger.warn(
        `[SimpleMain] Startup reconcile: found ${openOrders.length} open order(s) in ${shortId}…, cancelling`
      );

      const cancelled = await cancelMarketOrders(cfg.condition_id);
      if (!cancelled) {
        throw new Error(`[SimpleMain] Startup reconcile failed for ${shortId}…: stale-order-cancel-failed`);
      }

      const remainingOrders = await getOpenOrders(cfg.condition_id);
      if (remainingOrders.length > 0) {
        throw new Error(
          `[SimpleMain] Startup reconcile failed for ${shortId}…: ${remainingOrders.length} open order(s) remain after cancel`
        );
      }
    }

    const [yesBalance, noBalance] = await Promise.all([
      getTokenBalanceStrict(cfg.yes_token_id),
      getTokenBalanceStrict(cfg.no_token_id),
    ]);

    if (yesBalance > STARTUP_INVENTORY_EPSILON || noBalance > STARTUP_INVENTORY_EPSILON) {
      throw new Error(
        `[SimpleMain] Startup reconcile failed for ${shortId}…: residual inventory yes=${yesBalance} no=${noBalance}`
      );
    }
  }

  logger.info('[SimpleMain] Startup reconcile passed');

  const wsManager = new WsManager(appConfig.defaults.ws_host);
  const tokenIds = resolvedMarkets.flatMap(m => [m.yes_token_id, m.no_token_id]);
  wsManager.subscribe(tokenIds);
  wsManager.connect();

  const userWsManager = new UserWsManager(appConfig.defaults.ws_user_host, getApiCreds(), {
    assetIds: tokenIds,
    conditionIds: resolvedMarkets.map(m => m.condition_id),
  });

  const makers = resolvedMarkets.map(cfg => {
    const maker = new SimpleMarketMaker(cfg, wsManager);
    maker.start();
    return maker;
  });

  let stopInProgress = false;
  let userWsAuthenticated = false;

  async function stopAll(reason: string, exitCode: number): Promise<void> {
    if (stopInProgress) return;
    stopInProgress = true;

    logger.warn(`[SimpleMain] Stopping all markets: ${reason}`);

    const shutdownResults = await Promise.allSettled(
      makers.map(maker => maker.shutdown(`stop:${reason}`))
    );

    let finalExitCode = exitCode;
    for (const result of shutdownResults) {
      if (result.status === 'rejected') {
        finalExitCode = 1;
        logger.error('[SimpleMain] Market shutdown failed:', result.reason);
        continue;
      }
      if (!result.value) {
        finalExitCode = 1;
      }
    }

    wsManager.disconnect();
    userWsManager.disconnect();
    stopHeartbeat();

    logger.info(`[SimpleMain] Stopped (exitCode=${finalExitCode})`);
    process.exit(finalExitCode);
  }

  userWsManager.on('connected', () => {
    userWsAuthenticated = true;
    logger.info('[SimpleMain] User WS authenticated');
  });

  userWsManager.on('disconnected', () => {
    const wasAuthenticated = userWsAuthenticated;
    userWsAuthenticated = false;
    if (!wasAuthenticated || stopInProgress) return;
    stopAll('user-ws-disconnected', 1).catch(err =>
      logger.error('[SimpleMain] Failed to stop after user WS disconnect:', err)
    );
  });

  userWsManager.on('authError', (err) => {
    userWsAuthenticated = false;
    stopAll(`user-ws-auth-error:${String(err)}`, 1).catch(error =>
      logger.error('[SimpleMain] Failed to stop after user WS auth error:', error)
    );
  });

  userWsManager.on('fill', fill => {
    const marketId = fill.conditionId ? fill.conditionId.slice(0, 10) : 'unknown';
    stopAll(`fill:${marketId}`, 0).catch(err =>
      logger.error('[SimpleMain] Failed to stop after fill:', err)
    );
  });

  userWsManager.connect();

  logger.info(`[SimpleMain] Started ${makers.length} simple market maker(s)`);

  process.on('SIGINT', () => {
    stopAll('SIGINT', 0).catch(err =>
      logger.error('[SimpleMain] Failed to stop on SIGINT:', err)
    );
  });
  process.on('SIGTERM', () => {
    stopAll('SIGTERM', 0).catch(err =>
      logger.error('[SimpleMain] Failed to stop on SIGTERM:', err)
    );
  });
}

main().catch(err => {
  logger.error('[SimpleMain] Fatal error:', err);
  process.exit(1);
});
