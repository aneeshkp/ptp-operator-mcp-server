### docs/API.md
```markdown
# API Documentation

## Available Tools

### Core Monitoring Tools

#### `list_ptp_pods`
Lists all PTP daemon pods with their status.

**Parameters:**
- `namespace` (optional): Default `openshift-ptp`
- `labelSelector` (optional): Default `app=linuxptp-daemon`

#### `get_daemon_logs`
Analyzes linuxptp-daemon-container logs.

**Parameters:**
- `namespace` (optional): Default `openshift-ptp`
- `podName` (optional): Specific pod name
- `tailLines` (optional): Default 500
- `searchPattern` (optional): Search term
- `sinceMinutes` (optional): Default 30

#### `get_ptp_metrics`
Fetches Prometheus metrics from localhost:9091/metrics.

**Parameters:**
- `namespace` (optional): Default `openshift-ptp`
- `podName` (optional): Specific pod name
- `filterMetric` (optional): Filter for specific metric
- `format` (optional): `raw`, `parsed`, or `summary`

### Configuration Tools

#### `get_ptp_configs`
Queries PtpConfig custom resources.

**Parameters:**
- `namespace` (optional): Default `openshift-ptp`
- `configName` (optional): Specific config name
- `includeStatus` (optional): Default true

#### `get_node_ptp_configs`
Gets NodePtpDevice resources.

**Parameters:**
- `nodeName` (optional): Specific node name

### Analysis Tools

#### `analyze_ptp_faults`
Comprehensive fault analysis.

**Parameters:**
- `namespace` (optional): Default `openshift-ptp`
- `podName` (optional): Specific pod name
- `sinceHours` (optional): Default 2

#### `check_ptp_status`
Overall health check.

**Parameters:**
- `namespace` (optional): Default `openshift-ptp`
- `detailed` (optional): Default false

### Execution Tools

#### `exec_ptp_command`
Execute commands in containers.

**Parameters:**
- `namespace` (optional): Default `openshift-ptp`
- `podName` (optional): Specific pod name
- `container` (optional): Container name
- `command` (array): Command to execute

## Response Format

All tools return content in this format:
```json
{
  "content": [
    {
      "type": "text", 
      "text": "Response content"
    }
  ]
}
