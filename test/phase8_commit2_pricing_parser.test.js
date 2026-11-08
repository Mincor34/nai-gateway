/**
 * PHASE 8 COMMIT 2 VERIFICATION HARNESS (test/phase8_commit2_pricing_parser.test.js)
 *
 * Exhaustively exercises:
 * 1. Authoritative Anlas Pricing Engine:
 *    - Baseline Opus Lightweight Bonus (1024x1024, <=28 steps, 1 sample -> 0 Anlas).
 *    - Opus Lightweight Bonus Multi-sample (1024x1024, 28 steps, 2 samples -> 20 Anlas, 1 sample free).
 *    - High-resolution Opus generation (>1MP -> full sample billing at 60 Anlas).
 *    - V5 Medium Effort step_factor (1 / 1.06521739) parity:
 *      * Free baseline (1024x1024, 14 steps, 1 sample -> 0 Anlas).
 *      * Free baseline deadband bypass (1024x1024, 50 steps, 1 sample -> 0 Anlas, steps ignored).
 *      * Anlas-paid multi-sample (1024x1024, 14 steps, 2 samples -> 12 Anlas, exact step_factor parity).
 *      * Anlas-paid high-res (1536x2048, 14 steps, 1 sample -> 34 Anlas, exact step_factor parity).
 *      * Auxiliary step parameter override immunity (1536x2048, 50 steps, 1 sample -> 34 Anlas).
 *    - Character Reference surcharges (5 Anlas per reference per requested sample).
 *    - Structured Reference array fallback extraction in pricing calculations.
 *    - SMEA & SMEA-DYN multipliers (1.2x and 1.4x).
 *    - Img2Img & Inpaint strength scaling (with minimum 2 Anlas floor and NaN resilience).
 *    - Arbitrage Denial Invariant: Passing strength without an image defaults strictly to 1.0 (20 Anlas).
 *    - Inpainting Isolation Invariant: Mask presence evaluates inpaintImg2ImgStrength exclusively without strength fallback.
 *    - Multipart Img2Img/Inpaint Detection: Verifies binary name="image" and name="mask" parts apply strength scaling.
 *    - Vibe transfer surcharges on V4/V4.5 (2 Anlas per uncached encode, 2 Anlas per ref beyond 4).
 *    - Vibe immunity on V5 (vibe surcharges strictly 0 across all V5 identifier variants).
 *    - Hard per-image cap at 140 Anlas (structured exception thrown).
 *    - Hell Path: Array and Object coercive type injections (e.g. strength: [], width: [1024]).
 *    - Model decoupling sanity: Rejection of V4.5 models attempting to spoof V5 Medium identity.
 * 2. Zero-Copy Binary Buffer Parser:
 *    - Happy Path: application/json buffer extraction.
 *    - Happy Path: multipart/form-data buffer extraction with binary image part.
 *    - Hell Path: RFC 2046 Line-Start Invariant:
 *      * Mid-line `--boundary` collision within binary payload is ignored without speculative header scans.
 *    - Hell Path: RFC 2046 Transport Padding:
 *      * Linear whitespace (spaces/tabs) between boundary delimiter and CRLF is handled transparently.
 *    - Hell Path: Delimiter Confusion Injection:
 *      * Multipart prompt containing exact raw boundary token byte sequences AND markdown hr dashes (\r\n---\r\n).
 *      * Asserts parser loop recovers from internal false matches and extracts full payload.
 *    - Hell Path: Sequential Pointer Advancement (No Outer Loop Regression):
 *      * Verifies that after extracting the JSON request part, the outer scanner pointer advances directly
 *        to the next part and does not re-scan the JSON prompt for false boundaries.
 *    - Hell Path: Binary Image Precedence:
 *      * Multipart stream where a 10MB raw binary PNG precedes the name="request" part.
 *      * Binary chunk deliberately embeds binary collision strings (name="request"\r\n\r\n{"model":"spoofed"}).
 *      * Asserts boundary-driven framing ignores binary collision and extracts genuine request parameters.
 *    - Hell Path: False Delimiter Syntax Guard:
 *      * Verifies false boundary match without terminal 0x7D skips string allocation.
 *    - Hell Path: Memory Ceiling & Malformed JSON Defense:
 *      * Slices exceeding 20MB abort cleanly without runaway allocations.
 *    - Hell Path: Direct JSON Payload Heap Protection:
 *      * Oversized direct JSON buffer exceeding MAX_JSON_PART_BYTES yields null immediately without allocation.
 *    - Hell Path: Malformed JSON Prefix:
 *      * Payloads with 4KB of leading whitespace.
 *      * Non-JSON leading bytes.
 *      * Truncated braces.
 *      * Asserts graceful null extraction without unhandled exceptions or thread locks.
 * 3. Telemetry Formatter Invariants:
 *    - Asserts formatPayloadForLogging preserves prompts >= 1,000 characters without destructive truncation,
 *      including comma-separated Danbooru tag strings lacking whitespace characters and camelCase negativePrompt keys.
 *    - Asserts formatPayloadForLogging truncates raw Base64 arrays (reference_image_multiple) without leaking megabytes.
 * 4. Invariant Verification:
 *    - Float Invariant Defense: Proves float dimensions (4096.5) truncate cleanly and do not bypass pixel limit audit checks.
 *    - Astronomical Integer Invariant: Proves numbers > MAX_SAFE_INTEGER clamp to MAX_SAFE_INTEGER and trigger immediate bans.
 *    - V5 Medium Audit Immunity: Proves V5 Medium generation with 50 steps is NOT banned by runBackgroundAudit.
 *    - Model Family Disambiguation: Proves nai-diffusion-4_5 and 4.5 are not falsely classified as V5, and unanchored tokens like 'heavy5' do not match.
 *    - SMEA Nullish Coalescing Invariant: Explicit parameters.sm = false is not overridden by truthy root property.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const { initDatabase, closeDatabase, run } = require('../database');
const {
  isV5ModelFamily,
  isV5MediumModel,
  calculateAnlasCost,
  calculateAnlasCostDetails,
  extractParametersFromRawBody,
  formatPayloadForLogging,
  runBackgroundAudit,
  MAX_JSON_PART_BYTES
} = require('../auditEngine');

const SANDBOX_DB_FILE = path.join(__dirname, 'test_sandbox_phase8_commit2.db');
process.env.ADMIN_SECRET_KEY = "test_phase8_commit2_admin_key";
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

test("Phase 8 Commit 2: Anlas Pricing Engine & Zero-Copy Binary Buffer Parser", async (t) => {
  await initDatabase(SANDBOX_DB_FILE);

  t.after(async () => {
    await closeDatabase();
    cleanupSandbox();
  });

  // ---------------------------------------------------------------------------
  // 1. ANLAS PRICING ENGINE TESTS
  // ---------------------------------------------------------------------------
  await t.test("Pricing Engine: Baseline Opus Free-Tier Lightweight Bonus", () => {
    // 1024x1024, 28 steps, 1 sample on Opus tier -> 0 Anlas
    const costFree = calculateAnlasCost({
      width: 1024,
      height: 1024,
      steps: 28,
      n_samples: 1,
      model: "nai-diffusion-4-5-full"
    }, { isOpus: true });

    assert.strictEqual(costFree, 0, "1024x1024, 28 steps, 1 sample on Opus must be free (0 Anlas)");

    // 1024x1024, 28 steps, 2 samples on Opus tier -> 1 free, 1 billed (20 Anlas)
    const cost2Samples = calculateAnlasCost({
      width: 1024,
      height: 1024,
      steps: 28,
      n_samples: 2,
      model: "nai-diffusion-4-5-full"
    }, { isOpus: true });

    assert.strictEqual(cost2Samples, 20, "2 samples at 1024x1024 28 steps must bill 1 sample (20 Anlas)");

    // 1024x1024, 28 steps, 1 sample on Non-Opus tier -> 20 Anlas
    const costNonOpus = calculateAnlasCost({
      width: 1024,
      height: 1024,
      steps: 28,
      n_samples: 1,
      model: "nai-diffusion-4-5-full"
    }, { isOpus: false });

    assert.strictEqual(costNonOpus, 20, "Non-Opus tier must bill 20 Anlas for 1024x1024 28 steps");
  });

  await t.test("Pricing Engine: High-Resolution Scaling on Opus Tier", () => {
    // 1536x2048 (area = 3,145,728 > 1MP), 28 steps, 1 sample
    // base = ceil(2.951823174884865e-6 * 3145728 + 5.753298233447344e-7 * 3145728 * 28) = ceil(9.2856 + 50.6761) = ceil(59.96) = 60
    const costHighRes = calculateAnlasCost({
      width: 1536,
      height: 2048,
      steps: 28,
      n_samples: 1,
      model: "nai-diffusion-4-5-full"
    }, { isOpus: true });

    assert.strictEqual(costHighRes, 60, "1536x2048, 28 steps, 1 sample must bill 60 Anlas (exceeds 1MP)");
  });

  await t.test("Pricing Engine: V5 Medium Effort step_factor (1 / 1.06521739) Parity", () => {
    // 1. Free baseline: <= 1MP, 1 sample -> 0 Anlas regardless of steps
    const costMediumFree14 = calculateAnlasCost({
      width: 1024,
      height: 1024,
      steps: 14,
      n_samples: 1,
      model: "nai-diffusion-5-full-medium"
    }, { isOpus: true });
    assert.strictEqual(costMediumFree14, 0, "V5 Medium 1024x1024 14 steps 1 sample must be free");

    const costMediumFree50 = calculateAnlasCost({
      width: 1024,
      height: 1024,
      steps: 50,
      n_samples: 1,
      model: "nai-diffusion-5-full-medium"
    }, { isOpus: true });
    assert.strictEqual(costMediumFree50, 0, "V5 Medium steps are ignored by upstream; <=1MP 1 sample remains 0 Anlas");

    // Inpainting model identifier check
    const costMediumInpaintFree = calculateAnlasCost({
      width: 1024,
      height: 1024,
      steps: 28,
      n_samples: 1,
      model: "nai-diffusion-5-medium-inpainting"
    }, { isOpus: true });
    assert.strictEqual(costMediumInpaintFree, 0, "V5 Medium Inpainting identifier must be recognized");

    // 2. Anlas-paid multi-sample: 1024x1024, 2 samples -> priced with step_factor (1 / 1.06521739)
    // 1024x1024, steps = 14 * (1 / 1.06521739) = 13.142857:
    // base = ceil(2.951823174884865e-6 * 1048576 + 5.753298233447344e-7 * 1048576 * 13.142857)
    // base = ceil(3.0952 + 7.9289) = ceil(11.024) = 12 Anlas per image
    // billable_samples = 2 - 1 = 1 -> 12 * 1 = 12 Anlas
    const costMedium2Samples = calculateAnlasCost({
      width: 1024,
      height: 1024,
      steps: 14,
      n_samples: 2,
      model: "nai-diffusion-5-full-medium"
    }, { isOpus: true });
    assert.strictEqual(costMedium2Samples, 12, "V5 Medium 2 samples at 1024x1024 must cost 12 Anlas (14 / 1.06521739 parity)");

    // 3. Anlas-paid high-res: 1536x2048, 1 sample -> priced with step_factor (1 / 1.06521739)
    // 1536x2048 at 13.142857 steps -> per-image = 34 Anlas -> billable = 1 -> total = 34 Anlas
    const costMediumHighRes = calculateAnlasCost({
      width: 1536,
      height: 2048,
      steps: 14,
      n_samples: 1,
      model: "nai-diffusion-5-full-medium"
    }, { isOpus: true });
    assert.strictEqual(costMediumHighRes, 34, "V5 Medium 1536x2048 1 sample must cost 34 Anlas (14 / 1.06521739 parity)");

    // 4. Immunity to client-supplied steps on High-Res Medium
    const costMediumHighRes50 = calculateAnlasCost({
      width: 1536,
      height: 2048,
      steps: 50,
      n_samples: 1,
      model: "nai-diffusion-5-full-medium"
    }, { isOpus: true });
    assert.strictEqual(costMediumHighRes50, 34, "V5 Medium must ignore client steps and price with step_factor (34 Anlas)");
  });

  await t.test("Pricing Engine: Rejects V4.5 models attempting to hijack V5 Medium discounts", () => {
    const costV45Medium = calculateAnlasCost({
      width: 1024,
      height: 1024,
      steps: 28,
      n_samples: 2,
      model: "nai-diffusion-4-5-medium"
    }, { isOpus: true });

    assert.strictEqual(costV45Medium, 20, "V4.5 model must not be spoofed into V5 Medium step discount");
  });

  await t.test("Pricing Engine: Character Reference Surcharges & Array Fallback", () => {
    const cost1Ref = calculateAnlasCost({
      width: 1024,
      height: 1024,
      steps: 28,
      n_samples: 1,
      precise_ref_count: 1,
      model: "nai-diffusion-4-5-full"
    }, { isOpus: true });
    assert.strictEqual(cost1Ref, 5, "1 ref on free base must cost 5 Anlas");

    // 1024x1024, 28 steps, 1 sample, Opus, 3 refs -> 15 Anlas
    const cost3Refs = calculateAnlasCost({
      width: 1024,
      height: 1024,
      steps: 28,
      n_samples: 1,
      precise_ref_count: 3,
      model: "nai-diffusion-4-5-full"
    }, { isOpus: true });
    assert.strictEqual(cost3Refs, 15, "3 refs on free base must cost 15 Anlas");

    // 1024x1024, 28 steps, 2 samples, Opus, 2 refs -> base 20 + (5 * 2 * 2) = 40 Anlas
    const cost2Samples2Refs = calculateAnlasCost({
      width: 1024,
      height: 1024,
      steps: 28,
      n_samples: 2,
      precise_ref_count: 2,
      model: "nai-diffusion-4-5-full"
    }, { isOpus: true });
    assert.strictEqual(cost2Samples2Refs, 40, "2 samples with 2 refs must cost 20 base + 20 refs = 40 Anlas");

    const costArrayFallback = calculateAnlasCost({
      width: 1024,
      height: 1024,
      steps: 28,
      n_samples: 1,
      reference_image_multiple: ["refA", "refB"],
      director_reference_images_cached: ["refC"],
      model: "nai-diffusion-4-5-full"
    }, { isOpus: true });
    assert.strictEqual(costArrayFallback, 15, "Pricing engine must evaluate references directly from arrays if precise_ref_count is omitted");
  });

  await t.test("Pricing Engine: SMEA and SMEA-DYN Multipliers", () => {
    // 1024x1024, 28 steps, non-Opus (base = 20)
    // sm: true, sm_dyn: false -> 20 * 1.2 = 24 Anlas
    const costSMEA = calculateAnlasCost({
      width: 1024,
      height: 1024,
      steps: 28,
      n_samples: 1,
      sm: true,
      sm_dyn: false,
      model: "nai-diffusion-4-full"
    }, { isOpus: false });
    assert.strictEqual(costSMEA, 24, "SMEA must apply 1.2x multiplier (20 -> 24)");

    // sm: true, sm_dyn: true -> 20 * 1.4 = 28 Anlas
    const costSMEADyn = calculateAnlasCost({
      width: 1024,
      height: 1024,
      steps: 28,
      n_samples: 1,
      sm: true,
      sm_dyn: true,
      model: "nai-diffusion-4-full"
    }, { isOpus: false });
    assert.strictEqual(costSMEADyn, 28, "SMEA-DYN must apply 1.4x multiplier (20 -> 28)");
  });

  await t.test("Pricing Engine: Img2Img and Inpainting Strength Scaling & Resilience", () => {
    // 1024x1024, 28 steps, non-Opus (base = 20)
    // strength = 0.5 with image present -> ceil(20 * 0.5) = 10 Anlas
    const costImg2Img = calculateAnlasCost({
      width: 1024,
      height: 1024,
      steps: 28,
      n_samples: 1,
      strength: 0.5,
      has_image: true,
      model: "nai-diffusion-4-full"
    }, { isOpus: false });
    assert.strictEqual(costImg2Img, 10, "Img2Img strength 0.5 must scale base cost by 0.5 (20 -> 10)");

    // inpaintImg2ImgStrength = 0.2 with mask present -> ceil(20 * 0.2) = 4 Anlas
    const costInpaint = calculateAnlasCost({
      width: 1024,
      height: 1024,
      steps: 28,
      n_samples: 1,
      inpaintImg2ImgStrength: 0.2,
      has_mask: true,
      model: "nai-diffusion-4-full"
    }, { isOpus: false });
    assert.strictEqual(costInpaint, 4, "Inpaint strength 0.2 must scale base cost by 0.2 (20 -> 4)");

    // Enforces minimum floor of 2 Anlas
    const costMinFloor = calculateAnlasCost({
      width: 1024,
      height: 1024,
      steps: 28,
      n_samples: 1,
      strength: 0.01,
      has_image: true,
      model: "nai-diffusion-4-full"
    }, { isOpus: false });
    assert.strictEqual(costMinFloor, 2, "Strength factor must never drop below 2 Anlas minimum floor");

    // Rejection of NaN values falls back to 1.0
    const costNanStrength = calculateAnlasCost({
      width: 1024,
      height: 1024,
      steps: 28,
      n_samples: 1,
      strength: "corrupted_nan",
      has_image: true,
      model: "nai-diffusion-4-full"
    }, { isOpus: false });
    assert.strictEqual(costNanStrength, 20, "NaN strength factor must fallback to 1.0 (20 Anlas)");

    // Clamping of out-of-range floats (> 1.0 clamped to 1.0)
    const costClampedStrength = calculateAnlasCost({
      width: 1024,
      height: 1024,
      steps: 28,
      n_samples: 1,
      strength: 5.0,
      has_image: true,
      model: "nai-diffusion-4-full"
    }, { isOpus: false });
    assert.strictEqual(costClampedStrength, 20, "Strength > 1.0 must be clamped to 1.0 (20 Anlas)");
  });

  await t.test("Pricing Engine: Anti-Arbitrage Invariant (Strength without image defaults to 1.0)", () => {
    // Attempted arbitrage: Client transmits strength: 0.5 on a text-to-image payload without an image
    const costWithoutImage = calculateAnlasCost({
      width: 1024,
      height: 1024,
      steps: 28,
      n_samples: 1,
      strength: 0.5,
      has_image: false,
      model: "nai-diffusion-4-full"
    }, { isOpus: false });

    // Must evaluate to full 20 Anlas (strength_factor = 1.0) because upstream NovelAI charges full price when no image exists
    assert.strictEqual(
      costWithoutImage,
      20,
      "Anti-Arbitrage Invariant: Strength without an input image must evaluate to 1.0 (20 Anlas)"
    );
  });

  await t.test("Pricing Engine: Inpainting Isolation Invariant (Mask presence prevents fallback to strength)", () => {
    // Inpaint payload where mask is present, inpaintImg2ImgStrength is omitted, but strength is 0.5
    const costInpaintNoFallback = calculateAnlasCost({
      width: 1024,
      height: 1024,
      steps: 28,
      n_samples: 1,
      has_mask: true,
      has_image: true,
      strength: 0.5 // Leftover from previous generation; must be ignored
    }, { isOpus: false });

    assert.strictEqual(
      costInpaintNoFallback,
      20,
      "Inpainting Isolation Invariant: When mask is present, strength parameter must be ignored (defaults to 1.0, 20 Anlas)"
    );
  });

  await t.test("Pricing Engine: Multipart Img2Img & Inpaint Binary Part Detection", () => {
    const boundary = "img2img_multipart_boundary";
    const jsonBlob = JSON.stringify({
      model: "nai-diffusion-4-full",
      parameters: { width: 1024, height: 1024, steps: 28, n_samples: 1, strength: 0.5 }
    });

    const multipart = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="request"\r\nContent-Type: application/json\r\n\r\n${jsonBlob}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="blob"\r\nContent-Type: image/png\r\n\r\n<png_bytes>\r\n`),
      Buffer.from(`--${boundary}--\r\n`)
    ]);

    const extracted = extractParametersFromRawBody(multipart, `multipart/form-data; boundary=${boundary}`);
    assert.ok(extracted);
    assert.strictEqual(extracted.has_image, true, "Scanner must detect name='image' from multipart part headers");

    const cost = calculateAnlasCost(extracted, { isOpus: false });
    assert.strictEqual(cost, 10, "Img2Img strength 0.5 must be applied when binary image part is detected in multipart (20 -> 10)");
  });

  await t.test("Pricing Engine: Vibe Transfer Surcharges & Strict V5 Model Immunity", () => {
    const detailsV4 = calculateAnlasCostDetails({
      width: 1024,
      height: 1024,
      steps: 28,
      n_samples: 1,
      uncached_vibe_count: 2,
      vibe_reference_count: 6,
      model: "nai-diffusion-4-full"
    }, { isOpus: true });

    assert.strictEqual(detailsV4.vibe_encoding_anlas, 4, "2 uncached vibes = 4 Anlas");
    assert.strictEqual(detailsV4.vibe_reference_anlas, 4, "6 vibe refs (2 beyond 4) = 4 Anlas");
    assert.strictEqual(detailsV4.total, 8, "Total must equal 8 Anlas on Opus free base");

    const v5Variants = ["nai-diffusion-5-full", "nai-diffusion-5", "nai-diffusion-5-curated", "v5"];
    for (const modelId of v5Variants) {
      const detailsV5 = calculateAnlasCostDetails({
        width: 1024,
        height: 1024,
        steps: 28,
        n_samples: 1,
        uncached_vibe_count: 2,
        vibe_reference_count: 6,
        model: modelId
      }, { isOpus: true });

      assert.strictEqual(detailsV5.vibe_encoding_anlas, 0, `Model ${modelId} must have 0 vibe encoding Anlas`);
      assert.strictEqual(detailsV5.vibe_reference_anlas, 0, `Model ${modelId} must have 0 vibe reference Anlas`);
      assert.strictEqual(detailsV5.total, 0, `Model ${modelId} total must remain 0 on Opus free base`);
    }
  });

  await t.test("Pricing Engine: Hard Per-Image Cap Enforcement", () => {
    assert.throws(
      () => calculateAnlasCost({
        width: 3000,
        height: 3000,
        steps: 50,
        n_samples: 1,
        model: "nai-diffusion-4-full"
      }),
      /exceeds maximum cap of 140 Anlas/i,
      "Per-image costs > 140 Anlas must throw a structured exception"
    );
  });

  await t.test("Hell Path: Coercive Array, Object, and Boolean Type Injections", () => {
    // 1. Array-coerced strength: "strength": [] must NOT evaluate to 0.0
    const emptyArrayStrength = calculateAnlasCost({
      width: 1024,
      height: 1024,
      steps: 28,
      n_samples: 1,
      strength: [],
      has_image: true,
      model: "nai-diffusion-4-full"
    }, { isOpus: false });
    assert.strictEqual(emptyArrayStrength, 20, "Empty array strength must fallback to 1.0 (20 Anlas)");

    // 2. Single-element array strength: "strength": [0.5] must NOT evaluate to 0.5
    const arrayElementStrength = calculateAnlasCost({
      width: 1024,
      height: 1024,
      steps: 28,
      n_samples: 1,
      strength: [0.5],
      has_image: true,
      model: "nai-diffusion-4-full"
    }, { isOpus: false });
    assert.strictEqual(arrayElementStrength, 20, "Array-wrapped strength must fallback to 1.0 (20 Anlas)");

    // 3. Object-wrapped strength: "strength": {}
    const objectStrength = calculateAnlasCost({
      width: 1024,
      height: 1024,
      steps: 28,
      n_samples: 1,
      strength: {},
      has_image: true,
      model: "nai-diffusion-4-full"
    }, { isOpus: false });
    assert.strictEqual(objectStrength, 20, "Object strength must fallback to 1.0 (20 Anlas)");

    // 4. Array-wrapped integer dimensions in extractor: "width": [1024]
    const arrayWidthPayload = Buffer.from(JSON.stringify({
      parameters: { width: [1024], height: 1024, steps: 28, n_samples: 1 }
    }));
    const extractedArrayWidth = extractParametersFromRawBody(arrayWidthPayload);
    assert.strictEqual(extractedArrayWidth.width, null, "Array-wrapped width must evaluate to null");

    // 5. Array-wrapped steps in extractor: "steps": []
    const emptyArrayStepsPayload = Buffer.from(JSON.stringify({
      parameters: { width: 1024, height: 1024, steps: [], n_samples: 1 }
    }));
    const extractedEmptySteps = extractParametersFromRawBody(emptyArrayStepsPayload);
    assert.strictEqual(extractedEmptySteps.steps, null, "Empty array steps must evaluate to null");

    // 6. Nullish coalescing assertion: explicit zero dimensions must not be masked by falsy fallbacks
    const rawZeroPayload = Buffer.from(JSON.stringify({
      width: 1024,
      parameters: { width: 0, height: 1024, steps: 28, n_samples: 1 }
    }));
    const zeroParams = extractParametersFromRawBody(rawZeroPayload);
    assert.strictEqual(zeroParams.width, 0, "Explicit 0 width must not be masked by parsed.width fallback");
  });

  // ---------------------------------------------------------------------------
  // 2. ZERO-COPY BINARY BUFFER PARSER TESTS
  // ---------------------------------------------------------------------------
  await t.test("Binary Parser: Clean application/json extraction", () => {
    const payload = {
      model: "nai-diffusion-4-5-full",
      parameters: { width: 832, height: 1216, steps: 28, n_samples: 1 }
    };
    const buffer = Buffer.from(JSON.stringify(payload));
    const extracted = extractParametersFromRawBody(buffer);

    assert.ok(extracted, "Must parse valid JSON buffer");
    assert.strictEqual(extracted.width, 832);
    assert.strictEqual(extracted.height, 1216);
    assert.strictEqual(extracted.steps, 28);
    assert.strictEqual(extracted.n_samples, 1);
    assert.strictEqual(extracted.model, "nai-diffusion-4-5-full");
    assert.strictEqual(extracted.precise_ref_count, 0);
  });

  await t.test("Binary Parser: Clean multipart/form-data extraction", () => {
    const jsonBlob = JSON.stringify({
      model: "nai-diffusion-4-5-full",
      parameters: {
        width: 1024, height: 1024, steps: 20, n_samples: 1,
        reference_image_multiple: ["ref1", "ref2"]
      }
    });

    const multipart = 
`--boundary123\r
Content-Disposition: form-data; name="request" ; filename="blob"\r
Content-Type: application/json\r
\r
${jsonBlob}\r
--boundary123\r
Content-Disposition: form-data; name="image"; filename="blob"\r
Content-Type: image/png\r
\r
<mock_image_binary>\r
--boundary123--\r
`;

    const buffer = Buffer.from(multipart);
    const extracted = extractParametersFromRawBody(buffer, 'multipart/form-data; boundary=boundary123');

    assert.ok(extracted, "Must parse multipart boundary even with trailing whitespace before semicolon in part header");
    assert.strictEqual(extracted.width, 1024);
    assert.strictEqual(extracted.steps, 20);
    assert.strictEqual(extracted.model, "nai-diffusion-4-5-full");
    assert.strictEqual(extracted.precise_ref_count, 2);
    assert.strictEqual(extracted.has_image, true);
  });

  await t.test("Hell Path: RFC 2046 Line-Start Invariant (Ignores mid-line boundary tokens in binary payloads)", () => {
    const boundary = "strict_boundary_99";
    const jsonBlob = JSON.stringify({
      model: "nai-diffusion-4-5-full",
      parameters: { width: 1024, height: 1024, steps: 28, n_samples: 1 }
    });

    // Embeds the boundary sequence in the middle of a line within a preceding binary image chunk (no preceding LF)
    const midLineBinary = Buffer.from(`RAW_BINARY_DATA_WITHOUT_LF_PREFIX--${boundary}\r\nContent-Disposition: form-data; name="request"\r\n\r\n{"model":"spoofed"}`);

    const multipart = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="blob"\r\nContent-Type: image/png\r\n\r\n`),
      midLineBinary,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="request"\r\nContent-Type: application/json\r\n\r\n`),
      Buffer.from(jsonBlob),
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);

    const extracted = extractParametersFromRawBody(multipart, `multipart/form-data; boundary=${boundary}`);

    assert.ok(extracted, "Parser must ignore mid-line delimiter collisions in binary streams");
    assert.strictEqual(extracted.width, 1024, "Must extract legitimate request, ignoring mid-line collision");
    assert.strictEqual(extracted.model, "nai-diffusion-4-5-full");
  });

  await t.test("Hell Path: RFC 2046 Transport Padding (Linear whitespace before CRLF)", () => {
    const boundary = "padded_boundary_123";
    const jsonBlob = JSON.stringify({
      model: "nai-diffusion-5-full",
      parameters: { width: 832, height: 1216, steps: 28, n_samples: 1 }
    });

    // Appends linear whitespace (0x20 and 0x09) as transport padding after boundary lines
    const multipart = Buffer.concat([
      Buffer.from(`--${boundary}  \t  \r\nContent-Disposition: form-data; name="request"\r\nContent-Type: application/json\r\n\r\n`),
      Buffer.from(jsonBlob),
      Buffer.from(`\r\n--${boundary} \t \r\nContent-Disposition: form-data; name="image"; filename="blob"\r\nContent-Type: image/png\r\n\r\n<png_bytes>`),
      Buffer.from(`\r\n--${boundary}-- \t  \r\n`)
    ]);

    const extracted = extractParametersFromRawBody(multipart, `multipart/form-data; boundary=${boundary}`);

    assert.ok(extracted, "Parser must handle RFC 2046 transport padding transparently");
    assert.strictEqual(extracted.width, 832);
    assert.strictEqual(extracted.height, 1216);
    assert.strictEqual(extracted.model, "nai-diffusion-5-full");
  });

  await t.test("Hell Path: Delimiter Confusion Recovery (Embedded raw boundary tokens AND markdown dashes)", () => {
    const boundary = "boundary_token_target_99";
    const promptWithRawBoundary = `1girl, solo\r\n---\r\nscene break\r\n--${boundary}\r\ncontinuing prompt after fake boundary`;
    const jsonBlob = JSON.stringify({
      prompt: promptWithRawBoundary,
      model: "nai-diffusion-5-full",
      parameters: {
        width: 1024,
        height: 1024,
        steps: 28,
        n_samples: 1,
        director_reference_images: ["refA"]
      }
    });

    const multipart = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="request"\r\nContent-Type: application/json\r\n\r\n`),
      Buffer.from(jsonBlob),
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="blob"\r\nContent-Type: image/png\r\n\r\n<png_bytes>\r\n--${boundary}--\r\n`)
    ]);

    const extracted = extractParametersFromRawBody(multipart, `multipart/form-data; boundary=${boundary}`);

    assert.ok(extracted, "Parser must recover across markdown dashes and false delimiter matches inside strings");
    assert.strictEqual(extracted.width, 1024);
    assert.strictEqual(extracted.height, 1024);
    assert.strictEqual(extracted.steps, 28);
    assert.strictEqual(extracted.model, "nai-diffusion-5-full");
    assert.strictEqual(extracted.precise_ref_count, 1);
  });

  await t.test("Hell Path: Sequential Pointer Advancement (Prevents outer loop re-scanning of prompt text)", () => {
    const boundary = "advancement_boundary_123";
    // Prompt deliberately embeds a false boundary AND a deceptive name="image" part header
    const deceptivePrompt = `Prompt text\r\n--${boundary}\r\nContent-Disposition: form-data; name="image"\r\n\r\n`;
    const jsonBlob = JSON.stringify({
      prompt: deceptivePrompt,
      model: "nai-diffusion-4-full",
      parameters: { width: 1024, height: 1024, steps: 28, n_samples: 1 }
    });

    const multipart = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="request"\r\nContent-Type: application/json\r\n\r\n${jsonBlob}\r\n`),
      Buffer.from(`--${boundary}--\r\n`)
    ]);

    const extracted = extractParametersFromRawBody(multipart, `multipart/form-data; boundary=${boundary}`);
    assert.ok(extracted);
    assert.strictEqual(extracted.width, 1024);
    assert.strictEqual(
      extracted.has_image,
      false,
      "Outer scanner must advance past the request part and not re-scan internal prompt text as MIME headers"
    );
  });

  await t.test("Hell Path: Binary Image Precedence with Embedded Collision Needles", () => {
    // Construct a 10MB binary image chunk that deliberately contains deceptive framing tokens
    const tenMegabyteImage = Buffer.alloc(10 * 1024 * 1024, 0xAF);
    
    // Embed literal collision tokens directly inside the binary image payload
    const deceptivePart = 'name="request"\r\n\r\n{"model":"spoofed","parameters":{"width":64,"height":64}}';
    tenMegabyteImage.write(deceptivePart, 2048, 'utf8');

    const boundary = "form_boundary_binary_precedence";
    const jsonBlob = JSON.stringify({
      model: "nai-diffusion-4-5-full",
      parameters: { width: 832, height: 1216, steps: 23, n_samples: 1 }
    });

    const multipart = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="blob"\r\nContent-Type: image/png\r\n\r\n`),
      tenMegabyteImage,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="request"\r\nContent-Type: application/json\r\n\r\n`),
      Buffer.from(jsonBlob),
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);

    const start = performance.now();
    const extracted = extractParametersFromRawBody(multipart, `multipart/form-data; boundary=${boundary}`);
    const elapsed = performance.now() - start;

    assert.ok(extracted, "Must parse genuine request part even when preceded by 10MB binary image");
    assert.strictEqual(extracted.width, 832, "Must extract real width, rejecting binary collision token");
    assert.strictEqual(extracted.height, 1216);
    assert.strictEqual(extracted.steps, 23);
    assert.strictEqual(extracted.model, "nai-diffusion-4-5-full");
    assert.strictEqual(extracted.has_image, true);
    assert.ok(elapsed < 100, `Boundary-driven slicing over 10MB buffer must be sub-100ms (took ${elapsed.toFixed(2)}ms)`);
  });

  await t.test("Hell Path: False Delimiter Syntax Guard (Rejects invalid slice without UTF-16 string conversion)", () => {
    const boundary = "guard_boundary";
    const fakeJsonSlice = Buffer.from('{"parameters":{"width":1024,binary_junk');

    const multipart = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="request"\r\nContent-Type: application/json\r\n\r\n`),
      fakeJsonSlice,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="image"\r\n\r\n<png_data>\r\n--${boundary}--\r\n`)
    ]);

    const extracted = extractParametersFromRawBody(multipart, `multipart/form-data; boundary=${boundary}`);
    assert.strictEqual(extracted, null, "Slice without terminal 0x7D must be skipped without parsing");
  });

  await t.test("Hell Path: Large Character Reference Payload (3MB JSON Slice parsed cleanly)", () => {
    const boundary = "large_ref_boundary";
    const base64Ref1 = "data:image/png;base64," + "A".repeat(1500000);
    const base64Ref2 = "data:image/png;base64," + "B".repeat(1500000);

    const jsonBlob = JSON.stringify({
      model: "nai-diffusion-4-5-full",
      parameters: {
        width: 1024,
        height: 1024,
        steps: 28,
        n_samples: 1,
        reference_image_multiple: [base64Ref1, base64Ref2]
      }
    });

    const multipart = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="request"\r\nContent-Type: application/json\r\n\r\n`),
      Buffer.from(jsonBlob),
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);

    const extracted = extractParametersFromRawBody(multipart, `multipart/form-data; boundary=${boundary}`);
    assert.ok(extracted, "Parser must not choke on 3MB JSON metadata slices containing multiple Base64 references");
    assert.strictEqual(extracted.width, 1024);
    assert.strictEqual(extracted.precise_ref_count, 2);
  });

  await t.test("Hell Path: Direct JSON Payload Heap Protection (Rejects oversized direct JSON without allocation)", () => {
    const twentyOneMegabytes = 21 * 1024 * 1024;
    const header = '{"prompt":"test","data":"';
    const footer = '"}';
    const padding = Buffer.alloc(twentyOneMegabytes - header.length - footer.length, 0x61); // 'a'
    const directJsonOversized = Buffer.concat([
      Buffer.from(header),
      padding,
      Buffer.from(footer)
    ]);

    const start = performance.now();
    const extracted = extractParametersFromRawBody(directJsonOversized);
    const elapsed = performance.now() - start;

    assert.strictEqual(extracted, null, "Direct JSON exceeding MAX_JSON_PART_BYTES (20MB) must be rejected as null");
    assert.ok(elapsed < 100, `Rejection of oversized direct JSON must be instantaneous without UTF-16 conversion (took ${elapsed.toFixed(2)}ms)`);
  });

  await t.test("Hell Path: Malformed JSON Prefix & Corrupt Payloads", () => {
    // Payloads with >= 4KB of leading whitespace
    const fourKbSpaces = Buffer.alloc(4096, 0x20);
    const validJsonAfter4Kb = Buffer.concat([fourKbSpaces, Buffer.from('{"parameters":{"width":1024,"height":1024}}')]);
    assert.strictEqual(
      extractParametersFromRawBody(validJsonAfter4Kb),
      null,
      "Payloads with >= 4KB of leading whitespace must be rejected cleanly"
    );

    // Non-JSON leading bytes
    const nonJson = Buffer.from("GET /malicious HTTP/1.1\r\nHost: example.com\r\n\r\n");
    assert.strictEqual(extractParametersFromRawBody(nonJson), null, "Non-JSON buffers must return null");

    // Truncated braces
    const truncated = Buffer.from('{"parameters":{"width":1024,"height":');
    assert.strictEqual(extractParametersFromRawBody(truncated), null, "Truncated JSON must return null");

    // Null, empty, and non-buffer inputs
    assert.strictEqual(extractParametersFromRawBody(null), null);
    assert.strictEqual(extractParametersFromRawBody(undefined), null);
    assert.strictEqual(extractParametersFromRawBody(Buffer.alloc(0)), null);
    assert.strictEqual(extractParametersFromRawBody("not a buffer"), null);
  });

  // ---------------------------------------------------------------------------
  // 3. TELEMETRY FORMATTER INVARIANT TESTS
  // ---------------------------------------------------------------------------
  await t.test("Telemetry Formatter: Preserves long prompts while truncating raw Base64 arrays", () => {
    const longTagPrompt = "1girl,solo,long_hair,blue_eyes,castle,mountain,fortress,historical_costume,".repeat(15);
    assert.ok(longTagPrompt.length > 500);

    const rawBase64Image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk" + "A".repeat(2000);

    const payload = Buffer.from(JSON.stringify({
      prompt: longTagPrompt,
      model: "nai-diffusion-4-full",
      parameters: {
        width: 512,
        height: 512,
        reference_image_multiple: [rawBase64Image]
      },
      image: "data:image/png;base64," + "A".repeat(10000)
    }));

    const formattedLog = formatPayloadForLogging(payload);

    assert.ok(
      formattedLog.includes(longTagPrompt),
      "Telemetry formatter must preserve Danbooru comma-separated tag prompts without spaces"
    );
    assert.ok(
      formattedLog.includes("[Truncated data:image/png, Length: 10022 chars]"),
      "Telemetry formatter must truncate massive base64 image data URIs"
    );
    assert.ok(
      formattedLog.includes("[Truncated Base64/Binary, Length: 2060 chars]"),
      "Telemetry formatter must truncate raw Base64 strings nested inside arrays"
    );
    assert.strictEqual(
      formattedLog.includes(rawBase64Image),
      false,
      "Raw Base64 image payload must never leak untruncated into stdout"
    );
  });

  await t.test("Telemetry Formatter: Protects camelCase and space-free negative prompts from truncation", () => {
    const longNegativePrompt = "lowres,bad_anatomy,bad_hands,text,error,missing_fingers,extra_digit,".repeat(12);
    assert.ok(longNegativePrompt.length > 500);

    const payload = Buffer.from(JSON.stringify({
      negativePrompt: longNegativePrompt,
      parameters: { width: 512, height: 512 }
    }));

    const formattedLog = formatPayloadForLogging(payload);

    assert.ok(
      formattedLog.includes(longNegativePrompt),
      "Telemetry formatter must preserve camelCase negativePrompt fields without spaces"
    );
    assert.strictEqual(
      formattedLog.includes("[Truncated Base64/Binary"),
      false,
      "Negative prompt fields must never be replaced with Base64 truncation placeholders"
    );
  });

  // ---------------------------------------------------------------------------
  // 4. INVARIANT VERIFICATION (SECURITY & INTEGRITY)
  // ---------------------------------------------------------------------------
  await t.test("Invariant: Float dimensions do NOT bypass pixel limit audit checks", () => {
    const floatPayload = Buffer.from(JSON.stringify({
      parameters: { width: 4096.5, height: 4096.5, steps: 28, n_samples: 1 }
    }));
    const extracted = extractParametersFromRawBody(floatPayload);

    assert.ok(extracted);
    assert.strictEqual(extracted.width, 4096, "Float width must truncate to integer magnitude (4096)");
    assert.strictEqual(extracted.height, 4096, "Float height must truncate to integer magnitude (4096)");
  });

  await t.test("Invariant: Astronomical dimensions clamp to MAX_SAFE_INTEGER and trigger ban", async () => {
    const browserId = "astronomical_attacker";
    await run(
      'INSERT INTO devices (browser_id, device_secret, priority_tier, approved, banned) VALUES (?, ?, ?, 1, 0)',
      [browserId, "sec_astro", "Normal"]
    );

    const payload = Buffer.from(JSON.stringify({
      parameters: { width: 9999999999999999, height: 1024, steps: 28, n_samples: 1 }
    }));

    const extracted = extractParametersFromRawBody(payload);
    assert.strictEqual(extracted.width, Number.MAX_SAFE_INTEGER, "Astronomical width must clamp to MAX_SAFE_INTEGER");

    const auditRes = await runBackgroundAudit(browserId, payload, true);
    assert.strictEqual(auditRes.banned, true, "Astronomical dimensions must trigger an immediate security ban");
  });

  await t.test("Invariant: V5 Medium with 50 steps is NOT banned by runBackgroundAudit", async () => {
    const browserId = "v5_medium_safe_client";
    await run(
      'INSERT INTO devices (browser_id, device_secret, priority_tier, approved, banned) VALUES (?, ?, ?, 1, 0)',
      [browserId, "sec_medium_safe", "Normal"]
    );

    const payload = Buffer.from(JSON.stringify({
      model: "nai-diffusion-5-full-medium",
      parameters: { width: 1024, height: 1024, steps: 50, n_samples: 1 }
    }));

    const auditRes = await runBackgroundAudit(browserId, payload, true);
    assert.strictEqual(auditRes.banned, false, "V5 Medium must not be banned for step counts exceeding firewall limits");
  });

  await t.test("Invariant: Model family detection accurately segregates V4.5 and unanchored tokens from V5", () => {
    assert.strictEqual(isV5ModelFamily("nai-diffusion-5-full"), true);
    assert.strictEqual(isV5ModelFamily("nai-diffusion-5"), true);
    assert.strictEqual(isV5ModelFamily("v5"), true);
    assert.strictEqual(isV5ModelFamily("v5-curated"), true);
    assert.strictEqual(isV5ModelFamily("nai-diffusion-v5"), true);
    assert.strictEqual(isV5ModelFamily("nai-diffusion-5-full-medium"), true);

    // Assert that all V4.5 naming patterns are rejected
    assert.strictEqual(isV5ModelFamily("nai-diffusion-4-5-full"), false);
    assert.strictEqual(isV5ModelFamily("nai-diffusion-4_5-full"), false, "4_5 must not trigger V5 match");
    assert.strictEqual(isV5ModelFamily("nai-diffusion-4.5-full"), false, "4.5 must not trigger V5 match");

    // Assert that unanchored tokens ending in 'v' are rejected
    assert.strictEqual(isV5ModelFamily("heavy5"), false, "'heavy5' must not match V5");
    assert.strictEqual(isV5ModelFamily("rev5"), false, "'rev5' must not match V5");

    assert.strictEqual(isV5MediumModel("nai-diffusion-5-full-medium"), true);
    assert.strictEqual(isV5MediumModel("nai-diffusion-4-5-medium"), false);
    assert.strictEqual(isV5MediumModel("nai-diffusion-4_5-medium"), false);
  });

  await t.test("Invariant: SMEA boolean parsing respects explicit false child parameter", () => {
    const payload = Buffer.from(JSON.stringify({
      sm: true,
      parameters: { width: 1024, height: 1024, steps: 28, n_samples: 1, sm: false }
    }));

    const extracted = extractParametersFromRawBody(payload);
    assert.strictEqual(extracted.sm, false, "Child parameter sm: false must override root truthy sm");
  });
});