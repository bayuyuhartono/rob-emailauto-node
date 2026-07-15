// create-emails.js
//
// Bulk-create email account di SATU akun cPanel, langsung lewat UAPI cPanel
// (gak lewat WHM sama sekali). Autentikasi pake USERNAME + PASSWORD akun cPanel
// (HTTP Basic Auth) — dipakai kalau provider hosting lo gak nyediain/nonaktifin
// fitur "Manage API Tokens".
//
// PENTING: kalau akun cPanel lo pakai 2FA (Two-Factor Authentication), password
// auth doang gak akan cukup — cPanel bakal minta kode OTP juga. Kalau ini kasus
// lo, matiin dulu 2FA buat akun ini, atau pake opsi API Token (lihat versi lain).
//
// Cara pakai:
//   1. cp .env.example .env   -> isi CPANEL_HOST, CPANEL_USER, CPANEL_PASSWORD
//   2. cp accounts.example.csv accounts.csv -> isi daftar email yang mau dibikin
//   3. npm install
//   4. node create-emails.js accounts.csv --dry-run   (cek dulu tanpa eksekusi)
//   5. node create-emails.js accounts.csv             (eksekusi beneran)
//
// Format CSV (accounts.csv):
//   Cukup daftar USERNAME aja, satu per baris. Boleh pakai baris header "email_user"
//   di paling atas (opsional — bakal di-skip otomatis).
//
//   Contoh isi accounts.csv:
//     email_user
//     office
//     admin
//     budi
//     siti
//
//   domain, password, quota di-set di blok EMAIL_CONFIG di bawah (bukan di CSV).

import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

// =====================================================================
//  EDIT DI SINI — dipakai buat SEMUA email yang dibuat dari accounts.csv
// =====================================================================
const EMAIL_CONFIG = {
  domain: "warganegara.my.id",     // domain email, mis. budi@<domain>
  password: "lpZc1r3P@sUw0rd!",    // password yang sama buat semua akun
  quota: "1",                    // kuota MB per akun (0 = unlimited)
  send_welcome_email: "0",         // "1" = kirim welcome email, "0" = jangan
};
// =====================================================================

// ---------- Konfigurasi dari .env ----------
const CPANEL_HOST = process.env.CPANEL_HOST;
const CPANEL_PORT = process.env.CPANEL_PORT || "2083";
const CPANEL_USER = process.env.CPANEL_USER;
const CPANEL_PASSWORD = process.env.CPANEL_PASSWORD;
const CPANEL_VERIFY_SSL = (process.env.CPANEL_VERIFY_SSL || "true").toLowerCase() !== "false";
const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS || 500);

// ---------- Argumen CLI ----------
// Bisa kasih lebih dari satu file CSV sekaligus, mis:
//   node index.js accounts.csv accounts_2.csv accounts_3.csv
const args = process.argv.slice(2);
const csvPaths = args.filter((a) => !a.startsWith("--"));
if (csvPaths.length === 0) csvPaths.push("accounts.csv");
const isDryRun = args.includes("--dry-run");

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

// ---------- Validasi awal ----------
if (!CPANEL_HOST) fail("CPANEL_HOST belum diisi di .env");
if (!CPANEL_USER) fail("CPANEL_USER belum diisi di .env");
if (!CPANEL_PASSWORD) fail("CPANEL_PASSWORD belum diisi di .env");
for (const p of csvPaths) {
  if (!fs.existsSync(p)) fail(`File CSV tidak ditemukan: ${p}`);
}

if (!CPANEL_VERIFY_SSL) {
  console.warn(
    "⚠️  CPANEL_VERIFY_SSL=false — verifikasi sertifikat SSL dimatikan untuk seluruh proses ini. " +
      "Cuma aman kalau lo yakin ini server sendiri dengan self-signed cert.\n"
  );
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

// ---------- Validasi EMAIL_CONFIG ----------
if (!EMAIL_CONFIG.domain) fail("EMAIL_CONFIG.domain belum diisi di index.js");
if (!EMAIL_CONFIG.password) fail("EMAIL_CONFIG.password belum diisi di index.js");

// ---------- Baca semua CSV: daftar username, satu per baris ----------
// Gabungin isi semua file yang dikasih, buang duplikat (biar gak dobel bikin
// akun yang sama), sambil inget username itu asalnya dari file mana.
const usernames = [];
const seenUsers = new Set();
let dupCount = 0;

for (const p of csvPaths) {
  const lines = fs
    .readFileSync(p, "utf-8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    // Buang header opsional kalau ada.
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

if (usernames.length === 0) fail("CSV kosong, gak ada username yang bisa diproses.");

// Bangun satu baris lengkap dari username + EMAIL_CONFIG.
function resolveRow(rawUser) {
  // Kalau isinya email lengkap (mis. "jajang@kss.com"), ambil bagian sebelum "@" aja.
  const email_user = rawUser.split("@")[0].trim();
  return {
    email_user,
    domain: EMAIL_CONFIG.domain,
    password: EMAIL_CONFIG.password,
    quota: EMAIL_CONFIG.quota || "250",
    send_welcome_email: EMAIL_CONFIG.send_welcome_email || "0",
  };
}

// ---------- Fungsi utama: panggil UAPI Email::add_pop langsung ----------
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

  // Auth pake password = HTTP Basic Auth standar (beda skema sama token,
  // yang pakai header custom "Authorization: cpanel user:token").
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
      message: `Response bukan JSON valid (HTTP ${res.status}). Cek CPANEL_HOST/PORT/USER/PASSWORD.`,
      raw: text.slice(0, 500),
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      message: `HTTP ${res.status} — kemungkinan username/password salah, atau akun ini pakai 2FA (password auth gak akan jalan kalau 2FA aktif).`,
      raw: JSON.stringify(data),
    };
  }

  // Response langsung UAPI (gak dibungkus proxy), formatnya standar: { status, errors, data, metadata }
  if (data.status === 1) {
    return { ok: true, message: "Email berhasil dibuat", raw: JSON.stringify(data) };
  }

  const errorMsg = Array.isArray(data.errors) ? data.errors.join("; ") : data.errors || "Gagal, gak ada pesan error dari cPanel.";
  return { ok: false, message: errorMsg, raw: JSON.stringify(data) };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Terjemahin error jaringan Node jadi pesan yang beneran ngasih tau masalahnya.
const NETWORK_HINTS = {
  ENOTFOUND: `hostname "${CPANEL_HOST}" gak ketemu di DNS. Kalau domainnya baru didaftarin, DNS-nya belum propagasi — pakai hostname server hosting lo (misal mutis.iixcp.rumahweb.net) di CPANEL_HOST.`,
  EAI_AGAIN: `DNS lookup "${CPANEL_HOST}" timeout/gagal sementara. Cek koneksi internet atau resolver DNS lo.`,
  ECONNREFUSED: `koneksi ke ${CPANEL_HOST}:${CPANEL_PORT} ditolak. Port cPanel salah, atau diblokir firewall.`,
  ETIMEDOUT: `koneksi ke ${CPANEL_HOST}:${CPANEL_PORT} timeout. Kemungkinan diblokir firewall.`,
  CERT_HAS_EXPIRED: "sertifikat SSL server expired. Set CPANEL_VERIFY_SSL=false kalau lo yakin servernya bener.",
  ERR_TLS_CERT_ALTNAME_INVALID: `sertifikat SSL server gak cocok sama "${CPANEL_HOST}" (biasanya kejadian kalau CPANEL_HOST diisi IP). Pakai hostname server yang sesuai cert, atau set CPANEL_VERIFY_SSL=false.`,
  DEPTH_ZERO_SELF_SIGNED_CERT: "server pakai self-signed cert. Set CPANEL_VERIFY_SSL=false kalau ini server lo sendiri.",
};

function describeNetworkError(err) {
  const cause = err.cause;
  if (!cause) return err.message;

  const code = cause.code;
  const hint = NETWORK_HINTS[code];
  const detail = cause.message || String(cause);

  return hint ? `${err.message}: ${hint}` : `${err.message}: ${detail}${code ? ` (${code})` : ""}`;
}

// ---------- Proses semua baris ----------
async function main() {
  console.log(`\ncPanel Email Automation (single account)`);
  console.log(`Server target : ${CPANEL_HOST}:${CPANEL_PORT}`);
  console.log(`Akun cPanel   : ${CPANEL_USER}`);
  console.log(`Domain email  : ${EMAIL_CONFIG.domain}`);
  console.log(`File CSV       : ${csvPaths.join(", ")}`);
  console.log(`Total username: ${usernames.length}${dupCount ? ` (buang ${dupCount} duplikat)` : ""}`);
  console.log(`Mode          : ${isDryRun ? "DRY RUN (tidak eksekusi)" : "EKSEKUSI BENERAN"}\n`);

  const results = [];
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < usernames.length; i++) {
    const source = usernames[i].source;
    const row = { ...resolveRow(usernames[i].raw), source };
    const label = `${row.email_user}@${row.domain}`;

    if (isDryRun) {
      console.log(`[${i + 1}/${usernames.length}] 🔍 DRY RUN  ${label}`);
      results.push({ ...row, status: "DRY_RUN", message: "Belum dieksekusi", raw_response: "" });
      continue;
    }

    try {
      const result = await createEmailAccount(row);
      if (result.ok) {
        console.log(`[${i + 1}/${usernames.length}] ✅ OK    ${label}`);
        successCount++;
      } else {
        console.log(`[${i + 1}/${usernames.length}] ❌ GAGAL ${label} — ${result.message}`);
        failCount++;
      }
      results.push({
        ...row,
        status: result.ok ? "SUCCESS" : "FAILED",
        message: result.message,
        raw_response: result.raw,
      });
    } catch (err) {
      // fetch() bungkus error jaringan jadi "fetch failed" doang; penyebab aslinya
      // (DNS, TLS, connection refused) cuma ada di err.cause.
      const detail = describeNetworkError(err);
      console.log(`[${i + 1}/${usernames.length}] ❌ ERROR ${label} — ${detail}`);
      failCount++;
      results.push({ ...row, status: "ERROR", message: detail, raw_response: "" });
    }

    if (i < usernames.length - 1) await sleep(REQUEST_DELAY_MS);
  }

  // ---------- Tulis log hasil ke CSV ----------
  if (!isDryRun) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const logPath = path.join(process.cwd(), `results-${timestamp}.csv`);
    const header = "source_file,domain,email_user,status,message,raw_response\n";
    const body = results
      .map((r) => [csvEscape(r.source), r.domain, r.email_user, r.status, csvEscape(r.message), csvEscape(r.raw_response)].join(","))
      .join("\n");
    fs.writeFileSync(logPath, header + body);
    console.log(`\n📄 Log hasil ditulis ke: ${logPath}`);
  }

  console.log(`\nSelesai. Sukses: ${successCount} | Gagal/Skip: ${failCount} | Total: ${usernames.length}\n`);

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