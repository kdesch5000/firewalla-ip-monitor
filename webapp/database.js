const { Pool } = require('pg');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

class ConnectionsDatabase {
    constructor(options = {}) {
        // PostgreSQL connection configuration
        this.pool = new Pool({
            user: options.user || 'firewalla_user',
            host: options.host || 'localhost',
            database: options.database || 'firewalla_monitor',
            password: options.password || 'firewalla123',
            port: options.port || 5432,
            max: 20, // Maximum number of clients in the pool
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 2000,
        });
        
        this.isInitialized = false;
        
        // Retention policies configuration
        this.retentionConfig = {
            maxSizeMB: options.maxSizeMB || 3000, // 3GB max database size
            maxAgeDays: options.maxAgeDays || 7, // 7 days retention (reduced from 30)
            cleanupBatchSize: options.cleanupBatchSize || 50000, // Records to delete per batch
            enableSizeLimit: options.enableSizeLimit !== false,
            enableTimeLimit: options.enableTimeLimit !== false
        };

        // Tracking for data reduction strategies
        this.recentListeningPorts = new Map();
        this.highVolumeIPs = new Set(['0.0.0.0', '8.8.8.8', '3.12.68.8', '15.197.187.26', '3.33.190.236']);
        this.listeningPortCleanupInterval = setInterval(() => {
            this.recentListeningPorts.clear();
        }, 3600000);
        
        // Email notification configuration
        this.emailConfig = {
            enabled: options.enableEmailNotifications !== false,
            recipient: options.emailRecipient || 'admin@example.com'
        };
        
        // Handle pool errors
        this.pool.on('error', (err) => {
            console.error('PostgreSQL pool error:', err);
        });
    }

    // Initialize database connection
    async init() {
        try {
            // Test connection
            const client = await this.pool.connect();
            console.log(`Connected to PostgreSQL database`);
            client.release();
            this.isInitialized = true;
        } catch (err) {
            console.error('Error connecting to PostgreSQL:', err.message);
            throw err;
        }
    }

    // Close database connections
    async close() {
        if (this.listeningPortCleanupInterval) {
            clearInterval(this.listeningPortCleanupInterval);
        }
        await this.pool.end();
    }

    // Insert connections into database
    async insertConnections(connections) {
        if (!connections || connections.length === 0) return 0;
        
        const client = await this.pool.connect();
        let insertCount = 0;
        
        try {
            await client.query('BEGIN');
            
            const insertQuery = `
                INSERT INTO connections (
                    ip, timestamp, direction, connection_type, internal_ip, 
                    internal_port, external_port, state, orig_packets, orig_bytes,
                    reply_packets, reply_bytes, details, source_file
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                ON CONFLICT (ip, timestamp, direction, internal_ip, external_port) 
                DO NOTHING
            `;
            
            for (const conn of connections) {
                try {
                    const result = await client.query(insertQuery, [
                        conn.ip,
                        conn.timestamp,
                        conn.direction,
                        conn.connection_type,
                        conn.internal_ip,
                        conn.internal_port,
                        conn.external_port,
                        conn.state,
                        conn.orig_packets || 0,
                        conn.orig_bytes || 0,
                        conn.reply_packets || 0,
                        conn.reply_bytes || 0,
                        conn.details,
                        conn.source_file
                    ]);
                    insertCount++;
                } catch (err) {
                    if (!err.message.includes('duplicate key')) {
                        console.error('Error inserting connection:', err.message);
                    }
                }
            }
            
            await client.query('COMMIT');
            
        } catch (err) {
            await client.query('ROLLBACK');
            console.error('Transaction failed:', err.message);
            throw err;
        } finally {
            client.release();
        }
        
        return insertCount;
    }

    // Alias for insertConnections (for backward compatibility)
    async insertConnectionsAggregated(connections) {
        return await this.insertConnections(connections);
    }

    // Get recent connections for API
    async getRecentConnections(options = {}) {
        const limit = options.limit || 5000;
        const offset = options.offset || 0;
        
        const query = `
            SELECT ip, timestamp, direction, connection_type, internal_ip,
                   internal_port, external_port, state, orig_packets, orig_bytes,
                   reply_packets, reply_bytes, details
            FROM connections
            ORDER BY timestamp DESC
            LIMIT $1 OFFSET $2
        `;
        
        try {
            const result = await this.pool.query(query, [limit, offset]);
            return result.rows;
        } catch (err) {
            console.error('Error getting recent connections:', err.message);
            return [];
        }
    }

    // Get historical connections with filters (includes geolocation data)
    async getHistoricalConnections(options = {}) {
        const limit = options.limit || 5000;
        const orderBy = options.orderBy || 'timestamp DESC';
        const filters = options.filters || {};
        
        // Join with geolocations table to include lat/lng for map display
        let query = `
            SELECT c.*, g.country, g.country_code, g.region, g.city, 
                   g.latitude, g.longitude, g.timezone, g.isp, g.org, g.asn, g.hostname
            FROM connections c
            LEFT JOIN geolocations g ON c.ip = g.ip
        `;
        const queryParams = [];
        const whereClauses = [];
        
        // Always exclude invalid/internal IP addresses
        whereClauses.push(`c.ip != '0.0.0.0'`);
        whereClauses.push(`c.ip IS NOT NULL`);
        
        // Add filters
        if (filters.direction) {
            whereClauses.push(`c.direction = $${queryParams.length + 1}`);
            queryParams.push(filters.direction);
        }
        
        if (filters.ip) {
            whereClauses.push(`c.ip = $${queryParams.length + 1}`);
            queryParams.push(filters.ip);
        }
        
        if (filters.startDate) {
            whereClauses.push(`c.timestamp >= $${queryParams.length + 1}`);
            queryParams.push(filters.startDate);
        }
        
        if (filters.endDate) {
            whereClauses.push(`c.timestamp <= $${queryParams.length + 1}`);
            queryParams.push(filters.endDate);
        }
        
        if (whereClauses.length > 0) {
            query += ' WHERE ' + whereClauses.join(' AND ');
        }
        
        // Replace 'timestamp' with 'c.timestamp' in ORDER BY
        const orderByFixed = orderBy.replace('timestamp', 'c.timestamp');
        query += ` ORDER BY ${orderByFixed} LIMIT $${queryParams.length + 1}`;
        queryParams.push(limit);
        
        try {
            const result = await this.pool.query(query, queryParams);
            return result.rows;
        } catch (err) {
            console.error('Error getting historical connections:', err.message);
            return [];
        }
    }

    // Get database statistics (optimized for PostgreSQL)
    async getStats() {
        const queries = {
            total_connections: 'SELECT COUNT(*) as total_connections FROM connections',
            unique_ips: 'SELECT COUNT(DISTINCT ip) as unique_ips FROM connections',
            cached_geolocations: 'SELECT COUNT(*) as cached_geolocations FROM geolocations',
            date_range: 'SELECT MIN(timestamp) as oldest_record, MAX(timestamp) as newest_record FROM connections'
        };

        const results = {};
        
        try {
            // Run queries with reasonable timeouts
            const promises = Object.entries(queries).map(async ([key, query]) => {
                try {
                    const result = await this.pool.query(query);
                    if (key === 'date_range') {
                        results.oldest_record = result.rows[0]?.oldest_record;
                        results.newest_record = result.rows[0]?.newest_record;
                    } else {
                        Object.assign(results, result.rows[0]);
                    }
                } catch (err) {
                    console.error(`Error in stats query ${key}:`, err.message);
                    if (key === 'date_range') {
                        results.oldest_record = 'Error';
                        results.newest_record = 'Error';
                    } else {
                        results[key.split(' as ')[1]] = 'Error';
                    }
                }
            });
            
            await Promise.all(promises);
            
        } catch (error) {
            console.error('Error getting database stats:', error.message);
            return {
                total_connections: 'Error',
                unique_ips: 'Error',
                cached_geolocations: 'Error',
                oldest_record: 'Error',
                newest_record: 'Error'
            };
        }
        
        return results;
    }

    // Get database size (PostgreSQL specific)
    async getDatabaseSizeMB() {
        try {
            const query = `
                SELECT pg_size_pretty(pg_database_size('firewalla_monitor')) as size_pretty,
                       pg_database_size('firewalla_monitor') / (1024 * 1024) as size_mb
            `;
            const result = await this.pool.query(query);
            return Math.round(result.rows[0]?.size_mb * 100) / 100;
        } catch (error) {
            console.warn('Could not get database size:', error.message);
            return 0;
        }
    }

    // Cleanup old records by age
    async cleanupByAge() {
        if (!this.retentionConfig.enableTimeLimit) return 0;

        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - this.retentionConfig.maxAgeDays);
        const maxAgeDays = this.retentionConfig.maxAgeDays;

        try {
            const result = await this.pool.query(
                'DELETE FROM connections WHERE timestamp < $1',
                [cutoffDate.toISOString()]
            );
            
            const deletedRows = result.rowCount;
            if (deletedRows > 0) {
                console.log(`🧹 Cleaned up ${deletedRows} connections older than ${maxAgeDays} days`);
            }
            return deletedRows;
        } catch (error) {
            console.error('Error cleaning up by age:', error.message);
            return 0;
        }
    }

    // Cleanup by database size
    async cleanupBySize() {
        if (!this.retentionConfig.enableSizeLimit) return 0;

        try {
            const sizeMB = await this.getDatabaseSizeMB();
            if (sizeMB <= this.retentionConfig.maxSizeMB) return 0;

            // Delete oldest records in batches until under size limit
            const batchSize = this.retentionConfig.cleanupBatchSize;
            let totalDeleted = 0;
            
            while (await this.getDatabaseSizeMB() > this.retentionConfig.maxSizeMB) {
                const result = await this.pool.query(`
                    DELETE FROM connections 
                    WHERE id IN (
                        SELECT id FROM connections 
                        ORDER BY timestamp ASC 
                        LIMIT $1
                    )
                `, [batchSize]);
                
                const deleted = result.rowCount;
                totalDeleted += deleted;
                
                if (deleted < batchSize) break; // No more records to delete
            }

            if (totalDeleted > 0) {
                console.log(`🧹 Cleaned up ${totalDeleted} connections to maintain ${this.retentionConfig.maxSizeMB}MB size limit`);
            }
            return totalDeleted;
        } catch (error) {
            console.error('Error cleaning up by size:', error.message);
            return 0;
        }
    }

    // Geolocation methods
    async insertGeolocation(ip, geoData) {
        try {
            const query = `
                INSERT INTO geolocations (
                    ip, country, country_code, region, city, 
                    latitude, longitude, timezone, isp, org, asn, hostname
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                ON CONFLICT (ip) DO UPDATE SET
                    country = EXCLUDED.country,
                    country_code = EXCLUDED.country_code,
                    region = EXCLUDED.region,
                    city = EXCLUDED.city,
                    latitude = EXCLUDED.latitude,
                    longitude = EXCLUDED.longitude,
                    timezone = EXCLUDED.timezone,
                    isp = EXCLUDED.isp,
                    org = EXCLUDED.org,
                    asn = EXCLUDED.asn,
                    hostname = EXCLUDED.hostname,
                    last_updated = NOW()
            `;
            
            await this.pool.query(query, [
                ip, geoData.country, geoData.country_code, geoData.region,
                geoData.city, geoData.latitude, geoData.longitude, geoData.timezone,
                geoData.isp, geoData.org, geoData.asn, geoData.hostname
            ]);
        } catch (error) {
            console.error('Error inserting geolocation:', error.message);
        }
    }

    async getGeolocation(ip) {
        try {
            const result = await this.pool.query('SELECT * FROM geolocations WHERE ip = $1', [ip]);
            return result.rows[0] || null;
        } catch (error) {
            console.error('Error getting geolocation:', error.message);
            return null;
        }
    }

    async getAllGeolocations() {
        try {
            const result = await this.pool.query('SELECT * FROM geolocations ORDER BY last_updated DESC');
            return result.rows;
        } catch (error) {
            console.error('Error getting all geolocations:', error.message);
            return [];
        }
    }

    // Alias for insertGeolocation (for backward compatibility)
    async upsertGeolocation(ip, geoData) {
        return await this.insertGeolocation(ip, geoData);
    }

    // Get aggregated connections for connection list view
    async getAggregatedConnections(filters = {}) {
        const limit = filters.limit || 1000;
        const orderBy = 'c.timestamp DESC';
        
        // Use optimized query with subquery to limit data first, then aggregate
        let query = `
            WITH recent_connections AS (
                SELECT c.ip, c.direction, c.timestamp
                FROM connections c
                WHERE 1=1
        `;
        
        const queryParams = [];
        const whereClauses = [];
        
        // Always exclude invalid/internal IP addresses in subquery
        whereClauses.push(`c.ip != '0.0.0.0'`);
        whereClauses.push(`c.ip IS NOT NULL`);
        
        // Add time range filters to subquery for better performance
        if (filters.startDate) {
            whereClauses.push(`c.timestamp >= $${queryParams.length + 1}`);
            queryParams.push(filters.startDate);
        }
        
        if (filters.endDate) {
            whereClauses.push(`c.timestamp <= $${queryParams.length + 1}`);
            queryParams.push(filters.endDate);
        }
        
        if (filters.direction) {
            whereClauses.push(`c.direction = $${queryParams.length + 1}`);
            queryParams.push(filters.direction);
        }
        
        // Add WHERE clauses to subquery
        if (whereClauses.length > 0) {
            query = query.replace('WHERE 1=1', 'WHERE ' + whereClauses.join(' AND '));
        }
        
        // Complete the CTE and main query - don't limit raw connections, let grouping happen first
        query += `
                ORDER BY c.timestamp DESC
            )
            SELECT 
                rc.ip,
                g.hostname,
                g.country, g.region, g.city,
                g.latitude, g.longitude, g.country_code,
                g.isp, g.org, g.asn, g.timezone,
                COUNT(*) as connection_count,
                COUNT(CASE WHEN rc.direction = 'inbound' THEN 1 END) as inbound_count,
                COUNT(CASE WHEN rc.direction = 'outbound' THEN 1 END) as outbound_count,
                MAX(rc.timestamp) as last_seen,
                STRING_AGG(DISTINCT rc.direction, ', ') as directions
            FROM recent_connections rc
            LEFT JOIN geolocations g ON rc.ip = g.ip
            GROUP BY rc.ip, g.hostname, g.country, g.region, g.city, g.latitude, g.longitude, g.country_code, g.isp, g.org, g.asn, g.timezone
            ORDER BY last_seen DESC 
            LIMIT $${queryParams.length + 1}
        `;
        
        queryParams.push(limit);
        
        try {
            const result = await this.pool.query(query, queryParams);
            return result.rows.map(row => ({
                ip: row.ip,
                hostname: row.hostname || 'No hostname found',
                location: `${row.city || ''}, ${row.region || ''}, ${row.country || ''}`.replace(/(^, |, $)/g, '').replace(/, ,/g, ', ').trim() || 'Unknown',
                country: row.country || 'Unknown',
                region: row.region || 'Unknown', 
                city: row.city || 'Unknown',
                latitude: parseFloat(row.latitude) || 0,
                longitude: parseFloat(row.longitude) || 0,
                countryCode: row.country_code || 'XX',
                isp: row.isp || 'Unknown ISP',
                org: row.org || 'Unknown Org',
                asn: row.asn || 'Unknown ASN',
                timezone: row.timezone,
                connectionCount: parseInt(row.connection_count),
                inboundCount: parseInt(row.inbound_count || 0),
                outboundCount: parseInt(row.outbound_count || 0),
                lastSeen: row.last_seen,
                directions: row.directions
            }));
        } catch (err) {
            console.error('Error getting aggregated connections:', err.message);
            return [];
        }
    }

    // Search connections with text search functionality
    async searchConnections(searchTerm, filters = {}) {
        const limit = filters.limit || 1000;
        
        // Base query similar to getAggregatedConnections but optimized for search
        let query = `
            SELECT 
                c.ip,
                g.hostname,
                g.country, g.region, g.city,
                g.latitude, g.longitude, g.country_code,
                g.isp, g.org, g.asn, g.timezone,
                COUNT(*) as connection_count,
                COUNT(CASE WHEN c.direction = 'inbound' THEN 1 END) as inbound_count,
                COUNT(CASE WHEN c.direction = 'outbound' THEN 1 END) as outbound_count,
                MAX(c.timestamp) as last_seen,
                STRING_AGG(DISTINCT c.direction, ', ') as directions
            FROM connections c
            LEFT JOIN geolocations g ON c.ip = g.ip
        `;
        
        const queryParams = [];
        const whereClauses = [];
        
        // Always exclude invalid/internal IP addresses
        whereClauses.push(`c.ip != '0.0.0.0'`);
        whereClauses.push(`c.ip IS NOT NULL`);
        
        // Add search term filtering if provided
        if (searchTerm && searchTerm.trim().length > 0) {
            const term = searchTerm.trim();
            whereClauses.push(`(
                c.ip::text ILIKE $${queryParams.length + 1} OR
                g.hostname ILIKE $${queryParams.length + 1} OR
                g.city ILIKE $${queryParams.length + 1} OR
                g.country ILIKE $${queryParams.length + 1} OR
                g.region ILIKE $${queryParams.length + 1} OR
                g.isp ILIKE $${queryParams.length + 1} OR
                g.org ILIKE $${queryParams.length + 1}
            )`);
            queryParams.push(`%${term}%`);
        }
        
        // Add time range filters
        if (filters.startDate) {
            whereClauses.push(`c.timestamp >= $${queryParams.length + 1}`);
            queryParams.push(filters.startDate);
        }
        
        if (filters.endDate) {
            whereClauses.push(`c.timestamp <= $${queryParams.length + 1}`);
            queryParams.push(filters.endDate);
        }
        
        if (filters.direction) {
            whereClauses.push(`c.direction = $${queryParams.length + 1}`);
            queryParams.push(filters.direction);
        }
        
        if (whereClauses.length > 0) {
            query += ' WHERE ' + whereClauses.join(' AND ');
        }
        
        query += ` 
            GROUP BY c.ip, g.hostname, g.country, g.region, g.city, g.latitude, g.longitude, g.country_code, g.isp, g.org, g.asn, g.timezone
            ORDER BY last_seen DESC 
            LIMIT $${queryParams.length + 1}
        `;
        queryParams.push(limit);
        
        try {
            const result = await this.pool.query(query, queryParams);
            return result.rows.map(row => ({
                ip: row.ip,
                hostname: row.hostname || 'No hostname found',
                location: `${row.city || ''}, ${row.region || ''}, ${row.country || ''}`.replace(/(^, |, $)/g, '').replace(/, ,/g, ', ').trim() || 'Unknown',
                country: row.country || 'Unknown',
                region: row.region || 'Unknown', 
                city: row.city || 'Unknown',
                latitude: parseFloat(row.latitude) || 0,
                longitude: parseFloat(row.longitude) || 0,
                countryCode: row.country_code || 'XX',
                isp: row.isp || 'Unknown ISP',
                org: row.org || 'Unknown Org',
                asn: row.asn || 'Unknown ASN',
                timezone: row.timezone,
                connectionCount: parseInt(row.connection_count),
                inboundCount: parseInt(row.inbound_count || 0),
                outboundCount: parseInt(row.outbound_count || 0),
                lastSeen: row.last_seen,
                directions: row.directions
            }));
        } catch (err) {
            console.error('Error searching connections:', err.message);
            return [];
        }
    }

    // Threat intelligence methods
    async insertThreatIntel(ip, threatData) {
        try {
            const query = `
                INSERT INTO threat_intel (
                    ip, virustotal_reputation, virustotal_total, virustotal_categories,
                    abuseipdb_confidence, abuseipdb_usage_type, abuseipdb_total_reports,
                    abuseipdb_categories, threat_level
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                ON CONFLICT (ip) DO UPDATE SET
                    virustotal_reputation = EXCLUDED.virustotal_reputation,
                    virustotal_total = EXCLUDED.virustotal_total,
                    virustotal_categories = EXCLUDED.virustotal_categories,
                    abuseipdb_confidence = EXCLUDED.abuseipdb_confidence,
                    abuseipdb_usage_type = EXCLUDED.abuseipdb_usage_type,
                    abuseipdb_total_reports = EXCLUDED.abuseipdb_total_reports,
                    abuseipdb_categories = EXCLUDED.abuseipdb_categories,
                    threat_level = EXCLUDED.threat_level,
                    last_checked = NOW()
            `;
            
            await this.pool.query(query, [
                ip,
                threatData.virustotal_reputation,
                threatData.virustotal_total,
                JSON.stringify(threatData.virustotal_categories),
                threatData.abuseipdb_confidence,
                threatData.abuseipdb_usage_type,
                threatData.abuseipdb_total_reports,
                JSON.stringify(threatData.abuseipdb_categories),
                threatData.threat_level
            ]);
        } catch (error) {
            console.error('Error inserting threat intel:', error.message);
        }
    }

    async getThreatIntel(ip) {
        try {
            const result = await this.pool.query('SELECT * FROM threat_intel WHERE ip = $1', [ip]);
            return result.rows[0] || null;
        } catch (error) {
            console.error('Error getting threat intel:', error.message);
            return null;
        }
    }

    // Alias for insertThreatIntel (for backward compatibility)
    async upsertThreatIntel(ip, threatData) {
        return await this.insertThreatIntel(ip, threatData);
    }

    async getIPsNeedingThreatCheck(limit = 50) {
        try {
            // Tiered approach: Priority 1 (Unknown IPs - 7 days), Priority 2 (Cloud IPs - 30 days)
            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            
            // First priority: Unknown/suspicious IPs (non-cloud) - scan every 7 days
            const unknownQuery = `
                SELECT DISTINCT c.ip
                FROM connections c
                LEFT JOIN threat_intel t ON c.ip = t.ip
                WHERE c.timestamp > $1 
                AND (t.ip IS NULL OR t.last_checked < $2)
                AND c.ip != '0.0.0.0'
                AND c.ip::text NOT LIKE '192.168.%'
                AND c.ip::text NOT LIKE '10.%'
                AND c.ip::text NOT LIKE '172.16.%'
                AND c.ip::text NOT LIKE '172.17.%'
                AND c.ip::text NOT LIKE '172.18.%'
                AND c.ip::text NOT LIKE '172.19.%'
                AND c.ip::text NOT LIKE '172.2%'
                AND c.ip::text NOT LIKE '172.30.%'
                AND c.ip::text NOT LIKE '172.31.%'
                AND c.ip::text NOT LIKE '3.%'         -- AWS
                AND c.ip::text NOT LIKE '34.%'        -- Google Cloud
                AND c.ip::text NOT LIKE '52.%'        -- Microsoft Azure
                AND c.ip::text NOT LIKE '54.%'        -- AWS
                AND c.ip::text NOT LIKE '8.8.8.%'     -- Google DNS
                AND c.ip::text NOT LIKE '8.8.4.%'     -- Google DNS
                AND c.ip::text NOT LIKE '216.239.%'   -- Google
                AND c.ip::text NOT LIKE '17.%'        -- Apple
                LIMIT $3
            `;
            
            // Second priority: Cloud provider IPs - scan every 30 days (longer cache)
            const cloudQuery = `
                SELECT DISTINCT c.ip
                FROM connections c
                LEFT JOIN threat_intel t ON c.ip = t.ip
                WHERE c.timestamp > $1 
                AND (t.ip IS NULL OR t.last_checked < $2)
                AND (c.ip::text LIKE '3.%' OR c.ip::text LIKE '34.%' OR c.ip::text LIKE '52.%' OR c.ip::text LIKE '54.%' 
                     OR c.ip::text LIKE '8.8.8.%' OR c.ip::text LIKE '8.8.4.%' OR c.ip::text LIKE '216.239.%' OR c.ip::text LIKE '17.%')
                LIMIT $3
            `;
            
            // Try unknown IPs first
            const unknownResult = await this.pool.query(unknownQuery, [sevenDaysAgo, sevenDaysAgo, limit]);
            
            if (unknownResult.rows.length > 0) {
                console.log(`Found ${unknownResult.rows.length} unknown/suspicious IPs for threat intel scanning`);
                return unknownResult.rows.map(row => row.ip);
            }
            
            // If no unknown IPs, check cloud IPs
            const cloudResult = await this.pool.query(cloudQuery, [sevenDaysAgo, thirtyDaysAgo, limit]);
            
            if (cloudResult.rows.length > 0) {
                console.log(`Found ${cloudResult.rows.length} cloud provider IPs for threat intel scanning (30-day cache)`);
                return cloudResult.rows.map(row => row.ip);
            }
            
            console.log('No IPs need threat intelligence refresh');
            return [];
            
        } catch (error) {
            console.error('Error getting IPs needing threat check:', error.message);
            return [];
        }
    }

    async getThreatIntelStatus() {
        try {
            // Get the real total from header stats (matches the 1,679 display)
            const totalUniqueQuery = `
                SELECT COUNT(DISTINCT ip) as count
                FROM connections 
                WHERE timestamp > NOW() - INTERVAL '7 days'
                AND ip != '0.0.0.0'
                AND ip::text NOT LIKE '192.168.%'
                AND ip::text NOT LIKE '10.%'
                AND ip::text NOT LIKE '172.%'
            `;

            // Count IPs that have been scanned (have threat intel data)
            const scannedQuery = `
                SELECT COUNT(DISTINCT t.ip) as count
                FROM threat_intel t
                INNER JOIN connections c ON t.ip = c.ip
                WHERE c.timestamp > NOW() - INTERVAL '7 days'
                AND t.last_checked IS NOT NULL
                AND c.ip != '0.0.0.0'
                AND c.ip::text NOT LIKE '192.168.%'
                AND c.ip::text NOT LIKE '10.%'
                AND c.ip::text NOT LIKE '172.%'
            `;

            // Get last scan time and count of IPs updated since then
            const lastScanQuery = `
                SELECT MAX(last_checked) as last_scan
                FROM threat_intel
            `;

            const [totalResult, scannedResult, lastScanResult] = await Promise.all([
                this.pool.query(totalUniqueQuery),
                this.pool.query(scannedQuery),
                this.pool.query(lastScanQuery)
            ]);

            const total = parseInt(totalResult.rows[0].count) || 0;
            const scanned = parseInt(scannedResult.rows[0].count) || 0;
            const pending = total - scanned;
            const lastScan = lastScanResult.rows[0].last_scan;

            // Count IPs updated since last scan
            let recentlyUpdated = 0;
            if (lastScan) {
                const recentQuery = `
                    SELECT COUNT(DISTINCT t.ip) as count
                    FROM threat_intel t
                    INNER JOIN connections c ON t.ip = c.ip
                    WHERE c.timestamp > NOW() - INTERVAL '7 days'
                    AND t.last_checked > $1
                    AND c.ip != '0.0.0.0'
                    AND c.ip::text NOT LIKE '192.168.%'
                    AND c.ip::text NOT LIKE '10.%'
                    AND c.ip::text NOT LIKE '172.%'
                `;
                const recentResult = await this.pool.query(recentQuery, [lastScan]);
                recentlyUpdated = parseInt(recentResult.rows[0].count) || 0;
            }

            // Quick estimate for priority breakdown (use existing fast function)
            const pendingIps = await this.getIPsNeedingThreatCheck(50);
            const samplePending = pendingIps.length;
            const unknownRatio = samplePending > 0 ? 0.7 : 0;
            const unknownPending = Math.floor(pending * unknownRatio);
            const cloudPending = pending - unknownPending;

            const progress = total > 0 ? Math.round((scanned / total) * 100) : 0;

            return {
                total_ips: total,
                scanned_ips: scanned,
                pending_ips: pending,
                unknown_pending: unknownPending,
                cloud_pending: cloudPending,
                recently_updated: recentlyUpdated,
                scan_progress: progress,
                last_scan: lastScan
            };

        } catch (error) {
            console.error('Error getting threat intel status:', error.message);
            return {
                total_ips: 0,
                scanned_ips: 0,
                pending_ips: 0,
                unknown_pending: 0,
                cloud_pending: 0,
                recently_updated: 0,
                scan_progress: 0,
                last_scan: null
            };
        }
    }

    // Apply data reduction strategies
    applyDataReduction(connections) {
        const skipStates = ['TIME_WAIT', 'CLOSE', 'LAST_ACK', 'FIN_WAIT', 'SYN_RECV'];
        const result = [];
        const aggregated = new Map();

        for (const conn of connections) {
            // Skip transient connection states
            if (conn.state && skipStates.includes(conn.state)) continue;

            // Deduplicate listening ports
            if (conn.direction === 'inbound' && conn.state === 'LISTEN') {
                const portKey = `${conn.internal_ip}:${conn.internal_port}`;
                const now = Date.now();
                const lastSeen = this.recentListeningPorts.get(portKey);
                
                if (lastSeen && (now - lastSeen) < 3600000) continue; // Skip if seen in last hour
                this.recentListeningPorts.set(portKey, now);
            }

            // Aggregate high-volume IPs into 5-minute buckets
            if (this.highVolumeIPs.has(conn.ip) && conn.direction === 'outbound') {
                const timestamp = new Date(conn.timestamp);
                const bucketKey = `${conn.ip}-${Math.floor(timestamp.getTime() / 300000)}`; // 5-minute buckets
                
                if (aggregated.has(bucketKey)) {
                    const existing = aggregated.get(bucketKey);
                    existing.orig_packets += conn.orig_packets || 0;
                    existing.orig_bytes += conn.orig_bytes || 0;
                    existing.reply_packets += conn.reply_packets || 0;
                    existing.reply_bytes += conn.reply_bytes || 0;
                    continue;
                } else {
                    aggregated.set(bucketKey, { ...conn });
                }
            }
            
            result.push(conn);
        }

        // Add aggregated connections
        for (const aggregatedConn of aggregated.values()) {
            result.push(aggregatedConn);
        }

        return result;
    }

    // Run all retention policies
    async runRetentionPolicies() {
        console.log('🔄 Running retention policies...');
        
        const results = {
            aged: await this.cleanupByAge(),
            sized: await this.cleanupBySize(),
            geolocations: 0 // Could implement geolocation cleanup later
        };
        
        // Run VACUUM to reclaim space (PostgreSQL specific)
        try {
            await this.pool.query('VACUUM ANALYZE');
            console.log('✅ Database vacuumed and analyzed');
        } catch (error) {
            console.error('Error running VACUUM:', error.message);
        }
        
        return results;
    }
}

module.exports = ConnectionsDatabase;