# Changelog

All notable changes to the Firewalla IP Monitor project will be documented in this file.

## [2.0.0] - 2025-09-09

### 🚀 Major: SQLite Database Implementation

**Performance Breakthrough**: Complete migration from JSON file storage to SQLite database with **6x performance improvement**.

#### Added
- **SQLite Database Backend**: 
  - High-performance structured storage replacing JSON files
  - Normalized tables: `connections` and `geolocations`
  - Comprehensive indexing for sub-second query responses
  - Database file: `/data/connections.db` (550MB storing 1.18M+ connections)
  
- **Database Management System**:
  - `webapp/database.js` - Full database abstraction layer
  - `migrate_to_db.js` - Migration tool for converting JSON to SQLite
  - Unique constraints preventing duplicate connection records
  - Efficient LEFT JOIN operations for geolocation data

- **Data Retention Policies**:
  - **Size-based retention**: Configurable maximum database size (default: 10GB)
  - **Time-based retention**: Configurable data age limit (default: 45 days)
  - **Automated cleanup**: Daily scheduled retention at 2 AM via cron
  - **Manual triggers**: API endpoints for immediate cleanup execution
  - **Space recovery**: Automatic VACUUM operations after significant deletions
  - **Orphan cleanup**: Removes geolocation entries for deleted IPs

#### Performance Improvements
- **Query Speed**: Sub-3-second responses vs 18+ seconds (file-based)
- **Database Size**: 550MB storing 2+ days of comprehensive connection data
- **Space Efficiency**: ~275MB per day of connection tracking
- **Memory Usage**: Optimized server memory footprint with database caching

#### New API Endpoints
- `GET /api/connections/history-fast` - High-speed database queries
- `GET /api/stats` - Database and system statistics
- `GET /api/retention/config` - View retention policy settings
- `PUT /api/retention/config` - Update retention policies
- `POST /api/retention/run` - Manually trigger cleanup

#### Database Schema
```sql
CREATE TABLE connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT NOT NULL,
    timestamp DATETIME NOT NULL,
    direction TEXT NOT NULL,
    connection_type TEXT,
    internal_ip TEXT,
    internal_port INTEGER,
    external_port INTEGER,
    state TEXT,
    orig_packets INTEGER DEFAULT 0,
    orig_bytes INTEGER DEFAULT 0,
    reply_packets INTEGER DEFAULT 0,
    reply_bytes INTEGER DEFAULT 0,
    details TEXT,
    source_file TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(ip, timestamp, direction, internal_ip, external_port)
);

CREATE TABLE geolocations (
    ip TEXT PRIMARY KEY,
    country TEXT, country_code TEXT, region TEXT, city TEXT,
    latitude REAL, longitude REAL, timezone TEXT,
    isp TEXT, org TEXT, asn TEXT, hostname TEXT,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

#### Migration Results
- **2,773 JSON files** successfully migrated to SQLite
- **296MB disk space** reclaimed by removing redundant JSON files
- **1.18M connection records** from 1,825 unique IPs preserved
- **Zero data loss** during migration process

#### Enhanced Features
- **Historical Data Analysis**: Fast time-range filtering and visualization
- **Advanced Query Filters**: IP, direction, date ranges with database indexes
- **Retention Management**: Live configuration updates without service restart
- **Backward Compatibility**: Existing APIs maintained during transition

### Fixed
- **Performance Issues**: Eliminated multi-minute load times for historical data
- **Memory Leaks**: Database connection management prevents server crashes
- **Disk Space Growth**: Automated retention prevents unlimited database expansion

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