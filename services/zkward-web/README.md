# zkward-web — self-hosted Next.js on Bakchodi

Final piece of the Vercel migration. Runs the full Next.js production
server (homepage, dashboard, /paper, chat AI, all APIs) on Bakchodi
under systemd. Exposed to the internet via the existing Cloudflare
tunnel.

## Architecture

```
                Cloudflare edge (CDN + TLS + WAF)
                            │
                            ▼
              cloudflared tunnel (existing)
                            │
                            ▼
                localhost:3000 on Bakchodi
                            │
                            ▼
      systemd: zkward-web.service → bun run next start
                            │
                            ▼
              /opt/zkward-worker/.next/*
                            │
                            ▼
                Bakchodi Postgres (localhost:6432)
```

## Setup — full migration off Vercel

### Prereqs

- paper-trader-worker + cron-workers already installed
- `/opt/zkward-worker` clone up to date with origin/main
- `/opt/zkward-worker/.env` has ALL production env vars (copy from
  Vercel prod — every var the site + APIs touch, not just the crons)
- Bakchodi has ≥ 4 GB free RAM (Next.js SSR is memory-hungry)
- `cloudflared` running with an existing tunnel to `pg.zkward.com` /
  `jobs.zkward.com` / `ssh.zkward.com`

### Step 1 — install + first build

```bash
# On Bakchodi
sudo bash /opt/zkward-worker/services/zkward-web/install.sh
```

The installer:
1. Runs `bun run build` (5-10 min) if `.next/` doesn't exist
2. Installs the systemd unit
3. Enables + starts the service
4. Curls `http://localhost:3000/` to verify

After it finishes, the site is live on Bakchodi's `localhost:3000`
but not yet reachable from the internet.

### Step 2 — Cloudflare tunnel ingress

Add the two ingress rules from `cloudflared-ingress-snippet.yml` to
your existing cloudflared config (usually `/etc/cloudflared/config.yml`).
Put them BEFORE the catch-all `service: http_status:404` rule.

```bash
sudo systemctl restart cloudflared
```

Verify the tunnel is routing:
```bash
# From your laptop
curl -sI https://<TUNNEL-UUID>.cfargotunnel.com -H "Host: zkward.com" | head -5
# Should show HTTP/2 200
```

### Step 3 — DNS cutover (this is the "flip the switch" moment)

In Cloudflare dashboard for `zkward.com` zone:

1. **Delete** the current A/CNAME for `zkward.com` pointing at
   `cname.vercel-dns.com` (or Vercel IPs `76.76.21.21`)
2. **Add** a CNAME record:
   - Name: `zkward.com`
   - Target: `<YOUR-TUNNEL-UUID>.cfargotunnel.com`
   - Proxy status: Proxied (orange cloud)
3. Repeat for `www.zkward.com`

Get your tunnel UUID:
```bash
cloudflared tunnel list
```

Propagation: 1-5 min. Test from your laptop:
```bash
dig +short zkward.com   # should NOT show 76.76.21.x
curl -sI https://zkward.com | head -5
# HTTP/2 200 → serving from Bakchodi via Cloudflare
```

## Deploy new code

After the initial install, every subsequent deploy uses `deploy.sh`:

```bash
sudo bash /opt/zkward-worker/services/zkward-web/deploy.sh
```

Does:
1. `git fetch` + `reset --hard origin/main`
2. `bun install` (only if `package.json` or `bun.lock` changed)
3. `bun run build` (always — Next.js output changes with every commit)
4. `systemctl restart zkward-web.service` (drops in-flight requests via SIGTERM, comes back in ~5 s)

Typical deploy time: 6-12 min (build dominates).

## Verify site is healthy

```bash
# On Bakchodi
systemctl status zkward-web.service
# active (running)

curl -sS http://localhost:3000/api/health/production | head -c 500
# should return JSON with status field
```

From laptop:
```bash
curl -sI https://zkward.com | head -5   # HTTP/2 200
curl -sS https://zkward.com/api/predictions/per-asset?assets=BTC | head -c 300
# JSON with BTC prediction
```

## Rollback

If a deploy breaks the site:

```bash
# Fast rollback to previous commit
cd /opt/zkward-worker
sudo -u zkward git log --oneline -5   # find the last good commit
sudo -u zkward git reset --hard <good-commit-sha>
sudo -u zkward bun run build
sudo systemctl restart zkward-web.service
```

To fall back to Vercel entirely (if Bakchodi has an outage):

1. In Cloudflare DNS, change the CNAME back to
   `cname.vercel-dns.com` for `zkward.com` + `www.zkward.com`
2. Wait 1-5 min for DNS propagation
3. Vercel serves everything again (assuming Vercel is unblocked at that point)

## Resource requirements

| Component | Peak use | Notes |
|---|---|---|
| RAM at rest | ~600 MB | Next.js SSR baseline |
| RAM under load | 1.5-2.5 GB | Chat AI streaming + big aggregator responses can push higher |
| CPU idle | <5% | Static pages served fast |
| CPU under load | 40-80% | Chat AI + SSR of dynamic dashboards spikes |
| Build peak RAM | 3-4 GB | `bun run build` — hence NODE_OPTIONS=--max-old-space-size=4096 in service |
| Disk | ~2 GB | .next/ is ~800 MB + node_modules ~1 GB |
| Bandwidth | Depends on traffic | Cloudflare absorbs edge cache |

Bakchodi (laptop-class hardware) can handle low-to-moderate traffic
comfortably. If you get >100 req/s sustained, consider scaling to a
dedicated VPS.

## Troubleshooting

| Symptom | Check | Fix |
|---|---|---|
| `systemctl status zkward-web` shows "activating" then "failed" | `journalctl -u zkward-web -n 60` | Usually missing env var or `.next/` corrupt — re-run `deploy.sh` |
| `curl localhost:3000` refused | Service active but not listening | Check journal for "Ready in Nms" line; if missing, port 3000 conflict — `sudo lsof -i:3000` |
| `curl https://zkward.com` returns Cloudflare 502 | Tunnel can't reach origin | `cloudflared tunnel info <UUID>` — connector should be "healthy" |
| Site loads but API routes 500 | Route can't reach DB / external API | `.env` missing var — see cron-workers README env table |
| Chat AI streams then hangs | Cloudflare 100s idle timeout | Streaming works up to 100s; longer responses truncate. Increase `originRequest.connectTimeout` won't fix (that's for connection, not idle) — the fix is server-side streaming with keepalive frames |
| Build OOMs | Bakchodi RAM under 4 GB free | Raise `--max-old-space-size` to 6144 in unit, or add swap |
| Deploy takes 15+ min | First build always slow | Subsequent builds cache-hit; 6-10 min is normal |
| `next start` crashes on missing font/asset | Static file 404 during build | Check `git status` — untracked files that Vercel had? |

## Multi-worker coordination note

zkward-web + all 11 cron workers all share the same Bakchodi Postgres
pool. Watch total connection count during peak:

```sql
SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'zkv-%';
```

Ceiling: 30-40 comfortable, 60+ risky. The web server holds ~10-20
persistent connections; each cron tick adds 3-5 for its duration.
If you hit the ceiling, cut `max` in `lib/db/postgres.ts` or move to
a dedicated PG instance.

## Full off-Vercel checklist

After you complete all steps above, you have:

- [x] Paper trader → Bakchodi systemd (verified)
- [x] All 11 scheduled crons → Bakchodi systemd timers
- [x] Website → Bakchodi Next.js via Cloudflare tunnel
- [x] DNS → Cloudflare orange-cloud pointing at tunnel

At that point Vercel has zero role in the production stack. You can:
- Delete the Vercel project (or leave it as an emergency fallback)
- Cancel any Vercel Pro subscription you might upgrade to
- Save the ~$20/mo forever

## What we lose vs Vercel

Being honest:

1. **CDN**: Vercel's edge CDN serves static assets from ~30 POPs.
   Cloudflare's CDN (in front of the tunnel) covers this — probably
   equivalent perf.
2. **Multi-region SSR**: Vercel runs SSR in your users' nearest
   region. Bakchodi is one location. SSR latency for users far from
   Bakchodi's region will be worse (~100-300ms added).
3. **Auto-scaling**: Vercel spins up more Lambda instances under
   load. Bakchodi is one server; a traffic spike could OOM.
4. **Deploy previews**: Vercel gave PR previews. Now you'd need a
   staging environment (separate systemd unit + subdomain).
5. **Zero-config observability**: Vercel dashboards for traffic,
   errors, function duration. Now you'd need Grafana / Prometheus /
   whatever.
6. **DDoS protection**: Cloudflare provides basic DDoS at the CDN
   layer. But origin is exposed if the tunnel URL leaks — add
   Cloudflare Access rules to lock down direct tunnel access.

For a solo-operator project with modest traffic, these trade-offs
are fine. For growth into real user volume, revisit.
