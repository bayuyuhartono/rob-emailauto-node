// status.js
//
// List the domain batches currently running (started with run-domain.js / index.js).
// Shows PID, how long it's been running, the domain, and progress from its log.
//
// Usage:
//   node status.js
//   npm run status

import { execSync } from "node:child_process";
import fs from "node:fs";

// --- find running "node index.js ..." processes ---
let ps = "";
try {
  ps = execSync("ps -eo pid=,etime=,args=", { encoding: "utf8" });
} catch {
  ps = "";
}

const procs = ps
  .split("\n")
  .map((l) => l.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/))
  .filter(Boolean)
  .map((m) => ({ pid: m[1], elapsed: m[2], args: m[3] }))
  .filter((p) => /\bindex\.js\b/.test(p.args) && !/status\.js/.test(p.args));

if (procs.length === 0) {
  console.log("\nNo domain batches are currently running.\n");
  process.exit(0);
}

// --- resolve the domain for a process ---
function domainOf(p) {
  // 1) Linux: read EMAIL_DOMAIN straight from the process environment.
  try {
    const env = fs.readFileSync(`/proc/${p.pid}/environ`, "utf8");
    const hit = env.split("\0").find((kv) => kv.startsWith("EMAIL_DOMAIN="));
    if (hit) return hit.slice("EMAIL_DOMAIN=".length);
  } catch {
    /* not Linux or no access — fall through */
  }
  // 2) Fallback: read the domain from the first CSV file in the command.
  const file = (p.args.match(/accounts(?:_\d+)?\.csv/g) || [])[0];
  if (file && fs.existsSync(file)) {
    const line = fs.readFileSync(file, "utf8").split(/\r?\n/)[1] || "";
    if (line.includes("@")) return line.trim().split("@")[1];
  }
  return "?";
}

// --- progress from the newest matching log ---
function progressOf(domain) {
  let logs;
  try {
    logs = fs
      .readdirSync(".")
      .filter((f) => f.startsWith(`run-${domain}-`) && f.endsWith(".log"))
      .map((f) => ({ f, t: fs.statSync(f).mtimeMs }))
      .sort((a, b) => b.t - a.t);
  } catch {
    logs = [];
  }
  if (!logs.length) return { ok: "?", fail: "?", log: "-" };
  const txt = fs.readFileSync(logs[0].f, "utf8");
  const ok = (txt.match(/✅ OK/g) || []).length;
  const fail = (txt.match(/❌/g) || []).length;
  return { ok, fail, log: logs[0].f };
}

const rows = procs.map((p) => {
  const domain = domainOf(p);
  const { ok, fail, log } = progressOf(domain);
  return { pid: p.pid, elapsed: p.elapsed, domain, ok, fail, log };
});

// --- print a simple table ---
const cols = [
  ["PID", (r) => r.pid],
  ["ELAPSED", (r) => r.elapsed],
  ["DOMAIN", (r) => r.domain],
  ["OK", (r) => String(r.ok)],
  ["FAIL", (r) => String(r.fail)],
  ["LOG", (r) => r.log],
];
const widths = cols.map(([h, get]) => Math.max(h.length, ...rows.map((r) => get(r).length)));

console.log(`\n${procs.length} batch(es) running:\n`);
console.log(cols.map(([h], i) => h.padEnd(widths[i])).join("  "));
console.log(widths.map((w) => "-".repeat(w)).join("  "));
for (const r of rows) {
  console.log(cols.map(([, get], i) => get(r).padEnd(widths[i])).join("  "));
}
console.log("\nStop one with:  kill <PID>\n");