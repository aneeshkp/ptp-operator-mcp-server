#!/bin/bash

set -e

echo "🚀 Installing PTP Operator MCP Server..."

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 18+ first."
    exit 1
fi

# Check Node.js version
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Node.js version 18 or higher is required. Current version: $(node -v)"
    exit 1
fi

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Make the script executable
echo "🔧 Making script executable..."
chmod +x index.js

# Check if kubectl/oc is available and test permissions
if command -v oc &> /dev/null; then
    echo "✅ OpenShift CLI (oc) found"
    KUBE_CMD="oc"
elif command -v kubectl &> /dev/null; then
    echo "✅ Kubernetes CLI (kubectl) found"  
    KUBE_CMD="kubectl"
else
    echo "❌ Error: Neither oc nor kubectl found. Please install one of them."
    exit 1
fi

# Check cluster access and permissions
echo "🔍 Checking cluster access..."
if ! $KUBE_CMD cluster-info &> /dev/null; then
    echo "❌ Cannot connect to cluster. Check your KUBECONFIG:"
    echo "   export KUBECONFIG=/path/to/your/kubeconfig"
    exit 1
fi

echo "✅ Connected to cluster: $($KUBE_CMD config current-context)"

# Test openshift-ptp namespace access
if $KUBE_CMD get pods -n openshift-ptp &> /dev/null; then
    echo "✅ Can access openshift-ptp namespace"
    PTP_PODS=$($KUBE_CMD get pods -n openshift-ptp -l app=linuxptp-daemon --no-headers 2>/dev/null | wc -l)
    echo "📊 Found $PTP_PODS PTP daemon pods"
else
    echo "⚠️  Warning: Cannot access openshift-ptp namespace."
    echo "   Make sure you have permissions or PTP operator is installed."
fi

# Test required permissions
echo "🔐 Checking required permissions..."
PERMISSIONS_OK=true

if ! $KUBE_CMD auth can-i get pods -n openshift-ptp &> /dev/null; then
    echo "❌ Missing permission: get pods in openshift-ptp"
    PERMISSIONS_OK=false
fi

if ! $KUBE_CMD auth can-i get pods/log -n openshift-ptp &> /dev/null; then
    echo "❌ Missing permission: get pods/log in openshift-ptp"
    PERMISSIONS_OK=false
fi

if ! $KUBE_CMD auth can-i create pods/exec -n openshift-ptp &> /dev/null; then
    echo "❌ Missing permission: create pods/exec in openshift-ptp"
    PERMISSIONS_OK=false
fi

if $PERMISSIONS_OK; then
    echo "✅ All required permissions verified"
else
    echo "⚠️  Some permissions are missing. MCP server may have limited functionality."
fi

echo ""
echo "✅ Installation complete!"
echo ""
echo "📖 Next steps:"
echo "1. Add this server to your Claude Desktop config:"
echo "   ~/.config/claude-desktop/claude_desktop_config.json (Linux)"
echo "   ~/Library/Application Support/Claude/claude_desktop_config.json (macOS)"
echo ""
echo "2. Add this configuration:"
echo '   {
     "mcpServers": {
       "ptp-operator": {
         "command": "node",
         "args": ["'$(pwd)'/index.js"]
       }
     }
   }'
echo ""
echo "3. Restart Claude Desktop"
echo ""
echo "4. If you encounter permission issues, check:"
echo "   $KUBE_CMD auth can-i get pods -n openshift-ptp"
echo "   $KUBE_CMD auth can-i get pods/log -n openshift-ptp" 
echo "   $KUBE_CMD auth can-i create pods/exec -n openshift-ptp"
