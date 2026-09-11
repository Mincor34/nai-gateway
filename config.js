/**
 * SYSTEM CONFIGURATION ENGINE (config.js)
 * Architecture Level 1: Imports nothing, provides immutable system configuration parameters.
 *
 * DESIGN PRINCIPLES:
 * 1. Pure functional configuration isolation without runtime execution side-effects.
 * 2. Strict parametric schema validation for priority tiers, firewall thresholds, and timing parameters.
 * 3. Normalizes external JSON 'null' limits to internal JavaScript 'Infinity' thresholds.
 * 4. Merges custom tier definitions defensively over DEFAULT_TIER_CONFIGS to prevent missing-tier crashes.
 * 5. Deterministic error propagation: throws structured exceptions on schema violations.
 * 6. Zero magic numbers: exposes all system operational boundaries to higher architectural layers.
 * 7. Explicit key sanitization protects against prototype pollution while preserving standard Object prototype methods.
 * 8. Deep immutability: all tier objects and manifests are deeply frozen across both default and custom paths.
 */

const DEFAULT_TIER_CONFIGS = Object.freeze({
  'Admin':   Object.freeze({ basePriority: 30, preciseLimit: Infinity, maxBurst: Infinity, refillRate: 0,      maxAllowance: Infinity, refillRateMs: 0 }),
  'High':    Object.freeze({ basePriority: 20, preciseLimit: 3,        maxBurst: Infinity, refillRate: 0,      maxAllowance: Infinity, refillRateMs: 0 }),
  'Normal':  Object.freeze({ basePriority: 10, preciseLimit: 2,        maxBurst: 15,       refillRate: 120000, maxAllowance: Infinity, refillRateMs: 0 }),
  'Low':     Object.freeze({ basePriority: 0,  preciseLimit: 1,        maxBurst: 10,       refillRate: 120000, maxAllowance: Infinity, refillRateMs: 0 }),
  'Metered': Object.freeze({ basePriority: 0,  preciseLimit: 0,        maxBurst: 5,        refillRate: 120000, maxAllowance: 100,      refillRateMs: 1800000 })
});

const MANDATORY_BASE_TIERS = Object.freeze(['Admin', 'High', 'Normal', 'Low', 'Metered']);

const PROXY_PATH_WHITELIST = Object.freeze(new Set([
  'ai/generate-image',
  'ai/generate-image-stream',
  'ai/encode-vibe',      // Whitelisted path to support vibe transfer pre-processing via master token
  'ai/generate-stream',  // Legacy Text/story Generation API endpoint
  'oa/v1/completions',   // New OpenAI-compatible Text Generation API endpoint (GLM-4, Erato, Xialong, etc.)
  'user/subscription'    // Allow proxying of read-only subscription telemetry to spoof native UI meters
]));

const SUBDOMAIN_WHITELIST = Object.freeze(['api', 'image', 'text']);

// Static operational defaults
const OPERATIONAL_DEFAULTS = Object.freeze({
  PORT: 3000,
  DATABASE_PATH: 'staging_data.db',
  NODE_ENV: 'development',
  MAX_CONCURRENT_TEXT_GENS: 3,
  
  // Parametric Firewall Boundaries (Enforces NovelAI Opus free generation parameters)
  FIREWALL_MAX_PIXELS: 1048576, // 1 Megapixel (1024x1024)
  FIREWALL_MAX_STEPS: 28,
  FIREWALL_MAX_SAMPLES: 1,
  
  // Channel A Queue Aging & Allocation Metrics
  QUEUE_AUTO_BOOST_SECONDS: 120,
  QUEUE_FAST_SLOPE_DIVISOR: 5,
  QUEUE_BASE_SLOPE_DIVISOR: 15,
  QUEUE_POLL_TIMEOUT_MS: 12000,
  QUEUE_PROCESSING_TIMEOUT_MS: 75000, // Enforces exact 75s maximum execution lock conforming strictly to system spec
  QUEUE_GC_INTERVAL_MS: 5000,

  // Master Account Telemetry Harvester Boundaries
  TELEMETRY_FETCH_TIMEOUT_MS: 8000,
  TELEMETRY_STALE_MS: 1800000, // 30 minutes
  TELEMETRY_COOLDOWN_MS: 30000, // 30 seconds rate-limit between harvests
  
  // Identity & Account Policies
  ACTIVE_SESSION_TTL_MS: 30000, // Active presence RAM threshold
  MAX_LINKED_DEVICES_PER_USER: 3
});

/**
 * Validates and parses raw TIER_CONFIGS JSON strings into normalized runtime objects.
 * Defensive design: Merges parsed overrides over DEFAULT_TIER_CONFIGS to guarantee
 * all mandatory tiers (Admin, High, Normal, Low, Metered) always exist in memory.
 * Preserves standard Object prototype inheritance while blocking key-based pollution vectors.
 *
 * @param {string|undefined} rawTierJson - Raw JSON string from environment.
 * @returns {object} Normalized tier configuration dictionary.
 * @throws {Error} Fatal schema violation if structure, types, or bounds are invalid.
 */
function parseTierConfigs(rawTierJson) {
  if (!rawTierJson) {
    const baseline = {};
    for (const [tier, defaultCfg] of Object.entries(DEFAULT_TIER_CONFIGS)) {
      baseline[tier] = defaultCfg; // Preserves existing frozen object references
    }
    return Object.freeze(baseline);
  }

  let parsed;
  try {
    parsed = JSON.parse(rawTierJson);
  } catch (parseErr) {
    throw new Error(`Fatal schema violation in TIER_CONFIGS environment variable: Malformed JSON - ${parseErr.message}`);
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Fatal schema violation in TIER_CONFIGS: Root payload must be an object.');
  }

  // Standard dictionary with baseline defaults
  const mergedConfigs = {};
  for (const [tier, defaultCfg] of Object.entries(DEFAULT_TIER_CONFIGS)) {
    mergedConfigs[tier] = defaultCfg;
  }

  for (const [tier, cfg] of Object.entries(parsed)) {
    // Explicitly reject prototype pollution keys
    if (tier === '__proto__' || tier === 'constructor' || tier === 'prototype') {
      throw new Error(`Fatal schema violation in TIER_CONFIGS: Illegal tier key "${tier}" detected.`);
    }

    if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) {
      throw new Error(`Fatal schema violation in TIER_CONFIGS: Tier "${tier}" configuration must be an object.`);
    }

    // Strict numerical property checks and non-negative bounds
    if (typeof cfg.basePriority !== 'number' || !Number.isFinite(cfg.basePriority) || cfg.basePriority < 0) {
      throw new Error(`Fatal schema violation in TIER_CONFIGS: Tier "${tier}": basePriority must be a non-negative finite number.`);
    }
    if (typeof cfg.refillRate !== 'number' || !Number.isFinite(cfg.refillRate) || cfg.refillRate < 0) {
      throw new Error(`Fatal schema violation in TIER_CONFIGS: Tier "${tier}": refillRate must be a non-negative finite number.`);
    }
    if (typeof cfg.refillRateMs !== 'number' || !Number.isFinite(cfg.refillRateMs) || cfg.refillRateMs < 0) {
      throw new Error(`Fatal schema violation in TIER_CONFIGS: Tier "${tier}": refillRateMs must be a non-negative finite number.`);
    }

    // Convert JSON-safe null fields into internal Infinity representations
    const preciseLimit = cfg.preciseLimit === null ? Infinity : cfg.preciseLimit;
    const maxBurst = cfg.maxBurst === null ? Infinity : cfg.maxBurst;
    const maxAllowance = cfg.maxAllowance === null ? Infinity : cfg.maxAllowance;

    if (typeof preciseLimit !== 'number' || Number.isNaN(preciseLimit) || preciseLimit < 0) {
      throw new Error(`Fatal schema violation in TIER_CONFIGS: Tier "${tier}": preciseLimit must be a non-negative number or null.`);
    }
    if (typeof maxBurst !== 'number' || Number.isNaN(maxBurst) || maxBurst < 0) {
      throw new Error(`Fatal schema violation in TIER_CONFIGS: Tier "${tier}": maxBurst must be a non-negative number or null.`);
    }
    if (typeof maxAllowance !== 'number' || Number.isNaN(maxAllowance) || maxAllowance < 0) {
      throw new Error(`Fatal schema violation in TIER_CONFIGS: Tier "${tier}": maxAllowance must be a non-negative number or null.`);
    }

    mergedConfigs[tier] = Object.freeze({
      basePriority: cfg.basePriority,
      preciseLimit,
      maxBurst,
      refillRate: cfg.refillRate,
      maxAllowance,
      refillRateMs: cfg.refillRateMs
    });
  }

  // Final invariant check: assert all baseline mandatory tiers are present
  for (const mandatoryTier of MANDATORY_BASE_TIERS) {
    if (!mergedConfigs[mandatoryTier]) {
      throw new Error(`Fatal schema violation in TIER_CONFIGS: Mandatory base tier "${mandatoryTier}" is missing.`);
    }
  }

  return Object.freeze(mergedConfigs);
}

/**
 * Loads, normalizes, and validates the system configuration context from a given environment.
 * Pure functional execution: does not maintain global ambient state or memoized proxies.
 *
 * @param {object} [env=process.env] - Execution environment dictionary.
 * @returns {object} Validated, immutable configuration manifest.
 * @throws {Error} If critical credentials or parameters fail validation constraints.
 */
function loadConfig(env = process.env) {
  const adminSecretKey = env.ADMIN_SECRET_KEY;
  if (!adminSecretKey || typeof adminSecretKey !== 'string' || adminSecretKey.trim() === '') {
    throw new Error("[VPS Critical] ADMIN_SECRET_KEY variable is unconfigured! Crashing boot sequence.");
  }

  let port = OPERATIONAL_DEFAULTS.PORT;
  if (env.PORT !== undefined) {
    const rawPort = String(env.PORT).trim();
    if (!/^\d+$/.test(rawPort)) {
      throw new Error(`Fatal schema violation in PORT: "${env.PORT}" is not a valid network port (1-65535).`);
    }
    const parsedPort = parseInt(rawPort, 10);
    if (parsedPort < 1 || parsedPort > 65535) {
      throw new Error(`Fatal schema violation in PORT: "${env.PORT}" is not a valid network port (1-65535).`);
    }
    port = parsedPort;
  }

  let databasePath = OPERATIONAL_DEFAULTS.DATABASE_PATH;
  if (env.DATABASE_PATH !== undefined) {
    const rawDbPath = String(env.DATABASE_PATH).trim();
    if (rawDbPath === '') {
      throw new Error("Fatal schema violation in DATABASE_PATH: Path cannot be empty or whitespace.");
    }
    databasePath = rawDbPath;
  }

  const nodeEnv = env.NODE_ENV ? String(env.NODE_ENV).trim() : OPERATIONAL_DEFAULTS.NODE_ENV;
  const tierConfigs = parseTierConfigs(env.TIER_CONFIGS);

  return Object.freeze({
    PORT: port,
    ADMIN_SECRET_KEY: adminSecretKey.trim(),
    DATABASE_PATH: databasePath,
    NODE_ENV: nodeEnv,
    TIER_CONFIGS: tierConfigs,
    PROXY_PATH_WHITELIST,
    SUBDOMAIN_WHITELIST,
    MAX_CONCURRENT_TEXT_GENS: OPERATIONAL_DEFAULTS.MAX_CONCURRENT_TEXT_GENS,
    FIREWALL_MAX_PIXELS: OPERATIONAL_DEFAULTS.FIREWALL_MAX_PIXELS,
    FIREWALL_MAX_STEPS: OPERATIONAL_DEFAULTS.FIREWALL_MAX_STEPS,
    FIREWALL_MAX_SAMPLES: OPERATIONAL_DEFAULTS.FIREWALL_MAX_SAMPLES,
    QUEUE_AUTO_BOOST_SECONDS: OPERATIONAL_DEFAULTS.QUEUE_AUTO_BOOST_SECONDS,
    QUEUE_FAST_SLOPE_DIVISOR: OPERATIONAL_DEFAULTS.QUEUE_FAST_SLOPE_DIVISOR,
    QUEUE_BASE_SLOPE_DIVISOR: OPERATIONAL_DEFAULTS.QUEUE_BASE_SLOPE_DIVISOR,
    QUEUE_POLL_TIMEOUT_MS: OPERATIONAL_DEFAULTS.QUEUE_POLL_TIMEOUT_MS,
    QUEUE_PROCESSING_TIMEOUT_MS: OPERATIONAL_DEFAULTS.QUEUE_PROCESSING_TIMEOUT_MS,
    QUEUE_GC_INTERVAL_MS: OPERATIONAL_DEFAULTS.QUEUE_GC_INTERVAL_MS,
    TELEMETRY_FETCH_TIMEOUT_MS: OPERATIONAL_DEFAULTS.TELEMETRY_FETCH_TIMEOUT_MS,
    TELEMETRY_STALE_MS: OPERATIONAL_DEFAULTS.TELEMETRY_STALE_MS,
    TELEMETRY_COOLDOWN_MS: OPERATIONAL_DEFAULTS.TELEMETRY_COOLDOWN_MS,
    ACTIVE_SESSION_TTL_MS: OPERATIONAL_DEFAULTS.ACTIVE_SESSION_TTL_MS,
    MAX_LINKED_DEVICES_PER_USER: OPERATIONAL_DEFAULTS.MAX_LINKED_DEVICES_PER_USER
  });
}

module.exports = {
  loadConfig,
  parseTierConfigs,
  DEFAULT_TIER_CONFIGS,
  MANDATORY_BASE_TIERS,
  PROXY_PATH_WHITELIST,
  SUBDOMAIN_WHITELIST,
  OPERATIONAL_DEFAULTS
};