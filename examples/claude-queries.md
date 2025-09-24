# Example Claude Queries

## Basic Monitoring
- "How many PTP pods are running and what's their status?"
- "Show me any FAULTY states in the daemon logs from the last hour"
- "Get me the interface_role metrics from all PTP pods"

## Fault Analysis
- "Analyze PTP faults and tell me how many FAULTY states occurred in the last 2 hours"
- "Search daemon logs for SLAVE keyword and count occurrences"
- "Check if there are any high offset values in the metrics"

## Configuration
- "Show me all PtpConfig resources and their specifications"
- "What PTP devices are available on each node?"
- "Get the ptp4l configuration from the running daemon pods"

## Troubleshooting
- "Execute 'curl localhost:9091/metrics | grep interface_role' in daemon containers"
- "Show me recent events related to PTP pods that might indicate issues"
- "Run 'ps aux | grep ptp' to see all PTP processes"

## Advanced Monitoring
- "Give me a comprehensive health report of the entire PTP deployment"
- "Monitor cloud-event-proxy logs for any error messages"
- "Check PTP synchronization status across all pods"
