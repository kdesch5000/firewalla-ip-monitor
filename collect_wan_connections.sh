#!/bin/bash

# Firewalla WAN Connection Monitor
# Collects external IP addresses connecting to/from WAN interface

set -euo pipefail

# Configuration - UPDATE THESE VALUES FOR YOUR SETUP
FIREWALLA_HOST="192.168.86.1"        # Your Firewalla IP address
FIREWALLA_USER="pi"                  # SSH username (typically 'pi')
DATA_DIR="$(dirname "$0")/data"      # Data directory (relative to script)
LOG_FILE="$(dirname "$0")/monitor.log" # Log file location
WAN_INTERFACE="eth0"                 # WAN interface name
WAN_IP=""                           # Leave empty - will be auto-detected

# Create data directory
mkdir -p "${DATA_DIR}"

# Logging function
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "${LOG_FILE}"
}

# Extract external IPs from FireMain logs
collect_firemain_ips() {
    local output_file="${DATA_DIR}/connections_$(date +%Y%m%d_%H%M%S).json"
    local temp_file=$(mktemp)
    
    log "Collecting external IPs from FireMain logs..."
    
    # Get recent connection logs from Firewalla (find most recent FireMain log)
    # Use the most recent FireMain log file
    ssh "${FIREWALLA_USER}@${FIREWALLA_HOST}" "ls -t /home/pi/logs/FireMain*.log | head -1 | xargs tail -n 5000" | grep 'BroDetect: Conn:Debug' > "${temp_file}"
    
    # Process logs to extract external IP data
    {
        echo "["
        local first=true
        while IFS= read -r line; do
            # Extract timestamp and IPs from BroDetect log format
            # Format: 2025-09-07 02:06:22 WARN BroDetect: Conn:Debug:Orig_bytes: 116574375 C4LdXNNmEdWI5PpRi 99.182.4.194 192.168.86.105
            if [[ $line =~ ^([0-9]{4}-[0-9]{2}-[0-9]{2}\ [0-9]{2}:[0-9]{2}:[0-9]{2}).*\ ([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)\ ([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
                local timestamp="${BASH_REMATCH[1]}"
                local ip1="${BASH_REMATCH[2]}"
                local ip2="${BASH_REMATCH[3]}"
                
                # Determine which is internal and which is external
                local internal_ip=""
                local external_ip=""
                
                if [[ "$ip1" =~ ^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.) ]]; then
                    internal_ip="$ip1"
                    external_ip="$ip2"
                elif [[ "$ip2" =~ ^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.) ]]; then
                    internal_ip="$ip2"
                    external_ip="$ip1"
                else
                    # Both external, use the one that's not our WAN IP
                    if [[ "$ip1" != "$WAN_IP" ]]; then
                        external_ip="$ip1"
                        internal_ip="WAN"
                    else
                        external_ip="$ip2" 
                        internal_ip="WAN"
                    fi
                fi
                
                # Skip if external IP is empty or invalid
                if [[ -n "$external_ip" && "$external_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
                    if [[ "$first" == true ]]; then
                        first=false
                    else
                        echo ","
                    fi
                    
                    echo -n "    {\"timestamp\": \"$timestamp\", \"external_ip\": \"$external_ip\", \"internal_ip\": \"$internal_ip\", \"collected_at\": \"$(date -Iseconds)\"}"
                fi
            fi
        done < "${temp_file}"
        echo ""
        echo "]"
    } > "${output_file}"
    
    rm -f "${temp_file}"
    log "Collected data saved to: ${output_file}"
}

# Collect current netstat connections - ALL states
collect_current_connections() {
    local output_file="${DATA_DIR}/current_connections_$(date +%Y%m%d_%H%M%S).json"
    
    log "Collecting current external connections (all states)..."
    
    # Get ALL current connections from Firewalla (TCP and UDP for VPN)
    {
        # TCP connections
        ssh "${FIREWALLA_USER}@${FIREWALLA_HOST}" "netstat -tn | grep -E ':22|:80|:443|:8080|SYN|ESTABLISHED|TIME_WAIT|CLOSE_WAIT' | grep -v '127.0.0.1' | grep -E '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+'"
        
        # UDP connections (for VPN like Wireguard)
        ssh "${FIREWALLA_USER}@${FIREWALLA_HOST}" "netstat -un | grep -E '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | grep -v '127.0.0.1'"
    } | \
    awk -v timestamp="$(date -Iseconds)" '
    BEGIN { 
        print "["; 
        first=1 
    }
    /[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/ {
        split($4, local, ":")
        split($5, remote, ":")
        
        # Determine which IP is external (not private)
        ext_ip = ""
        ext_port = ""
        local_addr = ""
        local_port_val = ""
        
        # Check if local IP is external
        if (local[1] !~ /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|127\.)/) {
            ext_ip = local[1]
            ext_port = local[2]
            local_addr = remote[1]
            local_port_val = remote[2]
        }
        # Check if remote IP is external
        else if (remote[1] !~ /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|127\.)/) {
            ext_ip = remote[1]
            ext_port = remote[2]  
            local_addr = local[1]
            local_port_val = local[2]
        }
        
        # Only output if we found a valid external IP
        if (ext_ip != "" && ext_ip != "0.0.0.0") {
            if (first != 1) print ","
            first = 0
            printf "    {\"timestamp\": \"%s\", \"type\": \"netstat\", \"local_ip\": \"%s\", \"local_port\": \"%s\", \"external_ip\": \"%s\", \"external_port\": \"%s\", \"state\": \"%s\", \"collected_at\": \"%s\"}", 
                   timestamp, local_addr, local_port_val, ext_ip, ext_port, $6, timestamp
        }
    }
    END { print "\n]" }
    ' > "${output_file}"
    
    log "Current connections saved to: ${output_file}"
}

# Collect comprehensive scan/probe detection
collect_scan_detection() {
    local output_file="${DATA_DIR}/scans_probes_$(date +%Y%m%d_%H%M%S).json"
    
    log "Collecting scan/probe detection data..."
    
    {
        echo "["
        local first=true
        
        # 1. Check for recent SSH connection attempts (successful and failed)
        ssh "${FIREWALLA_USER}@${FIREWALLA_HOST}" "sudo grep -i 'sshd.*connection' /var/log/auth.log 2>/dev/null | tail -20" 2>/dev/null | while read line; do
            if [[ "$first" == true ]]; then
                first=false
            else
                echo ","
            fi
            echo -n "    {\"type\": \"ssh_attempt\", \"log_entry\": \"$line\", \"timestamp\": \"$(date -Iseconds)\", \"collected_at\": \"$(date -Iseconds)\"}"
        done
        
        # 2. Check for port scans in FireRouter logs  
        ssh "${FIREWALLA_USER}@${FIREWALLA_HOST}" "grep -i 'scan\|probe\|nmap' /home/pi/logs/FireRouter*.log 2>/dev/null | tail -10" 2>/dev/null | while read line; do
            echo ","
            echo -n "    {\"type\": \"scan_detection\", \"log_entry\": \"$line\", \"timestamp\": \"$(date -Iseconds)\", \"collected_at\": \"$(date -Iseconds)\"}"
        done
        
        # 3. Check kernel logs for blocked connections
        ssh "${FIREWALLA_USER}@${FIREWALLA_HOST}" "sudo dmesg | grep -E 'DROP|REJECT|blocked' | tail -10" 2>/dev/null | while read line; do
            echo ","
            echo -n "    {\"type\": \"kernel_block\", \"log_entry\": \"$line\", \"timestamp\": \"$(date -Iseconds)\", \"collected_at\": \"$(date -Iseconds)\"}"
        done
        
        echo ""
        echo "]"
    } > "${output_file}"
    
    log "Scan/probe data saved to: ${output_file}"
}

# Enhanced real-time connection monitoring
collect_realtime_connections() {
    local output_file="${DATA_DIR}/realtime_connections_$(date +%Y%m%d_%H%M%S).json"
    
    log "Collecting real-time connection data..."
    
    # Get comprehensive connection data from Firewalla
    {
        echo "["
        local first=true
        
        # All TCP connections (not just established)
        ssh "${FIREWALLA_USER}@${FIREWALLA_HOST}" "ss -tuln4 | grep -v '127.0.0.1'" | while read line; do
            if echo "$line" | grep -qE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+'; then
                if [[ "$first" == true ]]; then
                    first=false
                else
                    echo ","
                fi
                echo -n "    {\"type\": \"listening_port\", \"data\": \"$line\", \"timestamp\": \"$(date -Iseconds)\", \"collected_at\": \"$(date -Iseconds)\"}"
            fi
        done
        
        # Active connections with process info
        ssh "${FIREWALLA_USER}@${FIREWALLA_HOST}" "sudo netstat -tulnp | grep -E 'tcp|udp' | grep -E '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+'" | while read line; do
            echo ","
            echo -n "    {\"type\": \"active_connection\", \"data\": \"$line\", \"timestamp\": \"$(date -Iseconds)\", \"collected_at\": \"$(date -Iseconds)\"}"
        done
        
        echo ""
        echo "]"
    } > "${output_file}"
    
    log "Real-time connections saved to: ${output_file}"
}

# Collect VPN connection information
collect_vpn_connections() {
    local output_file="${DATA_DIR}/vpn_connections_$(date +%Y%m%d_%H%M%S).json"
    
    log "Collecting VPN connection data..."
    
    {
        echo "["
        local first=true
        
        # Check Wireguard connections and extract endpoint IPs
        ssh "${FIREWALLA_USER}@${FIREWALLA_HOST}" "sudo wg show all 2>/dev/null" | while read line; do
            if [[ "$line" =~ endpoint:\ ([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+):([0-9]+) ]]; then
                local endpoint_ip="${BASH_REMATCH[1]}"
                local endpoint_port="${BASH_REMATCH[2]}"
                
                if [[ "$first" == true ]]; then
                    first=false
                else
                    echo ","
                fi
                echo -n "    {\"type\": \"wireguard_endpoint\", \"external_ip\": \"$endpoint_ip\", \"external_port\": \"$endpoint_port\", \"timestamp\": \"$(date -Iseconds)\", \"collected_at\": \"$(date -Iseconds)\"}"
            fi
        done
        
        # Check for VPN-related UDP traffic on common VPN ports
        ssh "${FIREWALLA_USER}@${FIREWALLA_HOST}" "netstat -un | awk '/51820|1194|500|4500/ {print}'" | while read line; do
            if [[ "$line" =~ ([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+):([0-9]+)\ +([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+):([0-9]+) ]]; then
                local local_ip="${BASH_REMATCH[1]}"
                local local_port="${BASH_REMATCH[2]}"
                local remote_ip="${BASH_REMATCH[3]}"
                local remote_port="${BASH_REMATCH[4]}"
                
                # Determine external IP
                local external_ip=""
                if [[ ! "$remote_ip" =~ ^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|127\.) ]]; then
                    external_ip="$remote_ip"
                fi
                
                if [[ -n "$external_ip" ]]; then
                    echo ","
                    echo -n "    {\"type\": \"vpn_udp\", \"external_ip\": \"$external_ip\", \"external_port\": \"$remote_port\", \"local_ip\": \"$local_ip\", \"local_port\": \"$local_port\", \"timestamp\": \"$(date -Iseconds)\", \"collected_at\": \"$(date -Iseconds)\"}"
                fi
            fi
        done
        
        echo ""
        echo "]"
    } > "${output_file}"
    
    log "VPN connections saved to: ${output_file}"
}

# Collect outbound connections (connections initiated FROM internal network TO external)
collect_outbound_connections() {
    local output_file="${DATA_DIR}/outbound_connections_$(date +%Y%m%d_%H%M%S).json"
    
    log "Collecting outbound connections..."
    
    {
        echo "["
        local first=true
        
        # Get outbound connections - connections where our internal IP initiated to external
        ssh "${FIREWALLA_USER}@${FIREWALLA_HOST}" "netstat -tn | grep 'ESTABLISHED\|SYN_SENT\|FIN_WAIT'" | while read line; do
            # Parse the netstat line: Proto Recv-Q Send-Q Local Address Foreign Address State
            if [[ $line =~ ([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+):([0-9]+)\ +([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+):([0-9]+)\ +(.*) ]]; then
                local local_ip="${BASH_REMATCH[1]}"
                local local_port="${BASH_REMATCH[2]}"
                local remote_ip="${BASH_REMATCH[3]}"
                local remote_port="${BASH_REMATCH[4]}"
                local state="${BASH_REMATCH[5]}"
                
                # Check if this is outbound (local IP is internal, remote is external)
                if [[ "$local_ip" =~ ^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.) ]] && 
                   [[ ! "$remote_ip" =~ ^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|127\.) ]]; then
                    
                    # Skip if remote IP is our WAN IP (not truly outbound)
                    if [[ "$remote_ip" != "$WAN_IP" ]]; then
                        if [[ "$first" == true ]]; then
                            first=false
                        else
                            echo ","
                        fi
                        echo -n "    {\"timestamp\": \"$(date -Iseconds)\", \"local_ip\": \"$local_ip\", \"local_port\": \"$local_port\", \"external_ip\": \"$remote_ip\", \"external_port\": \"$remote_port\", \"state\": \"$state\", \"direction\": \"outbound\", \"collected_at\": \"$(date -Iseconds)\"}"
                    fi
                fi
            fi
        done
        
        # Also check for outbound UDP connections (like DNS, etc.)
        ssh "${FIREWALLA_USER}@${FIREWALLA_HOST}" "ss -u -n | grep -E '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+'" | while read line; do
            if [[ $line =~ ([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+):([0-9]+)\ +([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+):([0-9]+) ]]; then
                local local_ip="${BASH_REMATCH[1]}"
                local local_port="${BASH_REMATCH[2]}"
                local remote_ip="${BASH_REMATCH[3]}"
                local remote_port="${BASH_REMATCH[4]}"
                
                # Check if this is outbound UDP
                if [[ "$local_ip" =~ ^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.) ]] && 
                   [[ ! "$remote_ip" =~ ^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|127\.) ]] &&
                   [[ "$remote_ip" != "$WAN_IP" ]]; then
                    
                    echo ","
                    echo -n "    {\"timestamp\": \"$(date -Iseconds)\", \"local_ip\": \"$local_ip\", \"local_port\": \"$local_port\", \"external_ip\": \"$remote_ip\", \"external_port\": \"$remote_port\", \"state\": \"UDP\", \"direction\": \"outbound\", \"collected_at\": \"$(date -Iseconds)\"}"
                fi
            fi
        done
        
        echo ""
        echo "]"
    } > "${output_file}"
    
    log "Outbound connections saved to: ${output_file}"
}

# Collect connection tracking table data (comprehensive NAT and connection info)
collect_connection_tracking() {
    local output_file="${DATA_DIR}/connection_tracking_$(date +%Y%m%d_%H%M%S).json"
    
    log "Collecting connection tracking data..."
    
    {
        echo "["
        local first=true
        
        # Get all active connections from the connection tracking table
        ssh "${FIREWALLA_USER}@${FIREWALLA_HOST}" "sudo cat /proc/net/nf_conntrack" | while read line; do
            # Parse conntrack format: ipv4 2 tcp 6 431999 ESTABLISHED src=A dst=B sport=X dport=Y packets=P bytes=B src=C dst=D sport=Z dport=W packets=Q bytes=R [ASSURED] mark=M zone=Z use=U
            
            if [[ $line =~ ipv4.*tcp.*src=([0-9.]+).*dst=([0-9.]+).*sport=([0-9]+).*dport=([0-9]+).*packets=([0-9]+).*bytes=([0-9]+).*src=([0-9.]+).*dst=([0-9.]+).*sport=([0-9]+).*dport=([0-9]+).*packets=([0-9]+).*bytes=([0-9]+) ]]; then
                local orig_src="${BASH_REMATCH[1]}"
                local orig_dst="${BASH_REMATCH[2]}"
                local orig_sport="${BASH_REMATCH[3]}"
                local orig_dport="${BASH_REMATCH[4]}"
                local orig_packets="${BASH_REMATCH[5]}"
                local orig_bytes="${BASH_REMATCH[6]}"
                local reply_src="${BASH_REMATCH[7]}"
                local reply_dst="${BASH_REMATCH[8]}"
                local reply_sport="${BASH_REMATCH[9]}"
                local reply_dport="${BASH_REMATCH[10]}"
                local reply_packets="${BASH_REMATCH[11]}"
                local reply_bytes="${BASH_REMATCH[12]}"
                
                # Extract connection state
                local state=""
                if [[ $line =~ (ESTABLISHED|SYN_SENT|SYN_RECV|FIN_WAIT|CLOSE_WAIT|LAST_ACK|TIME_WAIT|CLOSE|LISTEN) ]]; then
                    state="${BASH_REMATCH[1]}"
                fi
                
                # Determine if this is inbound or outbound based on source/destination
                local direction=""
                local external_ip=""
                local internal_ip=""
                local external_port=""
                local internal_port=""
                
                # Check if original source is internal (outbound connection)
                if [[ "$orig_src" =~ ^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.) ]]; then
                    # Outbound connection: internal -> external
                    if [[ ! "$orig_dst" =~ ^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|127\.) ]] && [[ "$orig_dst" != "$WAN_IP" ]]; then
                        direction="outbound"
                        external_ip="$orig_dst"
                        internal_ip="$orig_src"
                        external_port="$orig_dport"
                        internal_port="$orig_sport"
                    fi
                # Check if reply source is external (inbound connection)
                elif [[ ! "$reply_src" =~ ^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|127\.) ]] && [[ "$reply_src" != "$WAN_IP" ]]; then
                    # Inbound connection: external -> internal (via NAT/port forwarding)
                    direction="inbound"
                    external_ip="$reply_src"
                    internal_ip="$orig_dst"
                    external_port="$reply_sport"
                    internal_port="$orig_dport"
                fi
                
                # Only include if we have a valid external connection
                if [[ -n "$direction" && -n "$external_ip" ]]; then
                    if [[ "$first" == true ]]; then
                        first=false
                    else
                        echo ","
                    fi
                    
                    echo -n "    {\"timestamp\": \"$(date -Iseconds)\", \"direction\": \"$direction\", \"external_ip\": \"$external_ip\", \"external_port\": \"$external_port\", \"internal_ip\": \"$internal_ip\", \"internal_port\": \"$internal_port\", \"state\": \"$state\", \"orig_packets\": $orig_packets, \"orig_bytes\": $orig_bytes, \"reply_packets\": $reply_packets, \"reply_bytes\": $reply_bytes, \"type\": \"connection_tracking\", \"collected_at\": \"$(date -Iseconds)\"}"
                fi
            fi
        done
        
        echo ""
        echo "]"
    } > "${output_file}"
    
    log "Connection tracking data saved to: ${output_file}"
}

# Collect threat intelligence data from FireMain logs
collect_threat_intel() {
    local output_file="${DATA_DIR}/threat_intel_$(date +%Y%m%d_%H%M%S).json"
    
    log "Collecting threat intelligence data from FireMain logs..."
    
    {
        echo "["
        local first=true
        
        # Extract threat intelligence data with IP, subdomain, and domain info
        ssh "${FIREWALLA_USER}@${FIREWALLA_HOST}" "grep 'DestIPFoundHook.*d: [0-9]' /home/pi/logs/FireMain*.log | tail -200" | while read line; do
            # Extract timestamp and intel data from format:
            # 2025-09-09 09:38:39 ERROR DestIPFoundHook: got error when calling intel proxy, err: Error: socket hang up d: 146.75.78.73,p19-oec-ttp.tiktokcdn-us.com,tiktokcdn-us.com
            if [[ $line =~ ^[^:]*:([0-9]{4}-[0-9]{2}-[0-9]{2}\ [0-9]{2}:[0-9]{2}:[0-9]{2}).*d:\ ([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+),?([^,]*),?([^,]*)$ ]]; then
                local timestamp="${BASH_REMATCH[1]}"
                local external_ip="${BASH_REMATCH[2]}"
                local subdomain="${BASH_REMATCH[3]}"
                local domain="${BASH_REMATCH[4]}"
                
                # Only process external (non-private) IPs
                if [[ ! "$external_ip" =~ ^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|127\.) ]]; then
                    if [[ "$first" == true ]]; then
                        first=false
                    else
                        echo ","
                    fi
                    
                    # Clean up domain fields (remove trailing whitespace)
                    subdomain=$(echo "$subdomain" | tr -d ' ')
                    domain=$(echo "$domain" | tr -d ' ')
                    
                    echo -n "    {\"timestamp\": \"$timestamp\", \"external_ip\": \"$external_ip\", \"subdomain\": \"$subdomain\", \"domain\": \"$domain\", \"type\": \"threat_intel\", \"source\": \"DestIPFoundHook\", \"collected_at\": \"$(date -Iseconds)\"}"
                fi
            fi
        done
        
        echo ""
        echo "]"
    } > "${output_file}"
    
    log "Threat intelligence data saved to: ${output_file}"
}

# Enhanced FireMain parsing for additional external IP patterns
collect_enhanced_firemain() {
    local output_file="${DATA_DIR}/enhanced_firemain_$(date +%Y%m%d_%H%M%S).json"
    
    log "Collecting enhanced FireMain data for additional external IP patterns..."
    
    local temp_file=$(mktemp)
    
    # Get broader external IP patterns from FireMain logs (not just BroDetect)
    ssh "${FIREWALLA_USER}@${FIREWALLA_HOST}" "grep -E '[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}' /home/pi/logs/FireMain*.log | tail -500" > "${temp_file}"
    
    {
        echo "["
        local first=true
        
        while read line; do
            # Extract timestamp from the beginning of the line
            if [[ $line =~ ^[^:]*:([0-9]{4}-[0-9]{2}-[0-9]{2}\ [0-9]{2}:[0-9]{2}:[0-9]{2}) ]]; then
                local timestamp="${BASH_REMATCH[1]}"
                
                # Extract log level and component
                local log_level=""
                local component=""
                if [[ $line =~ (INFO|ERROR|WARN|DEBUG)\ ([^:]+): ]]; then
                    log_level="${BASH_REMATCH[1]}"
                    component="${BASH_REMATCH[2]}"
                fi
                
                # Extract first external IP address from the line
                local ip=$(echo "$line" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' | head -1)
                
                # Skip private IPs
                if [[ -n "$ip" && ! "$ip" =~ ^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|127\.) ]]; then
                    if [[ "$first" == true ]]; then
                        first=false
                    else
                        echo ","
                    fi
                    
                    echo -n "    {\"timestamp\": \"$timestamp\", \"external_ip\": \"$ip\", \"log_level\": \"$log_level\", \"component\": \"$component\", \"type\": \"enhanced_firemain\", \"collected_at\": \"$(date -Iseconds)\"}"
                fi
            fi
        done < "${temp_file}"
        
        echo ""
        echo "]"
    } > "${output_file}"
    
    rm -f "${temp_file}"
    
    log "Enhanced FireMain data saved to: ${output_file}"
}

# Comprehensive collection function
main() {
    log "Starting comprehensive WAN connection monitoring collection..."
    
    collect_firemain_ips
    collect_current_connections
    collect_scan_detection
    collect_realtime_connections
    
    # Cleanup old files (keep last 24 hours)
    find "${DATA_DIR}" -name "*.json" -mtime +1 -delete 2>/dev/null || true
    
    log "Comprehensive collection completed successfully"
}

# Enhanced collection for real-time monitoring
collect_all() {
    log "Starting FULL monitoring collection (all data sources)..."
    
    collect_firemain_ips
    collect_current_connections
    collect_scan_detection
    collect_realtime_connections
    collect_vpn_connections
    collect_outbound_connections
    collect_connection_tracking
    collect_threat_intel
    collect_enhanced_firemain
    
    log "Full collection completed - check data directory for all files"
}

# Handle script arguments
case "${1:-}" in
    "--firemain")
        collect_firemain_ips
        ;;
    "--current")
        collect_current_connections
        ;;
    "--scans")
        collect_scan_detection
        ;;
    "--realtime")
        collect_realtime_connections
        ;;
    "--outbound")
        collect_outbound_connections
        ;;
    "--conntrack")
        collect_connection_tracking
        ;;
    "--threat-intel")
        collect_threat_intel
        ;;
    "--enhanced-firemain")
        collect_enhanced_firemain
        ;;
    "--all")
        collect_all
        ;;
    "--help")
        echo "Usage: $0 [OPTIONS]"
        echo "Data Collection Options:"
        echo "  --firemain    Collect from FireMain logs only"
        echo "  --current     Collect current connections only"  
        echo "  --scans       Collect scan/probe detection only"
        echo "  --realtime    Collect real-time connection data only"
        echo "  --outbound    Collect outbound connections only"
        echo "  --conntrack   Collect connection tracking table data only"
        echo "  --threat-intel  Collect threat intelligence data from FireMain logs"
        echo "  --enhanced-firemain  Collect additional external IPs from FireMain logs"
        echo "  --all         Run ALL collection methods (comprehensive)"
        echo "  --help        Show this help"
        echo "  (no args)     Run standard comprehensive collection"
        echo ""
        echo "Examples:"
        echo "  $0                    # Standard collection"
        echo "  $0 --all             # Maximum data collection" 
        echo "  $0 --scans           # Just scan detection"
        exit 0
        ;;
    "")
        main
        ;;
    *)
        echo "Unknown option: $1"
        echo "Use --help for usage information"
        exit 1
        ;;
esac