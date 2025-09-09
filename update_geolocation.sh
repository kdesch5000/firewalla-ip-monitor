#!/bin/bash

# Firewalla IP Monitor - Geolocation Update Utility
# Usage: ./update_geolocation.sh [IP_ADDRESS] [OPTIONS]

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

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to validate IP address
validate_ip() {
    local ip=$1
    if [[ $ip =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
        IFS='.' read -r -a octets <<< "$ip"
        for octet in "${octets[@]}"; do
            if (( octet < 0 || octet > 255 )); then
                return 1
            fi
        done
        return 0
    else
        return 1
    fi
}

# Function to fetch geolocation data from API
fetch_geolocation() {
    local ip=$1
    local api_url="http://ip-api.com/json/${ip}?fields=status,message,country,countryCode,region,city,lat,lon,timezone,isp,org,as,reverse"
    
    print_status "Fetching geolocation data for $ip..."
    
    local response
    response=$(curl -s -m 10 "$api_url" 2>/dev/null) || {
        print_error "Failed to fetch geolocation data from API"
        return 1
    }
    
    echo "$response"
}

# Function to parse JSON response
parse_geolocation() {
    local json_response=$1
    
    # Check if response contains success status
    local status
    status=$(echo "$json_response" | grep -o '"status":"[^"]*"' | cut -d'"' -f4 2>/dev/null || echo "")
    
    if [[ "$status" != "success" ]]; then
        local message
        message=$(echo "$json_response" | grep -o '"message":"[^"]*"' | cut -d'"' -f4 2>/dev/null || echo "Unknown error")
        print_error "API request failed: $message"
        return 1
    fi
    
    # Extract fields (handling potential null values)
    local country=$(echo "$json_response" | grep -o '"country":"[^"]*"' | cut -d'"' -f4 | sed 's/null//')
    local country_code=$(echo "$json_response" | grep -o '"countryCode":"[^"]*"' | cut -d'"' -f4 | sed 's/null//')
    local region=$(echo "$json_response" | grep -o '"region":"[^"]*"' | cut -d'"' -f4 | sed 's/null//')
    local city=$(echo "$json_response" | grep -o '"city":"[^"]*"' | cut -d'"' -f4 | sed 's/null//')
    local lat=$(echo "$json_response" | grep -o '"lat":[^,}]*' | cut -d':' -f2 | sed 's/null//')
    local lon=$(echo "$json_response" | grep -o '"lon":[^,}]*' | cut -d':' -f2 | sed 's/null//')
    local timezone=$(echo "$json_response" | grep -o '"timezone":"[^"]*"' | cut -d'"' -f4 | sed 's/null//')
    local isp=$(echo "$json_response" | grep -o '"isp":"[^"]*"' | cut -d'"' -f4 | sed 's/null//')
    local org=$(echo "$json_response" | grep -o '"org":"[^"]*"' | cut -d'"' -f4 | sed 's/null//')
    local asn=$(echo "$json_response" | grep -o '"as":"[^"]*"' | cut -d'"' -f4 | sed 's/null//')
    local hostname=$(echo "$json_response" | grep -o '"reverse":"[^"]*"' | cut -d'"' -f4 | sed 's/null//')
    
    # Return parsed data as tab-separated values
    echo -e "$country\t$country_code\t$region\t$city\t$lat\t$lon\t$timezone\t$isp\t$org\t$asn\t$hostname"
}

# Function to update database
update_database() {
    local ip=$1
    local country=$2
    local country_code=$3
    local region=$4
    local city=$5
    local lat=$6
    local lon=$7
    local timezone=$8
    local isp=$9
    local org=${10}
    local asn=${11}
    local hostname=${12}
    
    # Escape single quotes for SQL
    country=$(echo "$country" | sed "s/'/''/g")
    region=$(echo "$region" | sed "s/'/''/g")
    city=$(echo "$city" | sed "s/'/''/g")
    timezone=$(echo "$timezone" | sed "s/'/''/g")
    isp=$(echo "$isp" | sed "s/'/''/g")
    org=$(echo "$org" | sed "s/'/''/g")
    asn=$(echo "$asn" | sed "s/'/''/g")
    hostname=$(echo "$hostname" | sed "s/'/''/g")
    
    local sql="INSERT OR REPLACE INTO geolocations (
        ip, country, country_code, region, city, latitude, longitude, 
        timezone, isp, org, asn, hostname, last_updated
    ) VALUES (
        '$ip', 
        '$([ -n "$country" ] && echo "$country" || echo "NULL")',
        '$([ -n "$country_code" ] && echo "$country_code" || echo "NULL")',
        '$([ -n "$region" ] && echo "$region" || echo "NULL")',
        '$([ -n "$city" ] && echo "$city" || echo "NULL")',
        $([ -n "$lat" ] && echo "$lat" || echo "NULL"),
        $([ -n "$lon" ] && echo "$lon" || echo "NULL"),
        '$([ -n "$timezone" ] && echo "$timezone" || echo "NULL")',
        '$([ -n "$isp" ] && echo "$isp" || echo "NULL")',
        '$([ -n "$org" ] && echo "$org" || echo "NULL")',
        '$([ -n "$asn" ] && echo "$asn" || echo "NULL")',
        '$([ -n "$hostname" ] && echo "$hostname" || echo "NULL")',
        datetime('now')
    );"
    
    sqlite3 "$DB_FILE" "$sql" || {
        print_error "Failed to update database"
        return 1
    }
}

# Function to display current geolocation data
show_current_data() {
    local ip=$1
    
    print_status "Current geolocation data for $ip:"
    
    local result
    result=$(sqlite3 -header -column "$DB_FILE" "SELECT * FROM geolocations WHERE ip = '$ip';" 2>/dev/null) || {
        print_warning "No existing data found for $ip"
        return 1
    }
    
    if [[ -z "$result" ]]; then
        print_warning "No existing data found for $ip"
        return 1
    fi
    
    echo "$result"
    return 0
}

# Function to list IPs without geolocation data
list_missing_geolocations() {
    print_status "IPs in connections table without geolocation data:"
    
    local result
    result=$(sqlite3 -header -column "$DB_FILE" "
        SELECT c.ip, COUNT(*) as connection_count 
        FROM connections c 
        LEFT JOIN geolocations g ON c.ip = g.ip 
        WHERE g.ip IS NULL 
        GROUP BY c.ip 
        ORDER BY connection_count DESC 
        LIMIT 20;
    " 2>/dev/null) || {
        print_error "Failed to query database"
        return 1
    }
    
    if [[ -z "$result" ]]; then
        print_success "All IPs have geolocation data!"
        return 0
    fi
    
    echo "$result"
}

# Function to show usage
show_usage() {
    echo "Firewalla IP Monitor - Geolocation Update Utility"
    echo
    echo "Usage: $0 [IP_ADDRESS] [OPTIONS]"
    echo
    echo "Commands:"
    echo "  $0 <IP>              Update geolocation for specific IP"
    echo "  $0 --list-missing    Show IPs without geolocation data"
    echo "  $0 --show <IP>       Show current geolocation data for IP"
    echo "  $0 --help            Show this help message"
    echo
    echo "Examples:"
    echo "  $0 8.8.8.8"
    echo "  $0 --show 8.8.8.8"
    echo "  $0 --list-missing"
    echo
}

# Main script logic
main() {
    # Check if database exists
    if [[ ! -f "$DB_FILE" ]]; then
        print_error "Database file not found: $DB_FILE"
        exit 1
    fi
    
    # Parse command line arguments
    case "${1:-}" in
        "--help"|"-h"|"")
            show_usage
            exit 0
            ;;
        "--list-missing")
            list_missing_geolocations
            exit $?
            ;;
        "--show")
            if [[ -z "${2:-}" ]]; then
                print_error "IP address required with --show option"
                show_usage
                exit 1
            fi
            if ! validate_ip "$2"; then
                print_error "Invalid IP address: $2"
                exit 1
            fi
            show_current_data "$2"
            exit $?
            ;;
        *)
            # Assume it's an IP address
            local ip=$1
            if ! validate_ip "$ip"; then
                print_error "Invalid IP address: $ip"
                show_usage
                exit 1
            fi
            
            # Show current data if it exists
            show_current_data "$ip" && echo
            
            # Fetch new geolocation data
            local geo_response
            geo_response=$(fetch_geolocation "$ip") || exit 1
            
            # Parse the response
            local geo_data
            geo_data=$(parse_geolocation "$geo_response") || exit 1
            
            # Split the parsed data
            IFS=$'\t' read -r country country_code region city lat lon timezone isp org asn hostname <<< "$geo_data"
            
            # Display the new data
            print_status "New geolocation data:"
            echo "Country: ${country:-N/A}"
            echo "Country Code: ${country_code:-N/A}"
            echo "Region: ${region:-N/A}"
            echo "City: ${city:-N/A}"
            echo "Latitude: ${lat:-N/A}"
            echo "Longitude: ${lon:-N/A}"
            echo "Timezone: ${timezone:-N/A}"
            echo "ISP: ${isp:-N/A}"
            echo "Organization: ${org:-N/A}"
            echo "ASN: ${asn:-N/A}"
            echo "Hostname: ${hostname:-N/A}"
            echo
            
            # Confirm update
            read -p "Update database with this information? (y/N): " confirm
            if [[ "$confirm" =~ ^[Yy]$ ]]; then
                update_database "$ip" "$country" "$country_code" "$region" "$city" "$lat" "$lon" "$timezone" "$isp" "$org" "$asn" "$hostname"
                print_success "Geolocation data updated for $ip"
            else
                print_warning "Update cancelled"
            fi
            ;;
    esac
}

# Run main function
main "$@"