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

**This is the only environment variable you must set by hand.** Everything
else in `render.yaml` is already filled in; a few optional ones (Supabase,
OpenAI, owner phone numbers) are left blank because this phase of the
project doesn't use them yet.

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

## Current limitation: sessions don't survive a redeploy (yet)

This is important, so it's stated plainly rather than glossed over:

Render's disk for a web service (on Starter and Free both, without an
add-on persistent disk) is **ephemeral** — it resets every time the service
redeploys (a new commit, a manual redeploy, or certain restarts). Because
this phase of the project stores WhatsApp session credentials on that local
disk (see `docs/DECISIONS.md` ADR-006), **every account will need to be
re-paired (scan a new QR) after a redeploy.**

This is a known, deliberate limitation of this phase, not a bug. A future
phase (Phase 3) replaces local-file session storage with a durable,
Supabase-backed store, which will fix this permanently. Until then: avoid
unnecessary redeploys once an account is paired, and expect to re-scan
after the project's next update ships.

## Updating the deployed app later

Once your GitHub repository's `main` branch receives new commits (from a
future Claude Code session, or anyone else), Render redeploys automatically
by default. No action needed on your part beyond being aware that a
redeploy means re-pairing WhatsApp (see above) until Phase 3 lands.

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
