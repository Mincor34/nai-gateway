# Architectural Change Specification: Dual-Ledger Governance & Dynamic Compute Allocation

---

### Phase 1: The Optimistic Anlas Ledger & Parametric Bypass Pipeline

#### 1. What Changes
* **Decommissioning the Binary Parametric Firewall:** The rigid barrier in `proxyRouter.js` and `auditEngine.js` that dropped all generations exceeding baseline boundaries ($1024 \times 1024$, 1 sample, and 28 steps) is converted into a conditional gate. Any generation that breaches baseline parameters (dimensions $> 1\text{MP}$, samples $> 1$, or steps $> 28$) is classified as an Anlas-paid generation across all models. 
* **Model Polymorphy & Selective Parameter Firewalls:** The gateway recognizes two distinct V5 models: `nai-diffusion-5-full` (High Effort) and `nai-diffusion-5-full-medium` (Medium Effort).
  * For `nai-diffusion-5-full`, free-tier generations ($\le 1\text{MP}$, 1 sample) are constrained to $\le 23$ steps; free V5 High requests with 24–28 steps are strictly rejected (`HTTP 400 PARAMETRIC_LIMIT_EXCEEDED`) to prevent upstream battery drainage.
  * For `nai-diffusion-5-full-medium`, NovelAI's upstream backend hardcodes generation effort and silently ignores all auxiliary parameters. Consequently, the gateway firewall and audit engine for `nai-diffusion-5-full-medium` **validate strictly dimensions ($\le 1\text{MP}$ for free) and sample count ($n_{\text{samples}} = 1$)**, bypassing step-count validation and the 24–28 deadband check entirely.
* **Pre-Upstream Synchronous Gate & Point of No Return (PoNR) Accounting:** Rather than relying on fragile post-hoc asynchronous audits, parameter extraction and cost evaluation execute synchronously at `req.on('end')` on the in-memory buffer before the upstream socket is opened. Balance deductions follow a strict two-phase commit: an in-memory reservation hold is placed pre-dispatch, and the SQLite ledger debit is committed **if and only if** NovelAI responds with `HTTP 200 OK` (the Point of No Return).
* **Dual-Mode Zero-Copy Buffer Extractor:** Slicing logic operates directly on binary `Buffer` primitives without converting multi-megabyte payloads to UTF-16 strings or running regular expressions over image data. The extractor dynamically branches between RFC 7578 multipart streams (extracting `boundary` from `Content-Type`, locating `name="request"`, headers delimiter `\r\n\r\n` within 4KB, and trailing boundary `\r\n--${boundary}`) and raw RFC 8259 JSON bodies (with a bounded 4KB prefix scan skipping leading whitespace `0x20`, `0x0A`, `0x0D`, `0x09`).
* **Two-Phase Concurrency Handshake & Slowloris Protection:** Payload staging is decoupled from Channel A exclusive execution locks. Inbound buffering is gated by an ingress upload semaphore (`activeBufferingStreams <= 2`) to protect the 200MB PM2 memory ceiling. Inbound body streams on `/proxy/` enforce an upload streaming inactivity timeout (5 seconds without incoming data) and an absolute upload ceiling (60 seconds) to prevent slow mobile connections from holding connections indefinitely. The exclusive Channel A GPU execution lock is claimed strictly after the payload is fully buffered and validated in local VPS RAM, eliminating wide-area network transit delays from the GPU lock window.
* **Channel B Vibe Extraction Metering & Patch:** Resolves the unmetered bypass and schema crash vulnerabilities in `proxyRouter.js`. The `/ai/encode-vibe` endpoint is formally assigned to Channel B shared concurrency (`acquireTextSlot()`), enforces bearer token authentication, runs a dedicated image-presence validator that bypasses generation parameter extraction entirely, requires $\text{Available Balance} \ge 2\text{ Anlas}$, places an atomic reservation hold, and commits an integer 2 Anlas debit per uncached image upon upstream `HTTP 200 OK`.
* **Cross-Channel Defense-in-Depth Reservation Accounting:** `activeTextLocks` in `QueueCoordinator` is upgraded from a primitive timestamp map to a structured record map: `{ timestamp, user_id, held_cost }`. Available balance is computed dynamically across all active execution channels:
  $$\text{Available Balance} = \text{users.virtual\_anlas\_balance} - \sum_{\{t \in \text{queue} \mid t.\text{user\_id} = \text{user\_id}\}} t.\text{held\_cost} - \sum_{\{l \in \text{activeTextLocks} \mid l.\text{user\_id} = \text{user\_id}\}} l.\text{held\_cost}$$
  Attaching `held_cost` directly to the `task` record in `QueueCoordinator` and to `activeTextLocks` ensures holds automatically terminate if a task is completed, evicted, or purged by the TTL scavenger.
* **TTL Clock Re-Anchoring:** At the exact millisecond `req.on('end')` fires, parameter validation succeeds, and the Channel A lock is claimed, the gateway invokes `queueManager.reanchorProcessingTimestamp(req_id)`. This resets `task.started_processing_at = Date.now()`, granting upstream NovelAI the full, unpenalized 75-second GPU processing window regardless of client upload transit duration.
* **Optimistic Header Ingress Assertion with Step-3 Anti-Spoofing Reconciliation:** Step 1 host defense evaluates model identity and parametric limits optimistically from routing headers to reject unauthenticated or non-whitelisted traffic before allocation. At `req.on('end')`, extracted body parameters are reconciled against declared headers; any intentional discrepancy (e.g., header declared 1024px, body requested 2048px, or header declared Medium while body requested High) triggers an immediate `HTTP 403` and permanent database ban for active firewall evasion.
* **Native JavaScript Pricing Engine & Upstream Specification Tracking:** Anlas costs are calculated authoritatively on the server and client using a native JavaScript port of the reverse-engineered NovelAI pricing formula (mirroring `anlas-calculation.md`), covering base resolution curves, step multipliers, SMEA flags (`sm`, `sm_dyn`), Img2Img strength, precise character reference surcharges, and vibe transfer encoding fees:
  * For `nai-diffusion-5-full`, costs follow standard V5 formulas.
  * For `nai-diffusion-5-full-medium`, Anlas-paid generations (dimensions $> 1\text{MP}$ or samples $> 1$) are priced authoritatively using **14 steps scaled by a `step_factor` of $1 / 1.06521739$ ($\approx 13.143$ steps)**, exactly tracking upstream billing behavior without calculation drift.
  * The repository maintains an automated CI diff-checker targeting upstream documentation updates.
* **Dual-Header Telemetry & Spend Authorization:** The client scrapes NovelAI's rendered UI cost and calculates local formula costs. It transmits NovelAI's UI figure as a telemetry canary (`X-Scraped-Anlas`) and its authorized spending ceiling as an operational parameter (`X-Declared-Anlas` / `X-Max-Authorized-Anlas`).
* **True Parameter Tampering Detection vs. Canary Logging:** Discrepancies between server calculations and client-scraped values are logged as operational telemetry drift warnings to detect upstream formula changes without punishing users. Permanent database bans are strictly reserved for actual parameter forgery (mismatches between custom routing headers and raw payload body parameters).
* **Database Ledger Normalization & Temporal Usage Tracking:** The `users` and `devices` tables are expanded to maintain dedicated virtual Anlas balances (a static monthly quota defined per tier without rollover on a rolling 30-day epoch, with negative debt offsetting fresh allocations), overdraft debt states, and segregated monthly/subscription-period consumption metrics alongside lifetime counters.

#### 2. How It Changes
* **Ingress Assertion Flow:** 
  * The client inspects generation settings and model identity (`model`).
  * For `nai-diffusion-5-full-medium`: If dimensions $\le 1\text{MP}$ and samples $= 1$, it is classified as a **Free Generation**, regardless of step count (which defaults to 14 and is ignored upstream). If dimensions $> 1\text{MP}$ or samples $> 1$, it is classified as an **Anlas-Paid Generation** and priced using 14 steps scaled by `step_factor` ($1 / 1.06521739$).
  * For `nai-diffusion-5-full` and legacy models: If ANY baseline Opus boundary is exceeded (dimensions $> 1\text{MP}$, samples $> 1$, or steps $> 28$), the generation is classified as an **Anlas-Paid Generation**.
  * If parameters fall within baseline Opus limits (dimensions $\le 1\text{MP}$, 1 sample, steps $\le 28$), the generation is classified as a **Free Generation**. For `nai-diffusion-5-full` (High), free generations are policy-limited to $\le 23$ steps. If a V5 High generation is free ($\le 1\text{MP}$, 1 sample) but requests 24–28 steps, it is rejected immediately with `HTTP 400 PARAMETRIC_LIMIT_EXCEEDED` because NovelAI bills it at 0 Anlas upstream while heavily draining the master V5 battery.
  * For legal parameter sets, the client evaluates whether settings require base Anlas. If baseline limits are respected (dimensions $\le 1\text{MP}$, 1 sample; steps $\le 23$ for V5 High, $\le 28$ for legacy, or unconstrained for V5 Medium), base Anlas cost is $0$. If any baseline boundary is exceeded, it computes the required base Anlas. Addons (precise references at 5 Anlas each, vibe encodes at 2 Anlas each) are calculated orthogonally.
  * The client scrapes NovelAI's rendered button cost ($C_{\text{scraped}}$) and evaluates its local formula cost ($C_{\text{calc}}$). If $|C_{\text{scraped}} - C_{\text{calc}}| > 0$, the client UI alerts the user: *"Displayed cost may differ from estimate."*
  * The client appends `X-Base-Paid: true | false`, `X-Scraped-Anlas: <integer>`, and `X-Declared-Anlas: <integer>` (the authorized spending limit) to the request headers. Bypass headers transmitted on Channel B text generation are ignored.
  * When `X-Base-Paid` is false and total declared Anlas is 0, baseline parametric boundaries remain strictly enforced at zero Anlas cost.
  * When `X-Base-Paid` is true or `X-Declared-Anlas > 0`, the ingress gate asserts that the user's assigned tier permits bypass. It verifies that the user is not currently in an active Anlas debt state (`virtual_anlas_balance < 0`).
  * **Violation of Debt Lockout:** If a user with an active Anlas debt ($\text{balance} < 0$) attempts to transmit a generation request requiring Anlas (`X-Declared-Anlas > 0`), the gateway flags this as an intentional circumvention attempt. The request is rejected with `HTTP 403 DEBT_LOCKED`. Baseline free Opus generations ($0\text{ Anlas}$) remain fully operational.
  * If the user is in good standing, the gate checks if the declared cost is $\le$ the user's available virtual Anlas balance.
  * If the balance is sufficient, an in-memory reservation hold is placed, and the request proceeds to buffer or queue.
  * If the balance is insufficient, the request is rejected with `HTTP 403 INSUFFICIENT_ANLAS` without opening an upstream socket.
* **Pre-Buffer Ingress Defense & Concurrency Gate:**
  * Subdomain and path are asserted against the whitelist (`SUBDOMAIN_WHITELIST`, `PROXY_PATH_WHITELIST`).
  * Ingress calls `req.pause()` while asynchronous device verification runs against SQLite (`verifyDevice`).
  * Ingress buffering is governed by an atomic counting semaphore: `activeBufferingStreams <= 2`. If two streams are actively uploading, subsequent uploads receive `HTTP 429 UPLOAD_PIPELINE_SATURATED`. This limits buffer allocation to $2 \times 50\text{MB} = 100\text{MB}$, protecting the 200MB PM2 memory ceiling without starving Channel A.
  * Inbound sockets bind an upload inactivity deadline (`req.socket.setTimeout(5000)`) and an upload duration ceiling (`setTimeout(..., 60000)`). If body accumulation stalls for 5 seconds or exceeds 60 seconds total, the socket is destroyed, any reservation hold is released, and the transaction is aborted.
* **Dual-Mode Buffer Parsing (`req.on('end')`):**
  * When accumulation completes, `payloadBuffer` is evaluated in binary space:
    * **Multipart Branch (`buffer[0] === 0x2D && buffer[1] === 0x2D`):** 
      1. Extracts `boundary` from `req.headers['content-type']`.
      2. Constructs binary delimiters: `needleBoundary = Buffer.from('\r\n--' + boundary)` and `needleRequest = Buffer.from('name="request"')`.
      3. Uses `buffer.indexOf(needleRequest)` to locate the request part.
      4. Finds the header-body boundary `\r\n\r\n` (`0x0D 0x0A 0x0D 0x0A`), asserting the distance from `needleRequest` is $\le 4,096$ bytes.
      5. Finds the trailing boundary delimiter `\r\n--${boundary}` after `jsonStart`. Asserts `boundaryEnd !== -1 && boundaryEnd > jsonStart`.
      6. Extracts exclusively that slice: `payloadBuffer.subarray(jsonStart, boundaryEnd)`.
      7. Calls `JSON.parse()` strictly on that extracted slice (~1KB–2KB), leaving multi-megabyte binary PNG chunks untouched in memory.
    * **JSON Branch (Direct JSON Document):**
      1. Scans `buffer.subarray(0, Math.min(buffer.length, 4096))` for the first non-whitespace byte (`0x20`, `0x0A`, `0x0D`, `0x09`).
      2. Asserts the first non-whitespace byte is `0x7B` (`{`). If not, rejects immediately with `HTTP 400 MALFORMED_JSON`.
      3. Parses `payloadBuffer.toString('utf8')` directly via native C++ `JSON.parse()`.
  * Extracts: width, height, steps, samples, model, `sm`, `sm_dyn`, `strength`, `inpaintImg2ImgStrength`, reference counts, and uncached vibe counts.
* **Parameter Forgery Verification (Active Evasion Ban):**
  * Reconciles physical parameters against routing headers: `X-Gen-Width === body.width`, `X-Gen-Height === body.height`, `X-Gen-Steps === body.steps`, `X-Gen-Samples === body.n_samples`, and asserted model family.
  * If an adversarial client set `X-Gen-Model: legacy` or `X-Gen-Width: 1024` to pass Step 1 ingress, but embedded a V5 model or 2048px in the payload body, the gateway flags active evasion:
    * Rejects with `HTTP 403 FORBIDDEN`.
    * Commits permanent ban: `users.banned = 1`, `devices.banned = 1`.
    * Dispatches unnotified ban record for Discord bot alert.
    * Releases all queue locks and reservation holds.
* **The Point of No Return (PoNR) Transaction Lifecycle:**
  * The server computes authoritative cost: $C_{\text{auth}} = \text{calculateAnlasCost}(\text{extractedParams})$ (with `nai-diffusion-5-full-medium` evaluated at 14 steps $\times 1 / 1.06521739$).
  * If $C_{\text{auth}} > \text{Available Balance}$, rejects with `HTTP 403 INSUFFICIENT_ANLAS`.
  * If $C_{\text{auth}} > \text{X-Declared-Anlas}$, rejects with `HTTP 400 SPEND_CAP_EXCEEDED`.
  * **Channel A Lock Claim:** For image generation requests, the request now claims the Channel A exclusive execution lock.
  * **The Hold:** Sets `task.held_cost = C_auth` directly on the active task in `QueueCoordinator.queue`.
  * **TTL Re-Anchoring:** Invokes `queueManager.reanchorProcessingTimestamp(req_id)` to reset `task.started_processing_at = Date.now()`, granting NovelAI the full 75-second GPU inference window without upload penalty.
  * **Upstream Dispatch:** Outbound request is written to NovelAI.
  * **Pre-PoNR Failure:** If upstream returns `HTTP 4xx`, `HTTP 5xx`, or the TCP socket drops before response headers arrive:
    * Clear `task.held_cost = 0`.
    * The user is charged **0 Anlas**.
    * Rejects client with `HTTP 502 Bad Gateway`.
  * **The Point of No Return (HTTP 200 Received):**
    * The exact millisecond NovelAI returns `HTTP 200 OK`, master account Anlas is consumed.
    * The server commits the debit to SQLite immediately:
      `UPDATE users SET virtual_anlas_balance = virtual_anlas_balance - ?, subscription_period_anlas = subscription_period_anlas + ? WHERE user_id = ?`
    * Clears `task.held_cost = 0`.
  * **Post-PoNR Failure:** If the connection drops or the client disconnects mid-stream *after* `HTTP 200`, the transaction is a sunk cost. The debit stands. No refunds are granted.
* **Channel B Vibe Transfer Processing Pipeline (`/ai/encode-vibe`):**
  * Client sends vibe extraction request to `/proxy/image/ai/encode-vibe`.
  * Bypasses `extractParametersFromRawBody`. Dedicated validator verifies image binary presence without searching for `name="request"`.
  * Server claims a Channel B concurrency slot via `queueManager.acquireTextSlot(reqId, userId, 2)`.
  * Asserts user virtual balance $\ge 2\text{ Anlas}$. Places an in-memory reservation hold for 2 Anlas associated with `reqId` in `activeTextLocks`.
  * Buffers binary image payload.
  * Dispatches to NovelAI upstream.
  * If upstream fails pre-headers, releases hold and slot with zero charge.
  * Upon upstream `HTTP 200 OK`, commits 2 Anlas deduction to SQLite, clears hold in `activeTextLocks`, and streams vibe vector back to client.
  * Releases Channel B slot on stream completion.
* **Operational Canary Telemetry:**
  * Compares $C_{\text{auth}}$ against `X-Scraped-Anlas`.
  * If $|C_{\text{auth}} - \text{X-Scraped-Anlas}| > 0$, logs an operational canary event:
    `[VPS Telemetry Canary] Formula drift detected: Upstream UI reported ${X-Scraped-Anlas}, server calculated ${C_auth}. Check upstream specification.`
  * Zero bans or rejections are executed against the user for calculation drift.

#### 3. Why It Is Done This Way
* **Deterministic Single-Pass Verification:** Slicing the JSON metadata out of memory at `req.on('end')` takes $< 0.05\text{ ms}$, eliminating post-hoc asynchronous reconciliation, two-stage refund loops, and permanent ban tripwires entirely.
* **Transaction Atomicity via PoNR:** Gating SQLite ledger commits strictly behind upstream `HTTP 200` ensures network instability never drains user balances, while enforcing sunk-cost guarantees prevents client-side socket-termination exploits.
* **Elimination of Cross-Channel Arbitrage:** Upgrading `activeTextLocks` to track `{ timestamp, user_id, held_cost }` allows dynamic balance derivation to accurately aggregate holds across both Channel A and Channel B, preventing concurrent double-spending on shared ledgers.
* **Protection Against Memory & Concurrency Exhaustion:** Decoupling 50MB ingress upload staging from Channel A GPU locks via an upload semaphore (`activeBufferingStreams <= 2`) prevents multi-client PM2 heap crashes, while the 5-second socket timeout and 60-second upload cap prevent slow clients from starving Channel A inference windows.
* **RFC-Compliant Binary Slicing:** Scanning for multipart delimiters using explicit `\r\n--${boundary}` tokens prevents prompt dashes from breaking JSON parsing, avoids allocating 50MB UTF-16 strings, and maintains sub-millisecond execution.
* **Schema-Isolated Endpoints:** Providing `/ai/encode-vibe` with an isolated validation path prevents 100% false-positive rejection of vibe vectors while maintaining strict ledger accounting.
* **True Security Separation:** Reconciling body parameters against ingress headers preserves fast rejection at Step 1 while ensuring deliberate evasion attempts trigger immediate permanent bans.
* **Model-Appropriate Firewall Alignment:** Adhering to NovelAI's upstream behavior for `nai-diffusion-5-full-medium` eliminates artificial deadband rejections on an endpoint where the server hardcodes steps and ignores auxiliary inputs.

---

### Phase 2: Dynamic Proportional V5 Compute Engine & Hydraulic Tariff Coordination

#### 1. What Changes
* **Raw Compute Metrics & Model Effort Accounting:** Upstream NovelAI provides two effort levels for V5:
  * **V5 Full (High Effort - `nai-diffusion-5-full`):** $\approx 1705\text{ images/week}$ ($\approx 243.5\text{ images/day}$, draining $1 / 17.28\% \approx 0.05787\%$ of master battery per image, or $17.28\text{ images per } 1\%$).
  * **V5 Full (Medium Effort - `nai-diffusion-5-full-medium`):** $\approx 3060\text{ images/week}$ ($\approx 437.1\text{ images/day}$, draining $\approx 0.03223\%$ of master battery per image, or $31.02\text{ images per } 1\%$, representing **42% less usage** than High).
* **Normalized Compute Points (NCP) Ledger:** To prevent floating-point balance corruption and unspendable token fractions in SQLite, V5 compute allocations and debits are denominated in **Normalized Compute Points (NCP)**:
  * **1 Medium Generation = 10 NCP**
  * **1 High Generation = 18 NCP** (reflecting the exact $1705 / 3060 \approx 0.557$ ratio: $10 / 18 = 0.5556$).
  * Tier daily quotas are granted in clean integer NCP balances (e.g., Normal tier receives 180 NCP/day, permitting 10 High or 18 Medium generations).
* **Dynamic Refill Velocity Tracking:** The hardcoded assumption of an 11% daily replenishment rate is replaced with dynamic rate derivation using NovelAI's live `timeUntilNextPercent` telemetry metric, normalized dynamically (converting milliseconds to seconds if $> 10,000$), clamped against strict operational bounds (rejecting values $< 1800$ or $> 10000$ seconds as API hallucinations), and falling back to a static baseline constant (`NOMINAL_DAILY_V5_COMPUTE = 190.0` High-equivalent images/day, or $3420\text{ NCP/day}$, in `config.js`) when the upstream tank is full, telemetry is null, or the returned value breaches sanity bounds.
* **Strict Decoupling of Anlas from V5 Compute:** Virtual Anlas is strictly restricted to parametric bypass operations ($>1024 \times 1024$, $>1$ sample, $>28$ steps across legacy/High models) and addon surcharges. Virtual Anlas cannot be spent to override, subsidize, or bypass V5 subscription battery limits. Free generations within the V5 High battery deadband ($24 \le \text{steps} \le 28$ at $\le 1\text{MP}$, 1 sample) are unconditionally prohibited. V5 generations that incur a base Anlas charge due to resolution ($> 1\text{MP}$), sample count ($> 1$), or step count ($> 28$) (`X-Base-Paid: true`) do not deduct from the user's V5 NCP allowance or upstream V5 battery, as NovelAI excludes Anlas-paid generations from the subscription meter. Addon Anlas (e.g., precise references) does not exempt an otherwise baseline V5 image from battery deduction.
* **Hydraulic Two-Bucket Allocation Model:** Replacing flat daily resets with a dual-bucket structure:
  * **Bucket 1 (Personal Rollover Bank):** Accumulates daily tier NCP shares over time up to a strict multi-day cap (`v5MaxBankDays`, e.g., 3 days), protecting casual and weekend users from losing unspent allocations. Evaluated lazily on request arrival.
  * **Bucket 2 (Dynamic Cluster Surplus Pool):** Activates only when the master tank rises above $50\%$, routing unconsumed replenishment to active users to prevent compute from idling and rotting at $100\%$. Evaluated strictly inside the synchronous `sweep()` garbage collector once every 24 hours to **replace/overwrite** the pool with the smoothed physical surplus ($\min(S_{\text{daily}}, \text{physical compute above 50\%})$ denominated in NCP) rather than stacking unboundedly, remaining spendable down to zero without mid-day lockouts.
* **Pre-Flight Queue Gatekeeping by Model:** Evaluating V5 NCP eligibility at `POST /queue/join` using the explicit `model` identifier, reserving 18 NCP for High or 10 NCP for Medium. This eliminates queue starvation and phantom lock promotions for depleted clients, with in-memory reservation holds bound strictly to the `QueueCoordinator` lifecycle (`sweep`, `evict`, `complete`) to prevent token leaks on client abandonment.
* **Projected Master Battery Modeling with Weighted Dispatches:** Eliminating raw integer decrement drift by projecting live upstream capacity using the verified static period, elapsed time in seconds, and **cost-weighted local dispatch counts**:
  $$\text{Local Dispatches (Weighted)} = N_{\text{high}} + (0.557 \times N_{\text{medium}})$$
  Combined with dynamic telemetry polling escalation bounded to a minimum 60-second floor (`TELEMETRY_COOLDOWN_MS`) to protect against Cloudflare edge rate-limiting.
* **Hard Operational Circuit Breaker & Solvency Floor:** Replacing passive depletion warnings with an unyielding execution-level circuit breaker at $5.5\%$ master capacity, preventing the master account from breaching the $5\%$ floor and triggering a multi-hour cluster blackout.
* **Subscription-Period Ledger Tracking:** Adding explicit tracking for monthly/subscription-period generation volume (images generated, text tokens routed, and Anlas consumed) alongside global lifetime aggregates, with negative database debits clamped via `MAX(0, balance - 1)`.

#### 2. How It Changes
* **Telemetry Harvester Expansion & Dynamic Projection:**
  * The harvester in `server.js` parses the full `usage` payload from `/user/subscription`, capturing `percent`, `timeUntilNextPercent`, and `isNegative`.
  * Dynamic daily nominal capacity ($C_{\text{base}}$, High-equivalent images) is computed by normalizing `timeUntilNextPercent`:
    $$\text{normalizedPeriod} = \text{timeUntilNextPercent} > 10000 \ ? \ \left\lfloor \frac{\text{timeUntilNextPercent}}{1000} \right\rfloor : \text{timeUntilNextPercent}$$
    $$C_{\text{base}} = \left( \frac{86,400}{\text{normalizedPeriod}} \right) \times 17.28$$
    If `normalizedPeriod` is $\le 0$, missing, or outside the hard sanity bounds of $[1800, 10000]$, it falls back strictly to `config.NOMINAL_DAILY_V5_COMPUTE`.
    $$C_{\text{base}} = \max(100.0, \min(300.0, C_{\text{base}}))$$
    $$\text{Nominal Daily NCP} = \lfloor C_{\text{base}} \times 18 \rfloor$$
  * Continuous capacity in RAM is projected as:
    $$\text{Elapsed Seconds} = \frac{\text{Date.now}() - \text{Last Sync Epoch}}{1000}$$
    $$\text{Refill Velocity (percent/sec)} = \frac{1}{\text{Active Period Constant}}$$
    $$\text{Weighted Dispatches} = N_{\text{high}} + (0.557 \times N_{\text{medium}})$$
    $$\text{Estimated Battery \%} = \min\left(100, \text{Last Telemetry \%} + (\text{Elapsed Seconds} \times \text{Refill Velocity}) - \left( \frac{\text{Weighted Dispatches}}{17.28} \right)\right)$$
  * Upstream telemetry polling dynamically adapts based on projected capacity, bounded to a 60-second minimum floor:
    * **$> 30\%$:** Poll every 10 minutes (`600,000 ms`).
    * **$15\% - 30\%$:** Poll every 2 minutes (`120,000 ms`).
    * **$\le 15\%$:** Poll every 60 seconds (`60,000 ms`).
  * Telemetry updates reset `dispatchesSinceSync = 0`, reset model dispatch counters, and re-anchor `Last Telemetry %` to authoritative upstream data.
* **State Engine Integration & Synchronized Global Epoch (Lazy Accrual Engine):**
  * Attributes in the `users` schema track daily V5 allowance, banked V5 NCP balance (`v5_banked_balance`), daily V5 consumed count, last daily reset epoch (`v5_last_accrual_epoch`), subscription-period V5 consumed, subscription-period Anlas consumed, and subscription billing cycle start epoch.
  * Shared cluster surplus state is stored persistently in the `config` table (`v5_surplus_pool`, `v5_surplus_last_accrual`).
  * **Lazy Accrual Execution (Personal Buckets):**
    * Accrual executes lazily upon user request arrival in `auditEngine.js` (`evaluateV5Accrual`) when $\text{Elapsed Days} = \frac{\text{Date.now}() - \text{users.v5\_last\_accrual\_epoch}}{86,400,000} \ge 1.0$:
      $$W_{\text{all}} = \sum_{u \in \text{Approved Users}} \text{tierConfig}[u.\text{tier}].\text{v5Weight}$$
      $$r_i = \text{Nominal Daily NCP} \times \left( \frac{\text{tierConfig}[u_i.\text{tier}].\text{v5Weight}}{W_{\text{all}}} \right)$$
    * Each user accumulates quota up to their tier's retention horizon:
      $$C_{\text{personal}, i} = r_i \times \text{tierConfig}[u_i.\text{tier}].\text{v5MaxBankDays}$$
      $$\text{New Banked Balance} = \min(C_{\text{personal}, i}, \text{users.v5\_banked\_balance} + (\lfloor r_i \rfloor \times \lfloor\text{Elapsed Days}\rfloor))$$
    * Consumed counters reset: `v5_daily_consumed = 0`, and `v5_last_accrual_epoch` is updated.
  * **Bucket 2 Accrual (Dynamic Cluster Surplus):** 
    * Moved strictly into the synchronous `QueueCoordinator.sweep()` garbage collector. Evaluated once every 24 hours.
    * If projected master capacity $> 50\%$, surplus compute is smoothed over a 2-day horizon ($H = 2$) and **overwrites** the pool balance in NCP:
      $$S_{\text{daily}} = \left\lfloor \frac{(\text{Current Tank Percent} - 50) \times 17.28 \times 18}{2} \right\rfloor$$
      `UPDATE config SET value = ? WHERE key = 'v5_surplus_pool'` (setting value to $S_{\text{daily}}$).
    * If projected master capacity $\le 50\%$, the pool balance is cleared:
      `UPDATE config SET value = '0' WHERE key = 'v5_surplus_pool'`.
    * Update `v5_surplus_last_accrual` to `Date.now()`.
* **Two-Stage Hydraulic Ingress Gatekeeping:**
  * **Stage 1: Pre-Flight Queue Gating (`POST /queue/join`):**
    * Ingests explicit `model` parameter (`nai-diffusion-5-full` vs `nai-diffusion-5-full-medium`).
    * Evaluates required compute: $\text{ReqNCP} = (\text{model} === 'nai-diffusion-5-full-medium') \ ? \ 10 : 18$.
    * If `model === 'nai-diffusion-5-full'`, dimensions $\le 1\text{MP}$, samples $= 1$, and $24 \le \text{steps} \le 28$, reject immediately with `HTTP 400 PARAMETRIC_LIMIT_EXCEEDED` (free-tier battery deadband violation). For `nai-diffusion-5-full-medium`, deadband check is bypassed.
    * When evaluating V5 queue requests:
      1. **Circuit Breaker Check:** If $\text{Projected Master Battery} \le 5.5\%$ and request is not base-paid, reject immediately with `HTTP 503 V5_BATTERY_CRITICAL`.
      2. **Anlas-Paid Exemption Check:** If `is_base_paid === true` (request burns Anlas for resolution $> 1\text{MP}$, samples $> 1$, or steps $> 28$), bypass V5 allocation checks entirely.
      3. **Bucket 1 Check:** If `v5_banked_balance - in_memory_holds >= ReqNCP`, place a temporary in-memory hold on `ReqNCP` bound to `req_id` and permit queue entry.
      4. **Bucket 2 Check:** If `v5_banked_balance < ReqNCP`, verify if `v5SurplusEligible` is true for user tier and `v5_surplus_pool - in_memory_surplus_holds >= ReqNCP`. If true, place an in-memory hold on `ReqNCP` surplus tokens bound to `req_id` and permit queue entry.
      5. **Exhaustion Lockout:** If neither bucket can satisfy the request, reject immediately with `HTTP 429 V5_CAPACITY_DEPLETED`. The client does not enter the queue and does not hold an active slot.
    * **Reservation Teardown Watchdog:**
      * When `QueueCoordinator.complete(reqId, browserId)` is called, the in-memory hold associated with `reqId` is deleted.
      * When `QueueCoordinator.evict(target)` runs, all in-memory holds associated with evicted request IDs are deleted.
      * In `QueueCoordinator.sweep()`, whenever a task is purged for inactivity (`QUEUE_POLL_TIMEOUT_MS`) or processing timeout (`QUEUE_PROCESSING_TIMEOUT_MS`), its in-memory hold is deleted immediately.
  * **Stage 2: Piped Proxy Execution & Commit (`proxyRouter.js`):**
    * Client buffers full body after passing upload semaphore.
    * Pre-upstream validation checks model and parameters at `req.on('end')`.
    * Upstream socket opens.
    * **Pre-PoNR Failure Handling:** If upstream responds with non-200, socket reset, or timeout *before headers arrive*, the in-memory reservation hold is released. Zero tokens deducted.
    * **Point of No Return Commit (`statusCode === 200`):**
      * If satisfied by Bucket 1: 
        `UPDATE users SET v5_banked_balance = MAX(0, v5_banked_balance - ?), v5_daily_consumed = v5_daily_consumed + 1, subscription_period_v5 = subscription_period_v5 + 1 WHERE user_id = ?` (binding `ReqNCP`).
      * If satisfied by Bucket 2:
        `UPDATE config SET value = MAX(0, CAST(value AS INTEGER) - ?) WHERE key = 'v5_surplus_pool'` (binding `ReqNCP`),
        and increment `users.v5_daily_consumed` and `users.subscription_period_v5`.
      * Record dispatch: increment $N_{\text{high}}$ or $N_{\text{medium}}$ for weighted battery tracking.
      * Delete the in-memory reservation hold.

#### 3. Why It Is Done This Way
* **Elimination of Phantom Anlas Fallback & Lockout Prevention:** Virtual Anlas inside the gateway does not purchase upstream V5 battery charge. Permitting users to spend virtual Anlas to push the master tank down to 1% results in zero Anlas spent upstream while forcing the entire cluster into an unrecoverable 6.7+ hour operational freeze.
* **Discrete Compute Units Eliminate Truncation Drift:** Denominating V5 allocations in Normalized Compute Points (18 NCP for High, 10 NCP for Medium) cleanly models NovelAI's 42% Medium efficiency gain while keeping SQLite ledgers strictly in integer space.
* **Weighted Battery Modeling Prevents Premature Shutdown:** Distinguishing High vs Medium dispatches prevents local projections from draining $1.8\times$ faster than reality during Medium generation sessions.
* **Prevention of Queue Starvation:** Evaluating V5 quotas inside `queueRouter.js` guarantees that depleted clients are rejected at the door. They cannot wait in line, acquire Channel A execution locks, and block solvent users before failing at the proxy.
* **Mathematical Solvency Guarantee (The 50% Anchor):** Total virtual liabilities across all registered users are strictly bounded by their 3-day caps ($\sum C_{\text{personal}} \le 3 \times C_{\text{base}}$). Holding a $50\%$ baseline ensures that even if every registered user generates simultaneously, the tank drops safely without violating the $5.5\%$ circuit breaker or $5\%$ NovelAI floor.
* **Fairness for Casual and Weekend Users:** Users who do not generate on weekdays accumulate up to 3 days of generation allowance in Bucket 1. They are not penalized for being offline, and their quota is fully solvent upon their return.
* **Anti-Waste Dynamic Drainage:** Inactive users stop absorbing physical replenishment once their personal bank caps out. The unconsumed compute drives the tank past $50\%$, unlocking Bucket 2 for active users to burn down before compute is permanently discarded at $100\%$, while non-accumulating 24-hour pool replacement prevents unspent surplus from stacking into phantom debt.
* **Protection Against Egress Resets:** Committing quota deductions strictly gated behind execution boundaries prevents transient network failures from stripping user balances.

---

### Phase 3: Client UserScript Experience & Telemetry Pipeline

#### 1. What Changes
* **HUD and Settings Unification:** The local UI reflects the decoupled dual-engine reality: persistent rolling Anlas balance (including negative debt indicators for parametric bypass and zero-rollover badges) alongside the personal V5 banked quota in NCP and master battery telemetry.
* **Dynamic Refill Telemetry Visualization:** The client HUD renders live countdown timers derived from upstream `timeUntilNextPercent` metrics alongside cluster operational states (Green: Surplus Active, Yellow: Reserve Mode, Orange: Throttled, Red: Frozen).
* **Model Effort Toggle Integration:** The client UI supports NovelAI's Medium vs High effort toggle. Selecting Medium Effort updates local cost models to 14 steps with `step_factor = 1 / 1.06521739`, sets `model: "nai-diffusion-5-full-medium"`, displays the 10 NCP compute reservation, and hides/disables deadband warnings.
* **Explicit Firewall Bypass Toggle & Tariff Notification:** A dedicated control is integrated into the client UI allowing users to opt into Anlas-consuming generations deliberately for parametric overrides (dimensions $> 1024 \times 1024$, samples $> 1$, steps $> 28$ across all models), explicitly decoupled from V5 compute quotas.
* **Client-Side V5 Free-Tier Step Guidance:** When `nai-diffusion-5-full` (High) is selected and the Anlas bypass toggle is inactive, the step slider and numerical input are clamped to 23 steps. If the user attempts to set steps between 24 and 28 while dimensions are $\le 1\text{MP}$ and samples $= 1$, the UI blocks generation and displays: *"Steps 24-28 on V5 Full (High) are prohibited (battery deadband). Use ≤23 for free tier, switch to Medium effort, or enable Anlas bypass with >28 steps."* When Medium is selected, steps default to 14, auxiliary sliders are locked, and no deadband prompt is triggered.
* **Dual-Header Transmission & Drift Alert:** The client scrapes NovelAI's displayed UI cost and calculates local formula costs. If a mismatch is detected, the UI warns the user before dispatch. It attaches NovelAI's UI figure as `X-Scraped-Anlas` and its local estimate as `X-Declared-Anlas`.
* **Debt State UI Enforcement:** When an account carries an Anlas debt, the bypass toggle is locked out client-side with a warning indicating the required balance restoration.
* **Subscription-Period Telemetry Display:** The operator and guest settings panels expose both current subscription-period usage and lifetime statistics.

#### 2. How It Changes
* **UI Controls & Indicators:**
  * The standalone settings modal and generation HUD render a secondary progress indicator displaying the user's personal V5 banked usage (`available / max_cap` in NCP) and current master battery percentage.
  * A persistent toggle labeled "Enable Anlas Bypass (High-Res / Steps / Samples)" is added. When disarmed, the userscript limits sliders and settings to standard free Opus thresholds ($1024 \times 1024$, 1 sample; 23 steps for V5 High / 28 steps for legacy / unconstrained for V5 Medium). When armed, the UI displays the calculated Anlas cost required for the parametric expansion.
  * For `nai-diffusion-5-full` with bypass armed, steps $\in [24, 28]$ remain disabled when dimensions are $\le 1\text{MP}$ and samples $= 1$; the step selector permits $\le 23$ (free battery) or $\ge 29$ (Anlas-paid bypass). For Medium, steps remain locked to 14.
  * When the user's V5 banked allowance is exhausted or master capacity is $\le 5.5\%$, the UI indicates that V5 capacity is depleted or recharging. The Generate button disables with a capacity-exhausted prompt (`V5 Quota Depleted` or `Battery Recharging`). The Anlas Bypass toggle does not override this state unless the request burns Anlas for base dimensions ($> 1\text{MP}$), samples ($> 1$), or steps ($> 28$) (`X-Base-Paid: true`).
  * If the user's Anlas balance is negative, the toggle is forced to the disabled position, the input is disabled, and the HUD displays a red debt warning: `Anlas Balance: -X (Bypass Locked)`.
* **Network Dispatch Modification:**
  * The `handleGenerationIntercept` pipeline checks parametric settings against free Opus boundaries.
  * If boundaries are exceeded and the bypass toggle is active, the client serializes generation parameters, evaluates the estimated Anlas cost, scrapes NovelAI's displayed cost from the DOM, and attaches `X-Base-Paid: true`, `X-Scraped-Anlas: <number>`, and `X-Declared-Anlas: <number>` to the headers forwarded via `GM_xmlhttpRequest`.
  * `POST /queue/join` attaches `is_v5: true/false`, `model: <string>`, `steps: <number>`, and `is_base_paid: true/false` to allow model-aware pre-flight queue gating.
* **Telemetry Refresh Handling:**
  * Polling responses from `/auth/status` stream the updated accounting metadata: current virtual Anlas (positive or negative debt with zero-rollover tags), refill ETA, personal V5 banked balance (in NCP), cluster surplus availability, master battery percentage, replenishment countdown (`timeUntilNextPercent`), and subscription-period usage metrics.

#### 3. Why It Is Done This Way
* **Predictable Cost Transparency:** Users know in advance whether a generation is operating under standard free limits or burning ledger currency for high-resolution/step expansions.
* **Visual Parity with Upstream Rules:** The local client clearly signals whether a generation is operating under the free Opus tier or burning ledger currency for parametric expansions, aligning user expectations with server-side accounting while clarifying that V5 compute is governed by the hydraulic battery.
* **Client-Side Self-Restraint:** Explicitly locking the toggle when an account holds an Anlas debt prevents users from inadvertently transmitting bypass requests that would trigger rejection. Guiding users around the 24–28 step deadband on High effort eliminates accidental 400 errors while avoiding false warnings on Medium.

---

### Phase 4: Implementation & Verification Order

#### 1. Ingress, Processing & Settlement Pipeline Checklist

| Pipeline Stage | Operational Responsibility | Enforcement & Failure Safeguards |
| :--- | :--- | :--- |
| **Stage 1: Ingress** | Route, Auth & Whitelist Check | Calls `req.pause()`. Rejects unapproved/banned credentials immediately (`HTTP 401/403`). Asserts subdomain and path against whitelist. **Zero bytes buffered.** |
| **Stage 2: Staging Semaphore** | Ingress Buffer Concurrency Gate | Enforces `activeBufferingStreams <= 2`. Rejects excess concurrent uploads with `HTTP 429`. Binds 5-second chunk inactivity deadline and 60-second upload cap. Does NOT hold Channel A execution lock. |
| **Stage 3: Buffer Intake** | Stream Buffering | Accumulates chunks into `bodyChunks`. Enforces hard 50MB counter. If `accumulatedBytes > MAX_PAYLOAD_SIZE_BYTES`, terminates socket with `HTTP 413`. |
| **Stage 4: Extraction & Branching** | Route-Specific Binary Slicing | `/ai/encode-vibe` runs dedicated image-presence validator. Generation routes branch on `buffer[0,1] === 0x2D 0x2D` (multipart) vs leading non-whitespace `0x7B` within 4KB prefix (JSON). Multipart extracts `boundary` from `Content-Type`, locates `name="request"`, asserts header $\le 4\text{KB}$, and slices strictly to `\r\n--${boundary}`. Never decodes raw image buffers to UTF-16 strings. |
| **Stage 5: Anti-Spoofing** | Parameter Forgery Reconciliation | Asserts extracted body parameters match declared routing headers. Intentional evasion (e.g. header declares 1024px, body requests 2048px, or header declares Medium, body requests High) triggers immediate permanent database ban and queue eviction. |
| **Stage 6: Firewall** | V5 Model-Aware Deadband Gate | For `nai-diffusion-5-full` (High), asserts free requests do not set $24 \le \text{steps} \le 28$ (`HTTP 400 PARAMETRIC_LIMIT_EXCEEDED`). For `nai-diffusion-5-full-medium` (Medium), asserts only dimensions $\le 1\text{MP}$ and $n_{\text{samples}} = 1$; step counts are ignored and bypass the deadband. |
| **Stage 7: Pre-Flight Hold & Lock Claim** | Cost Calculation, Hold & Execution Gate | Computes $C_{\text{auth}} = \text{calculateAnlasCost}(\text{params})$ (Medium evaluated at 14 steps $\times 1 / 1.06521739$). Verifies $\text{Available Balance} \ge C_{\text{auth}}$. Sets hold on task or `activeTextLocks`. Claims Channel A exclusive execution lock (images) or Channel B slot (vibe). Sets `started_processing_at = Date.now()`. Zero SQLite debits. |
| **Stage 8: Upstream Pipe** | Recalculate & Forward | Strips hop-by-hop framing markers (`transfer-encoding`, conflicting `content-length`). Injects master token and authoritative `Content-Length`. Writes buffer to NovelAI over local datacenter fiber. |
| **Stage 9: Settlement** | Point of No Return (PoNR) Commit | On upstream `HTTP 200 OK`, immediately commits balance debit to SQLite, commits NCP deduction (18 NCP for High, 10 NCP for Medium), and clears hold. If upstream drops pre-headers, releases hold and charges **0 Anlas / 0 NCP**. Post-PoNR drops stand as sunk costs. |

#### 2. Sequence of Execution
1. **Database Schema Expansion:** Apply additive, non-destructive column updates to `users`, `devices`, and `config` tables via transactional migrations in `database.js` (`virtual_anlas_balance`, `last_anlas_reset_epoch`, `v5_banked_balance` [in NCP], `v5_last_accrual_epoch`, `v5_daily_consumed`, `subscription_period_anlas`, `subscription_period_v5`, `subscription_period_start_epoch`, `v5_surplus_pool` [in NCP], `v5_surplus_last_accrual`).
2. **Telemetry Harvester & Master Battery Normalization:**
   * Update `syncTelemetry()` in `server.js` to parse and expose `timeUntilNextPercent`, `isNegative`, and replenishment velocity.
   * Implement unit-safe normalization: if `timeUntilNextPercent > 10000`, divide by 1000; clamp to $[1800, 10000]$ seconds, and fallback to `NOMINAL_DAILY_V5_COMPUTE = 190.0` (High-equivalents).
   * Implement weighted local dispatch tracking: $N_{\text{weighted}} = N_{\text{high}} + (0.557 \times N_{\text{medium}})$, updating continuous capacity projection in RAM.
   * Implement adaptive polling intervals (10m $\to$ 2m $\to$ 60s floor) based on projected battery levels.
3. **Deterministic V5 Allocation Engine & Static Anlas Reset:**
   * Implement `evaluateV5Accrual()` in `auditEngine.js` using static integer tier NCP quotas and tier-based `v5MaxBankDays` limits. Implement cluster surplus replacement synchronously inside `sweep()` in NCP units.
   * Implement `evaluateAnlasReset()` in `auditEngine.js` enforcing 30-day epoch resets with strict zero rollover, offsetting existing negative debt.
4. **Queue Ingress Gating (`routes/queueRouter.js`):**
   * Update `POST /queue/join` to accept `model` string.
   * Implement model-aware V5 free-tier deadband check: reject $24 \le \text{steps} \le 28$ strictly when `model === 'nai-diffusion-5-full' && !is_base_paid`. Bypass deadband check when `model === 'nai-diffusion-5-full-medium'`.
   * Implement V5 pre-flight gating on `POST /queue/join`, asserting available NCP balance $\ge 18$ for High or $\ge 10$ for Medium against personal and surplus buckets, enforcing the $5.5\%$ circuit breaker.
   * Refactor `activeTextLocks` in `QueueCoordinator` to store `{ timestamp, user_id, held_cost }`. Implement dynamic `calculateAvailableBalance()` in `auditEngine.js` aggregating holds across Channel A tasks and Channel B locks.
5. **Proxy Ingress, Upstream Execution, & Audit (`routes/proxyRouter.js` & `auditEngine.js`):**
   * Route `/ai/encode-vibe` to a dedicated handler on Channel B (`acquireTextSlot(reqId, userId, 2)`), verify image payload presence without generation parameter parsing, assert available balance $\ge 2$, execute reservation hold, and commit debit upon upstream `HTTP 200 OK`.
   * Implement ingress staging semaphore (`activeBufferingStreams <= 2`), 5-second socket inactivity deadline, and 60-second upload cap on `/proxy/`. Decouple upload buffering from Channel A execution lock.
   * Implement dual-mode binary buffer slicing in `extractParametersFromRawBody` (RFC 7578 multipart using `\r\n--${boundary}` delimiters with bounded 4KB part-headers, and RFC 8259 JSON parsing with a 4KB whitespace-bounded prefix window).
   * Port `anlas-calculation.md` formula to pure JavaScript in `auditEngine.js` and `src/userscripts/shared/params.js`, authoritatively pricing `nai-diffusion-5-full-medium` using 14 steps with `step_factor = 1 / 1.06521739`.
   * Set up automated repository workflow (GitHub Actions / scheduled task) to monitor `anlas-calculation.md` for upstream formula changes.
   * Implement pre-upstream Point of No Return (PoNR) lifecycle: atomic in-memory reservation hold via `task.held_cost`, grant Channel A execution lock post-buffering, SQLite balance debit committed strictly at upstream `HTTP 200 OK`, and immediate hold release on pre-header failure.
   * Commit V5 NCP deductions upon upstream `HTTP 200 OK`: 18 NCP for High, 10 NCP for Medium.
   * Exempt Anlas-paid requests (`X-Base-Paid: true` via dimensions $> 1\text{MP}$, samples $> 1$, or steps $> 28$) from V5 NCP bank/battery deductions across all models.
   * Implement parameter tampering tripwire: permanent bans executed strictly when routing headers deliberately mismatch raw body parameters.
   * Implement canary logging: log warnings when authoritative cost diverges from `X-Scraped-Anlas`. Do not ban users for formula drift.
6. **Client UserScript Recompilation:** Update shared UI components, interceptors, and settings managers to handle High/Medium effort switching, bypass headers, V5 High 23-step clamping / deadband handling, V5 Medium 14-step handling, live refill timers, debt lockout states, zero-rollover tags, monthly usage reporting, V5 NCP bank meters, dual-header dispatch, and hard battery freeze states, followed by compilation into distribution artifacts.
7. **System Verification Testing:**
   * Assert continuous battery projection evaluates timestamps in seconds without integer overflow, properly normalizes `timeUntilNextPercent` whether transmitted in milliseconds or seconds, weights Medium dispatches at $0.557$, and falls back to `NOMINAL_DAILY_V5_COMPUTE` when missing or out of bounds.
   * Assert lazy accrual credits integer NCP allocations and enforces multi-day bank ceilings.
   * Assert free V5 requests within the deadband ($24 \le \text{steps} \le 28$ at $\le 1\text{MP}$, 1 sample) are rejected on `nai-diffusion-5-full`, but pass validation on `nai-diffusion-5-full-medium`.
   * Assert V5 Medium Anlas-paid generations are priced authoritatively using 14 steps with `step_factor = 1 / 1.06521739` ($1024 \times 1024, 2\text{ samples} \to 12\text{ Anlas}$; $1536 \times 2048, 1\text{ sample} \to 34\text{ Anlas}$).
   * Assert immediate `HTTP 429` rejection on `POST /queue/join` when a user lacks sufficient NCP for the requested model effort (18 NCP for High, 10 NCP for Medium).
   * Assert immediate `HTTP 503` rejection on `POST /queue/join` for all V5 requests when projected battery is $\le 5.5\%$, verifying baseline non-V5 image generation requests pass through untouched.
   * Assert that an Anlas-paid request (`X-Base-Paid: true` due to resolution $> 1\text{MP}$, samples $> 1$, or steps $> 28$) does not deduct from `users.v5_banked_balance` on V5 models.
   * Assert that when NovelAI terminates an upstream connection mid-flight prior to header streaming, the user's `v5_banked_balance` and reservation holds are released with zero balance deduction. Assert that if the connection terminates *after* `HTTP 200` is received, the debit stands as a sunk cost.
   * Assert that when a client upload stalls for $> 5$ seconds or takes $> 60$ seconds total, the staging socket is destroyed and the buffer cleared without starving Channel A.
   * Assert that Channel A execution locks are granted strictly post-buffering, ensuring that upload transit duration never truncates the 75-second GPU inference window.
   * Assert that multiple 24-hour evaluations while battery sits at $80\%$ overwrite `v5_surplus_pool` synchronously inside `sweep()` rather than accumulating unboundedly.
   * Assert that parameter tampering (e.g., `X-Gen-Width: 1024` but body contains $2048$, or header declares Medium but body requests High) triggers a post-hoc ban, appeal notification, and active session eviction.
   * Assert that dual-mode buffer slicing accurately extracts parameters from multipart bodies where binary image chunks precede `name="request"`, where prompts contain internal dashes (`\r\n---\r\n`), and parses JSON bodies with leading whitespace without allocating full-buffer UTF-16 strings.
   * Assert that a divergence between server authoritative cost and `X-Scraped-Anlas` logs an operational telemetry warning without banning the user.
   * Assert that `/ai/encode-vibe` requests bypass generation parameter parsing, enforce image presence validation, claim Channel B slots, track holds in `activeTextLocks`, and commit 2 Anlas debits on `HTTP 200`.
   * Assert that concurrent generation on Channel A and vibe extraction on Channel B calculates available balance dynamically against active in-memory holds across both channels, preventing cross-channel double-spending.
   * Assert that users in an Anlas debt state ($\text{balance} < 0$) are locked out of Anlas-consuming bypass generations while retaining access to free Opus generations.
   * Assert that an inactive user evaluated after 30 days receives exactly `tierConfig.monthlyAnlas` without multi-month accumulation, offsetting any existing debt.