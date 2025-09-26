#!/usr/bin/env node

/**
 * PTP Operator MCP Server
 * Specialized MCP server for monitoring ptp-operator pods,
 * specifically linuxptp-daemon-container and cloud-event-proxy
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import k8s from '@kubernetes/client-node';
import { Writable } from 'stream';
import { spawn } from 'child_process';

class PTPOperatorMCPServer {
  constructor() {
    this.server = new Server(
      {
        name: 'ptp-operator-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
          resources: {},
          notifications: {
            'resources/changed': {}
          }
        },
      }
    );

    // Initialize Kubernetes client
    this.kc = new k8s.KubeConfig();
    try {
      this.kc.loadFromDefault();
    } catch (error) {
      // Failed to load kubeconfig - continue without logging to avoid breaking MCP
    }

    this.k8sApi = this.kc.makeApiClient(k8s.CoreV1Api);
    this.exec = new k8s.Exec(this.kc);
    this.appsApi = this.kc.makeApiClient(k8s.AppsV1Api);
    this.eventsV1Api = this.kc.makeApiClient(k8s.EventsV1Api);
    
    // Custom Resource API clients
    this.customObjectsApi = this.kc.makeApiClient(k8s.CustomObjectsApi);

    // PTP-specific configurations
    this.ptpNamespace = 'openshift-ptp'; // Default PTP namespace
    this.ptpContainers = {
      daemon: 'linuxptp-daemon-container',
      proxy: 'cloud-event-proxy'
    };
    this.ptpDaemonSetName = 'linuxptp-daemon';
    
    // Agentic service integration with auto port-forward
    this.agentServiceUrl = process.env.PTP_AGENT_URL || 'http://localhost:8081';
    this.agentNamespace = process.env.AGENT_NAMESPACE || 'ptp-agent';
    this.portForwardProcess = null;
    this.portForwardPort = 8081;

    // Enhanced polling configuration
    this.lastAlertCheck = null;
    this.pollingEnabled = false;

    // Monitoring state
    this.monitoringState = {
      active: false,
      intervalId: null,
      intervalSeconds: 10,
      alertSeverity: 'WARNING',
      maxAlerts: 50,
      alertHistory: [],
      lastCheck: null,
      startTime: null
    };

    this.setupHandlers();
    this.setupAgentConnection();
  }

  setupHandlers() {
    // Debug: Log server startup with timestamp
    try {
      const fs = require('fs');
      fs.appendFileSync('/tmp/ptp-mcp-debug.log', `${new Date().toISOString()} - MCP SERVER HANDLERS SETUP - UPDATED CODE v3\n`);
    } catch (e) {}

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'list_ptp_pods',
          description: 'List all PTP operator pods with their status',
          inputSchema: {
            type: 'object',
            properties: {
              namespace: {
                type: 'string',
                description: 'PTP namespace (default: openshift-ptp)',
                default: 'openshift-ptp'
              },
              labelSelector: {
                type: 'string',
                description: 'Label selector for PTP pods (default: app=linuxptp-daemon)',
                default: 'app=linuxptp-daemon'
              }
            }
          }
        },
        {
          name: 'get_ptp_configs',
          description: 'Get PtpConfig custom resources and their status',
          inputSchema: {
            type: 'object',
            properties: {
              namespace: {
                type: 'string',
                description: 'PTP namespace (default: openshift-ptp)',
                default: 'openshift-ptp'
              },
              configName: {
                type: 'string',
                description: 'Specific PtpConfig name (optional)'
              },
              includeStatus: {
                type: 'boolean',
                description: 'Include status information',
                default: true
              }
            }
          }
        },
        {
          name: 'get_node_ptp_configs',
          description: 'Get NodePtpDevice custom resources showing PTP devices on nodes',
          inputSchema: {
            type: 'object',
            properties: {
              nodeName: {
                type: 'string',
                description: 'Specific node name (optional)'
              }
            }
          }
        },
        {
          name: 'get_daemon_logs',
          description: 'Get logs from linuxptp-daemon-container with analysis capabilities',
          inputSchema: {
            type: 'object',
            properties: {
              namespace: {
                type: 'string',
                description: 'PTP namespace (default: openshift-ptp)',
                default: 'openshift-ptp'
              },
              podName: {
                type: 'string',
                description: 'Specific pod name (optional - will use first available if not specified)'
              },
              tailLines: {
                type: 'number',
                description: 'Number of lines to tail (default: 500)',
                default: 500
              },
              searchPattern: {
                type: 'string',
                description: 'Search for specific pattern in logs (e.g., FAULTY, SLAVE, MASTER)'
              },
              sinceMinutes: {
                type: 'number',
                description: 'Get logs from last N minutes (default: 30)',
                default: 30
              }
            }
          }
        },
        {
          name: 'get_proxy_logs',
          description: 'Get logs from cloud-event-proxy container',
          inputSchema: {
            type: 'object',
            properties: {
              namespace: {
                type: 'string',
                description: 'PTP namespace (default: openshift-ptp)',
                default: 'openshift-ptp'
              },
              podName: {
                type: 'string',
                description: 'Specific pod name (optional)'
              },
              tailLines: {
                type: 'number',
                description: 'Number of lines to tail (default: 200)',
                default: 200
              },
              searchPattern: {
                type: 'string',
                description: 'Search for specific pattern in proxy logs'
              }
            }
          }
        },
        {
          name: 'analyze_ptp_faults',
          description: 'Analyze daemon logs for FAULTY states and PTP issues',
          inputSchema: {
            type: 'object',
            properties: {
              namespace: {
                type: 'string',
                description: 'PTP namespace (default: openshift-ptp)',
                default: 'openshift-ptp'
              },
              podName: {
                type: 'string',
                description: 'Specific pod name (optional)'
              },
              sinceHours: {
                type: 'number',
                description: 'Analyze logs from last N hours (default: 2)',
                default: 2
              }
            }
          }
        },
        {
          name: 'get_ptp_metrics',
          description: 'Fetch PTP metrics from daemon pod localhost:9091/metrics',
          inputSchema: {
            type: 'object',
            properties: {
              namespace: {
                type: 'string',
                description: 'PTP namespace (default: openshift-ptp)',
                default: 'openshift-ptp'
              },
              podName: {
                type: 'string',
                description: 'Specific pod name (optional)'
              },
              filterMetric: {
                type: 'string',
                description: 'Filter for specific metric (e.g., interface_role, offset, frequency)'
              },
              format: {
                type: 'string',
                description: 'Output format: raw, parsed, or summary',
                enum: ['raw', 'parsed', 'summary'],
                default: 'parsed'
              }
            }
          }
        },
        {
          name: 'check_ptp_status',
          description: 'Comprehensive PTP status check across all pods',
          inputSchema: {
            type: 'object',
            properties: {
              namespace: {
                type: 'string',
                description: 'PTP namespace (default: openshift-ptp)',
                default: 'openshift-ptp'
              },
              detailed: {
                type: 'boolean',
                description: 'Include detailed metrics and log analysis',
                default: false
              }
            }
          }
        },
        {
          name: 'exec_ptp_command',
          description: 'Execute custom commands in PTP daemon pods',
          inputSchema: {
            type: 'object',
            properties: {
              namespace: {
                type: 'string',
                description: 'PTP namespace (default: openshift-ptp)',
                default: 'openshift-ptp'
              },
              podName: {
                type: 'string',
                description: 'Specific pod name (optional)'
              },
              container: {
                type: 'string',
                description: 'Container name',
                enum: ['linuxptp-daemon-container', 'cloud-event-proxy'],
                default: 'linuxptp-daemon-container'
              },
              command: {
                type: 'array',
                items: { type: 'string' },
                description: 'Command to execute',
                default: ['ps', 'aux']
              }
            }
          }
        },
        {
          name: 'monitor_ptp_events',
          description: 'Monitor PTP events by parsing cloud-event-proxy logs',
          inputSchema: {
            type: 'object',
            properties: {
              namespace: {
                type: 'string',
                description: 'PTP namespace (default: openshift-ptp)',
                default: 'openshift-ptp'
              },
              sinceMinutes: {
                type: 'number',
                description: 'Events from last N minutes (default: 60)',
                default: 60
              }
            }
          }
        },
        {
          name: 'get_ptp_config',
          description: 'Get PTP configuration from pods',
          inputSchema: {
            type: 'object',
            properties: {
              namespace: {
                type: 'string',
                description: 'PTP namespace (default: openshift-ptp)',
                default: 'openshift-ptp'
              },
              podName: {
                type: 'string',
                description: 'Specific pod name (optional)'
              },
              configType: {
                type: 'string',
                description: 'Configuration type to fetch',
                enum: ['ptp4l', 'phc2sys', 'all'],
                default: 'all'
              }
            }
          }
        },
        {
          name: 'diagnose_ptp_issues',
          description: 'AI-powered comprehensive PTP issue diagnosis with actionable recommendations',
          inputSchema: {
            type: 'object',
            properties: {
              namespace: {
                type: 'string',
                description: 'PTP namespace (default: openshift-ptp)',
                default: 'openshift-ptp'
              },
              includeMetrics: {
                type: 'boolean',
                description: 'Include detailed metrics analysis',
                default: true
              },
              severity: {
                type: 'string',
                description: 'Focus on specific severity level',
                enum: ['all', 'critical', 'warning', 'info'],
                default: 'all'
              },
              sinceHours: {
                type: 'number',
                description: 'Analyze data from last N hours (default: 2)',
                default: 2
              },
              includeLogs: {
                type: 'boolean',
                description: 'Include log analysis in diagnosis',
                default: true
              }
            }
          }
        },
        {
          name: 'get_cloud_events',
          description: 'Get and analyze recent cloud events from cloud-event-proxy logs',
          inputSchema: {
            type: 'object',
            properties: {
              namespace: {
                type: 'string',
                description: 'PTP namespace (default: openshift-ptp)',
                default: 'openshift-ptp'
              },
              podName: {
                type: 'string',
                description: 'Specific pod name (optional)'
              },
              count: {
                type: 'number',
                description: 'Number of recent events to retrieve (default: 10)',
                default: 10
              },
              eventType: {
                type: 'string',
                description: 'Filter by event type (optional)',
                enum: ['sync-state', 'lock-state', 'clock-class', 'all'],
                default: 'all'
              },
              sinceMinutes: {
                type: 'number',
                description: 'Events from last N minutes (default: 30)',
                default: 30
              },
              includeMetrics: {
                type: 'boolean',
                description: 'Include cloud-event-proxy metrics',
                default: true
              }
            }
          }
        },
        {
          name: 'get_agent_alerts',
          description: 'Get real-time alerts from PTP agentic service',
          inputSchema: {
            type: 'object',
            properties: {
              hours: {
                type: 'number',
                description: 'Hours of alert history to retrieve (default: 24)',
                default: 24
              },
              severity: {
                type: 'string',
                description: 'Filter by severity level',
                enum: ['INFO', 'WARNING', 'CRITICAL', 'all'],
                default: 'all'
              }
            }
          }
        },
        {
          name: 'get_agent_summary',
          description: 'Get real-time PTP event summary from agentic service',
          inputSchema: {
            type: 'object',
            properties: {
              nodeName: {
                type: 'string',
                description: 'Specific node name (optional)'
              }
            }
          }
        },
        {
          name: 'start_ptp_monitoring',
          description: 'Start continuous PTP monitoring with automatic alerts and summaries',
          inputSchema: {
            type: 'object',
            properties: {
              intervalSeconds: {
                type: 'number',
                description: 'Check interval in seconds (default: 10, minimum: 5)',
                default: 10
              },
              alertSeverity: {
                type: 'string',
                description: 'Minimum severity level to report',
                enum: ['INFO', 'WARNING', 'CRITICAL', 'all'],
                default: 'WARNING'
              },
              maxAlerts: {
                type: 'number',
                description: 'Maximum alerts to track (default: 50)',
                default: 50
              }
            }
          }
        },
        {
          name: 'stop_ptp_monitoring',
          description: 'Stop continuous PTP monitoring',
          inputSchema: {
            type: 'object',
            properties: {}
          }
        },
        {
          name: 'get_monitoring_status',
          description: 'Get current monitoring status and recent alerts',
          inputSchema: {
            type: 'object',
            properties: {
              includeHistory: {
                type: 'boolean',
                description: 'Include alert history in response',
                default: true
              }
            }
          }
        },
        {
          name: 'force_alert_check',
          description: 'Immediately check for new alerts from the agent (useful for testing)',
          inputSchema: {
            type: 'object',
            properties: {}
          }
        },
        {
          name: 'get_alert_notifications',
          description: '🚨 Get immediate alert notifications - shows new alerts as they occur (use MCP resource ptp://alerts/current for auto-updates)',
          inputSchema: {
            type: 'object',
            properties: {
              markAsRead: {
                type: 'boolean',
                description: 'Mark notifications as read after displaying',
                default: true
              }
            }
          }
        }
      ]
    }));

    // Resource handlers
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [
        {
          uri: 'ptp://alerts/current',
          name: 'Current PTP Alerts',
          description: 'Real-time PTP alerts and notifications',
          mimeType: 'application/json'
        }
      ]
    }));

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      
      if (uri === 'ptp://alerts/current') {
        try {
          // Get alerts from monitoring state (more reliable than file)
          const pendingNotifications = this.monitoringState.pendingNotifications || [];
          const unreadAlerts = pendingNotifications.filter(a => !a.displayed);
          const recentAlerts = this.monitoringState.alertHistory.slice(-10);

          const alertSummary = {
            unreadCount: unreadAlerts.length,
            totalHistory: this.monitoringState.alertHistory.length,
            monitoringActive: this.monitoringState.active,
            lastCheck: this.monitoringState.lastCheck,
            unreadAlerts: unreadAlerts.map(alert => ({
              severity: alert.severity,
              summary: alert.summary,
              node: alert.affected_nodes?.[0] || 'unknown',
              timestamp: alert.timestamp,
              notifiedAt: alert.notifiedAt
            })),
            recentHistory: recentAlerts.map(alert => ({
              severity: alert.severity,
              summary: alert.summary,
              timestamp: alert.timestamp
            })),
            lastUpdated: new Date().toISOString()
          };

          return {
            contents: [
              {
                uri: uri,
                mimeType: 'application/json',
                text: JSON.stringify(alertSummary, null, 2)
              }
            ]
          };
        } catch (error) {
          return {
            contents: [
              {
                uri: uri,
                mimeType: 'application/json',
                text: JSON.stringify({ error: error.message }, null, 2)
              }
            ]
          };
        }
      }
      
      throw new McpError(ErrorCode.InvalidRequest, `Unknown resource: ${uri}`);
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'list_ptp_pods':
            return await this.listPTPPods(args);
          case 'get_ptp_configs':
            return await this.getPtpConfigs(args);
          case 'get_node_ptp_configs':
            return await this.getNodePtpConfigs(args);
          case 'get_daemon_logs':
            return await this.getDaemonLogs(args);
          case 'get_proxy_logs':
            return await this.getProxyLogs(args);
          case 'analyze_ptp_faults':
            return await this.analyzePTPFaults(args);
          case 'get_ptp_metrics':
            return await this.getPTPMetrics(args);
          case 'check_ptp_status':
            return await this.checkPTPStatus(args);
          case 'exec_ptp_command':
            return await this.execPTPCommand(args);
          case 'monitor_ptp_events':
            return await this.monitorPTPEvents(args);
          case 'get_ptp_config':
            return await this.getPTPConfig(args);
          case 'diagnose_ptp_issues':
            return await this.diagnosePTPIssues(args);
          case 'get_cloud_events':
            return await this.getCloudEvents(args);
          case 'get_agent_alerts':
            return await this.getAgentAlerts(args);
          case 'get_agent_summary':
            return await this.getAgentSummary(args);
          case 'start_ptp_monitoring':
            return await this.startPTPMonitoring(args);
          case 'stop_ptp_monitoring':
            return await this.stopPTPMonitoring(args);
          case 'get_monitoring_status':
            return await this.getMonitoringStatus(args);
          case 'force_alert_check':
            return await this.forceAlertCheck(args);
          case 'get_alert_notifications':
            return await this.getAlertNotifications(args);
          default:
            throw new McpError(ErrorCode.MethodNotFound, `Tool ${name} not found`);
        }
      } catch (error) {
        // Error logged to stderr to avoid breaking MCP protocol
        throw new McpError(ErrorCode.InternalError, `Failed to execute ${name}: ${error.message}`);
      }
    });
  }

  async listPTPPods(args) {
    const { namespace = this.ptpNamespace, labelSelector = 'app=linuxptp-daemon' } = args;

    try {
      const response = await this.k8sApi.listNamespacedPod(
        namespace,
        undefined, undefined, undefined, undefined, labelSelector
      );

      const pods = response.body.items.map(pod => ({
        name: pod.metadata.name,
        node: pod.spec.nodeName,
        status: pod.status.phase,
        ready: this.isPodReady(pod),
        restarts: this.getPodRestarts(pod),
        age: this.getAge(pod.metadata.creationTimestamp),
        ip: pod.status.podIP,
        containers: pod.spec.containers.map(c => ({
          name: c.name,
          image: c.image,
          ready: this.isContainerReady(pod, c.name),
        })),
        conditions: pod.status.conditions?.map(c => ({
          type: c.type,
          status: c.status,
          reason: c.reason
        })) || []
      }));

      return {
        content: [
          {
            type: 'text',
            text: `PTP Pods in namespace ${namespace}:\n\n${JSON.stringify(pods, null, 2)}`,
          },
        ],
      };
    } catch (error) {
      throw new McpError(ErrorCode.InternalError, `Failed to list PTP pods: ${error.message}`);
    }
  }

  async getPtpConfigs(args) {
    const { namespace = this.ptpNamespace, configName, includeStatus = true } = args;

    try {
      let response;
      if (configName) {
        response = await this.customObjectsApi.getNamespacedCustomObject(
          'ptp.openshift.io',
          'v1',
          namespace,
          'ptpconfigs',
          configName
        );
        
        return {
          content: [
            {
              type: 'text',
              text: `PtpConfig ${configName}:\n\n${JSON.stringify(response.body, null, 2)}`,
            },
          ],
        };
      } else {
        response = await this.customObjectsApi.listNamespacedCustomObject(
          'ptp.openshift.io',
          'v1',
          namespace,
          'ptpconfigs'
        );

        const configs = response.body.items.map(config => {
          const result = {
            name: config.metadata.name,
            namespace: config.metadata.namespace,
            creationTimestamp: config.metadata.creationTimestamp,
            spec: config.spec
          };

          if (includeStatus && config.status) {
            result.status = config.status;
          }

          return result;
        });

        return {
          content: [
            {
              type: 'text',
              text: `PtpConfigs in namespace ${namespace}:\n\n${JSON.stringify(configs, null, 2)}`,
            },
          ],
        };
      }
    } catch (error) {
      throw new McpError(ErrorCode.InternalError, `Failed to get PtpConfigs: ${error.message}`);
    }
  }

  async getNodePtpConfigs(args) {
    const { nodeName } = args;

    try {
      const response = await this.customObjectsApi.listClusterCustomObject(
        'ptp.openshift.io',
        'v1',
        'nodeptpdevices'
      );

      let devices = response.body.items;
      
      if (nodeName) {
        devices = devices.filter(device => device.metadata.name === nodeName);
      }

      const deviceInfo = devices.map(device => ({
        nodeName: device.metadata.name,
        creationTimestamp: device.metadata.creationTimestamp,
        devices: device.status?.devices || [],
        hwconfig: device.status?.hwconfig || []
      }));

      return {
        content: [
          {
            type: 'text',
            text: `NodePtpDevice information${nodeName ? ` for node ${nodeName}` : ''}:\n\n${JSON.stringify(deviceInfo, null, 2)}`,
          },
        ],
      };
    } catch (error) {
      throw new McpError(ErrorCode.InternalError, `Failed to get NodePtpDevices: ${error.message}`);
    }
  }

  async getDaemonLogs(args) {
    const { 
      namespace = this.ptpNamespace, 
      podName, 
      tailLines = 500, 
      searchPattern,
      sinceMinutes = 30 
    } = args;

    try {
      const targetPodName = podName || await this.getFirstPTPPod(namespace);
      const sinceSeconds = sinceMinutes * 60;

      const response = await this.k8sApi.readNamespacedPodLog(
        targetPodName,
        namespace,
        this.ptpContainers.daemon,
        undefined, // follow
        undefined, // insecureSkipTLSVerifyBackend
        undefined, // limitBytes
        undefined, // pretty
        undefined, // previous
        sinceSeconds,
        tailLines,
        true // timestamps
      );

      let logs = response.body;
      let analysis = '';

      if (searchPattern) {
        const lines = logs.split('\n');
        const matchedLines = lines.filter(line => 
          line.toLowerCase().includes(searchPattern.toLowerCase())
        );
        
        analysis = `\n=== SEARCH ANALYSIS for "${searchPattern}" ===\n`;
        analysis += `Found ${matchedLines.length} occurrences\n`;
        analysis += `Matched lines:\n${matchedLines.join('\n')}\n`;
        analysis += `=== END ANALYSIS ===\n\n`;
      }

      // Auto-analyze for common PTP issues
      const autoAnalysis = this.analyzePTPLogContent(logs);

      return {
        content: [
          {
            type: 'text',
            text: `LinuxPTP Daemon Logs from pod ${targetPodName}:\n${analysis}${autoAnalysis}\n=== RAW LOGS ===\n${logs}`,
          },
        ],
      };
    } catch (error) {
      throw new McpError(ErrorCode.InternalError, `Failed to get daemon logs: ${error.message}`);
    }
  }

  async getProxyLogs(args) {
    const { 
      namespace = this.ptpNamespace, 
      podName, 
      tailLines = 200, 
      searchPattern 
    } = args;

    try {
      const targetPodName = podName || await this.getPodFromDaemonSet(namespace, this.ptpDaemonSetName, this.ptpContainers.proxy);

      const response = await this.k8sApi.readNamespacedPodLog(
        targetPodName,
        namespace,
        this.ptpContainers.proxy,
        undefined, // follow
        undefined, // insecureSkipTLSVerifyBackend
        undefined, // limitBytes
        undefined, // pretty
        undefined, // previous
        undefined, // sinceSeconds
        tailLines,
        true // timestamps
      );

      let logs = response.body;
      let analysis = '';

      if (searchPattern) {
        const lines = logs.split('\n');
        const matchedLines = lines.filter(line => 
          line.toLowerCase().includes(searchPattern.toLowerCase())
        );
        
        analysis = `\n=== SEARCH ANALYSIS for "${searchPattern}" ===\n`;
        analysis += `Found ${matchedLines.length} occurrences\n`;
        analysis += `Matched lines:\n${matchedLines.join('\n')}\n`;
        analysis += `=== END ANALYSIS ===\n\n`;
      }

      return {
        content: [
          {
            type: 'text',
            text: `Cloud Event Proxy Logs from pod ${targetPodName}:\n${analysis}=== RAW LOGS ===\n${logs}`,
          },
        ],
      };
    } catch (error) {
      throw new McpError(ErrorCode.InternalError, `Failed to get proxy logs: ${error.message}`);
    }
  }

  async analyzePTPFaults(args) {
    const { namespace = this.ptpNamespace, podName, sinceHours = 2 } = args;

    try {
      const targetPodName = podName || await this.getFirstPTPPod(namespace);
      const sinceSeconds = sinceHours * 3600;

      const response = await this.k8sApi.readNamespacedPodLog(
        targetPodName,
        namespace,
        this.ptpContainers.daemon,
        undefined, // follow
        undefined, // insecureSkipTLSVerifyBackend
        undefined, // limitBytes
        undefined, // pretty
        undefined, // previous
        sinceSeconds,
        1000, // tailLines
        true // timestamps
      );

      const logs = response.body;
      const analysis = this.performFaultAnalysis(logs);

      return {
        content: [
          {
            type: 'text',
            text: `PTP Fault Analysis for pod ${targetPodName} (last ${sinceHours} hours):\n\n${analysis}`,
          },
        ],
      };
    } catch (error) {
      throw new McpError(ErrorCode.InternalError, `Failed to analyze PTP faults: ${error.message}`);
    }
  }

  async getPTPMetrics(args) {
    const { 
      namespace = this.ptpNamespace, 
      podName, 
      filterMetric, 
      format = 'parsed' 
    } = args;

    try {
      const targetPodName = podName || await this.getFirstPTPPod(namespace);

      const stdout = await this.execCommandInPod(
        namespace,
        targetPodName,
        this.ptpContainers.daemon,
        ['curl', '-s', 'localhost:9091/metrics']
      );

      let result = '';
      
      if (format === 'raw') {
        result = stdout;
      } else {
        const metrics = this.parsePrometheusMetrics(stdout, filterMetric);
        
        if (format === 'summary') {
          result = this.summarizeMetrics(metrics);
        } else {
          result = JSON.stringify(metrics, null, 2);
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: `PTP Metrics from pod ${targetPodName}${filterMetric ? ` (filtered: ${filterMetric})` : ''}:\n\n${result}`,
          },
        ],
      };
    } catch (error) {
      throw new McpError(ErrorCode.InternalError, `Failed to get PTP metrics: ${error.message}`);
    }
  }

  async checkPTPStatus(args) {
    const { namespace = this.ptpNamespace, detailed = false } = args;

    try {
      const podsResponse = await this.k8sApi.listNamespacedPod(
        namespace, undefined, undefined, undefined, undefined, 'app=linuxptp-daemon'
      );

      const pods = podsResponse.body.items;
      const statusResults = [];

      for (const pod of pods) {
        const podStatus = {
          name: pod.metadata.name,
          node: pod.spec.nodeName,
          phase: pod.status.phase,
          ready: this.isPodReady(pod),
          containers: {}
        };

        if (detailed) {
          try {
            // Get recent logs for quick status check
            const daemonLogs = await this.k8sApi.readNamespacedPodLog(
              pod.metadata.name,
              namespace,
              this.ptpContainers.daemon,
              undefined, // follow
              undefined, // insecureSkipTLSVerifyBackend
              undefined, // limitBytes
              undefined, // pretty
              undefined, // previous
              300, // sinceSeconds (last 5 minutes)
              50, // tailLines
              true // timestamps
            );
            
            podStatus.logSummary = this.analyzePTPLogContent(daemonLogs.body);

            // Try to get metrics
            try {
              const metricsOutput = await this.execCommandInPod(
                namespace,
                pod.metadata.name,
                this.ptpContainers.daemon,
                ['curl', '-s', '--max-time', '5', 'localhost:9091/metrics']
              );
              
              const metrics = this.parsePrometheusMetrics(metricsOutput, 'interface_role');
              podStatus.metrics = this.summarizeMetrics(metrics);
            } catch (metricsError) {
              podStatus.metrics = 'Metrics unavailable: ' + metricsError.message;
            }
          } catch (logError) {
            podStatus.logSummary = 'Log analysis failed: ' + logError.message;
          }
        }

        statusResults.push(podStatus);
      }

      return {
        content: [
          {
            type: 'text',
            text: `PTP Status Summary for namespace ${namespace}:\n\n${JSON.stringify(statusResults, null, 2)}`,
          },
        ],
      };
    } catch (error) {
      throw new McpError(ErrorCode.InternalError, `Failed to check PTP status: ${error.message}`);
    }
  }

  async execPTPCommand(args) {
    const { 
      namespace = this.ptpNamespace, 
      podName, 
      container = this.ptpContainers.daemon, 
      command = ['ps', 'aux'] 
    } = args;

    try {
      const targetPodName = podName || await this.getFirstPTPPod(namespace);
      const stdout = await this.execCommandInPod(namespace, targetPodName, container, command);

      return {
        content: [
          {
            type: 'text',
            text: `Command execution in pod ${targetPodName}, container ${container}:\nCommand: ${command.join(' ')}\n\n${stdout}`,
          },
        ],
      };
    } catch (error) {
      throw new McpError(ErrorCode.InternalError, `Failed to execute command: ${error.message}`);
    }
  }

  async monitorPTPEvents(args) {
    const { namespace = this.ptpNamespace, sinceMinutes = 60 } = args;

    try {
      const sinceMs = Date.now() - sinceMinutes * 60 * 1000;

      // Aggregate cloud-event-proxy logs from all DS pods
      const podNames = await this.listPodsForDaemonSetWithContainer(namespace, this.ptpDaemonSetName, this.ptpContainers.proxy);
      const sinceSeconds = Math.max(60, Math.floor(sinceMinutes * 60));
      let combinedLogs = '';
      for (const pod of podNames) {
        try {
          const resp = await this.k8sApi.readNamespacedPodLog(
            pod,
            namespace,
            this.ptpContainers.proxy,
            undefined, // follow
            undefined, // insecureSkipTLSVerifyBackend
            undefined, // limitBytes
            undefined, // pretty
            undefined, // previous
            sinceSeconds,
            3000, // tailLines
            true // timestamps
          );
          combinedLogs += (resp.body || '') + '\n';
        } catch (_) {}
      }

      // Parse and filter events by time
      const allEvents = this.extractCloudEventsFromLogs(combinedLogs);
      const filtered = allEvents.filter(ev => {
        const t = Date.parse(ev?.time || '');
        return !Number.isNaN(t) && t >= sinceMs;
      });
      const simplified = filtered
        .map(ev => this.simplifyCloudEvent(ev))
        .sort((a, b) => (Date.parse(b.time || '') || 0) - (Date.parse(a.time || '') || 0));

      return {
        content: [
          {
            type: 'text',
            text: `PTP Events from cloud-event-proxy logs (last ${sinceMinutes} minutes):\n\n${JSON.stringify(simplified.slice(0, 50), null, 2)}`,
          },
        ],
      };
    } catch (error) {
      throw new McpError(ErrorCode.InternalError, `Failed to monitor PTP events: ${error.message}`);
    }
  }

  normalizeCoreV1Event(e) {
    const timeStr = e.lastTimestamp || e.firstTimestamp || e.eventTime;
    const time = timeStr ? new Date(timeStr) : undefined;
    return {
      type: e.type,
      reason: e.reason,
      message: e.message,
      objectKind: e.involvedObject?.kind,
      objectName: e.involvedObject?.name,
      count: e.count,
      time,
    };
  }

  // Note: events.events.k8s.io not used per user preference

  async getPTPConfig(args) {
    const { 
      namespace = this.ptpNamespace, 
      podName, 
      configType = 'all' 
    } = args;

    try {
      const targetPodName = podName || await this.getFirstPTPPod(namespace);
      const configs = {};

      if (configType === 'all' || configType === 'ptp4l') {
        try {
          const ptp4lConfig = await this.execCommandInPod(
            namespace, targetPodName, this.ptpContainers.daemon,
            ['cat', '/etc/ptp4l.conf']
          );
          configs.ptp4l = ptp4lConfig;
        } catch (error) {
          configs.ptp4l = `Error reading ptp4l.conf: ${error.message}`;
        }
      }

      if (configType === 'all' || configType === 'phc2sys') {
        try {
          const phc2sysConfig = await this.execCommandInPod(
            namespace, targetPodName, this.ptpContainers.daemon,
            ['cat', '/etc/phc2sys.conf']
          );
          configs.phc2sys = phc2sysConfig;
        } catch (error) {
          configs.phc2sys = `Error reading phc2sys.conf: ${error.message}`;
        }
      }

      // Also get process status
      try {
        const processes = await this.execCommandInPod(
          namespace, targetPodName, this.ptpContainers.daemon,
          ['ps', 'aux']
        );
        configs.processes = processes;
      } catch (error) {
        configs.processes = `Error getting processes: ${error.message}`;
      }

      return {
        content: [
          {
            type: 'text',
            text: `PTP Configuration from pod ${targetPodName}:\n\n${JSON.stringify(configs, null, 2)}`,
          },
        ],
      };
    } catch (error) {
      throw new McpError(ErrorCode.InternalError, `Failed to get PTP configuration: ${error.message}`);
    }
  }

  async getCloudEvents(args) {
    const {
      namespace = this.ptpNamespace,
      podName,
      count = 10,
      eventType = 'all',
      sinceMinutes = 30,
      includeMetrics = true, // reserved for future use
    } = args;

    try {
      const targetPodName = podName || await this.getPodFromDaemonSet(namespace, this.ptpDaemonSetName, this.ptpContainers.proxy);
      const sinceSeconds = sinceMinutes * 60;

      // Collect logs from all DS pods that have the proxy container (oc logs ds/... aggregates)
      const podNames = await this.listPodsForDaemonSetWithContainer(namespace, this.ptpDaemonSetName, this.ptpContainers.proxy);
      let combinedLogs = '';
      for (const pod of podNames) {
        try {
          const resp = await this.k8sApi.readNamespacedPodLog(
            pod,
            namespace,
            this.ptpContainers.proxy,
            undefined, // follow
            undefined, // insecureSkipTLSVerifyBackend
            undefined, // limitBytes
            undefined, // pretty
            undefined, // previous
            sinceSeconds,
            3000, // tailLines per pod
            true // timestamps
          );
          combinedLogs += (resp.body || '') + '\n';
        } catch (e) {
          // Skip pods we can't read
        }
      }

      const allEvents = this.extractCloudEventsFromLogs(combinedLogs);

      const filtered = allEvents.filter(ev => {
        if (eventType === 'all') return true;
        const t = (ev.type || '').toLowerCase();
        if (eventType === 'sync-state') return t.includes('sync-status') || t.includes('synchronization');
        if (eventType === 'lock-state') return t.includes('lock');
        if (eventType === 'clock-class') return t.includes('clock-class');
        return true;
      });

      // Sort by time desc when possible
      const sorted = filtered.sort((a, b) => {
        const ta = Date.parse(a.time || '');
        const tb = Date.parse(b.time || '');
        if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
        if (Number.isNaN(ta)) return 1;
        if (Number.isNaN(tb)) return -1;
        return tb - ta;
      });

      const selected = sorted.slice(0, Math.max(0, count));
      const simplified = selected.map(ev => this.simplifyCloudEvent(ev));

      return {
        content: [
          {
            type: 'text',
            text: `Cloud Event Proxy events from pod ${targetPodName} (first ${simplified.length} of ${filtered.length}, window ${sinceMinutes}m):\n\n${JSON.stringify(simplified, null, 2)}`,
          },
        ],
      };
    } catch (error) {
      throw new McpError(ErrorCode.InternalError, `Failed to get cloud events: ${error.message}`);
    }
  }

  extractCloudEventsFromLogs(logs) {
    const lines = logs.split('\n');
    const events = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const idx = line.toLowerCase().indexOf('event sent');
      if (idx === -1) continue;

      // Try fast-path: JSON contained within the same line (escaped newlines/quotes)
      const braceStart = line.indexOf('{', idx);
      const braceEnd = line.lastIndexOf('}');
      if (braceStart !== -1 && braceEnd !== -1 && braceEnd > braceStart) {
        const candidate = line.slice(braceStart, braceEnd + 1);
        const obj = this.tryParseJsonCandidate(candidate);
        if (obj) { events.push(obj); continue; }
      }

      // Fallback: multi-line JSON object following the log line
      let startLine = i;
      let startCol = braceStart;
      if (startCol === -1) {
        for (let j = i + 1; j < lines.length; j++) {
          const col = lines[j].indexOf('{');
          if (col !== -1) { startLine = j; startCol = col; break; }
        }
      }
      if (startCol === -1) continue;

      const parsed = this.parseJsonObjectFromLines(lines, startLine, startCol);
      if (parsed && parsed.obj) { events.push(parsed.obj); i = parsed.endLine; }
    }
    return events;
  }

  parseJsonObjectFromLines(lines, startLine, startCol) {
    let buffer = '';
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = startLine; i < lines.length; i++) {
      const line = lines[i];
      const start = i === startLine ? startCol : 0;
      for (let j = start; j < line.length; j++) {
        const ch = line[j];
        buffer += ch;
        if (inString) {
          if (escape) {
            escape = false;
          } else if (ch === '\\') {
            escape = true;
          } else if (ch === '"') {
            inString = false;
          }
          continue;
        }
        if (ch === '"') {
          inString = true;
          continue;
        }
        if (ch === '{') depth++;
        else if (ch === '}') depth--;

        if (depth === 0) {
          // Attempt to parse
          try {
            const obj = JSON.parse(buffer);
            return { obj, endLine: i };
          } catch (e) {
            // Some logs escape quotes within the JSON fragment; try unescaping common sequences
            try {
              const cleaned = buffer
                .replace(/\\n/g, '\n')
                .replace(/\\t/g, '\t')
                .replace(/\\r/g, '')
                .replace(/\\\"/g, '"');
              const obj2 = JSON.parse(cleaned);
              return { obj: obj2, endLine: i };
            } catch (_e) {
              // keep scanning
            }
          }
        }
      }
      buffer += '\n';
    }
    return null;
  }

  tryParseJsonCandidate(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      try {
        const cleaned = text
          .replace(/\\n/g, '\n')
          .replace(/\\t/g, '\t')
          .replace(/\\r/g, '')
          .replace(/\\\"/g, '"');
        return JSON.parse(cleaned);
      } catch (_) {
        return null;
      }
    }
  }

  async listPodsForDaemonSetWithContainer(namespace, daemonSetName, containerName) {
    const ds = await this.appsApi.readNamespacedDaemonSet(daemonSetName, namespace);
    const selector = ds.body.spec?.selector?.matchLabels || {};
    const labelSelector = Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(',');
    const podsResp = await this.k8sApi.listNamespacedPod(namespace, undefined, undefined, undefined, undefined, labelSelector);
    const pods = podsResp.body.items || [];
    const names = pods.filter(p => (p.spec?.containers || []).some(c => c.name === containerName)).map(p => p.metadata.name);
    if (names.length) return names;
    // Fallback to app label
    const fallbackResp = await this.k8sApi.listNamespacedPod(namespace, undefined, undefined, undefined, undefined, 'app=linuxptp-daemon');
    return (fallbackResp.body.items || [])
      .filter(p => (p.spec?.containers || []).some(c => c.name === containerName))
      .map(p => p.metadata.name);
  }

  simplifyCloudEvent(ev) {
    const values = ev?.data?.values || [];
    const flatValues = values.map(v => ({
      address: v?.ResourceAddress,
      dataType: v?.data_type,
      valueType: v?.value_type,
      value: v?.value
    }));
    return {
      id: ev?.id,
      type: ev?.type,
      source: ev?.source,
      time: ev?.time,
      values: flatValues
    };
  }

  // Agentic service integration methods
  async getAgentAlerts(args) {
    const { hours = 24, severity = 'all' } = args;
    
    try {
      // Handle self-signed certificates for HTTPS
      if (this.agentServiceUrl.startsWith('https://')) {
        process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
      }

      const fetchOptions = {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000
      };
      
      const response = await fetch(`${this.agentServiceUrl}/alerts?hours=${hours}`, fetchOptions);
      
      if (!response.ok) {
        throw new Error(`Agent service responded with ${response.status}`);
      }
      
      const alerts = await response.json();
      const filtered = severity === 'all' ? alerts : alerts.filter(a => a.severity === severity.toUpperCase());
      
      return {
        content: [
          {
            type: 'text',
            text: `PTP Agent Alerts (${filtered.length} alerts in last ${hours}h):\n\n${JSON.stringify(filtered, null, 2)}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Failed to connect to PTP agent service: ${error.message}\n\nEnsure the PTP agentic service is running and accessible at ${this.agentServiceUrl}`,
          },
        ],
      };
    }
  }

  async getAgentSummary(args) {
    const { nodeName } = args;
    
    try {
      // Handle self-signed certificates for HTTPS
      if (this.agentServiceUrl.startsWith('https://')) {
        process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
      }

      const fetchOptions = {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000
      };
      
      const response = await fetch(`${this.agentServiceUrl}/summary`, fetchOptions);
      
      if (!response.ok) {
        throw new Error(`Agent service responded with ${response.status}`);
      }
      
      const summary = await response.json();
      const filtered = nodeName ? { [nodeName]: summary[nodeName] } : summary;
      
      return {
        content: [
          {
            type: 'text',
            text: `PTP Agent Event Summary:\n\n${JSON.stringify(filtered, null, 2)}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Failed to connect to PTP agent service: ${error.message}\n\nEnsure the PTP agentic service is running and accessible at ${this.agentServiceUrl}`,
          },
        ],
      };
    }
  }

  isPodReady(pod) {
    const conditions = pod.status?.conditions || [];
    return conditions.some(c => c.type === 'Ready' && c.status === 'True');
  }

  isContainerReady(pod, containerName) {
    const statuses = pod.status?.containerStatuses || [];
    const status = statuses.find(s => s.name === containerName);
    return Boolean(status?.ready);
  }

  getPodRestarts(pod) {
    const statuses = pod.status?.containerStatuses || [];
    return statuses.reduce((sum, s) => sum + (s.restartCount || 0), 0);
  }

  getAge(creationTimestamp) {
    if (!creationTimestamp) return 'unknown';
    const created = new Date(creationTimestamp).getTime();
    const now = Date.now();
    let seconds = Math.max(0, Math.floor((now - created) / 1000));
    const days = Math.floor(seconds / 86400); seconds -= days * 86400;
    const hours = Math.floor(seconds / 3600); seconds -= hours * 3600;
    const minutes = Math.floor(seconds / 60);
    const parts = [];
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (minutes || parts.length === 0) parts.push(`${minutes}m`);
    return parts.join(' ');
  }

  async getFirstPTPPod(namespace) {
    const response = await this.k8sApi.listNamespacedPod(
      namespace, undefined, undefined, undefined, undefined, 'app=linuxptp-daemon'
    );
    const pods = response.body.items || [];
    if (!pods.length) {
      throw new Error(`No pods found with label app=linuxptp-daemon in namespace ${namespace}`);
    }
    return pods[0].metadata.name;
  }

  // Prefer pods owned by the linuxptp-daemon DaemonSet and that include the requested container
  async getPodFromDaemonSet(namespace, daemonSetName, containerName) {
    // Find DaemonSet to get selector
    const ds = await this.appsApi.readNamespacedDaemonSet(daemonSetName, namespace);
    const selector = ds.body.spec?.selector?.matchLabels || {};
    const labelSelector = Object.entries(selector).map(([k,v]) => `${k}=${v}`).join(',');

    // List pods matching the DS selector
    const podsResp = await this.k8sApi.listNamespacedPod(namespace, undefined, undefined, undefined, undefined, labelSelector);
    const pods = podsResp.body.items || [];
    // Filter to pods that have the container
    const withContainer = pods.filter(p => (p.spec?.containers || []).some(c => c.name === containerName));
    if (withContainer.length) return withContainer[0].metadata.name;

    // Fallback: any app=linuxptp-daemon pod with container
    const fallbackResp = await this.k8sApi.listNamespacedPod(namespace, undefined, undefined, undefined, undefined, 'app=linuxptp-daemon');
    const fallbackPods = (fallbackResp.body.items || []).filter(p => (p.spec?.containers || []).some(c => c.name === containerName));
    if (fallbackPods.length) return fallbackPods[0].metadata.name;

    throw new Error(`No pods found in ${namespace} with container ${containerName}`);
  }

  analyzePTPLogContent(logs) {
    if (!logs) return 'No logs available';
    const lines = logs.split('\n');
    let faultyCount = 0;
    let offsetWarnings = 0;
    let clockStep = 0;
    let roleChanges = 0;
    for (const line of lines) {
      const l = line.toLowerCase();
      if (l.includes('faulty')) faultyCount++;
      if (l.includes('clock step')) clockStep++;
      if (l.match(/offset\s*[=:]\s*[-+]?\d+/)) offsetWarnings++;
      if (l.includes('master') && l.includes('slave')) roleChanges++;
      if (l.includes('state') && (l.includes('master') || l.includes('slave'))) roleChanges++;
    }
    const findings = [];
    if (faultyCount) findings.push(`FAULTY occurrences: ${faultyCount}`);
    if (clockStep) findings.push(`Clock step events: ${clockStep}`);
    if (offsetWarnings) findings.push(`Offset observations: ${offsetWarnings}`);
    if (roleChanges) findings.push(`Role/state change hints: ${roleChanges}`);
    if (!findings.length) findings.push('No obvious issues detected in recent logs');
    return findings.join('\n');
  }

  performFaultAnalysis(logs) {
    if (!logs) return 'No logs available';
    const lines = logs.split('\n');
    const summary = { faulty: 0, portErrors: 0, clockStep: 0, syncLoss: 0, lastFaultyLine: null };
    lines.forEach(line => {
      const l = line.toLowerCase();
      if (l.includes('faulty')) { summary.faulty++; summary.lastFaultyLine = line; }
      if (l.includes('clock step')) summary.clockStep++;
      if (l.includes('sync') && l.includes('lost')) summary.syncLoss++;
      if (l.includes('port') && (l.includes('down') || l.includes('fault'))) summary.portErrors++;
    });
    return JSON.stringify(summary, null, 2);
  }

  async execCommandInPod(namespace, podName, containerName, command) {
    return await new Promise((resolve, reject) => {
      let stdoutData = '';
      let stderrData = '';
      const stdoutStream = new Writable({ write(chunk, enc, cb) { stdoutData += chunk.toString(); cb(); } });
      const stderrStream = new Writable({ write(chunk, enc, cb) { stderrData += chunk.toString(); cb(); } });
      this.exec.exec(
        namespace,
        podName,
        containerName,
        command,
        stdoutStream,
        stderrStream,
        null,
        false,
        (status) => {
          if (!status || status.status === 'Success') {
            resolve(stdoutData);
          } else {
            reject(new Error(stderrData || JSON.stringify(status)));
          }
        }
      ).catch(err => reject(err));
    });
  }

  parsePrometheusMetrics(text, filterMetric) {
    const metrics = {};
    if (!text) return metrics;
    const lines = text.split('\n');
    for (const line of lines) {
      if (!line || line.startsWith('#')) continue;
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) continue;
      const metricAndLabels = parts[0];
      const value = parseFloat(parts[1]);
      if (Number.isNaN(value)) continue;
      const nameMatch = metricAndLabels.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{.*\})?$/);
      if (!nameMatch) continue;
      const metricName = nameMatch[1];
      if (filterMetric && !metricName.includes(filterMetric)) continue;
      const labelsRaw = nameMatch[2];
      const labels = {};
      if (labelsRaw) {
        const inner = labelsRaw.slice(1, -1);
        inner.split(',').forEach(kv => {
          const [k, v] = kv.split('=');
          if (k) labels[k.trim()] = v?.trim()?.replace(/^\"|\"$/g, '') || '';
        });
      }
      if (!metrics[metricName]) metrics[metricName] = [];
      metrics[metricName].push({ labels, value });
    }
    return metrics;
  }

  summarizeMetrics(metrics) {
    const summary = {};
    for (const [name, samples] of Object.entries(metrics)) {
      const count = samples.length;
      let min = Infinity, max = -Infinity, sum = 0;
      samples.forEach(s => { min = Math.min(min, s.value); max = Math.max(max, s.value); sum += s.value; });
      summary[name] = { count, min: isFinite(min) ? min : null, max: isFinite(max) ? max : null, avg: count ? sum / count : null };
    }
    return JSON.stringify(summary, null, 2);
  }

  // Continuous monitoring methods
  async startPTPMonitoring(args) {
    const { intervalSeconds = 10, alertSeverity = 'WARNING', maxAlerts = 50 } = args;
    
    // Enforce minimum interval for stability
    const actualInterval = Math.max(5, intervalSeconds);

    if (this.monitoringState.active) {
      return {
        content: [
          {
            type: 'text',
            text: `PTP monitoring is already active. Started at ${this.monitoringState.startTime}, checking every ${this.monitoringState.intervalSeconds} seconds.`
          }
        ]
      };
    }

    this.monitoringState = {
      active: true,
      intervalSeconds: actualInterval,
      alertSeverity,
      maxAlerts,
      alertHistory: [],
      lastCheck: new Date().toISOString(),
      startTime: new Date().toISOString(),
      intervalId: null
    };

    // Start monitoring loop
    this.monitoringState.intervalId = setInterval(async () => {
      await this.performMonitoringCheck();
    }, actualInterval * 1000);

    // Perform initial check
    await this.performMonitoringCheck();

    return {
      content: [
        {
          type: 'text',
          text: `STARTING: PTP Continuous Monitoring Started!

STATUS: Settings:
- Check interval: ${actualInterval} seconds (${(actualInterval/60).toFixed(1)} minutes)
- Alert severity: ${alertSeverity}+
- Max alerts tracked: ${maxAlerts}
- Started: ${this.monitoringState.startTime}

SUCCESS: Initial check completed. Claude will now automatically monitor PTP events and alert you of issues.

Use 'get_monitoring_status' to check current status or 'stop_ptp_monitoring' to stop.`
        }
      ]
    };
  }

  async stopPTPMonitoring(args) {
    if (!this.monitoringState.active) {
      return {
        content: [
          {
            type: 'text',
            text: 'PTP monitoring is not currently active.'
          }
        ]
      };
    }

    if (this.monitoringState.intervalId) {
      clearInterval(this.monitoringState.intervalId);
    }

    const duration = new Date() - new Date(this.monitoringState.startTime);
    const hours = Math.floor(duration / (1000 * 60 * 60));
    const minutes = Math.floor((duration % (1000 * 60 * 60)) / (1000 * 60));

    const finalStats = {
      duration: `${hours}h ${minutes}m`,
      totalAlerts: this.monitoringState.alertHistory.length,
      criticalAlerts: this.monitoringState.alertHistory.filter(a => a.severity === 'CRITICAL').length,
      warningAlerts: this.monitoringState.alertHistory.filter(a => a.severity === 'WARNING').length
    };

    this.monitoringState.active = false;
    this.monitoringState.intervalId = null;

    return {
      content: [
        {
          type: 'text',
          text: `STOPPED: PTP Monitoring Stopped

STATUS: Session Summary:
- Duration: ${finalStats.duration}
- Total alerts: ${finalStats.totalAlerts}
- Critical alerts: ${finalStats.criticalAlerts}
- Warning alerts: ${finalStats.warningAlerts}

Alert history preserved. Use 'get_monitoring_status' to review.`
        }
      ]
    };
  }

  async forceAlertCheck(args) {
    if (!this.monitoringState.active) {
      return {
        content: [
          {
            type: 'text',
            text: 'Monitoring is not active. Start monitoring first with "start_ptp_monitoring"'
          }
        ]
      };
    }

    // Force alert check requested
    await this.performMonitoringCheck();

    const recentAlerts = this.monitoringState.alertHistory.slice(-10);

    return {
      content: [
        {
          type: 'text',
          text: `FORCE: Force Alert Check Complete\n\nRecent alerts found: ${recentAlerts.length}\n\n${JSON.stringify(recentAlerts, null, 2)}`
        }
      ]
    };
  }

  async getAlertNotifications(args) {
    const { markAsRead = true } = args;

    try {
      // Get notifications from memory (faster and more reliable)
      const notifications = this.monitoringState.pendingNotifications || [];
      const unreadNotifications = notifications.filter(n => !n.displayed);

      if (unreadNotifications.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: '✅ No new alert notifications\n\nAll alerts have been reviewed. Use "force_alert_check" to check for new alerts.'
            }
          ]
        };
      }

      let notificationText = `🚨 NEW PTP ALERT NOTIFICATIONS (${unreadNotifications.length})\n\n`;

      unreadNotifications.forEach((notification, index) => {
        const severity = notification.severity;
        const emoji = severity === 'CRITICAL' ? '🔴' : severity === 'WARNING' ? '🟡' : '🟢';
        
        notificationText += `${emoji} ALERT ${index + 1}/${unreadNotifications.length}\n`;
        notificationText += `Severity: ${severity}\n`;
        notificationText += `Summary: ${notification.summary}\n`;
        notificationText += `Node: ${notification.affected_nodes?.join(', ') || 'unknown'}\n`;
        notificationText += `Time: ${new Date(notification.timestamp).toLocaleString()}\n`;
        
        if (notification.details) {
          notificationText += `Details: ${notification.details}\n`;
        }
        
        if (notification.recommendations && notification.recommendations.length > 0) {
          notificationText += `Recommendations:\n`;
          notification.recommendations.forEach(rec => {
            notificationText += `  • ${rec}\n`;
          });
        }
        
        notificationText += `\n${'─'.repeat(60)}\n\n`;
      });

      // Mark as read if requested
      if (markAsRead) {
        this.monitoringState.pendingNotifications.forEach(n => {
          if (!n.displayed) n.displayed = true;
        });
      }

      return {
        content: [
          {
            type: 'text',
            text: notificationText
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error reading alert notifications: ${error.message}`
          }
        ]
      };
    }
  }

  async getMonitoringStatus(args) {
    const { includeHistory = true } = args;

    const status = {
      active: this.monitoringState.active,
      startTime: this.monitoringState.startTime,
      lastCheck: this.monitoringState.lastCheck,
      polling: {
        lastCheck: this.monitoringState.lastCheck,
        agentUrl: this.agentServiceUrl
      },
      settings: {
        intervalSeconds: this.monitoringState.intervalSeconds,
        alertSeverity: this.monitoringState.alertSeverity,
        maxAlerts: this.monitoringState.maxAlerts
      },
      stats: {
        totalAlerts: this.monitoringState.alertHistory.length,
        criticalAlerts: this.monitoringState.alertHistory.filter(a => a.severity === 'CRITICAL').length,
        warningAlerts: this.monitoringState.alertHistory.filter(a => a.severity === 'WARNING').length,
        recentAlerts: this.monitoringState.alertHistory.slice(-5),
        alertsInLastHour: this.monitoringState.alertHistory.filter(a => {
          const alertTime = new Date(a.timestamp);
          const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
          return alertTime > oneHourAgo;
        }).length
      }
    };

    if (includeHistory) {
      status.alertHistory = this.monitoringState.alertHistory;
    }

    let statusText = `STATUS: PTP Monitoring Status

Active: ${status.active ? 'YES' : 'NO'}
 Agent URL: ${status.polling.agentUrl}`;

    if (status.active) {
      statusText += `
 Started: ${status.startTime}
FORCE: Last Check: ${status.lastCheck}
 Check Interval: ${status.settings.intervalSeconds} seconds (${(status.settings.intervalSeconds/60).toFixed(1)} min)
ALERT: Alert Level: ${status.settings.alertSeverity}+

 Alert Statistics:
- Total: ${status.stats.totalAlerts}
- Critical: ${status.stats.criticalAlerts} 
- Warning: ${status.stats.warningAlerts} 
- Last hour: ${status.stats.alertsInLastHour} `;

      if (status.stats.recentAlerts.length > 0) {
        statusText += `\n\n Recent Alerts (last 5):`;
        status.stats.recentAlerts.forEach(alert => {
          const emoji = alert.severity === 'CRITICAL' ? '' : '';
          statusText += `\n${emoji} [${alert.timestamp}] ${alert.summary}`;
        });
      }
    }

    if (includeHistory && status.alertHistory.length > 0) {
      statusText += `\n\n Full Alert History:\n${JSON.stringify(status.alertHistory, null, 2)}`;
    }

    return {
      content: [
        {
          type: 'text',
          text: statusText
        }
      ]
    };
  }

  async performMonitoringCheck() {
    try {
      this.monitoringState.lastCheck = new Date().toISOString();

      // Debug logging to file (safe for MCP protocol)
      const fs = await import('fs');
      const debugLog = (msg) => {
        try {
          fs.appendFileSync('/tmp/ptp-mcp-debug.log', `${new Date().toISOString()} - ${msg}\n`);
        } catch (e) {
          // Ignore file write errors
        }
      };

      debugLog(`Starting monitoring check - URL: ${this.agentServiceUrl}`);

      // Handle self-signed certificates for HTTPS
      if (this.agentServiceUrl.startsWith('https://')) {
        process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
      }

      // Get alerts from last hour but filter for recent ones in processing
      const alertsResponse = await fetch(`${this.agentServiceUrl}/alerts?hours=1`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000
      });

      debugLog(`Fetch response status: ${alertsResponse.status}`);

      if (!alertsResponse.ok) {
        debugLog(`Agent monitoring check failed: HTTP ${alertsResponse.status}`);
        return;
      }

      const alerts = await alertsResponse.json();
      debugLog(`Retrieved ${alerts.length} alerts from agent`);

      // Get only ACTIVE ISSUES (exclude LOCKED/recovered states)
      const activeIssues = new Map();
      
      // Sort alerts by timestamp (newest first)
      const sortedAlerts = alerts.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      
      // For each resource, find the latest state and only keep if it's problematic
      const resourceStates = new Map();
      
      sortedAlerts.forEach(alert => {
        const resourceKey = alert.details?.match(/Resource: ([^\s]+)/)?.[1] || 'unknown';
        
        // Track the latest state for each resource
        if (!resourceStates.has(resourceKey)) {
          resourceStates.set(resourceKey, alert);
        }
      });
      
      // Keep alerts for both problematic states AND recovery notifications
      resourceStates.forEach((latestAlert, resourceKey) => {
        // Check if the latest state is either problematic OR a recovery notification
        const isProblematic = latestAlert.summary.includes('→ FREERUN') ||
                              latestAlert.summary.includes('→ HOLDOVER') ||
                              latestAlert.summary.includes('→ FAULTY') ||
                              latestAlert.summary.includes('Frequent PTP state changes');

        // Clock class handling - include all clock class changes (they show quality)
        const isClockClass = latestAlert.summary.includes('Clock class');

        // Also include LOCKED recovery notifications (INFO severity)
        const isRecovery = latestAlert.summary.includes('→ LOCKED') ||
                          latestAlert.summary.includes('recovered');

        if (isProblematic || isClockClass || isRecovery) {
          activeIssues.set(resourceKey, latestAlert);
        }
      });
      
      // Convert back to array and filter by severity
      const filteredAlerts = Array.from(activeIssues.values()).filter(alert => {
        if (this.monitoringState.alertSeverity === 'all') return true;
        if (this.monitoringState.alertSeverity === 'CRITICAL') return alert.severity === 'CRITICAL';
        if (this.monitoringState.alertSeverity === 'WARNING') return ['WARNING', 'CRITICAL'].includes(alert.severity);
        return true;
      });

      debugLog(`Filtered to ${filteredAlerts.length} alerts matching severity ${this.monitoringState.alertSeverity}`);

      // Find genuinely new alerts using better timestamp comparison
      const existingAlertKeys = new Set(
        this.monitoringState.alertHistory.map(a => `${a.timestamp}:${a.summary}:${a.severity}`)
      );

      const newAlerts = filteredAlerts.filter(alert => {
        const key = `${alert.timestamp}:${alert.summary}:${alert.severity}`;
        return !existingAlertKeys.has(key);
      });

      debugLog(`Found ${newAlerts.length} new alerts (existing: ${this.monitoringState.alertHistory.length})`);

      // Add new alerts to history and notify client
      for (const alert of newAlerts) {
        this.monitoringState.alertHistory.push({
          ...alert,
          detectedAt: new Date().toISOString()
        });

        debugLog(`NEW ALERT: ${alert.severity} - ${alert.summary}`);

        // Store alert in monitoring state for immediate retrieval
        this.monitoringState.pendingNotifications = this.monitoringState.pendingNotifications || [];
        this.monitoringState.pendingNotifications.push({
          ...alert,
          notifiedAt: new Date().toISOString(),
          displayed: false
        });

        // Keep only last 20 notifications
        if (this.monitoringState.pendingNotifications.length > 20) {
          this.monitoringState.pendingNotifications = this.monitoringState.pendingNotifications.slice(-20);
        }

        debugLog(`ALERT STORED IN MEMORY: ${alert.severity} - ${alert.summary}`);

        // Send MCP resource change notification for new alerts
        this.sendResourceChangeNotification();
        debugLog(`SENT MCP RESOURCE NOTIFICATION FOR NEW ALERT`);
      }

      // Trim history if needed
      if (this.monitoringState.alertHistory.length > this.monitoringState.maxAlerts) {
        this.monitoringState.alertHistory = this.monitoringState.alertHistory.slice(-this.monitoringState.maxAlerts);
      }

      debugLog(`Monitoring check complete. Total alerts in history: ${this.monitoringState.alertHistory.length}`);

    } catch (error) {
      // Debug logging to file (safe for MCP protocol)
      try {
        const fs = await import('fs');
        fs.appendFileSync('/tmp/ptp-mcp-debug.log', `${new Date().toISOString()} - ERROR: ${error.message}\n`);
      } catch (e) {
        // Ignore file write errors
      }
    }
  }

  async notifyClient(alert) {
    try {
      // Send alert notification via MCP resource change
      const alertMessage = this.formatAlertForLLM(alert);
      this.sendAlertToNotificationFile(alertMessage);
      
      // Log to debug file
      const fs = await import('fs');
      fs.appendFileSync('/tmp/ptp-mcp-debug.log', `${new Date().toISOString()} - ALERT SENT VIA MCP: ${alert.severity} - ${alert.summary}\n`);
    } catch (error) {
      // Log error to debug file only
      try {
        const fs = await import('fs');
        fs.appendFileSync('/tmp/ptp-mcp-debug.log', `${new Date().toISOString()} - NOTIFICATION ERROR: ${error.message}\n`);
      } catch (e) {
        // Ignore file write errors
      }
    }
  }

  formatAlertForLLM(alert) {
    const emoji = alert.severity === 'CRITICAL' ? '🔴' : alert.severity === 'WARNING' ? '🟡' : '🟢';
    const timestamp = new Date(alert.timestamp).toLocaleString();
    
    let message = `${emoji} **PTP ALERT - ${alert.severity}**\n\n`;
    message += `**Summary:** ${alert.summary}\n`;
    message += `**Node:** ${alert.affected_nodes?.join(', ') || 'unknown'}\n`;
    message += `**Time:** ${timestamp}\n`;
    
    if (alert.details) {
      message += `**Details:** ${alert.details}\n`;
    }
    
    if (alert.recommendations && alert.recommendations.length > 0) {
      message += `**Recommendations:**\n`;
      alert.recommendations.forEach(rec => {
        message += `• ${rec}\n`;
      });
    }
    
    return message;
  }

  sendAlertToNotificationFile(message) {
    try {
      // Write alert to a notification file
      const fs = require('fs');
      const alertFile = '/tmp/ptp-alerts.json';
      
      // Debug log entry
      fs.appendFileSync('/tmp/ptp-mcp-debug.log', `${new Date().toISOString()} - WRITING ALERT TO FILE: ${alertFile}\n`);
      
      const alertNotification = {
        timestamp: new Date().toISOString(),
        message: message,
        processed: false
      };
      
      // Append to alerts file
      let alerts = [];
      try {
        const existingData = fs.readFileSync(alertFile, 'utf8');
        alerts = JSON.parse(existingData);
        fs.appendFileSync('/tmp/ptp-mcp-debug.log', `${new Date().toISOString()} - READ EXISTING ALERTS: ${alerts.length}\n`);
      } catch (e) {
        // File doesn't exist or is invalid, start fresh
        alerts = [];
        fs.appendFileSync('/tmp/ptp-mcp-debug.log', `${new Date().toISOString()} - STARTING FRESH ALERTS ARRAY\n`);
      }
      
      alerts.push(alertNotification);
      
      // Keep only last 50 alerts
      if (alerts.length > 50) {
        alerts = alerts.slice(-50);
      }
      
      fs.writeFileSync(alertFile, JSON.stringify(alerts, null, 2));
      fs.appendFileSync('/tmp/ptp-mcp-debug.log', `${new Date().toISOString()} - WROTE ${alerts.length} ALERTS TO FILE\n`);
      
      // Send MCP resource change notification
      this.sendResourceChangeNotification();
      
    } catch (error) {
      // Log error to debug file only
      try {
        const fs = require('fs');
        fs.appendFileSync('/tmp/ptp-mcp-debug.log', `${new Date().toISOString()} - FILE WRITE ERROR: ${error.message}\n${error.stack}\n`);
      } catch (e) {
        // Ignore file write errors
      }
    }
  }

  sendResourceChangeNotification() {
    try {
      // Send MCP resource change notification
      this.server.notification({
        method: 'notifications/resources/changed',
        params: {
          resources: ['ptp://alerts/current']
        }
      });
      
      // Log to debug file
      const fs = require('fs');
      fs.appendFileSync('/tmp/ptp-mcp-debug.log', `${new Date().toISOString()} - MCP RESOURCE NOTIFICATION SENT\n`);
    } catch (error) {
      // Log error to debug file only
      try {
        const fs = require('fs');
        fs.appendFileSync('/tmp/ptp-mcp-debug.log', `${new Date().toISOString()} - MCP NOTIFICATION ERROR: ${error.message}\n`);
      } catch (e) {
        // Ignore file write errors
      }
    }
  }

  async setupAgentConnection() {
    // Auto-setup port forward if using localhost and not explicitly disabled
    if (this.agentServiceUrl.includes('localhost') && !process.env.DISABLE_AUTO_PORT_FORWARD) {
      await this.ensurePortForward();
    }
  }

  async ensurePortForward() {
    try {
      // Check if port forward is needed and not already running
      if (this.portForwardProcess && !this.portForwardProcess.killed) {
        return; // Already running
      }

      // Test if agent is already accessible
      try {
        const testResponse = await fetch(`${this.agentServiceUrl}/health`, { 
          method: 'GET', 
          timeout: 2000 
        });
        if (testResponse.ok) {
          return; // Agent already accessible, no port forward needed
        }
      } catch (e) {
        // Agent not accessible, need port forward
      }

      // Start port forward
      const kubeconfigFlag = process.env.KUBECONFIG ? `--kubeconfig=${process.env.KUBECONFIG}` : '';
      const cmd = kubeconfigFlag ? 
        ['oc', kubeconfigFlag, 'port-forward', `svc/ptp-agent`, `${this.portForwardPort}:8081`, '-n', this.agentNamespace] :
        ['oc', 'port-forward', `svc/ptp-agent`, `${this.portForwardPort}:8081`, '-n', this.agentNamespace];

      this.portForwardProcess = spawn(cmd[0], cmd.slice(1), {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false
      });

      // Wait a moment for port forward to establish
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Test the connection
      try {
        const testResponse = await fetch(`${this.agentServiceUrl}/health`, { 
          method: 'GET', 
          timeout: 3000 
        });
        if (testResponse.ok) {
          // Port forward successful
        }
      } catch (e) {
        // Port forward might have failed, but continue anyway
      }

    } catch (error) {
      // Port forward failed, but continue with direct service URL
    }
  }

  cleanup() {
    if (this.portForwardProcess && !this.portForwardProcess.killed) {
      this.portForwardProcess.kill();
    }
  }
}

// Export the class for reuse in other modules
export { PTPOperatorMCPServer };

// Only start stdio server if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  const serverInstance = new PTPOperatorMCPServer();
  const transport = new StdioServerTransport();
  
  // Cleanup on exit
  process.on('SIGINT', () => {
    serverInstance.cleanup();
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    serverInstance.cleanup();
    process.exit(0);
  });
  
  serverInstance.server.connect(transport);
}