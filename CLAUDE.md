# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Architecture

This repository contains a **Model Context Protocol (MCP) server** for monitoring and managing OpenShift PTP (Precision Time Protocol) Operator deployments. The system provides multiple implementation approaches:

### Core Components

1. **Node.js MCP Server** (`index.js`) - Primary MCP server implementation
   - Uses `@modelcontextprotocol/sdk` for MCP protocol
   - Kubernetes client integration via `@kubernetes/client-node`
   - Provides comprehensive PTP monitoring tools

2. **Python MCP Server** (`server.py`) - Alternative implementation
   - Uses `mcp.server.fastmcp` framework
   - Same functionality as Node.js version
   - Kubernetes integration via official Python client

3. **PTP Agent** (`ptp_agent.py`) - Autonomous diagnostic agent
   - Real-time event subscription from cloud-event-proxy
   - Intelligent PTP fault analysis and reporting
   - HTTP API for agent interactions

### MCP Tools Architecture

The MCP server exposes specialized tools for PTP monitoring:

- **Pod Management**: `list_ptp_pods` - Discover PTP daemon pods
- **Log Analysis**: `get_daemon_logs`, `get_proxy_logs` - Container log inspection with pattern matching
- **Metrics Collection**: `get_ptp_metrics` - Prometheus metrics from localhost:9091
- **Fault Analysis**: `analyze_ptp_faults` - Multi-pattern fault detection with severity scoring
- **Configuration**: `get_ptp_configs`, `get_node_ptp_configs` - PTP custom resource inspection
- **Execution**: `exec_ptp_command` - Command execution in PTP containers
- **Health Checks**: `check_ptp_status` - Comprehensive health assessment

## Development Commands

### Node.js Server
```bash
# Install dependencies
npm install

# Start MCP server (stdio transport)
npm start
# or
node index.js

# Start HTTP transport version
npm run start:http
# or
node index-tcp.js

# Development with debugging
npm run dev
# or
node --inspect index.js
```

### Python Server
```bash
# Setup virtual environment
python3 -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Run Python MCP server
python server.py

# Run PTP agent
python ptp_agent.py
```

### Testing and Validation
```bash
# Test cluster connectivity
kubectl get pods -n openshift-ptp -l app=linuxptp-daemon

# Verify MCP protocol
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node index.js

# Check permissions
kubectl auth can-i get pods -n openshift-ptp
kubectl auth can-i get pods/log -n openshift-ptp
kubectl auth can-i create pods/exec -n openshift-ptp

# Install with automated checks
./scripts/install.sh
```

## Deployment Architecture

### Recommended Setup (Hybrid)
- **MCP Server** (`index.js`) runs locally for direct Claude Desktop integration
- **PTP Agent** (`ptp_agent.py`) runs in-cluster (`ptp-agent-system` namespace) for real-time event monitoring
- MCP server connects to remote Kubernetes cluster via KUBECONFIG
- Agent provides in-cluster diagnostics and event subscription via cloud-event-proxy
- Agent communicates across namespaces: monitors `openshift-ptp`, runs in `ptp-agent-system`

### Alternative Deployments
- Dockerfiles provided for both agent (`Dockerfile.agent`) and MCP server (`Dockerfile.mcp`)
- Kubernetes manifests in `k8s/` directory
- Full in-cluster deployment possible if needed

### Claude Desktop Integration
For the recommended local MCP server setup, add to Claude Desktop config:
```json
{
  "mcpServers": {
    "ptp-operator": {
      "command": "node",
      "args": ["/path/to/ptp-operator-mcp-server/index.js"],
      "env": {
        "KUBECONFIG": "/path/to/your/.kube/config",
        "PTP_AGENT_URL": "http://ptp-agent.ptp-agent-system.svc.cluster.local:8081"
      }
    }
  }
}
```

## Code Conventions

### Error Handling
- Always wrap Kubernetes API calls in try-catch blocks
- Return structured error responses via MCP protocol
- Log errors to stderr (won't interfere with stdio MCP transport)

### PTP-Specific Patterns
- Default namespace: `openshift-ptp`
- Target containers: `linuxptp-daemon-container`, `cloud-event-proxy`
- Metrics endpoint: `localhost:9091/metrics` within daemon containers
- Custom resources: `PtpConfig`, `NodePtpDevice`

### Kubernetes API Usage
- Use label selector `app=linuxptp-daemon` for pod discovery
- Prefer CustomObjectsApi for PTP CRDs
- Stream logs with tail limits (default 500 lines)
- Execute commands via Exec API for metrics collection

## Key Dependencies

### Node.js
- `@modelcontextprotocol/sdk` - MCP protocol implementation
- `@kubernetes/client-node` - Kubernetes API client
- `express` - HTTP server for TCP transport
- `cors` - CORS middleware

### Python
- `mcp` - MCP framework
- `kubernetes` - Official Kubernetes Python client
- `aiohttp` - Async HTTP client for agent
- `pyyaml` - YAML processing

## Important Notes

- Tests and linting are not implemented (`npm test`, `npm run lint` are placeholders)
- The system requires PTP Operator to be deployed in target cluster
- **Recommended**: Run `index.js` locally + `ptp_agent.py` in-cluster for optimal functionality
- Agent service integration via PTP_AGENT_URL environment variable
- Multiple transport methods supported: stdio (default) and HTTP
- Python MCP server (`server.py`) is alternative implementation, agent (`ptp_agent.py`) is production component
- to memorize