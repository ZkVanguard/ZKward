# ZK-STARK API Cloudflare Tunnel Deployment

This guide sets up a secure Cloudflare Tunnel to expose your local ZK-STARK Python API to the internet.

## Why Cloudflare Tunnel?

- **No open ports** - Your server stays behind NAT/firewall
- **No exposed IP** - DDoS protection built-in
- **Free tier available** - Zero cost for basic usage
- **Automatic TLS** - HTTPS with no certificate management
- **Global edge network** - Low latency worldwide

## Prerequisites

1. Cloudflare account (free)
2. Domain added to Cloudflare DNS
3. ZK-STARK Python API running on `localhost:8000`

## Quick Setup

### Windows (PowerShell)

```powershell
# Install cloudflared
winget install Cloudflare.cloudflared

# Run setup script
.\zkp\cloudflare-tunnel\setup.ps1 -TunnelName "zk-stark-api" -Hostname "zk-api.yourdomain.com"
```

### Linux/macOS

```bash
# Make executable
chmod +x zkp/cloudflare-tunnel/setup.sh

# Run setup
./zkp/cloudflare-tunnel/setup.sh
```

## Manual Setup

### 1. Install cloudflared

**Windows:**
```powershell
winget install Cloudflare.cloudflared
```

**macOS:**
```bash
brew install cloudflare/cloudflare/cloudflared
```

**Linux (Debian/Ubuntu):**
```bash
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
```

### 2. Authenticate

```bash
cloudflared tunnel login
```

This opens a browser to authenticate with your Cloudflare account.

### 3. Create Tunnel

```bash
cloudflared tunnel create zk-stark-api
```

Note the Tunnel ID returned.

### 4. Configure DNS Route

```bash
cloudflared tunnel route dns zk-stark-api zk-api.yourdomain.com
```

### 5. Create Config File

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: YOUR_TUNNEL_ID
credentials-file: ~/.cloudflared/YOUR_TUNNEL_ID.json

ingress:
  - hostname: zk-api.yourdomain.com
    service: http://localhost:8000
    originRequest:
      connectTimeout: 30s
      keepAliveTimeout: 120s
  - service: http_status:404
```

### 6. Run Tunnel

**One-time:**
```bash
cloudflared tunnel run zk-stark-api
```

**As service (recommended):**
```bash
# Linux
sudo cloudflared service install
sudo systemctl start cloudflared

# Windows
cloudflared service install
Start-Service cloudflared
```

## Update Your Application

Once the tunnel is running, update your environment:

```env
# .env
ZK_API_URL=https://zk-api.yourdomain.com
```

## Verify

Test the connection:

```bash
curl https://zk-api.yourdomain.com/health
```

Prove that a private number is inside public bounds:

```bash
curl -X POST https://zk-api.yourdomain.com/api/zk/bounds/prove   -H "Content-Type: application/json"   -d '{"statement":{"kind":"example","bounds":[[0,70]]},"witness":{"values":[55]}}'
```

## Monitoring

```bash
# Check tunnel status
cloudflared tunnel info zk-stark-api

# View logs (Linux)
sudo journalctl -u cloudflared -f

# View logs (Windows)
Get-EventLog -LogName Application -Source cloudflared -Newest 50
```

## Security Considerations

1. **Access Policies**: Add Cloudflare Access policies to restrict who can call the API
2. **Rate Limiting**: Configure rate limiting in Cloudflare dashboard
3. **API Keys**: Implement API key authentication in your ZK Python service

## Troubleshooting

**Tunnel not connecting:**
```bash
cloudflared tunnel cleanup zk-stark-api
cloudflared tunnel run zk-stark-api
```

**DNS not resolving:**
- Check Cloudflare DNS dashboard
- Ensure the CNAME record exists for your hostname

**Connection timeouts:**
- Increase `connectTimeout` in config
- Check if ZK API is running: `curl http://localhost:8000/health`
