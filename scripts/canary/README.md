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

## Production install (preferred: bot-token mode)

### 1. Pick the channel for alerts

In your production Discord server, decide where canary alerts should land
(e.g., #ops or a fresh #canary). Right-click the channel → **Copy Channel
ID** (Developer Mode must be on under User Settings → Advanced).

### 2. Drop the channel id into the canary env file

```bash
ssh root@174.138.70.29
echo "CANARY_CHANNEL_ID=<paste channel id>" > /etc/canary.env
chmod 600 /etc/canary.env
```

That's the only configuration needed — the canary auto-reads
`DISCORD_BOT_TOKEN` from `/opt/nous-bot/.env`, so the production bot
posts the alerts as itself. No webhook URL setup, no token duplication.

### 3. Install the systemd units

```bash
cp /opt/nous-bot/scripts/canary/canary.service /etc/systemd/system/
cp /opt/nous-bot/scripts/canary/canary.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now canary.timer
```

### 4. Verify

```bash
# Confirm the timer is armed
systemctl list-timers canary.timer

# Run once manually to test the alert delivery
systemctl start canary.service
journalctl -u canary.service -n 20 --no-pager

# To get a one-time green confirmation in Discord (handy after install):
echo "CANARY_VERBOSE=1" >> /etc/canary.env
systemctl start canary.service
# then remove the line so red-only is the steady state
sed -i '/CANARY_VERBOSE/d' /etc/canary.env
```

## Alternate install (webhook mode)

If you'd rather not have the production bot post canary alerts (e.g., you
want a separate identity for ops alerts), use a channel webhook URL:

1. Discord channel settings → Integrations → Webhooks → New Webhook → Copy URL
2. Replace `CANARY_CHANNEL_ID=…` with `CANARY_WEBHOOK_URL=…` in `/etc/canary.env`
3. Restart: `systemctl start canary.service`

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
