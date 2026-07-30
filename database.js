/**
 * DATABASE CONTROLLER (database.js)
 *
 * Manages persistent device registrations, approval states, blacklists,
 * and configurations. Uses promise boundaries to guarantee schemas are fully
 * prepared prior to mounting Express listeners.
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbFilename = process.env.DATABASE_PATH || 'staging_data.db';
const dbPath = path.isAbsolute(dbFilename) 
  ? dbFilename 
  : path.join(__dirname, dbFilename);

const db = new sqlite3.Database(dbPath);

/**
 * Ensures schemas and migrations are fully executed sequentially.
 * Blocks server startup on failure.
 */
const initDatabase = () => {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // Initial Table Setup
      db.run(`CREATE TABLE IF NOT EXISTS devices (
        browser_id TEXT PRIMARY KEY,
        device_secret TEXT NOT NULL,
        label TEXT,
        priority_tier TEXT NOT NULL DEFAULT 'Normal',
        approved INTEGER NOT NULL DEFAULT 0,
        discord_id TEXT
      )`, (err) => { if (err) return reject(err); });
      
      db.run(`CREATE TABLE IF NOT EXISTS banned_discords (
        discord_id TEXT PRIMARY KEY,
        banned_at INTEGER NOT NULL,
        reason TEXT
      )`, (err) => { if (err) return reject(err); });
      
      db.run(`CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`, (err) => { if (err) return reject(err); });

      // Daily Session Tracker: Enforces the 6 x 30-minute daily constraints for Metered tiers
      db.run(`CREATE TABLE IF NOT EXISTS device_sessions (
        browser_id TEXT NOT NULL,
        session_date TEXT NOT NULL,
        session_count INTEGER NOT NULL DEFAULT 0,
        last_session_at INTEGER NOT NULL,
        PRIMARY KEY (browser_id, session_date)
      )`, (err) => { if (err) return reject(err); });

      // Schema Migration Check
      db.all("PRAGMA table_info(devices)", (err, rows) => {
        if (err) return reject(err);
        
        const hasDiscordId = rows.some(row => row.name === 'discord_id');
        if (!hasDiscordId) {
          db.run("ALTER TABLE devices ADD COLUMN discord_id TEXT", (alterErr) => {
            if (alterErr) return reject(alterErr);
            console.log("[Database] Migration complete: 'discord_id' column appended.");
            resolve();
          });
        } else {
          resolve();
        }
      });
    });
  });
};

const run = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function(err) {
    if (err) reject(err);
    else resolve(this);
  });
});

/**
 * Fetch a single database record matching query criteria.
 */
const get = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => {
    if (err) reject(err);
    else resolve(row);
  });
});

/**
 * Retrieve all records matching query criteria.
 */
const all = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => {
    if (err) reject(err);
    else resolve(rows);
  });
});

module.exports = { db, initDatabase, run, get, all };