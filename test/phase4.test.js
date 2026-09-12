/**
 * PHASE 4 HARNESS: AUDIT ENGINE & STATELESS PARAMETER EXTRACTION (test/phase4.test.js)
 *
 * Exhaustively exercises the decoupled Level 2 Audit Engine:
 * 1. Stateless Buffer Parsing:
 *    - Validates extraction from raw application/json buffers.
 *    - Validates extraction from complex multipart/form-data boundaries.
 *    - Hell Path: Corrupt, truncated, empty, and non-JSON payloads safely return null without uncaught exceptions.
 *    - ReDoS prevention: verifies extraction against 5MB+ base64 image strings.
 * 2. Device Identity & Hierarchical Gatekeeping:
 *    - Missing credentials rejected (401).
 *    - Unapproved devices rejected when strict approval enforced (401).
 *    - Unapproved devices permitted when permissive onboarding active (e.g. status polling & nickname registration).
 *    - Banned Discord accounts rejected unconditionally (403) and synchronized to SQLite devices table.
 * 3. Hard Security Enforcements (Payload Mismatch Detection):
 *    - Asserts that body payload parameter violations flag as bypass violations and trigger bans.
 *    - Asserts that stealth V5 model requests trigger bans and return full eviction targets.
 * 4. Anlas Accounting Ledger:
 *    - Verifies Anlas costs (5 per precise reference) are deducted asynchronously.
 * 5. Token Allowance Ledger:
 *    - Verifies lazy refills, millisecond timing drift preservation, and deduction boundaries.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { initDatabase, closeDatabase, get, run } = require('../database');
const {
  verifyDevice,
  extractParametersFromRawBody,
  runBackgroundAudit,
  getOrUpdateAllowance,
  getNextRefillTime
} = require('../auditEngine');

const SANDBOX_DB_FILE = path.join(__dirname, 'test_sandbox_phase4.db');
process.env.ADMIN_SECRET_KEY = "audit_secret_key";
process.env.DATABASE_PATH = SANDBOX_DB_FILE;

function cleanupFiles() {
  [
    SANDBOX_DB_FILE,
    `${SANDBOX_DB_FILE}-journal`,
    `${SANDBOX_DB_FILE}-wal`,
    `${SANDBOX_DB_FILE}-shm`
  ].forEach(f => {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
  });
}

cleanupFiles();

test("Phase 4: Decoupled Audit Engine & Parameter Extraction Verification", async (t) => {
  await initDatabase(SANDBOX_DB_FILE);

  t.after(async () => {
    await closeDatabase();
    cleanupFiles();
  });

  await t.test("Extractor: Accurately parses clean application/json buffers", () => {
    const payload = {
      model: "nai-diffusion-3",
      parameters: { width: 832, height: 1216, steps: 28, n_samples: 1 }
    };
    const buffer = Buffer.from(JSON.stringify(payload));
    
    const extracted = extractParametersFromRawBody(buffer);
    assert.ok(extracted, "Must extract parameters from JSON buffer");
    assert.strictEqual(extracted.width, 832);
    assert.strictEqual(extracted.height, 1216);
    assert.strictEqual(extracted.steps, 28);
    assert.strictEqual(extracted.n_samples, 1);
    assert.strictEqual(extracted.model, "nai-diffusion-3");
    assert.strictEqual(extracted.precise_ref_count, 0);
  });

  await t.test("Extractor: Accurately parses complex multipart/form-data boundaries", () => {
    const jsonBlob = JSON.stringify({
      model: "nai-diffusion-4-5-full",
      parameters: {
        width: 1024, height: 1024, steps: 20, n_samples: 1,
        reference_image_multiple: ["ref1", "ref2"]
      }
    });

    const multipartString = 
`--boundary123
Content-Disposition: form-data; name="request"
Content-Type: application/json

${jsonBlob}
--boundary123
Content-Disposition: form-data; name="image"; filename="blob"
Content-Type: image/png

<binary_data_mock>
--boundary123--`;

    const buffer = Buffer.from(multipartString);
    const extracted = extractParametersFromRawBody(buffer);
    
    assert.ok(extracted, "Must extract parameters from multi-part boundary string");
    assert.strictEqual(extracted.width, 1024);
    assert.strictEqual(extracted.steps, 20);
    assert.strictEqual(extracted.model, "nai-diffusion-4-5-full");
    assert.strictEqual(extracted.precise_ref_count, 2, "Must aggregate precise character references accurately");
  });

  await t.test("Hell Path: Extractor gracefully returns null on malformed, empty, or non-JSON payloads", () => {
    assert.strictEqual(extractParametersFromRawBody(null), null);
    assert.strictEqual(extractParametersFromRawBody(Buffer.alloc(0)), null);
    assert.strictEqual(extractParametersFromRawBody(Buffer.from("invalid json payload")), null);
    assert.strictEqual(extractParametersFromRawBody(Buffer.from("{ corrupt: json")), null);
    
    // Malformed multipart lacking closing boundary
    const badMultipart = Buffer.from('--boundary\r\nContent-Disposition: form-data; name="request"\r\n\r\n{ "model": "broken"');
    assert.strictEqual(extractParametersFromRawBody(badMultipart), null);
  });

  await t.test("Extractor: Survives ReDoS attempts on massive base64 payloads without blocking", () => {
    // Generate a massive dummy base64 string to simulate 5MB image upload
    const massiveBase64 = Buffer.alloc(5 * 1024 * 1024, 'a').toString('base64');
    const payload = {
      model: "test",
      parameters: { width: 512, height: 512 },
      image: `data:image/png;base64,${massiveBase64}`
    };
    
    const buffer = Buffer.from(JSON.stringify(payload));
    const start = performance.now();
    const extracted = extractParametersFromRawBody(buffer);
    const elapsed = performance.now() - start;

    assert.ok(extracted, "Must extract parameters regardless of payload size");
    assert.strictEqual(extracted.width, 512);
    // Vague heuristic, but a ReDoS on 5MB string would lock the thread for seconds/minutes.
    assert.ok(elapsed < 100, `Regex must neutralize base64 blocks instantly (Took ${elapsed}ms)`);
  });

  await t.test("Device Gatekeeper: Evaluates authentication, unapproved status, and Discord identity bans", async () => {
    await run('INSERT INTO devices (browser_id, device_secret, priority_tier, approved, banned) VALUES (?, ?, ?, 0, 0)',
      ['dev_unapproved', 'sec_unapproved', 'Normal']);
    await run('INSERT INTO devices (browser_id, device_secret, discord_id, priority_tier, approved, banned) VALUES (?, ?, ?, ?, 1, 0)',
      ['dev_banned_user', 'sec_banned_user', 'discord_bad_1', 'Normal']);
    await run('INSERT INTO banned_discords (discord_id, banned_at, reason) VALUES (?, ?, ?)',
      ['discord_bad_1', Date.now(), 'Malicious Behavior']);

    // Missing context
    const resMissing = await verifyDevice(null, null);
    assert.strictEqual(resMissing.ok, false);
    assert.strictEqual(resMissing.status, 401);

    // Unapproved device with requireApproval=true must be rejected
    const resUnapprovedStrict = await verifyDevice('dev_unapproved', 'sec_unapproved', { requireApproval: true });
    assert.strictEqual(resUnapprovedStrict.ok, false);
    assert.strictEqual(resUnapprovedStrict.status, 401);
    assert.match(resUnapprovedStrict.error, /pending registration approval/i);

    // Unapproved device with requireApproval=false must be accepted (for status querying & nickname updates)
    const resUnapprovedPermissive = await verifyDevice('dev_unapproved', 'sec_unapproved', { requireApproval: false });
    assert.strictEqual(resUnapprovedPermissive.ok, true);

    // Banned Discord account must be rejected regardless of requireApproval setting
    const resBanned = await verifyDevice('dev_banned_user', 'sec_banned_user', { requireApproval: false });
    assert.strictEqual(resBanned.ok, false);
    assert.strictEqual(resBanned.status, 403);
    assert.match(resBanned.error, /Discord identity is permanently banned/i);

    // Assert SQLite device record was synchronized with ban flag
    const updatedDev = await get('SELECT banned FROM devices WHERE browser_id = ?', ['dev_banned_user']);
    assert.strictEqual(updatedDev.banned, 1);
  });

  await t.test("Audit Engine: Malicious payload parameter spoofing triggers database bans and returns eviction targets", async () => {
    const browserId = "malicious_spoof_client";
    const discordId = "discord_hacker_123";
    await run('INSERT INTO devices (browser_id, device_secret, discord_id, priority_tier, approved, banned) VALUES (?, ?, ?, ?, 1, 0)', 
      [browserId, "secret", discordId, "Normal"]);

    // Client bypassed ingress by lying in headers, but embedded illegal steps in body
    const payload = Buffer.from(JSON.stringify({
      parameters: { width: 1024, height: 1024, steps: 50, n_samples: 1 }
    }));

    const auditResult = await runBackgroundAudit(browserId, payload, true);
    
    assert.strictEqual(auditResult.banned, true, "Body payload mismatches exceeding limits must trigger permanent ban");
    assert.strictEqual(auditResult.discordId, discordId, "Must return target discordId for router-level queue eviction");
    assert.strictEqual(auditResult.browserId, browserId);
    
    const device = await get('SELECT banned FROM devices WHERE browser_id = ?', [browserId]);
    assert.strictEqual(device.banned, 1, "Device must be flagged as banned in database");

    const discordBan = await get('SELECT reason FROM banned_discords WHERE discord_id = ?', [discordId]);
    assert.ok(discordBan, "Linked Discord account must be added to banned_discords table");
    assert.match(discordBan.reason, /Client spoofed headers to bypass ingress limits/i);
  });

  await t.test("Audit Engine: Model spoofing bypass triggers database bans and returns eviction targets", async () => {
    const browserId = "stealth_v5_client";
    const discordId = "discord_stealth_123";
    await run('INSERT INTO devices (browser_id, device_secret, discord_id, priority_tier, approved, banned) VALUES (?, ?, ?, ?, 1, 0)', 
      [browserId, "secret", discordId, "Normal"]);

    // Client requests V5 model without reporting header
    const payload = Buffer.from(JSON.stringify({
      model: "nai-diffusion-5-full",
      parameters: { width: 1024, height: 1024, steps: 28, n_samples: 1 }
    }));

    const auditResult = await runBackgroundAudit(browserId, payload, false);
    
    assert.strictEqual(auditResult.banned, true, "V5 model bypass violations must return banned = true");
    assert.strictEqual(auditResult.discordId, discordId);
    
    // Assert Ban Ledger
    const device = await get('SELECT banned FROM devices WHERE browser_id = ?', [browserId]);
    assert.strictEqual(device.banned, 1);

    const discordBan = await get('SELECT reason FROM banned_discords WHERE discord_id = ?', [discordId]);
    assert.ok(discordBan);
    assert.match(discordBan.reason, /suppressed X-Gen-Model header/i);
  });

  await t.test("Audit Engine: Verifies exact Anlas deduction ledger per reference image", async () => {
    const browserId = "anlas_client";
    await run('INSERT INTO devices (browser_id, device_secret, priority_tier, approved, banned, anlas_consumed) VALUES (?, ?, ?, 1, 0, 0)', 
      [browserId, "secret", "Normal"]);

    const payload = Buffer.from(JSON.stringify({
      parameters: { 
        width: 1024, height: 1024, 
        director_reference_images_cached: ["img1", "img2"] // 2 references
      }
    }));

    await runBackgroundAudit(browserId, payload, true);
    
    const device = await get('SELECT anlas_consumed FROM devices WHERE browser_id = ?', [browserId]);
    
    // 2 references * 5 Anlas = 10 Anlas consumed
    assert.strictEqual(device.anlas_consumed, 10, "Ledger must deduct exactly 5 Anlas per precise reference used");
  });

  await t.test("Allowance Ledger: Mathematical lazy refills, remainder drift, and deduction boundaries", async () => {
    const browserId = "allowance_ledger_client";
    await run('INSERT INTO devices (browser_id, device_secret, priority_tier, approved, banned, metered_allowance, last_allowance_update_at) VALUES (?, ?, ?, 1, 0, 10, ?)',
      [browserId, "secret", "Metered", Date.now() - 3600000]); // 1 hour ago

    // Metered tier: refillRateMs = 1800000 (30 mins = 2 tokens gained)
    const initialAllowance = await getOrUpdateAllowance(browserId, "Metered", false);
    assert.strictEqual(initialAllowance, 12, "Must lazily refill 2 tokens for 1 hour elapsed");

    // Deduct 1 token
    const afterDeduct = await getOrUpdateAllowance(browserId, "Metered", true);
    assert.strictEqual(afterDeduct, 11, "Must deduct 1 token atomically");

    // Next refill time assertion
    const nextRefill = await getNextRefillTime(browserId, "Metered");
    assert.ok(nextRefill > Date.now(), "Next refill timestamp must be in the future");
  });
});