import * as dotenv from 'dotenv';
import * as path from 'path';
import { loadConfig } from './config';
import { getApiCreds, initClient } from './client';
import { initNotifier } from './notifier';
import logger from './logger';
import { SimpleMarketSupervisor } from './simple-market-supervisor';

dotenv.config();

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

  const supervisor = new SimpleMarketSupervisor({
    defaults: appConfig.defaults,
    creds: getApiCreds(),
  });

  let stopInProgress = false;

  async function stopAll(reason: string, exitCode: number): Promise<void> {
    if (stopInProgress) return;
    stopInProgress = true;

    logger.warn(`[SimpleMain] Stopping simple supervisor: ${reason}`);

    const shutdownOk = await supervisor.shutdown(`stop:${reason}`);
    const finalExitCode = shutdownOk ? exitCode : 1;

    logger.info(`[SimpleMain] Stopped (exitCode=${finalExitCode})`);
    process.exit(finalExitCode);
  }

  supervisor.on('fatal', (reason: string) => {
    stopAll(reason, 1).catch(err =>
      logger.error('[SimpleMain] Failed to stop after fatal supervisor event:', err)
    );
  });

  await supervisor.start();
  logger.info('[SimpleMain] Started simple market supervisor');

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
