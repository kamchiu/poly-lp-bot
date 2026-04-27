import { EventEmitter } from 'events';
import {
  cancelMarketOrders,
  getOpenOrders,
  getTokenBalanceStrict,
  stopHeartbeat,
} from './client';
import { resolveMarketConfig } from './config';
import logger from './logger';
import {
  buildMarketConfigEntry,
  scanMarkets,
  ScanMarketsOptions,
} from './market-scanner';
import { SimpleMarketMaker } from './simple-market-maker';
import { ResolvedMarketConfig, Defaults } from './types';
import { UserWsManager, UserWsCreds } from './user-ws-manager';
import { WsManager } from './ws-manager';

const INVENTORY_EPSILON = 1e-6;

export const SIMPLE_SCAN_INTERVAL_MS = 15 * 60 * 1000;
export const SIMPLE_RUNTIME_SCAN_OPTIONS: Readonly<ScanMarketsOptions> = {
  minDailyRate: 20,
  maxDailyRate: Number.POSITIVE_INFINITY,
  maxMinShares: 20,
  minVolume24h: 0,
  maxVolume24h: 200,
  minDaysToEvent: Number.NEGATIVE_INFINITY,
  minMid: 0,
  maxMid: 1,
  minBestBid: 0.1,
  maxBestBid: 0.9,
  minBestAsk: 0.1,
  maxBestAsk: 0.9,
  exactCompetitiveness: 0,
};

export interface SimpleMarketSupervisorWsManager {
  subscribe(tokenIds: string[]): void;
  connect(): void;
  disconnect(): void;
}

export interface SimpleMarketSupervisorMaker {
  conditionId: string;
  start(): void;
  shutdown(reason?: string): Promise<boolean>;
}

export interface SimpleMarketSupervisorUserWsManager extends EventEmitter {
  connect(): void;
  disconnect(): void;
}

interface SimpleMarketSupervisorDeps {
  scanMarkets(): Promise<ResolvedMarketConfig[]>;
  createWsManager(wsHost: string): SimpleMarketSupervisorWsManager;
  createUserWsManager(
    wsHost: string,
    creds: UserWsCreds,
    subscription: { assetIds: string[]; conditionIds: string[] }
  ): SimpleMarketSupervisorUserWsManager;
  createMaker(
    cfg: ResolvedMarketConfig,
    wsManager: SimpleMarketSupervisorWsManager
  ): SimpleMarketSupervisorMaker;
  getOpenOrders(conditionId: string): Promise<any[]>;
  cancelMarketOrders(conditionId: string): Promise<boolean>;
  getTokenBalanceStrict(tokenId: string): Promise<number>;
  stopHeartbeat(): void;
}

interface SimpleMarketSupervisorOptions {
  defaults: Defaults;
  creds: UserWsCreds;
  scanIntervalMs?: number;
  scanMarketCount?: number | null;
}

export function buildSimpleRuntimeScanOptions(
  scanMarketCount?: number | null
): ScanMarketsOptions {
  if (
    typeof scanMarketCount === 'number' &&
    Number.isFinite(scanMarketCount) &&
    scanMarketCount > 0
  ) {
    return {
      ...SIMPLE_RUNTIME_SCAN_OPTIONS,
      count: Math.floor(scanMarketCount),
    };
  }

  return { ...SIMPLE_RUNTIME_SCAN_OPTIONS };
}

function buildDefaultDeps(
  defaults: Defaults,
  scanMarketCount?: number | null
): SimpleMarketSupervisorDeps {
  const runtimeScanOptions = buildSimpleRuntimeScanOptions(scanMarketCount);

  return {
    scanMarkets: async () => {
      const scannedMarkets = await scanMarkets(runtimeScanOptions);
      return scannedMarkets.map(scanned =>
        resolveMarketConfig(buildMarketConfigEntry(scanned), defaults)
      );
    },
    createWsManager: (wsHost: string) => new WsManager(wsHost),
    createUserWsManager: (
      wsHost: string,
      creds: UserWsCreds,
      subscription: { assetIds: string[]; conditionIds: string[] }
    ) => new UserWsManager(wsHost, creds, subscription),
    createMaker: (
      cfg: ResolvedMarketConfig,
      wsManager: SimpleMarketSupervisorWsManager
    ) => new SimpleMarketMaker(cfg, wsManager as WsManager),
    getOpenOrders,
    cancelMarketOrders,
    getTokenBalanceStrict,
    stopHeartbeat,
  };
}

function shortId(conditionId: string): string {
  return conditionId.slice(0, 10);
}

export class SimpleMarketSupervisor extends EventEmitter {
  private readonly deps: SimpleMarketSupervisorDeps;
  private readonly scanIntervalMs: number;

  private refreshTimer: NodeJS.Timeout | null = null;
  private wsManager: SimpleMarketSupervisorWsManager | null = null;
  private userWsManager: SimpleMarketSupervisorUserWsManager | null = null;
  private makers = new Map<string, SimpleMarketSupervisorMaker>();
  private started = false;
  private stopping = false;
  private userWsAuthenticated = false;
  private mutationQueue: Promise<void> = Promise.resolve();

  private readonly onUserWsConnected = () => {
    this.userWsAuthenticated = true;
    logger.info('[SimpleSupervisor] User WS authenticated');
  };

  private readonly onUserWsDisconnected = () => {
    const wasAuthenticated = this.userWsAuthenticated;
    this.userWsAuthenticated = false;
    if (!wasAuthenticated || this.stopping) return;
    this.emit('fatal', 'user-ws-disconnected');
  };

  private readonly onUserWsAuthError = (err: unknown) => {
    this.userWsAuthenticated = false;
    if (this.stopping) return;
    this.emit('fatal', `user-ws-auth-error:${String(err)}`);
  };

  private readonly onUserWsFill = (fill: { conditionId?: string }) => {
    const conditionId = fill.conditionId ?? '';
    if (!conditionId || this.stopping) return;

    this.enqueueMutation(async () => {
      await this.removeFilledMarket(conditionId);
    }).catch(err =>
      logger.error(`[SimpleSupervisor] Failed to stop filled market ${shortId(conditionId)}…:`, err)
    );
  };

  constructor(
    private readonly options: SimpleMarketSupervisorOptions,
    deps?: Partial<SimpleMarketSupervisorDeps>
  ) {
    super();
    this.deps = {
      ...buildDefaultDeps(options.defaults, options.scanMarketCount),
      ...deps,
    };
    this.scanIntervalMs = options.scanIntervalMs ?? SIMPLE_SCAN_INTERVAL_MS;
  }

  async start(): Promise<void> {
    await this.enqueueMutation(async () => {
      if (this.started || this.stopping) return;
      this.started = true;
      await this.refreshFromScan('startup');
      this.scheduleNextRefresh();
    });
  }

  async shutdown(reason = 'shutdown'): Promise<boolean> {
    return this.enqueueMutation(async () => {
      if (this.stopping) return true;
      this.stopping = true;
      this.clearRefreshTimer();

      logger.warn(`[SimpleSupervisor] Shutting down: ${reason}`);

      const shutdownOk = await this.shutdownActiveMarkets(reason);
      this.disconnectManagers();
      this.deps.stopHeartbeat();

      return shutdownOk;
    });
  }

  private enqueueMutation<T>(task: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(task);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private scheduleNextRefresh(): void {
    if (this.stopping) return;

    this.clearRefreshTimer();
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.enqueueMutation(async () => {
        if (this.stopping) return;
        await this.refreshFromScan('interval');
      }).catch(err =>
        logger.error('[SimpleSupervisor] Interval refresh failed:', err)
      ).finally(() => {
        if (!this.stopping) this.scheduleNextRefresh();
      });
    }, this.scanIntervalMs);
  }

  private clearRefreshTimer(): void {
    if (!this.refreshTimer) return;
    clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
  }

  private async refreshFromScan(reason: string): Promise<void> {
    logger.info(`[SimpleSupervisor] Running market scan (${reason})`);

    let scannedMarkets: ResolvedMarketConfig[];
    try {
      scannedMarkets = await this.deps.scanMarkets();
      scannedMarkets = await this.filterInventoryCleanMarkets(scannedMarkets);
    } catch (err) {
      logger.error(`[SimpleSupervisor] market scan (${reason}) failed:`, err);
      return;
    }

    if (scannedMarkets.length === 0) {
      logger.warn(`[SimpleSupervisor] market scan (${reason}) returned no runnable markets; keeping current makers`);
      return;
    }

    await this.replaceActiveMarkets(scannedMarkets, reason);
  }

  private async filterInventoryCleanMarkets(
    scannedMarkets: ResolvedMarketConfig[]
  ): Promise<ResolvedMarketConfig[]> {
    const runnableMarkets: ResolvedMarketConfig[] = [];

    for (const cfg of scannedMarkets) {
      const [yesBalance, noBalance] = await Promise.all([
        this.deps.getTokenBalanceStrict(cfg.yes_token_id),
        this.deps.getTokenBalanceStrict(cfg.no_token_id),
      ]);

      if (yesBalance > INVENTORY_EPSILON || noBalance > INVENTORY_EPSILON) {
        logger.warn(
          `[SimpleSupervisor] Skipping ${shortId(cfg.condition_id)}… due to residual inventory ` +
          `yes=${yesBalance} no=${noBalance}`
        );
        continue;
      }

      runnableMarkets.push(cfg);
    }

    return runnableMarkets;
  }

  private async replaceActiveMarkets(
    nextMarkets: ResolvedMarketConfig[],
    reason: string
  ): Promise<void> {
    await this.shutdownActiveMarkets(`scan:${reason}`);
    this.disconnectManagers();

    if (this.stopping) return;

    const reconciledMarkets = await this.reconcileTargetMarkets(nextMarkets);
    if (reconciledMarkets.length === 0) {
      logger.warn('[SimpleSupervisor] No markets survived reconcile after refresh');
      return;
    }

    const tokenIds = reconciledMarkets.flatMap(cfg => [cfg.yes_token_id, cfg.no_token_id]);
    const conditionIds = reconciledMarkets.map(cfg => cfg.condition_id);

    const wsManager = this.deps.createWsManager(this.options.defaults.ws_host);
    wsManager.subscribe(tokenIds);
    wsManager.connect();
    this.wsManager = wsManager;

    const userWsManager = this.deps.createUserWsManager(
      this.options.defaults.ws_user_host,
      this.options.creds,
      { assetIds: tokenIds, conditionIds }
    );
    this.attachUserWsListeners(userWsManager);
    userWsManager.connect();
    this.userWsManager = userWsManager;

    for (const cfg of reconciledMarkets) {
      const maker = this.deps.createMaker(cfg, wsManager);
      maker.start();
      this.makers.set(cfg.condition_id, maker);
    }

    logger.info(`[SimpleSupervisor] Running ${this.makers.size} simple market maker(s)`);
  }

  private async reconcileTargetMarkets(
    markets: ResolvedMarketConfig[]
  ): Promise<ResolvedMarketConfig[]> {
    const reconciledMarkets: ResolvedMarketConfig[] = [];

    for (const cfg of markets) {
      const openOrders = await this.deps.getOpenOrders(cfg.condition_id);
      if (openOrders.length > 0) {
        logger.warn(
          `[SimpleSupervisor] Reconcile found ${openOrders.length} open order(s) in ${shortId(cfg.condition_id)}…, cancelling`
        );

        const cancelled = await this.deps.cancelMarketOrders(cfg.condition_id);
        if (!cancelled) {
          logger.warn(`[SimpleSupervisor] Reconcile cancel failed for ${shortId(cfg.condition_id)}…, skipping market`);
          continue;
        }

        const remainingOrders = await this.deps.getOpenOrders(cfg.condition_id);
        if (remainingOrders.length > 0) {
          logger.warn(
            `[SimpleSupervisor] Reconcile still sees ${remainingOrders.length} open order(s) in ` +
            `${shortId(cfg.condition_id)}…, skipping market`
          );
          continue;
        }
      }

      reconciledMarkets.push(cfg);
    }

    return reconciledMarkets;
  }

  private async shutdownActiveMarkets(reason: string): Promise<boolean> {
    const activeMakers = [...this.makers.values()];
    this.makers.clear();

    if (activeMakers.length === 0) return true;

    const results = await Promise.allSettled(
      activeMakers.map(maker => maker.shutdown(reason))
    );

    let shutdownOk = true;
    for (const result of results) {
      if (result.status === 'rejected') {
        shutdownOk = false;
        logger.error('[SimpleSupervisor] Market shutdown failed:', result.reason);
        continue;
      }

      if (!result.value) shutdownOk = false;
    }

    return shutdownOk;
  }

  private async removeFilledMarket(conditionId: string): Promise<void> {
    const maker = this.makers.get(conditionId);
    if (!maker) {
      logger.warn(`[SimpleSupervisor] Ignoring fill for inactive market ${shortId(conditionId)}…`);
      return;
    }

    this.makers.delete(conditionId);

    logger.warn(`[SimpleSupervisor] Fill detected in ${shortId(conditionId)}…; stopping that market until next scan`);
    const shutdownOk = await maker.shutdown(`fill:${shortId(conditionId)}`);
    if (!shutdownOk) {
      logger.warn(`[SimpleSupervisor] Filled market shutdown reported failure for ${shortId(conditionId)}…`);
    }
  }

  private attachUserWsListeners(userWsManager: SimpleMarketSupervisorUserWsManager): void {
    userWsManager.on('connected', this.onUserWsConnected);
    userWsManager.on('disconnected', this.onUserWsDisconnected);
    userWsManager.on('authError', this.onUserWsAuthError);
    userWsManager.on('fill', this.onUserWsFill);
  }

  private detachUserWsListeners(userWsManager: SimpleMarketSupervisorUserWsManager): void {
    userWsManager.off('connected', this.onUserWsConnected);
    userWsManager.off('disconnected', this.onUserWsDisconnected);
    userWsManager.off('authError', this.onUserWsAuthError);
    userWsManager.off('fill', this.onUserWsFill);
  }

  private disconnectManagers(): void {
    if (this.userWsManager) {
      this.detachUserWsListeners(this.userWsManager);
      this.userWsManager.disconnect();
      this.userWsManager = null;
    }

    if (this.wsManager) {
      this.wsManager.disconnect();
      this.wsManager = null;
    }

    this.userWsAuthenticated = false;
  }
}
