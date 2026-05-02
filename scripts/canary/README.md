# Production Canary

Every-15-min HTTP health probe that verifies your deployed system actually works for buyers — distinct from CI which only verifies code correctness. Catches the failure modes CI can't see:

- Env var typo on the server after a deploy
- Webhook secret rotated in Stripe but not updated in `.env`
- nginx proxy config drift after a reboot
- DO droplet ran out of disk
- SSL cert expired
- ShippingEasy API key revoked
- DNS issue at the registrar
- A caching bug that only manifests with real traffic

## What it checks

6 endpoints across both production hosts:
- `https://itzenzo.tv/`
- `https://itzenzo.tv/cards`
- `https://itzenzo.tv/how-it-works/refund-policy`
- `https://itzenzo.tv/api/queue/snapshot`
- `https://vincentragosta.io/wp-json/shop/v1/queue`
- `https://vincentragosta.io/`

Each check has a soft latency budget (SLO). Breaches don't fail the canary but flag the embed yellow.

## Local smoke

```bash
node scripts/canary/run-canary.js
# prints per-check status + total fail/slow counts; exits 1 on any failure
```

## Production install

### 1. Create a Discord webhook

In your Discord server (production guild — where you want alerts to land):

1. Go to a channel where you want canary alerts (recommend creating a fresh `#canary` channel)
2. Channel settings (gear icon) → **Integrations** → **Webhooks** → **New Webhook**
3. Name it `Canary` → **Copy Webhook URL**

### 2. Drop the webhook URL into a secrets file on the DO droplet

```bash
ssh root@174.138.70.29
echo "CANARY_WEBHOOK_URL=https://discord.com/api/webhooks/..." > /etc/canary.env
chmod 600 /etc/canary.env
```

### 3. Install the systemd units

```bash
# From the Nous deploy on the box
sudo cp /opt/nous-bot/scripts/canary/canary.service /etc/systemd/system/canary.service
sudo cp /opt/nous-bot/scripts/canary/canary.timer /etc/systemd/system/canary.timer
sudo systemctl daemon-reload
sudo systemctl enable --now canary.timer
```

### 4. Verify

```bash
# Confirm the timer is armed
systemctl list-timers canary.timer

# Run once manually to test the webhook delivery
sudo systemctl start canary.service
journalctl -u canary.service -n 20 --no-pager

# After a deliberate green run, set CANARY_VERBOSE=1 in /etc/canary.env to
# get a one-time green confirmation embed in Discord, then unset it.
```

## What red looks like

The Discord embed turns red, lists every failed check with HTTP status + body tail, and includes any slow checks as a footer note. Example:

```
❌ 2/6 checks failed

✗ vincentragosta.io /wp-json/shop/v1/queue — HTTP 502 (1234ms)
  `Bad Gateway`
✗ itzenzo.tv /api/queue/snapshot — HTTP 503 (892ms)
  `{"error":"Too many requests..."}`
```

## What yellow looks like

All checks pass but at least one breached its SLO. Example:

```
🟡 all green, 1 slow

✓ itzenzo.tv homepage — 1834ms
✓ ...
🟡 itzenzo.tv /api/queue/snapshot — 4521ms (budget 2000ms)
```

Yellow is informational — useful to spot degradation trends before they become outages.

## Tuning

- **Frequency**: edit `OnCalendar=*:0/15` in `canary.timer`. Hourly = `OnCalendar=hourly`. Every 5 min = `*:0/5`.
- **SLOs**: each check has a `slo:` field in `run-canary.js`. Edit and redeploy.
- **Adding checks**: append to the `CHECKS` array. Each `expect` predicate gets `{ status, body }` and returns true on success.
- **Verbose green confirmations**: set `CANARY_VERBOSE=1` to get green embeds too. Useful right after install to confirm the Discord webhook works.
