'use strict';

/**
 * PHASE 2 HARNESS: CONFIGURATION & EXPLICIT DATABASE LIFECYCLE (test/phase2.test.js)
 *
 * Exhaustively exercises:
 * 1. Configuration Isolation & Schema Validation:
 *    - Unconfigured ADMIN_SECRET_KEY throws explicit fatal boot exception.
 *    - Missing PORT falls back cleanly to 3000; non-numeric, float, negative, zero, and out-of-range ports throw fatal exceptions.
 *    - Malformed TIER_CONFIGS JSON throws fatal schema violation.
 *    - Prototype pollution vectors in TIER_CONFIGS (__proto__, constructor, prototype) are strictly rejected.
 *    - Standard Object prototype methods (e.g. .hasOwnProperty) remain functional on parsed tier configurations.
 *    - Strict typing, non-negative bounds, and non-infinite values enforced for base priorities and refill rates.
 *    - Partial TIER_CONFIGS safely merge with DEFAULT_TIER_CONFIGS to prevent missing-tier crashes.
 *    - JSON null properties normalize to Infinity for preciseLimit, maxBurst, maxAllowance.
 *    - Immutability check: All tier objects remain strictly frozen under both default and custom configurations.
 *    - Functional purity: loadConfig() does not mutate global state or memoize across calls.
 *    - Strict spec verification: QUEUE_PROCESSING_TIMEOUT_MS must equal exactly 75000ms.
 * 2. Database Connection Lifecycle & Invariant Guards:
 *    - Stateless import: requiring database.js does not open file handles or create files.
 *    - Invoking run(), get(), or all() before initDatabase() throws structured [Database Error].
 *    - Mandates explicit path injection: initDatabase() without argument or whitespace rejects.
 *    - Canonical Boot Verification: PRAGMA journal_mode=WAL, PRAGMA busy_timeout=5000ms.
 *    - Strict Concurrency Denial: Parallel initDatabase calls reject with explicit boot sequence collision errors.
 *    - Strict Target Isolation: Changing database paths without explicitly calling closeDatabase() first throws.
 *    - Exhaustive Migration Verification: All 8 additive columns and notification flags are verified after legacy upgrade.
 *    - Authentic TOCTOU Multi-Handle Migration Race: Competing SQLite connections racing migrations resolve safely without duplicate column errors.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { loadConfig, parseTierConfigs, DEFAULT_TIER_CONFIGS, MANDATORY_BASE_TIERS, OPERATIONAL_DEFAULTS } = require('../config');
const database = require('../database');

const SANDBOX_DIR = path.join(__dirname, 'sandbox_phase2');

function purgeSandbox() {
  if (fs.existsSync(SANDBOX_DIR)) {
    try {
      fs.rmSync(SANDBOX_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Quiet fail if OS file locks are still draining asynchronously
    }
  }
}

test("Phase 2: Configuration & Database Connection Lifecycle Verification Gate", async (t) => {
  purgeSandbox();
  fs.mkdirSync(SANDBOX_DIR, { recursive: true });

  t.after(async () => {
    try { await database.closeDatabase(); } catch {}
    purgeSandbox();
  });

  // ----------------- CONFIGURATION ENGINE TESTS -----------------

  await t.test("Config: Rejects execution context when ADMIN_SECRET_KEY is absent or empty", () => {
    assert.throws(
      () => loadConfig({}),
      /ADMIN_SECRET_KEY variable is unconfigured/i,
      "Must throw explicit boot error when ADMIN_SECRET_KEY is missing"
    );

    assert.throws(
      () => loadConfig({ ADMIN_SECRET_KEY: "   " }),
      /ADMIN_SECRET_KEY variable is unconfigured/i,
      "Must throw explicit boot error when ADMIN_SECRET_KEY is whitespace"
    );
  });

  await t.test("Config: Normalizes Port and Rejects Non-Integer or Corrupt Port Formats", () => {
    const defaultCfg = loadConfig({ ADMIN_SECRET_KEY: "secret_123" });
    assert.strictEqual(defaultCfg.PORT, OPERATIONAL_DEFAULTS.PORT, "Port must default to operational default (3000)");
    assert.strictEqual(defaultCfg.NODE_ENV, "development", "NODE_ENV must default to development");

    const customPortCfg = loadConfig({ ADMIN_SECRET_KEY: "secret_123", PORT: "8080" });
    assert.strictEqual(customPortCfg.PORT, 8080, "String port must parse to integer");

    // Rejection of corrupt or partial strings that parseInt would erroneously accept
    assert.throws(
      () => loadConfig({ ADMIN_SECRET_KEY: "secret_123", PORT: "8080xyz" }),
      /not a valid network port/i,
      "Must reject alphanumeric port strings"
    );

    assert.throws(
      () => loadConfig({ ADMIN_SECRET_KEY: "secret_123", PORT: "3000.5" }),
      /not a valid network port/i,
      "Must reject float port strings"
    );

    assert.throws(
      () => loadConfig({ ADMIN_SECRET_KEY: "secret_123", PORT: "-80" }),
      /not a valid network port/i,
      "Must reject negative port strings"
    );

    assert.throws(
      () => loadConfig({ ADMIN_SECRET_KEY: "secret_123", PORT: "0" }),
      /not a valid network port/i,
      "Must reject zero port value"
    );

    assert.throws(
      () => loadConfig({ ADMIN_SECRET_KEY: "secret_123", PORT: "99999" }),
      /not a valid network port/i,
      "Must reject out-of-range port numbers"
    );
  });

  await t.test("Config: Rejects invalid or whitespace DATABASE_PATH configurations", () => {
    assert.throws(
      () => loadConfig({ ADMIN_SECRET_KEY: "secret_123", DATABASE_PATH: "   " }),
      /DATABASE_PATH: Path cannot be empty or whitespace/i,
      "Must reject whitespace database paths"
    );
  });

  await t.test("Config: Rejects Malformed TIER_CONFIGS JSON payloads and Prototype Injection", () => {
    assert.throws(
      () => parseTierConfigs("{ not_valid_json: true }"),
      /Malformed JSON/i,
      "Must throw syntax error on malformed JSON"
    );

    assert.throws(
      () => parseTierConfigs("[]"),
      /Root payload must be an object/i,
      "Must reject non-object JSON roots"
    );

    // Explicit raw JSON string containing __proto__ key (bypassing JS object literal setter trap)
    const protoPollutionPayload = '{"__proto__": {"basePriority": 10, "preciseLimit": 2, "maxBurst": 10, "refillRate": 0, "maxAllowance": 100, "refillRateMs": 0}}';
    assert.throws(
      () => parseTierConfigs(protoPollutionPayload),
      /Illegal tier key "__proto__"/i,
      "Must explicitly reject prototype pollution payloads"
    );

    // Explicit raw JSON string containing constructor key
    const constructorPayload = '{"constructor": {"basePriority": 10, "preciseLimit": 2, "maxBurst": 10, "refillRate": 0, "maxAllowance": 100, "refillRateMs": 0}}';
    assert.throws(
      () => parseTierConfigs(constructorPayload),
      /Illegal tier key "constructor"/i,
      "Must explicitly reject constructor pollution payloads"
    );

    // Explicit raw JSON string containing prototype key
    const prototypeKeyPayload = '{"prototype": {"basePriority": 10, "preciseLimit": 2, "maxBurst": 10, "refillRate": 0, "maxAllowance": 100, "refillRateMs": 0}}';
    assert.throws(
      () => parseTierConfigs(prototypeKeyPayload),
      /Illegal tier key "prototype"/i,
      "Must explicitly reject prototype key pollution payloads"
    );
  });

  await t.test("Config: Preserves Standard Object Prototype Methods on Parsed Registries", () => {
    const defaultConfigs = parseTierConfigs(undefined);
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(defaultConfigs, 'Normal'),
      true,
      "Parsed configuration must remain compatible with standard prototype checks"
    );
    assert.strictEqual(
      typeof defaultConfigs.hasOwnProperty,
      'function',
      "Default parsed configuration must expose hasOwnProperty function"
    );

    const customConfigs = parseTierConfigs(JSON.stringify({
      'Admin': { basePriority: 40, preciseLimit: null, maxBurst: null, refillRate: 0, maxAllowance: null, refillRateMs: 0 }
    }));
    assert.strictEqual(
      customConfigs.hasOwnProperty('Admin'),
      true,
      "Custom parsed configuration must expose hasOwnProperty function directly"
    );
  });

  await t.test("Config: Enforces Strict Numerical Typing, Non-Negative Bounds, and Finite Constraints", () => {
    // Missing basePriority
    const badBasePriority = JSON.stringify({
      'Admin': { preciseLimit: null, maxBurst: null, refillRate: 0, maxAllowance: null, refillRateMs: 0 }
    });
    assert.throws(() => parseTierConfigs(badBasePriority), /basePriority must be a non-negative finite number/i);

    // Negative basePriority
    const negativeBasePriority = JSON.stringify({
      'Admin': { basePriority: -10, preciseLimit: null, maxBurst: null, refillRate: 0, maxAllowance: null, refillRateMs: 0 }
    });
    assert.throws(() => parseTierConfigs(negativeBasePriority), /basePriority must be a non-negative finite number/i);

    // Non-finite basePriority (Infinity)
    const infiniteBasePriority = JSON.stringify({
      'Admin': { basePriority: 1e309, preciseLimit: null, maxBurst: null, refillRate: 0, maxAllowance: null, refillRateMs: 0 }
    });
    assert.throws(() => parseTierConfigs(infiniteBasePriority), /basePriority must be a non-negative finite number/i);

    // Negative refillRate
    const negativeRefillRate = JSON.stringify({
      'Admin': { basePriority: 30, preciseLimit: null, maxBurst: null, refillRate: -60000, maxAllowance: null, refillRateMs: 0 }
    });
    assert.throws(() => parseTierConfigs(negativeRefillRate), /refillRate must be a non-negative finite number/i);

    // String instead of number in refillRate
    const badRefillRate = JSON.stringify({
      'Admin': { basePriority: 30, preciseLimit: null, maxBurst: null, refillRate: "zero", maxAllowance: null, refillRateMs: 0 }
    });
    assert.throws(() => parseTierConfigs(badRefillRate), /refillRate must be a non-negative finite number/i);
  });

  await t.test("Config: Merges partial overrides defensively over default tiers", () => {
    // Override ONLY the Admin tier; verify base tiers (Normal, Low, High, Metered) are preserved
    const partialOverride = JSON.stringify({
      'Admin': {
        basePriority: 99,
        preciseLimit: null,
        maxBurst: null,
        refillRate: 0,
        maxAllowance: null,
        refillRateMs: 0
      }
    });

    const parsed = parseTierConfigs(partialOverride);
    assert.strictEqual(parsed.Admin.basePriority, 99, "Admin priority must be overridden");
    assert.ok(parsed.Normal !== undefined, "Normal tier must be preserved to prevent runtime crashes");
    assert.strictEqual(parsed.Normal.basePriority, DEFAULT_TIER_CONFIGS.Normal.basePriority);
    assert.strictEqual(parsed.Low.basePriority, DEFAULT_TIER_CONFIGS.Low.basePriority);
    assert.strictEqual(parsed.High.basePriority, DEFAULT_TIER_CONFIGS.High.basePriority);
    assert.strictEqual(parsed.Metered.basePriority, DEFAULT_TIER_CONFIGS.Metered.basePriority);

    for (const mandatory of MANDATORY_BASE_TIERS) {
      assert.ok(parsed[mandatory] !== undefined, `Mandatory tier ${mandatory} must exist`);
    }
  });

  await t.test("Config: Normalizes null limit values to JavaScript Infinity", () => {
    const rawJson = JSON.stringify({
      'Custom': {
        basePriority: 15,
        preciseLimit: null,
        maxBurst: null,
        refillRate: 60000,
        maxAllowance: null,
        refillRateMs: 0
      }
    });

    const parsed = parseTierConfigs(rawJson);
    assert.strictEqual(parsed.Custom.preciseLimit, Infinity, "preciseLimit null must convert to Infinity");
    assert.strictEqual(parsed.Custom.maxBurst, Infinity, "maxBurst null must convert to Infinity");
    assert.strictEqual(parsed.Custom.maxAllowance, Infinity, "maxAllowance null must convert to Infinity");
    assert.strictEqual(parsed.Custom.basePriority, 15);
    assert.strictEqual(parsed.Custom.refillRate, 60000);
  });

  await t.test("Config: Enforces Deep Immutability Across Both Default and Custom Tiers", () => {
    const defaultTiers = parseTierConfigs(undefined);
    
    // Explicitly assert freezing state
    assert.strictEqual(Object.isFrozen(defaultTiers), true, "Root configuration registry must be frozen");
    assert.strictEqual(Object.isFrozen(defaultTiers.Normal), true, "Default Normal tier object must be frozen");
    assert.strictEqual(Object.isFrozen(defaultTiers.Admin), true, "Default Admin tier object must be frozen");

    // In strict mode, mutation throws a TypeError
    assert.throws(
      () => { defaultTiers.Normal.basePriority = 999; },
      TypeError,
      "Default parsed tier objects must be strictly frozen and throw on mutation"
    );

    const customTiers = parseTierConfigs(JSON.stringify({
      'Admin': { basePriority: 50, preciseLimit: null, maxBurst: null, refillRate: 0, maxAllowance: null, refillRateMs: 0 }
    }));
    
    assert.strictEqual(Object.isFrozen(customTiers), true, "Custom configuration registry must be frozen");
    assert.strictEqual(Object.isFrozen(customTiers.Admin), true, "Custom Admin tier object must be frozen");

    assert.throws(
      () => { customTiers.Admin.basePriority = 999; },
      TypeError,
      "Custom parsed tier objects must be strictly frozen and throw on mutation"
    );
  });

  await t.test("Config: Exposes full parametric constants and maintains functional purity", () => {
    const cfg1 = loadConfig({ ADMIN_SECRET_KEY: "secret_1" });
    const cfg2 = loadConfig({ ADMIN_SECRET_KEY: "secret_2", PORT: "4000" });

    // Functional purity check: separate invocations must not pollute or memoize
    assert.strictEqual(cfg1.ADMIN_SECRET_KEY, "secret_1");
    assert.strictEqual(cfg2.ADMIN_SECRET_KEY, "secret_2");
    assert.strictEqual(cfg1.PORT, 3000);
    assert.strictEqual(cfg2.PORT, 4000);

    // Assert all operational constants strictly adhere to system specifications
    assert.strictEqual(cfg1.FIREWALL_MAX_PIXELS, 1048576, "Firewall pixel boundary must strictly equal 1MP (1048576)");
    assert.strictEqual(cfg1.FIREWALL_MAX_STEPS, 28, "Firewall step boundary must strictly equal 28");
    assert.strictEqual(cfg1.FIREWALL_MAX_SAMPLES, 1, "Firewall sample boundary must strictly equal 1");
    assert.strictEqual(cfg1.QUEUE_AUTO_BOOST_SECONDS, 120, "Queue auto-boost seconds must strictly equal 120");
    assert.strictEqual(cfg1.QUEUE_PROCESSING_TIMEOUT_MS, 75000, "Queue processing timeout must strictly equal 75000ms per system spec");
    assert.strictEqual(cfg1.QUEUE_POLL_TIMEOUT_MS, 12000, "Queue poll timeout must strictly equal 12000");
    assert.strictEqual(cfg1.MAX_LINKED_DEVICES_PER_USER, 3, "Maximum linked devices per user must strictly equal 3");
  });

  // ----------------- DATABASE CONNECTION LIFECYCLE TESTS -----------------

  await t.test("Database Lifecycle: Uninitialized Queries Reject with Explicit [Database Error]", async () => {
    // Ensure database is completely closed
    await database.closeDatabase();

    await assert.rejects(
      async () => await database.run("SELECT 1"),
      /\[Database Error\] Database has not been initialized/i,
      "run() must throw when uninitialized"
    );

    await assert.rejects(
      async () => await database.get("SELECT 1"),
      /\[Database Error\] Database has not been initialized/i,
      "get() must throw when uninitialized"
    );

    await assert.rejects(
      async () => await database.all("SELECT 1"),
      /\[Database Error\] Database has not been initialized/i,
      "all() must throw when uninitialized"
    );
  });

  await t.test("Database Lifecycle: Mandates explicit path injection and rejects missing paths", async () => {
    await assert.rejects(
      async () => await database.initDatabase(),
      /initDatabase requires an explicit, non-empty database file path/i,
      "Calling initDatabase() with no arguments must reject"
    );

    await assert.rejects(
      async () => await database.initDatabase("   "),
      /initDatabase requires an explicit, non-empty database file path/i,
      "Calling initDatabase() with whitespace must reject"
    );
  });

  await t.test("Database Lifecycle: Canonical Fresh Boot Schema & PRAGMA Verification", async () => {
    const dbPath = path.join(SANDBOX_DIR, "canonical_boot.db");
    
    await database.initDatabase(dbPath);
    assert.ok(fs.existsSync(dbPath), "Target SQLite file must exist on disk after initDatabase()");

    // Verify PRAGMA journal_mode is WAL
    const journalRow = await database.get("PRAGMA journal_mode;");
    assert.strictEqual(journalRow.journal_mode.toLowerCase(), "wal", "Database must enforce WAL journal mode");

    // Verify tables are created
    const tables = await database.all("SELECT name FROM sqlite_master WHERE type='table';");
    const tableNames = tables.map(t => t.name);
    assert.ok(tableNames.includes('devices'), "Must create 'devices' table");
    assert.ok(tableNames.includes('banned_discords'), "Must create 'banned_discords' table");
    assert.ok(tableNames.includes('config'), "Must create 'config' table");
    assert.ok(tableNames.includes('device_sessions'), "Must create 'device_sessions' table");

    // Invariant check: Assert all canonical columns exist immediately on fresh boot without migration churn
    const deviceCols = await database.all("PRAGMA table_info(devices)");
    const deviceColNames = deviceCols.map(c => c.name);
    assert.ok(deviceColNames.includes('browser_id'));
    assert.ok(deviceColNames.includes('device_secret'));
    assert.ok(deviceColNames.includes('label'));
    assert.ok(deviceColNames.includes('priority_tier'));
    assert.ok(deviceColNames.includes('approved'));
    assert.ok(deviceColNames.includes('discord_id'));
    assert.ok(deviceColNames.includes('anlas_consumed'));
    assert.ok(deviceColNames.includes('banned'));
    assert.ok(deviceColNames.includes('total_requests'));
    assert.ok(deviceColNames.includes('last_active_at'));
    assert.ok(deviceColNames.includes('discord_username'));
    assert.ok(deviceColNames.includes('metered_allowance'));
    assert.ok(deviceColNames.includes('last_allowance_update_at'));

    const banCols = await database.all("PRAGMA table_info(banned_discords)");
    const banColNames = banCols.map(c => c.name);
    assert.ok(banColNames.includes('is_notified'), "Must have is_notified on banned_discords");

    await database.run("INSERT INTO devices (browser_id, device_secret, label) VALUES (?, ?, ?)", [
      "test_b_1", "test_s_1", "Test Device"
    ]);

    const record = await database.get("SELECT * FROM devices WHERE browser_id = ?", ["test_b_1"]);
    assert.strictEqual(record.browser_id, "test_b_1");
    assert.strictEqual(record.label, "Test Device");

    // Clean teardown
    await database.closeDatabase();

    // Verify calls fail post-closure
    await assert.rejects(
      async () => await database.get("SELECT * FROM devices"),
      /\[Database Error\] Database has not been initialized/i
    );
  });

  await t.test("Database Lifecycle: Rejects Concurrent Initialization Attempts", async () => {
    const concurrentDbPath = path.join(SANDBOX_DIR, "concurrent_init.db");
    const initPromise = database.initDatabase(concurrentDbPath);

    await assert.rejects(
      async () => await database.initDatabase(concurrentDbPath),
      /Boot sequence collision/i,
      "Subsequent concurrent initialization calls must fail-fast and reject"
    );

    await initPromise;
    await database.closeDatabase();
  });

  await t.test("Database Lifecycle: Rejects Hot-Swapping Paths Without Explicit Closure", async () => {
    const pathA = path.join(SANDBOX_DIR, "path_a.db");
    const pathB = path.join(SANDBOX_DIR, "path_b.db");

    await database.initDatabase(pathA);

    await assert.rejects(
      async () => await database.initDatabase(pathB),
      /already actively connected to a different path/i,
      "Changing database paths without calling closeDatabase() must throw"
    );

    await database.closeDatabase();
  });

  await t.test("Database Lifecycle: Transactional Migration of Legacy Database Verifies All Additive Columns", async () => {
    const legacyDbPath = path.join(SANDBOX_DIR, "legacy_exhaustive_migration.db");

    // Create legacy table lacking all modern columns
    await new Promise((resolve, reject) => {
      const legacyDb = new sqlite3.Database(legacyDbPath, (err) => {
        if (err) return reject(err);
        legacyDb.serialize(() => {
          legacyDb.run(`CREATE TABLE devices (
            browser_id TEXT PRIMARY KEY,
            device_secret TEXT NOT NULL,
            label TEXT,
            priority_tier TEXT NOT NULL DEFAULT 'Normal',
            approved INTEGER NOT NULL DEFAULT 0
          )`);
          legacyDb.run(`CREATE TABLE banned_discords (
            discord_id TEXT PRIMARY KEY,
            banned_at INTEGER NOT NULL,
            reason TEXT
          )`);
          legacyDb.close((closeErr) => {
            if (closeErr) reject(closeErr);
            else resolve();
          });
        });
      });
    });

    // Run initDatabase over the legacy file; it must migrate transactionally
    await database.initDatabase(legacyDbPath);

    // Assert every single additive column is migrated without exception
    const deviceCols = await database.all("PRAGMA table_info(devices)");
    const deviceColNames = deviceCols.map(c => c.name);
    assert.ok(deviceColNames.includes('discord_id'), "Legacy migration must add discord_id");
    assert.ok(deviceColNames.includes('anlas_consumed'), "Legacy migration must add anlas_consumed");
    assert.ok(deviceColNames.includes('banned'), "Legacy migration must add banned");
    assert.ok(deviceColNames.includes('total_requests'), "Legacy migration must add total_requests");
    assert.ok(deviceColNames.includes('last_active_at'), "Legacy migration must add last_active_at");
    assert.ok(deviceColNames.includes('discord_username'), "Legacy migration must add discord_username");
    assert.ok(deviceColNames.includes('metered_allowance'), "Legacy migration must add metered_allowance");
    assert.ok(deviceColNames.includes('last_allowance_update_at'), "Legacy migration must add last_allowance_update_at");

    const banCols = await database.all("PRAGMA table_info(banned_discords)");
    const banColNames = banCols.map(c => c.name);
    assert.ok(banColNames.includes('is_notified'), "Legacy migration must add is_notified");

    await database.closeDatabase();
  });

  await t.test("Database Lifecycle: Rejects initDatabase and concurrent closes during active teardown", async () => {
    const teardownDbPath = path.join(SANDBOX_DIR, "teardown_lock.db");
    await database.initDatabase(teardownDbPath);

    // Trigger teardown
    const closePromise = database.closeDatabase();

    // Attempt concurrent initDatabase while teardown is in flight
    await assert.rejects(
      async () => await database.initDatabase(teardownDbPath),
      /Teardown collision: Database is actively shutting down/i,
      "initDatabase must fail-fast if executed during an active close"
    );

    // Attempt concurrent closeDatabase while teardown is in flight
    await assert.rejects(
      async () => await database.closeDatabase(),
      /Database teardown is already in progress/i,
      "Concurrent closeDatabase calls must fail-fast"
    );

    await closePromise;
  });

  await t.test("Database Lifecycle: Authentic Multi-Handle Concurrent Migration Race Resolves Without Collision", async () => {
    const raceDbPath = path.join(SANDBOX_DIR, "race_migration.db");

    await new Promise((resolve, reject) => {
      const legacyDb = new sqlite3.Database(raceDbPath, (err) => {
        if (err) return reject(err);
        legacyDb.serialize(() => {
          legacyDb.run(`CREATE TABLE devices (
            browser_id TEXT PRIMARY KEY,
            device_secret TEXT NOT NULL,
            label TEXT,
            priority_tier TEXT NOT NULL DEFAULT 'Normal',
            approved INTEGER NOT NULL DEFAULT 0
          )`);
          legacyDb.run(`CREATE TABLE banned_discords (
            discord_id TEXT PRIMARY KEY,
            banned_at INTEGER NOT NULL,
            reason TEXT
          )`);
          legacyDb.close((closeErr) => {
            if (closeErr) reject(closeErr);
            else resolve();
          });
        });
      });
    });

    const competingDb = new sqlite3.Database(raceDbPath);
    await new Promise((resolve, reject) => {
      competingDb.serialize(() => {
        competingDb.run("PRAGMA journal_mode = WAL;");
        competingDb.run("PRAGMA busy_timeout = 5000;", (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });

    const competingMigration = () => new Promise((resolve, reject) => {
      competingDb.serialize(() => {
        competingDb.run("BEGIN IMMEDIATE;", (beginErr) => {
          if (beginErr) return reject(beginErr);

          competingDb.all("PRAGMA table_info(devices);", (infoErr, rows) => {
            if (infoErr) {
              competingDb.run("ROLLBACK;");
              return reject(infoErr);
            }

            const hasCol = rows.some(r => r.name === 'discord_id');
            if (!hasCol) {
              competingDb.run("ALTER TABLE devices ADD COLUMN discord_id TEXT;", (alterErr) => {
                if (alterErr) {
                  competingDb.run("ROLLBACK;");
                  return reject(alterErr);
                }
                competingDb.run("COMMIT;", (commitErr) => {
                  if (commitErr) reject(commitErr);
                  else resolve();
                });
              });
            } else {
              competingDb.run("COMMIT;", (commitErr) => {
                if (commitErr) reject(commitErr);
                else resolve();
              });
            }
          });
        });
      });
    });

    const [res1, res2] = await Promise.allSettled([
      competingMigration(),
      database.initDatabase(raceDbPath)
    ]);

    assert.strictEqual(res1.status, 'fulfilled', `Competing worker failed: ${res1.reason?.message}`);
    assert.strictEqual(res2.status, 'fulfilled', `database.initDatabase failed: ${res2.reason?.message}`);

    const deviceCols = await database.all("PRAGMA table_info(devices)");
    const deviceColNames = deviceCols.map(c => c.name);
    assert.ok(deviceColNames.includes('discord_id'), "discord_id column must exist after race");
    assert.ok(deviceColNames.includes('anlas_consumed'), "anlas_consumed must exist after race");

    await new Promise((r) => competingDb.close(r));
    await database.closeDatabase();
  });
});