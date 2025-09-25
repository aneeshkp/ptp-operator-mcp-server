# Namespace Configuration Changes

## Overview

The PTP Agent now runs in its own dedicated namespace `ptp-agent` instead of `openshift-ptp`. This provides better isolation and security.

## Namespace Structure

```
┌─────────────────────────────┐
│     openshift-ptp           │  ← PTP Operator & Daemon Pods
│  - linuxptp-daemon pods     │
│  - cloud-event-proxy        │
│  - ptp-event-publisher-*    │
└─────────────────────────────┘
              ↓ (subscribes to events)
┌─────────────────────────────┐
│     ptp-agent               │  ← PTP Agent Service
│  - ptp-agent deployment     │
│  - MCP integration API      │
│  - Event analysis & alerts  │
└─────────────────────────────┘
```

## Environment Variables

### PTP Agent (`ptp_agent.py`)
- `PTP_NAMESPACE`: Namespace where PTP operator runs (default: `openshift-ptp`)
- `AGENT_NAMESPACE`: Namespace where agent runs (default: `ptp-agent`)

### MCP Server (`index.js`)
- `PTP_AGENT_URL`: URL to agent service (default: `http://ptp-agent.ptp-agent.svc.cluster.local:8081`)

## Updated Files

### Agent Configuration
- ✅ `ptp_agent.py`: Uses separate namespaces for PTP and agent
- ✅ `ptp-agent-deployment.yaml`: Deploys to `ptp-agent` namespace
- ✅ `ptp-agent-route.yaml`: Updated namespace
- ✅ `ptp-agent-nodeport.yaml`: Updated namespace

### MCP Server
- ✅ `index.js`: Updated default agent service URL
- ✅ `build-deploy-test.md`: Updated all commands and examples

## Deployment Commands

### Deploy Agent
```bash
# Deploy to ptp-agent namespace
oc apply -f ptp-agent-deployment.yaml

# Check status
oc get pods -n ptp-agent -l app=ptp-agent
oc logs -f deployment/ptp-agent -n ptp-agent
```

### Port Forward
```bash
# Forward agent service to local desktop
oc port-forward svc/ptp-agent 8081:8081 -n ptp-agent
```

### External Access
```bash
# Create route
oc apply -f ptp-agent-route.yaml

# Get URL
AGENT_URL=$(oc get route ptp-agent -n ptp-agent -o jsonpath='{.spec.host}')
echo "Agent URL: https://$AGENT_URL"
```

## Claude Desktop Configuration

### Local MCP Server (Port Forward)
```json
{
  "mcpServers": {
    "ptp-operator": {
      "command": "node",
      "args": ["/path/to/index.js"],
      "env": {
        "KUBECONFIG": "/path/to/kubeconfig",
        "PTP_AGENT_URL": "http://localhost:8081"
      }
    }
  }
}
```

### External Access
```json
{
  "mcpServers": {
    "ptp-operator": {
      "command": "node",
      "args": ["/path/to/index.js"],
      "env": {
        "KUBECONFIG": "/path/to/kubeconfig",
        "PTP_AGENT_URL": "https://ptp-agent-ptp-agent.apps.your-cluster.com"
      }
    }
  }
}
```

## Service Discovery

The agent automatically discovers PTP publisher endpoints:
```
http://ptp-event-publisher-service-{NODE_NAME}.openshift-ptp.svc.cluster.local:9043
```

And registers its consumer endpoint:
```
http://ptp-agent.ptp-agent.svc.cluster.local:8080/event
```

## RBAC Permissions

The agent service account has cluster-wide permissions to:
- Read pods and nodes (discover PTP daemon pods)
- Read daemonsets (find linuxptp-daemon DS)
- Read PTP custom resources (ptpconfigs, nodeptpdevices)
- Access services (for publisher endpoint discovery)

## Benefits

1. **Security Isolation**: Agent runs in separate namespace
2. **Clear Separation**: PTP operator vs. monitoring concerns
3. **Easier Management**: Dedicated namespace for agent resources
4. **Flexible Deployment**: Can deploy agent independently of PTP operator
5. **Multi-tenancy**: Multiple agent instances possible with different namespaces
