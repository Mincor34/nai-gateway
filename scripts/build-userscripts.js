const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'UserScripts');

// TODO: Consider Github Releases instead of committing build artifacts to the repository.

const adminBanner = `// ==UserScript==
// @name         NovelAI Split-Token Gateway Coordinator (Admin Panel)
// @namespace    http://tampermonkey.net/
// @version      4.3.0
// @description  Secure administration panel, telemetry dashboard, bilateral debug coordinator, and session token injector
// @author       Minco
// @match        https://novelai.net/*
// @match        https://*.novelai.net/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      duckdns.org
// @updateURL    https://raw.githubusercontent.com/Mincor34/nai-gateway/master/UserScripts/nai-admin.user.js
// @downloadURL  https://raw.githubusercontent.com/Mincor34/nai-gateway/master/UserScripts/nai-admin.user.js
// ==/UserScript==\n`;

const guestBanner = `// ==UserScript==
// @name         NovelAI Split-Token Gateway Coordinator (Guest)
// @namespace    http://tampermonkey.net/
// @version      4.3.0
// @description  FIFO queue coordination, rolling allowance telemetry visualization, and background stream proxy pipeline
// @author       Minco
// @match        https://novelai.net/*
// @match        https://*.novelai.net/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      duckdns.org
// @updateURL    https://raw.githubusercontent.com/Mincor34/nai-gateway/master/UserScripts/nai-guest.user.js
// @downloadURL  https://raw.githubusercontent.com/Mincor34/nai-gateway/master/UserScripts/nai-guest.user.js
// ==/UserScript==\n`;

const targets = [
  {
    name: 'nai-admin',
    entryPoint: path.join(__dirname, '..', 'src', 'userscripts', 'admin', 'index.js'),
    outfile: path.join(OUT_DIR, 'nai-admin.user.js'),
    banner: adminBanner
  },
  {
    name: 'nai-guest',
    entryPoint: path.join(__dirname, '..', 'src', 'userscripts', 'guest', 'index.js'),
    outfile: path.join(OUT_DIR, 'nai-guest.user.js'),
    banner: guestBanner
  }
];

async function build() {
  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }

  for (const target of targets) {
    await esbuild.build({
      entryPoints: [target.entryPoint],
      bundle: true,
      outfile: target.outfile,
      banner: { js: target.banner },
      target: 'es2020',
      format: 'iife'
    });
  }
}

// Only auto-run if executed directly via node scripts/build-userscripts.js
if (require.main === module) {
  build()
    .then(() => console.log("Userscripts compiled successfully to /UserScripts."))
    .catch((err) => {
      console.error("Build failed:", err);
      process.exit(1);
    });
}

module.exports = { build, targets };