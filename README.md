# Firewalla IP Monitor

<img width="1157" height="914" alt="image" src="https://github.com/user-attachments/assets/1a7fb1dd-d97e-436b-9d93-a1db445496f7" />


A comprehensive monitoring system that visualizes all external IP addresses connecting to or probing your Firewalla Purple's WAN interface on an interactive global map.

## Features

- **Global Map Visualization**: Interactive Leaflet.js map showing connection locations worldwide
- **PostgreSQL Database Backend**: High-performance database for historical connection storage
- **Comprehensive Data Collection**: Monitors multiple sources:
  - FireMain logs (connection history)
  - Current active connections (netstat)
  - Connection tracking table (`/proc/net/nf_conntrack`)
  - Real-time connection monitoring
  - Scan/probe detection
  - **VPN Connection Detection** (Wireguard endpoints)
- **Historical Data Analysis**: Time-based filtering and visualization of connection history
- **Advanced Filtering**: Filter connections by direction (inbound/outbound), date ranges, IP addresses
- **Connection List View**: Detailed table showing IP addresses, hostnames, geolocation data with CSV export
- **Arc Visualization**: Curved lines on map showing connection paths from sources to home location
- **Color-coded Connections**: Visual legend for different connection types and directions
- **Data Retention Policies**: Configurable size and time-based data cleanup
- **Server-side DNS Resolution**: Resolves hostnames without CORS limitations
- **Automatic Updates**: Collects fresh data every 2 minutes with database storage
- **Performance Optimized**: Sub-second query responses for historical data (6x faster than file-based)
- **Real-time Threat Intelligence Status**: Live header display showing scanned vs unscanned IP counts with tiered priority system

## Architecture

### Components

- **Collection Script**: `collect_wan_connections.sh` - Bash script that collects data from Firewalla
- **Web Server**: `webapp/server.js` - Node.js/Express server providing APIs
- **Database Layer**: `webapp/database.js` - PostgreSQL database management with retention policies
- **Schema Setup**: `postgres_schema.sql` - PostgreSQL database schema and indexes
- **Web Interface**: `webapp/public/index.html` - Frontend with map and list views
- **Startup Script**: `start-monitor.sh` - Convenient startup wrapper
- **Systemd Service**: `firewalla-monitor.service` - System service for auto-start

### Database Architecture

The system uses PostgreSQL for efficient historical data storage:

```
┌─────────────────────────────────────┐         ┌─────────────────────────────────────┐
│              CONNECTIONS            │         │            GEOLOCATIONS            │
├─────────────────────────────────────┤         ├─────────────────────────────────────┤
│ PK  id                 INTEGER      │         │ PK  ip               TEXT           │
│     ip                 TEXT         │◄────────┤     country          TEXT           │
│     timestamp          DATETIME     │         │     country_code     TEXT           │
│     direction          TEXT         │         │     region           TEXT           │
│     connection_type    TEXT         │         │     city             TEXT           │
│     internal_ip        TEXT         │         │     latitude         REAL           │
│     internal_port      INTEGER      │         │     longitude        REAL           │
│     external_port      INTEGER      │         │     timezone         TEXT           │
│     state              TEXT         │         │     isp              TEXT           │
│     orig_packets       INTEGER      │         │     org              TEXT           │
│     orig_bytes         INTEGER      │         │     asn              TEXT           │
│     reply_packets      INTEGER      │         │     hostname         TEXT           │
│     reply_bytes        INTEGER      │         │     last_updated     DATETIME      │
│     details            TEXT         │         └─────────────────────────────────────┘
│     source_file        TEXT         │
│     created_at         DATETIME     │
└─────────────────────────────────────┘
```

### Data Sources

1. **FireMain Logs**: Historical connection data from Firewalla's main log
2. **Connection Tracking**: Comprehensive NAT data from `/proc/net/nf_conntrack`
3. **Current Connections**: Active TCP/UDP connections via netstat
4. **Scan Detection**: SSH attempts, port scans, blocked connections
5. **Real-time Monitoring**: Live connection tracking with process info
6. **VPN Detection**: Wireguard endpoint discovery via `wg show`

## Installation

### Quick Install (Recommended)

Run the automated installer that handles everything for you:

```bash
curl -fsSL https://raw.githubusercontent.com/kdesch5000/firewalla-ip-monitor/main/install.sh | bash
```

Or download and run locally:
```bash
git clone https://github.com/kdesch5000/firewalla-ip-monitor.git
cd firewalla-ip-monitor
./install.sh
```

The installer will:
- ✅ Install all system dependencies (Node.js, PostgreSQL, SSH tools)  
- ✅ Walk you through configuration (Firewalla IP, database settings)
- ✅ Set up SSH key authentication (optional)
- ✅ Configure systemd service for auto-start (optional)
- ✅ Test the installation to ensure everything works

### Manual Installation

If you prefer manual setup:

#### Prerequisites
- Ubuntu/Debian Linux with apt package manager
- Firewalla Purple with SSH access configured
- Node.js (v14+) and npm
- PostgreSQL

#### Setup Steps

1. **Install dependencies**:
   ```bash
   sudo apt update
   sudo apt install nodejs npm postgresql postgresql-contrib ssh curl jq
   ```

2. **Clone the repository**:
   ```bash
   git clone https://github.com/kdesch5000/firewalla-ip-monitor.git
   cd firewalla-ip-monitor
   ```

3. **Configure connection settings**:
   Edit `collect_wan_connections.sh` and update:
   ```bash
   FIREWALLA_HOST="192.168.1.1"   # Your Firewalla IP
   FIREWALLA_USER="pi"             # SSH username
   ```

4. **Install Node.js dependencies**:
   ```bash
   cd webapp
   npm install --production
   cd ..
   ```

5. **Set up SSH key authentication**:
   ```bash
   ssh-keygen -t rsa -b 4096      # Generate key if needed
   ssh-copy-id pi@your-firewalla-ip
   ```

6. **Make scripts executable**:
   ```bash
   chmod +x collect_wan_connections.sh
   chmod +x start-monitor.sh
   ```

## Usage

### Threat Intelligence Status

The web interface displays a real-time threat intelligence status indicator in the header:

```
🔍 Threat Intel
45 Scanned | 1,634 Not Scanned
1,143 Unknown • 490 Cloud • 3% Complete of 1,679
```

**Status Components:**
- **Scanned**: IPs with current threat intelligence data (green)
- **Not Scanned**: IPs waiting for threat analysis (red)  
- **Unknown**: Suspicious/unknown IP ranges (Priority 1 - scanned first)
- **Cloud**: Major cloud providers (Priority 2 - scanned after unknowns)
- **Completion**: Overall scanning progress percentage

**Tiered Scanning System:**
- **Priority 1 (7-day cache)**: Unknown/suspicious IPs get scanned first
- **Priority 2 (30-day cache)**: Cloud providers (AWS, Google, Microsoft, Apple) scanned when unknowns queue is empty
- **Auto-refresh**: Status updates every 30 seconds
- **Recently Updated**: Shows (+X new) when IPs are scanned since last refresh

**Hover for Details:**
The status indicator includes a comprehensive tooltip showing:
- Total external IPs discovered
- Breakdown by priority level  
- Exact counts and percentages
- Recently updated IP counts

### Starting the Monitor

#### As a System Service (Recommended)
If you used the installer and set up the systemd service:

```bash
# Start the service
sudo systemctl start firewalla-monitor

# Check status
sudo systemctl status firewalla-monitor

# View logs
sudo journalctl -u firewalla-monitor -f

# Stop the service
sudo systemctl stop firewalla-monitor
```

#### Manual Start
```bash
./start-monitor.sh
```

### Access the Web Interface

Once running, access the web interface at:
- **Local**: http://localhost:3001
- **Network**: http://your-ip:3001

The monitor will:
- Start initial data collection from your Firewalla
- Launch the web server on port 3001  
- Begin automatic data collection every 2 minutes
- Store data in PostgreSQL database with automatic retention policies

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

### Core Data APIs
- `GET /api/connections` - Get current processed connection data
- `GET /api/connections/history` - Get historical connections (file-based, slower)
- `GET /api/connections/history-fast` - Get historical connections (database-based, fast)
- `GET /api/location/:ip` - Get geolocation data for specific IP
- `GET /api/hostname/:ip` - Resolve hostname for specific IP
- `GET /api/status` - Server status and statistics
- `GET /api/stats` - Database and system statistics
- `POST /api/refresh` - Trigger manual data collection

### Database Management APIs
- `GET /api/retention/config` - Get current retention policy configuration
- `PUT /api/retention/config` - Update retention policy settings
- `POST /api/retention/run` - Manually trigger retention policy cleanup

### Query Parameters for Historical Data
- `startDate` - Filter connections after this date (ISO format)
- `endDate` - Filter connections before this date (ISO format)
- `direction` - Filter by connection direction (`inbound`, `outbound`, `both`)
- `limit` - Maximum number of records to return
- `ip` - Filter by specific IP address

## Database Features

### PostgreSQL Integration
- **High Performance**: 6x faster than file-based queries (sub-3-second vs 18+ seconds)
- **Structured Storage**: Normalized tables for connections and geolocation data
- **Full-text Search**: Indexed fields for fast IP, timestamp, and direction filtering
- **Data Integrity**: Unique constraints prevent duplicate connection records
- **Efficient Joins**: Optimized relationship between connections and geolocation tables

### Data Retention Policies
- **Size-based Retention**: Configurable maximum database size (default: 10GB)
- **Time-based Retention**: Configurable data age limit (default: 45 days)
- **Automated Cleanup**: Daily scheduled cleanup at 2 AM
- **Manual Triggers**: API endpoints for immediate retention policy execution
- **Space Recovery**: Automatic VACUUM operations to reclaim disk space
- **Orphan Cleanup**: Removes unused geolocation entries

### Performance Metrics
- **Current Database**: 550MB storing 1.18M connections from 1,825 unique IPs
- **Query Speed**: Sub-second responses for complex historical queries
- **Space Efficiency**: ~275MB per day of connection data
- **Retention Results**: Recent cleanup removed 5,000+ records, saving 34.7MB

### Migration Support
- **Schema Setup**: `postgres_schema.sql` provides optimized table structure
- **Batch Processing**: Handles large datasets efficiently (2,700+ files)
- **Data Preservation**: Maintains all historical connection and geolocation data
- **Backward Compatibility**: Existing APIs continue to work during transition

## Configuration

### Port Configuration
The system uses port 3001 to avoid conflicts with UniFi (ports 8080, 8443).

### Data Retention
- **Database Retention**: Configurable size (10GB) and time limits (45 days)
- **Automatic Cleanup**: Daily retention policy execution at 2 AM
- **JSON Files**: Legacy files removed after database migration to save 296MB+ disk space

### Rate Limiting
- IP geolocation API calls are limited with 200ms delays
- DNS resolution includes caching to prevent repeated lookups
- Maximum 50 unique IPs processed per collection cycle

## Troubleshooting

### Installation Issues

1. **Installer fails on dependency installation**:
   ```bash
   # Install dependencies manually
   sudo apt update
   sudo apt install nodejs npm postgresql postgresql-contrib ssh curl jq
   ```

2. **SSH connection test fails**:
   - Verify Firewalla IP address is correct
   - Ensure SSH is enabled on your Firewalla device
   - Test manually: `ssh pi@your-firewalla-ip`
   - Set up SSH key: `ssh-copy-id pi@your-firewalla-ip`

3. **Permission denied errors**:
   - Don't run installer as root
   - Ensure your user has sudo privileges
   - Check file permissions after installation

### Runtime Issues

1. **Service won't start**:
   ```bash
   # Check service status
   sudo systemctl status firewalla-monitor
   
   # View detailed logs  
   sudo journalctl -u firewalla-monitor -n 50
   
   # Test manual start
   cd /path/to/installation && ./start-monitor.sh
   ```

2. **Database errors**:
   ```bash
   # Check database file permissions
   ls -la data/connections.db
   
   # Test database manually
   psql -d firewalla_monitor -c "SELECT COUNT(*) FROM connections;"
   ```

3. **No connection data appearing**:
   - Verify SSH connectivity: `ssh pi@your-firewalla-ip "echo test"`
   - Check Firewalla log permissions
   - Test data collection: `./collect_wan_connections.sh --firemain`

4. **Web interface not accessible**:
   - Check if port 3001 is available: `netstat -tlnp | grep 3001`
   - Verify firewall settings
   - Check server logs in systemd journal

### Debug Mode

Enable detailed logging by setting environment variable:
```bash
DEBUG=* ./start-monitor.sh
```

## File Structure

```
firewalla-ip-monitor/
├── README.md                    # This file
├── CHANGELOG.md                # Version history and updates
├── install.sh                  # Automated installer script
├── collect_wan_connections.sh   # Data collection script
├── start-monitor.sh            # Startup script
├── migrate_to_db.js            # Database migration tool
├── firewalla-monitor.service   # Systemd service file template
├── data/                       # Database and cache files (created at runtime)
│   ├── (PostgreSQL database)   # Remote PostgreSQL server
│   └── geolocation_cache.json  # IP geolocation cache
└── webapp/
    ├── server.js               # Node.js server
    ├── database.js             # PostgreSQL database layer
    ├── package.json           # Node.js dependencies
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
