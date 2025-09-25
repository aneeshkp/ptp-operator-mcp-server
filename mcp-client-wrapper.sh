#!/bin/bash
# MCP Client Wrapper - Connects Claude Desktop to in-cluster MCP server

# Port forward in background if not already running
if ! pgrep -f "port-forward.*ptp-mcp-server" > /dev/null; then
    echo "Starting port forward to MCP server..." >&2
    oc port-forward svc/ptp-mcp-server 3000:3000 -n openshift-ptp &
    PF_PID=$!
    
    # Wait for port forward to be ready
    sleep 3
    
    # Cleanup on exit
    trap "kill $PF_PID 2>/dev/null" EXIT
fi

# Connect to the forwarded MCP server
exec nc localhost 3000
