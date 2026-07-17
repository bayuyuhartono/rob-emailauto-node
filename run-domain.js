// run-domain.js
//
// Convenience wrapper: run all CSV files for ONE domain in a single call.
//
// It scans every accounts*.csv in this folder, picks the ones whose addresses
// use the given domain (the "@domain" inside the file), sets EMAIL_DOMAIN for
// you automatically, and runs index.js on exactly those files.
//
// Usage:
//   node run-domain.js <domain> [cpanelUser] [cpanelPassword] [startRow] [--dry-run] [--bg]
//
//   node run-domain.js finisher.my.id                       (creds from .env, foreground)
//   node run-domain.js finisher.my.id slk13 doiwd93         (override cPanel user+pass)
//   node run-domain.js finisher.my.id slk13 doiwd93 --bg    (override creds, background)
//   node run-domain.js finisher.my.id slk13 doiwd93 1100    (resume: start from row 1100)
//   node run-domain.js finisher.my.id --dry-run             (preview only)
//   npm run domain -- finisher.my.id slk13 doiwd93 1100 --bg
//
// The optional startRow is the numeric argument (default 0 = from the beginning).
// It skips the first N rows of the merged file list — handy to resume a run.
//
// No need to edit .env:
//   - EMAIL_DOMAIN is set from the <domain> you pass here.
//   - CPANEL_USER / CPANEL_PASSWORD are overridden if you pass them (else .env is used).

import fs from "node:fs";
import { spawnSync, spawn } from "node:child_process";

const args = process.argv.slice(2);
const positionals = args.filter((a) => !a.startsWith("--"));

// The domain is always first. Among the rest, a purely-numeric arg is the startRow;
// the remaining (non-numeric) args are cPanel user then password, in order.
const domain = positionals[0];
const rest = positionals.slice(1);
const startArg = rest.find((a) => /^\d+$/.test(a));
const startRow = startArg ? Number(startArg) : 0;
const [cpUser, cpPass] = rest.filter((a) => !/^\d+$/.test(a));
const isBg = args.includes("--bg");
const passthrough = args.filter((a) => a.startsWith("--") && a !== "--bg"); // e.g. --dry-run

if (!domain) {
  console.error(
    "\n❌ Usage: node run-domain.js <domain> [cpanelUser] [cpanelPassword] [startRow] [--dry-run] [--bg]\n" +
      "   e.g. node run-domain.js finisher.my.id slk13 doiwd93 1100 --bg\n"
  );
  process.exit(1);
}

// Natural sort so accounts_2 comes before accounts_10.
function naturalKey(name) {
  const m = name.match(/^accounts(?:_(\d+))?\.csv$/);
  return m ? Number(m[1] ?? 0) : Infinity;
}

const files = fs
  .readdirSync(".")
  .filter((f) => /^accounts(_\d+)?\.csv$/.test(f))
  .filter((f) => {
    const txt = fs.readFileSync(f, "utf-8");
    // Match the domain only after an "@" so "finisher.my.id" doesn't match a substring.
    return txt.includes(`@${domain}`);
  })
  .sort((a, b) => naturalKey(a) - naturalKey(b));

if (files.length === 0) {
  console.error(`\n❌ No accounts*.csv files found containing "@${domain}".\n`);
  process.exit(1);
}

// Pass the start offset through to index.js as a flag.
const startFlag = startRow > 0 ? [`--start=${startRow}`] : [];
const childArgs = ["index.js", ...files, ...startFlag, ...passthrough];

console.log(`\n▶ Domain : ${domain}`);
console.log(`▶ Files  : ${files.length} (${files.join(", ")})`);
console.log(`▶ Rows   : ~${files.length * 1000}`);
if (cpUser) console.log(`▶ cPanel : ${cpUser} (from CLI, overrides .env)`);
if (startRow > 0) console.log(`▶ Start  : row ${startRow} (skipping the first ${startRow})`);

// dotenv in index.js does NOT override an already-set env var, so these win.
const childEnv = { ...process.env, EMAIL_DOMAIN: domain };
if (cpUser) childEnv.CPANEL_USER = cpUser;
if (cpPass) childEnv.CPANEL_PASSWORD = cpPass;

if (isBg) {
  // Detached background run — survives logout, logs to a file. No nohup needed.
  const logPath = `run-${domain}-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
  const out = fs.openSync(logPath, "a");
  const child = spawn("node", childArgs, {
    detached: true,
    stdio: ["ignore", out, out],
    env: childEnv,
  });
  child.unref();
  console.log(`▶ Mode   : BACKGROUND (pid ${child.pid})`);
  console.log(`\n📄 Log  : ${logPath}`);
  console.log(`   watch : tail -f ${logPath}`);
  console.log(`   stop  : kill ${child.pid}\n`);
  process.exit(0);
}

console.log(`▶ Mode   : FOREGROUND\n`);
const res = spawnSync("node", childArgs, {
  stdio: "inherit",
  env: childEnv,
});

process.exit(res.status ?? 0);