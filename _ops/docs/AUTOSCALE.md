# AUTOSCALE — scaling the self-hosted stack

Practical scaling playbook for the ZKward stack post-Vercel. Written as
a staged migration path: start at Stage 0 (where we are today), move up
only when the trigger metrics say so, never skip stages.

**TL;DR:** Bakchodi (laptop) handles ~10-50 concurrent users comfortably.
Each stage roughly 10× that. Never over-engineer — the goal is to be
one stage ahead of load, not five.

---

## Stage 0 — Where we are (Sept 2026)

**Architecture:**
- Single Bakchodi laptop hosting: Postgres, jobs.zkward.com, 11 cron
  workers, Next.js website (`zkward-web.service`), cloudflared tunnel
- Cloudflare edge (CDN, TLS, WAF)
- External APIs (Polymarket, Kalshi, Delphi, Binance, BlueFin, etc.)

**Capacity envelope:**

| Resource | Available | Peak use | Headroom |
|---|---|---|---|
| RAM | 16 GB (typical laptop) | ~4-6 GB (web + PG + crons) | Comfortable |
| CPU | 4-8 cores | 40-80% under aggregator load | Comfortable |
| Concurrent users | — | ~10-50 realistic | Tight above 100 |
| DB connections | 100 max | ~30-40 sustained | Fine |
| Uplink | 100 Mbps typical | Low (Cloudflare absorbs static) | Fine |

**Cost:** ~$0/mo (existing hardware + Cloudflare free tier).

**Failure modes:**
- Laptop reboot → 60-120s downtime (systemd auto-restarts everything)
- Laptop offline (travel, power) → full outage
- Bakchodi hardware failure → catastrophic; recover from git + DB backup

---

## Stage 1 — Vertical scale to a VPS

**Trigger to move up:**
- P95 response latency > 1.5s (measure with a synthetic probe every 60s)
- OR CPU sustained above 70% for 30+ min
- OR you're travelling and need the laptop back
- OR the laptop crashes more than 1×/month

**Move to:** Single Linux VPS with 4-8 GB RAM, 2-4 vCPU, SSD.

**Recommended providers (2026 pricing):**

| Provider | Instance | Cost/mo | Notes |
|---|---|---|---|
| Hetzner Cloud | CX22 (2 vCPU, 4 GB) | €5 (~$5.50) | Best price/perf; EU/Ashburn |
| Hetzner Cloud | CX32 (4 vCPU, 8 GB) | €10 (~$11) | Recommended sweet spot |
| DigitalOcean | Basic Droplet 2 vCPU / 4 GB | $24 | Global regions |
| Fly.io | shared-cpu-2x, 4 GB | $19 | Deploys anywhere Fly runs |
| Vultr | Cloud Compute 4 vCPU / 8 GB | $24 | Global |
| AWS Lightsail | 2 vCPU / 4 GB | $20 | If already in AWS ecosystem |

**Recommendation:** Hetzner CX32 (~$11/mo) — 4 vCPU + 8 GB, deployed in
region closest to your primary user base (Ashburn if US, Falkenstein if
EU).

### Migration playbook Stage 0 → 1

**Time budget:** 2-3 hours, mostly waiting for `bun run build`.

1. **Provision the VPS.** Ubuntu 24.04 LTS. Save the root password + SSH
   key. Note the IP address.

2. **Migrate DB first.**
   ```bash
   # On Bakchodi
   pg_dump -Fc bakchodi > /tmp/bakchodi-YYYYMMDD.dump

   # scp to new VPS
   scp /tmp/bakchodi-YYYYMMDD.dump root@<VPS-IP>:/tmp/

   # On new VPS
   apt update && apt install -y postgresql-17 postgresql-contrib
   sudo -u postgres createdb bakchodi
   sudo -u postgres createuser zkward
   sudo -u postgres psql -c "ALTER USER zkward WITH PASSWORD '<same-as-bakchodi>';"
   sudo -u postgres pg_restore -d bakchodi /tmp/bakchodi-YYYYMMDD.dump
   ```

3. **Set up PgBouncer on VPS** to match the `:6432` port the rest of the
   stack expects:
   ```bash
   apt install -y pgbouncer
   # Configure /etc/pgbouncer/pgbouncer.ini for zkward user + bakchodi db
   # Listen on 6432 (or bind to localhost only + expose via cloudflared)
   systemctl enable --now pgbouncer
   ```

4. **Run all installers on VPS.** In order:
   ```bash
   sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/ZkVanguard/ZKward/main/services/paper-trader-worker/install.sh)"
   # populate /opt/zkward-worker/.env with the SAME env you had on Bakchodi
   sudo bash /opt/zkward-worker/services/cron-workers/install.sh
   sudo bash /opt/zkward-worker/services/zkward-web/install.sh
   ```

5. **Cloudflare tunnel to VPS.** Either:
   - Install cloudflared on VPS + create a new tunnel + point ingress at
     `localhost:3000` (recommended — no exposed public IP)
   - OR update the existing Bakchodi tunnel's ingress to point at the
     VPS's public IP (simpler, exposes VPS)

6. **DNS unchanged.** If you used the tunnel approach, the CNAME still
   points at `<UUID>.cfargotunnel.com` — just the tunnel now routes to
   VPS. Zero DNS propagation delay.

7. **Cutover — the flip moment:**
   - On Bakchodi: `sudo systemctl stop zkward-web.service` +
     `sudo systemctl stop 'zkward-cron@*.timer' paper-trader-worker.timer`
   - Update the Cloudflare tunnel ingress to point at the VPS (or
     activate the new VPS tunnel)
   - `curl -sI https://zkward.com` should serve from VPS within 30s
   - After 24h of clean VPS operation, decommission Bakchodi services

**Rollback:** Reverse tunnel routing → Bakchodi services still installed
and can be re-started with a single command.

**Capacity envelope after Stage 1:**
- Concurrent users: 100-500 comfortable
- P95 latency: ~200-400ms (mostly external API + SSR bound)
- Availability: ~99.9% (VPS provider SLA)

---

## Stage 2 — Split the workloads

**Trigger:**
- P95 latency > 800ms sustained
- Web + crons competing for CPU during aggregator ticks
- Any single component OOMing weekly

**Move to:** 3-tier split across dedicated boxes:
- **Web tier:** 2× small VPS (2 vCPU / 4 GB each) behind a load balancer
- **Worker tier:** 1× medium VPS (4 vCPU / 8 GB) for all crons
- **DB tier:** Managed Postgres (or 1× larger VPS dedicated to PG)

**Why split:**
- Web restart doesn't kill in-flight cron ticks
- Crons can hammer CPU without slowing user requests
- Web can auto-restart on failure without draining the DB pool
- Each tier scales independently

**Cost estimate (Hetzner):**

| Tier | Spec | Count | Cost |
|---|---|---|---|
| Web | CX22 (2 vCPU / 4 GB) | 2 | €10 |
| Worker | CX32 (4 vCPU / 8 GB) | 1 | €10 |
| DB | Managed PG or CX41 dedicated | 1 | €20-40 |
| Load balancer | Hetzner LB11 | 1 | €5 |
| **Total** | | | **~€45-65/mo (~$50-75)** |

### Migration playbook Stage 1 → 2

**Time budget:** 4-6 hours.

1. **Provision DB tier first.** Managed Postgres (Hetzner, DigitalOcean,
   Aiven, Neon) OR self-managed on a dedicated VPS.

2. **Migrate DB again.** Same `pg_dump` / `pg_restore` flow. Update
   `DATABASE_URL` in `.env` on your existing single-node stack to point
   at new DB. Restart everything. Verify with a full tick + web request.

3. **Provision worker tier.** Fresh Ubuntu VPS. Run only:
   ```bash
   sudo bash paper-trader-worker/install.sh
   sudo bash cron-workers/install.sh
   ```
   Skip `zkward-web/install.sh` on this box.

4. **Cutover crons:** disable timers on Stage-1 box, enable on new
   worker box. Verify cron heartbeats stay fresh via
   `SELECT * FROM cron_state WHERE key LIKE 'cron:lastRun:%'`.

5. **Provision 2 web nodes.** Fresh Ubuntu VPS × 2. Run only:
   ```bash
   sudo bash zkward-web/install.sh
   ```
   (Skip cron installers.)

6. **Configure load balancer.** Hetzner LB11 with health check
   pointing at `/api/health/production`. Add both web nodes as targets.

7. **DNS/tunnel update.** Point `zkward.com` CNAME at the LB (or route
   tunnel to LB IP). Cloudflare will edge-cache on top.

8. **Verify + decommission** Stage-1 combined box.

**Session state consideration:** Currently all state lives in
`cron_state` (Postgres). Multi-node web is safe — no local state to sync.
If you ever add per-user local caching, use Redis (already in the stack).

### Cron leadership under multi-node

The existing `tryClaimCronRun(key, intervalMs, now)` in
`lib/db/cron-state.ts` is a DB CAS lock. It works correctly across
N worker boxes — first-to-claim wins, others no-op. So you can even
run 2 worker boxes in HA active-active without duplicate cron fires.

**Capacity envelope after Stage 2:**
- Concurrent users: 1,000-5,000
- P95 latency: 150-300ms
- Availability: ~99.95% (multi-node web)
- Worker outage: acceptable (crons resume when box restarts)
- Web outage: transparent to users (LB routes to healthy node)

---

## Stage 3 — Multi-region + read replicas

**Trigger:**
- Global user base with users >500ms from primary region
- Traffic > 5,000 concurrent OR > 100 rps sustained
- Need for regulatory data residency (EU user data must stay in EU)

**Move to:** Multi-region deployment with:
- 2-3 regions running full web tier
- Global load balancer with geo-routing (Cloudflare Load Balancing)
- Postgres primary + read replicas per region
- Cron workers stay single-region (they mutate shared state)

**Architecture:**

```
                    Cloudflare (edge + global LB)
                              │
              ┌───────────────┼───────────────┐
              │               │               │
        US-East region   EU region      Asia region
        ─────────────    ────────       ──────────
        2× web nodes     2× web         2× web
        1× read replica  1× replica     1× replica
              │               │               │
              └───────────────┼───────────────┘
                              │
                    Postgres primary (US-East)
                    ────────────────────────
                    1× dedicated PG (writes)
                    1× worker box (all crons)
```

**Cost estimate:**

| Tier | Spec × Regions | Cost/mo |
|---|---|---|
| Web | 2× CX22 × 3 regions = 6 nodes | €30 |
| Read replicas | 1× CX22 × 3 regions | €15 |
| Primary DB | Managed PG large | €80 |
| Worker box | CX32 | €10 |
| Cloudflare LB | Load Balancing add-on | $5 |
| **Total** | | **~$150-200/mo** |

### Reading vs writing split

Update `lib/db/postgres.ts` to accept two URLs:
- `DATABASE_URL` — the primary (writes always go here)
- `DATABASE_READ_URL` — nearest read replica

```typescript
// Simplified illustration — actual impl in lib/db/postgres.ts
const writePool = new Pool({ connectionString: process.env.DATABASE_URL });
const readPool = process.env.DATABASE_READ_URL
  ? new Pool({ connectionString: process.env.DATABASE_READ_URL })
  : writePool;

export const readQuery = (sql, params) => readPool.query(sql, params);
export const writeQuery = (sql, params) => writePool.query(sql, params);
```

Migrate call sites gradually — most dashboard queries are read-only.
Cron writes always go to primary.

### Read-replica lag caveat

Replication lag can be 100-500ms. If a user writes then immediately
reads, they might see stale data. Two mitigations:
1. Route the immediate-read query to primary (tag reads with a
   "consistency: strong" flag)
2. Wait for replica confirmation before returning (adds latency but
   guarantees consistency)

For ZKward's use case (dashboards, mostly-read), 500ms lag is fine.
For NAV attestation writes → immediate read, use write pool.

---

## Stage 4 — Kubernetes + full HPA

**Trigger:**
- Sustained > 500 rps
- Need for auto-scaling on traffic spikes (news events, viral moment)
- Team growing past solo — need proper deploy pipelines

**Move to:** Managed Kubernetes (EKS, GKE, DigitalOcean Kubernetes,
or self-managed with k3s on VPSes).

**What changes:**
- Web pods with Horizontal Pod Autoscaler (target CPU 70%)
- Postgres via Cloud SQL / RDS with read replicas + auto-failover
- Cron workers as CronJob resources (k8s native; drop systemd)
- Ingress via nginx-ingress-controller behind Cloudflare
- Observability: Prometheus + Grafana + Loki
- Deploys via GitHub Actions → kubectl apply

**Cost estimate:**

| Component | Cost/mo |
|---|---|
| Managed k8s control plane | $75 (EKS) or free (DO/GKE Autopilot) |
| Worker nodes (3× medium) | $150-300 |
| Managed Postgres HA | $200-400 |
| Load balancer + egress | $50-100 |
| Observability stack | $50-200 (or free self-hosted) |
| **Total** | **$500-1000+/mo** |

At this stage, `services/*/install.sh` is retired — replaced by k8s
manifests + Helm charts. Not a small refactor; do it when the pain of
NOT having auto-scaling is real, not preemptively.

### Alternative — Fly.io as k8s-lite

If k8s feels heavy, Fly.io Machines give you:
- Auto-scale to zero + wake on request (perfect for occasional traffic)
- Multi-region built in
- Postgres managed via Fly Postgres
- Simple `fly deploy` workflow

Cost: ~$50-200/mo for equivalent capacity. Trade-off: vendor lock-in.

---

## Cross-cutting: observability at every stage

You cannot scale what you cannot measure.

**Stage 0-1 (single box):**
- systemd journal (`journalctl -u zkward-web -f`)
- Postgres `pg_stat_activity` for connection count
- Ad-hoc `top` / `htop` during load
- One synthetic probe: `curl -w '%{time_total}' https://zkward.com/api/health/production` every 60s

**Stage 2 (split tiers):**
- Add Uptime Kuma or Better Stack (~$0-20/mo) for external probing
- Postgres slow query log — set `log_min_duration_statement = 1000`
- Structured logging already in place (`logger.info`)

**Stage 3-4:**
- Prometheus scraping web + worker + PG metrics
- Grafana dashboards for latency, error rate, CPU, memory
- Loki or Vector for centralized logs
- PagerDuty or Opsgenie for alerts

---

## Cost curve summary

| Stage | Users | P95 | Cost/mo | Effort to migrate |
|---|---|---|---|---|
| 0 (laptop) | ~10-50 | 200-500ms | $0 | — |
| 1 (single VPS) | 100-500 | 200-400ms | $11-25 | 2-3 h |
| 2 (split tiers) | 1k-5k | 150-300ms | $50-75 | 4-6 h |
| 3 (multi-region) | 5k-50k | 80-200ms | $150-300 | 1-2 days |
| 4 (k8s HPA) | 50k+ | 50-150ms | $500-1000+ | 1-2 weeks |

**Rule of thumb:** each stage costs ~3× more but supports ~10× users.
Don't skip stages — Stage 0 → 2 in one jump is a lot of untested change
at once.

---

## Anti-patterns — what NOT to do

1. **Don't add Kubernetes at Stage 1.** Overkill; you'll spend more time
   fighting k8s than shipping features.
2. **Don't preemptively add Redis** unless you have a specific
   caching win. Postgres handles session state fine at Stage 0-2.
3. **Don't split web + crons unless you have real evidence** they
   compete for CPU. On a single box they can coexist happily up to
   Stage 1's ceiling.
4. **Don't buy multi-region until you have users in multiple regions.**
   Latency arbitrage only matters if the users exist to benefit.
5. **Don't build custom load balancing.** Cloudflare LB, Hetzner LB,
   nginx are all solved problems.
6. **Don't skip the DB migration test.** Every stage move includes a
   DB cutover; run a full pg_dump/restore dry-run against a staging
   instance BEFORE the real cutover. 30 min saved is 5 hours of
   emergency recovery avoided.

---

## Auto-scale checklist per stage

Before promoting to the next stage, verify:

- [ ] Current stage's P95 latency has been > threshold for 1+ week
- [ ] You can articulate WHAT the next stage buys you (not just "more")
- [ ] You've priced the next stage and it fits budget
- [ ] You have a rollback plan (DNS revert, tunnel switch, etc.)
- [ ] Observability at current stage tells you if the migration worked
- [ ] `.env` on the new tier matches source-of-truth

---

## When to hire actual infra

At Stage 3 you're spending 8+ hours/week on ops. At Stage 4 it's a
full-time job. If ZKward hits real user growth:
- Bring in a part-time SRE contractor at Stage 3
- Hire a full-time infra person at Stage 4
- Consider going back to Vercel Enterprise at that point — the $1-2k/mo
  is cheaper than a full-time hire AND covers CDN + auto-scale +
  multi-region + monitoring

The migration off Vercel was the right call at the current stage.
Migrating back at Stage 4 might be too. That's not failure — it's
matching infra to product size.

---

## References

- `services/paper-trader-worker/README.md` — Stage 0 paper trader
- `services/cron-workers/README.md` — Stage 0 crons
- `services/zkward-web/README.md` — Stage 0 web
- `docs/DEPLOY_RUNBOOK.md` — SUI-specific deploy invariants
- `docs/SLO_AND_RUNBOOKS.md` — SLO definitions + incident runbooks
