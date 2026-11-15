/**
 * PHASE 8 COMMIT 4 VERIFICATION HARNESS (test/phase8_commit4_ledger_accrual.test.js)
 *
 * Exhaustively tests:
 * 1. Architectural Level 2 Isolation Invariant:
 *    - Verifies auditEngine.js imports strictly Level 0 (./database) and Level 1 (./config),
 *      with zero upward dependency on queueManager.js.
 * 2. Happy Path: V5 Lazy Accrual Engine (`evaluateV5Accrual`):
 *    - Accrues daily NCP shares based on proportional tier weights up to v5MaxBankDays (3-day ceiling).
 *    - Sub-day (<24h) evaluations do not double-accrue or reset v5_daily_consumed, while still returning
 *      accurate daily_share_ncp, max_bank_ncp, and total_cluster_weight for downstream HUD telemetry.
 *    - Preserves sub-day remainder drift across multi-day evaluations.
 *    - Guarantees strict integer balances in SQLite (no float truncation drift).
 *    - Validates nominalDailyCompute clamping to [100.0, 300.0] and fail-closed rejections.
 * 3. Happy Path & Hell Path: Rolling 30-Day Anlas Reset (`evaluateAnlasReset`):
 *    - Initial allocation grants tier monthlyAnlas.
 *    - Strict zero rollover: unused positive balance resets cleanly to monthlyAnlas.
 *    - Multi-month inactivity (>90 days) grants 1x monthlyAnlas without stacking.
 *    - Negative overdraft debt offsets fresh tier allocations (both partial recovery and persistent debt).
 *    - Metered tier (0 monthlyAnlas) preserves debt without wiping it.
 *    - Resets subscription_period_anlas and subscription_period_v5 at epoch boundary,
 *      including for database-backed Admin principals without mutating virtual_anlas_balance.
 *    - Freezes banned accounts (`banned = 1`) without resetting balances or period counters.
 * 4. Hell Path: Multi-Device Weight Inflation, Tier Transitions & Banned/Unapproved Exclusion:
 *    - User with 3 approved devices counts once in W_all (zero weight inflation).
 *    - Banned and unapproved users contribute 0 weight to W_all and accrue 0 NCP.
 *    - Metered principals do not stamp v5_last_accrual_epoch, allowing immediate accrual on upgrade,
 *      while downgrading to Metered caps prior banked NCP to 0.
 *    - Temporary revocation or ban preserves existing banked V5 NCP and leaves v5_last_accrual_epoch untouched.
 *    - Unapproved onboarding polling does not poison v5_last_accrual_epoch prior to approval.
 *    - Division-by-zero protection when total cluster weight is 0.
 * 5. Hell Path: Cross-Channel Double-Spend Race & Stage 1 Base-Paid Bypass Denial:
 *    - Channel A reservation hold (QueueCoordinator) + Channel B vibe hold (activeTextLocks)
 *      aggregated via queueManager.getHeldAnlasForUser() and injected into Level 2.
 *    - Rejects concurrent Channel B or Channel A spend exceeding available balance (HTTP 403 INSUFFICIENT_ANLAS).
 *    - Rejects Stage 1 `isBasePaid: true, declaredAnlas: 0` against both 0-balance (`403 INSUFFICIENT_ANLAS`)
 *      and solvent (`400 SPEND_CAP_EXCEEDED`) principals.
 *    - Releases holds cleanly on completion/eviction and restores spendable capacity.
 * 6. Hell Path: Debt Circumvention Denial (`HTTP 403 DEBT_LOCKED`):
 *    - Account with negative Anlas debt passes 0-Anlas free Opus requests.
 *    - Rejects X-Declared-Anlas > 0, requiredAnlas > 0, or X-Base-Paid: true with HTTP 403 DEBT_LOCKED.
 * 7. Hell Path: Concurrent TOCTOU Accrual & Reset Race:
 *    - 10 simultaneous evaluateV5Accrual / evaluateAnlasReset calls serialize cleanly per user_id.
 * 8. Hell Path: PoNR Ledger Commits, Integer Overdrafts, Admin Infinity Immunity & Fail-Closed Inputs:
 *    - commitAnlasDebit preserves negative overdraft integers and syncs devices via SQLite triggers.
 *    - Database-backed Admin-tier principals track consumption metrics without accumulating phantom negative debt,
 *      and verifyDevice returns virtual_anlas_balance === Infinity for DB-backed Admin principals.
 *    - commitV5Debit treats 0 NCP as a read-only no-op, clamps >0 debits via MAX(0, ...), and increments counters.
 *    - recordSurplusV5Usage ignores synthetic 'admin' and ghost users safely while validating identifiers.
 *    - Admin tier never writes JS Infinity into SQLite INTEGER columns.
 *    - Non-existent principals fail safely without crashing.
 *    - Rejects floats, booleans, negatives, NaN, Infinity, arrays, and whitespace strings.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const fs = require('fs');
const path = require('path');

const { initDatabase, closeDatabase, run, get } = require('../database');
const { createQueueCoordinator } = require('../queueManager');
const { DEFAULT_TIER_CONFIGS, OPERATIONAL_DEFAULTS } = require('../config');
const {
  verifyDevice,
  calculateAvailableBalance,
  evaluateAnlasReset,
  evaluateV5Accrual,
  authorizeAnlasSpend,
  commitAnlasDebit,
  commitV5Debit,
  recordSurplusV5Usage,
  DAY_MS,
  THIRTY_DAYS_MS
} = require('../auditEngine');

const SANDBOX_DB_FILE = path.join(__dirname, 'test_sandbox_phase8_commit4.db');
process.env.ADMIN_SECRET_KEY = 'test_phase8_commit4_admin_key';
process.env.DATABASE_PATH = SANDBOX_DB_FILE;

function cleanupSandbox() {
  [
    SANDBOX_DB_FILE,
    `${SANDBOX_DB_FILE}-journal`,
    `${SANDBOX_DB_FILE}-wal`,
    `${SANDBOX_DB_FILE}-shm`
  ].forEach(f => {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
  });
}

cleanupSandbox();

test('Phase 8 Commit 4: Financial Ledger, Dynamic Balance Derivation & Temporal Accrual Gate', async (t) => {
  await initDatabase(SANDBOX_DB_FILE);

  t.after(async () => {
    await closeDatabase();
    cleanupSandbox();
  });

  // ---------------------------------------------------------------------------
  // 1. ARCHITECTURAL LEVEL 2 ISOLATION INVARIANT
  // ---------------------------------------------------------------------------
  await t.test('Architecture Invariant: auditEngine.js imports only database.js and config.js (blind to queueManager)', () => {
    const aePath = path.resolve(__dirname, '..', 'auditEngine.js');
    const previousCacheEntry = require.cache[aePath];
    const loadedDeps = [];
    const originalLoad = Module._load;

    delete require.cache[aePath];
    Module._load = function(request, parent, isMain) {
      if (parent && parent.filename === aePath) {
        loadedDeps.push(request);
      }
      return originalLoad.apply(this, arguments);
    };

    try {
      require('../auditEngine');
    } finally {
      Module._load = originalLoad;
      if (previousCacheEntry) {
        require.cache[aePath] = previousCacheEntry;
      } else {
        delete require.cache[aePath];
      }
    }

    assert.deepStrictEqual(
      loadedDeps.sort(),
      ['./config', './database'],
      'Level 2 Isolation Invariant: auditEngine.js must depend strictly on ./database and ./config'
    );
  });

  // ---------------------------------------------------------------------------
  // 2. HAPPY PATH: V5 LAZY ACCRUAL & 3-DAY BANKING CEILING
  // ---------------------------------------------------------------------------
  await t.test('Happy Path: evaluateV5Accrual credits integer NCP shares up to 3-day cap and clamps nominalDailyCompute', async () => {
    // Seed Normal (weight 2) and Low (weight 1) approved users => totalWeight = 3
    // Nominal Daily NCP = floor(190.0 * 18) = 3420 NCP
    // Normal daily share = floor(3420 * (2 / 3)) = 2280 NCP; 3-day cap = 6840 NCP
    // Low daily share = floor(3420 * (1 / 3)) = 1140 NCP; 3-day cap = 3420 NCP
    await run("INSERT INTO users (user_id, priority_tier, banned) VALUES ('u_norm_1', 'Normal', 0)");
    await run("INSERT INTO devices (browser_id, user_id, device_secret, approved) VALUES ('b_norm_1', 'u_norm_1', 's1', 1)");

    await run("INSERT INTO users (user_id, priority_tier, banned) VALUES ('u_low_1', 'Low', 0)");
    await run("INSERT INTO devices (browser_id, user_id, device_secret, approved) VALUES ('b_low_1', 'u_low_1', 's2', 1)");

    const t0 = 1760000000000;

    // Initial accrual -> 1 day share (2280 NCP)
    const initNorm = await evaluateV5Accrual('u_norm_1', { now: t0 });
    assert.strictEqual(initNorm.accrual_applied, true);
    assert.strictEqual(initNorm.total_cluster_weight, 3);
    assert.strictEqual(initNorm.daily_share_ncp, 2280);
    assert.strictEqual(initNorm.max_bank_ncp, 6840);
    assert.strictEqual(initNorm.v5_banked_balance, 2280);
    assert.strictEqual(Number.isInteger(initNorm.v5_banked_balance), true);

    // Sub-day check (12h later): must NOT accrue and must preserve v5_daily_consumed,
    // while still reporting non-zero daily_share_ncp, max_bank_ncp, and total_cluster_weight.
    await run("UPDATE users SET v5_daily_consumed = 4 WHERE user_id = 'u_norm_1'");
    const subDay = await evaluateV5Accrual('u_norm_1', { now: t0 + (DAY_MS / 2) });
    assert.strictEqual(subDay.accrual_applied, false);
    assert.strictEqual(subDay.v5_banked_balance, 2280);
    assert.strictEqual(subDay.v5_daily_consumed, 4);
    assert.strictEqual(subDay.total_cluster_weight, 3, 'Sub-day read must return real cluster weight');
    assert.strictEqual(subDay.daily_share_ncp, 2280, 'Sub-day read must return real daily share');
    assert.strictEqual(subDay.max_bank_ncp, 6840, 'Sub-day read must return real max bank cap');

    // 1.5 days after t0 -> accrues 1 day (total 4560), resets daily_consumed, preserves 0.5 day remainder
    const day15 = await evaluateV5Accrual('u_norm_1', { now: t0 + Math.floor(1.5 * DAY_MS) });
    assert.strictEqual(day15.accrual_applied, true);
    assert.strictEqual(day15.v5_banked_balance, 4560);
    assert.strictEqual(day15.v5_daily_consumed, 0);
    assert.strictEqual(day15.v5_last_accrual_epoch, t0 + DAY_MS, 'Must preserve sub-day remainder');

    // Jump 10 days ahead -> capped strictly at 3-day ceiling (6840 NCP)
    const day10 = await evaluateV5Accrual('u_norm_1', { now: t0 + (10 * DAY_MS) });
    assert.strictEqual(day10.accrual_applied, true);
    assert.strictEqual(day10.v5_banked_balance, 6840, 'Balance must cap at 3-day ceiling');

    // Low user check
    const initLow = await evaluateV5Accrual('u_low_1', { now: t0 });
    assert.strictEqual(initLow.v5_banked_balance, 1140);

    // nominalDailyCompute lower/upper clamping ([100.0, 300.0]) and fail-closed rejection
    await run("INSERT INTO users (user_id, priority_tier, banned) VALUES ('u_clamp_low', 'Low', 0)");
    await run("INSERT INTO devices (browser_id, user_id, device_secret, approved) VALUES ('b_clamp_low', 'u_clamp_low', 'scl', 1)");
    // totalWeight = 2 + 1 + 1 = 4; Low weight = 1
    // nominalDailyCompute = 50 -> clamps to 100.0 -> 1800 NCP * (1/4) = 450 NCP
    const clampedMin = await evaluateV5Accrual('u_clamp_low', { now: t0, nominalDailyCompute: 50 });
    assert.strictEqual(clampedMin.daily_share_ncp, 450, 'nominalDailyCompute < 100 must clamp to 100.0');

    // nominalDailyCompute = 999 -> clamps to 300.0 -> 5400 NCP * (1/4) = 1350 NCP
    const clampedMax = await evaluateV5Accrual('u_clamp_low', { now: t0 + DAY_MS, nominalDailyCompute: 999 });
    assert.strictEqual(clampedMax.daily_share_ncp, 1350, 'nominalDailyCompute > 300 must clamp to 300.0');

    for (const badCompute of [0, -10, NaN, Infinity, '190', false, []]) {
      await assert.rejects(
        () => evaluateV5Accrual('u_clamp_low', { now: t0, nominalDailyCompute: badCompute }),
        /positive finite number or null/
      );
    }
  });

  // ---------------------------------------------------------------------------
  // 3. HELL PATH: MULTI-DEVICE WEIGHT INFLATION, TIER TRANSITIONS & PRESERVATION
  // ---------------------------------------------------------------------------
  await t.test('Hell Path: Multi-device users count once in W_all; tier upgrades avoid 24h lock; banned/unapproved preserve bank', async () => {
    // Reset tables for isolated weight matrix
    await run('DELETE FROM devices');
    await run('DELETE FROM users');

    // User A (High, weight 3) has 3 approved devices -> must count ONCE (weight 3)
    await run("INSERT INTO users (user_id, priority_tier, banned) VALUES ('u_multi', 'High', 0)");
    await run("INSERT INTO devices (browser_id, user_id, device_secret, approved) VALUES ('d_m1', 'u_multi', 'sm1', 1)");
    await run("INSERT INTO devices (browser_id, user_id, device_secret, approved) VALUES ('d_m2', 'u_multi', 'sm2', 1)");
    await run("INSERT INTO devices (browser_id, user_id, device_secret, approved) VALUES ('d_m3', 'u_multi', 'sm3', 1)");

    // User B (Normal, weight 2)
    await run("INSERT INTO users (user_id, priority_tier, banned) VALUES ('u_norm_b', 'Normal', 0)");
    await run("INSERT INTO devices (browser_id, user_id, device_secret, approved) VALUES ('d_nb1', 'u_norm_b', 'snb1', 1)");

    // User C (Normal, weight 2) -> totalWeight = 7 (3420 * 3 / 7 = 1465.714...)
    await run("INSERT INTO users (user_id, priority_tier, banned) VALUES ('u_norm_c', 'Normal', 0)");
    await run("INSERT INTO devices (browser_id, user_id, device_secret, approved) VALUES ('d_nc1', 'u_norm_c', 'snc1', 1)");

    // Banned User (High, weight 3) with existing 900 NCP banked -> MUST be excluded from W_all and preserve 900 NCP
    await run("INSERT INTO users (user_id, priority_tier, banned, v5_banked_balance, v5_last_accrual_epoch) VALUES ('u_banned', 'High', 1, 900, 1760900000000)");
    await run("INSERT INTO devices (browser_id, user_id, device_secret, approved) VALUES ('d_ban1', 'u_banned', 'sban', 1)");

    // Unapproved User (High, weight 3) -> MUST be excluded from W_all and leave v5_last_accrual_epoch NULL
    await run("INSERT INTO users (user_id, priority_tier, banned) VALUES ('u_unapproved', 'High', 0)");
    await run("INSERT INTO devices (browser_id, user_id, device_secret, approved) VALUES ('d_unapp1', 'u_unapproved', 'sunapp', 0)");

    // Metered User (weight 0, v5MaxBankDays 0) -> accrues 0 and leaves epoch NULL
    await run("INSERT INTO users (user_id, priority_tier, banned) VALUES ('u_metered', 'Metered', 0)");
    await run("INSERT INTO devices (browser_id, user_id, device_secret, approved) VALUES ('d_met1', 'u_metered', 'smet', 1)");

    const now = 1761000000000;
    const resMulti = await evaluateV5Accrual('u_multi', { now });

    assert.strictEqual(resMulti.total_cluster_weight, 7, 'Multi-device user must count once; banned/unapproved excluded');
    // floor(3420 * 3 / 7) = floor(1465.714285...) = 1465
    assert.strictEqual(resMulti.daily_share_ncp, 1465);
    assert.strictEqual(resMulti.max_bank_ncp, 1465 * 3);
    assert.strictEqual(Number.isInteger(resMulti.v5_banked_balance), true, 'SQLite balance must be strict integer');

    // Banned user must not accrue AND must not have pre-existing bank wiped
    const resBanned = await evaluateV5Accrual('u_banned', { now });
    assert.strictEqual(resBanned.accrual_applied, false);
    assert.strictEqual(resBanned.v5_banked_balance, 900, 'Banned user must not lose existing banked NCP');

    // Unapproved user must not accrue AND must not have epoch poisoned prior to approval
    const resUnapprovedBefore = await evaluateV5Accrual('u_unapproved', { now });
    assert.strictEqual(resUnapprovedBefore.accrual_applied, false);
    assert.strictEqual(resUnapprovedBefore.v5_banked_balance, 0);
    assert.strictEqual(resUnapprovedBefore.v5_last_accrual_epoch, null, 'Unapproved polling must not stamp v5_last_accrual_epoch');

    // Once approved 10 seconds later, user receives initial accrual immediately without 24h starvation
    await run("UPDATE devices SET approved = 1 WHERE browser_id = 'd_unapp1'");
    const resUnapprovedAfter = await evaluateV5Accrual('u_unapproved', { now: now + 10000 });
    assert.strictEqual(resUnapprovedAfter.accrual_applied, true, 'Newly approved user must receive immediate initial accrual');
    assert.ok(resUnapprovedAfter.v5_banked_balance > 0);

    // Temporary revocation of u_multi must NOT wipe its existing banked NCP
    const multiBalanceBeforeRevoke = resMulti.v5_banked_balance;
    await run("UPDATE devices SET approved = 0 WHERE user_id = 'u_multi'");
    const resMultiWhileRevoked = await evaluateV5Accrual('u_multi', { now: now + DAY_MS });
    assert.strictEqual(resMultiWhileRevoked.accrual_applied, false);
    assert.strictEqual(
      resMultiWhileRevoked.v5_banked_balance,
      multiBalanceBeforeRevoke,
      'Temporary device revocation must preserve existing v5_banked_balance'
    );

    // Metered user must accrue 0, leave v5_last_accrual_epoch NULL, and accrue immediately if upgraded 10s later
    const resMetered = await evaluateV5Accrual('u_metered', { now });
    assert.strictEqual(resMetered.v5_banked_balance, 0, 'Metered user must accrue 0 NCP');
    assert.strictEqual(resMetered.v5_last_accrual_epoch, null, 'Metered evaluation must not stamp v5_last_accrual_epoch');

    await run("UPDATE users SET priority_tier = 'Normal' WHERE user_id = 'u_metered'");
    const resUpgraded = await evaluateV5Accrual('u_metered', { now: now + 10000 });
    assert.strictEqual(resUpgraded.accrual_applied, true, 'Upgraded Metered user must accrue immediately without 24h wait');
    assert.ok(resUpgraded.v5_banked_balance > 0);

    // Downgrading back to Metered must cap existing banked NCP to 0 after 24h
    await run("UPDATE users SET priority_tier = 'Metered' WHERE user_id = 'u_metered'");
    const resDowngraded = await evaluateV5Accrual('u_metered', { now: now + 10000 + DAY_MS });
    assert.strictEqual(resDowngraded.v5_banked_balance, 0, 'Downgrading to Metered must cap banked balance to 0');

    // Division-by-zero protection when zero approved active users exist
    await run('UPDATE devices SET approved = 0');
    const resZeroWeight = await evaluateV5Accrual('u_multi', { now: now + DAY_MS });
    assert.strictEqual(resZeroWeight.total_cluster_weight, 0);
    assert.strictEqual(resZeroWeight.daily_share_ncp, 0);
    assert.strictEqual(Number.isNaN(resZeroWeight.v5_banked_balance), false);
  });

  // ---------------------------------------------------------------------------
  // 4. HAPPY PATH & HELL PATH: 30-DAY ANLAS RESET (ZERO ROLLOVER + DEBT OFFSET)
  // ---------------------------------------------------------------------------
  await t.test('Anlas Reset: Enforces 30-day zero rollover, 1x inactivity cap, debt offset, and ban freeze', async () => {
    const t0 = 1760000000000;

    // 1. Fresh Normal user -> gets 500 Anlas
    await run("INSERT INTO users (user_id, priority_tier, virtual_anlas_balance) VALUES ('u_reset_pos', 'Normal', 0)");
    const firstReset = await evaluateAnlasReset('u_reset_pos', t0);
    assert.strictEqual(firstReset.reset_applied, true);
    assert.strictEqual(firstReset.virtual_balance, 500);

    // User spends 200 (300 left) and accrues subscription_period metrics
    await run(
      "UPDATE users SET virtual_anlas_balance = 300, subscription_period_anlas = 200, subscription_period_v5 = 12 WHERE user_id = 'u_reset_pos'"
    );

    // 29 days later -> no reset
    const day29 = await evaluateAnlasReset('u_reset_pos', t0 + (29 * DAY_MS));
    assert.strictEqual(day29.reset_applied, false);
    assert.strictEqual(day29.virtual_balance, 300);

    // 95 days later (3+ months inactive) -> receives EXACTLY 500 (strict zero rollover, no multi-month accumulation)
    const day95 = await evaluateAnlasReset('u_reset_pos', t0 + (95 * DAY_MS));
    assert.strictEqual(day95.reset_applied, true);
    assert.strictEqual(day95.virtual_balance, 500, 'Unused 300 must not roll over and 95 days must not stack');

    const periodRow = await get("SELECT subscription_period_anlas, subscription_period_v5 FROM users WHERE user_id = 'u_reset_pos'");
    assert.strictEqual(periodRow.subscription_period_anlas, 0, 'Subscription period Anlas counter must reset on 30-day boundary');
    assert.strictEqual(periodRow.subscription_period_v5, 0, 'Subscription period V5 counter must reset on 30-day boundary');

    // 2. Partial Debt Offset: Low tier (200/mo) with -120 debt -> resets to 80
    await run(
      "INSERT INTO users (user_id, priority_tier, virtual_anlas_balance, last_anlas_reset_epoch) VALUES ('u_debt_partial', 'Low', -120, ?)",
      [t0]
    );
    const partialDebtReset = await evaluateAnlasReset('u_debt_partial', t0 + THIRTY_DAYS_MS);
    assert.strictEqual(partialDebtReset.reset_applied, true);
    assert.strictEqual(partialDebtReset.virtual_balance, 80, '200 monthlyAnlas + (-120 debt) must equal 80');

    // 3. Persistent Debt: Low tier (200/mo) with -350 debt -> resets to -150 (remains in debt)
    await run(
      "INSERT INTO users (user_id, priority_tier, virtual_anlas_balance, last_anlas_reset_epoch) VALUES ('u_debt_heavy', 'Low', -350, ?)",
      [t0]
    );
    const heavyDebtReset = await evaluateAnlasReset('u_debt_heavy', t0 + THIRTY_DAYS_MS);
    assert.strictEqual(heavyDebtReset.virtual_balance, -150, 'Debt exceeding monthly grant must carry forward remaining debt');

    // 4. Metered tier (0/mo) with -50 debt -> preserves -50 debt
    await run(
      "INSERT INTO users (user_id, priority_tier, virtual_anlas_balance, last_anlas_reset_epoch) VALUES ('u_debt_metered', 'Metered', -50, ?)",
      [t0]
    );
    const meteredDebtReset = await evaluateAnlasReset('u_debt_metered', t0 + THIRTY_DAYS_MS);
    assert.strictEqual(meteredDebtReset.virtual_balance, -50, 'Metered tier reset must never erase negative debt');

    // 5. Banned account freeze: must NOT reset balance or clear period metrics
    await run(
      "INSERT INTO users (user_id, priority_tier, banned, virtual_anlas_balance, last_anlas_reset_epoch, subscription_period_anlas) VALUES ('u_reset_banned', 'Normal', 1, -40, ?, 99)",
      [t0]
    );
    const bannedReset = await evaluateAnlasReset('u_reset_banned', t0 + THIRTY_DAYS_MS);
    assert.strictEqual(bannedReset.reset_applied, false);
    assert.strictEqual(bannedReset.virtual_balance, -40, 'Banned account must not receive fresh monthly quota');
    const bannedRow = await get("SELECT subscription_period_anlas, last_anlas_reset_epoch FROM users WHERE user_id = 'u_reset_banned'");
    assert.strictEqual(bannedRow.subscription_period_anlas, 99);
    assert.strictEqual(bannedRow.last_anlas_reset_epoch, t0);
  });

  // ---------------------------------------------------------------------------
  // 5. HELL PATH: CROSS-CHANNEL DOUBLE-SPEND RACE & STAGE 1 BASE-PAID BYPASS DENIAL
  // ---------------------------------------------------------------------------
  await t.test('Hell Path: Cross-Channel Double-Spend Race aggregates Channel A & Channel B holds and blocks 0-declared base-paid bypass', async () => {
    const qm = createQueueCoordinator({
      TIER_CONFIGS: DEFAULT_TIER_CONFIGS,
      ...OPERATIONAL_DEFAULTS
    });

    const userId = 'u_double_spend';
    await run("INSERT INTO users (user_id, priority_tier, virtual_anlas_balance) VALUES (?, 'Normal', 20)", [userId]);

    // 1. Place a 20 Anlas reservation hold on Channel A (e.g., high-res image queued)
    qm.join({
      browser_id: 'b_ds_1',
      req_id: 'req_chan_a_20',
      priority_tier: 'Normal',
      user_id: userId,
      held_cost: 20
    });

    const heldAfterA = qm.getHeldAnlasForUser(userId);
    assert.strictEqual(heldAfterA, 20);

    const balAfterA = await calculateAvailableBalance(userId, heldAfterA);
    assert.strictEqual(balAfterA.virtual_balance, 20);
    assert.strictEqual(balAfterA.available_balance, 0);

    // 2. Simultaneous Channel B /ai/encode-vibe attempts to spend 2 Anlas -> MUST REJECT
    const vibeAttempt = await authorizeAnlasSpend(userId, {
      declaredAnlas: 2,
      requiredAnlas: 2,
      heldAnlas: heldAfterA
    });
    assert.strictEqual(vibeAttempt.ok, false);
    assert.strictEqual(vibeAttempt.status, 403);
    assert.strictEqual(vibeAttempt.error, 'INSUFFICIENT_ANLAS');

    // 3. Complete Channel A without PoNR commit -> hold clears, balance returns to 20
    qm.complete('req_chan_a_20', 'b_ds_1');
    assert.strictEqual(qm.getHeldAnlasForUser(userId), 0);

    // 4. Reverse direction: Channel B holds 2 Anlas for vibe encode; Channel A attempts 20 Anlas -> MUST REJECT
    assert.strictEqual(qm.acquireTextSlot('vibe_ds_1', userId, 2), true);
    const heldAfterB = qm.getHeldAnlasForUser(userId);
    assert.strictEqual(heldAfterB, 2);

    const chanAAttempt = await authorizeAnlasSpend(userId, {
      declaredAnlas: 20,
      requiredAnlas: 20,
      isBasePaid: true,
      heldAnlas: heldAfterB
    });
    assert.strictEqual(chanAAttempt.ok, false);
    assert.strictEqual(chanAAttempt.status, 403);
    assert.strictEqual(chanAAttempt.error, 'INSUFFICIENT_ANLAS');
    assert.strictEqual(chanAAttempt.available_balance, 18);

    // 5. Release Channel B slot -> Channel A 20 Anlas succeeds
    qm.releaseTextSlot('vibe_ds_1');
    const chanASuccess = await authorizeAnlasSpend(userId, {
      declaredAnlas: 20,
      requiredAnlas: 20,
      isBasePaid: true,
      heldAnlas: qm.getHeldAnlasForUser(userId)
    });
    assert.strictEqual(chanASuccess.ok, true);
    assert.strictEqual(chanASuccess.available_balance, 20);

    // 6. Stage 1 Base-Paid + 0 Declared bypass denial:
    // Metered/0-balance user forging X-Base-Paid: true + X-Declared-Anlas: 0 must be blocked pre-buffer (403 INSUFFICIENT_ANLAS)
    await run("INSERT INTO users (user_id, priority_tier, virtual_anlas_balance) VALUES ('u_zero_bal', 'Metered', 0)");
    const zeroBalBypass = await authorizeAnlasSpend('u_zero_bal', {
      declaredAnlas: 0,
      requiredAnlas: null,
      isBasePaid: true,
      heldAnlas: 0
    });
    assert.strictEqual(zeroBalBypass.ok, false);
    assert.strictEqual(zeroBalBypass.status, 403);
    assert.strictEqual(zeroBalBypass.error, 'INSUFFICIENT_ANLAS');

    // Solvent user sending X-Base-Paid: true with X-Declared-Anlas: 0 must also fail closed (400 SPEND_CAP_EXCEEDED)
    const solventZeroDeclare = await authorizeAnlasSpend(userId, {
      declaredAnlas: 0,
      requiredAnlas: null,
      isBasePaid: true,
      heldAnlas: 0
    });
    assert.strictEqual(solventZeroDeclare.ok, false);
    assert.strictEqual(solventZeroDeclare.status, 400);
    assert.strictEqual(solventZeroDeclare.error, 'SPEND_CAP_EXCEEDED');
  });

  // ---------------------------------------------------------------------------
  // 6. HELL PATH: DEBT CIRCUMVENTION DENIAL (HTTP 403 DEBT_LOCKED)
  // ---------------------------------------------------------------------------
  await t.test('Hell Path: Debt Circumvention Denial locks paid requests while permitting free Opus', async () => {
    const userId = 'u_in_debt';
    await run("INSERT INTO users (user_id, priority_tier, virtual_anlas_balance) VALUES (?, 'Normal', -25)", [userId]);

    const bal = await calculateAvailableBalance(userId, 0);
    assert.strictEqual(bal.virtual_balance, -25);
    assert.strictEqual(bal.available_balance, -25);
    assert.strictEqual(bal.is_in_debt, true);

    // 1. Free Opus generation (0 Anlas, isBasePaid=false) -> MUST PASS
    const freeOpus = await authorizeAnlasSpend(userId, {
      declaredAnlas: 0,
      requiredAnlas: 0,
      isBasePaid: false,
      heldAnlas: 0
    });
    assert.strictEqual(freeOpus.ok, true);
    assert.strictEqual(freeOpus.debt_free_bypass, true);

    // 2. Client transmits X-Declared-Anlas > 0 -> MUST REJECT 403 DEBT_LOCKED
    const declaredBypass = await authorizeAnlasSpend(userId, {
      declaredAnlas: 5,
      heldAnlas: 0
    });
    assert.strictEqual(declaredBypass.ok, false);
    assert.strictEqual(declaredBypass.status, 403);
    assert.strictEqual(declaredBypass.error, 'DEBT_LOCKED');

    // 3. Client spoofs X-Declared-Anlas: 0 while request requires base Anlas (requiredAnlas: 20) -> MUST REJECT 403 DEBT_LOCKED
    const stealthBypass = await authorizeAnlasSpend(userId, {
      declaredAnlas: 0,
      requiredAnlas: 20,
      isBasePaid: false,
      heldAnlas: 0
    });
    assert.strictEqual(stealthBypass.ok, false);
    assert.strictEqual(stealthBypass.status, 403);
    assert.strictEqual(stealthBypass.error, 'DEBT_LOCKED');

    // 4. Client asserts X-Base-Paid: true with declaredAnlas: 0 -> MUST REJECT 403 DEBT_LOCKED
    const basePaidBypass = await authorizeAnlasSpend(userId, {
      declaredAnlas: 0,
      isBasePaid: true,
      heldAnlas: 0
    });
    assert.strictEqual(basePaidBypass.ok, false);
    assert.strictEqual(basePaidBypass.status, 403);
    assert.strictEqual(basePaidBypass.error, 'DEBT_LOCKED');

    // 5. Solvent user exceeding X-Declared-Anlas cap (required > declared, within balance) -> 400 SPEND_CAP_EXCEEDED
    await run("INSERT INTO users (user_id, priority_tier, virtual_anlas_balance) VALUES ('u_cap_test', 'Normal', 100)");
    const capExceeded = await authorizeAnlasSpend('u_cap_test', {
      declaredAnlas: 10,
      requiredAnlas: 20,
      isBasePaid: true,
      heldAnlas: 0
    });
    assert.strictEqual(capExceeded.ok, false);
    assert.strictEqual(capExceeded.status, 400);
    assert.strictEqual(capExceeded.error, 'SPEND_CAP_EXCEEDED');
  });

  // ---------------------------------------------------------------------------
  // 7. HELL PATH: CONCURRENT TOCTOU ACCRUAL & RESET SERIALIZATION
  // ---------------------------------------------------------------------------
  await t.test('Hell Path: Concurrent evaluateV5Accrual & evaluateAnlasReset serialize without double-crediting', async () => {
    await run('DELETE FROM devices');
    await run('DELETE FROM users');

    const t0 = 1762000000000;
    await run(
      "INSERT INTO users (user_id, priority_tier, banned, virtual_anlas_balance, last_anlas_reset_epoch, v5_banked_balance, v5_last_accrual_epoch) VALUES ('u_race', 'Normal', 0, 100, ?, 0, ?)",
      [t0, t0]
    );
    await run("INSERT INTO devices (browser_id, user_id, device_secret, approved) VALUES ('d_race', 'u_race', 'srace', 1)");

    // Fire 10 simultaneous V5 accruals exactly 1 day later (sole user => 3420 NCP daily share)
    const accrualPromises = Array.from({ length: 10 }, () => evaluateV5Accrual('u_race', { now: t0 + DAY_MS }));
    const accrualResults = await Promise.all(accrualPromises);

    const appliedCount = accrualResults.filter(r => r.accrual_applied).length;
    assert.strictEqual(appliedCount, 1, 'Exactly ONE concurrent V5 accrual must execute');

    const userRow = await get("SELECT v5_banked_balance FROM users WHERE user_id = 'u_race'");
    assert.strictEqual(userRow.v5_banked_balance, 3420, 'Concurrent accrual race must not multiply balance');

    // Fire 10 simultaneous Anlas resets after 30 days
    const resetPromises = Array.from({ length: 10 }, () => evaluateAnlasReset('u_race', t0 + THIRTY_DAYS_MS));
    const resetResults = await Promise.all(resetPromises);
    assert.strictEqual(resetResults.filter(r => r.reset_applied).length, 1, 'Exactly ONE concurrent Anlas reset must execute');
  });

  // ---------------------------------------------------------------------------
  // 8. HELL PATH: PoNR COMMITS, OVERDRAFT PRESERVATION, ADMIN INFINITY & FAIL-CLOSED INPUTS
  // ---------------------------------------------------------------------------
  await t.test('Hell Path: PoNR commits preserve negative integer overdrafts, Admin Infinity immunity, and fail-closed checks', async () => {
    const userId = 'u_ponr_ledger';
    const browserId = 'b_ponr_dev';
    await run("INSERT INTO users (user_id, priority_tier, virtual_anlas_balance, v5_banked_balance) VALUES (?, 'Normal', 10, 28)", [userId]);
    await run("INSERT INTO devices (browser_id, user_id, device_secret, approved) VALUES (?, ?, 's_ponr', 1)", [browserId, userId]);

    // 1. Overdraft commit (10 - 25 = -15) preserves integer precision across users and devices
    const debitRes = await commitAnlasDebit(userId, 25, browserId);
    assert.strictEqual(debitRes.committed, true);
    assert.strictEqual(debitRes.virtual_balance, -15);

    const devRow = await get('SELECT virtual_anlas_balance, anlas_consumed FROM devices WHERE browser_id = ?', [browserId]);
    assert.strictEqual(devRow.virtual_anlas_balance, -15, 'Trigger must mirror negative overdraft onto linked device');
    assert.strictEqual(devRow.anlas_consumed, 25);

    const userRow = await get('SELECT subscription_period_anlas, anlas_consumed FROM users WHERE user_id = ?', [userId]);
    assert.strictEqual(userRow.subscription_period_anlas, 25);
    assert.strictEqual(userRow.anlas_consumed, 25);

    // 2. Zero-cost debits must remain read-only no-ops without inflating usage counters
    const zeroAnlas = await commitAnlasDebit(userId, 0, browserId);
    assert.strictEqual(zeroAnlas.committed, false);
    assert.strictEqual(zeroAnlas.virtual_balance, -15);

    const zeroV5 = await commitV5Debit(userId, 0);
    assert.strictEqual(zeroV5.committed, false);
    assert.strictEqual(zeroV5.v5_banked_balance, 28);

    const zeroCounters = await get('SELECT v5_daily_consumed, subscription_period_v5, subscription_period_anlas FROM users WHERE user_id = ?', [userId]);
    assert.strictEqual(zeroCounters.v5_daily_consumed, 0, '0 NCP debit must not increment daily V5 counter');
    assert.strictEqual(zeroCounters.subscription_period_v5, 0, '0 NCP debit must not increment period V5 counter');
    assert.strictEqual(zeroCounters.subscription_period_anlas, 25, '0 Anlas debit must not alter period Anlas counter');

    // 3. V5 Bucket 1 debit (28 - 18 = 10, then 10 - 18 clamps at 0) & Bucket 2 counter tracking
    const v5First = await commitV5Debit(userId, 18);
    assert.strictEqual(v5First.v5_banked_balance, 10);
    const v5Second = await commitV5Debit(userId, 18);
    assert.strictEqual(v5Second.v5_banked_balance, 0, 'V5 bank debit must clamp cleanly via MAX(0, ...)');
    await recordSurplusV5Usage(userId);

    const v5Counters = await get('SELECT v5_daily_consumed, subscription_period_v5 FROM users WHERE user_id = ?', [userId]);
    assert.strictEqual(v5Counters.v5_daily_consumed, 3);
    assert.strictEqual(v5Counters.subscription_period_v5, 3);

    // 4. Admin tier Infinity immunity (never writes Infinity or phantom debt into SQLite, resets period counters)
    const adminT0 = 1763000000000;
    await run("INSERT INTO users (user_id, priority_tier, banned) VALUES ('u_admin_real', 'Admin', 0)");
    await run("INSERT INTO devices (browser_id, user_id, device_secret, approved) VALUES ('d_adm_real', 'u_admin_real', 'sadm', 1)");
    const adminReset = await evaluateAnlasReset('u_admin_real', adminT0);
    assert.strictEqual(adminReset.reset_applied, true);
    assert.strictEqual(adminReset.virtual_balance, Infinity);
    const adminBal = await calculateAvailableBalance('u_admin_real', 0);
    assert.strictEqual(adminBal.available_balance, Infinity);

    // Database-backed Admin verifyDevice must resolve virtual_anlas_balance === Infinity
    const dbAdminAuth = await verifyDevice('d_adm_real', 'sadm');
    assert.strictEqual(dbAdminAuth.ok, true);
    assert.strictEqual(dbAdminAuth.device.virtual_anlas_balance, Infinity);

    // Database-backed Admin spending 60 Anlas and surplus V5 must track usage without incurring negative debt
    const adminDebit = await commitAnlasDebit('u_admin_real', 60, 'd_adm_real');
    assert.strictEqual(adminDebit.committed, true);
    assert.strictEqual(adminDebit.virtual_balance, Infinity);
    await recordSurplusV5Usage('u_admin_real');

    const adminRow = await get("SELECT virtual_anlas_balance, anlas_consumed, subscription_period_anlas, subscription_period_v5 FROM users WHERE user_id = 'u_admin_real'");
    assert.strictEqual(adminRow.virtual_anlas_balance, 0, 'Admin principal must not accumulate negative virtual debt');
    assert.strictEqual(adminRow.anlas_consumed, 60);
    assert.strictEqual(adminRow.subscription_period_anlas, 60);
    assert.strictEqual(adminRow.subscription_period_v5, 1);

    // 30 days later, DB-backed Admin period counters must reset while lifetime anlas_consumed remains intact
    const adminSecondReset = await evaluateAnlasReset('u_admin_real', adminT0 + THIRTY_DAYS_MS);
    assert.strictEqual(adminSecondReset.reset_applied, true);
    assert.strictEqual(adminSecondReset.virtual_balance, Infinity);
    const adminAfterReset = await get("SELECT virtual_anlas_balance, anlas_consumed, subscription_period_anlas, subscription_period_v5 FROM users WHERE user_id = 'u_admin_real'");
    assert.strictEqual(adminAfterReset.virtual_anlas_balance, 0);
    assert.strictEqual(adminAfterReset.anlas_consumed, 60);
    assert.strictEqual(adminAfterReset.subscription_period_anlas, 0, 'Admin subscription_period_anlas must reset at 30d boundary');
    assert.strictEqual(adminAfterReset.subscription_period_v5, 0, 'Admin subscription_period_v5 must reset at 30d boundary');

    const adminV5 = await evaluateV5Accrual('u_admin_real', { now: adminT0 });
    assert.strictEqual(Number.isInteger(adminV5.v5_banked_balance), true, 'Admin V5 accrual must remain finite integer in SQLite');

    // Synthetic admin verifyDevice fields and recordSurplusV5Usage immunity
    const adminAuth = await verifyDevice('admin_term', process.env.ADMIN_SECRET_KEY);
    assert.strictEqual(adminAuth.ok, true);
    assert.strictEqual(adminAuth.device.virtual_anlas_balance, Infinity);
    await recordSurplusV5Usage('admin');

    // Non-existent user handling fails safely without crashing
    assert.strictEqual(await calculateAvailableBalance('ghost_user', 0), null);
    assert.strictEqual(await evaluateAnlasReset('ghost_user', Date.now()), null);
    assert.strictEqual(await evaluateV5Accrual('ghost_user', { now: Date.now() }), null);
    assert.deepStrictEqual(await commitAnlasDebit('ghost_user', 20), { committed: false, virtual_balance: 0 });
    assert.deepStrictEqual(await commitV5Debit('ghost_user', 18), { committed: false, v5_banked_balance: 0 });
    await recordSurplusV5Usage('ghost_user');

    // 5. Fail-closed validation rejects poison arguments
    for (const badVal of [-1, 1.5, NaN, Infinity, true, '10', [], {}]) {
      await assert.rejects(() => calculateAvailableBalance(userId, badVal), /non-negative safe integer/);
      await assert.rejects(() => authorizeAnlasSpend(userId, { declaredAnlas: badVal }), /non-negative safe integer/);
      await assert.rejects(() => commitAnlasDebit(userId, badVal), /non-negative safe integer/);
      await assert.rejects(() => commitV5Debit(userId, badVal), /non-negative safe integer/);
    }
    await assert.rejects(() => authorizeAnlasSpend(userId, { isBasePaid: 'true' }), /must be a boolean/);
    await assert.rejects(() => calculateAvailableBalance('   ', 0), /non-empty string/);
    await assert.rejects(() => recordSurplusV5Usage('   '), /non-empty string/);
    await assert.rejects(() => evaluateAnlasReset(userId, -100), /finite non-negative number/);
    await assert.rejects(() => evaluateV5Accrual(userId, { now: NaN }), /finite non-negative number/);
  });
});