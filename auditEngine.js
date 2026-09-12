/**
 * LEVEL 2: SECURITY AUDIT & ACCOUNTING ENGINE (auditEngine.js)
 * 
 * Strict unidirectional constraints:
 * - Imports Level 0 (database.js) and Level 1 (config.js).
 * - Blind to HTTP transport (Express), socket streams, and queue RAM states.
 * - Handles parameter parsing, security auditing, Anlas tracking, and authoritative device authentication.
 */

'use strict';

const { get, run } = require('./database');
const { loadConfig } = require('./config');

/**
 * Evaluates the runtime system configuration dynamically.
 *
 * @returns {object} Validated, immutable configuration manifest.
 */
function getConfig() {
  return loadConfig(process.env);
}

/**
 * Authoritative Device Authentication & Identity Gatekeeper.
 * Centralizes credential validation, administrative bypass, and hierarchical ban enforcement.
 * (Technically violates SRP, but abstracting a single function into a new root file is pendantic and premature.)
 * 
 * @param {string} browserId - Unique device browser footprint.
 * @param {string} deviceSecret - Secret passkey or admin secret.
 * @param {object} [options={}] - Validation policies.
 * @param {boolean} [options.requireApproval=true] - Whether unapproved devices should be rejected.
 * @returns {Promise<{ok: boolean, status?: number, error?: string, device?: object}>} Validation result.
 */
async function verifyDevice(browserId, deviceSecret, { requireApproval = true } = {}) {
  if (!browserId || !deviceSecret) {
    return { ok: false, status: 401, error: 'Missing routing authorization context.' };
  }

  const config = getConfig();
  let device;

  if (deviceSecret === config.ADMIN_SECRET_KEY) {
    device = { approved: 1, banned: 0, priority_tier: 'Admin', discord_id: 'admin', anlas_consumed: 0 };
  } else {
    device = await get(
      'SELECT approved, banned, priority_tier, discord_id, anlas_consumed FROM devices WHERE browser_id = ? AND device_secret = ?',
      [browserId, deviceSecret]
    );
  }

  if (!device) {
    return { ok: false, status: 401, error: 'Access Denied: Device credentials rejected.' };
  }

  // Authoritative Identity Hierarchy: Evaluate Discord ID blacklist before device-level flags
  if (device.discord_id && device.discord_id !== 'admin') {
    const isBannedUser = await get('SELECT 1 FROM banned_discords WHERE discord_id = ?', [device.discord_id]);
    if (isBannedUser) {
      if (device.banned !== 1) {
        await run('UPDATE devices SET banned = 1 WHERE discord_id = ?', [device.discord_id]);
      }
      return { ok: false, status: 403, error: 'Access Denied: Your Discord identity is permanently banned.' };
    }
  }

  if (device.banned === 1) {
    return { ok: false, status: 403, error: 'Access Denied: Your device/profile has been permanently banned.' };
  }

  if (requireApproval && device.approved !== 1) {
    return { ok: false, status: 401, error: 'Access Denied: Device pending registration approval.' };
  }

  return { ok: true, device };
}

/**
 * Format-agnostic parameter extractor.
 * Safely parses JSON blocks or multipart streams, identifying character references.
 * Hardened against malformed JSON, truncated boundaries, and ReDoS injections.
 *
 * @param {Buffer} buffer - Outbound raw client payload buffer.
 * @returns {object|null} Structured parameters or null on parsing failure.
 */
function extractParametersFromRawBody(buffer) {
  try {
    if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) return null;

    const bodyStr = buffer.toString('utf8');
    
    // Strip base64 payloads to prevent catastrophic regex backtracking (ReDoS)
    const cleanedStr = bodyStr.replace(/"(?:data:image\/[^"]+|[A-Za-z0-9+/=]{1000,})"/g, '""');

    let parsed = null;

    // Multipart/FormData JSON Extraction
    if (buffer[0] === 0x2d && buffer[1] === 0x2d) { // Starts with "--"
      const firstLineEnd = cleanedStr.indexOf('\n');
      const boundary = firstLineEnd !== -1 ? cleanedStr.slice(0, firstLineEnd).trim() : '';

      const requestIndex = cleanedStr.indexOf('name="request"');
      if (requestIndex !== -1 && boundary) {
        const startIdx = cleanedStr.indexOf('{', requestIndex);
        if (startIdx !== -1) {
          const nextBoundary = cleanedStr.indexOf(boundary, startIdx);
          const endIdx = nextBoundary !== -1 ? nextBoundary : cleanedStr.length;

          let jsonCandidate = cleanedStr.slice(startIdx, endIdx).trim();
          const lastBrace = jsonCandidate.lastIndexOf('}');
          if (lastBrace !== -1) {
            jsonCandidate = jsonCandidate.slice(0, lastBrace + 1);
          }
          parsed = JSON.parse(jsonCandidate);
        }
      }
    } else {
      // Direct application/json Payload Parsing
      const trimmed = cleanedStr.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        parsed = JSON.parse(trimmed);
      }
    }

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const params = (parsed.parameters && typeof parsed.parameters === 'object' && !Array.isArray(parsed.parameters))
        ? parsed.parameters
        : parsed;
      
      const preciseRefs = 
        (Array.isArray(params.director_reference_images_cached) ? params.director_reference_images_cached.length : 0) +
        (Array.isArray(params.director_reference_images) ? params.director_reference_images.length : 0) +
        (Array.isArray(params.reference_image_multiple) ? params.reference_image_multiple.length : 0);

      const parsedWidth = parseInt(params.width || parsed.width, 10);
      const parsedHeight = parseInt(params.height || parsed.height, 10);
      const parsedSteps = parseInt(params.steps || parsed.steps, 10);
      const parsedSamples = parseInt(params.n_samples || parsed.n_samples, 10);
      const parsedModel = typeof parsed.model === 'string' ? parsed.model : (typeof params.model === 'string' ? params.model : null);

      return {
        width: Number.isFinite(parsedWidth) ? parsedWidth : null,
        height: Number.isFinite(parsedHeight) ? parsedHeight : null,
        steps: Number.isFinite(parsedSteps) ? parsedSteps : null,
        n_samples: Number.isFinite(parsedSamples) ? parsedSamples : null,
        precise_ref_count: preciseRefs,
        model: parsedModel
      };
    }
  } catch (err) {
    console.error('[VPS Audit] Error extracting parameters from raw body:', err.message);
  }
  return null;
}

/**
 * Recursively inspects a JSON payload and replaces massive Base64 strings
 * with compact metadata placeholders to prevent log bloat.
 *
 * @param {*} obj - Target payload object.
 * @returns {*} Sanitized object copy.
 */
function sanitizeObjectForLogging(obj) {
  if (obj === null || obj === undefined) return obj;
  
  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObjectForLogging(item));
  }
  
  if (typeof obj === 'object') {
    const cleaned = {};
    for (const [key, val] of Object.entries(obj)) {
      cleaned[key] = sanitizeObjectForLogging(val);
    }
    return cleaned;
  }
  
  if (typeof obj === 'string') {
    if (obj.length > 500) {
      const mimeType = obj.startsWith('data:') ? obj.split(';')[0] : 'Base64/Binary';
      return `[Truncated ${mimeType}, Length: ${obj.length} chars]`;
    }
  }
  
  return obj;
}

/**
 * Formats JSON and Multipart/FormData payloads into a structured string for telemetry.
 *
 * @param {Buffer} buffer - Raw request body buffer.
 * @returns {string} Formatted log output.
 */
function formatPayloadForLogging(buffer) {
  try {
    if (!buffer || buffer.length === 0) return "{ empty payload }";

    const bodyStr = buffer.toString('utf8');

    if (buffer[0] === 0x2d && buffer[1] === 0x2d) { // Starts with "--"
      const firstLineEnd = bodyStr.indexOf('\n');
      const boundary = firstLineEnd !== -1 ? bodyStr.slice(0, firstLineEnd).trim() : '';
      const requestIndex = bodyStr.indexOf('name="request"');
      
      if (requestIndex !== -1 && boundary) {
        const startIdx = bodyStr.indexOf('{', requestIndex);
        if (startIdx !== -1) {
          const nextBoundary = bodyStr.indexOf(boundary, startIdx);
          const endIdx = nextBoundary !== -1 ? nextBoundary : bodyStr.length;

          let jsonCandidate = bodyStr.slice(startIdx, endIdx).trim();
          const lastBrace = jsonCandidate.lastIndexOf('}');
          if (lastBrace !== -1) {
            jsonCandidate = jsonCandidate.slice(0, lastBrace + 1);
          }
          
          const parsed = JSON.parse(jsonCandidate);
          return JSON.stringify(sanitizeObjectForLogging(parsed), null, 2);
        }
      }
      return `[Multipart Payload - Boundary: ${boundary}, Length: ${buffer.length} bytes]`;
    }

    if (bodyStr.trim().startsWith('{')) {
      const parsed = JSON.parse(bodyStr);
      return JSON.stringify(sanitizeObjectForLogging(parsed), null, 2);
    }

    return bodyStr.substring(0, 1000) + `... [Truncated raw data, Total: ${buffer.length} bytes]`;
  } catch (err) {
    return `[Logger Error] Parsing failure: ${err.message}. Raw payload size: ${buffer.length} bytes.`;
  }
}

/**
 * Executes deep background auditing on transmitted payload buffers.
 * Detects model spoofing bypass attempts and hard-limit violations.
 * 
 * @param {string} browserId - Unique device key.
 * @param {Buffer} payloadBuffer - Accumulated outbound parameters buffer.
 * @param {boolean} clientReportedV5 - Model validation flag received in header.
 * @returns {Promise<object>} Audit report containing ban status and eviction targets.
 */
async function runBackgroundAudit(browserId, payloadBuffer, clientReportedV5) {
  const actualParams = extractParametersFromRawBody(payloadBuffer);
  if (!actualParams) return { banned: false, discordId: null, browserId };

  const { width, height, steps, n_samples, precise_ref_count, model } = actualParams;
  
  const actualPixels = (width && height) ? (width * height) : 0;
  const actualSteps = steps || 0;
  const actualSamples = n_samples || 1;
  const actualRefs = precise_ref_count || 0;

  const device = await get('SELECT priority_tier, discord_id FROM devices WHERE browser_id = ?', [browserId]);
  if (!device) return { banned: false, discordId: null, browserId };

  const config = getConfig();
  const tierConfig = config.TIER_CONFIGS[device.priority_tier] || config.TIER_CONFIGS['Normal'];
  
  // Header Spoofing Detection
  const isViolation = (actualPixels > config.FIREWALL_MAX_PIXELS) || 
                      (actualSteps > config.FIREWALL_MAX_STEPS) || 
                      (actualSamples !== config.FIREWALL_MAX_SAMPLES) || 
                      (actualRefs > tierConfig.preciseLimit);

  // V5 model string matching bypass verification
  const isV5Model = typeof model === 'string' && /[-_]5[-_]/i.test(model) && !model.includes('4-5');
  const bypassViolation = isV5Model && !clientReportedV5;

  // Ledger execution (5 Anlas per character reference)
  const anlasSpent = actualRefs * 5;
  if (anlasSpent > 0) {
    await run('UPDATE devices SET anlas_consumed = anlas_consumed + ? WHERE browser_id = ?', [anlasSpent, browserId]);
    console.log(`[VPS Audit Ledger] Deducted ${anlasSpent} Anlas on user profile ${device.discord_id || browserId} (refs used: ${actualRefs})`);
  }

  // Punitive execution on hostile mismatch
  if (isViolation || bypassViolation) {
    console.warn(`\x1b[31m[VPS SECURITY AUDIT] !!! HOSTILE PAYLOAD SPOOFING DETECTED !!!\x1b[0m`);
    console.warn(`[VPS Security Audit] Device: "${browserId}", Tier: "${device.priority_tier}"`);
    
    try {
      const banReason = bypassViolation 
        ? `Firewall Bypass Violation: Client generated with V5 model ("${model}") but suppressed X-Gen-Model header.`
        : `Firewall Bypass Violation: Client spoofed headers to bypass ingress limits. Actual Body Payload: Pixels=${actualPixels}, Steps=${actualSteps}, Refs=${actualRefs}`;

      if (device.discord_id) {
        console.warn(`[VPS Security Audit] Revoking all devices linked to Discord ID: "${device.discord_id}"`);
        await run('INSERT OR REPLACE INTO banned_discords (discord_id, banned_at, reason, is_notified) VALUES (?, ?, ?, 0)', [
          device.discord_id, Date.now(), banReason
        ]);
        await run('UPDATE devices SET banned = 1 WHERE discord_id = ?', [device.discord_id]);
      } else {
        console.warn(`[VPS Security Audit] Revoking browser_id directly: "${browserId}"`);
        await run('UPDATE devices SET banned = 1 WHERE browser_id = ?', [browserId]);
      }
      
      console.log(`[VPS Security Audit] Success. Database ban committed for "${browserId}".`);
      return {
        banned: true,
        reason: banReason,
        discordId: device.discord_id || null,
        browserId
      };
    } catch (dbErr) {
      console.error('[VPS Security Audit] Failed to execute database ban:', dbErr.message);
    }
  }

  return { banned: false, discordId: device.discord_id || null, browserId };
}

/**
 * Lazy-refills and updates the database-backed tier token bucket.
 * Accounts for elapsed time while preserving fractional timing remainder.
 *
 * @param {string} browserId - Unique device browser footprint.
 * @param {string} tier - Device priority tier mapping.
 * @param {boolean} [deduct=false] - True if 1 token should be consumed atomically.
 * @returns {Promise<number>} Evaluated current metered token balance.
 */
async function getOrUpdateAllowance(browserId, tier, deduct = false) {
  const config = getConfig();
  const tierConfig = config.TIER_CONFIGS[tier];
  if (!tierConfig) return 0;

  if (tierConfig.maxAllowance === Infinity) {
    return Infinity;
  }

  const row = await get('SELECT metered_allowance, last_allowance_update_at FROM devices WHERE browser_id = ?', [browserId]);
  if (!row) return 0;

  let allowance = row.metered_allowance;
  let lastUpdate = row.last_allowance_update_at;
  const now = Date.now();

  const maxAllowance = tierConfig.maxAllowance;
  const refillRate = tierConfig.refillRateMs;

  if (allowance === null || lastUpdate === null) {
    allowance = maxAllowance;
    lastUpdate = now;
    await run('UPDATE devices SET metered_allowance = ?, last_allowance_update_at = ? WHERE browser_id = ?', [maxAllowance, now, browserId]);
  }

  const elapsed = Math.max(0, now - lastUpdate);
  const gained = refillRate > 0 ? Math.floor(elapsed / refillRate) : 0;

  if (gained > 0) {
    allowance = Math.min(maxAllowance, allowance + gained);
    lastUpdate = lastUpdate + (gained * refillRate);
  }

  if (deduct) {
    if (allowance >= 1) {
      allowance -= 1;
      await run('UPDATE devices SET metered_allowance = ?, last_allowance_update_at = ? WHERE browser_id = ?', [allowance, lastUpdate, browserId]);
    } else {
      return -1;
    }
  } else if (gained > 0) {
    await run('UPDATE devices SET metered_allowance = ?, last_allowance_update_at = ? WHERE browser_id = ?', [allowance, lastUpdate, browserId]);
  }

  return allowance;
}

/**
 * Calculates the exact millisecond epoch for the user's next rolling allowance refill.
 *
 * @param {string} browserId - Unique device browser footprint.
 * @param {string} tier - Device priority tier mapping.
 * @returns {Promise<number|null>} Refill epoch or null if already capped.
 */
async function getNextRefillTime(browserId, tier) {
  const config = getConfig();
  const tierConfig = config.TIER_CONFIGS[tier];
  if (!tierConfig || tierConfig.maxAllowance === Infinity) return null;

  const row = await get('SELECT metered_allowance, last_allowance_update_at FROM devices WHERE browser_id = ?', [browserId]);
  if (!row || row.metered_allowance === null || row.last_allowance_update_at === null) return null;
  if (row.metered_allowance >= tierConfig.maxAllowance) return null;
  return row.last_allowance_update_at + tierConfig.refillRateMs;
}

module.exports = {
  verifyDevice,
  extractParametersFromRawBody,
  sanitizeObjectForLogging,
  formatPayloadForLogging,
  runBackgroundAudit,
  getOrUpdateAllowance,
  getNextRefillTime
};