# PTP Operator MCP Server

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![OpenShift](https://img.shields.io/badge/OpenShift-PTP-red.svg)](https://docs.openshift.com/container-platform/latest/networking/ptp/about-ptp.html)

A specialized Model Context Protocol (MCP) server for monitoring and managing **OpenShift PTP Operator** deployments. This server provides Claude with comprehensive tools to monitor PTP daemons, analyze logs, check metrics, and manage PTP configurations.

![PTP MCP Server Demo](https://via.placeholder.com/800x400/1a1a1a/ffffff?text=PTP+MCP+Server+Dashboard)

## ✨ Features

### 🔍 **Smart PTP Monitoring**
- **FAULTY State Detection**: Automatically count and analyze FAULTY occurrences in daemon logs
- **Real-time Metrics**: Fetch and parse Prometheus metrics from `localhost:9091/metrics`
- **Log Pattern Matching**: Search logs for SLAVE, MASTER, LISTENING states with intelligent analysis
- **Health Assessment**: Comprehensive health scoring (HEALTHY/MINOR/MODERATE/CRITICAL)

### 🏗️ **Container-Specific Analysis**
- **`linuxptp-daemon-container`**: Primary PTP daemon monitoring with fault analysis
- **`cloud-event-proxy`**: Event proxy log analysis and monitoring
- **Flexible Pod Selection**: Auto-discover pods or target specific instances

### ⚙️ **Configuration Management**
- **PtpConfig CRs**: Query and analyze PtpConfig custom resources
- **NodePtpDevice**: Check PTP hardware availability across cluster nodes  
- **Config File Access**: Read `ptp4l.conf` and `phc2sys.conf` from running pods
- **Process Monitoring**: View running PTP processes and their status

### 📊 **Advanced Analytics**
- **Metrics Parsing**: Human-readable interpretation of interface_role, clock_state, offset metrics
- **Fault Pattern Detection**: Detect timeouts, unreachable states, high offsets
- **Event Correlation**: Link pod issues with Kubernetes events
- **State Transition Tracking**: Monitor PTP state changes over time

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- OpenShift/Kubernetes cluster access with PTP Operator deployed
- Existing KUBECONFIG with permissions to openshift-ptp namespace

### Installation

```bash
# Clone the repository
git clone https://github.com/aneeshkp/ptp-operator-mcp-server.git
cd ptp-operator-mcp-server

# Run the installation script
chmod +x scripts/install.sh
./scripts/install.sh
```

### Configure Claude Desktop

Add to your Claude Desktop configuration file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Linux**: `~/.config/claude-desktop/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "ptp-operator": {
      "command": "node",
      "args": ["/path/to/ptp-operator-mcp-server/index.js"]
    }
  }
}
```

### Verify Installation

```bash
# Test cluster access
kubectl get pods -n openshift-ptp -l app=linuxptp-daemon

# Test the MCP server
node index.js
# Should show: "PTP Operator MCP Server running on stdio"
```

## 🛠️ Available Tools

### Core Monitoring Tools

| Tool | Description | Key Features |
|------|-------------|--------------|
| **`list_ptp_pods`** | List all PTP daemon pods | Pod status, container health, node placement |
| **`get_daemon_logs`** | Analyze daemon container logs | FAULTY detection, pattern search, auto-analysis |
| **`get_proxy_logs`** | Monitor cloud-event-proxy logs | Event analysis, error detection |
| **`analyze_ptp_faults`** | Comprehensive fault analysis | Multi-pattern fault detection, severity assessment |
| **`get_ptp_metrics`** | Fetch Prometheus metrics | Parsed metrics, interface roles, clock states |
| **`check_ptp_status`** | Overall health assessment | Pod health, log summary, metrics overview |

### Configuration Tools

| Tool | Description | Key Features |
|------|-------------|--------------|
| **`get_ptp_configs`** | Query PtpConfig CRs | Configuration specs, status information |
| **`get_node_ptp_configs`** | Check NodePtpDevice CRs | Hardware discovery, device capabilities |
| **`get_ptp_config`** | Access config files | ptp4l.conf, phc2sys.conf, process status |

### Execution & Events

| Tool | Description | Key Features |
|------|-------------|--------------|
| **`exec_ptp_command`** | Execute commands in containers | curl metrics, process inspection, debugging |
| **`monitor_ptp_events`** | Track Kubernetes events | PTP-related events, error correlation |

## 💬 Example Claude Interactions

### Basic Monitoring
```
"How many PTP pods are running and what's their status?"
"Show me any FAULTY states in daemon logs from the last hour"
"Get interface_role metrics from all PTP daemon pods"
```

### Fault Analysis
```
"Analyze PTP faults in the last 2 hours and tell me how many FAULTY states occurred"
"Search daemon logs for SLAVE keyword and count occurrences"
"Check if there are any high offset values in the metrics"
```

### Troubleshooting
```
"Execute 'curl localhost:9091/metrics | grep clock_state' in daemon containers"
"Show me recent Kubernetes events related to PTP pods"
"Get comprehensive health report of entire PTP deployment"
```

### Configuration Analysis
```
"Show me all PtpConfig resources and their specifications"
"What PTP hardware devices are available on each node?"
"Get ptp4l and phc2sys configuration from running daemon pods"
```

## 📋 Tool Reference

### `get_daemon_logs`
Analyze linuxptp-daemon-container logs with intelligent pattern matching.

**Parameters:**
- `namespace`: PTP namespace (default: `openshift-ptp`)
- `podName`: Specific pod (optional - auto-selects first available)
- `tailLines`: Lines to retrieve (default: 500)
- `searchPattern`: Search term (e.g., "FAULTY", "SLAVE", "MASTER")
- `sinceMinutes`: Time window (default: 30 minutes)

**Example Output:**
```
=== SEARCH ANALYSIS for "FAULTY" ===
Found 15 occurrences
Matched lines:
2024-01-15T10:30:25.123Z ptp4l[1234]: [port] FAULTY to LISTENING on FAULT_DETECTED
2024-01-15T10:31:30.456Z ptp4l[1234]: [port] FAULTY to LISTENING on FAULT_CLEARED

=== AUTOMATIC PTP LOG ANALYSIS ===
FAULTY states: 15
SLAVE states: 45
MASTER states: 0
LISTENING states: 30
Errors found: 3
Warnings found: 8
State changes: 12
```

### `get_ptp_metrics`
Fetch and parse Prometheus metrics from daemon containers.

**Parameters:**
- `namespace`: PTP namespace (default: `openshift-ptp`)
- `podName`: Specific pod (optional)
- `filterMetric`: Filter for specific metrics (e.g., "interface_role", "clock_state")
- `format`: Output format - `raw`, `parsed`, or `summary` (default: `parsed`)

**Example Output:**
```
=== INTERFACE ROLES ===
{interface="ens8f0",node="worker-1"} = ACTIVE
{interface="ens8f1",node="worker-1"} = INACTIVE

=== CLOCK STATES ===
{interface="ens8f0",node="worker-1"} = SLAVE
{interface="ens8f1",node="worker-1"} = LISTENING

=== OFFSET FROM MASTER (nanoseconds) ===
{interface="ens8f0",node="worker-1"} = 45ns (Normal)
```

### `analyze_ptp_faults`
Perform comprehensive fault analysis with severity assessment.

**Parameters:**
- `namespace`: PTP namespace (default: `openshift-ptp`)
- `podName`: Specific pod (optional)
- `sinceHours`: Analysis window (default: 2 hours)

**Example Output:**
```
=== DETAILED FAULT ANALYSIS ===
FAULTY: 15 occurrences
  Examples:
  2024-01-15T10:30:25Z ptp4l[1234]: port 1: FAULTY to LISTENING on FAULT_DETECTED

TIMEOUT: 3 occurrences
  Examples:
  2024-01-15T10:25:10Z ptp4l[1234]: timed out while polling for tx timestamp

OFFSET_HIGH: 2 occurrences
  Examples:
  2024-01-15T10:20:15Z ptp4l[1234]: master offset 1500000 s2 freq -22000

OVERALL FAULT COUNT: 20
STATUS: MODERATE ISSUES - Several faults detected
```

## 🔧 Development & Extension

### Adding Custom Tools

1. **Add tool definition** to the tools list in `setupHandlers()`:
```javascript
{
  name: 'my_custom_tool',
  description: 'Custom PTP monitoring tool',
  inputSchema: {
    type: 'object',
    properties: {
      // Define parameters
    }
  }
}
```

2. **Add handler** in the switch statement:
```javascript
case 'my_custom_tool':
  return await this.myCustomTool(args);
```

3. **Implement the method**:
```javascript
async myCustomTool(args) {
  // Your implementation
  return {
    content: [{
      type: 'text',
      text: 'Tool output'
    }]
  };
}
```

### Extending Log Analysis

Add new fault patterns in `performFaultAnalysis()`:
```javascript
const faultPatterns = {
  // Existing patterns...
  custom_error: /my custom error pattern/i,
  performance_issue: /performance.*degraded/i,
};
```

### Custom Metrics Parsing

Extend `summarizeMetrics()` for new metric types:
```javascript
if (metrics['my_custom_metric']) {
  summary += '\n=== MY CUSTOM METRICS ===\n';
  // Custom parsing logic
}
```

## 🔒 Security & Permissions

### Required KUBECONFIG Permissions
Your cluster credentials need these permissions:
- **Pods**: `get`, `list` (discover PTP pods)
- **Pods/log**: `get` (read container logs)  
- **Pods/exec**: `create` (execute commands for metrics)
- **Events**: `get`, `list` (monitor cluster events)
- **Custom Resources**: `get`, `list` for `ptpconfigs`, `nodeptpdevices`

### Permission Verification
```bash
# Test required permissions
kubectl auth can-i get pods -n openshift-ptp
kubectl auth can-i get pods/log -n openshift-ptp
kubectl auth can-i create pods/exec -n openshift-ptp
kubectl auth can-i get ptpconfigs -n openshift-ptp
kubectl auth can-i get nodeptpdevices
```

### Production Deployment
For production deployments inside the cluster, see `examples/production-rbac.yaml` for service account configuration.

## 🚨 Troubleshooting

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| "No PTP pods found" | PTP operator not deployed | `kubectl get pods -n openshift-ptp` |
| "Metrics unavailable" | Port 9091 not accessible | Check daemon container health |
| "Permission denied" | Insufficient RBAC | Verify KUBECONFIG permissions |
| "Custom resource not found" | PTP CRDs not installed | Ensure PTP operator is deployed |

### Debug Mode
```bash
# Run with debugging
node --inspect index.js

# Check MCP protocol communication
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node index.js
```

### Log Analysis
The server logs errors to stderr (won't interfere with MCP protocol):
```bash
# Check for issues
node index.js 2>debug.log
```

## 🤝 Contributing

We welcome contributions! Here's how to help:

1. **Fork the repository**
2. **Create feature branch**: `git checkout -b feature/amazing-feature`
3. **Make changes and test** with your PTP deployment
4. **Commit changes**: `git commit -m 'Add amazing feature'`
5. **Push to branch**: `git push origin feature/amazing-feature`
6. **Open Pull Request**

### Development Setup
```bash
git clone https://github.com/aneeshkp/ptp-operator-mcp-server.git
cd ptp-operator-mcp-server
npm install
# Make changes and test with: node index.js
```

## 📚 Documentation

- **[Setup Guide](docs/SETUP.md)** - Detailed installation instructions
- **[API Reference](docs/API.md)** - Complete tool documentation  
- **[Troubleshooting](docs/TROUBLESHOOTING.md)** - Common issues and solutions
- **[Examples](examples/)** - Usage examples and configuration files

## 🔗 Related Projects

- **[PTP Operator](https://github.com/openshift/ptp-operator)** - OpenShift PTP Operator
- **[LinuxPTP](http://linuxptp.sourceforge.net/)** - Linux PTP implementation
- **[Model Context Protocol](https://modelcontextprotocol.io/)** - MCP specification
- **[Claude Desktop](https://claude.ai/desktop)** - Claude desktop application

## 📈 Roadmap

- [ ] **Web Dashboard** - Optional web interface for PTP monitoring
- [ ] **Alert Integration** - Webhook notifications for critical PTP events
- [ ] **Historical Analysis** - Long-term PTP performance trending
- [ ] **Multi-cluster Support** - Monitor PTP across multiple clusters
- [ ] **Custom Dashboards** - Configurable monitoring views

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- **OpenShift PTP Team** - For the excellent PTP Operator
- **Anthropic** - For the Model Context Protocol and Claude
- **LinuxPTP Community** - For the robust PTP implementation
- **Kubernetes Community** - For the client libraries

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/aneeshkp/ptp-operator-mcp-server/issues)
- **Discussions**: [GitHub Discussions](https://github.com/aneeshkp/ptp-operator-mcp-server/discussions)
- **PTP Documentation**: [OpenShift PTP Docs](https://docs.openshift.com/container-platform/latest/networking/ptp/about-ptp.html)

---

**Made with ❤️ for the OpenShift PTP Community**

*Star ⭐ this repo if you find it helpful!*