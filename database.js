/**
 * DATABASE CONTROLLER (database.js)
 *
 * This module manages persistent device registration, approval states, and 
 * encrypted master configuration tokens using an embedded SQLite database.
 * 
 * Safety Mechanisms:
 * - Table configurations use strict schema typing.
 * - Transactions and run/get utilities are wrapped in Promises to ensure clean 
 *   asynchronous control flow without blocking the Express event loop.
 */

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Allow the database file path to be set via environment variable with a default fallback
const dbFilename = process.env.DATABASE_PATH || 'data.db';
const dbPath = path.isAbsolute(dbFilename) 
  ? dbFilename 
  : path.join(__dirname, dbFilename);

const db = new sqlite3.Database(dbPath);

// Synchronously initialize required schema definitions
db.serialize(() => {
  // Device registrations
  db.run(`CREATE TABLE IF NOT EXISTS devices (
    browser_id TEXT PRIMARY KEY,
    device_secret TEXT NOT NULL,
    label TEXT,
    priority_tier TEXT NOT NULL DEFAULT 'Normal',
    approved INTEGER NOT NULL DEFAULT 0
  )`);
  
  // Encrypted or sensitive master session configurations
  db.run(`CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);
});

/**
 * Execute SQL query with no return value (INSERT, UPDATE, DELETE).
 */
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

module.exports = { db, run, get, all };