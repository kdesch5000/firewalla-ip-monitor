# Changelog

All notable changes to the Firewalla IP Monitor project will be documented in this file.

## [1.1.0] - 2025-09-09

### Added
- **VPN Connection Detection**: Added comprehensive Wireguard VPN endpoint detection
  - New `collect_vpn_connections()` function in collection script
  - Detects VPN endpoints using `sudo wg show all` command
  - Extracts endpoint IP addresses and ports from Wireguard configuration
  - VPN connections appear with connection type "wireguard_endpoint"
  - Added VPN data processing in server.js `extractIPsFromData()` function

### Enhanced
- **Server-side DNS Resolution**: Moved hostname resolution from client to server
  - Added `/api/hostname/:ip` endpoint for hostname resolution
  - Implemented DNS caching to prevent repeated lookups
  - Eliminated CORS issues and rate limiting problems
  - Added `resolveHostname()` function with error handling

- **Data Collection Improvements**:
  - Enhanced `--all` flag to include VPN connection collection
  - Increased FireMain log reading from 1000 to 5000 lines for better coverage
  - Added VPN file type to server file processing pipeline
  - Improved error handling and logging throughout collection process

- **Web Interface Enhancements**:
  - Updated connection list to show VPN connection types
  - Improved geolocation display with proper VPN endpoint identification
  - Enhanced connection details to include VPN port information

### Fixed
- **VPN File Processing**: Fixed server not loading VPN connection files
  - VPN files were being created but not processed by web server
  - Added proper file grouping for `vpn_connections_` prefix
  - Fixed file discovery logic in `loadConnectionData()` function

- **Connection Type Classification**:
  - VPN endpoints now properly classified as "wireguard_endpoint" type
  - Added specific details formatting for VPN connections
  - Improved external IP validation for VPN traffic

### Technical Details
- Added `vpn_connections_` to `fileTypes` object in server.js
- Enhanced `collect_wan_connections.sh` with VPN-specific collection logic
- VPN data stored in JSON format: `vpn_connections_YYYYMMDD_HHMMSS.json`
- VPN connections include: type, external_ip, external_port, timestamp

### Example Output
VPN connections now appear in the API and web interface as:
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

## [1.0.0] - 2025-09-08

### Initial Release
- **Core Monitoring System**: Complete Firewalla IP monitoring with global map visualization
- **Multiple Data Sources**: FireMain logs, netstat, scan detection, real-time monitoring
- **Web Interface**: Interactive Leaflet.js map with connection list view
- **Automatic Collection**: Scheduled data collection every 2 minutes
- **IP Geolocation**: Integration with ip-api.com for location data
- **Hostname Resolution**: Client-side DNS resolution for connection identification

### Features Included
- Bash-based data collection from Firewalla Purple
- Node.js/Express web server with REST API
- Real-time connection monitoring and visualization
- Scan/probe detection and logging
- Automatic data cleanup (24-hour retention)
- Rate limiting and caching for external API calls

---

🤖 Generated with [Claude Code](https://claude.ai/code)