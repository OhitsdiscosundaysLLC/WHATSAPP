# Deploying to Render

This guide assumes no prior experience with Git, GitHub, or Render. Follow
it top to bottom.

## What you're deploying

A small web app with two parts, running as one service:

- A **dashboard** you open in your browser to connect WhatsApp accounts.
- The **WhatsApp connection** itself (via Baileys), which the dashboard
  controls.

It needs to run continuously (not just "on a visit"), so it's deployed as a
**Render Web Service**, not a static site.

## Before you start

- A [Render](https://render.com) account (free to create).
- This project's code already on GitHub, in the `OhitsdiscosundaysLLC/WHATSAPP`
  repository, on the `main` branch. (If you're reading this, that part is
  done — see "Which branch" below.)
- A password you'll use to log into your own dashboard. Pick one now; you'll
  enter it in a step below. Anyone who knows this password can connect/
  disconnect your WhatsApp accounts, so keep it private, like any password.

## Step 1 — Connect Render to your GitHub repository

1. Go to [dashboard.render.com](https://dashboard.render.com) and sign in
   (or create an account — you can sign up with your GitHub account directly).
2. Click **New +** (top right) → **Blueprint**.
3. If this is your first time, Render will ask to connect to GitHub. Approve
   it, and give it access to the `OhitsdiscosundaysLLC/WHATSAPP` repository
   (either "all repositories" or select this one specifically).
4. Select the `OhitsdiscosundaysLLC/WHATSAPP` repository from the list.

## Step 2 — Which branch

Render will ask which branch to deploy. Choose **`main`**.

(Behind the scenes: this project's code was developed on a separate branch
and merged into `main` once it was complete and tested — see "Branch
situation" in the project's own notes if you're curious. You never need to
think about branches day to day; `main` is always the current, working
version of the app.)

## Step 3 — Review the Blueprint

This repository includes a file called `render.yaml` that tells Render
exactly how to build and run the app — Render will detect it automatically
and show you a preview:

- **Build command**: `npm install && npm run build`
- **Start command**: `npm start`
- **Health check path**: `/health`
- **Plan**: Starter (a small always-on tier — see "Choosing a plan" below)

You don't need to change any of this. Click **Apply** (or **Create New
Resources**, depending on Render's current wording) to continue.

## Step 4 — Set your dashboard password

Render will create the service and start its first build. While that's
running (or right after):

1. Open the new service in Render's dashboard.
2. Go to the **Environment** tab.
3. Find `DASHBOARD_ADMIN_PASSWORD` (it will show as needing a value).
4. Enter the password you chose earlier and save.
5. Render will redeploy automatically with the password set.

**This is one of two things you should set by hand before pairing any
WhatsApp account for real use.** The other is Supabase, covered next —
everything else in `render.yaml` is already filled in, and the remaining
optional ones (OpenAI, owner phone numbers) are left blank because this
phase of the project doesn't use them yet.

## Step 4b — Set up durable session storage (Supabase)

Skip this step only if you're just kicking the tires — without it, the app
still works, but every WhatsApp account will need a fresh QR scan after
every redeploy (see "Session storage: with vs. without Supabase" below).
For anything you intend to keep connected, do this step.

1. Create a free account at [supabase.com](https://supabase.com) if you
   don't have one, and create a new project (any name/region/password —
   that project password is separate from your dashboard password and you
   won't need it again).
2. In your new Supabase project, open the **SQL Editor** (left sidebar) and
   run the contents of this repository's
   `supabase/migrations/20261001120000_whatsapp_core.sql` file (open it on
   GitHub, copy all of it, paste into the SQL Editor, click **Run**). This
   creates the three tables the app needs and locks them down (Row Level
   Security, no public access) — it does not touch anything else in your
   project.
3. In Supabase, go to **Project Settings → API**. You need two values from
   this page:
   - **Project URL** (looks like `https://xxxxxxxx.supabase.co`)
   - **service_role** key, under "Project API keys" (click to reveal it —
     treat this like a master password; see the warning below)
4. Generate the third value yourself — a random encryption key — by running
   this in any terminal with Node.js installed:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
   This prints 64 characters of hex. Copy the whole thing.
5. Back in Render, on your service's **Environment** tab, set:
   - `SUPABASE_URL` → the Project URL from step 3
   - `SUPABASE_SERVICE_ROLE_KEY` → the service_role key from step 3
   - `WHATSAPP_AUTH_ENCRYPTION_KEY` → the 64-character value from step 4
6. Save. Render redeploys automatically.

**Two things worth taking seriously here:**

- The **service_role key** bypasses every database access restriction. Never
  put it in a browser, a public repo, or share it outside Render's
  Environment tab. This app only ever uses it on the server, never sends it
  to your browser, and never logs it.
- The **encryption key** is what protects your WhatsApp credentials at rest
  in the database — and it's also the _only_ thing that can decrypt them.
  **If you lose it, every connected WhatsApp account becomes permanently
  unreadable and must be re-paired from scratch** (the encrypted rows in
  Supabase can't be recovered without it — there is no backdoor). Store a
  copy of it somewhere safe outside Render (a password manager is ideal)
  before you consider this step done. Don't change it once accounts are
  paired, for the same reason.

## Step 5 — Open your dashboard

Once the deploy finishes (Render shows "Live"), your app has a public URL
that looks like:

```
https://whatsapp-automation-bot-XXXX.onrender.com
```

(Render shows the exact URL at the top of your service's page.) Open it in
your browser.

## Step 6 — Log in

You'll see a sign-in page. Enter the password you set in Step 4.

## Step 7 — Add a WhatsApp account

1. On the dashboard, click **+ Add WhatsApp Account**.
2. Give it a name (e.g. "My Phone" or "Support Line") and confirm.
3. A window opens showing a **QR code**.

## Step 8 — Link WhatsApp

On the phone whose WhatsApp you want to connect:

1. Open **WhatsApp**.
2. Go to **Settings → Linked Devices → Link a Device**.
3. Scan the QR code shown on your dashboard.

**Don't have a camera handy, or prefer a code instead?** Click the **"Phone
number"** tab in the same window, enter your number (digits only, country
code first, no `+` — e.g. `15551234567` for a US number), and click **Get
pairing code**. WhatsApp's linking screen has a **"Link with phone number
instead"** option that accepts this code.

## Step 9 — Confirm it's connected

Within a few seconds of scanning/entering the code, the dashboard updates
on its own (no refresh needed) and the account's status changes to
**Connected**. That's it — your bot is now linked to that WhatsApp account.

---

## Choosing a plan

`render.yaml` specifies Render's **Starter** plan. This matters because
Render's **free** web-service tier spins the app down after about 15
minutes without an incoming web request, and spins it back up on the next
one — which would silently drop the WhatsApp connection repeatedly. Starter
(a low-cost paid tier) stays running continuously, which this app needs to
actually hold its WhatsApp connection open.

If you just want to try the dashboard itself without keeping WhatsApp
connected long-term, you can change the plan to **Free** in Render's
dashboard (Settings → Plan) — just know that the WhatsApp connection won't
reliably stay up between visits on that tier.

## Session storage: with vs. without Supabase

Render's disk for a web service (on Starter and Free both, without an
add-on persistent disk) is **ephemeral** — it resets every time the service
redeploys (a new commit, a manual redeploy, or certain restarts).

- **With Supabase configured** (Step 4b above): WhatsApp session credentials
  are stored durably, encrypted, in your Supabase project instead of on
  Render's local disk. A redeploy or restart does **not** require
  re-pairing — the app reconnects on its own using the stored, encrypted
  session. This is the recommended setup for any account you actually want
  to keep connected. (See `docs/DATABASE.md` and `docs/SECURITY.md` for how
  this works.)
- **Without Supabase configured**: the app falls back to storing session
  credentials on Render's local disk, which does **not** survive a
  redeploy — every account will need to be re-paired (scan a new QR or
  re-enter a pairing code) after each redeploy. The dashboard's status
  panel and the `/health` endpoint both show which mode is active
  (`"mode": "supabase"` vs `"mode": "file"`, and `"durable": true/false`),
  so you can always tell which one you're running without guessing.

If Supabase is configured but something about it is wrong (a typo'd key, an
unreachable project, a missing/invalid encryption key), the app does **not**
silently fall back to the non-durable file mode — it fails loudly instead
(visible in Render's Logs tab and in `/health`), so you're never left
thinking your sessions are durable when they actually aren't.

## Updating the deployed app later

Once your GitHub repository's `main` branch receives new commits (from a
future Claude Code session, or anyone else), Render redeploys automatically
by default. With Supabase configured (recommended — see above), a redeploy
no longer requires re-pairing WhatsApp.

## Troubleshooting

- **"Dashboard is not configured yet"** when you try to log in: the
  `DASHBOARD_ADMIN_PASSWORD` environment variable isn't set. Go to Step 4.
- **The page says "Too many attempts"**: you (or someone) entered the wrong
  password several times in a row. Wait 15 minutes and try again.
- **QR code never appears / account stuck on "Connecting"**: check Render's
  **Logs** tab for the service. If you see repeated warnings about no
  connection activity, Render's network may be temporarily affecting the
  WhatsApp connection — the app will keep retrying automatically; no action
  needed unless it persists for several minutes.
- **`/health` returns an error page, or the service won't start**: check
  the **Logs** tab for a startup error — this usually means an environment
  variable is malformed. The app logs a clear validation error naming which
  one.
