import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig, resolveMarketConfig } from '../config';
import { AppConfig } from '../types';

// ─── helpers ─────────────────────────────────────────────────────────────────

function writeTempYaml(content: string): string {
  const file = path.join(os.tmpdir(), `pm-lp-test-${Date.now()}.yaml`);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

const MINIMAL_YAML = `
defaults:
  spread_factor: 0.8
  refresh_interval_ms: 180000
  drift_threshold_factor: 0.15
  ws_host: wss://example.com/ws/

markets:
  - condition_id: "0xABC"
    yes_token_id: "TOKEN1"
    no_token_id: "TOKEN2"
    min_size: 50
    fallback_v: 0.05
`;

// ─── loadConfig ──────────────────────────────────────────────────────────────

describe('loadConfig', () => {
  it('parses a valid YAML file and returns AppConfig shape', () => {
    const file = writeTempYaml(MINIMAL_YAML);
    const cfg = loadConfig(file);
    expect(cfg.defaults.spread_factor).toBe(0.8);
    expect(cfg.defaults.ws_host).toBe('wss://example.com/ws/');
    expect(cfg.markets).toHaveLength(1);
    expect(cfg.markets[0].condition_id).toBe('0xABC');
    fs.unlinkSync(file);
  });

  it('parses multiple markets', () => {
    const yaml = MINIMAL_YAML + `
  - condition_id: "0xDEF"
    yes_token_id: "TOKEN2"
    min_size: 100
    fallback_v: 0.03
`;
    const file = writeTempYaml(yaml);
    const cfg = loadConfig(file);
    expect(cfg.markets).toHaveLength(2);
    expect(cfg.markets[1].condition_id).toBe('0xDEF');
    fs.unlinkSync(file);
  });

  it('throws when file does not exist', () => {
    expect(() => loadConfig('/nonexistent/path/config.yaml')).toThrow();
  });
});

// ─── resolveMarketConfig ─────────────────────────────────────────────────────

describe('resolveMarketConfig', () => {
  const defaults: AppConfig['defaults'] = {
    spread_factor: 0.8,
    refresh_interval_ms: 180000,
    drift_threshold_factor: 0.15,
    ws_host: 'wss://example.com/ws/',
  };

  const baseMarket: AppConfig['markets'][0] = {
    condition_id: '0xABC',
    yes_token_id: 'TOKEN1',
    no_token_id: 'TOKEN2',
    min_size: 50,
    fallback_v: 0.05,
  };

  it('uses defaults when market has no overrides', () => {
    const resolved = resolveMarketConfig(baseMarket, defaults);
    expect(resolved.spread_factor).toBe(0.8);
    expect(resolved.refresh_interval_ms).toBe(180000);
    expect(resolved.drift_threshold_factor).toBe(0.15);
    expect(resolved.ws_host).toBe('wss://example.com/ws/');
  });

  it('copies required market fields verbatim', () => {
    const resolved = resolveMarketConfig(baseMarket, defaults);
    expect(resolved.condition_id).toBe('0xABC');
    expect(resolved.yes_token_id).toBe('TOKEN1');
    expect(resolved.min_size).toBe(50);
    expect(resolved.fallback_v).toBe(0.05);
  });

  it('per-market spread_factor overrides default', () => {
    const resolved = resolveMarketConfig(
      { ...baseMarket, spread_factor: 0.75 },
      defaults
    );
    expect(resolved.spread_factor).toBe(0.75);
  });

  it('per-market refresh_interval_ms overrides default', () => {
    const resolved = resolveMarketConfig(
      { ...baseMarket, refresh_interval_ms: 60000 },
      defaults
    );
    expect(resolved.refresh_interval_ms).toBe(60000);
  });

  it('per-market drift_threshold_factor overrides default', () => {
    const resolved = resolveMarketConfig(
      { ...baseMarket, drift_threshold_factor: 0.25 },
      defaults
    );
    expect(resolved.drift_threshold_factor).toBe(0.25);
  });

  it('all fields resolved to Required<MarketConfig> — no undefined values', () => {
    const resolved = resolveMarketConfig(baseMarket, defaults);
    const fields: (keyof typeof resolved)[] = [
      'condition_id', 'yes_token_id', 'no_token_id', 'min_size', 'fallback_v',
      'spread_factor', 'refresh_interval_ms',
      'drift_threshold_factor', 'ws_host',
    ];
    for (const f of fields) {
      expect(resolved[f]).toBeDefined();
    }
  });
});
