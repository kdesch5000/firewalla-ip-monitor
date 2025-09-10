const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const cors = require('cors');
const cron = require('node-cron');
const { exec } = require('child_process');
const { promisify } = require('util');
const dns = require('dns').promises;
const ConnectionsDatabase = require('./database');

const app = express();
const PORT = 3001; // Safe port away from UniFi
const execAsync = promisify(exec);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configuration
const CONFIG = {
    dataDir: path.join(__dirname, '..', 'data'),
    collectorScript: path.join(__dirname, '..', 'collect_wan_connections.sh'),
    geoServiceUrl: 'http://ip-api.com/json/', // Free IP geolocation service
    wanHostname: 'mrfish.ooguy.com', // Our WAN interface hostname
    homeLocation: {
        latitude: 41.8781,  // Chicago coordinates
        longitude: -87.6298,
        city: 'Chicago',
        region: 'Illinois',
        country: 'United States'
    }
};

// In-memory cache for processed data
let connectionsCache = [];
let lastUpdate = new Date();

// Hostname resolution cache
const hostnameCache = new Map();

// Cache for WAN IP resolution
let wanIPCache = null;
let wanIPCacheTime = 0;
const WAN_IP_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Persistent geolocation cache
const GEOLOCATION_CACHE_FILE = path.join(CONFIG.dataDir, 'geolocation_cache.json');
let geolocationCache = new Map();

// Database instance with retention policies and email notifications
const db = new ConnectionsDatabase('../data/connections.db', {
    maxSizeMB: 10240,      // 10GB max database size
    maxAgeDays: 30,        // 30 days retention
    cleanupBatchSize: 5000, // Delete 5000 records per cleanup batch
    enableSizeLimit: true,
    enableTimeLimit: true,
    // Email notification settings (uses system mail command)
    enableEmailNotifications: true,
    emailRecipient: 'admin@example.com'
});

// Logging function
const log = (message) => {
    console.log(`[${new Date().toISOString()}] ${message}`);
};

// Load geolocation cache from disk
async function loadGeolocationCache() {
    try {
        const cacheData = await fs.readFile(GEOLOCATION_CACHE_FILE, 'utf8');
        const parsedData = JSON.parse(cacheData);
        
        // Convert array back to Map
        geolocationCache = new Map(parsedData);
        log(`Loaded ${geolocationCache.size} cached geolocation entries`);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            log(`Error loading geolocation cache: ${error.message}`);
        }
        // If file doesn't exist or is invalid, start with empty cache
        geolocationCache = new Map();
    }
}

// Save geolocation cache to disk
async function saveGeolocationCache() {
    try {
        // Convert Map to array for JSON serialization
        const cacheArray = Array.from(geolocationCache.entries());
        await fs.writeFile(GEOLOCATION_CACHE_FILE, JSON.stringify(cacheArray, null, 2));
        log(`Saved ${geolocationCache.size} geolocation entries to cache`);
    } catch (error) {
        log(`Error saving geolocation cache: ${error.message}`);
    }
}

// Get current WAN IP by resolving mrfish.ooguy.com
async function getWanIP() {
    const now = Date.now();
    
    // Return cached IP if still valid
    if (wanIPCache && (now - wanIPCacheTime) < WAN_IP_CACHE_DURATION) {
        return wanIPCache;
    }
    
    try {
        const addresses = await dns.lookup(CONFIG.wanHostname, { family: 4 });
        wanIPCache = addresses.address;
        wanIPCacheTime = now;
        log(`Resolved WAN IP: ${wanIPCache}`);
        return wanIPCache;
    } catch (error) {
        log(`Error resolving WAN hostname ${CONFIG.wanHostname}: ${error.message}`);
        // Return cached value if available, otherwise null
        return wanIPCache;
    }
}

// Server-side hostname resolution
async function resolveHostname(ip) {
    // Check cache first
    if (hostnameCache.has(ip)) {
        return hostnameCache.get(ip);
    }
    
    try {
        const hostnames = await dns.reverse(ip);
        if (hostnames && hostnames.length > 0) {
            const hostname = hostnames[0];
            hostnameCache.set(ip, hostname);
            return hostname;
        }
    } catch (error) {
        // DNS resolution failed - cache the failure to avoid repeated attempts
        hostnameCache.set(ip, 'No hostname found');
    }
    
    return 'No hostname found';
}

// Get external IP geolocation using free service
async function getIPLocation(ip) {
    // Check cache first
    if (geolocationCache.has(ip)) {
        const cachedData = geolocationCache.get(ip);
        log(`Using cached geolocation for ${ip}`);
        return cachedData;
    }
    
    try {
        const axios = require('axios');
        const response = await axios.get(`${CONFIG.geoServiceUrl}${ip}?fields=status,country,countryCode,region,regionName,city,lat,lon,timezone,isp,org,as,query`);
        
        if (response.data.status === 'success') {
            const locationData = {
                ip: ip,
                country: response.data.country,
                countryCode: response.data.countryCode,
                region: response.data.regionName,
                city: response.data.city,
                latitude: response.data.lat,
                longitude: response.data.lon,
                timezone: response.data.timezone,
                isp: response.data.isp,
                org: response.data.org,
                asn: response.data.as,
                cachedAt: new Date().toISOString()
            };
            
            // Cache the result
            geolocationCache.set(ip, locationData);
            log(`Cached geolocation for ${ip}: ${locationData.city}, ${locationData.region}, ${locationData.country}`);
            
            // Save cache to disk periodically (every 10 entries)
            if (geolocationCache.size % 10 === 0) {
                saveGeolocationCache();
            }
            
            return locationData;
        }
    } catch (error) {
        log(`Error getting location for IP ${ip}: ${error.message}`);
        
        // Cache failures to avoid repeated API calls for problematic IPs
        const failureData = {
            ip: ip,
            error: 'Location lookup failed',
            cachedAt: new Date().toISOString()
        };
        geolocationCache.set(ip, failureData);
    }
    
    return null;
}

// Filter for truly external IPs
async function isExternalIP(ip) {
    if (!ip || !ip.match(/^\d+\.\d+\.\d+\.\d+$/)) return false;
    
    // Filter out our own WAN IP (dynamically resolved)
    const wanIP = await getWanIP();
    if (wanIP && ip === wanIP) return false;
    
    // Private IP ranges
    if (ip.startsWith('192.168.') || ip.startsWith('10.')) return false;
    if (ip.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./)) return false;
    if (ip.startsWith('127.')) return false;
    
    // Other non-routable ranges
    if (ip.startsWith('169.254.')) return false; // Link-local
    if (ip.startsWith('224.')) return false; // Multicast
    
    return true;
}

// Extract IPs from different data source types
async function extractIPsFromData(data, dataType) {
    const ips = [];
    
    if (!Array.isArray(data)) return ips;
    
    // Get WAN IP once for this extraction session
    const wanIP = await getWanIP();
    
    for (const item of data) {
        try {
            switch (dataType) {
                case 'connections':
                    if (item.external_ip && await isExternalIP(item.external_ip)) {
                        ips.push({
                            ip: item.external_ip,
                            timestamp: item.timestamp,
                            type: 'firemain_log',
                            details: `Connection from ${item.internal_ip}`,
                            direction: 'inbound'
                        });
                    }
                    break;
                
                case 'current_connections':
                    // For netstat data, we want the remote IP (not our WAN IP)
                    let actualExternalIP = null;
                    if (item.local_ip && item.external_ip) {
                        // If external_ip is our WAN IP, then local_ip is actually the external one
                        if (item.external_ip === wanIP) {
                            actualExternalIP = item.local_ip;
                        } else {
                            actualExternalIP = item.external_ip;
                        }
                        
                        if (actualExternalIP && await isExternalIP(actualExternalIP)) {
                            ips.push({
                                ip: actualExternalIP,
                                timestamp: item.timestamp,
                                type: 'active_connection',
                                details: `${item.state} connection on port ${item.local_port || item.external_port}`,
                                direction: 'inbound'
                            });
                        }
                    }
                    break;
                
                case 'scans_probes':
                    // Extract IPs from log entries
                    const logEntry = item.log_entry || '';
                    const ipMatches = logEntry.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g);
                    if (ipMatches) {
                        for (const ip of ipMatches) {
                            if (await isExternalIP(ip)) {
                                ips.push({
                                    ip: ip,
                                    timestamp: item.timestamp,
                                    type: item.type || 'scan_probe',
                                    details: logEntry.substring(0, 100),
                                    direction: 'inbound'
                                });
                            }
                        }
                    }
                    break;
                
                case 'realtime_connections':
                    // Extract IPs from netstat/ss data
                    const data_entry = item.data || '';
                    const realtimeIPs = data_entry.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g);
                    if (realtimeIPs) {
                        for (const ip of realtimeIPs) {
                            if (await isExternalIP(ip)) {
                                ips.push({
                                    ip: ip,
                                    timestamp: item.timestamp,
                                    type: item.type || 'realtime',
                                    details: data_entry.substring(0, 100),
                                    direction: 'inbound'
                                });
                            }
                        }
                    }
                    break;
                
                case 'vpn_connections':
                    // Extract IPs from VPN connection data
                    if (item.external_ip && await isExternalIP(item.external_ip)) {
                        ips.push({
                            ip: item.external_ip,
                            timestamp: item.timestamp,
                            type: item.type || 'vpn',
                            details: `VPN endpoint on port ${item.external_port}`,
                            direction: 'outbound'
                        });
                    }
                    break;
                
                case 'outbound_connections':
                    // Extract IPs from outbound connection data
                    if (item.external_ip && await isExternalIP(item.external_ip)) {
                        ips.push({
                            ip: item.external_ip,
                            timestamp: item.timestamp,
                            type: item.state || 'outbound_connection',
                            details: `Outbound ${item.state} connection from ${item.local_ip}:${item.local_port} to port ${item.external_port}`,
                            direction: 'outbound'
                        });
                    }
                    break;
                
                case 'connection_tracking':
                    // Extract IPs from connection tracking data (most comprehensive)
                    if (item.external_ip && await isExternalIP(item.external_ip)) {
                        const bytes_total = (item.orig_bytes || 0) + (item.reply_bytes || 0);
                        const packets_total = (item.orig_packets || 0) + (item.reply_packets || 0);
                        ips.push({
                            ip: item.external_ip,
                            timestamp: item.timestamp,
                            type: item.state || 'connection_tracking',
                            details: `${item.direction} ${item.state} connection via ${item.internal_ip}:${item.internal_port} ↔ ${item.external_ip}:${item.external_port} (${bytes_total} bytes, ${packets_total} packets)`,
                            direction: item.direction
                        });
                    }
                    break;
            }
        } catch (error) {
            // Skip malformed entries
            log(`Error processing ${dataType} entry: ${error.message}`);
        }
    }
    
    return ips;
}

// Load and process connection data from ALL sources
async function loadConnectionData() {
    try {
        log('Loading connection data from all sources...');
        
        // Read all JSON files from data directory
        const files = await fs.readdir(CONFIG.dataDir);
        const jsonFiles = files.filter(file => file.endsWith('.json'));
        
        if (jsonFiles.length === 0) {
            log('No connection data files found');
            return [];
        }
        
        // Group files by type and get most recent of each type
        const fileTypes = {
            'connections_': [],
            'current_connections_': [],
            'scans_probes_': [],
            'realtime_connections_': [],
            'vpn_connections_': [],
            'outbound_connections_': [],
            'connection_tracking_': []
        };
        
        jsonFiles.forEach(file => {
            Object.keys(fileTypes).forEach(prefix => {
                if (file.startsWith(prefix)) {
                    fileTypes[prefix].push(file);
                }
            });
        });
        
        // Collect all IPs from all sources
        const allConnectionData = [];
        
        // Process all files to get complete historical data
        for (const [prefix, files] of Object.entries(fileTypes)) {
            if (files.length > 0) {
                const dataType = prefix.replace(/_$/, ''); // Remove only trailing underscore
                log(`Loading ${dataType} from ${files.length} files...`);
                
                // Sort files by timestamp (newest first) and process all
                const sortedFiles = files.sort().reverse();
                
                for (const file of sortedFiles) {
                    const filePath = path.join(CONFIG.dataDir, file);
                    
                    try {
                        const data = await fs.readFile(filePath, 'utf8');
                        const parsedData = JSON.parse(data);
                        const extractedIPs = await extractIPsFromData(parsedData, dataType);
                        allConnectionData.push(...extractedIPs);
                        
                        // Limit processing to avoid memory issues (keep last 24 hours worth)
                        const fileTimestamp = file.match(/(\d{8}_\d{6})/);
                        if (fileTimestamp) {
                            const fileDate = new Date(
                                fileTimestamp[1].replace(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/, 
                                '$1-$2-$3T$4:$5:$6')
                            );
                            const hoursSinceFile = (Date.now() - fileDate.getTime()) / (1000 * 60 * 60);
                            
                            // Stop processing files older than 24 hours for performance
                            if (hoursSinceFile > 24) {
                                break;
                            }
                        }
                    } catch (error) {
                        log(`Error reading ${dataType} file ${file}: ${error.message}`);
                    }
                }
                
                log(`Total extracted ${allConnectionData.length} connection records from ${dataType}`);
            }
        }
        
        // Insert new connection data into database if available
        if (db && db.isInitialized && allConnectionData.length > 0) {
            try {
                log(`Inserting ${allConnectionData.length} connection records into database...`);
                
                // Prepare connection data for database insertion
                const connectionsForDB = allConnectionData.map(conn => ({
                    ip: conn.ip,
                    timestamp: conn.timestamp,
                    direction: conn.direction || 'inbound',
                    connection_type: conn.type,
                    internal_ip: conn.internal_ip || null,
                    internal_port: conn.internal_port || null,
                    external_port: conn.external_port || null,
                    state: conn.state || null,
                    orig_packets: conn.orig_packets || 0,
                    orig_bytes: conn.orig_bytes || 0,
                    reply_packets: conn.reply_packets || 0,
                    reply_bytes: conn.reply_bytes || 0,
                    details: conn.details || null,
                    source_file: conn.source_file || 'live_collection'
                }));
                
                // Use aggregated batch insert with data reduction
                const insertedCount = await db.insertConnectionsAggregated(connectionsForDB);
                log(`Successfully inserted ${insertedCount} new connection records into database`);
                
            } catch (error) {
                log(`Warning: Failed to insert connections into database: ${error.message}`);
            }
        } else if (!db || !db.isInitialized) {
            log('Database not initialized, skipping insertion');
        }
        
        // Group by unique external IP
        const ipGroups = {};
        allConnectionData.forEach(conn => {
            if (!ipGroups[conn.ip]) {
                ipGroups[conn.ip] = [];
            }
            ipGroups[conn.ip].push(conn);
        });
        
        const uniqueIPs = Object.keys(ipGroups);
        log(`Found ${uniqueIPs.length} unique external IPs across all sources`);
        
        // Get geolocation for each IP (with rate limiting)
        const processedConnections = [];
        for (let i = 0; i < Math.min(uniqueIPs.length, 50); i++) { // Increased limit
            const ip = uniqueIPs[i];
            const location = await getIPLocation(ip);
            
            if (location && location.latitude && location.longitude) {
                // Insert/update geolocation data in database
                if (db && db.isInitialized) {
                    try {
                        await db.upsertGeolocation(ip, location);
                    } catch (error) {
                        log(`Warning: Failed to insert geolocation for ${ip}: ${error.message}`);
                    }
                }
                
                const ipConnections = ipGroups[ip];
                const connectionCount = ipConnections.length;
                const lastSeen = ipConnections
                    .map(conn => new Date(conn.timestamp))
                    .sort((a, b) => b - a)[0];
                
                // Resolve hostname for this IP
                const hostname = await resolveHostname(ip);
                
                // Calculate direction counts
                const directions = ipConnections.map(c => c.direction || 'inbound');
                const inboundCount = directions.filter(d => d === 'inbound').length;
                const outboundCount = directions.filter(d => d === 'outbound').length;
                
                processedConnections.push({
                    ...location,
                    hostname: hostname,
                    connectionCount,
                    inboundCount,
                    outboundCount,
                    lastSeen: lastSeen ? lastSeen.toISOString() : new Date().toISOString(),
                    connectionTypes: [...new Set(ipConnections.map(c => c.type))],
                    directions: [...new Set(directions)],
                    details: ipConnections.slice(0, 3).map(c => c.details) // Keep some sample details
                });
            }
            
            // Rate limiting delay - be nice to the free service
            if (i < Math.min(uniqueIPs.length, 50) - 1) {
                await new Promise(resolve => setTimeout(resolve, 200)); // 200ms delay
            }
        }
        
        connectionsCache = processedConnections;
        lastUpdate = new Date();
        
        // Store raw connection data for historical analysis
        global.rawConnectionData = allConnectionData;
        
        log(`Processed ${processedConnections.length} IP locations with ${allConnectionData.length} total connection records`);
        
        return processedConnections;
        
    } catch (error) {
        log(`Error loading connection data: ${error.message}`);
        return [];
    }
}

// Run comprehensive data collection
async function runDataCollection() {
    try {
        log('Running comprehensive data collection (all sources)...');
        const { stdout, stderr } = await execAsync(`${CONFIG.collectorScript} --all`);
        
        if (stderr && !stderr.includes('warning: setlocale')) {
            log(`Collection stderr: ${stderr}`);
        }
        
        log('Comprehensive data collection completed');
        
        // Reload processed data after a short delay
        setTimeout(() => {
            loadConnectionData();
        }, 3000);
        
    } catch (error) {
        log(`Error running data collection: ${error.message}`);
    }
}

// API Routes
app.get('/api/connections', async (req, res) => {
    try {
        // Get recent connections from database instead of loading all JSON files
        const recentConnections = await db.getHistoricalConnections({
            limit: 5000, // Limit to recent 5000 connections for map display
            orderBy: 'timestamp DESC'
        });
        
        // Process connections for map display (group by location)
        const locationMap = new Map();
        
        for (const conn of recentConnections) {
            if (conn.latitude && conn.longitude) {
                const key = `${conn.latitude},${conn.longitude}`;
                if (locationMap.has(key)) {
                    locationMap.get(key).connectionCount++;
                } else {
                    locationMap.set(key, {
                        ip: conn.ip,
                        country: conn.country,
                        region: conn.region,
                        city: conn.city,
                        latitude: parseFloat(conn.latitude),
                        longitude: parseFloat(conn.longitude),
                        connectionCount: 1,
                        lastSeen: conn.timestamp
                    });
                }
            }
        }
        
        const processedConnections = Array.from(locationMap.values());
        
        res.json({
            connections: processedConnections,
            lastUpdate: new Date(),
            totalConnections: processedConnections.length,
            homeLocation: CONFIG.homeLocation
        });
    } catch (error) {
        log(`Error serving connections: ${error.message}`);
        res.status(500).json({ error: 'Failed to load connection data' });
    }
});

// API endpoint for historical connection data with filtering
app.get('/api/connections/history', async (req, res) => {
    try {
        const { startDate, endDate, direction, limit = 1000 } = req.query;
        
        // Build SQL query with filters
        let query = `
            SELECT c.*, g.country, g.region, g.city, g.latitude, g.longitude, g.isp
            FROM connections c
            LEFT JOIN geolocations g ON c.ip = g.ip
        `;
        
        let whereConditions = [];
        let params = [];
        
        // Apply date filtering
        if (startDate) {
            whereConditions.push('datetime(c.timestamp) >= datetime(?)');
            params.push(startDate);
        }
        
        if (endDate) {
            whereConditions.push('datetime(c.timestamp) <= datetime(?)');
            params.push(endDate);
        }
        
        // Apply direction filtering
        if (direction && direction !== 'both') {
            whereConditions.push('c.direction = ?');
            params.push(direction);
        }
        
        if (whereConditions.length > 0) {
            query += ' WHERE ' + whereConditions.join(' AND ');
        }
        
        // Sort and limit
        query += ' ORDER BY c.timestamp DESC LIMIT ?';
        params.push(parseInt(limit));
        
        const rows = await new Promise((resolve, reject) => {
            db.db.all(query, params, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
        
        // Transform to match expected format
        const connections = rows.map(row => ({
            timestamp: row.timestamp,
            ip: row.ip,
            direction: row.direction,
            connection_type: row.connection_type,
            internal_ip: row.internal_ip,
            internal_port: row.internal_port,
            external_port: row.external_port,
            state: row.state,
            orig_packets: row.orig_packets,
            orig_bytes: row.orig_bytes,
            reply_packets: row.reply_packets,
            reply_bytes: row.reply_bytes,
            country: row.country,
            region: row.region,
            city: row.city,
            latitude: row.latitude,
            longitude: row.longitude,
            isp: row.isp,
            details: row.details
        }));
        
        // Get total count for the filtered query (without limit)
        let countQuery = `
            SELECT COUNT(*) as total
            FROM connections c
            LEFT JOIN geolocations g ON c.ip = g.ip
        `;
        
        if (whereConditions.length > 0) {
            countQuery += ' WHERE ' + whereConditions.join(' AND ');
        }
        
        const countResult = await new Promise((resolve, reject) => {
            db.db.get(countQuery, params.slice(0, -1), (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });
        
        res.json({
            connections: connections,
            totalCount: countResult.total,
            filteredCount: connections.length,
            filters: { startDate, endDate, direction, limit }
        });
        
    } catch (error) {
        log(`Error serving historical connections: ${error.message}`);
        res.status(500).json({ error: 'Failed to load historical connection data' });
    }
});

app.post('/api/refresh', async (req, res) => {
    try {
        await runDataCollection();
        res.json({ 
            success: true, 
            message: 'Data collection initiated',
            lastUpdate: lastUpdate
        });
    } catch (error) {
        log(`Error refreshing data: ${error.message}`);
        res.status(500).json({ error: 'Failed to refresh data' });
    }
});

// Hostname resolution API endpoint
app.get('/api/hostname/:ip', async (req, res) => {
    try {
        const ip = req.params.ip;
        if (!ip.match(/^\d+\.\d+\.\d+\.\d+$/)) {
            return res.status(400).json({ error: 'Invalid IP address format' });
        }
        
        const hostname = await resolveHostname(ip);
        res.json({ ip, hostname });
    } catch (error) {
        log(`Error resolving hostname for ${req.params.ip}: ${error.message}`);
        res.status(500).json({ error: 'Hostname resolution failed' });
    }
});

// API endpoint to get location information for an IP address
app.get('/api/location/:ip', async (req, res) => {
    try {
        const ip = req.params.ip;
        if (!ip.match(/^\d+\.\d+\.\d+\.\d+$/)) {
            return res.status(400).json({ error: 'Invalid IP address format' });
        }
        
        const locationData = await getIPLocation(ip);
        if (locationData) {
            res.json(locationData);
        } else {
            res.status(404).json({ error: 'Location data not found' });
        }
    } catch (error) {
        log(`Error getting location for ${req.params.ip}: ${error.message}`);
        res.status(500).json({ error: 'Location lookup failed' });
    }
});

// API endpoint for fast database-backed historical connections
app.get('/api/connections/history-fast', async (req, res) => {
    try {
        const { startDate, endDate, direction, limit = 1000 } = req.query;
        
        const filters = {
            startDate: startDate ? new Date(startDate).toISOString() : null,
            endDate: endDate ? new Date(endDate).toISOString() : null,
            direction: direction && direction !== 'both' ? direction : null,
            limit: parseInt(limit)
        };
        
        const connections = await db.getAggregatedConnections(filters);
        
        res.json({
            connections: connections,
            totalConnections: connections.length,
            lastUpdate: new Date().toISOString(),
            homeLocation: CONFIG.homeLocation,
            source: 'database',
            filters: filters
        });
        
    } catch (error) {
        log(`Error serving fast historical connections: ${error.message}`);
        res.status(500).json({ error: 'Failed to load historical connection data from database' });
    }
});

// API endpoint for database search
app.get('/api/connections/search', async (req, res) => {
    try {
        const { q: searchTerm, startDate, endDate, direction, limit = 1000 } = req.query;
        
        const filters = {
            startDate: startDate ? new Date(startDate).toISOString() : null,
            endDate: endDate ? new Date(endDate).toISOString() : null,
            direction: direction && direction !== 'both' ? direction : null,
            limit: parseInt(limit)
        };
        
        const connections = await db.searchConnections(searchTerm, filters);
        
        res.json({
            connections: connections,
            totalConnections: connections.length,
            searchTerm: searchTerm || '',
            lastUpdate: new Date().toISOString(),
            homeLocation: CONFIG.homeLocation,
            source: 'database',
            filters: filters
        });
        
    } catch (error) {
        log(`Error in database search: ${error.message}`);
        res.status(500).json({ error: 'Failed to search database' });
    }
});

app.get('/api/status', (req, res) => {
    res.json({
        status: 'running',
        lastUpdate: lastUpdate,
        connectionsCount: connectionsCache.length,
        uptime: process.uptime(),
        port: PORT
    });
});

// API endpoint for database statistics
app.get('/api/stats', async (req, res) => {
    try {
        const stats = await db.getStats();
        const dbSizeMB = await db.getDatabaseSizeMB();
        
        res.json({
            database: {
                ...stats,
                size_mb: dbSizeMB
            },
            cache: {
                connections: connectionsCache.length,
                geolocations: geolocationCache.size
            },
            system: {
                uptime: process.uptime(),
                memory: process.memoryUsage(),
                lastUpdate: lastUpdate
            }
        });
    } catch (error) {
        log(`Error getting database stats: ${error.message}`);
        res.status(500).json({ error: 'Failed to get database statistics', details: error.message });
    }
});

// API endpoint to manually run retention policies
app.post('/api/retention/run', async (req, res) => {
    try {
        log('Manual retention policy run requested via API');
        const results = await db.runRetentionPolicies();
        res.json({
            success: true,
            results: results,
            message: `Cleaned up ${results.aged + results.sized + results.geolocations} total records`
        });
    } catch (error) {
        log(`Error running manual retention policies: ${error.message}`);
        res.status(500).json({ error: 'Failed to run retention policies', details: error.message });
    }
});

// API endpoint to get retention policy configuration
app.get('/api/retention/config', (req, res) => {
    res.json({
        config: db.retentionConfig,
        currentSizeMB: null // Will be populated if database is initialized
    });
});

// API endpoint to update retention policy configuration
app.put('/api/retention/config', (req, res) => {
    try {
        const { maxSizeMB, maxAgeDays, enableSizeLimit, enableTimeLimit } = req.body;
        
        if (maxSizeMB && maxSizeMB > 0) db.retentionConfig.maxSizeMB = maxSizeMB;
        if (maxAgeDays && maxAgeDays > 0) db.retentionConfig.maxAgeDays = maxAgeDays;
        if (enableSizeLimit !== undefined) db.retentionConfig.enableSizeLimit = enableSizeLimit;
        if (enableTimeLimit !== undefined) db.retentionConfig.enableTimeLimit = enableTimeLimit;
        
        log(`Retention config updated: ${JSON.stringify(db.retentionConfig)}`);
        res.json({ success: true, config: db.retentionConfig });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update retention config', details: error.message });
    }
});

// Serve main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Schedule automatic data collection every 2 minutes for real-time monitoring
cron.schedule('*/2 * * * *', () => {
    log('Scheduled comprehensive data collection starting...');
    runDataCollection();
});

// Skip initial JSON data load - now using database directly
log('Using database for connection data (skipping JSON file loading)');

// Initialize server
async function initializeServer() {
    // Initialize database
    try {
        await db.init();
        log('Database initialized successfully');
    } catch (error) {
        log(`Warning: Database initialization failed: ${error.message}`);
        log('Historical data will fall back to JSON files');
    }
    
    // Load geolocation cache
    await loadGeolocationCache();
    
    // Schedule periodic cache saves (every 5 minutes)
    cron.schedule('*/5 * * * *', () => {
        saveGeolocationCache();
    });
    
    // Schedule database retention policies (every 30 minutes)
    cron.schedule('*/30 * * * *', async () => {
        try {
            log('Running database retention policies...');
            const results = await db.runRetentionPolicies();
            log(`Retention completed: ${results.aged} aged, ${results.sized} oversized, ${results.geolocations} orphaned geo records removed`);
        } catch (error) {
            log(`Error running retention policies: ${error.message}`);
        }
    });
    
    // Start server
    app.listen(PORT, '0.0.0.0', () => {
        log(`Firewalla IP Monitor server running on http://0.0.0.0:${PORT}`);
        log(`Access via: http://localhost:${PORT} or http://[your-ip]:${PORT}`);
        log('Scheduled comprehensive data collection every 2 minutes');
        log('Scheduled geolocation cache saves every 5 minutes');
        log(`Scheduled database retention policies every 30 minutes (${db.retentionConfig.maxAgeDays}d/${db.retentionConfig.maxSizeMB}MB limits)`);
    });
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
    log('Shutting down server...');
    await saveGeolocationCache();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    log('Shutting down server...');
    await saveGeolocationCache();
    process.exit(0);
});

// Start the server
initializeServer().catch(error => {
    log(`Error initializing server: ${error.message}`);
    process.exit(1);
});