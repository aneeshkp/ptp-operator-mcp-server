# PTP Agentic AI Service

An intelligent real-time PTP event monitoring and diagnostic service that subscribes to PTP events from cloud-event-proxy and provides AI-powered analysis.

## Architecture

```
┌─────────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Claude Desktop    │◄──►│   MCP Server     │◄──►│  PTP Agent AI   │
│                     │    │   (index.js)     │    │  (ptp_agent.py) │
└─────────────────────┘    └──────────────────┘    └─────────────────┘
                                                            │
                                                            ▼
                           ┌─────────────────────────────────────────────┐
                           │        PTP Event Publishers                 │
                           │  (ptp-event-publisher-service-NODE.svc)    │
                           └─────────────────────────────────────────────┘
                                                            ▲
                                                            │
                           ┌─────────────────────────────────────────────┐
                           │         Cloud Event Proxy                   │
                           │      (in linuxptp-daemon pods)             │
                           └─────────────────────────────────────────────┘
```

## Features

### 🤖 AI-Powered Diagnostics
- **Pattern Recognition**: Detects persistent FREERUN states, frequent state changes, high offsets
- **Predictive Analysis**: Identifies potential issues before they become critical
- **Root Cause Analysis**: Provides actionable recommendations for each alert

### 📡 Real-time Event Subscription
- **Cloud Event Protocol**: Subscribes to PTP events using the same protocol as the [consumer example](https://github.com/redhat-cne/cloud-event-proxy/blob/main/examples/consumer/main.go)
- **Multi-node Support**: Automatically discovers and subscribes to all PTP publisher endpoints
- **Event Buffering**: Maintains recent event history for pattern analysis

### 🔔 Intelligent Alerting
- **Severity Classification**: INFO, WARNING, CRITICAL alerts based on impact
- **Slack Integration**: Optional webhook notifications for critical events
- **Threshold Configuration**: Customizable alert thresholds via environment variables

## Quick Start

### 1. Build and Deploy

```bash
# Build the agent image
docker build -f Dockerfile.agent -t ptp-agent:latest .

# Deploy to OpenShift
oc apply -f ptp-agent-deployment.yaml
```

### 2. Configure MCP Server

Update your Claude Desktop config to include the agent service URL:

```json
{
  "mcpServers": {
    "ptp-operator": {
      "command": "/usr/bin/node",
      "args": ["/path/to/index.js"],
      "env": {
        "KUBECONFIG": "/path/to/kubeconfig",
        "PTP_AGENT_URL": "http://ptp-agent.openshift-ptp.svc.cluster.local:8081"
      }
    }
  }
}
```

### 3. Test Integration

Ask Claude:
- "Get agent alerts for the last 24 hours"
- "Show me the PTP agent summary"
- "Get critical alerts from the PTP agent"

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PTP_NAMESPACE` | `openshift-ptp` | Kubernetes namespace for PTP resources |
| `MCP_INTEGRATION_PORT` | `8081` | Port for MCP server integration |
| `SLACK_WEBHOOK_URL` | - | Slack webhook for alert notifications |
| `ALERT_EVENT_TYPES` | `sync-state,os-clock-sync-state,clock-class` | Event types to monitor |
| `ALERT_SYNC_STATES` | `FREERUN,FAULTY` | Sync states that trigger alerts |
| `ALERT_OFFSET_THRESHOLD` | `100` | Offset threshold in nanoseconds |

### Alert Thresholds

The agent uses intelligent thresholds for different alert types:

- **FREERUN Duration**: 5 minutes of continuous FREERUN state
- **State Changes**: More than 10 state changes per hour
- **High Offset**: Absolute offset > 100ns (configurable)

## Event Subscription Details

The agent follows the same subscription pattern as the [cloud-event-proxy consumer example](https://github.com/redhat-cne/cloud-event-proxy/blob/main/examples/consumer/main.go):

1. **Discovery**: Finds all `linuxptp-daemon` pods and their associated nodes
2. **Subscription**: Creates subscriptions to `http://ptp-event-publisher-service-{NODE_NAME}.openshift-ptp.svc.cluster.local:9043`
3. **Consumer Endpoint**: Runs HTTP server on port 8080 to receive events
4. **Processing**: Parses events and performs real-time analysis

## MCP Integration

The agent exposes two endpoints for MCP server integration:

### `/alerts?hours=24`
Returns recent alerts with diagnostic information:
```json
[
  {
    "severity": "CRITICAL",
    "summary": "Node worker-1 in FREERUN for 8.3 minutes",
    "details": "PTP synchronization lost. Clock is free-running without external reference.",
    "recommendations": [
      "Check network connectivity to PTP grandmaster",
      "Verify PTP configuration on the node"
    ],
    "affected_nodes": ["worker-1"],
    "timestamp": "2025-01-15T10:30:00Z"
  }
]
```

### `/summary`
Returns event summary by node:
```json
{
  "worker-1": {
    "total_events": 45,
    "latest_state": "LOCKED",
    "event_types": ["event.sync.sync-status.synchronization-state-change"]
  }
}
```

## Troubleshooting

### Agent Not Receiving Events

1. **Check Subscriptions**:
```bash
oc logs -f deployment/ptp-agent -n openshift-ptp
```

2. **Verify Publisher Services**:
```bash
oc get svc -n openshift-ptp | grep ptp-event-publisher-service
```

3. **Test Publisher Connectivity**:
```bash
oc exec -it deployment/ptp-agent -n openshift-ptp -- \
  curl -v http://ptp-event-publisher-service-{NODE_NAME}.openshift-ptp.svc.cluster.local:9043/api/cloudNotifications/v1/health
```

### MCP Integration Issues

1. **Check Agent Service**:
```bash
oc port-forward svc/ptp-agent 8081:8081 -n openshift-ptp
curl http://localhost:8081/health
```

2. **Test from MCP Server**:
```bash
echo '{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"get_agent_alerts","arguments":{"hours":1}}}' | node index.js
```

## Development

### Local Testing

```bash
# Install dependencies
pip install -r requirements.txt

# Set environment variables
export PTP_NAMESPACE=openshift-ptp
export KUBECONFIG=/path/to/kubeconfig

# Run the agent
python ptp_agent.py
```

### Adding Custom Diagnostics

Extend the `PTPDiagnosticAgent` class to add new diagnostic patterns:

```python
async def _diagnose_patterns(self, node_name: str, latest_event: PTPEvent):
    # Add custom diagnostic logic
    if self._detect_custom_pattern(events):
        return DiagnosticResult(
            severity='WARNING',
            summary='Custom pattern detected',
            # ... other fields
        )
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Add tests for new diagnostic patterns
4. Submit a pull request

## License

MIT License - see LICENSE file for details.
