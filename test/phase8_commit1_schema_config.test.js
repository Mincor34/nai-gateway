/**
 * PHASE 8 COMMIT 1 VERIFICATION HARNESS (test/phase8_commit1_schema_config.test.js)
 *
 * Exhaustively tests:
 * 1. ACS-1 Configuration Expansion:
 *    - All operational constants: NOMINAL_DAILY_V5_COMPUTE, V5_CIRCUIT_BREAKER_PERCENT,
 *      V5_SURPLUS_THRESHOLD_PERCENT, INGRESS_SEMAPHORE_MAX, UPLOAD_INACTIVITY_TIMEOUT_MS,
 *      UPLOAD_DURATION_CEILING_MS.
 *    - All tier configurations include monthlyAnlas, v5Weight, v5MaxBankDays, v5SurplusEligible.
 *    - Strict schema validation: non-negative integers, null -> Infinity mapping, boolean check,
 *      and defensive inheritance over defaults.
 *    - Regex-backed environmental validation: rejects partial strings and trailing junk.
 * 2. Database Schema & Persistence (Fresh Boot):
 *    - Fresh initialization creates complete canonical schema with all 8 new users columns
 *      and 2 new devices columns.
 *    - Config table has seeded v5_surplus_pool = '0' and v5_surplus_last_accrual = '0'.
 * 3. Database Migration (Legacy Upgrade):
 *    - Scenario A: Legacy DB lacking users table (Phase 1 structure) migrates cleanly.
 *    - Scenario B: Phase 7 DB lacking ACS-1 columns migrates without data corruption,
 *      accurately preserving canonical user_id mappings when discord_id is null.
 * 4. Hell Path: Concurrent Migration Collision:
 *    - Spawns competing multi-handle database boots simultaneously under WAL mode.
 *    - Asserts transactions serialize via BEGIN IMMEDIATE without "duplicate column" SQLite exceptions.
 * 5. Hell Path: Schema Invariant Integrity (Triggers, Negative Balances, & Anti-Arbitrage):
 *    - Assert bidirectional trigger updates preserve negative virtual Anlas balances without silent truncation or float casting.
 *    - Synchronizes across canonical users and linked devices bidirectionally.
 *    - Synchronizes allowance alongside balances on device insert and user_id update to eliminate multi-device arbitrage.
 *    - Preserves int64 timestamp fidelity.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const { loadConfig, parseTierConfigs, DEFAULT_TIER_CONFIGS } = require('../config');
const database = require('../database');

const SANDBOX_DIR = path.join(__dirname, 'sandbox_phase8_commit1');

function purgeSandbox() {
  if (fs.existsSync(SANDBOX_DIR)) {
    try {
      fs.rmSync(SANDBOX_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_) {}
  }
}

test("Phase 8 Commit 1: Configuration & Database Schema Migration Verification Gate", async (t) => {
  purgeSandbox();
  fs.mkdirSync(SANDBOX_DIR, { recursive: true });

  t.after(async () => {
    try { await database.closeDatabase(); } catch (_) {}
    purgeSandbox();
  });

  // ---------------------------------------------------------------------------
  // 1. CONFIGURATION EXPANSION TESTS
  // ---------------------------------------------------------------------------
  await t.test("Config: Exposes all ACS-1 operational constants and defaults", () => {
    const config = loadConfig({ ADMIN_SECRET_KEY: "test_key_schema_commit1" });

    assert.strictEqual(config.NOMINAL_DAILY_V5_COMPUTE, 190.0);
    assert.strictEqual(config.V5_CIRCUIT_BREAKER_PERCENT, 5.5);
    assert.strictEqual(config.V5_SURPLUS_THRESHOLD_PERCENT, 50.0);
    assert.strictEqual(config.INGRESS_SEMAPHORE_MAX, 2);
    assert.strictEqual(config.UPLOAD_INACTIVITY_TIMEOUT_MS, 5000);
    assert.strictEqual(config.UPLOAD_DURATION_CEILING_MS, 60000);

    // Assert that default tiers reflect ACS-1 specifications
    assert.strictEqual(DEFAULT_TIER_CONFIGS.Admin.monthlyAnlas, Infinity);
    assert.strictEqual(DEFAULT_TIER_CONFIGS.Admin.v5Weight, 4);
    assert.strictEqual(DEFAULT_TIER_CONFIGS.Admin.v5MaxBankDays, Infinity);
    assert.strictEqual(DEFAULT_TIER_CONFIGS.Admin.v5SurplusEligible, true);

    assert.strictEqual(DEFAULT_TIER_CONFIGS.High.monthlyAnlas, 1000);
    assert.strictEqual(DEFAULT_TIER_CONFIGS.High.v5Weight, 3);
    assert.strictEqual(DEFAULT_TIER_CONFIGS.High.v5MaxBankDays, 3);
    assert.strictEqual(DEFAULT_TIER_CONFIGS.High.v5SurplusEligible, true);

    assert.strictEqual(DEFAULT_TIER_CONFIGS.Normal.monthlyAnlas, 500);
    assert.strictEqual(DEFAULT_TIER_CONFIGS.Normal.v5Weight, 2);
    assert.strictEqual(DEFAULT_TIER_CONFIGS.Normal.v5MaxBankDays, 3);
    assert.strictEqual(DEFAULT_TIER_CONFIGS.Normal.v5SurplusEligible, true);

    assert.strictEqual(DEFAULT_TIER_CONFIGS.Low.monthlyAnlas, 200);
    assert.strictEqual(DEFAULT_TIER_CONFIGS.Low.v5Weight, 1);
    assert.strictEqual(DEFAULT_TIER_CONFIGS.Low.v5MaxBankDays, 3);
    assert.strictEqual(DEFAULT_TIER_CONFIGS.Low.v5SurplusEligible, true);

    assert.strictEqual(DEFAULT_TIER_CONFIGS.Metered.monthlyAnlas, 0);
    assert.strictEqual(DEFAULT_TIER_CONFIGS.Metered.v5Weight, 0);
    assert.strictEqual(DEFAULT_TIER_CONFIGS.Metered.v5MaxBankDays, 0);
    assert.strictEqual(DEFAULT_TIER_CONFIGS.Metered.v5SurplusEligible, false);
  });

  await t.test("Config: Enforces strict integer typing and rejects float quotas", () => {
    // 1. Normalizing null values to Infinity
    const parsedNulls = parseTierConfigs(JSON.stringify({
      'Admin': {
        basePriority: 30, preciseLimit: null, maxBurst: null, refillRate: 0,
        maxAllowance: null, refillRateMs: 0,
        monthlyAnlas: null, v5Weight: 4, v5MaxBankDays: null, v5SurplusEligible: true
      }
    }));
    assert.strictEqual(parsedNulls.Admin.monthlyAnlas, Infinity);
    assert.strictEqual(parsedNulls.Admin.v5MaxBankDays, Infinity);

    // 2. Reject negative monthlyAnlas
    assert.throws(
      () => parseTierConfigs(JSON.stringify({
        'Admin': { basePriority: 30, preciseLimit: null, maxBurst: null, refillRate: 0, maxAllowance: null, refillRateMs: 0, monthlyAnlas: -50 }
      })),
      /monthlyAnlas must be a non-negative integer or null/i
    );

    // 3. Reject float monthlyAnlas (enforces discrete ledger invariant)
    assert.throws(
      () => parseTierConfigs(JSON.stringify({
        'Admin': { basePriority: 30, preciseLimit: null, maxBurst: null, refillRate: 0, maxAllowance: null, refillRateMs: 0, monthlyAnlas: 500.5 }
      })),
      /monthlyAnlas must be a non-negative integer or null/i
    );

    // 4. Reject negative v5Weight
    assert.throws(
      () => parseTierConfigs(JSON.stringify({
        'Admin': { basePriority: 30, preciseLimit: null, maxBurst: null, refillRate: 0, maxAllowance: null, refillRateMs: 0, v5Weight: -1 }
      })),
      /v5Weight must be a non-negative integer/i
    );

    // 5. Reject float v5Weight
    assert.throws(
      () => parseTierConfigs(JSON.stringify({
        'Admin': { basePriority: 30, preciseLimit: null, maxBurst: null, refillRate: 0, maxAllowance: null, refillRateMs: 0, v5Weight: 2.5 }
      })),
      /v5Weight must be a non-negative integer/i
    );

    // 6. Reject negative v5MaxBankDays
    assert.throws(
      () => parseTierConfigs(JSON.stringify({
        'Admin': { basePriority: 30, preciseLimit: null, maxBurst: null, refillRate: 0, maxAllowance: null, refillRateMs: 0, v5MaxBankDays: -3 }
      })),
      /v5MaxBankDays must be a non-negative integer or null/i
    );

    // 7. Reject float v5MaxBankDays
    assert.throws(
      () => parseTierConfigs(JSON.stringify({
        'Admin': { basePriority: 30, preciseLimit: null, maxBurst: null, refillRate: 0, maxAllowance: null, refillRateMs: 0, v5MaxBankDays: 1.5 }
      })),
      /v5MaxBankDays must be a non-negative integer or null/i
    );

    // 8. Reject non-boolean v5SurplusEligible
    assert.throws(
      () => parseTierConfigs(JSON.stringify({
        'Admin': { basePriority: 30, preciseLimit: null, maxBurst: null, refillRate: 0, maxAllowance: null, refillRateMs: 0, v5SurplusEligible: "true" }
      })),
      /v5SurplusEligible must be a boolean/i
    );
  });

  await t.test("Config: Strict regex validation rejects corrupt alphanumeric environment parameters", () => {
    // Alphanumeric trailing string in NOMINAL_DAILY_V5_COMPUTE
    assert.throws(
      () => loadConfig({ ADMIN_SECRET_KEY: "k", NOMINAL_DAILY_V5_COMPUTE: "190.0px" }),
      /Fatal schema violation in NOMINAL_DAILY_V5_COMPUTE/i
    );

    // Alphanumeric trailing string in V5_CIRCUIT_BREAKER_PERCENT
    assert.throws(
      () => loadConfig({ ADMIN_SECRET_KEY: "k", V5_CIRCUIT_BREAKER_PERCENT: "5.5%" }),
      /Fatal schema violation in V5_CIRCUIT_BREAKER_PERCENT/i
    );

    // Negative INGRESS_SEMAPHORE_MAX
    assert.throws(
      () => loadConfig({ ADMIN_SECRET_KEY: "k", INGRESS_SEMAPHORE_MAX: "0" }),
      /Fatal schema violation in INGRESS_SEMAPHORE_MAX/i
    );

    // Sub-100ms UPLOAD_INACTIVITY_TIMEOUT_MS
    assert.throws(
      () => loadConfig({ ADMIN_SECRET_KEY: "k", UPLOAD_INACTIVITY_TIMEOUT_MS: "50" }),
      /must be at least 100ms/i
    );
  });

  // ---------------------------------------------------------------------------
  // 2. DATABASE SCHEMA & FRESH BOOT VERIFICATION
  // ---------------------------------------------------------------------------
  await t.test("Database: Fresh boot creates full canonical schema with ACS-1 columns and seeded config", async () => {
    const dbPath = path.join(SANDBOX_DIR, "fresh_boot.db");
    await database.initDatabase(dbPath);

    // Verify all columns on users table
    const userCols = await database.all("PRAGMA table_info(users)");
    const userColNames = userCols.map(c => c.name);

    const requiredUserCols = [
      'user_id', 'priority_tier', 'banned', 'ban_reason', 'ban_notified',
      'anlas_consumed', 'metered_allowance', 'last_allowance_update_at', 'discord_username',
      'virtual_anlas_balance', 'last_anlas_reset_epoch', 'v5_banked_balance',
      'v5_last_accrual_epoch', 'v5_daily_consumed', 'subscription_period_anlas',
      'subscription_period_v5', 'subscription_period_start_epoch'
    ];

    for (const col of requiredUserCols) {
      assert.ok(userColNames.includes(col), `Users table must include column: ${col}`);
    }

    // Verify mirrored columns on devices table
    const deviceCols = await database.all("PRAGMA table_info(devices)");
    const deviceColNames = deviceCols.map(c => c.name);
    assert.ok(deviceColNames.includes('virtual_anlas_balance'), "Devices table must mirror virtual_anlas_balance");
    assert.ok(deviceColNames.includes('v5_banked_balance'), "Devices table must mirror v5_banked_balance");

    // Verify config seeded keys
    const poolConfig = await database.get("SELECT value FROM config WHERE key = 'v5_surplus_pool'");
    assert.ok(poolConfig, "config table must contain v5_surplus_pool");
    assert.strictEqual(poolConfig.value, '0');

    const accrualConfig = await database.get("SELECT value FROM config WHERE key = 'v5_surplus_last_accrual'");
    assert.ok(accrualConfig, "config table must contain v5_surplus_last_accrual");
    assert.strictEqual(accrualConfig.value, '0');

    await database.closeDatabase();
  });

  // ---------------------------------------------------------------------------
  // 3. DATABASE MIGRATION VERIFICATION (LEGACY UPGRADES)
  // ---------------------------------------------------------------------------
  await t.test("Database: Preserves Phase 7 canonical user_id during migration when discord_id is NULL", async () => {
    const migrationDbPath = path.join(SANDBOX_DIR, "phase7_user_migration.db");

    // Seed Phase 7 database where user_id is set on devices, but discord_id is null
    await new Promise((resolve, reject) => {
      const p7Db = new sqlite3.Database(migrationDbPath, (err) => {
        if (err) return reject(err);
        p7Db.serialize(() => {
          p7Db.run(`CREATE TABLE devices (
            browser_id TEXT PRIMARY KEY,
            user_id TEXT,
            device_secret TEXT NOT NULL,
            label TEXT,
            priority_tier TEXT NOT NULL DEFAULT 'Normal',
            approved INTEGER NOT NULL DEFAULT 1,
            banned INTEGER NOT NULL DEFAULT 0,
            total_requests INTEGER NOT NULL DEFAULT 5,
            last_active_at INTEGER,
            discord_id TEXT,
            discord_username TEXT,
            anlas_consumed INTEGER NOT NULL DEFAULT 15,
            metered_allowance INTEGER DEFAULT 42,
            last_allowance_update_at INTEGER
          )`);
          p7Db.run(`INSERT INTO devices (browser_id, user_id, device_secret, label, discord_id, anlas_consumed, metered_allowance) 
                    VALUES ('browser_laptop_1', 'custom_principal_99', 'sec_99', 'Laptop', NULL, 15, 42)`);
          p7Db.close(closeErr => closeErr ? reject(closeErr) : resolve());
        });
      });
    });

    await database.initDatabase(migrationDbPath);

    // Invariant: Migration must register user under 'custom_principal_99', NOT 'browser_laptop_1'
    const canonicalUser = await database.get("SELECT * FROM users WHERE user_id = 'custom_principal_99'");
    assert.ok(canonicalUser, "Canonical user_id must be preserved from devices.user_id during migration");
    assert.strictEqual(canonicalUser.anlas_consumed, 15);
    assert.strictEqual(canonicalUser.metered_allowance, 42);

    const falseUser = await database.get("SELECT * FROM users WHERE user_id = 'browser_laptop_1'");
    assert.strictEqual(falseUser, undefined, "Raw browser_id must not usurp canonical user_id during migration");

    await database.closeDatabase();
  });

  // ---------------------------------------------------------------------------
  // 4. HELL PATH: CONCURRENT MIGRATION COLLISION VIA BEGIN IMMEDIATE
  // ---------------------------------------------------------------------------
  await t.test("Hell Path: Multi-handle concurrent migration serialization via BEGIN IMMEDIATE", async () => {
    const raceDbPath = path.join(SANDBOX_DIR, "race_migration.db");

    await new Promise((resolve, reject) => {
      const dbH = new sqlite3.Database(raceDbPath, (err) => {
        if (err) return reject(err);
        dbH.serialize(() => {
          dbH.run(`CREATE TABLE devices (
            browser_id TEXT PRIMARY KEY,
            device_secret TEXT NOT NULL,
            label TEXT,
            priority_tier TEXT NOT NULL DEFAULT 'Normal',
            approved INTEGER NOT NULL DEFAULT 0
          );`);
          dbH.run(`CREATE TABLE banned_discords (
            discord_id TEXT PRIMARY KEY,
            banned_at INTEGER NOT NULL,
            reason TEXT
          );`);
          dbH.close(e => e ? reject(e) : resolve());
        });
      });
    });

    const competingDb = new sqlite3.Database(raceDbPath);
    await new Promise((resolve, reject) => {
      competingDb.serialize(() => {
        competingDb.run("PRAGMA journal_mode = WAL;");
        competingDb.run("PRAGMA busy_timeout = 5000;", err => err ? reject(err) : resolve());
      });
    });

    const competingWorkerMigration = () => new Promise((resolve, reject) => {
      competingDb.serialize(() => {
        competingDb.run("BEGIN IMMEDIATE;", (beginErr) => {
          if (beginErr) return reject(beginErr);

          competingDb.all("PRAGMA table_info(devices);", (infoErr, rows) => {
            if (infoErr) {
              competingDb.run("ROLLBACK;");
              return reject(infoErr);
            }

            const hasCol = rows.some(r => r.name === 'virtual_anlas_balance');
            if (!hasCol) {
              competingDb.run("ALTER TABLE devices ADD COLUMN virtual_anlas_balance INTEGER NOT NULL DEFAULT 0;", (alterErr) => {
                if (alterErr) {
                  competingDb.run("ROLLBACK;");
                  return reject(alterErr);
                }
                competingDb.run("COMMIT;", commitErr => commitErr ? reject(commitErr) : resolve());
              });
            } else {
              competingDb.run("COMMIT;", commitErr => commitErr ? reject(commitErr) : resolve());
            }
          });
        });
      });
    });

    const [res1, res2] = await Promise.allSettled([
      competingWorkerMigration(),
      database.initDatabase(raceDbPath)
    ]);

    assert.strictEqual(res1.status, 'fulfilled', `Worker 1 failed: ${res1.reason?.message}`);
    assert.strictEqual(res2.status, 'fulfilled', `database.initDatabase failed: ${res2.reason?.message}`);

    const deviceCols = await database.all("PRAGMA table_info(devices)");
    const deviceColNames = deviceCols.map(c => c.name);
    assert.ok(deviceColNames.includes('virtual_anlas_balance'));
    assert.ok(deviceColNames.includes('v5_banked_balance'));

    await new Promise(r => competingDb.close(r));
    await database.closeDatabase();
  });

  // ---------------------------------------------------------------------------
  // 5. HELL PATH: BIDIRECTIONAL TRIGGER BALANCE SYNCHRONIZATION & NEGATIVE NUMBERS
  // ---------------------------------------------------------------------------
  await t.test("Hell Path: Bidirectional trigger balance sync preserves negative numbers and int64 fidelity", async () => {
    const triggerDbPath = path.join(SANDBOX_DIR, "trigger_sync.db");
    await database.initDatabase(triggerDbPath);

    const userId = "discord_bob_101";

    // 1. Create canonical user with existing debt balance (-50) and metered allowance (15)
    await database.run(`
      INSERT INTO users (user_id, priority_tier, virtual_anlas_balance, v5_banked_balance, metered_allowance, discord_username)
      VALUES (?, 'Metered', -50, 18, 15, 'Bob')
    `, [userId]);

    // 2. Link 2 devices to Bob
    await database.run(`
      INSERT INTO devices (browser_id, user_id, device_secret, label, approved)
      VALUES ('bob_laptop', ?, 'sec_laptop', 'Laptop', 1)
    `, [userId]);

    await database.run(`
      INSERT INTO devices (browser_id, user_id, device_secret, label, approved)
      VALUES ('bob_phone', ?, 'sec_phone', 'Phone', 1)
    `, [userId]);

    // Invariant Check 1: Newly inserted devices must immediately inherit user's negative debt balance AND metered allowance
    const devLaptop = await database.get("SELECT virtual_anlas_balance, v5_banked_balance, metered_allowance FROM devices WHERE browser_id = 'bob_laptop'");
    assert.strictEqual(devLaptop.virtual_anlas_balance, -50, "Laptop must inherit negative debt on insert");
    assert.strictEqual(devLaptop.v5_banked_balance, 18);
    assert.strictEqual(devLaptop.metered_allowance, 15, "Laptop must inherit canonical metered allowance (anti-arbitrage)");
    assert.strictEqual(Number.isInteger(devLaptop.virtual_anlas_balance), true, "Must preserve integer fidelity (no float cast)");

    const devPhone = await database.get("SELECT virtual_anlas_balance, v5_banked_balance, metered_allowance FROM devices WHERE browser_id = 'bob_phone'");
    assert.strictEqual(devPhone.virtual_anlas_balance, -50);
    assert.strictEqual(devPhone.metered_allowance, 15);

    // Invariant Check 2: Update balance on users table -> must sync to both devices
    await database.run("UPDATE users SET virtual_anlas_balance = -120, v5_banked_balance = 36 WHERE user_id = ?", [userId]);

    const checkLaptopAfterUserUpdate = await database.get("SELECT virtual_anlas_balance, v5_banked_balance FROM devices WHERE browser_id = 'bob_laptop'");
    assert.strictEqual(checkLaptopAfterUserUpdate.virtual_anlas_balance, -120, "Updating users must sync negative balance to laptop");
    assert.strictEqual(checkLaptopAfterUserUpdate.v5_banked_balance, 36);

    const checkPhoneAfterUserUpdate = await database.get("SELECT virtual_anlas_balance, v5_banked_balance FROM devices WHERE browser_id = 'bob_phone'");
    assert.strictEqual(checkPhoneAfterUserUpdate.virtual_anlas_balance, -120);

    // Invariant Check 3: Update balance on laptop device -> must sync to users and peer phone device
    await database.run("UPDATE devices SET virtual_anlas_balance = -275, v5_banked_balance = 0 WHERE browser_id = 'bob_laptop'");

    const checkUserAfterDevUpdate = await database.get("SELECT virtual_anlas_balance, v5_banked_balance FROM users WHERE user_id = ?", [userId]);
    assert.strictEqual(checkUserAfterDevUpdate.virtual_anlas_balance, -275, "Updating device must sync negative balance to canonical user");
    assert.strictEqual(checkUserAfterDevUpdate.v5_banked_balance, 0);

    const checkPeerPhone = await database.get("SELECT virtual_anlas_balance, v5_banked_balance FROM devices WHERE browser_id = 'bob_phone'");
    assert.strictEqual(checkPeerPhone.virtual_anlas_balance, -275, "Updating laptop device must sync negative balance to peer phone device");
    assert.strictEqual(checkPeerPhone.v5_banked_balance, 0);

    // Invariant Check 4: Linking an existing device to Bob via UPDATE of user_id syncs allowance and balances
    await database.run("INSERT INTO devices (browser_id, device_secret, label, approved) VALUES ('bob_tablet', 'sec_tab', 'Tablet', 1)");
    await database.run("UPDATE devices SET user_id = ? WHERE browser_id = 'bob_tablet'", [userId]);

    const checkTablet = await database.get("SELECT virtual_anlas_balance, metered_allowance FROM devices WHERE browser_id = 'bob_tablet'");
    assert.strictEqual(checkTablet.virtual_anlas_balance, -275, "Linked tablet must inherit user balance");
    assert.strictEqual(checkTablet.metered_allowance, 15, "Linked tablet must inherit user metered allowance");

    // Invariant Check 5: Int64 timestamp fidelity on epoch columns
    const testEpoch = 1762500000000;
    await database.run("UPDATE users SET last_anlas_reset_epoch = ? WHERE user_id = ?", [testEpoch, userId]);

    const checkEpoch = await database.get("SELECT last_anlas_reset_epoch FROM users WHERE user_id = ?", [userId]);
    assert.strictEqual(checkEpoch.last_anlas_reset_epoch, testEpoch, "Epoch columns must retain 64-bit integer timestamp without truncation");

    await database.closeDatabase();
  });
});