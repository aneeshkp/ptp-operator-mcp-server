# PTP Agentic System - Build, Deploy & Test Guide

## Prerequisites

- OpenShift/Kubernetes cluster with PTP operator deployed
- `oc` or `kubectl` CLI configured
- Docker/Podman for building images
- Node.js for local MCP server

## Step 1: Build Container Images

### Build PTP Agent Image

```bash
# Navigate to project directory
cd /home/aputtur/github.com/aneeshkp/ptp-operator-mcp-server

# Build the PTP agent container
docker build -f Dockerfile.agent -t quay.io/aneeshkp/ptp-agent:latest .

# Push to registry
docker push quay.io/aneeshkp/ptp-agent:latest
```

### Build MCP Server Image (Optional - for in-cluster deployment)

```bash
# Create Dockerfile for MCP server
cat > Dockerfile.mcp << 'EOF'
FROM node:18-slim

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY index.js .

# Create non-root user
RUN useradd -r -u 1001 -g root mcpserver
USER mcpserver

EXPOSE 3000

CMD ["node", "index.js"]
EOF

# Build MCP server image
docker build -f Dockerfile.mcp -t ptp-mcp-server:latest .

# Tag and push
docker tag ptp-mcp-server:latest quay.io/your-username/ptp-mcp-server:latest
docker push quay.io/your-username/ptp-mcp-server:latest
```

## Step 2: Update Deployment Files

Update the image references in deployment files:

```bash
# Update PTP agent deployment
sed -i 's|ptp-agent:latest|quay.io/your-username/ptp-agent:latest|' ptp-agent-deployment.yaml

# Update MCP server deployment (if using)
sed -i 's|ptp-mcp-server:latest|quay.io/your-username/ptp-mcp-server:latest|' mcp-server-deployment.yaml
```

## Step 3: Deploy PTP Agent

```bash
# Deploy the PTP agent
oc apply -f ptp-agent-deployment.yaml

# Check deployment status
oc get pods -n ptp-agent -l app=ptp-agent

# Check logs
oc logs -f deployment/ptp-agent -n ptp-agent
```

## Step 4: Verify PTP Agent Health

```bash
# Port forward to test locally
oc port-forward svc/ptp-agent 8080:8080 8081:8081 -n ptp-agent &

# Test health endpoints
curl http://localhost:8080/health  # Consumer endpoint
curl http://localhost:8081/health  # MCP integration endpoint

# Test agent APIs
curl http://localhost:8081/alerts?hours=1
curl http://localhost:8081/summary

# Stop port forward when done
pkill -f "port-forward.*ptp-agent"
```

## Step 5: Configure Local MCP Server

### Option A: Port Forward Approach (Recommended)

```bash
# Start port forward for agent service
oc port-forward svc/ptp-agent 8081:8081 -n ptp-agent &

# Update your Claude Desktop config
mkdir -p ~/.config/claude-desktop
cat > ~/.config/claude-desktop/claude_desktop_config.json << 'EOF'
{
  "mcpServers": {
    "ptp-operator": {
      "command": "node",
      "args": ["/home/aputtur/github.com/aneeshkp/ptp-operator-mcp-server/index.js"],
      "env": {
        "KUBECONFIG": "/home/aputtur/.kube/config",
        "PTP_AGENT_URL": "http://localhost:8081"
      }
    }
  }
}
EOF
```

### Option B: Route/External Access

```bash
# Create route for external access
oc apply -f ptp-agent-route.yaml

# Get the external URL
AGENT_URL=$(oc get route ptp-agent -n ptp-agent -o jsonpath='{.spec.host}')
echo "Agent accessible at: https://$AGENT_URL"

# Update Claude config with external URL
cat > ~/.config/claude-desktop/claude_desktop_config.json << EOF
{
  "mcpServers": {
    "ptp-operator": {
      "command": "node",
      "args": ["/home/aputtur/github.com/aneeshkp/ptp-operator-mcp-server/index.js"],
      "env": {
        "KUBECONFIG": "/home/aputtur/.kube/config",
        "PTP_AGENT_URL": "https://$AGENT_URL"
      }
    }
  }
}
EOF
```

## Step 6: Test MCP Integration

### Test Local MCP Server

```bash
# Test MCP server locally
echo '{"jsonrpc":"2.0","id":"1","method":"tools/list","params":{}}' | node index.js

# Test agent integration
echo '{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"get_agent_alerts","arguments":{"hours":24}}}' | node index.js

# Test agent summary
echo '{"jsonrpc":"2.0","id":"1","method":"tools/call","params":{"name":"get_agent_summary","arguments":{}}}' | node index.js
```

### Test with Claude Desktop

1. **Restart Claude Desktop** after updating the config
2. **Open Claude Desktop**
3. **Test the tools**:
   - "List available tools" (should show agent tools)
   - "Get agent alerts for the last 24 hours"
   - "Show me the PTP agent summary"
   - "Get critical alerts from the PTP agent"

## Step 6.5: Enable Continuous Monitoring (Optional)

### Start Real-Time Monitoring
```bash
# In Claude Desktop, ask:
"Start PTP monitoring with 2-minute intervals"
# or for faster alerting:
"Start PTP monitoring with 30-second intervals and WARNING level alerts"
```

### Expected Alert Behavior

The PTP agent now generates **immediate alerts** for any state changes:

#### 🔴 **CRITICAL Alerts (Immediate Response)**
- **FREERUN state**: Complete synchronization loss
- **Clock class ≥248**: Poor/no synchronization
- **FAULTY state**: Hardware issues
- **GNSS/GPS Issues**: ANTENNA-DISCONNECTED, ANTENNA-SHORT-CIRCUIT, NO-FIX, SURVEY-FAIL
- **OS Clock FREERUN**: System clock synchronization lost

#### 🟡 **WARNING Alerts (Immediate Response)**
- **HOLDOVER state**: Temporary sync reference loss
- **Clock class changes**: 6→7, 6→248, any deviation
- **State transitions**: Any change from LOCKED
- **OS Clock HOLDOVER**: Temporary system clock sync loss

#### 🔵 **INFO Alerts (Immediate Response)**
- **LOCKED state**: Recovery notifications
- **Clock class 6**: Return to optimal sync
- **GNSS/GPS Recovery**: LOCKED, TRACKING states
- **OS Clock Recovery**: System clock sync restored

#### 📊 **Pattern Alerts (Historical Analysis)**
- **Persistent issues**: FREERUN >5min, frequent changes >10/hour
- **Performance degradation**: High offsets >100ns

### Test Alert Generation
```bash
# Create a test state change (if possible in your environment)
# Watch for immediate alerts in Claude Desktop

# Check alert history
curl http://localhost:8081/alerts?hours=1

# Verify monitoring status in Claude Desktop
"Get monitoring status"
```

### Monitoring Commands
- **"Get monitoring status"** - Current monitoring state and alert count
- **"Stop PTP monitoring"** - End continuous monitoring
- **"Show recent alerts and history"** - Review alert timeline
- **"Check the PTP alerts resource"** - Get immediate unread alerts (MCP resource notifications)
- **"Show me ptp://alerts/current"** - Direct resource access for latest alerts

### MCP Resource Notifications (NEW)
The system now sends **automatic notifications** to Claude Desktop when new alerts occur:

1. **Background monitoring** detects new PTP events
2. **MCP resource notification** sent to Claude Desktop
3. **User checks alerts**: "Check the PTP alerts resource"
4. **Immediate response**: See all unread alerts with details

**Benefits**:
- ✅ Real-time notifications when alerts occur
- ✅ Rich alert details with node, severity, recommendations
- ✅ Unread tracking (only shows new alerts)
- ✅ Complete alert history available

## Step 7: Monitor and Troubleshoot

### Check Agent Subscriptions

```bash
# Check agent logs for subscription status
oc logs -f deployment/ptp-agent -n ptp-agent | grep -i subscription

# Check for event reception
oc logs -f deployment/ptp-agent -n ptp-agent | grep -i "received event"

# Check for alerts
oc logs -f deployment/ptp-agent -n ptp-agent | grep -i alert
```

### Verify PTP Events Flow

```bash
# Check if PTP events are being published
oc logs -f ds/linuxptp-daemon -n openshift-ptp -c cloud-event-proxy | grep "event sent"

# Check publisher services exist
oc get svc -n openshift-ptp | grep ptp-event-publisher-service
```

### Debug Agent Issues

```bash
# Get detailed pod info
oc describe pod -l app=ptp-agent -n ptp-agent

# Check service endpoints
oc get endpoints ptp-agent -n ptp-agent

# Test internal connectivity
oc exec -it deployment/ptp-agent -n ptp-agent -- curl -v http://localhost:8080/health
```

## Step 8: Production Configuration

### Configure Slack Alerts (Optional)

```bash
# Create secret with Slack webhook
oc create secret generic ptp-agent-config -n ptp-agent \
  --from-literal=slack-webhook-url="https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK"

# Restart agent to pick up config
oc rollout restart deployment/ptp-agent -n ptp-agent
```

### Configure Alert Thresholds

```bash
# Update deployment with custom thresholds
oc patch deployment ptp-agent -n ptp-agent -p '{
  "spec": {
    "template": {
      "spec": {
        "containers": [{
          "name": "ptp-agent",
          "env": [
            {"name": "ALERT_OFFSET_THRESHOLD", "value": "50"},
            {"name": "ALERT_SYNC_STATES", "value": "FREERUN,FAULTY,HOLDOVER"}
          ]
        }]
      }
    }
  }
}'
```

## Verification Checklist

- [ ] PTP agent pod is running and healthy
- [ ] Agent can discover PTP publisher endpoints
- [ ] Agent successfully subscribes to event publishers
- [ ] Agent receives and processes PTP events
- [ ] MCP server can connect to agent service
- [ ] Claude Desktop shows agent tools in tool list
- [ ] Agent tools return data when called from Claude
- [ ] Alerts are generated for PTP issues (if any exist)

## Troubleshooting Common Issues

### Agent Not Receiving Events
- Check if `ptp-event-publisher-service-*` services exist
- Verify network connectivity between agent and publishers
- Check agent subscription logs

### MCP Integration Fails
- Verify agent service is accessible from MCP server
- Check `PTP_AGENT_URL` environment variable
- Test agent endpoints with curl

### Claude Desktop Issues

#### Common Configuration Errors:
1. **Wrong MCP Server Name**
   ```json
   // ❌ WRONG - Don't use this name
   "ptp-operator-mcp-server": {

   // ✅ CORRECT - Use exactly this name
   "ptp-operator": {
   ```

2. **JSON Syntax Errors**
   ```json
   // ❌ WRONG - Missing comma
   "env": {
     "KUBECONFIG": "/path/to/config",
     "PTP_AGENT_URL": "http://localhost:8081"
   }    // Missing comma here!

   // ✅ CORRECT - Proper syntax
   "env": {
     "KUBECONFIG": "/path/to/config",
     "PTP_AGENT_URL": "http://localhost:8081"
   }
   ```

3. **Agent Connection Issues**
   - Verify port forwarding: `curl http://localhost:8081/health`
   - Check if `PTP_AGENT_URL` environment variable is being used
   - Test MCP server locally: `PTP_AGENT_URL=http://localhost:8081 node index.js`

#### Troubleshooting Steps:
- Restart Claude Desktop after config changes
- Check Claude Desktop logs for MCP errors
- Verify MCP server can start locally
- Validate JSON syntax: `cat ~/.config/claude-desktop/claude_desktop_config.json | jq .`

### Performance Issues
- Monitor agent memory/CPU usage
- Check event buffer size in agent logs
- Consider increasing resource limits if needed
