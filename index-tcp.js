#!/usr/bin/env node

/**
 * HTTP/TCP version of the PTP MCP server for in-cluster deployment
 * Exposes MCP tools via HTTP endpoints instead of stdio
 */

import express from 'express';
import cors from 'cors';
import { PTPOperatorMCPServer } from './index.js';

const app = express();
const PORT = process.env.MCP_PORT || 3000;

// Enable CORS and JSON parsing
app.use(cors());
app.use(express.json());

// Create PTP server instance
const ptpServer = new PTPOperatorMCPServer();

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    server: 'ptp-mcp-server-http',
    version: '1.0.0'
  });
});

// List available tools endpoint
app.get('/tools', async (req, res) => {
  try {
    // Simulate MCP tools/list request
    const toolsResponse = await ptpServer.server.request({
      method: 'tools/list',
      params: {}
    });
    res.json(toolsResponse);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Execute tool endpoint
app.post('/tools/:toolName', async (req, res) => {
  try {
    const { toolName } = req.params;
    const args = req.body || {};
    
    // Simulate MCP tools/call request
    const result = await ptpServer.server.request({
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args
      }
    });
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Direct tool endpoints for easier access
app.get('/ptp/pods', async (req, res) => {
  try {
    const result = await callTool('list_ptp_pods', req.query);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/ptp/events', async (req, res) => {
  try {
    const result = await callTool('get_cloud_events', req.query);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/ptp/alerts', async (req, res) => {
  try {
    const result = await callTool('get_agent_alerts', req.query);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/ptp/summary', async (req, res) => {
  try {
    const result = await callTool('get_agent_summary', req.query);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/ptp/status', async (req, res) => {
  try {
    const result = await callTool('check_ptp_status', req.query);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Helper function to call tools
async function callTool(toolName, args) {
  // Create a mock request object that matches MCP format
  const request = {
    params: {
      name: toolName,
      arguments: args || {}
    }
  };
  
  // Call the tool handler directly
  switch (toolName) {
    case 'list_ptp_pods':
      return await ptpServer.listPTPPods(args);
    case 'get_ptp_configs':
      return await ptpServer.getPtpConfigs(args);
    case 'get_node_ptp_configs':
      return await ptpServer.getNodePtpConfigs(args);
    case 'get_daemon_logs':
      return await ptpServer.getDaemonLogs(args);
    case 'get_proxy_logs':
      return await ptpServer.getProxyLogs(args);
    case 'analyze_ptp_faults':
      return await ptpServer.analyzePTPFaults(args);
    case 'get_ptp_metrics':
      return await ptpServer.getPTPMetrics(args);
    case 'check_ptp_status':
      return await ptpServer.checkPTPStatus(args);
    case 'exec_ptp_command':
      return await ptpServer.execPTPCommand(args);
    case 'monitor_ptp_events':
      return await ptpServer.monitorPTPEvents(args);
    case 'get_ptp_config':
      return await ptpServer.getPTPConfig(args);
    case 'diagnose_ptp_issues':
      return await ptpServer.diagnosePTPIssues(args);
    case 'get_cloud_events':
      return await ptpServer.getCloudEvents(args);
    case 'get_agent_alerts':
      return await ptpServer.getAgentAlerts(args);
    case 'get_agent_summary':
      return await ptpServer.getAgentSummary(args);
    default:
      throw new Error(`Tool ${toolName} not found`);
  }
}

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('HTTP MCP Server Error:', error);
  res.status(500).json({ 
    error: 'Internal server error',
    message: error.message,
    timestamp: new Date().toISOString()
  });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 PTP MCP HTTP Server listening on port ${PORT}`);
  console.log(`📋 Health check: http://localhost:${PORT}/health`);
  console.log(`🔧 Tools list: http://localhost:${PORT}/tools`);
  console.log(`📊 PTP Status: http://localhost:${PORT}/ptp/status`);
  console.log(`🚨 PTP Alerts: http://localhost:${PORT}/ptp/alerts`);
  console.log(`📈 PTP Events: http://localhost:${PORT}/ptp/events`);
});
