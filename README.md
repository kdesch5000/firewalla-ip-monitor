# Firewalla IP Monitor

A comprehensive monitoring system that visualizes all external IP addresses connecting to or probing your Firewalla Purple's WAN interface on an interactive global map.

## Features

- **Global Map Visualization**: Interactive Leaflet.js map showing connection locations worldwide
- **Comprehensive Data Collection**: Monitors multiple sources:
  - FireMain logs (connection history)
  - Current active connections (netstat)
  - Real-time connection monitoring
  - Scan/probe detection
  - **VPN Connection Detection** (Wireguard endpoints)
- **Connection List View**: Detailed table showing IP addresses, hostnames, geolocation data
- **Server-side DNS Resolution**: Resolves hostnames without CORS limitations
- **Automatic Updates**: Collects fresh data every 2 minutes
- **Rate Limiting Protection**: Implements delays and caching for external APIs

## Architecture

### Components

- **Collection Script**: `collect_wan_connections.sh` - Bash script that collects data from Firewalla
- **Web Server**: `webapp/server.js` - Node.js/Express server providing APIs
- **Web Interface**: `webapp/public/index.html` - Frontend with map and list views
- **Startup Script**: `start-monitor.sh` - Convenient startup wrapper

### Data Sources

1. **FireMain Logs**: Historical connection data from Firewalla's main log
2. **Current Connections**: Active TCP/UDP connections via netstat
3. **Scan Detection**: SSH attempts, port scans, blocked connections
4. **Real-time Monitoring**: Live connection tracking with process info
5. **VPN Detection**: Wireguard endpoint discovery via `wg show`

## Installation

### Prerequisites

- Firewalla Purple with SSH access configured
- Node.js (v14+) and npm
- SSH key authentication to Firewalla

### Setup

1. **Clone the repository**:
   ```bash
   git clone https://github.com/kdesch5000/firewalla-ip-monitor.git
   cd firewalla-ip-monitor
   ```

2. **Install dependencies**:
   ```bash
   cd webapp
   npm install
   ```

3. **Configure connection settings**:
   Edit `collect_wan_connections.sh` and update:
   ```bash
   FIREWALLA_HOST="192.168.86.1"  # Your Firewalla IP
   FIREWALLA_USER="pi"            # SSH username
   WAN_IP="104.0.40.169"         # Your WAN IP
   ```

4. **Make scripts executable**:
   ```bash
   chmod +x collect_wan_connections.sh
   chmod +x start-monitor.sh
   ```

## Usage

### Start the Monitor

```bash
./start-monitor.sh
```

The monitor will:
- Start initial data collection
- Launch the web server on port 3001
- Begin automatic data collection every 2 minutes

### Access the Interface

- **Local**: http://localhost:3001
- **Network**: http://your-ip:3001
- **UniFi Network**: http://unifi.mf:3001

### Manual Data Collection

```bash
# Collect all data sources
./collect_wan_connections.sh --all

# Collect specific data types
./collect_wan_connections.sh --firemain
./collect_wan_connections.sh --current
./collect_wan_connections.sh --scans
./collect_wan_connections.sh --realtime
```

## API Endpoints

- `GET /api/connections` - Get all processed connection data
- `POST /api/refresh` - Trigger manual data collection
- `GET /api/hostname/:ip` - Resolve hostname for specific IP
- `GET /api/status` - Server status and statistics

## Recent Updates

### VPN Detection Enhancement
- **Added Wireguard VPN Detection**: Automatically discovers VPN endpoints using `sudo wg show`
- **Enhanced Data Processing**: VPN connections now appear with connection type "wireguard_endpoint"
- **Server-side DNS Resolution**: Improved hostname resolution without rate limiting
- **Comprehensive File Processing**: Fixed VPN file discovery and processing in server

### Example VPN Detection Output
```json
{
  "ip": "83.87.22.211",
  "country": "The Netherlands",
  "city": "Amstelveen",
  "connectionCount": 1,
  "connectionTypes": ["wireguard_endpoint"],
  "details": ["VPN endpoint on port 64609"]
}
```

## Configuration

### Port Configuration
The system uses port 3001 to avoid conflicts with UniFi (ports 8080, 8443).

### Data Retention
JSON data files are automatically cleaned up after 24 hours to manage disk space.

### Rate Limiting
- IP geolocation API calls are limited with 200ms delays
- DNS resolution includes caching to prevent repeated lookups
- Maximum 50 unique IPs processed per collection cycle

## Troubleshooting

### Common Issues

1. **SSH Connection Failed**:
   - Verify SSH key authentication to Firewalla
   - Check FIREWALLA_HOST and FIREWALLA_USER settings

2. **No VPN Connections Detected**:
   - Ensure Wireguard is active: `sudo wg show`
   - Verify script has sudo access on Firewalla

3. **Server Not Starting**:
   - Check port 3001 availability: `netstat -tlnp | grep 3001`
   - Verify Node.js dependencies: `cd webapp && npm install`

4. **Missing Connection Data**:
   - Check Firewalla log permissions
   - Verify data directory permissions: `ls -la data/`

### Debug Mode

Enable detailed logging by modifying server.js to include debug output.

## File Structure

```
firewalla-ip-monitor/
├── README.md                    # This file
├── collect_wan_connections.sh   # Data collection script
├── start-monitor.sh            # Startup script
├── data/                       # JSON data files (auto-generated)
└── webapp/
    ├── server.js               # Node.js server
    ├── package.json           # Dependencies
    └── public/
        └── index.html         # Web interface
```

## Contributing

This project monitors network security and external connections. Contributions should focus on:
- Enhanced connection detection
- Improved geolocation accuracy
- Better visualization features
- Performance optimizations

## License

Private monitoring tool for personal network security analysis.

---

🤖 Generated with [Claude Code](https://claude.ai/code)