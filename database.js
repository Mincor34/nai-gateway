/**
 * DATABASE CONTROLLER (database.js)
 * Architecture Level 0: Stateless persistence engine on module load.
 *
 * This module is the authoritative persistence engine for the NovelAI gateway.
 * It manages persistent device registrations, approval states, blacklists,
 * and system configuration variables.
 *
 * DESIGN PRINCIPLES:
 * 1. Zero top-level connection side-effects or ambient environment coupling.
 * 2. Complete dormancy until initDatabase(explicitPath) is explicitly invoked.
 * 3. Strict State Enforcement: Fails fast on concurrent boot attempts and in-flight teardowns.
 * 4. TOCTOU-safe transactional migrations executed entirely under BEGIN IMMEDIATE.
 * 5. Strict encapsulation: suppresses raw handle leakage completely. Higher layers interact via run/get/all.
 */

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
          // Enforce WAL mode and a 5000ms busy timeout to prevent SQLITE_BUSY crashes under concurrency
          await execRun(newDb, "PRAGMA journal_mode = WAL;");
          await execRun(newDb, "PRAGMA busy_timeout = 5000;");

          // Canonical Devices Table: Created with all modern columns upfront
          await execRun(newDb, `CREATE TABLE IF NOT EXISTS devices (
            browser_id TEXT PRIMARY KEY,
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
            last_allowance_update_at INTEGER
          )`);
          
          // Canonical Banned Discords Table
          await execRun(newDb, `CREATE TABLE IF NOT EXISTS banned_discords (
            discord_id TEXT PRIMARY KEY,
            banned_at INTEGER NOT NULL,
            reason TEXT,
            is_notified INTEGER NOT NULL DEFAULT 0
          )`);
          
          // Config Table: System key-value configurations (e.g., master token)
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

          // Backward-Compatibility Migrations for Legacy Schemas:
          // Executed ENTIRELY inside BEGIN IMMEDIATE to eliminate TOCTOU inspection races
          await execRun(newDb, "BEGIN IMMEDIATE;");
          try {
            const deviceCols = await execAll(newDb, "PRAGMA table_info(devices)");
            const hasCol = (name) => deviceCols.some(row => row.name === name);

            const legacyDeviceColumns = [
              { name: 'discord_id', ddl: "ALTER TABLE devices ADD COLUMN discord_id TEXT" },
              { name: 'anlas_consumed', ddl: "ALTER TABLE devices ADD COLUMN anlas_consumed INTEGER NOT NULL DEFAULT 0" },
              { name: 'banned', ddl: "ALTER TABLE devices ADD COLUMN banned INTEGER NOT NULL DEFAULT 0" },
              { name: 'total_requests', ddl: "ALTER TABLE devices ADD COLUMN total_requests INTEGER NOT NULL DEFAULT 0" },
              { name: 'last_active_at', ddl: "ALTER TABLE devices ADD COLUMN last_active_at INTEGER" },
              { name: 'discord_username', ddl: "ALTER TABLE devices ADD COLUMN discord_username TEXT" },
              { name: 'metered_allowance', ddl: "ALTER TABLE devices ADD COLUMN metered_allowance INTEGER DEFAULT 100" },
              { name: 'last_allowance_update_at', ddl: "ALTER TABLE devices ADD COLUMN last_allowance_update_at INTEGER" }
            ];

            for (const migration of legacyDeviceColumns) {
              if (!hasCol(migration.name)) {
                await execRun(newDb, migration.ddl);
              }
            }

            const banCols = await execAll(newDb, "PRAGMA table_info(banned_discords)");
            const hasBanCol = (name) => banCols.some(row => row.name === name);
            if (!hasBanCol('is_notified')) {
              await execRun(newDb, "ALTER TABLE banned_discords ADD COLUMN is_notified INTEGER NOT NULL DEFAULT 0");
            }

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