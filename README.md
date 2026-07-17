# cPanel Email Automation

Bulk-create email accounts on a **single cPanel account** directly through the cPanel
UAPI (`Email/add_pop`), authenticating with the cPanel username + password over HTTP
Basic Auth. No WHM required.

---

## 1. Setup (once)

```bash
npm install
cp .env.example .env   # if you don't already have a .env
```

Edit `.env`:

```ini
# cPanel connection
CPANEL_HOST=mutis.iixcp.rumahweb.net   # hosting server hostname (NOT your domain)
CPANEL_PORT=2083
CPANEL_USER=ward6939                    # cPanel login username
CPANEL_PASSWORD=your-cpanel-password
CPANEL_VERIFY_SSL=true
REQUEST_DELAY_MS=500                    # delay between requests (ms)

# Email accounts to create
EMAIL_DOMAIN=warganegara.my.id          # domain for the created emails
EMAIL_PASSWORD=lpZc1r3P@sUw0rd!         # same password for every created account
```

> **Note:** `CPANEL_HOST` must be the hosting **server** hostname, not your email
> domain. A brand-new domain may not resolve in DNS yet, but the server hostname
> always does (and its SSL cert matches, so `CPANEL_VERIFY_SSL=true` keeps working).

Quota and welcome-email settings live in the `EMAIL_CONFIG` block at the top of
`index.js` (`quota`, `send_welcome_email`).

---

## 2. CSV format

Each `accounts*.csv` is just a list of usernames, one per line, with an optional
`email_user` header. Full email addresses are fine too — everything after `@` is
stripped and the domain from `EMAIL_DOMAIN` is used instead.

```
email_user
budiginting.54@warganegara.my.id
sitihalim.12@warganegara.my.id
```

---

## 3. Running

### A. The easy way — run a whole domain at once (recommended)

`run-domain.js` finds every `accounts*.csv` whose addresses use the given domain,
sets `EMAIL_DOMAIN` for you, and runs them together. **No need to edit `.env`.**

**Argument order:** `<domain> [cpanelUser] [cpanelPassword] [startRow] [--dry-run] [--bg]`

- `domain` — required; also selects which files run (all whose addresses use it).
- `cpanelUser`, `cpanelPassword` — optional; override `CPANEL_USER` / `CPANEL_PASSWORD`
  for this run (otherwise taken from `.env`).
- `startRow` — optional **numeric** value; skip the first N rows (default `0` = from the
  start). Use it to **resume** a run that stopped partway.
- `--dry-run` — preview only, creates nothing.
- `--bg` — run detached in the background (survives logout, no `nohup`).

```bash
# preview first (creates nothing)
npm run domain -- slick.my.id --dry-run

# run for real, foreground
npm run domain -- slick.my.id

# override cPanel account (2nd = user, 3rd = password)
npm run domain -- slick.my.id slk13 doiwd93

# run in the background
npm run domain -- slick.my.id slk13 doiwd93 --bg

# resume from row 1100 (skips the first 1100 of the merged list)
npm run domain -- slick.my.id slk13 doiwd93 1100 --bg
```

The `startRow` is detected as the all-digits argument, so its position is flexible.
The merged row order is stable across runs (files in numeric order, de-duplicated), so
row 1100 means the same account each time — **as long as you don't regenerate the CSVs**
between runs.

You can also call the script directly instead of via npm:

```bash
node run-domain.js slick.my.id slk13 doiwd93 1100 --bg
```

### B. Manual — pick specific files

```bash
node index.js accounts_15.csv accounts_16.csv --dry-run
node index.js accounts_15.csv accounts_16.csv
```

Multiple files are merged and de-duplicated. The domain always comes from
`EMAIL_DOMAIN` in `.env`, so make sure it matches the files you pass.

---

## 4. Background runs & monitoring

`--bg` writes to a timestamped log and prints the PID:

```
📄 Log  : run-slick.my.id-2026-07-16T....log
   watch : tail -f run-slick.my.id-....log
   stop  : kill <pid>
```

```bash
tail -f run-slick.my.id-*.log        # live progress
grep -c '✅ OK' run-slick.my.id-*.log # successes so far
pgrep -af index.js                    # find the running process
kill <pid>                            # stop it
```

If you background a plain `node index.js …` run instead, use `nohup`:

```bash
nohup node index.js accounts_15.csv > run.log 2>&1 &
disown
```

---

## 5. Output

Every real run writes `results-<timestamp>.csv` with one row per account:

```
source_file,domain,email_user,status,message,raw_response
```

`status` is `SUCCESS`, `FAILED`, or `ERROR`. Exit code is non-zero if any row failed.

---

## Notes & cautions

- **One domain per run.** `EMAIL_DOMAIN` is a single value, so run each domain as its
  own batch. `run-domain.js` handles this for you by matching files to the domain.
- **Resuming.** If a run is killed midway, re-run with the `startRow` argument (e.g.
  `... 1100`) to continue from where it stopped instead of re-hitting already-created
  accounts. Without it, a re-run starts from the top and existing accounts come back as
  `FAILED` (already exists). Only valid if the CSVs are unchanged since the failed run.
- **Quota vs. disk.** Each account uses its quota (MB) from the account's disk
  allowance. Thousands of accounts × a large quota can exceed a shared plan — lower
  `quota` in `index.js` (or set `0`) if unsure.
- **2FA.** Password auth won't work if the cPanel account has 2FA enabled — disable it
  or use an API token.
- **Passwords on the CLI.** Passing the cPanel password as an argument makes it visible
  in shell history and `ps`. On a shared machine, keep it in `.env` instead.
- **Always `--dry-run` first** to confirm the file list and domain before a real run.