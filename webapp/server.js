const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const cors = require('cors');
const cron = require('node-cron');
const { exec } = require('child_process');
const { promisify } = require('util');
const dns = require('dns').promises;

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
    geoServiceUrl: 'http://ip-api.com/json/' // Free IP geolocation service
};

// In-memory cache for processed data
let connectionsCache = [];
let lastUpdate = new Date();

// Hostname resolution cache
const hostnameCache = new Map();

// Logging function
const log = (message) => {
    console.log(`[${new Date().toISOString()}] ${message}`);
};

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
    try {
        const axios = require('axios');
        const response = await axios.get(`${CONFIG.geoServiceUrl}${ip}?fields=status,country,countryCode,region,regionName,city,lat,lon,timezone,isp,org,as,query`);
        
        if (response.data.status === 'success') {
            return {
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
                asn: response.data.as
            };
        }
    } catch (error) {
        log(`Error getting location for IP ${ip}: ${error.message}`);
    }
    
    return null;
}

// Filter for truly external IPs
function isExternalIP(ip) {
    if (!ip || !ip.match(/^\d+\.\d+\.\d+\.\d+$/)) return false;
    
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
function extractIPsFromData(data, dataType) {
    const ips = [];
    
    if (!Array.isArray(data)) return ips;
    
    data.forEach(item => {
        try {
            switch (dataType) {
                case 'connections':
                    if (item.external_ip) {
                        ips.push({
                            ip: item.external_ip,
                            timestamp: item.timestamp,
                            type: 'firemain_log',
                            details: `Connection from ${item.internal_ip}`
                        });
                    }
                    break;
                
                case 'current_connections':
                    // For netstat data, we want the remote IP (not our WAN IP)
                    let actualExternalIP = null;
                    if (item.local_ip && item.external_ip) {
                        // If external_ip is our WAN IP, then local_ip is actually the external one
                        if (item.external_ip === '104.0.40.169') {
                            actualExternalIP = item.local_ip;
                        } else {
                            actualExternalIP = item.external_ip;
                        }
                        
                        if (actualExternalIP && isExternalIP(actualExternalIP)) {
                            ips.push({
                                ip: actualExternalIP,
                                timestamp: item.timestamp,
                                type: 'active_connection',
                                details: `${item.state} connection on port ${item.local_port || item.external_port}`
                            });
                        }
                    }
                    break;
                
                case 'scans_probes':
                    // Extract IPs from log entries
                    const logEntry = item.log_entry || '';
                    const ipMatches = logEntry.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g);
                    if (ipMatches) {
                        ipMatches.forEach(ip => {
                            if (isExternalIP(ip)) {
                                ips.push({
                                    ip: ip,
                                    timestamp: item.timestamp,
                                    type: item.type || 'scan_probe',
                                    details: logEntry.substring(0, 100)
                                });
                            }
                        });
                    }
                    break;
                
                case 'realtime_connections':
                    // Extract IPs from netstat/ss data
                    const data_entry = item.data || '';
                    const realtimeIPs = data_entry.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g);
                    if (realtimeIPs) {
                        realtimeIPs.forEach(ip => {
                            if (isExternalIP(ip)) {
                                ips.push({
                                    ip: ip,
                                    timestamp: item.timestamp,
                                    type: item.type || 'realtime',
                                    details: data_entry.substring(0, 100)
                                });
                            }
                        });
                    }
                    break;
                
                case 'vpn_connections':
                    // Extract IPs from VPN connection data
                    if (item.external_ip && isExternalIP(item.external_ip)) {
                        ips.push({
                            ip: item.external_ip,
                            timestamp: item.timestamp,
                            type: item.type || 'vpn',
                            details: `VPN endpoint on port ${item.external_port}`
                        });
                    }
                    break;
            }
        } catch (error) {
            // Skip malformed entries
            log(`Error processing ${dataType} entry: ${error.message}`);
        }
    });
    
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
            'vpn_connections_': []
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
        
        for (const [prefix, files] of Object.entries(fileTypes)) {
            if (files.length > 0) {
                const latestFile = files.sort().pop(); // Get most recent
                const filePath = path.join(CONFIG.dataDir, latestFile);
                const dataType = prefix.replace(/_$/, ''); // Remove only trailing underscore
                
                try {
                    log(`Loading ${dataType} from: ${latestFile}`);
                    const data = await fs.readFile(filePath, 'utf8');
                    const parsedData = JSON.parse(data);
                    // log(`Debug: Processing dataType '${dataType}' with ${parsedData.length} records`);
                    const extractedIPs = extractIPsFromData(parsedData, dataType);
                    allConnectionData.push(...extractedIPs);
                    log(`Extracted ${extractedIPs.length} IPs from ${dataType}`);
                } catch (error) {
                    log(`Error reading ${dataType} file ${latestFile}: ${error.message}`);
                }
            }
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
                const ipConnections = ipGroups[ip];
                const connectionCount = ipConnections.length;
                const lastSeen = ipConnections
                    .map(conn => new Date(conn.timestamp))
                    .sort((a, b) => b - a)[0];
                
                // Resolve hostname for this IP
                const hostname = await resolveHostname(ip);
                
                processedConnections.push({
                    ...location,
                    hostname: hostname,
                    connectionCount,
                    lastSeen: lastSeen ? lastSeen.toISOString() : new Date().toISOString(),
                    connectionTypes: [...new Set(ipConnections.map(c => c.type))],
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
        log(`Processed ${processedConnections.length} IP locations with hostnames`);
        
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
        if (connectionsCache.length === 0) {
            await loadConnectionData();
        }
        
        res.json({
            connections: connectionsCache,
            lastUpdate: lastUpdate,
            totalConnections: connectionsCache.length
        });
    } catch (error) {
        log(`Error serving connections: ${error.message}`);
        res.status(500).json({ error: 'Failed to load connection data' });
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

app.get('/api/status', (req, res) => {
    res.json({
        status: 'running',
        lastUpdate: lastUpdate,
        connectionsCount: connectionsCache.length,
        uptime: process.uptime(),
        port: PORT
    });
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

// Initial data load
loadConnectionData().then(() => {
    log('Initial data load completed');
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    log(`Firewalla IP Monitor server running on http://0.0.0.0:${PORT}`);
    log(`Access via: http://unifi.mf:${PORT} or http://192.168.86.1:${PORT}`);
    log('Scheduled comprehensive data collection every 2 minutes');
});