const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'UserScripts');

// TODO: Add warning to not edit the built files directly.
// TODO: Versioning and metadata don't belong in the build script.

// UserScript metadata banners for Tampermonkey
// Adhere to SemVer versioning for the @version field
const adminBanner = `// ==UserScript==
// @name         GuildWeave Gateway (Admin)
// @namespace    http://tampermonkey.net/
// @version      5.0.0
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
// @name         GuildWeave Gateway
// @namespace    http://tampermonkey.net/
// @version      5.0.0
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
      format: 'iife',
      loader: {
        '.svg': 'text'
      }
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