# PostgreSQL Setup for Local Development

## Option 1: Docker (Recommended)

```powershell
# Pull PostgreSQL image
docker pull postgres:16-alpine

# Run PostgreSQL container
docker run -d `
  --name zkward-postgres `
  -e POSTGRES_PASSWORD=postgres `
  -e POSTGRES_USER=postgres `
  -e POSTGRES_DB=zkward `
  -p 5432:5432 `
  postgres:16-alpine

# Verify it's running
docker ps
```

## Option 2: Install PostgreSQL Locally

Download from: https://www.postgresql.org/download/windows/

## Setup Database Schema

```powershell
# Connect to PostgreSQL
psql -U postgres -d zkward

# Run schema (paste content from scripts/database/hedges-schema.sql)
\i scripts/database/hedges-schema.sql

# Verify tables created
\dt

# Exit
\q
```

## Option 3: Use Neon (Free Cloud PostgreSQL)

1. Go to https://neon.tech
2. Create account (free tier: 512MB, 3GB transfer/month)
3. Create project "zkward"
4. Create database "zkward"
5. Copy connection string

## Environment Variables

Add to `.env.local`:

```bash
# Local PostgreSQL
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/zkward

# OR Neon Cloud
DATABASE_URL=postgresql://user:password@ep-xxx.us-east-2.aws.neon.tech/zkward?sslmode=require
```

## Initialize Schema

```powershell
# From project root
cd scripts/database

# Run hedge schema
bun run init-hedges-db.ts
```

## Verify Setup

```powershell
# Test connection
bun run test-db-connection.ts
```

## Query Examples

```sql
-- View all hedges
SELECT * FROM hedges ORDER BY created_at DESC LIMIT 10;

-- View active hedges
SELECT * FROM active_hedges_summary;

-- View daily stats
SELECT * FROM daily_hedge_stats;

-- Get total PnL
SELECT 
  SUM(current_pnl) as total_current_pnl,
  SUM(realized_pnl) as total_realized_pnl
FROM hedges;
```

## Migration to Real On-Chain Data

When you switch to real Moonlander trading:

1. Update `simulation_mode = false` in hedge execution
2. Add `tx_hash` when transactions are confirmed
3. Update PnL periodically from on-chain positions
4. All data structure stays the same ✅
