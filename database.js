/**
 * DATABASE CONTROLLER (database.js)
 * Architecture Level 0: Stateless persistence engine on module load.
 *
 * This module is the authoritative persistence engine for the NovelAI gateway.
 * It manages persistent device registrations, approval states, blacklists,
 * financial ledgers, and system configuration variables.
 *
 * DESIGN PRINCIPLES:
 * 1. Zero top-level connection side-effects or ambient environment coupling.
 * 2. Complete dormancy until initDatabase(explicitPath) is explicitly invoked.
 * 3. Strict State Enforcement: Fails fast on concurrent boot attempts and in-flight teardowns.
 * 4. TOCTOU-safe transactional migrations executed entirely under BEGIN IMMEDIATE.
 * 5. Strict encapsulation: suppresses raw handle leakage completely. Higher layers interact via run/get/all.
 * 6. Relational Normalization (Option 1): Maintains canonical users table for authoritative principal state
 *    while preserving legacy column contracts and synchronizing via SQLite triggers for complete zero-regression safety.
 * 7. Negative Ledger Invariant: Preserves integer precision on negative balance states (overdrafts) without float casting.
 */

'use strict';

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Dormant connection state
let db = null;
let activeDatabasePath = null;
let isInitializing = false;
let isClosing = false;

/**
 * Asserts that the database connection instance is initialized and active.
 *
 * @throws {Error} If called while the connection handle is null, closing, or uninitialized.
 */
function assertInitialized() {
  if (isClosing) {
    throw new Error("[Database Error] Database is currently terminating. Queries are rejected.");
  }
  if (!db) {
    throw new Error("[Database Error] Database has not been initialized. Call initDatabase(dbPath) before executing queries.");
  }
}

/**
 * Low-level promisified query execution helper for migration sequencing.
 *
 * @param {sqlite3.Database} dbHandle - Target database handle.
 * @param {string} sql - SQL command string.
 * @param {Array} [params=[]] - Query parameters.
 * @returns {Promise<object>} Resolves with query context.
 */
function execRun(dbHandle, sql, params = []) {
  return new Promise((resolve, reject) => {
    dbHandle.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

/**
 * Low-level promisified batch retrieval helper for migration sequencing.
 *
 * @param {sqlite3.Database} dbHandle - Target database handle.
 * @param {string} sql - SQL command string.
 * @param {Array} [params=[]] - Query parameters.
 * @returns {Promise<Array>} Resolves with rows.
 */
function execAll(dbHandle, sql, params = []) {
  return new Promise((resolve, reject) => {
    dbHandle.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

/**
 * Initializes the SQLite database handle and guarantees canonical schema preparation.
 *
 * @param {string} targetPath - Mandatory explicit target path for the SQLite database file.
 * @returns {Promise<void>} Resolves when the schema is verified, migrated, and ready.
 * @throws {Error} If path is missing, if invoked concurrently, or if teardown is in flight.
 */
const initDatabase = async (targetPath) => {
  if (!targetPath || typeof targetPath !== 'string' || targetPath.trim() === '') {
    throw new Error("[Database Error] initDatabase requires an explicit, non-empty database file path.");
  }

  const resolvedPath = path.isAbsolute(targetPath) 
    ? targetPath 
    : path.resolve(process.cwd(), targetPath);

  if (isClosing) {
    throw new Error("[Database Error] Teardown collision: Database is actively shutting down. Re-initialization rejected.");
  }

  if (isInitializing) {
    throw new Error("[Database Error] Boot sequence collision: Initialization is already in progress. Concurrent database boots are forbidden.");
  }

  if (db) {
    if (activeDatabasePath === resolvedPath) {
      return; // Idempotent no-op for matching target
    }
    throw new Error("[Database Error] Database is already actively connected to a different path. Explicitly close it before swapping targets.");
  }

  isInitializing = true;

  try {
    await new Promise((resolve, reject) => {
      const newDb = new sqlite3.Database(resolvedPath, async (err) => {
        if (err) {
          newDb.close(() => {});
          return reject(err);
        }

        try {
          // Enforce WAL mode, foreign keys, and busy timeout
          await execRun(newDb, "PRAGMA journal_mode = WAL;");
          await execRun(newDb, "PRAGMA busy_timeout = 5000;");
          await execRun(newDb, "PRAGMA foreign_keys = ON;");

          // Canonical Users Table: The authoritative entity for quotas, allowances, tiers, bans, and compute ledgers
          await execRun(newDb, `CREATE TABLE IF NOT EXISTS users (
            user_id TEXT PRIMARY KEY,
            priority_tier TEXT NOT NULL DEFAULT 'Normal',
            banned INTEGER NOT NULL DEFAULT 0,
            ban_reason TEXT,
            ban_notified INTEGER NOT NULL DEFAULT 0,
            anlas_consumed INTEGER NOT NULL DEFAULT 0,
            metered_allowance INTEGER DEFAULT 100,
            last_allowance_update_at INTEGER,
            discord_username TEXT,
            virtual_anlas_balance INTEGER NOT NULL DEFAULT 0,
            last_anlas_reset_epoch INTEGER,
            v5_banked_balance INTEGER NOT NULL DEFAULT 0,
            v5_last_accrual_epoch INTEGER,
            v5_daily_consumed INTEGER NOT NULL DEFAULT 0,
            subscription_period_anlas INTEGER NOT NULL DEFAULT 0,
            subscription_period_v5 INTEGER NOT NULL DEFAULT 0,
            subscription_period_start_epoch INTEGER
          )`);

          // Canonical Devices Table: Created with complete column set to guarantee backwards compatibility
          await execRun(newDb, `CREATE TABLE IF NOT EXISTS devices (
            browser_id TEXT PRIMARY KEY,
            user_id TEXT,
            device_secret TEXT NOT NULL,
            label TEXT,
            priority_tier TEXT NOT NULL DEFAULT 'Normal',
            approved INTEGER NOT NULL DEFAULT 0,
            banned INTEGER NOT NULL DEFAULT 0,
            total_requests INTEGER NOT NULL DEFAULT 0,
            last_active_at INTEGER,
            discord_id TEXT,
            discord_username TEXT,
            anlas_consumed INTEGER NOT NULL DEFAULT 0,
            metered_allowance INTEGER DEFAULT 100,
            last_allowance_update_at INTEGER,
            virtual_anlas_balance INTEGER NOT NULL DEFAULT 0,
            v5_banked_balance INTEGER NOT NULL DEFAULT 0
          )`);
          
          // Canonical Banned Discords Table: Preserved for legacy contract assertions
          await execRun(newDb, `CREATE TABLE IF NOT EXISTS banned_discords (
            discord_id TEXT PRIMARY KEY,
            banned_at INTEGER NOT NULL,
            reason TEXT,
            is_notified INTEGER NOT NULL DEFAULT 0
          )`);
          
          // Config Table: System key-value configurations (e.g., master token, surplus pool)
          await execRun(newDb, `CREATE TABLE IF NOT EXISTS config (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          )`);

          // Device Sessions: Daily allocation tracker enforcing metered usage limits
          await execRun(newDb, `CREATE TABLE IF NOT EXISTS device_sessions (
            browser_id TEXT NOT NULL,
            session_date TEXT NOT NULL,
            session_count INTEGER NOT NULL DEFAULT 0,
            last_session_at INTEGER NOT NULL,
            PRIMARY KEY (browser_id, session_date)
          )`);

          // Backward-Compatibility Migrations & Trigger Setup inside BEGIN IMMEDIATE
          await execRun(newDb, "BEGIN IMMEDIATE;");
          try {
            // 1. Transactional Migration for users table
            const userCols = await execAll(newDb, "PRAGMA table_info(users)");
            const hasUserCol = (name) => userCols.some(row => row.name === name);

            const userColumnsToAdd = [
              { name: 'virtual_anlas_balance', ddl: "ALTER TABLE users ADD COLUMN virtual_anlas_balance INTEGER NOT NULL DEFAULT 0" },
              { name: 'last_anlas_reset_epoch', ddl: "ALTER TABLE users ADD COLUMN last_anlas_reset_epoch INTEGER" },
              { name: 'v5_banked_balance', ddl: "ALTER TABLE users ADD COLUMN v5_banked_balance INTEGER NOT NULL DEFAULT 0" },
              { name: 'v5_last_accrual_epoch', ddl: "ALTER TABLE users ADD COLUMN v5_last_accrual_epoch INTEGER" },
              { name: 'v5_daily_consumed', ddl: "ALTER TABLE users ADD COLUMN v5_daily_consumed INTEGER NOT NULL DEFAULT 0" },
              { name: 'subscription_period_anlas', ddl: "ALTER TABLE users ADD COLUMN subscription_period_anlas INTEGER NOT NULL DEFAULT 0" },
              { name: 'subscription_period_v5', ddl: "ALTER TABLE users ADD COLUMN subscription_period_v5 INTEGER NOT NULL DEFAULT 0" },
              { name: 'subscription_period_start_epoch', ddl: "ALTER TABLE users ADD COLUMN subscription_period_start_epoch INTEGER" }
            ];

            for (const migration of userColumnsToAdd) {
              if (!hasUserCol(migration.name)) {
                await execRun(newDb, migration.ddl);
              }
            }

            // 2. Transactional Migration for devices table (includes label, priority_tier, approved defensively)
            const deviceCols = await execAll(newDb, "PRAGMA table_info(devices)");
            const hasCol = (name) => deviceCols.some(row => row.name === name);

            const legacyDeviceColumns = [
              { name: 'user_id', ddl: "ALTER TABLE devices ADD COLUMN user_id TEXT" },
              { name: 'label', ddl: "ALTER TABLE devices ADD COLUMN label TEXT" },
              { name: 'priority_tier', ddl: "ALTER TABLE devices ADD COLUMN priority_tier TEXT NOT NULL DEFAULT 'Normal'" },
              { name: 'approved', ddl: "ALTER TABLE devices ADD COLUMN approved INTEGER NOT NULL DEFAULT 0" },
              { name: 'discord_id', ddl: "ALTER TABLE devices ADD COLUMN discord_id TEXT" },
              { name: 'anlas_consumed', ddl: "ALTER TABLE devices ADD COLUMN anlas_consumed INTEGER NOT NULL DEFAULT 0" },
              { name: 'banned', ddl: "ALTER TABLE devices ADD COLUMN banned INTEGER NOT NULL DEFAULT 0" },
              { name: 'total_requests', ddl: "ALTER TABLE devices ADD COLUMN total_requests INTEGER NOT NULL DEFAULT 0" },
              { name: 'last_active_at', ddl: "ALTER TABLE devices ADD COLUMN last_active_at INTEGER" },
              { name: 'discord_username', ddl: "ALTER TABLE devices ADD COLUMN discord_username TEXT" },
              { name: 'metered_allowance', ddl: "ALTER TABLE devices ADD COLUMN metered_allowance INTEGER DEFAULT 100" },
              { name: 'last_allowance_update_at', ddl: "ALTER TABLE devices ADD COLUMN last_allowance_update_at INTEGER" },
              { name: 'virtual_anlas_balance', ddl: "ALTER TABLE devices ADD COLUMN virtual_anlas_balance INTEGER NOT NULL DEFAULT 0" },
              { name: 'v5_banked_balance', ddl: "ALTER TABLE devices ADD COLUMN v5_banked_balance INTEGER NOT NULL DEFAULT 0" }
            ];

            for (const migration of legacyDeviceColumns) {
              if (!hasCol(migration.name)) {
                await execRun(newDb, migration.ddl);
              }
            }

            // 3. Transactional Migration for banned_discords
            const banCols = await execAll(newDb, "PRAGMA table_info(banned_discords)");
            const hasBanCol = (name) => banCols.some(row => row.name === name);
            if (!hasBanCol('is_notified')) {
              await execRun(newDb, "ALTER TABLE banned_discords ADD COLUMN is_notified INTEGER NOT NULL DEFAULT 0");
            }

            // 4. Seed ACS-1 Dynamic Cluster Surplus Keys into config table
            await execRun(newDb, `INSERT OR IGNORE INTO config (key, value) VALUES ('v5_surplus_pool', '0')`);
            await execRun(newDb, `INSERT OR IGNORE INTO config (key, value) VALUES ('v5_surplus_last_accrual', '0')`);

            // 5. Populate users table from pre-existing devices records, prioritizing canonical user_id
            await execRun(newDb, `
              INSERT OR IGNORE INTO users (
                user_id, priority_tier, banned, anlas_consumed, metered_allowance, last_allowance_update_at, discord_username,
                virtual_anlas_balance, v5_banked_balance
              )
              SELECT 
                COALESCE(user_id, discord_id, browser_id), priority_tier, banned, anlas_consumed, COALESCE(metered_allowance, 100), last_allowance_update_at, discord_username,
                COALESCE(virtual_anlas_balance, 0), COALESCE(v5_banked_balance, 0)
              FROM devices
            `);

            await execRun(newDb, `
              UPDATE devices SET user_id = COALESCE(user_id, discord_id, browser_id) WHERE user_id IS NULL
            `);

            // 6. Reset triggers to modern schema definitions
            await execRun(newDb, "DROP TRIGGER IF EXISTS trg_sync_devices_insert;");
            await execRun(newDb, "DROP TRIGGER IF EXISTS trg_sync_devices_update_allowance;");
            await execRun(newDb, "DROP TRIGGER IF EXISTS trg_sync_users_update_allowance;");
            await execRun(newDb, "DROP TRIGGER IF EXISTS trg_sync_devices_update_balances;");
            await execRun(newDb, "DROP TRIGGER IF EXISTS trg_sync_users_update_balances;");
            await execRun(newDb, "DROP TRIGGER IF EXISTS trg_sync_devices_update_user_id;");
            await execRun(newDb, "DROP TRIGGER IF EXISTS trg_sync_banned_discords_insert;");
            await execRun(newDb, "DROP TRIGGER IF EXISTS trg_sync_banned_discords_delete;");

            // 7. Bidirectional Synchronization Triggers
            await execRun(newDb, `
              CREATE TRIGGER IF NOT EXISTS trg_sync_devices_insert
              AFTER INSERT ON devices
              BEGIN
                INSERT INTO users (
                  user_id, priority_tier, banned, anlas_consumed, metered_allowance, last_allowance_update_at, discord_username,
                  virtual_anlas_balance, v5_banked_balance
                ) VALUES (
                  COALESCE(NEW.user_id, NEW.discord_id, NEW.browser_id),
                  COALESCE(NEW.priority_tier, 'Normal'),
                  COALESCE(NEW.banned, 0),
                  COALESCE(NEW.anlas_consumed, 0),
                  COALESCE(NEW.metered_allowance, 100),
                  COALESCE(NEW.last_allowance_update_at, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
                  NEW.discord_username,
                  COALESCE(NEW.virtual_anlas_balance, 0),
                  COALESCE(NEW.v5_banked_balance, 0)
                )
                ON CONFLICT(user_id) DO UPDATE SET
                  banned = MAX(users.banned, excluded.banned),
                  priority_tier = CASE WHEN excluded.priority_tier != 'Normal' THEN excluded.priority_tier ELSE users.priority_tier END;

                UPDATE devices SET 
                  user_id = COALESCE(NEW.user_id, NEW.discord_id, NEW.browser_id),
                  metered_allowance = (SELECT metered_allowance FROM users WHERE user_id = COALESCE(NEW.user_id, NEW.discord_id, NEW.browser_id)),
                  last_allowance_update_at = (SELECT last_allowance_update_at FROM users WHERE user_id = COALESCE(NEW.user_id, NEW.discord_id, NEW.browser_id)),
                  virtual_anlas_balance = COALESCE((SELECT virtual_anlas_balance FROM users WHERE user_id = COALESCE(NEW.user_id, NEW.discord_id, NEW.browser_id)), 0),
                  v5_banked_balance = COALESCE((SELECT v5_banked_balance FROM users WHERE user_id = COALESCE(NEW.user_id, NEW.discord_id, NEW.browser_id)), 0)
                WHERE browser_id = NEW.browser_id;
              END;
            `);

            await execRun(newDb, `
              CREATE TRIGGER IF NOT EXISTS trg_sync_devices_update_allowance
              AFTER UPDATE OF metered_allowance, last_allowance_update_at ON devices
              WHEN (OLD.metered_allowance IS NOT NEW.metered_allowance OR OLD.last_allowance_update_at IS NOT NEW.last_allowance_update_at)
              BEGIN
                UPDATE users SET
                  metered_allowance = NEW.metered_allowance,
                  last_allowance_update_at = NEW.last_allowance_update_at
                WHERE user_id = COALESCE(NEW.user_id, NEW.discord_id, NEW.browser_id);
              END;
            `);

            await execRun(newDb, `
              CREATE TRIGGER IF NOT EXISTS trg_sync_users_update_allowance
              AFTER UPDATE OF metered_allowance, last_allowance_update_at ON users
              WHEN (OLD.metered_allowance IS NOT NEW.metered_allowance OR OLD.last_allowance_update_at IS NOT NEW.last_allowance_update_at)
              BEGIN
                UPDATE devices SET
                  metered_allowance = NEW.metered_allowance,
                  last_allowance_update_at = NEW.last_allowance_update_at
                WHERE user_id = NEW.user_id OR discord_id = NEW.user_id;
              END;
            `);

            await execRun(newDb, `
              CREATE TRIGGER IF NOT EXISTS trg_sync_devices_update_balances
              AFTER UPDATE OF virtual_anlas_balance, v5_banked_balance ON devices
              WHEN (OLD.virtual_anlas_balance IS NOT NEW.virtual_anlas_balance OR OLD.v5_banked_balance IS NOT NEW.v5_banked_balance)
              BEGIN
                UPDATE users SET
                  virtual_anlas_balance = NEW.virtual_anlas_balance,
                  v5_banked_balance = NEW.v5_banked_balance
                WHERE user_id = COALESCE(NEW.user_id, NEW.discord_id, NEW.browser_id);
              END;
            `);

            await execRun(newDb, `
              CREATE TRIGGER IF NOT EXISTS trg_sync_users_update_balances
              AFTER UPDATE OF virtual_anlas_balance, v5_banked_balance ON users
              WHEN (OLD.virtual_anlas_balance IS NOT NEW.virtual_anlas_balance OR OLD.v5_banked_balance IS NOT NEW.v5_banked_balance)
              BEGIN
                UPDATE devices SET
                  virtual_anlas_balance = NEW.virtual_anlas_balance,
                  v5_banked_balance = NEW.v5_banked_balance
                WHERE user_id = NEW.user_id OR discord_id = NEW.user_id;
              END;
            `);

            await execRun(newDb, `
              CREATE TRIGGER IF NOT EXISTS trg_sync_devices_update_user_id
              AFTER UPDATE OF user_id ON devices
              WHEN (OLD.user_id IS NOT NEW.user_id AND NEW.user_id IS NOT NULL)
              BEGIN
                UPDATE devices SET
                  metered_allowance = (SELECT metered_allowance FROM users WHERE user_id = NEW.user_id),
                  last_allowance_update_at = (SELECT last_allowance_update_at FROM users WHERE user_id = NEW.user_id),
                  virtual_anlas_balance = COALESCE((SELECT virtual_anlas_balance FROM users WHERE user_id = NEW.user_id), 0),
                  v5_banked_balance = COALESCE((SELECT v5_banked_balance FROM users WHERE user_id = NEW.user_id), 0)
                WHERE browser_id = NEW.browser_id;
              END;
            `);

            await execRun(newDb, `
              CREATE TRIGGER IF NOT EXISTS trg_sync_banned_discords_insert
              AFTER INSERT ON banned_discords
              BEGIN
                UPDATE users SET banned = 1, ban_reason = NEW.reason, ban_notified = NEW.is_notified WHERE user_id = NEW.discord_id;
                UPDATE devices SET banned = 1 WHERE discord_id = NEW.discord_id OR user_id = NEW.discord_id;
              END;
            `);

            await execRun(newDb, `
              CREATE TRIGGER IF NOT EXISTS trg_sync_banned_discords_delete
              AFTER DELETE ON banned_discords
              BEGIN
                UPDATE users SET banned = 0, ban_reason = NULL, ban_notified = 0 WHERE user_id = OLD.discord_id;
                UPDATE devices SET banned = 0 WHERE discord_id = OLD.discord_id OR user_id = OLD.discord_id;
              END;
            `);

            await execRun(newDb, "COMMIT;");
          } catch (txErr) {
            await execRun(newDb, "ROLLBACK;");
            throw txErr;
          }

          db = newDb;
          activeDatabasePath = resolvedPath;
          resolve();
        } catch (migrationErr) {
          newDb.close(() => {});
          reject(migrationErr);
        }
      });
    });
  } finally {
    isInitializing = false;
  }
};

/**
 * Closes the active SQLite database connection cleanly and flushes OS file locks.
 * Prevents race conditions by maintaining an isClosing lock until the driver finishes teardown.
 *
 * @returns {Promise<void>} Resolves when the connection is fully terminated.
 */
const closeDatabase = () => {
  return new Promise((resolve, reject) => {
    if (isInitializing) {
      return reject(new Error("[Database Error] Cannot close database while initialization is actively running."));
    }
    if (isClosing) {
      return reject(new Error("[Database Error] Database teardown is already in progress."));
    }
    if (!db) {
      activeDatabasePath = null;
      return resolve();
    }
    
    isClosing = true;
    const currentHandle = db;

    currentHandle.close((err) => {
      db = null;
      activeDatabasePath = null;
      isClosing = false;

      if (err) reject(err);
      else resolve();
    });
  });
};

/**
 * Execute a modifying query (INSERT, UPDATE, DELETE).
 *
 * @param {string} sql - SQL template string.
 * @param {Array} [params=[]] - Query binding parameters.
 * @returns {Promise<object>} Resolves with the execution context (this.changes, this.lastID).
 */
const run = (sql, params = []) => new Promise((resolve, reject) => {
  try {
    assertInitialized();
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  } catch (err) {
    reject(err);
  }
});

/**
 * Query a single record.
 *
 * @param {string} sql - SQL query string.
 * @param {Array} [params=[]] - Query binding parameters.
 * @returns {Promise<object|undefined>} Resolves with the matched record or undefined.
 */
const get = (sql, params = []) => new Promise((resolve, reject) => {
  try {
    assertInitialized();
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  } catch (err) {
    reject(err);
  }
});

/**
 * Query all matching records.
 *
 * @param {string} sql - SQL query string.
 * @param {Array} [params=[]] - Query binding parameters.
 * @returns {Promise<Array>} Resolves with the array of matched rows.
 */
const all = (sql, params = []) => new Promise((resolve, reject) => {
  try {
    assertInitialized();
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  } catch (err) {
    reject(err);
  }
});

module.exports = {
  initDatabase,
  closeDatabase,
  run,
  get,
  all
};