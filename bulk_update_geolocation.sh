#!/bin/bash

# Bulk Geolocation Update for Firewalla IP Monitor
# Updates all missing geolocation data automatically

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="${SCRIPT_DIR}/data"
DB_FILE="${DATA_DIR}/connections.db"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to fetch and update geolocation
update_ip_geolocation() {
    local ip=$1
    local count=$2
    
    print_status "Processing $ip ($count connections)..."
    
    # Fetch geolocation data
    local response
    response=$(curl -s -m 10 "http://ip-api.com/json/${ip}?fields=status,message,country,countryCode,region,city,lat,lon,timezone,isp,org,as,reverse" 2>/dev/null) || {
        print_error "Failed to fetch data for $ip"
        return 1
    }
    
    # Check status
    local status
    status=$(echo "$response" | grep -o '"status":"[^"]*"' | cut -d'"' -f4 2>/dev/null || echo "")
    
    if [[ "$status" != "success" ]]; then
        local message
        message=$(echo "$response" | grep -o '"message":"[^"]*"' | cut -d'"' -f4 2>/dev/null || echo "Unknown error")
        print_error "API request failed for $ip: $message"
        return 1
    fi
    
    # Extract fields
    local country=$(echo "$response" | grep -o '"country":"[^"]*"' | cut -d'"' -f4 | sed 's/null//')
    local country_code=$(echo "$response" | grep -o '"countryCode":"[^"]*"' | cut -d'"' -f4 | sed 's/null//')
    local region=$(echo "$response" | grep -o '"region":"[^"]*"' | cut -d'"' -f4 | sed 's/null//')
    local city=$(echo "$response" | grep -o '"city":"[^"]*"' | cut -d'"' -f4 | sed 's/null//')
    local lat=$(echo "$response" | grep -o '"lat":[^,}]*' | cut -d':' -f2 | sed 's/null//')
    local lon=$(echo "$response" | grep -o '"lon":[^,}]*' | cut -d':' -f2 | sed 's/null//')
    local timezone=$(echo "$response" | grep -o '"timezone":"[^"]*"' | cut -d'"' -f4 | sed 's/null//')
    local isp=$(echo "$response" | grep -o '"isp":"[^"]*"' | cut -d'"' -f4 | sed 's/null//')
    local org=$(echo "$response" | grep -o '"org":"[^"]*"' | cut -d'"' -f4 | sed 's/null//')
    local asn=$(echo "$response" | grep -o '"as":"[^"]*"' | cut -d'"' -f4 | sed 's/null//')
    local hostname=$(echo "$response" | grep -o '"reverse":"[^"]*"' | cut -d'"' -f4 | sed 's/null//')
    
    # Escape single quotes for SQL
    country=$(echo "$country" | sed "s/'/''/g")
    region=$(echo "$region" | sed "s/'/''/g")
    city=$(echo "$city" | sed "s/'/''/g")
    timezone=$(echo "$timezone" | sed "s/'/''/g")
    isp=$(echo "$isp" | sed "s/'/''/g")
    org=$(echo "$org" | sed "s/'/''/g")
    asn=$(echo "$asn" | sed "s/'/''/g")
    hostname=$(echo "$hostname" | sed "s/'/''/g")
    
    # Build SQL with proper NULL handling
    local sql="INSERT OR REPLACE INTO geolocations (
        ip, country, country_code, region, city, latitude, longitude, 
        timezone, isp, org, asn, hostname, last_updated
    ) VALUES (
        '$ip',
        $([ -n "$country" ] && echo "'$country'" || echo "NULL"),
        $([ -n "$country_code" ] && echo "'$country_code'" || echo "NULL"),
        $([ -n "$region" ] && echo "'$region'" || echo "NULL"),
        $([ -n "$city" ] && echo "'$city'" || echo "NULL"),
        $([ -n "$lat" ] && echo "$lat" || echo "NULL"),
        $([ -n "$lon" ] && echo "$lon" || echo "NULL"),
        $([ -n "$timezone" ] && echo "'$timezone'" || echo "NULL"),
        $([ -n "$isp" ] && echo "'$isp'" || echo "NULL"),
        $([ -n "$org" ] && echo "'$org'" || echo "NULL"),
        $([ -n "$asn" ] && echo "'$asn'" || echo "NULL"),
        $([ -n "$hostname" ] && echo "'$hostname'" || echo "NULL"),
        datetime('now')
    );"
    
    sqlite3 "$DB_FILE" "$sql" || {
        print_error "Failed to update database for $ip"
        return 1
    }
    
    print_success "Updated $ip: $country, $city ($isp)"
    
    # Rate limiting - be nice to the API
    sleep 1
}

# Main function
main() {
    if [[ ! -f "$DB_FILE" ]]; then
        print_error "Database file not found: $DB_FILE"
        exit 1
    fi
    
    print_status "Fetching list of IPs without geolocation data..."
    
    # Get IPs without geolocation data
    local missing_ips
    missing_ips=$(sqlite3 "$DB_FILE" "
        SELECT c.ip, COUNT(*) as connection_count 
        FROM connections c 
        LEFT JOIN geolocations g ON c.ip = g.ip 
        WHERE g.ip IS NULL 
        GROUP BY c.ip 
        ORDER BY connection_count DESC;
    " 2>/dev/null) || {
        print_error "Failed to query database"
        exit 1
    }
    
    if [[ -z "$missing_ips" ]]; then
        print_success "All IPs already have geolocation data!"
        exit 0
    fi
    
    local total_count=0
    local success_count=0
    
    echo "$missing_ips" | while IFS='|' read -r ip count; do
        total_count=$((total_count + 1))
        if update_ip_geolocation "$ip" "$count"; then
            success_count=$((success_count + 1))
        fi
    done
    
    print_status "Bulk update completed"
}

main "$@"