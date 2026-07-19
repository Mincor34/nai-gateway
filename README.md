# NovelAI Split-Token Gateway Coordinator (nai-gateway)

A single-concurrency transaction queue and split-token reverse proxy designed to coordinate a shared, paid NovelAI Opus-tier session across a verified user group without exposing the master account credentials.

## 1. System Architecture

```
                       [ HTTPS (443) ]
  [ Guest Browser ]  ==================>  [ Reverse Proxy (Caddy/Nginx) ]
                                                   ||
                                             (Local Port 3000)
                                                   ||
                                                   \/
                                          [ Express Gateway ]
                                           ├── SQLite Store (Devices/State)
                                           ├── In-Memory Queues
                                           └── Request Buffer Accumulator
                                                   ||
                                            (Token Swapping)
                                                   ||
                                                   \/
                                          [ NovelAI Upstream ]
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
   Navigate to your project directory on your remote VPS and run:
   ```bash
   npm install
   ```

2. **Configure Environment Variables**
   The application reads runtime secrets from process environment variables. Define these globally or pass them during startup:
   ```bash
   export PORT=3000
   export ADMIN_SECRET_KEY="your_extremely_secure_vps_admin_passkey_change_me"
   ```

3. **Initialize Persistent Daemon Execution**
   Do not run this server directly in your interactive shell session. Use `pm2` to monitor and keep the process alive:
   ```bash
   # Install pm2 globally if not already available
   npm install -g pm2

   # Start the daemon
   ADMIN_SECRET_KEY="your_secure_passkey" PORT=3000 pm2 start server.js --name "nai-gateway"

   # Configure pm2 to restart on VPS reboot
   pm2 startup
   pm2 save
   ```

---

## 3. Reverse Proxy Configuration (TLS/SSL Enforced)

**Never expose the Express application directly to the public internet on port 3000.** You must run a front-facing reverse proxy to enforce HTTPS and protect client authorization headers from eavesdropping.

### Option A: Caddy (Highly Recommended)
Caddy automatically provisions, configures, and renews Let's Encrypt SSL certificates out-of-the-box with minimal overhead.

1. Edit your system Caddy configuration file (`/etc/caddy/Caddyfile`):
   ```caddy
   your-domain.duckdns.org {
       reverse_proxy localhost:3000 {
           header_up Host {upstream_hostport}
           header_up X-Real-IP {remote_host}
       }
   }
   ```
2. Restart Caddy: `systemctl restart caddy`

### Option B: Nginx
If using Nginx, you must manually coordinate Certbot to obtain and renew certificates.

1. Configure an Nginx server block:
   ```nginx
   server {
       listen 80;
       server_name your-domain.duckdns.org;
       return 301 https://$host$request_uri;
   }

   server {
       listen 443 ssl;
       server_name your-domain.duckdns.org;

       ssl_certificate /etc/letsencrypt/live/your-domain.duckdns.org/fullchain.pem;
       ssl_certificate_key /etc/letsencrypt/live/your-domain.duckdns.org/privkey.pem;

       location / {
           proxy_pass http://localhost:3000;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection 'upgrade';
           proxy_set_header Host $host;
           proxy_cache_bypass $http_upgrade;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       }
   }
   ```
2. Restart Nginx: `systemctl restart nginx`

---

## 4. Client UserScript Installation

Guests and administrators must install their respective browser scripts using Tampermonkey.

### Setup Instructions

1. **Install Tampermonkey** in the target browser.
2. **Install Scripts:**
   * **Guest Script:** Install `UserScripts/nai-guest.user.js` on guest browsers.
   * **Admin Script:** Install `UserScripts/nai-admin.user.js` on your own administrator browser.
3. **Change VPS URL Target:**
   Open the installed scripts inside the Tampermonkey editor and modify the `VPS_HOST` variable to point to your domain:
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
Centralized telemetry is printed to standard output in real-time. Use the PM2 CLI utility to trace incoming traffic and exceptions:
```bash
pm2 logs nai-gateway
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