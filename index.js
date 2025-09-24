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
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import k8s from '@kubernetes/client-node';

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
        },
      }
    );

    // Initialize Kubernetes client
    this.kc = new k8s.KubeConfig();
    try {
      this.kc.loadFromDefault();
    } catch (error) {
      console.error('Failed to load kubeconfig:', error.message);
    }

    this.k8sApi = this.kc.makeApiClient(k8s.CoreV1Api);
    this.exec = new k8s.Exec(this.kc);
    
    // Custom Resource API clients
    this.customObjectsApi = this.kc.makeApiClient(k8s.CustomObjectsApi);

    // PTP-specific configurations
    this.ptpNamespace = 'openshift-ptp'; // Default PTP namespace
    this.ptpContainers = {
      daemon: 'linuxptp-daemon-container',
      proxy: 'cloud-event-proxy'
    };

    this.setupHandlers();
  }

  setupHandlers() {
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
          description: 'Monitor PTP-related Kubernetes events',
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
        }
      ]
    }));

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
          default:
            throw new McpError(ErrorCode.MethodNotFound, `Tool ${name} not found`);
        }
      } catch (error) {
        console.error(`Error executing tool ${name}:`, error);
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
      const targetPodName = podName || await this.getFirstPTPPod(namespace);

      const response = await this.k8sApi.readNamespacedPodLog(
        targetPodName,
        namespace,
        this.ptpContainers.proxy,
        undefined, undefined, undefined, undefined, 
        undefined, tailLines, true
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
        undefined, undefined, undefined, undefined,
        sinceSeconds, 1000, true
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
              undefined, undefined, undefined, undefined,
              300, // last 5 minutes
              50, true
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
      const sinceTime = new Date(Date.now() - sinceMinutes * 60 * 1000).toISOString();
      
      const response = await this.k8sApi.listNamespacedEvent(namespace);
      
      const ptpEvents = response.body.items
        .filter(event => {
          const eventTime = new Date(event.lastTimestamp || event.firstTimestamp);
          return eventTime >= new Date(sinceTime);
        })
        .filter(event => 
          event.involvedObject.name?.includes('ptp') ||
          event.involvedObject.name?.includes('linuxptp') ||
          event.message?.toLowerCase().includes('ptp')
        )
        .map(event => ({
          type: event.type,
          reason: event.reason,
          message: event.message,
          object: `${event.involvedObject.kind}/${event.involvedObject.name}`,
          count: event.count,
          firstTime: event.firstTimestamp,
          lastTime: event.lastTimestamp
        }));

      return {
        content: [
          {
            type: 'text',
            text: `PTP Events in namespace ${namespace} (last ${sinceMinutes} minutes):\n\n${JSON.stringify(ptpEvents, null, 2)}`,
          },
        ],
      };
    } catch (error) {
      throw new McpError(ErrorCode.InternalError, `Failed to monitor PTP events: ${error.message}`);
    }
  }

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
      throw new McpError(ErrorCode.InternalError, `Failed to get PTP config: ${error.message}`);
    }
  }

  // Helper methods
  async getFirstPTPPod(namespace) {
    const response = await this.k8sApi.listNamespacedPod(
      namespace, undefined, undefined, undefined, undefined, 'app=linuxptp-daemon'
    );
    
    if (response.body.items.length === 0) {
      throw new Error('No PTP pods found');
    }
    
    return response.body.items[0].metadata.name;
  }

  async execCommandInPod(namespace, podName, containerName, command) {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';

      this.exec.exec(
        namespace,
        podName,
        containerName,
        command,
        stdout,
        stderr,
        null, // stdin
        false, // tty
        (status) => {
          if (status.status === 'Success') {
            resolve(stdout);
          } else {
            reject(new Error(`Command failed: ${stderr || status.message || 'Unknown error'}`));
          }
        }
      );
    });
  }

  analyzePTPLogContent(logs) {
    const lines = logs.split('\n');
    const analysis = {
      faultyCount: 0,
      slaveCount: 0,
      masterCount: 0,
      listeningCount: 0,
      errors: [],
      warnings: [],
      stateChanges: []
    };

    lines.forEach(line => {
      const lowerLine = line.toLowerCase();
      
      if (lowerLine.includes('faulty')) {
        analysis.faultyCount++;
      }
      if (lowerLine.includes('slave')) {
        analysis.slaveCount++;
      }
      if (lowerLine.includes('master')) {
        analysis.masterCount++;
      }
      if (lowerLine.includes('listening')) {
        analysis.listeningCount++;
      }
      if (lowerLine.includes('error')) {
        analysis.errors.push(line.trim());
      }
      if (lowerLine.includes('warn')) {
        analysis.warnings.push(line.trim());
      }
      if (lowerLine.includes('state') && (lowerLine.includes('change') || lowerLine.includes('transition'))) {
        analysis.stateChanges.push(line.trim());
      }
    });

    let summary = '=== AUTOMATIC PTP LOG ANALYSIS ===\n';
    summary += `FAULTY states: ${analysis.faultyCount}\n`;
    summary += `SLAVE states: ${analysis.slaveCount}\n`;
    summary += `MASTER states: ${analysis.masterCount}\n`;
    summary += `LISTENING states: ${analysis.listeningCount}\n`;
    summary += `Errors found: ${analysis.errors.length}\n`;
    summary += `Warnings found: ${analysis.warnings.length}\n`;
    summary += `State changes: ${analysis.stateChanges.length}\n`;
    
    if (analysis.errors.length > 0) {
      summary += '\nRecent errors:\n' + analysis.errors.slice(-3).join('\n') + '\n';
    }
    
    if (analysis.stateChanges.length > 0) {
      summary += '\nRecent state changes:\n' + analysis.stateChanges.slice(-3).join('\n') + '\n';
    }
    
    summary += '=== END ANALYSIS ===\n\n';
    
    return summary;
  }

  performFaultAnalysis(logs) {
    const lines = logs.split('\n');
    const faultPatterns = {
      faulty: /faulty/i,
      timeout: /timeout/i,
      unreachable: /unreachable/i,
      offset_high: /offset.*[1-9]\d{6}/i, // Large offsets (>1M ns)
      frequency_high: /frequency.*[1-9]\d{2}/i, // High frequency adjustments
    };

    const faultCounts = {};
    const faultLines = {};
    
    Object.keys(faultPatterns).forEach(key => {
      faultCounts[key] = 0;
      faultLines[key] = [];
    });

    lines.forEach(line => {
      Object.keys(faultPatterns).forEach(key => {
        if (faultPatterns[key].test(line)) {
          faultCounts[key]++;
          if (faultLines[key].length < 5) { // Keep only first 5 examples
            faultLines[key].push(line.trim());
          }
        }
      });
    });

    let analysis = '=== DETAILED FAULT ANALYSIS ===\n';
    
    Object.keys(faultCounts).forEach(key => {
      analysis += `${key.toUpperCase()}: ${faultCounts[key]} occurrences\n`;
      if (faultLines[key].length > 0) {
        analysis += `  Examples:\n  ${faultLines[key].join('\n  ')}\n\n`;
      }
    });

    // Overall health assessment
    const totalFaults = Object.values(faultCounts).reduce((a, b) => a + b, 0);
    analysis += `OVERALL FAULT COUNT: ${totalFaults}\n`;
    
    if (totalFaults === 0) {
      analysis += 'STATUS: HEALTHY - No faults detected\n';
    } else if (totalFaults < 10) {
      analysis += 'STATUS: MINOR ISSUES - Few faults detected\n';
    } else if (totalFaults < 50) {
      analysis += 'STATUS: MODERATE ISSUES - Several faults detected\n';
    } else {
      analysis += 'STATUS: CRITICAL ISSUES - Many faults detected\n';
    }
    
    analysis += '=== END FAULT ANALYSIS ===\n';
    
    return analysis;
  }

  parsePrometheusMetrics(metricsText, filter) {
    const lines = metricsText.split('\n');
    const metrics = {};

    lines.forEach(line => {
      if (line.startsWith('#') || line.trim() === '') return;
      
      if (!filter || line.includes(filter)) {
        const parts = line.split(' ');
        if (parts.length >= 2) {
          const metricName = parts[0];
          const value = parts[1];
          
          // Parse metric labels if present
          const labelMatch = metricName.match(/([^{]+)({.*})?/);
          if (labelMatch) {
            const baseName = labelMatch[1];
            const labels = labelMatch[2] || '{}';
            
            if (!metrics[baseName]) {
              metrics[baseName] = [];
            }
            
            metrics[baseName].push({
              labels: labels,
              value: parseFloat(value) || value,
              rawLine: line
            });
          }
        }
      }
    });

    return metrics;
  }

  summarizeMetrics(metrics) {
    let summary = '=== METRICS SUMMARY ===\n';
    
    Object.keys(metrics).forEach(metricName => {
      summary += `\n${metricName}:\n`;
      metrics[metricName].forEach(metric => {
        summary += `  ${metric.labels} = ${metric.value}\n`;
      });
    });

    // Special handling for common PTP metrics
    if (metrics['interface_role']) {
      summary += '\n=== INTERFACE ROLES ===\n';
      metrics['interface_role'].forEach(metric => {
        const roleValue = metric.value === 1 ? 'ACTIVE' : 'INACTIVE';
        summary += `  ${metric.labels} = ${roleValue}\n`;
      });
    }

    if (metrics['clock_state']) {
      summary += '\n=== CLOCK STATES ===\n';
      metrics['clock_state'].forEach(metric => {
        const stateNames = {
          0: 'INITIALIZING',
          1: 'FAULTY',
          2: 'DISABLED',
          3: 'LISTENING',
          4: 'PRE_MASTER',
          5: 'MASTER',
          6: 'PASSIVE',
          7: 'UNCALIBRATED',
          8: 'SLAVE'
        };
        const stateName = stateNames[metric.value] || `UNKNOWN(${metric.value})`;
        summary += `  ${metric.labels} = ${stateName}\n`;
      });
    }

    if (metrics['offset_from_master']) {
      summary += '\n=== OFFSET FROM MASTER (nanoseconds) ===\n';
      metrics['offset_from_master'].forEach(metric => {
        const offset = parseFloat(metric.value);
        const offsetStatus = Math.abs(offset) > 1000000 ? 'HIGH OFFSET!' : 'Normal';
        summary += `  ${metric.labels} = ${offset}ns (${offsetStatus})\n`;
      });
    }

    summary += '\n=== END SUMMARY ===\n';
    return summary;
  }

  isPodReady(pod) {
    const conditions = pod.status.conditions || [];
    const readyCondition = conditions.find(c => c.type === 'Ready');
    return readyCondition?.status === 'True';
  }

  isContainerReady(pod, containerName) {
    const containerStatus = pod.status.containerStatuses?.find(c => c.name === containerName);
    return containerStatus?.ready || false;
  }

  getPodRestarts(pod) {
    return pod.status.containerStatuses?.reduce((total, c) => total + c.restartCount, 0) || 0;
  }

  getAge(timestamp) {
    const now = new Date();
    const created = new Date(timestamp);
    const diffMs = now - created;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    const diffHours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const diffMinutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));

    if (diffDays > 0) return `${diffDays}d${diffHours}h`;
    if (diffHours > 0) return `${diffHours}h${diffMinutes}m`;
    return `${diffMinutes}m`;
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('PTP Operator MCP Server running on stdio');
  }
}

// Start the server
const server = new PTPOperatorMCPServer();
server.run().catch(console.error);