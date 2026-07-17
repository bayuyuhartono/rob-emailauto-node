// create-emails.js
//
// Bulk-create email accounts on a SINGLE cPanel account, directly via the cPanel
// UAPI (no WHM involved at all). Authenticates with the cPanel USERNAME + PASSWORD
// (HTTP Basic Auth) — useful when your hosting provider doesn't offer / has disabled
// the "Manage API Tokens" feature.
//
// IMPORTANT: if your cPanel account uses 2FA (Two-Factor Authentication), password
// auth alone won't be enough — cPanel will also ask for an OTP code. If that's your
// case, disable 2FA for this account first, or use the API Token version instead.
//
// Usage:
//   1. cp .env.example .env   -> fill in CPANEL_HOST, CPANEL_USER, CPANEL_PASSWORD,
//                                 EMAIL_DOMAIN, EMAIL_PASSWORD
//   2. cp accounts.example.csv accounts.csv -> fill in the list of emails to create
//   3. npm install
//   4. node create-emails.js accounts.csv --dry-run   (preview without executing)
//   5. node create-emails.js accounts.csv             (execute for real)
//
// CSV format (accounts.csv):
//   Just a list of USERNAMEs, one per line. An "email_user" header line at the top
//   is optional (it's skipped automatically).
//
//   Example accounts.csv contents:
//     email_user
//     office
//     admin
//     budi
//     siti
//
//   domain & password come from .env (EMAIL_DOMAIN, EMAIL_PASSWORD); quota &
//   send_welcome_email are set in the EMAIL_CONFIG block below (not in the CSV).

import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

// ---------- Configuration from .env ----------
const CPANEL_HOST = process.env.CPANEL_HOST;
const CPANEL_PORT = process.env.CPANEL_PORT || "2083";
const CPANEL_USER = process.env.CPANEL_USER;
const CPANEL_PASSWORD = process.env.CPANEL_PASSWORD;
const CPANEL_VERIFY_SSL = (process.env.CPANEL_VERIFY_SSL || "true").toLowerCase() !== "false";
const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS || 500);

// =====================================================================
//  Email settings — applied to ALL emails created from accounts.csv.
//  domain & password come from .env; the rest can be tweaked here.
// =====================================================================
const EMAIL_CONFIG = {
  domain: process.env.EMAIL_DOMAIN,      // email domain, e.g. budi@<domain>  (set in .env)
  password: process.env.EMAIL_PASSWORD,  // the same password for every account (set in .env)
  quota: "1",                            // quota in MB per account (0 = unlimited)
  send_welcome_email: "0",               // "1" = send welcome email, "0" = don't
};
// =====================================================================

// ---------- CLI arguments ----------
// You can pass more than one CSV file at once, e.g:
//   node index.js accounts.csv accounts_2.csv accounts_3.csv
const args = process.argv.slice(2);
const csvPaths = args.filter((a) => !a.startsWith("--"));
if (csvPaths.length === 0) csvPaths.push("accounts.csv");
const isDryRun = args.includes("--dry-run");

// Optional resume offset: --start=N skips the first N rows of the merged list.
const startArg = args.find((a) => a.startsWith("--start="));
const startIndex = startArg ? Math.max(0, parseInt(startArg.split("=")[1], 10) || 0) : 0;

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

// ---------- Initial validation ----------
if (!CPANEL_HOST) fail("CPANEL_HOST is not set in .env");
if (!CPANEL_USER) fail("CPANEL_USER is not set in .env");
if (!CPANEL_PASSWORD) fail("CPANEL_PASSWORD is not set in .env");
for (const p of csvPaths) {
  if (!fs.existsSync(p)) fail(`CSV file not found: ${p}`);
}

if (!CPANEL_VERIFY_SSL) {
  console.warn(
    "⚠️  CPANEL_VERIFY_SSL=false — SSL certificate verification is disabled for this entire run. " +
      "Only safe if you're sure this is your own server with a self-signed cert.\n"
  );
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

// ---------- Validate EMAIL_CONFIG ----------
if (!EMAIL_CONFIG.domain) fail("EMAIL_DOMAIN is not set in .env");
if (!EMAIL_CONFIG.password) fail("EMAIL_PASSWORD is not set in .env");

// ---------- Read all CSVs: list of usernames, one per line ----------
// Merge the contents of every file given, drop duplicates (so we don't create the
// same account twice), while remembering which file each username came from.
const usernames = [];
const seenUsers = new Set();
let dupCount = 0;

for (const p of csvPaths) {
  const lines = fs
    .readFileSync(p, "utf-8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    // Drop the optional header line if present.
    .filter((line, i) => !(i === 0 && /^(email_user|username)$/i.test(line)));

  for (const line of lines) {
    const key = line.split("@")[0].trim().toLowerCase();
    if (seenUsers.has(key)) {
      dupCount++;
      continue;
    }
    seenUsers.add(key);
    usernames.push({ raw: line, source: p });
  }
}

if (usernames.length === 0) fail("CSV is empty, no usernames to process.");

// Build a full row from a username + EMAIL_CONFIG.
function resolveRow(rawUser) {
  // If it's a full email (e.g. "jajang@kss.com"), take only the part before "@".
  const email_user = rawUser.split("@")[0].trim();
  return {
    email_user,
    domain: EMAIL_CONFIG.domain,
    password: EMAIL_CONFIG.password,
    quota: EMAIL_CONFIG.quota || "250",
    send_welcome_email: EMAIL_CONFIG.send_welcome_email || "0",
  };
}

// ---------- Main function: call UAPI Email::add_pop directly ----------
async function createEmailAccount(row) {
  const { domain, email_user, password, quota, send_welcome_email } = row;

  const params = new URLSearchParams({
    email: email_user,
    domain: domain,
    password: password,
    quota: quota || "250",
    send_welcome_email: send_welcome_email || "0",
  });

  const url = `https://${CPANEL_HOST}:${CPANEL_PORT}/execute/Email/add_pop?${params.toString()}`;

  // Password auth = standard HTTP Basic Auth (different scheme from tokens, which
  // use a custom header "Authorization: cpanel user:token").
  const basicAuth = Buffer.from(`${CPANEL_USER}:${CPANEL_PASSWORD}`).toString("base64");

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Basic ${basicAuth}`,
    },
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return {
      ok: false,
      message: `Response is not valid JSON (HTTP ${res.status}). Check CPANEL_HOST/PORT/USER/PASSWORD.`,
      raw: text.slice(0, 500),
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      message: `HTTP ${res.status} — likely a wrong username/password, or this account uses 2FA (password auth won't work if 2FA is enabled).`,
      raw: JSON.stringify(data),
    };
  }

  // Direct UAPI response (not wrapped by a proxy), standard format: { status, errors, data, metadata }
  if (data.status === 1) {
    return { ok: true, message: "Email created successfully", raw: JSON.stringify(data) };
  }

  const errorMsg = Array.isArray(data.errors) ? data.errors.join("; ") : data.errors || "Failed, no error message from cPanel.";
  return { ok: false, message: errorMsg, raw: JSON.stringify(data) };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Translate Node network errors into messages that actually explain the problem.
const NETWORK_HINTS = {
  ENOTFOUND: `hostname "${CPANEL_HOST}" not found in DNS. If the domain was just registered, DNS hasn't propagated yet — use your hosting server's hostname (e.g. mutis.iixcp.rumahweb.net) for CPANEL_HOST.`,
  EAI_AGAIN: `DNS lookup for "${CPANEL_HOST}" timed out / failed temporarily. Check your internet connection or DNS resolver.`,
  ECONNREFUSED: `connection to ${CPANEL_HOST}:${CPANEL_PORT} was refused. Wrong cPanel port, or blocked by a firewall.`,
  ETIMEDOUT: `connection to ${CPANEL_HOST}:${CPANEL_PORT} timed out. Likely blocked by a firewall.`,
  CERT_HAS_EXPIRED: "the server's SSL certificate has expired. Set CPANEL_VERIFY_SSL=false if you're sure the server is correct.",
  ERR_TLS_CERT_ALTNAME_INVALID: `the server's SSL certificate doesn't match "${CPANEL_HOST}" (usually happens when CPANEL_HOST is an IP). Use the hostname that matches the cert, or set CPANEL_VERIFY_SSL=false.`,
  DEPTH_ZERO_SELF_SIGNED_CERT: "the server uses a self-signed cert. Set CPANEL_VERIFY_SSL=false if this is your own server.",
};

function describeNetworkError(err) {
  const cause = err.cause;
  if (!cause) return err.message;

  const code = cause.code;
  const hint = NETWORK_HINTS[code];
  const detail = cause.message || String(cause);

  return hint ? `${err.message}: ${hint}` : `${err.message}: ${detail}${code ? ` (${code})` : ""}`;
}

// ---------- Process all rows ----------
async function main() {
  console.log(`\ncPanel Email Automation (single account)`);
  console.log(`Server target : ${CPANEL_HOST}:${CPANEL_PORT}`);
  console.log(`cPanel account: ${CPANEL_USER}`);
  console.log(`Email domain  : ${EMAIL_CONFIG.domain}`);
  console.log(`CSV file(s)   : ${csvPaths.join(", ")}`);
  console.log(`Total username: ${usernames.length}${dupCount ? ` (dropped ${dupCount} duplicates)` : ""}`);
  if (startIndex > 0) console.log(`Start from    : row ${startIndex + 1} (skipping the first ${startIndex})`);
  console.log(`Mode          : ${isDryRun ? "DRY RUN (no execution)" : "LIVE EXECUTION"}\n`);

  const results = [];
  let successCount = 0;
  let failCount = 0;

  for (let i = startIndex; i < usernames.length; i++) {
    const source = usernames[i].source;
    const row = { ...resolveRow(usernames[i].raw), source };
    const label = `${row.email_user}@${row.domain}`;

    if (isDryRun) {
      console.log(`[${i + 1}/${usernames.length}] 🔍 DRY RUN  ${label}`);
      results.push({ ...row, status: "DRY_RUN", message: "Not executed yet", raw_response: "" });
      continue;
    }

    try {
      const result = await createEmailAccount(row);
      if (result.ok) {
        console.log(`[${i + 1}/${usernames.length}] ✅ OK    ${label}`);
        successCount++;
      } else {
        console.log(`[${i + 1}/${usernames.length}] ❌ FAIL  ${label} — ${result.message}`);
        failCount++;
      }
      results.push({
        ...row,
        status: result.ok ? "SUCCESS" : "FAILED",
        message: result.message,
        raw_response: result.raw,
      });
    } catch (err) {
      // fetch() wraps network errors as a bare "fetch failed"; the real cause
      // (DNS, TLS, connection refused) lives only in err.cause.
      const detail = describeNetworkError(err);
      console.log(`[${i + 1}/${usernames.length}] ❌ ERROR ${label} — ${detail}`);
      failCount++;
      results.push({ ...row, status: "ERROR", message: detail, raw_response: "" });
    }

    if (i < usernames.length - 1) await sleep(REQUEST_DELAY_MS);
  }

  // ---------- Write result log to CSV ----------
  if (!isDryRun) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const logPath = path.join(process.cwd(), `results-${timestamp}.csv`);
    const header = "source_file,domain,email_user,status,message,raw_response\n";
    const body = results
      .map((r) => [csvEscape(r.source), r.domain, r.email_user, r.status, csvEscape(r.message), csvEscape(r.raw_response)].join(","))
      .join("\n");
    fs.writeFileSync(logPath, header + body);
    console.log(`\n📄 Result log written to: ${logPath}`);
  }

  console.log(`\nDone. Success: ${successCount} | Failed/Skipped: ${failCount} | Total: ${usernames.length}\n`);

  if (!isDryRun && failCount > 0) process.exitCode = 1;
}

function csvEscape(value) {
  const str = String(value ?? "");
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

main();
