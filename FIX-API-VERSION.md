# Fix: PTP Agent API Version Issue

## Problem Identified ✅

Your PTP operator is configured with **API version 2.0** but the agent was trying to use **API version 1.0** endpoints:

```yaml
# Your PtpOperatorConfig
spec:
  ptpEventConfig:
    apiVersion: "2.0"  # ← This means use /api/cloudNotifications/v2/
    enableEventPublisher: true
```

But the agent was calling:
```
http://ptp-event-publisher-service-cnfdg33.openshift-ptp.svc.cluster.local:9043/api/cloudNotifications/v1/subscriptions
```

Instead of:
```
http://ptp-event-publisher-service-cnfdg33.openshift-ptp.svc.cluster.local:9043/api/ocloudNotifications/v2/subscriptions
```

**Note**: The correct API path is `ocloudNotifications` (not `cloudNotifications`).

## Solution Implemented ✅

I've updated the PTP agent to:

1. **Auto-detect API version** from PtpOperatorConfig
2. **Try v2 first** (since it's the default for apiVersion 2.0)
3. **Fallback to v1** if v2 fails
4. **Log which version succeeds** for debugging

### Updated Code Features

- `get_ptp_api_version()` - Reads PtpOperatorConfig to determine correct API version
- Smart fallback logic in `subscribe_to_endpoint()`
- Better logging to show which API version is used

## Deploy the Fix

### Option 1: Rebuild and Redeploy (Recommended)

```bash
# 1. Rebuild agent image with the fix
docker build -f Dockerfile.agent -t ptp-agent:v1.1 .
docker tag ptp-agent:v1.1 quay.io/your-username/ptp-agent:v1.1
docker push quay.io/your-username/ptp-agent:v1.1

# 2. Update deployment
oc patch deployment ptp-agent -n ptp-agent -p '{"spec":{"template":{"spec":{"containers":[{"name":"ptp-agent","image":"quay.io/your-username/ptp-agent:v1.1"}]}}}}'

# 3. Watch for successful subscription
oc logs -f deployment/ptp-agent -n ptp-agent | grep -E "(subscription|API|Successfully)"
```

### Option 2: Quick Restart (If using latest tag)

```bash
# If your image uses 'latest' tag, just restart
oc rollout restart deployment/ptp-agent -n ptp-agent
oc logs -f deployment/ptp-agent -n ptp-agent
```

## Expected Results

After the fix, you should see logs like:

```
INFO - Successfully subscribed to http://ptp-event-publisher-service-cnfdg33.openshift-ptp.svc.cluster.local:9043 using API v2
INFO - Successfully subscribed to 1/1 endpoints
```

Instead of:
```
WARNING - Subscription failed for http://ptp-event-publisher-service-cnfdg33.openshift-ptp.svc.cluster.local:9043: 404
```

## Verification Commands

### Test the Fixed Endpoint

```bash
# Test v2 endpoint (should work now)
oc exec -it deployment/ptp-agent -n ptp-agent -- curl -v http://ptp-event-publisher-service-cnfdg33.openshift-ptp.svc.cluster.local:9043/api/ocloudNotifications/v2/health

# Test subscription (should return 201)
oc exec -it deployment/ptp-agent -n ptp-agent -- curl -v -X POST \
  http://ptp-event-publisher-service-cnfdg33.openshift-ptp.svc.cluster.local:9043/api/ocloudNotifications/v2/subscriptions \
  -H "Content-Type: application/json" \
  -d '{"Id": "test-123", "Resource": "/cluster/node/*/sync/sync-status/sync-state", "EndpointUri": "http://ptp-agent.ptp-agent.svc.cluster.local:8080/event"}'
```

### Check Agent Status

```bash
# Check subscription status
oc logs deployment/ptp-agent -n ptp-agent | grep -i subscription

# Check for incoming events (after successful subscription)
oc logs -f deployment/ptp-agent -n ptp-agent | grep -i "received event"

# Test MCP integration
oc port-forward svc/ptp-agent 8081:8081 -n ptp-agent &
curl http://localhost:8081/alerts
curl http://localhost:8081/summary
```

## Why This Happened

The PTP operator supports both API versions:
- **v1**: Legacy API (`apiVersion: "1.0"`)
- **v2**: Current API (`apiVersion: "2.0"` - default)

Your operator config uses `apiVersion: "2.0"`, so the cloud-event-proxy exposes `/api/cloudNotifications/v2/` endpoints, not `/api/cloudNotifications/v1/`.

The agent now automatically detects this from your PtpOperatorConfig and uses the correct version! 🎯
