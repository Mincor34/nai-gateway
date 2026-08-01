/**
 * DATABASE CONTROLLER (database.js)
 *
 * This module is the authoritative persistence engine for the NovelAI gateway.
 * It manages persistent device registrations, approval states, blacklists,
 * and system configuration variables.
 *
 * DESIGN PRINCIPLE:
 * To prevent Express mount races, this module uses Promise boundaries to guarantee 
 * schemas and additive structural migrations are fully prepared and verified prior to 
 * binding network listeners in server.js.
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Port and file configurations are derived dynamically from env properties
const dbFilename = process.env.DATABASE_PATH || 'staging_data.db';
const dbPath = path.isAbsolute(dbFilename) 
  ? dbFilename 
  : path.join(__dirname, dbFilename);

const db = new sqlite3.Database(dbPath);

/**
 * Executes schema boots and additive migrations sequentially inside a transaction block.
 * Forces an immediate exit of the engine if critical schema modifications fail.
 *
 * @returns {Promise<void>} Resolves when the schema is verified and ready.
 */
const initDatabase = () => {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // Devices Table: Primary registration map linking browser hardware to Discord accounts
      db.run(`CREATE TABLE IF NOT EXISTS devices (
        browser_id TEXT PRIMARY KEY,
        device_secret TEXT NOT NULL,
        label TEXT,
        priority_tier TEXT NOT NULL DEFAULT 'Normal',
        approved INTEGER NOT NULL DEFAULT 0,
        discord_id TEXT,
        anlas_consumed INTEGER NOT NULL DEFAULT 0
      )`, (err) => { if (err) return reject(err); });
      
      // Banned Discords Table: Local firewall block list preventing re-registration
      db.run(`CREATE TABLE IF NOT EXISTS banned_discords (
        discord_id TEXT PRIMARY KEY,
        banned_at INTEGER NOT NULL,
        reason TEXT,
        is_notified INTEGER NOT NULL DEFAULT 0
      )`, (err) => { if (err) return reject(err); });
      
      // Config Table: Encrypted system variables (e.g. master account session token)
      db.run(`CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`, (err) => { if (err) return reject(err); });

      // Device Sessions: Daily allocation tracker enforcing metered usage limits
      db.run(`CREATE TABLE IF NOT EXISTS device_sessions (
        browser_id TEXT NOT NULL,
        session_date TEXT NOT NULL,
        session_count INTEGER NOT NULL DEFAULT 0,
        last_session_at INTEGER NOT NULL,
        PRIMARY KEY (browser_id, session_date)
      )`, (err) => { if (err) return reject(err); });

      // Additive Migrations: Ensures backward-compatible schema evolutions
      db.all("PRAGMA table_info(devices)", (err, rows) => {
        if (err) return reject(err);
        
        const hasDiscordId = rows.some(row => row.name === 'discord_id');
        const hasAnlas = rows.some(row => row.name === 'anlas_consumed');
        const hasBanned = rows.some(row => row.name === 'banned');
        const hasTotalRequests = rows.some(row => row.name === 'total_requests');
        const hasLastActiveAt = rows.some(row => row.name === 'last_active_at');
        const hasDiscordUsername = rows.some(row => row.name === 'discord_username');
        
        // Purely additive alterations
        if (!hasDiscordId) {
          db.run("ALTER TABLE devices ADD COLUMN discord_id TEXT");
        }
        if (!hasAnlas) {
          db.run("ALTER TABLE devices ADD COLUMN anlas_consumed INTEGER NOT NULL DEFAULT 0");
        }
        if (!hasBanned) {
          db.run("ALTER TABLE devices ADD COLUMN banned INTEGER NOT NULL DEFAULT 0");
        }
        if (!hasTotalRequests) {
          db.run("ALTER TABLE devices ADD COLUMN total_requests INTEGER NOT NULL DEFAULT 0");
        }
        if (!hasLastActiveAt) {
          db.run("ALTER TABLE devices ADD COLUMN last_active_at INTEGER");
        }
        if (!hasDiscordUsername) {
          db.run("ALTER TABLE devices ADD COLUMN discord_username TEXT");
        }
        
        // Audit notification metrics inside block list table
        db.all("PRAGMA table_info(banned_discords)", (banErr, banRows) => {
          if (banErr) return reject(banErr);
          const hasNotified = banRows.some(row => row.name === 'is_notified');
          if (!hasNotified) {
            db.run("ALTER TABLE banned_discords ADD COLUMN is_notified INTEGER NOT NULL DEFAULT 0");
          }
          resolve();
        });
      });
    });
  });
};

/**
 * Execute a modifying query (INSERT, UPDATE, DELETE).
 *
 * @param {string} sql - SQL template string.
 * @param {Array} params - Query binding parameters.
 * @returns {Promise<object>} Resolves with the execution context (this.changes, this.lastID).
 */
const run = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function(err) {
    if (err) reject(err);
    else resolve(this);
  });
});

/**
 * Query a single record.
 *
 * @param {string} sql - SQL query string.
 * @param {Array} params - Query binding parameters.
 * @returns {Promise<object|undefined>} Resolves with the matched record or undefined.
 */
const get = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => {
    if (err) reject(err);
    else resolve(row);
  });
});

/**
 * Query all matching records.
 *
 * @param {string} sql - SQL query string.
 * @param {Array} params - Query binding parameters.
 * @returns {Promise<Array>} Resolves with the array of matched rows.
 */
const all = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => {
    if (err) reject(err);
    else resolve(rows);
  });
});

module.exports = { db, initDatabase, run, get, all };