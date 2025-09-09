#!/bin/bash

# Firewalla IP Monitor Startup Script

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEBAPP_DIR="${SCRIPT_DIR}/webapp"

# Colors for output
GREEN='\033[32m'
RED='\033[31m'
BLUE='\033[34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🌐 Starting Firewalla IP Monitor${NC}"

# Check if Node.js is available
if ! command -v node >/dev/null 2>&1; then
    echo -e "${RED}❌ Node.js not found. Please install Node.js first.${NC}"
    exit 1
fi

# Check if npm dependencies are installed
if [[ ! -d "${WEBAPP_DIR}/node_modules" ]]; then
    echo -e "${BLUE}📦 Installing Node.js dependencies...${NC}"
    cd "${WEBAPP_DIR}"
    npm install
fi

# Collect initial data (skip if SSH connection fails)
echo -e "${BLUE}📊 Collecting initial connection data...${NC}"
if "${SCRIPT_DIR}/collect_wan_connections.sh" --firemain; then
    echo -e "${GREEN}✅ Initial data collection successful${NC}"
else
    echo -e "${BLUE}ℹ️  Skipping initial data collection (SSH connection failed - will use existing data)${NC}"
fi

# Check if port 3001 is available
if netstat -tuln | grep -q ":3001 "; then
    echo -e "${RED}❌ Port 3001 is already in use!${NC}"
    echo "Please stop the service using port 3001 or modify server.js to use a different port."
    exit 1
fi

echo -e "${GREEN}✅ Starting web server on port 3001...${NC}"
echo -e "${GREEN}🌍 Access the monitor at:${NC}"
echo -e "  ${BLUE}• Local: http://localhost:3001${NC}"
echo -e "  ${BLUE}• Network: http://[your-server]:3001${NC}"
echo -e "  ${BLUE}• IP: http://$(hostname -I | awk '{print $1}'):3001${NC}"
echo
echo -e "${GREEN}💡 Tips:${NC}"
echo -e "  • Press Ctrl+C to stop the server"
echo -e "  • Data refreshes automatically every 30 minutes"
echo -e "  • Click 'Refresh Data' for manual updates"
echo
echo -e "${BLUE}🚀 Starting server...${NC}"

cd "${WEBAPP_DIR}"
node server.js