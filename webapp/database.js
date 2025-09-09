const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

class ConnectionsDatabase {
    constructor(dbPath = '../data/connections.db', options = {}) {
        this.dbPath = path.resolve(__dirname, dbPath);
        this.db = null;
        this.isInitialized = false;
        
        // Retention policies configuration
        this.retentionConfig = {
            maxSizeMB: options.maxSizeMB || 1000, // Default 1GB max database size
            maxAgeDays: options.maxAgeDays || 30, // Default 30 days retention
            cleanupBatchSize: options.cleanupBatchSize || 10000, // Records to delete per batch
            enableSizeLimit: options.enableSizeLimit !== false, // Enable by default
            enableTimeLimit: options.enableTimeLimit !== false  // Enable by default
        };
        
        // Email notification configuration
        this.emailConfig = {
            enabled: options.enableEmailNotifications !== false, // Enable by default
            recipient: options.emailRecipient || 'admin@example.com'
        };
    }

    // Initialize database connection and create tables
    async init() {
        return new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(this.dbPath, (err) => {
                if (err) {
                    console.error('Error opening database:', err.message);
                    reject(err);
                } else {
                    console.log(`Connected to SQLite database at ${this.dbPath}`);
                    this.createTables().then(() => {
                        this.isInitialized = true;
                        resolve();
                    }).catch(reject);
                }
            });
        });
    }

    // Create database tables
    async createTables() {
        const createConnectionsTable = `
            CREATE TABLE IF NOT EXISTS connections (
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
            )
        `;

        const createGeolocationsTable = `
            CREATE TABLE IF NOT EXISTS geolocations (
                ip TEXT PRIMARY KEY,
                country TEXT,
                country_code TEXT,
                region TEXT,
                city TEXT,
                latitude REAL,
                longitude REAL,
                timezone TEXT,
                isp TEXT,
                org TEXT,
                asn TEXT,
                hostname TEXT,
                last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `;

        const createIndexes = [
            'CREATE INDEX IF NOT EXISTS idx_connections_ip ON connections(ip)',
            'CREATE INDEX IF NOT EXISTS idx_connections_timestamp ON connections(timestamp)', 
            'CREATE INDEX IF NOT EXISTS idx_connections_ip_timestamp ON connections(ip, timestamp)',
            'CREATE INDEX IF NOT EXISTS idx_connections_direction ON connections(direction)',
            'CREATE INDEX IF NOT EXISTS idx_connections_type ON connections(connection_type)'
        ];

        return new Promise((resolve, reject) => {
            this.db.serialize(() => {
                this.db.run(createConnectionsTable);
                this.db.run(createGeolocationsTable);
                
                this.db.run('BEGIN');
                
                createIndexes.forEach(indexSQL => {
                    this.db.run(indexSQL);
                });
                
                this.db.run('COMMIT', (err) => {
                    if (err) {
                        reject(err);
                    } else {
                        console.log('Database tables and indexes created successfully');
                        resolve();
                    }
                });
            });
        });
    }

    // Insert connection record
    async insertConnection(connectionData) {
        const sql = `
            INSERT OR IGNORE INTO connections 
            (ip, timestamp, direction, connection_type, internal_ip, internal_port, 
             external_port, state, orig_packets, orig_bytes, reply_packets, reply_bytes, details, source_file)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `;

        return new Promise((resolve, reject) => {
            this.db.run(sql, [
                connectionData.ip,
                connectionData.timestamp,
                connectionData.direction || 'unknown',
                connectionData.type || connectionData.connection_type,
                connectionData.internal_ip,
                connectionData.internal_port,
                connectionData.external_port,
                connectionData.state,
                connectionData.orig_packets || 0,
                connectionData.orig_bytes || 0,
                connectionData.reply_packets || 0,
                connectionData.reply_bytes || 0,
                connectionData.details || '',
                connectionData.source_file || ''
            ], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.changes);
                }
            });
        });
    }

    // Batch insert connections (much faster)
    async insertConnectionsBatch(connections) {
        return new Promise((resolve, reject) => {
            const sql = `
                INSERT OR IGNORE INTO connections 
                (ip, timestamp, direction, connection_type, internal_ip, internal_port, 
                 external_port, state, orig_packets, orig_bytes, reply_packets, reply_bytes, details, source_file)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;

            this.db.serialize(() => {
                let insertCount = 0;
                this.db.run('BEGIN TRANSACTION');
                
                const stmt = this.db.prepare(sql);
                
                connections.forEach(conn => {
                    stmt.run([
                        conn.ip,
                        conn.timestamp,
                        conn.direction || 'unknown',
                        conn.type || conn.connection_type,
                        conn.internal_ip,
                        conn.internal_port,
                        conn.external_port,
                        conn.state,
                        conn.orig_packets || 0,
                        conn.orig_bytes || 0,
                        conn.reply_packets || 0,
                        conn.reply_bytes || 0,
                        conn.details || '',
                        conn.source_file || ''
                    ], function(err) {
                        if (!err && this.changes > 0) {
                            insertCount++;
                        }
                    });
                });
                
                stmt.finalize();
                this.db.run('COMMIT', (err) => {
                    if (err) {
                        reject(err);
                    } else {
                        console.log(`Batch inserted ${insertCount} connection records`);
                        resolve(insertCount);
                    }
                });
            });
        });
    }

    // Get historical connections with filtering
    async getHistoricalConnections(filters = {}) {
        let sql = `
            SELECT c.*, g.country, g.country_code, g.region, g.city, g.latitude, g.longitude,
                   g.timezone, g.isp, g.org, g.asn, g.hostname
            FROM connections c
            LEFT JOIN geolocations g ON c.ip = g.ip
            WHERE 1=1
        `;
        
        const params = [];
        
        if (filters.startDate) {
            sql += ' AND datetime(c.timestamp) >= datetime(?)';
            params.push(filters.startDate);
        }
        
        if (filters.endDate) {
            sql += ' AND datetime(c.timestamp) <= datetime(?)';
            params.push(filters.endDate);
        }
        
        if (filters.direction && filters.direction !== 'both') {
            sql += ' AND c.direction = ?';
            params.push(filters.direction);
        }
        
        if (filters.ip) {
            sql += ' AND c.ip = ?';
            params.push(filters.ip);
        }
        
        sql += ' ORDER BY c.timestamp DESC';
        
        if (filters.limit) {
            sql += ' LIMIT ?';
            params.push(parseInt(filters.limit));
        }

        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(rows);
                }
            });
        });
    }

    // Get aggregated connection data (for current API compatibility)
    async getAggregatedConnections(filters = {}) {
        let sql = `
            SELECT c.ip,
                   COUNT(*) as connection_count,
                   SUM(CASE WHEN c.direction = 'inbound' THEN 1 ELSE 0 END) as inbound_count,
                   SUM(CASE WHEN c.direction = 'outbound' THEN 1 ELSE 0 END) as outbound_count,
                   MAX(c.timestamp) as last_seen,
                   GROUP_CONCAT(DISTINCT c.connection_type) as connection_types,
                   GROUP_CONCAT(DISTINCT c.direction) as directions,
                   g.country, g.country_code, g.region, g.city, g.latitude, g.longitude,
                   g.timezone, g.isp, g.org, g.asn, g.hostname
            FROM connections c
            LEFT JOIN geolocations g ON c.ip = g.ip
            WHERE 1=1
        `;
        
        const params = [];
        
        if (filters.startDate) {
            sql += ' AND datetime(c.timestamp) >= datetime(?)';
            params.push(filters.startDate);
        }
        
        if (filters.endDate) {
            sql += ' AND datetime(c.timestamp) <= datetime(?)';
            params.push(filters.endDate);
        }
        
        if (filters.direction && filters.direction !== 'both') {
            sql += ' AND c.direction = ?';
            params.push(filters.direction);
        }
        
        sql += ' GROUP BY c.ip';
        sql += ' ORDER BY connection_count DESC';
        
        if (filters.limit) {
            sql += ' LIMIT ?';
            params.push(parseInt(filters.limit));
        }

        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    reject(err);
                } else {
                    // Transform to match current API format
                    const connections = rows.map(row => ({
                        ip: row.ip,
                        connectionCount: row.connection_count,
                        inboundCount: row.inbound_count,
                        outboundCount: row.outbound_count,
                        lastSeen: row.last_seen,
                        connectionTypes: row.connection_types ? row.connection_types.split(',') : [],
                        directions: row.directions ? row.directions.split(',') : [],
                        country: row.country || 'Unknown',
                        countryCode: row.country_code || 'XX',
                        region: row.region || 'Unknown',
                        city: row.city || 'Unknown',
                        latitude: row.latitude || 0,
                        longitude: row.longitude || 0,
                        timezone: row.timezone || 'Unknown',
                        isp: row.isp || 'Unknown',
                        org: row.org || 'Unknown',
                        asn: row.asn || 'Unknown',
                        hostname: row.hostname || 'No hostname found'
                    }));
                    resolve(connections);
                }
            });
        });
    }

    // Insert or update geolocation data
    async upsertGeolocation(ip, geoData) {
        const sql = `
            INSERT OR REPLACE INTO geolocations 
            (ip, country, country_code, region, city, latitude, longitude, timezone, isp, org, asn, hostname, last_updated)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `;

        return new Promise((resolve, reject) => {
            this.db.run(sql, [
                ip,
                geoData.country,
                geoData.countryCode,
                geoData.region,
                geoData.city,
                geoData.latitude,
                geoData.longitude,
                geoData.timezone,
                geoData.isp,
                geoData.org,
                geoData.asn,
                geoData.hostname || 'No hostname found'
            ], function(err) {
                if (err) {
                    reject(err);
                } else {
                    resolve(this.changes);
                }
            });
        });
    }

    // Get database statistics
    async getStats() {
        const queries = [
            'SELECT COUNT(*) as total_connections FROM connections',
            'SELECT COUNT(DISTINCT ip) as unique_ips FROM connections', 
            'SELECT COUNT(*) as cached_geolocations FROM geolocations',
            'SELECT MIN(timestamp) as oldest_record, MAX(timestamp) as newest_record FROM connections'
        ];

        const results = {};
        
        for (const query of queries) {
            const result = await new Promise((resolve, reject) => {
                this.db.get(query, (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                });
            });
            Object.assign(results, result);
        }
        
        return results;
    }

    // Get database file size in MB
    async getDatabaseSizeMB() {
        const fs = require('fs').promises;
        try {
            const stats = await fs.stat(this.dbPath);
            return Math.round(stats.size / (1024 * 1024) * 100) / 100; // Round to 2 decimal places
        } catch (error) {
            console.warn('Could not get database file size:', error.message);
            return 0;
        }
    }

    // Clean up old records by age (time-based retention)
    async cleanupByAge() {
        if (!this.retentionConfig.enableTimeLimit) return 0;

        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - this.retentionConfig.maxAgeDays);
        const cutoffISO = cutoffDate.toISOString();
        const maxAgeDays = this.retentionConfig.maxAgeDays;

        const deleteSQL = `
            DELETE FROM connections 
            WHERE id IN (
                SELECT id FROM connections 
                WHERE timestamp < ?
                ORDER BY timestamp ASC
                LIMIT ?
            )
        `;

        return new Promise((resolve, reject) => {
            this.db.run(deleteSQL, [cutoffISO, this.retentionConfig.cleanupBatchSize], function(err) {
                if (err) {
                    reject(err);
                } else {
                    const deleted = this.changes;
                    if (deleted > 0) {
                        console.log(`Cleaned up ${deleted} records older than ${maxAgeDays} days`);
                    }
                    resolve(deleted);
                }
            });
        });
    }

    // Clean up oldest records to maintain size limit (size-based retention)
    async cleanupBySize() {
        if (!this.retentionConfig.enableSizeLimit) return 0;

        const currentSizeMB = await this.getDatabaseSizeMB();
        if (currentSizeMB <= this.retentionConfig.maxSizeMB) return 0;
        
        const maxSizeMB = this.retentionConfig.maxSizeMB;

        const deleteSQL = `
            DELETE FROM connections 
            WHERE id IN (
                SELECT id FROM connections 
                ORDER BY timestamp ASC 
                LIMIT ?
            )
        `;

        return new Promise((resolve, reject) => {
            this.db.run(deleteSQL, [this.retentionConfig.cleanupBatchSize], function(err) {
                if (err) {
                    reject(err);
                } else {
                    const deleted = this.changes;
                    if (deleted > 0) {
                        console.log(`Cleaned up ${deleted} oldest records to maintain size limit (${currentSizeMB}MB > ${maxSizeMB}MB)`);
                    }
                    resolve(deleted);
                }
            });
        });
    }

    // Clean up orphaned geolocation entries (IPs no longer in connections table)
    async cleanupOrphanedGeolocations() {
        const deleteSQL = `
            DELETE FROM geolocations 
            WHERE ip NOT IN (SELECT DISTINCT ip FROM connections)
        `;

        return new Promise((resolve, reject) => {
            this.db.run(deleteSQL, function(err) {
                if (err) {
                    reject(err);
                } else {
                    const deleted = this.changes;
                    if (deleted > 0) {
                        console.log(`Cleaned up ${deleted} orphaned geolocation entries`);
                    }
                    resolve(deleted);
                }
            });
        });
    }

    // Vacuum database to reclaim space after deletions
    async vacuumDatabase() {
        return new Promise((resolve, reject) => {
            this.db.run('VACUUM', (err) => {
                if (err) {
                    reject(err);
                } else {
                    console.log('Database vacuumed to reclaim space');
                    resolve();
                }
            });
        });
    }

    // Send email notification about database cleanup using system mail command
    async sendCleanupNotification(cleanupResults) {
        if (!this.emailConfig.enabled) {
            console.log('Email notifications disabled');
            return;
        }

        const totalDeleted = cleanupResults.aged + cleanupResults.sized + cleanupResults.geolocations;
        
        // Only send email if significant cleanup occurred
        if (totalDeleted === 0) {
            return;
        }

        try {
            const currentTime = new Date().toLocaleString();
            const sizeBefore = cleanupResults.sizeBefore?.toFixed(2) || 'N/A';
            const sizeAfter = cleanupResults.sizeAfter?.toFixed(2) || 'N/A';
            const spaceSaved = cleanupResults.spaceSaved?.toFixed(2) || 'N/A';

            let cleanupReasons = [];
            if (cleanupResults.aged > 0) {
                cleanupReasons.push(`- Age-based cleanup: ${cleanupResults.aged} records older than ${this.retentionConfig.maxAgeDays} days`);
            }
            if (cleanupResults.sized > 0) {
                cleanupReasons.push(`- Size-based cleanup: ${cleanupResults.sized} oldest records to maintain ${this.retentionConfig.maxSizeMB}MB limit`);
            }
            if (cleanupResults.geolocations > 0) {
                cleanupReasons.push(`- Orphaned geolocation cleanup: ${cleanupResults.geolocations} unused entries`);
            }

            const emailBody = `Firewalla Monitor Database Cleanup Report

Cleanup completed: ${currentTime}

Summary:
- Total records deleted: ${totalDeleted.toLocaleString()}
- Database size before: ${sizeBefore} MB  
- Database size after: ${sizeAfter} MB
- Space reclaimed: ${spaceSaved} MB

Cleanup Details:
${cleanupReasons.join('\n')}

Configuration:
- Max database size: ${this.retentionConfig.maxSizeMB} MB
- Max data age: ${this.retentionConfig.maxAgeDays} days
- Cleanup batch size: ${this.retentionConfig.cleanupBatchSize} records

This is an automated message from the Firewalla IP Monitor system.`;

            const subject = `Firewalla Monitor Database Cleanup - ${totalDeleted.toLocaleString()} records processed`;
            
            // Use system mail command to send the email
            const mailCommand = `echo "${emailBody}" | mail -s "${subject}" ${this.emailConfig.recipient}`;
            
            const { stdout, stderr } = await execAsync(mailCommand);
            
            if (stderr && stderr.trim()) {
                console.warn(`Mail command stderr: ${stderr}`);
            }
            
            console.log(`Cleanup notification email sent to ${this.emailConfig.recipient}`);

        } catch (error) {
            console.error('Failed to send cleanup notification email:', error.message);
            // Don't throw the error - email failure shouldn't stop the cleanup process
        }
    }

    // Run all retention policies (main method to call)
    async runRetentionPolicies() {
        if (!this.isInitialized) {
            console.warn('Database not initialized, skipping retention policies');
            return { aged: 0, sized: 0, geolocations: 0 };
        }

        console.log('Running database retention policies...');
        
        const sizeBefore = await this.getDatabaseSizeMB();
        
        try {
            // Run cleanup operations
            const agedCleaned = await this.cleanupByAge();
            const sizeCleaned = await this.cleanupBySize();
            const geoCleaned = await this.cleanupOrphanedGeolocations();
            
            // Vacuum if we deleted anything significant
            if (agedCleaned + sizeCleaned + geoCleaned > 1000) {
                await this.vacuumDatabase();
            }
            
            const sizeAfter = await this.getDatabaseSizeMB();
            const spaceSaved = sizeBefore - sizeAfter;
            
            if (spaceSaved > 0.1) {
                console.log(`Retention policies completed: ${spaceSaved.toFixed(2)}MB space reclaimed`);
            }
            
            const cleanupResults = {
                aged: agedCleaned,
                sized: sizeCleaned,
                geolocations: geoCleaned,
                sizeBefore: sizeBefore,
                sizeAfter: sizeAfter,
                spaceSaved: spaceSaved
            };
            
            // Send email notification if cleanup occurred
            await this.sendCleanupNotification(cleanupResults);
            
            return cleanupResults;
            
        } catch (error) {
            console.error('Error running retention policies:', error.message);
            throw error;
        }
    }

    // Close database connection
    close() {
        if (this.db) {
            this.db.close((err) => {
                if (err) {
                    console.error('Error closing database:', err.message);
                } else {
                    console.log('Database connection closed');
                }
            });
        }
    }

    // Search connections with geolocation data
    async searchConnections(searchTerm, filters = {}) {
        if (!searchTerm || searchTerm.trim().length === 0) {
            // If no search term, return aggregated connections with filters
            return this.getAggregatedConnections(filters);
        }

        const term = `%${searchTerm.toLowerCase()}%`;
        
        let sql = `
            SELECT c.ip,
                   COUNT(*) as connection_count,
                   SUM(CASE WHEN c.direction = 'inbound' THEN 1 ELSE 0 END) as inbound_count,
                   SUM(CASE WHEN c.direction = 'outbound' THEN 1 ELSE 0 END) as outbound_count,
                   MAX(c.timestamp) as last_seen,
                   GROUP_CONCAT(DISTINCT c.connection_type) as connection_types,
                   GROUP_CONCAT(DISTINCT c.direction) as directions,
                   g.country, g.country_code, g.region, g.city, g.latitude, g.longitude,
                   g.timezone, g.isp, g.org, g.asn, g.hostname
            FROM connections c
            LEFT JOIN geolocations g ON c.ip = g.ip
            WHERE 1=1
        `;
        
        const params = [];
        
        // Apply date filtering
        if (filters.startDate) {
            sql += ' AND datetime(c.timestamp) >= datetime(?)';
            params.push(filters.startDate);
        }
        
        if (filters.endDate) {
            sql += ' AND datetime(c.timestamp) <= datetime(?)';
            params.push(filters.endDate);
        }
        
        // Apply direction filtering
        if (filters.direction && filters.direction !== 'both') {
            sql += ' AND c.direction = ?';
            params.push(filters.direction);
        }
        
        // Apply search term filtering - search across multiple fields
        sql += ` AND (
            LOWER(c.ip) LIKE ? OR 
            LOWER(g.country) LIKE ? OR 
            LOWER(g.region) LIKE ? OR 
            LOWER(g.city) LIKE ? OR 
            LOWER(g.isp) LIKE ? OR 
            LOWER(g.org) LIKE ? OR 
            LOWER(g.hostname) LIKE ?
        )`;
        
        // Add the search term for each field
        for (let i = 0; i < 7; i++) {
            params.push(term);
        }
        
        sql += `
            GROUP BY c.ip, g.country, g.country_code, g.region, g.city, 
                     g.latitude, g.longitude, g.timezone, g.isp, g.org, g.asn, g.hostname
            ORDER BY connection_count DESC
            LIMIT ?
        `;
        
        params.push(filters.limit || 1000);
        
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) {
                    console.error('Database search error:', err.message);
                    reject(err);
                    return;
                }
                
                const connections = rows.map(row => ({
                    ip: row.ip,
                    connectionCount: row.connection_count,
                    inboundCount: row.inbound_count,
                    outboundCount: row.outbound_count,
                    lastSeen: row.last_seen,
                    connectionTypes: row.connection_types ? row.connection_types.split(',') : [],
                    directions: row.directions ? row.directions.split(',') : [],
                    country: row.country || 'Unknown',
                    countryCode: row.country_code || '',
                    region: row.region || 'Unknown',
                    city: row.city || 'Unknown',
                    latitude: row.latitude || 0,
                    longitude: row.longitude || 0,
                    timezone: row.timezone || 'Unknown',
                    isp: row.isp || 'Unknown',
                    org: row.org || 'Unknown',
                    asn: row.asn || 'Unknown',
                    hostname: row.hostname || 'No hostname found'
                }));
                resolve(connections);
            });
        });
    }
}

module.exports = ConnectionsDatabase;