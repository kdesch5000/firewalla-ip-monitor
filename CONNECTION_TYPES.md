# Connection Types Documentation

This document explains the different connection types captured and displayed by the Firewalla IP Monitor system.

## Overview

The system categorizes network connections into security-focused types based on their source, destination, and characteristics. Each connection type has a specific color representation on the map for immediate visual threat assessment.

## Connection Type Categories

### 🔍 Network Reconnaissance (Hot Pink #ff0066)
**Detection**: `scan_probe` connection type  
**Threat Level**: ⚠️ **HIGH** - Pre-attack behavior

**What it is**: Attackers scanning your network to find vulnerabilities and gather intelligence before launching attacks.

**Examples**:
- Port scans checking what services are running
- Vulnerability scans looking for security holes  
- Network mapping attempts to understand your infrastructure
- Brute force login attempts against various services
- Service enumeration and fingerprinting

**Why it's dangerous**: This represents reconnaissance activity - someone is actively probing your network to find entry points. This is typically the first stage of a cyber attack.

**Response**: Investigate immediately, consider blocking the source IP, review firewall rules.

---

### 🎯 Direct Firewalla Attacks (Red #ff4444)
**Detection**: `firemain_log` connection type  
**Threat Level**: 🚨 **CRITICAL** - Direct security appliance targeting

**What it is**: Traffic specifically targeting the Firewalla security device itself, attempting to compromise your network's primary defense.

**Examples**:
- SSH login attempts to the Firewalla device
- Web admin panel brute force attacks
- Attempts to exploit Firewalla services
- Direct connections to Firewalla management ports
- Firmware or configuration exploitation attempts

**Why it's concerning**: If an attacker compromises your Firewalla, they gain control over your entire network's gateway and can bypass all security controls.

**Response**: Block immediately, review admin access controls, check for successful logins, consider changing admin passwords.

---

### 💻 Device Network Activity (Blue #0088ff)  
**Detection**: `conntrack_tcp`, `conntrack_udp` connection types  
**Threat Level**: ✅ **NORMAL** - Legitimate device usage

**What it is**: Normal internet usage from devices on your internal network, routed through the Firewalla to reach external destinations.

**Examples**:
- SSH connections to remote servers (like your lakehouse.ooguy.com connection)
- Web browsing from phones, computers, tablets
- Application updates and downloads
- Streaming services (Netflix, YouTube, Spotify)
- Cloud backups and file syncing (Dropbox, iCloud, OneDrive)
- Video calls (Zoom, Teams, FaceTime)
- Gaming connections
- IoT device communications

**Technical Details**:
- Captured via connection tracking (`conntrack -L`) on the Firewalla
- Shows NAT translations: Internal IP → External IP
- Includes both TCP and UDP protocols
- Represents traffic flowing **through** the Firewalla, not **to** it

**Your SSH Example**: 
```
192.168.86.162:51126 → 47.34.44.148:15069 (lakehouse.ooguy.com)
```

**Why it's blue**: This represents legitimate outbound activity from your devices - the digital equivalent of your devices "going out" to use internet services.

---

### ❓ Other Connection Types (Orange #ffaa00)
**Detection**: Various connection types that don't fit main categories  
**Threat Level**: 🔍 **REVIEW** - Requires individual analysis

**What it is**: Network connections with mixed characteristics or specialized protocols that need individual assessment.

**Examples**:
- VPN tunnel endpoints and encrypted tunnels
- Complex multi-protocol applications
- Legacy connection tracking entries
- Peer-to-peer networking protocols
- Specialized industrial or IoT protocols
- Connections with unknown or mixed type classifications

**Why separate**: These connections have legitimate uses but also potential security implications, requiring case-by-case analysis to determine if they're benign or concerning.

**Response**: Review individual connections, understand their purpose, verify they're authorized.

---

### ✅ Normal Traffic (Green #00ff88)
**Detection**: Default category for unclassified connections  
**Threat Level**: ✅ **NORMAL** - Standard internet connectivity

**What it is**: Baseline internet connectivity using standard protocols with no special security characteristics.

**Examples**:
- Basic web traffic (HTTP/HTTPS to standard websites)
- Email protocols (SMTP, IMAP, POP3)
- DNS lookups and responses
- NTP time synchronization
- Standard internet protocols and services
- Routine maintenance traffic

**Why it's green**: Default category for expected, routine internet traffic that doesn't warrant special attention.

## Connection Sources Explained

### Endpoint vs. Routed Traffic
- **Endpoint Traffic**: Firewalla is the source or destination (red/pink categories)
- **Routed Traffic**: Firewalla forwards traffic between internal and external networks (blue category)

### Collection Methods
1. **FireMain Logs** → `firemain_log` type (Red lines)
2. **Netstat Monitoring** → `active_connection` type (Various)  
3. **Connection Tracking** → `conntrack_tcp/udp` type (Blue lines)
4. **Security Scanning** → `scan_probe` type (Hot pink lines)

## Visual Map Reference

| Color | Hex Code | Type | Threat Level | Action |
|-------|----------|------|--------------|--------|
| 🟪 Hot Pink | #ff0066 | Network Reconnaissance | HIGH | Investigate |
| 🔴 Red | #ff4444 | Direct Firewalla Attacks | CRITICAL | Block |
| 🔵 Blue | #0088ff | Device Network Activity | NORMAL | Monitor |
| 🟠 Orange | #ffaa00 | Other Connection Types | REVIEW | Analyze |
| 🟢 Green | #00ff88 | Normal Traffic | NORMAL | Routine |

## Line Thickness
- **Line thickness** indicates connection volume/frequency
- **Line color** indicates security threat level
- Thicker lines = more connections from that IP
- Thinner lines = fewer connections from that IP

## Security Analysis Workflow

1. **Hot Pink/Red Lines**: Immediate attention required
   - Investigate source IPs
   - Check for successful attacks
   - Consider blocking persistent threats

2. **Blue Lines**: Normal monitoring
   - Verify internal devices are authorized
   - Look for unusual patterns or destinations
   - Monitor for data exfiltration patterns

3. **Orange Lines**: Periodic review
   - Understand the purpose of each connection
   - Verify business justification
   - Ensure proper security controls

4. **Green Lines**: Routine oversight
   - Baseline traffic monitoring
   - Capacity planning
   - Performance optimization

## Database Schema

Connection types are stored in the `connections` table:
```sql
connection_type VARCHAR(20) -- Values: 'conntrack_tcp', 'firemain_log', 'scan_probe', etc.
details TEXT               -- Human-readable connection description
direction VARCHAR(10)      -- 'inbound', 'outbound'  
```

## Configuration

Connection type detection can be tuned via:
- Collection script parameters
- Database connection limits
- IP processing limits via API: `/api/collection/config`

---

*Last updated: September 11, 2025*  
*System version: Firewalla IP Monitor with Conntrack Integration*