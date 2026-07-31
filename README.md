# NovelAI Split-Token Gateway Coordinator (nai-gateway)

A single-concurrency transaction queue and split-token reverse proxy designed to coordinate a shared, paid NovelAI Opus-tier session across a verified user group without exposing the master account credentials.

## 1. System Architecture

```
                                [ HTTPS (443) ]
  [ Guest Browser ]  ===================================>  [ Reverse Proxy (Caddy/Nginx) ]
                                                                     ||
                                                       (Process-Level Route Selection)
                                                        //                         \\
                                             (Local Port 3000)             (Local Port 3001)
                                                    ||                             ||
                                                    \/                             \/
                                        [ Express Gateway (PROD) ]    [ Express Gateway (STAGING) ]
                                        ├── SQLite Store (data.db)    ├── SQLite Store (staging_data.db)
                                        ├── In-Memory Queues          ├── In-Memory Queues
                                        └── Request Accumulator       └── Request Accumulator
                                                    ||                             ||
                                             (Token Swapping)               (Token Swapping)
                                                    ||                             ||
                                                    \/                             \/
                                           [ NovelAI Upstream ]           [ NovelAI Upstream ]
```

### Key Security Safeguards
* **Split-Token Execution Isolation:** Guests authenticate locally using their own free accounts. Cryptographic keystores, settings, and profile payloads bypass the VPS and connect natively to NovelAI.
* **Request Buffer Accumulation (WAF Shield):** Incoming generation settings are fully buffered in memory on the VPS before being forwarded. This dynamically recalculates and hardcodes the `Content-Length` header, stripping any conflicting client-side headers to prevent HTTP Request Smuggling blocks from upstream security layers (Cloudflare WAF).
* **Parametric Payload Firewall:** The proxy restricts incoming generation parameters strictly to $1024 \times 1024$ (1MP) total resolution, a maximum of 28 steps, and single-image generation to prevent unauthorized consumption of premium resources.
* **SSRF Target Validation:** Subdomains are strictly whitelisted (`api`, `image`, `text`). Wildcard paths are constrained strictly to verified endpoints.
* **Channel B Concurrency Limits:** Non-blocking text generation requests are fast-tracked through a separate shared lock channel restricted to `3` concurrent slots.

---

## 2. Server Installation (VPS Host)

### Prerequisites
* **Node.js** (v18.x or v20.x recommended)
* **SQLite3 Build Tools** (compiled natively during `npm install`)
* **Process Manager (PM2)**: For daemon execution and automated crash recovery.
* **Reverse Proxy (Caddy or Nginx)**: For automated TLS certificate acquisition and TLS termination.

### Deployment Steps

1. **Clone and Install Dependencies**
   To set up isolated development pipelines, maintain separate production and staging clones pointing to your remote repository:
   ```bash
   # Production Directory Setup
   git clone -b master [YOUR_REMOTE_URL] ~/nai-gateway
   cd ~/nai-gateway
   npm install

   # Staging Directory Setup
   git clone -b staging [YOUR_REMOTE_URL] ~/nai-gateway-staging
   cd ~/nai-gateway-staging
   npm install
   ```

2. **Configure Runtime Environment Manifests**
   Environment variables are managed dynamically via local PM2 configuration files. This separates runtime states without requiring manual exports or external environment dependency management.

   * **Production Configuration (`~/nai-gateway/ecosystem.config.js`):**
     ```javascript
     module.exports = {
       apps: [{
         name: "nai-gateway-prod",
         script: "./server.js",
         watch: false,
         max_memory_restart: "200M",
         env: {
           NODE_ENV: "production",
           PORT: 3000,
           DATABASE_PATH: "data.db",
           ADMIN_SECRET_KEY: "your_vps_production_admin_passkey"
         }
       }]
     };
     ```

   * **Staging Configuration (`~/nai-gateway-staging/ecosystem.config.js`):**
     ```javascript
     module.exports = {
       apps: [{
         name: "nai-gateway-staging",
         script: "./server.js",
         watch: false,
         max_memory_restart: "200M",
         env: {
           NODE_ENV: "staging",
           PORT: 3001,
           DATABASE_PATH: "staging_data.db",
           ADMIN_SECRET_KEY: "your_vps_staging_admin_passkey"
         }
       }]
     };
     ```

3. **Initialize Persistent Daemon Execution**
   Deploy the instances using their respective manifest files. PM2 will read the parameters and maintain runtime memory separation:
   ```bash
   # Start production gateway
   cd ~/nai-gateway
   pm2 start ecosystem.config.js

   # Start staging gateway
   cd ~/nai-gateway-staging
   pm2 start ecosystem.config.js

   # Configure PM2 to restart on VPS reboot
   pm2 startup
   pm2 save
   ```

---

## 3. Reverse Proxy Configuration (TLS/SSL Enforced)

**Never expose the Express application directly to the public internet on ports 3000 or 3001.** You must run a front-facing reverse proxy to enforce HTTPS and protect client authorization headers from eavesdropping.

### Option A: Caddy (Highly Recommended)
Caddy automatically provisions, configures, and renews Let's Encrypt SSL certificates out-of-the-box with minimal overhead.

Edit your system Caddy configuration file (`/etc/caddy/Caddyfile`):
```caddy
# Production Reverse Proxy Gateway
your-domain.duckdns.org {
    @allowed_api {
        path /proxy/* /auth/* /queue/* /admin/*
    }

    handle @allowed_api {
        reverse_proxy localhost:3000 {
            header_up Host {upstream_hostport}
            header_up X-Real-IP {remote_host}
        }
    }

    handle {
        respond "Not Found" 404
    }
}

# Staging Reverse Proxy Gateway
your-staging-domain.duckdns.org {
    @allowed_api {
        path /proxy/* /auth/* /queue/* /admin/*
    }

    handle @allowed_api {
        reverse_proxy localhost:3001 {
            header_up Host {upstream_hostport}
            header_up X-Real-IP {remote_host}
        }
    }

    handle {
        respond "Not Found" 404
    }
}
```
Restart Caddy: `systemctl restart caddy`


---

## 4. Client UserScript Installation

Guests and administrators must install their respective browser scripts using Tampermonkey.

### Setup Instructions

1. **Install Tampermonkey** in the target browser.
2. **Install Scripts:**
   * **Guest Script:** Install `UserScripts/nai-guest.user.js` on guest browsers.
   * **Admin Script:** Install `UserScripts/nai-admin.user.js` on your own administrator browser.
3. **Change VPS URL Target:**
   Open the installed scripts inside the Tampermonkey editor and modify the `VPS_HOST` variable to point to your respective production or staging domain:
   ```javascript
   const VPS_HOST = 'https://your-domain.duckdns.org';
   ```

---

## 5. Split-Token Authentication & Spoofing Flow

Guests log in natively with their own personal, free NovelAI accounts. All profile loading, story database reads, settings updates, and cryptographic E2EE decryption occur natively on their own local accounts. The UserScript interceptor tricks the local Single Page Application (SPA) into unlocking premium generation interfaces, while the VPS proxy transparently swaps their personal tokens for the master paid token exclusively on outgoing generation requests.

### The Administrator Flow
1. **Admin Key Entry:** Press `Ctrl + Shift + A` on the NovelAI interface to set and save your administrator API secret.
2. **Admin UI Access:** Click the red "VPS CONTROL PANEL" floating action button.
3. **Approve/Revoke with Priority Assignment:**
   * *Approve:* Click "Approve" next to a pending device and assign a **Priority Tier** (`Low`, `Normal`, `High`, `Admin`).
   * *Revoke:* Revoking deletes the validation record in SQLite. The guest's next proxied request will fail with an HTTP 401, wiping their approved status and blocking the UI.
4. **Manual Token Push:** Input the paid master account's Bearer token and click "PUSH TO VPS STORAGE". This updates the master Bearer session key on the SQLite database securely.

---

## 6. Maintenance & Troubleshooting

### Viewing Server Diagnostics
Centralized telemetry is printed to standard output in real-time. Use the PM2 CLI utility to trace incoming traffic and exceptions, specifying the process target:

* **Production Telemetry Logs:**
  ```bash
  pm2 logs nai-gateway-prod
  ```
* **Staging Telemetry Logs:**
  ```bash
  pm2 logs nai-gateway-staging
  ```

Every request, database query, and proxy event is logged to standard output using the `[VPS Telemetry]` prefix.

### Troubleshooting Upstream Exceptions

If PM2 outputs a log like:
`[VPS Telemetry] Upstream connection socket exception occurred: Error: socket hang up` with code `ECONNRESET`

1. **Verify Outbound Connectivity:** Ensure your VPS outbound port `443` is not restricted by cloud security lists.
2. **Verify Session Token Integrity:** Cloudflare (which protects NovelAI) will forcefully drop connection sockets with a TCP reset (`ECONNRESET`) if your master token is expired, invalid, or malformed. Extract a fresh Bearer token from a paid Opus-tier account and push it to VPS storage via the control panel.
3. **Trace Sandbox Violations:** If the client receives a status code error, the userscript normalizer intercepts raw exceptions and outputs the raw text received from the server directly to the console (`[Nai-Guest] Telemetry: Received raw error text:`), allowing you to pinpoint the exact reason for the failure.

### Recovering Hung Slots
The server executes an automated TTL sweep every 5 seconds. In the event of a client freeze, the active generation lock will self-terminate after exactly 75 seconds, processing the next queued request automatically.