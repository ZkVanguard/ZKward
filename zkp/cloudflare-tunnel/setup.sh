#!/bin/bash
# =============================================================================
# ZK-STARK API Cloudflare Tunnel Setup
# =============================================================================
# This script sets up a Cloudflare Tunnel to expose the ZK-STARK Python API
# securely to the internet without opening ports or exposing your IP.
#
# Prerequisites:
#   - Cloudflare account with a domain
#   - cloudflared CLI installed
#   - ZK-STARK Python API running on localhost:8000
# =============================================================================

set -e

TUNNEL_NAME="zk-stark-api"
HOSTNAME="zk-api.zkward.com"  # Change to your domain

echo "🔐 ZK-STARK Cloudflare Tunnel Setup"
echo "===================================="

# Check if cloudflared is installed
if ! command -v cloudflared &> /dev/null; then
    echo "❌ cloudflared not found. Installing..."
    
    # Detect OS and install
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
        sudo dpkg -i cloudflared.deb
        rm cloudflared.deb
    elif [[ "$OSTYPE" == "darwin"* ]]; then
        brew install cloudflare/cloudflare/cloudflared
    else
        echo "Please install cloudflared manually: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/"
        exit 1
    fi
fi

echo "✅ cloudflared is installed"

# Login to Cloudflare (opens browser)
echo ""
echo "📋 Step 1: Authenticate with Cloudflare"
echo "This will open a browser window to authenticate..."
cloudflared tunnel login

# Create tunnel
echo ""
echo "📋 Step 2: Creating tunnel '${TUNNEL_NAME}'..."
cloudflared tunnel create ${TUNNEL_NAME}

# Get tunnel ID
TUNNEL_ID=$(cloudflared tunnel list | grep ${TUNNEL_NAME} | awk '{print $1}')
echo "✅ Tunnel created with ID: ${TUNNEL_ID}"

# Create config file
echo ""
echo "📋 Step 3: Creating configuration..."
mkdir -p ~/.cloudflared

cat > ~/.cloudflared/config.yml << EOF
# Cloudflare Tunnel Configuration for ZK-STARK API
tunnel: ${TUNNEL_ID}
credentials-file: /root/.cloudflared/${TUNNEL_ID}.json

ingress:
  # ZK-STARK API
  - hostname: ${HOSTNAME}
    service: http://localhost:8000
    originRequest:
      noTLSVerify: false
      connectTimeout: 30s
      
  # Health check endpoint
  - hostname: health.${HOSTNAME}
    service: http://localhost:8000/health
    
  # Catch-all (required)
  - service: http_status:404
EOF

echo "✅ Configuration created at ~/.cloudflared/config.yml"

# Route DNS
echo ""
echo "📋 Step 4: Setting up DNS routing..."
cloudflared tunnel route dns ${TUNNEL_NAME} ${HOSTNAME}
echo "✅ DNS route created: ${HOSTNAME} -> ${TUNNEL_NAME}"

# Create systemd service for auto-start
echo ""
echo "📋 Step 5: Creating systemd service..."
sudo cat > /etc/systemd/system/cloudflared-zk.service << EOF
[Unit]
Description=Cloudflare Tunnel for ZK-STARK API
After=network.target

[Service]
Type=simple
User=root
ExecStart=/usr/local/bin/cloudflared tunnel run ${TUNNEL_NAME}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable cloudflared-zk
sudo systemctl start cloudflared-zk

echo ""
echo "=============================================="
echo "✅ Cloudflare Tunnel Setup Complete!"
echo "=============================================="
echo ""
echo "Your ZK-STARK API is now available at:"
echo "  https://${HOSTNAME}"
echo ""
echo "Update your .env with:"
echo "  ZK_API_URL=https://${HOSTNAME}"
echo ""
echo "To check tunnel status:"
echo "  cloudflared tunnel info ${TUNNEL_NAME}"
echo "  sudo systemctl status cloudflared-zk"
echo ""
echo "To view logs:"
echo "  sudo journalctl -u cloudflared-zk -f"
echo ""
