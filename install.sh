#!/bin/bash

# Firewalla IP Monitor Installer
# Automated installation and configuration script

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration variables
INSTALL_DIR=""
FIREWALLA_IP=""
FIREWALLA_USER="pi"
DB_MAX_SIZE_GB="10"
DB_MAX_AGE_DAYS="45"
SETUP_SSH_KEY=false
SETUP_SERVICE=false

# Logging functions
log_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

log_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

log_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

log_error() {
    echo -e "${RED}❌ $1${NC}"
}

# Check if running as root
check_root() {
    if [[ $EUID -eq 0 ]]; then
        log_error "Please do not run this installer as root"
        exit 1
    fi
}

# Check system requirements
check_requirements() {
    log_info "Checking system requirements..."
    
    # Check OS
    if ! command -v apt &> /dev/null; then
        log_error "This installer requires Ubuntu/Debian with apt package manager"
        exit 1
    fi
    
    # Check if we can sudo
    if ! sudo -n true 2>/dev/null; then
        log_warning "You'll need sudo privileges for system package installation"
    fi
    
    log_success "System requirements check passed"
}

# Install system dependencies
install_dependencies() {
    log_info "Installing system dependencies..."
    
    # Update package list
    sudo apt update
    
    # Install required packages
    local packages=(
        "nodejs"
        "npm" 
        "sqlite3"
        "ssh"
        "curl"
        "jq"
    )
    
    for package in "${packages[@]}"; do
        if ! dpkg -l "$package" &> /dev/null; then
            log_info "Installing $package..."
            sudo apt install -y "$package"
        else
            log_success "$package is already installed"
        fi
    done
    
    # Check Node.js version
    local node_version=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
    if [[ $node_version -lt 14 ]]; then
        log_warning "Node.js version $node_version detected. Recommended: 14+"
    fi
    
    log_success "Dependencies installed successfully"
}

# Get installation directory
get_install_directory() {
    echo
    log_info "📁 Installation Directory Setup"
    echo "Where would you like to install Firewalla IP Monitor?"
    echo "Press Enter for default: $HOME/firewalla-ip-monitor"
    read -p "> " user_dir
    
    if [[ -n "$user_dir" ]]; then
        INSTALL_DIR="$user_dir"
    else
        INSTALL_DIR="$HOME/firewalla-ip-monitor"
    fi
    
    # Create directory if it doesn't exist
    mkdir -p "$INSTALL_DIR"
    log_success "Installation directory: $INSTALL_DIR"
}

# Get Firewalla configuration
get_firewalla_config() {
    echo
    log_info "🔧 Firewalla Configuration"
    
    # Get Firewalla IP
    echo "What is your Firewalla's IP address?"
    echo "This is typically something like 192.168.1.1 or 192.168.86.1"
    while [[ -z "$FIREWALLA_IP" ]]; do
        read -p "Firewalla IP: " FIREWALLA_IP
        if [[ ! "$FIREWALLA_IP" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
            log_error "Please enter a valid IP address"
            FIREWALLA_IP=""
        fi
    done
    
    # Get SSH username
    echo
    echo "What is the SSH username for your Firewalla? (default: pi)"
    read -p "SSH Username: " input_user
    if [[ -n "$input_user" ]]; then
        FIREWALLA_USER="$input_user"
    fi
    
    log_success "Firewalla configuration: $FIREWALLA_USER@$FIREWALLA_IP"
}

# Get database configuration  
get_database_config() {
    echo
    log_info "💾 Database Configuration"
    
    echo "Maximum database size in GB? (default: 10GB)"
    echo "The database will automatically clean old data when this limit is reached"
    read -p "Max size (GB): " input_size
    if [[ -n "$input_size" ]] && [[ "$input_size" =~ ^[0-9]+$ ]]; then
        DB_MAX_SIZE_GB="$input_size"
    fi
    
    echo
    echo "Maximum data age in days? (default: 45 days)"
    echo "Connection data older than this will be automatically deleted"
    read -p "Max age (days): " input_age
    if [[ -n "$input_age" ]] && [[ "$input_age" =~ ^[0-9]+$ ]]; then
        DB_MAX_AGE_DAYS="$input_age"
    fi
    
    log_success "Database config: ${DB_MAX_SIZE_GB}GB max, ${DB_MAX_AGE_DAYS} days retention"
}

# SSH key setup
setup_ssh_key() {
    echo
    log_info "🔑 SSH Key Setup"
    echo "Do you want to set up SSH key authentication to your Firewalla?"
    echo "This eliminates the need for password authentication"
    read -p "Set up SSH key? (y/N): " setup_key
    
    if [[ "$setup_key" =~ ^[Yy]$ ]]; then
        SETUP_SSH_KEY=true
        
        # Check if SSH key already exists
        if [[ ! -f "$HOME/.ssh/id_rsa" ]]; then
            log_info "Generating SSH key pair..."
            ssh-keygen -t rsa -b 4096 -f "$HOME/.ssh/id_rsa" -N ""
        fi
        
        log_info "Copying SSH key to Firewalla..."
        echo "You'll need to enter your Firewalla password:"
        if ssh-copy-id -i "$HOME/.ssh/id_rsa.pub" "$FIREWALLA_USER@$FIREWALLA_IP"; then
            log_success "SSH key setup completed"
        else
            log_warning "SSH key setup failed. You can set it up manually later."
            SETUP_SSH_KEY=false
        fi
    fi
}

# Test SSH connection
test_ssh_connection() {
    echo
    log_info "🔍 Testing SSH Connection"
    
    if ssh -o ConnectTimeout=10 -o BatchMode=yes "$FIREWALLA_USER@$FIREWALLA_IP" "echo 'SSH connection successful'" &>/dev/null; then
        log_success "SSH connection to Firewalla successful"
        return 0
    else
        log_error "Failed to connect to Firewalla via SSH"
        echo "Please check:"
        echo "  - Firewalla IP address is correct"
        echo "  - SSH is enabled on Firewalla" 
        echo "  - Network connectivity"
        echo "  - SSH key/password authentication"
        return 1
    fi
}

# Copy and configure files
setup_files() {
    echo
    log_info "📄 Setting up application files..."
    
    # Copy all files to install directory
    cp -r "$(dirname "$0")"/* "$INSTALL_DIR/"
    
    # Update configuration in collect_wan_connections.sh
    sed -i "s|FIREWALLA_HOST=\".*\"|FIREWALLA_HOST=\"$FIREWALLA_IP\"|" "$INSTALL_DIR/collect_wan_connections.sh"
    sed -i "s|FIREWALLA_USER=\".*\"|FIREWALLA_USER=\"$FIREWALLA_USER\"|" "$INSTALL_DIR/collect_wan_connections.sh"
    
    # Update database configuration in server.js
    local max_size_mb=$((DB_MAX_SIZE_GB * 1024))
    sed -i "s|maxSizeMB: [0-9]*|maxSizeMB: $max_size_mb|" "$INSTALL_DIR/webapp/server.js"
    sed -i "s|maxAgeDays: [0-9]*|maxAgeDays: $DB_MAX_AGE_DAYS|" "$INSTALL_DIR/webapp/server.js"
    
    # Make scripts executable
    chmod +x "$INSTALL_DIR/collect_wan_connections.sh"
    chmod +x "$INSTALL_DIR/start-monitor.sh"
    
    log_success "Application files configured"
}

# Install Node.js dependencies
install_node_dependencies() {
    echo
    log_info "📦 Installing Node.js dependencies..."
    
    cd "$INSTALL_DIR/webapp"
    npm install --production
    
    log_success "Node.js dependencies installed"
}

# Setup systemd service
setup_systemd_service() {
    echo
    log_info "⚙️ Systemd Service Setup"
    echo "Do you want to set up Firewalla IP Monitor as a system service?"
    echo "This will make it start automatically on boot"
    read -p "Setup service? (Y/n): " setup_service
    
    if [[ ! "$setup_service" =~ ^[Nn]$ ]]; then
        SETUP_SERVICE=true
        
        # Create service file
        sudo tee /etc/systemd/system/firewalla-monitor.service > /dev/null <<EOF
[Unit]
Description=Firewalla IP Monitor
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$INSTALL_DIR/start-monitor.sh
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
        
        # Enable and start service
        sudo systemctl daemon-reload
        sudo systemctl enable firewalla-monitor.service
        
        log_success "Systemd service created and enabled"
    fi
}

# Test installation
test_installation() {
    echo
    log_info "🧪 Testing Installation"
    
    # Test data collection
    log_info "Testing data collection from Firewalla..."
    cd "$INSTALL_DIR"
    if timeout 30 ./collect_wan_connections.sh --firemain; then
        log_success "Data collection test passed"
    else
        log_warning "Data collection test failed - check SSH connectivity"
    fi
    
    # Test web server startup
    log_info "Testing web server startup..."
    cd "$INSTALL_DIR/webapp"
    if timeout 10 node server.js &>/dev/null & then
        local server_pid=$!
        sleep 5
        if kill -0 $server_pid 2>/dev/null; then
            kill $server_pid
            log_success "Web server test passed"
        else
            log_warning "Web server test failed"
        fi
    fi
}

# Show completion summary
show_completion() {
    echo
    log_success "🎉 Installation Complete!"
    echo
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo
    echo "📁 Installation Directory: $INSTALL_DIR"
    echo "🔧 Firewalla: $FIREWALLA_USER@$FIREWALLA_IP"  
    echo "💾 Database: ${DB_MAX_SIZE_GB}GB max, ${DB_MAX_AGE_DAYS} days retention"
    echo "🔑 SSH Key: $([ "$SETUP_SSH_KEY" = true ] && echo "Configured" || echo "Manual setup required")"
    echo "⚙️ System Service: $([ "$SETUP_SERVICE" = true ] && echo "Enabled" || echo "Not configured")"
    echo
    echo "🚀 Getting Started:"
    echo
    if [[ "$SETUP_SERVICE" = true ]]; then
        echo "  Start the service:"
        echo "    sudo systemctl start firewalla-monitor"
        echo
        echo "  Check service status:"
        echo "    sudo systemctl status firewalla-monitor"
    else
        echo "  Start the monitor manually:"
        echo "    cd $INSTALL_DIR && ./start-monitor.sh"
    fi
    echo
    echo "  Access the web interface:"
    echo "    http://localhost:3001"
    echo "    http://$(hostname -I | awk '{print $1}'):3001"
    echo
    echo "📚 Documentation: https://github.com/kdesch5000/firewalla-ip-monitor"
    echo
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

# Main installation flow
main() {
    echo
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "🌐 Firewalla IP Monitor - Automated Installer"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo
    echo "This installer will:"
    echo "  • Install system dependencies (Node.js, SQLite, SSH tools)"
    echo "  • Configure Firewalla connection settings"  
    echo "  • Set up database retention policies"
    echo "  • Configure SSH key authentication (optional)"
    echo "  • Create system service for auto-start (optional)"
    echo "  • Test the installation"
    echo
    read -p "Continue with installation? (Y/n): " continue_install
    if [[ "$continue_install" =~ ^[Nn]$ ]]; then
        echo "Installation cancelled."
        exit 0
    fi
    
    # Run installation steps
    check_root
    check_requirements
    install_dependencies
    get_install_directory
    get_firewalla_config
    get_database_config
    setup_ssh_key
    
    # Only test SSH if we're not in the middle of setting up keys
    if ! test_ssh_connection; then
        echo
        log_warning "SSH connection failed. You may need to:"
        echo "  1. Enable SSH on your Firewalla device"
        echo "  2. Set up SSH key authentication manually"
        echo "  3. Check firewall settings"
        echo
        read -p "Continue with installation anyway? (y/N): " continue_anyway
        if [[ ! "$continue_anyway" =~ ^[Yy]$ ]]; then
            exit 1
        fi
    fi
    
    setup_files
    install_node_dependencies
    setup_systemd_service
    test_installation
    show_completion
}

# Handle Ctrl+C gracefully
trap 'echo; log_error "Installation interrupted"; exit 1' INT

# Run main installation
main "$@"