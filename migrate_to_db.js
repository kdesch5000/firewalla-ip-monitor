#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const ConnectionsDatabase = require('./webapp/database');

const DATA_DIR = path.join(__dirname, 'data');
const GEOLOCATION_CACHE_FILE = path.join(DATA_DIR, 'geolocation_cache.json');

class DataMigration {
    constructor() {
        this.db = new ConnectionsDatabase();
        this.stats = {
            filesProcessed: 0,
            connectionsInserted: 0,
            geolocationsInserted: 0,
            errors: 0
        };
    }

    async run() {
        console.log('🚀 Starting database migration...');
        console.log('📁 Data directory:', DATA_DIR);
        
        try {
            // Initialize database
            await this.db.init();
            
            // Migrate geolocation cache first
            await this.migrateGeolocationCache();
            
            // Migrate connection data
            await this.migrateConnectionFiles();
            
            // Show final stats
            await this.showFinalStats();
            
            console.log('✅ Migration completed successfully!');
            
        } catch (error) {
            console.error('❌ Migration failed:', error);
            process.exit(1);
        } finally {
            this.db.close();
        }
    }

    async migrateGeolocationCache() {
        console.log('\n📍 Migrating geolocation cache...');
        
        try {
            const cacheData = await fs.readFile(GEOLOCATION_CACHE_FILE, 'utf8');
            const cacheEntries = JSON.parse(cacheData);
            
            let inserted = 0;
            for (const [ip, geoData] of cacheEntries) {
                if (geoData && !geoData.error && geoData.latitude && geoData.longitude) {
                    try {
                        await this.db.upsertGeolocation(ip, geoData);
                        inserted++;
                    } catch (error) {
                        console.warn(`Failed to insert geolocation for ${ip}:`, error.message);
                        this.stats.errors++;
                    }
                }
            }
            
            this.stats.geolocationsInserted = inserted;
            console.log(`✅ Migrated ${inserted} geolocation entries`);
            
        } catch (error) {
            console.warn('⚠️  Could not migrate geolocation cache:', error.message);
        }
    }

    async migrateConnectionFiles() {
        console.log('\n🔗 Migrating connection files...');
        
        const files = await fs.readdir(DATA_DIR);
        const connectionFiles = files.filter(file => 
            file.includes('connections') || 
            file.includes('tracking') ||
            file.includes('firemain') ||
            file.includes('vpn')
        ).filter(file => file.endsWith('.json'));
        
        console.log(`Found ${connectionFiles.length} connection files to process`);
        
        // Process files in batches to avoid memory issues
        const batchSize = 10;
        for (let i = 0; i < connectionFiles.length; i += batchSize) {
            const batch = connectionFiles.slice(i, i + batchSize);
            
            console.log(`Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(connectionFiles.length/batchSize)}`);
            
            const batchPromises = batch.map(file => this.processConnectionFile(file));
            await Promise.allSettled(batchPromises);
        }
    }

    async processConnectionFile(filename) {
        const filePath = path.join(DATA_DIR, filename);
        
        try {
            const fileContent = await fs.readFile(filePath, 'utf8');
            
            // Skip empty files
            if (!fileContent.trim()) return;
            
            const connections = JSON.parse(fileContent);
            
            // Skip if not an array or empty
            if (!Array.isArray(connections) || connections.length === 0) return;
            
            // Transform and insert connections
            const transformedConnections = connections.map(conn => ({
                ip: conn.external_ip || conn.ip,
                timestamp: conn.timestamp || conn.collected_at,
                direction: conn.direction || 'unknown',
                connection_type: conn.type || 'unknown',
                internal_ip: conn.internal_ip,
                internal_port: conn.internal_port,
                external_port: conn.external_port,
                state: conn.state,
                orig_packets: conn.orig_packets || conn.packets,
                orig_bytes: conn.orig_bytes || conn.bytes,
                reply_packets: conn.reply_packets,
                reply_bytes: conn.reply_bytes,
                details: conn.details || JSON.stringify(conn),
                source_file: filename
            })).filter(conn => conn.ip && conn.timestamp); // Only valid connections
            
            if (transformedConnections.length > 0) {
                const inserted = await this.db.insertConnectionsBatch(transformedConnections);
                this.stats.connectionsInserted += inserted;
            }
            
            this.stats.filesProcessed++;
            
            // Log progress every 50 files
            if (this.stats.filesProcessed % 50 === 0) {
                console.log(`  Processed ${this.stats.filesProcessed} files, inserted ${this.stats.connectionsInserted} connections`);
            }
            
        } catch (error) {
            console.warn(`⚠️  Error processing ${filename}:`, error.message);
            this.stats.errors++;
        }
    }

    async showFinalStats() {
        console.log('\n📊 Migration Statistics:');
        console.log(`  Files processed: ${this.stats.filesProcessed}`);
        console.log(`  Connections inserted: ${this.stats.connectionsInserted}`);
        console.log(`  Geolocations inserted: ${this.stats.geolocationsInserted}`);
        console.log(`  Errors: ${this.stats.errors}`);
        
        // Get database stats
        const dbStats = await this.db.getStats();
        console.log('\n🗄️  Database Statistics:');
        console.log(`  Total connections: ${dbStats.total_connections}`);
        console.log(`  Unique IPs: ${dbStats.unique_ips}`);
        console.log(`  Cached geolocations: ${dbStats.cached_geolocations}`);
        console.log(`  Date range: ${dbStats.oldest_record} to ${dbStats.newest_record}`);
    }
}

// Run migration if called directly
if (require.main === module) {
    const migration = new DataMigration();
    migration.run();
}

module.exports = DataMigration;