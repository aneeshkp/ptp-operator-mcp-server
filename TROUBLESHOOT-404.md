# Troubleshooting PTP Agent 404 Subscription Error

## Problem
The PTP agent is failing to subscribe to the publisher endpoint with a 404 error:
```
WARNING - Subscription failed for http://ptp-event-publisher-service-cnfdg33.openshift-ptp.svc.cluster.local:9043: 404
```

## Root Cause Analysis

The 404 error indicates that the PTP event publisher service either:
1. **Doesn't exist** - Service not deployed
2. **Wrong API version** - Using v1 endpoint when v2 is configured (most common)
3. **Wrong endpoint** - Incorrect URL or port
4. **Not ready** - Service exists but endpoint not available
5. **Different naming** - Service has different name pattern

**Note**: Your PtpOperatorConfig shows `apiVersion: "2.0"`, which means the agent should use `/api/cloudNotifications/v2/` endpoints, not `/api/cloudNotifications/v1/`.

## Troubleshooting Steps

### 1. Check PTP Event Publisher Services

```bash
# Login to cluster first
oc login

# Check for PTP event publisher services
oc get svc -n openshift-ptp | grep -i publisher
oc get svc -n openshift-ptp | grep -i event

# Check all services in openshift-ptp namespace
oc get svc -n openshift-ptp

# Look for services with port 9043
oc get svc -n openshift-ptp -o wide | grep 9043
```

### 2. Check PTP Operator Deployment

```bash
# Check if PTP operator is running
oc get pods -n openshift-ptp

# Check PTP daemon pods specifically
oc get pods -n openshift-ptp -l app=linuxptp-daemon

# Check cloud-event-proxy container in daemon pods
oc describe pod -n openshift-ptp -l app=linuxptp-daemon | grep -A5 -B5 cloud-event-proxy
```

### 3. Verify Cloud Event Proxy Configuration

```bash
# Check if cloud-event-proxy is configured to create publisher services
oc logs -n openshift-ptp -l app=linuxptp-daemon -c cloud-event-proxy | grep -i publisher

# Check for any service creation logs
oc logs -n openshift-ptp -l app=linuxptp-daemon -c cloud-event-proxy | grep -i service
```

### 4. Check PTP Configuration

```bash
# Check PtpConfig resources
oc get ptpconfigs -n openshift-ptp

# Check if cloud events are enabled in PTP config
oc get ptpconfigs -n openshift-ptp -o yaml | grep -A10 -B10 -i event
```

## Common Solutions

### Solution 1: PTP Event Publisher Not Enabled

If the publisher services don't exist, you need to enable cloud events in your PTP configuration:

```yaml
apiVersion: ptp.openshift.io/v1
kind: PtpConfig
metadata:
  name: your-ptp-config
  namespace: openshift-ptp
spec:
  profile:
  - name: "grandmaster"
    # ... your PTP config ...
    ptpClockThreshold:
      holdOverTimeout: 30
      maxOffsetThreshold: 100
      minOffsetThreshold: -100
    # Enable cloud events
    ptpSettings:
      logLevel: 2
    # Cloud event configuration
    plugins:
      e810:
        enableDefaultConfig: false
      # Enable cloud event proxy
      cloudEventProxy:
        publisherAddress: "http://ptp-event-publisher-service"
        transportHost: "http://ptp-event-publisher-service-NODE_NAME.openshift-ptp.svc.cluster.local:9043"
```

### Solution 2: Manual Service Creation

If services should exist but don't, you may need to create them manually:

```bash
# Create publisher service for each node
for NODE in $(oc get nodes -l node-role.kubernetes.io/worker -o jsonpath='{.items[*].metadata.name}'); do
  NODE_HOSTNAME=$(echo $NODE | cut -d. -f1)
  cat <<EOF | oc apply -f -
apiVersion: v1
kind: Service
metadata:
  name: ptp-event-publisher-service-${NODE_HOSTNAME}
  namespace: openshift-ptp
spec:
  selector:
    app: linuxptp-daemon
    kubernetes.io/hostname: ${NODE}
  ports:
  - name: event-publisher
    port: 9043
    targetPort: 9043
    protocol: TCP
  type: ClusterIP
EOF
done
```

### Solution 3: Update Agent Discovery Logic

If the service naming pattern is different, update the agent:

```python
# In ptp_agent.py, modify the endpoint discovery
async def discover_publisher_endpoints(self) -> List[str]:
    endpoints = []
    try:
        # Check actual service names first
        services = self.k8s_core.list_namespaced_service(namespace=self.ptp_namespace)
        
        for svc in services.items:
            if 'publisher' in svc.metadata.name.lower() or 'event' in svc.metadata.name.lower():
                for port in svc.spec.ports or []:
                    if port.port == 9043:
                        endpoint = f"http://{svc.metadata.name}.{self.ptp_namespace}.svc.cluster.local:{port.port}"
                        endpoints.append(endpoint)
                        logger.info(f"Discovered publisher endpoint: {endpoint}")
        
        # Fallback to node-based discovery if no services found
        if not endpoints:
            # ... existing node-based logic ...
```

## Verification Steps

After implementing fixes:

### 1. Test Publisher Endpoint Directly

```bash
# Check PTP API version first
oc get ptpoperatorconfig -n openshift-ptp -o jsonpath='{.items[0].spec.ptpEventConfig.apiVersion}'

# Test API v2 endpoint (default for apiVersion 2.0)
oc exec -it deployment/ptp-agent -n ptp-agent -- curl -v http://ptp-event-publisher-service-cnfdg33.openshift-ptp.svc.cluster.local:9043/api/ocloudNotifications/v2/health

# Test API v1 endpoint (if apiVersion 1.0)
oc exec -it deployment/ptp-agent -n ptp-agent -- curl -v http://ptp-event-publisher-service-cnfdg33.openshift-ptp.svc.cluster.local:9043/api/ocloudNotifications/v1/health

# Test subscription endpoint (v2)
oc exec -it deployment/ptp-agent -n ptp-agent -- curl -v -X POST http://ptp-event-publisher-service-cnfdg33.openshift-ptp.svc.cluster.local:9043/api/ocloudNotifications/v2/subscriptions \
  -H "Content-Type: application/json" \
  -d '{"Id": "test-123", "Resource": "/cluster/node/*/sync/sync-status/sync-state", "EndpointUri": "http://test:8080/event"}'
```

### 2. Check Agent Logs

```bash
# Watch for successful subscriptions
oc logs -f deployment/ptp-agent -n ptp-agent | grep -i subscription

# Look for incoming events (after successful subscription)
oc logs -f deployment/ptp-agent -n ptp-agent | grep -i "received event"
```

### 3. Verify Event Flow

```bash
# Check if cloud-event-proxy is sending events
oc logs -n openshift-ptp -l app=linuxptp-daemon -c cloud-event-proxy | grep "event sent"

# Check if events reach the agent
curl http://localhost:8081/summary  # Via port-forward
```

## Next Steps

1. **Run the troubleshooting commands** to identify the root cause
2. **Apply the appropriate solution** based on findings
3. **Restart the agent** after making changes
4. **Verify successful subscription** in agent logs

The most likely issue is that cloud events aren't enabled in your PTP configuration, or the publisher services weren't created automatically.
