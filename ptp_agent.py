#!/usr/bin/env python3
"""
PTP Agentic AI - Real-time event subscriber and diagnostic agent
Subscribes to PTP events via cloud-event-proxy and provides intelligent analysis
"""

import asyncio
import json
import logging
import os
import time
from dataclasses import dataclass, asdict
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Any
from urllib.parse import urljoin

import aiohttp
import yaml
from kubernetes import client, config
from kubernetes.client.rest import ApiException

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Reduce aiohttp access log verbosity (health checks are noisy)
logging.getLogger('aiohttp.access').setLevel(logging.WARNING)

@dataclass
class PTPEvent:
    """Structured PTP event from cloud-event-proxy"""
    id: str
    type: str
    source: str
    time: str
    data_version: str
    resource_address: str
    data_type: str
    value_type: str
    value: str
    node_name: Optional[str] = None
    
    @classmethod
    def from_cloud_event(cls, event_data: Dict[str, Any]) -> 'PTPEvent':
        """Parse cloud event JSON to PTPEvent"""
        data = event_data.get('data', {})
        values = data.get('values', [{}])
        first_value = values[0] if values else {}
        
        # Extract node name from resource address
        resource_addr = first_value.get('ResourceAddress', '')
        node_name = None
        if '/cluster/node/' in resource_addr:
            parts = resource_addr.split('/cluster/node/')
            if len(parts) > 1:
                node_name = parts[1].split('/')[0]
        
        return cls(
            id=event_data.get('id', ''),
            type=event_data.get('type', ''),
            source=event_data.get('source', ''),
            time=event_data.get('time', ''),
            data_version=data.get('version', ''),
            resource_address=resource_addr,
            data_type=first_value.get('data_type', ''),
            value_type=first_value.get('value_type', ''),
            value=first_value.get('value', ''),
            node_name=node_name
        )

@dataclass
class DiagnosticResult:
    """AI diagnostic result for PTP events"""
    severity: str  # INFO, WARNING, CRITICAL
    summary: str
    details: str
    recommendations: List[str]
    affected_nodes: List[str]
    timestamp: str

class PTPEventSubscriber:
    """Subscribes to PTP events from cloud-event-proxy publisher service"""
    
    def __init__(self, ptp_namespace: str = 'openshift-ptp', agent_namespace: str = 'ptp-agent'):
        self.ptp_namespace = ptp_namespace
        self.agent_namespace = agent_namespace
        self.subscription_endpoints: List[str] = []
        self.event_buffer: List[PTPEvent] = []
        self.max_buffer_size = 1000
        self.session: Optional[aiohttp.ClientSession] = None
        
        # Initialize Kubernetes client
        try:
            config.load_kube_config()
        except:
            config.load_incluster_config()
        self.k8s_core = client.CoreV1Api()
        self.custom_api = client.CustomObjectsApi()
        
    async def discover_publisher_endpoints(self) -> List[str]:
        """Discover PTP event publisher service endpoints for each node"""
        endpoints = []
        try:
            # Get all nodes with PTP daemon pods
            pods = self.k8s_core.list_namespaced_pod(
                namespace=self.ptp_namespace,
                label_selector='app=linuxptp-daemon'
            )
            
            for pod in pods.items:
                node_name = pod.spec.node_name
                if node_name:
                    # Follow cloud-event-proxy consumer pattern: use only hostname part
                    # transportHost = strings.Replace(transportHost, "NODE_NAME", strings.Split(nodeName, ".")[0], 1)
                    hostname = node_name.split('.')[0]  # Extract hostname from FQDN
                    endpoint = f"http://ptp-event-publisher-service-{hostname}.{self.ptp_namespace}.svc.cluster.local:9043"
                    endpoints.append(endpoint)
                    logger.info(f"Discovered publisher endpoint: {endpoint} (from node: {node_name})")
            
        except ApiException as e:
            logger.error(f"Failed to discover endpoints: {e}")
            
        return endpoints
    
    async def get_ptp_api_version(self) -> str:
        """Get PTP API version from PtpOperatorConfig"""
        try:
            # Get PtpOperatorConfig to determine API version
            config_response = await asyncio.get_event_loop().run_in_executor(
                None,
                lambda: self.custom_api.list_namespaced_custom_object(
                    group="ptp.openshift.io",
                    version="v1", 
                    namespace=self.ptp_namespace,
                    plural="ptpoperatorconfigs"
                )
            )
            
            configs = config_response.get('items', [])
            if configs:
                ptp_event_config = configs[0].get('spec', {}).get('ptpEventConfig', {})
                api_version = ptp_event_config.get('apiVersion', '2.0')
                # Convert "2.0" -> "v2", "1.0" -> "v1"
                if api_version.startswith('2'):
                    return 'v2'
                else:
                    return 'v1'
        except Exception as e:
            logger.debug(f"Failed to get PTP API version: {e}, defaulting to v2")
            
        return 'v2'  # Default to v2 as per PTP operator
    
    async def discover_available_resources(self, endpoint: str, api_version: str = 'v2') -> List[str]:
        """Discover what resources are actually available on the publisher"""
        resources = []
        try:
            if not self.session:
                self.session = aiohttp.ClientSession()
                
            # Try to get current state for common resource patterns to see what exists
            common_patterns = [
                "/cluster/node/*/sync/sync-status/sync-state",
                "/cluster/node/*/sync/sync-status/os-clock-sync-state", 
                "/cluster/node/*/sync/ptp-status/lock-state",
                "/cluster/node/*/sync/ptp-status/ptp-clock-class",
                "/cluster/node/*/sync/gnss-status/gnss-sync-status"
            ]
            
            for pattern in common_patterns:
                try:
                    # Test if resource exists by trying to get current state
                    resource_path = pattern.replace('/cluster/node/*', f'/cluster/node/{endpoint.split("-")[-1].split(".")[0]}')
                    test_url = f"{endpoint}/api/ocloudNotifications/{api_version}{resource_path}/CurrentState"
                    
                    async with self.session.get(test_url, timeout=aiohttp.ClientTimeout(total=5)) as response:
                        if response.status in [200, 202]:
                            resources.append(pattern)
                            logger.debug(f"Found available resource: {pattern}")
                except:
                    pass  # Resource not available
                    
        except Exception as e:
            logger.debug(f"Failed to discover resources: {e}")
            
        return resources
    
    async def get_consumer_endpoint_for_host_network(self) -> str:
        """Get consumer endpoint using Node IP (for hostNetwork=true PTP pods)"""
        try:
            # Get our agent pod to find which node we're running on
            pods = self.k8s_core.list_namespaced_pod(
                namespace=self.agent_namespace,
                label_selector='app=ptp-agent'
            )
            
            if pods.items:
                agent_pod = pods.items[0]
                agent_node_name = agent_pod.spec.node_name
                
                # Get the node to find its IP
                node = self.k8s_core.read_node(agent_node_name)
                
                # Find the internal IP address
                for address in node.status.addresses or []:
                    if address.type == 'InternalIP':
                        node_ip = address.address
                        logger.info(f"Using Node IP {node_ip} for consumer endpoint (hostNetwork compatibility)")
                        return f"http://{node_ip}:30080/event"  # Use NodePort
                        
        except Exception as e:
            logger.error(f"Failed to get node IP: {e}")
            
        # Fallback to localhost if we can't determine node IP
        logger.warning("Could not determine node IP, using localhost")
        return "http://localhost:8080/event"
    
    async def get_host_ip_endpoint(self) -> str:
        """Get consumer endpoint using host IP (since we use hostNetwork: true)"""
        try:
            # With hostNetwork: true, we can get the host IP from environment or pod status
            host_ip = os.getenv('NODE_IP')
            if not host_ip:
                # Get our agent pod to find the host IP
                pods = self.k8s_core.list_namespaced_pod(
                    namespace=self.agent_namespace,
                    label_selector='app=ptp-agent'
                )
                
                if pods.items:
                    agent_pod = pods.items[0]
                    host_ip = agent_pod.status.host_ip or agent_pod.status.pod_ip
            
            if host_ip:
                logger.info(f"Using host IP {host_ip} for consumer endpoint (hostNetwork: true)")
                return f"http://{host_ip}:8080/event"
                        
        except Exception as e:
            logger.error(f"Failed to get host IP: {e}")
            
        # Fallback to localhost
        logger.info("Using localhost for consumer endpoint")
        return "http://localhost:8080/event"
    
    async def subscribe_to_endpoint(self, endpoint: str, callback):
        """Subscribe to a single publisher endpoint"""
        # Since we're using hostNetwork: true, use the actual host IP
        consumer_endpoint = await self.get_host_ip_endpoint()
        timestamp = int(time.time())
        
        # Get the full node FQDN from the discovered pods
        # ResourceAddress format: "/cluster/node/{FULL_FQDN}/sync/{service}/{resource}"
        node_fqdn = None
        try:
            pods = self.k8s_core.list_namespaced_pod(
                namespace=self.ptp_namespace,
                label_selector='app=linuxptp-daemon'
            )
            for pod in pods.items:
                if pod.spec.node_name and endpoint.split('ptp-event-publisher-service-')[1].split('.')[0] in pod.spec.node_name:
                    node_fqdn = pod.spec.node_name
                    break
        except:
            pass
            
        if not node_fqdn:
            # Fallback to extracting from endpoint name
            node_fqdn = endpoint.split('ptp-event-publisher-service-')[1].split('.openshift-ptp')[0]
        
        logger.info(f"Using node FQDN: {node_fqdn} for subscriptions")
        
        subscriptions = [
            {
                "Id": f"ptp-agent-sync-state-{timestamp}",
                "ResourceAddress": f"/cluster/node/{node_fqdn}/sync/sync-status/sync-state",
                "EndpointUri": consumer_endpoint
            },
            {
                "Id": f"ptp-agent-os-clock-{timestamp}",
                "ResourceAddress": f"/cluster/node/{node_fqdn}/sync/sync-status/os-clock-sync-state",
                "EndpointUri": consumer_endpoint
            },
            {
                "Id": f"ptp-agent-lock-state-{timestamp}",
                "ResourceAddress": f"/cluster/node/{node_fqdn}/sync/ptp-status/lock-state",
                "EndpointUri": consumer_endpoint
            }
        ]
        
        try:
            if not self.session:
                self.session = aiohttp.ClientSession()
            
            # Get the configured API version, with fallback
            preferred_version = await self.get_ptp_api_version()
            api_versions = [preferred_version, "v1" if preferred_version == "v2" else "v2"]
            
            successful_subscriptions = 0
            
            for api_version in api_versions:
                try:
                    api_endpoint = f"{endpoint}/api/ocloudNotifications/{api_version}/subscriptions"
                    
                    # Create multiple subscriptions for different PTP event types
                    for subscription_data in subscriptions:
                        try:
                            async with self.session.post(
                                api_endpoint,
                                json=subscription_data,
                                timeout=aiohttp.ClientTimeout(total=10)
                            ) as response:
                                if response.status == 201:
                                    logger.info(f"Successfully subscribed to {subscription_data['ResourceAddress']} on {endpoint} using API {api_version}")
                                    successful_subscriptions += 1
                                elif response.status == 409:  # Conflict - subscription already exists
                                    logger.info(f"Subscription already exists for {subscription_data['ResourceAddress']} on {endpoint}")
                                    successful_subscriptions += 1
                                else:
                                    response_text = await response.text()
                                    logger.warning(f"Subscription failed for {subscription_data['ResourceAddress']} on {endpoint} (API {api_version}): {response.status} - {response_text}")
                        except Exception as e:
                            logger.error(f"Failed to subscribe to {subscription_data['ResourceAddress']}: {e}")
                    
                    # If we got any successful subscriptions with this API version, we're done
                    if successful_subscriptions > 0:
                        return True
                        
                    # If this was v2 and failed, try v1
                    if api_version == "v2":
                        logger.debug(f"API v2 failed for {endpoint}, trying v1")
                        continue
                    else:
                        break
                        
                except Exception as e:
                    if api_version == "v2":
                        logger.debug(f"API v2 failed for {endpoint}: {e}, trying v1")
                        continue
                    else:
                        raise e
                    
        except Exception as e:
            logger.error(f"Failed to subscribe to {endpoint}: {e}")
            
        return False
    
    async def start_consumer_server(self, port: int = 8080):
        """Start HTTP server to receive events from cloud-event-proxy"""
        from aiohttp import web
        
        async def handle_event(request):
            """Handle incoming PTP events"""
            try:
                event_data = await request.json()
                ptp_event = PTPEvent.from_cloud_event(event_data)
                
                # Add to buffer
                self.event_buffer.append(ptp_event)
                if len(self.event_buffer) > self.max_buffer_size:
                    self.event_buffer.pop(0)
                
                logger.info(f"Received event: {ptp_event.type} from {ptp_event.node_name} - {ptp_event.value}")
                
                # Trigger real-time analysis
                await self.analyze_event(ptp_event)
                
                return web.Response(status=200)
                
            except Exception as e:
                logger.error(f"Failed to process event: {e}")
                return web.Response(status=500)
        
        app = web.Application()
        app.router.add_post('/event', handle_event)
        app.router.add_get('/health', lambda req: web.Response(text='OK'))
        
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, '0.0.0.0', port)
        await site.start()
        logger.info(f"Consumer server started on port {port}")
        
        return runner

class PTPDiagnosticAgent:
    """AI-powered diagnostic agent for PTP events"""
    
    def __init__(self):
        self.event_history: Dict[str, List[PTPEvent]] = {}  # node_name -> events
        self.alert_thresholds = {
            'freerun_duration_minutes': 5,
            'fault_count_threshold': 3,
            'offset_threshold': 100,
            'state_change_frequency': 10  # changes per hour
        }
        
    async def analyze_event(self, event: PTPEvent) -> Optional[DiagnosticResult]:
        """Perform intelligent analysis on PTP event"""
        node_name = event.node_name or 'unknown'
        
        # Store event in history
        if node_name not in self.event_history:
            self.event_history[node_name] = []
        self.event_history[node_name].append(event)
        
        # Keep only recent events (last 24 hours)
        cutoff_time = datetime.now() - timedelta(hours=24)
        self.event_history[node_name] = [
            e for e in self.event_history[node_name] 
            if self._parse_event_time(e.time) > cutoff_time
        ]
        
        # Analyze patterns
        return await self._diagnose_patterns(node_name, event)
    
    def _parse_event_time(self, time_str: str) -> datetime:
        """Parse event timestamp"""
        try:
            return datetime.fromisoformat(time_str.replace('Z', '+00:00'))
        except:
            return datetime.now()
    
    async def _diagnose_patterns(self, node_name: str, latest_event: PTPEvent) -> Optional[DiagnosticResult]:
        """AI-powered pattern analysis"""
        events = self.event_history[node_name]
        if len(events) < 2:
            return None
            
        # Pattern 1: Persistent FREERUN state
        if latest_event.value == 'FREERUN':
            freerun_duration = self._calculate_freerun_duration(events)
            if freerun_duration > self.alert_thresholds['freerun_duration_minutes']:
                return DiagnosticResult(
                    severity='CRITICAL',
                    summary=f'Node {node_name} in FREERUN for {freerun_duration:.1f} minutes',
                    details=f'PTP synchronization lost. Clock is free-running without external reference.',
                    recommendations=[
                        'Check network connectivity to PTP grandmaster',
                        'Verify PTP configuration on the node',
                        'Check for hardware issues with NIC timestamping',
                        'Review ptp4l daemon logs for errors'
                    ],
                    affected_nodes=[node_name],
                    timestamp=datetime.now().isoformat()
                )
        
        # Pattern 2: Frequent state changes
        state_changes = self._count_state_changes(events)
        if state_changes > self.alert_thresholds['state_change_frequency']:
            return DiagnosticResult(
                severity='WARNING',
                summary=f'Frequent PTP state changes on {node_name} ({state_changes}/hour)',
                details='Unstable PTP synchronization with frequent state transitions',
                recommendations=[
                    'Check network stability and jitter',
                    'Verify PTP configuration parameters',
                    'Monitor network path to grandmaster',
                    'Consider adjusting PTP servo parameters'
                ],
                affected_nodes=[node_name],
                timestamp=datetime.now().isoformat()
            )
        
        # Pattern 3: High offset values
        if latest_event.data_type == 'metric' and 'decimal' in latest_event.value_type:
            try:
                offset_value = abs(float(latest_event.value))
                if offset_value > self.alert_thresholds['offset_threshold']:
                    return DiagnosticResult(
                        severity='WARNING',
                        summary=f'High PTP offset on {node_name}: {offset_value}ns',
                        details=f'Clock offset exceeds threshold of {self.alert_thresholds["offset_threshold"]}ns',
                        recommendations=[
                            'Monitor trend - transient spikes may be normal',
                            'Check network path quality to grandmaster',
                            'Verify hardware timestamping is enabled',
                            'Consider PTP servo tuning if persistent'
                        ],
                        affected_nodes=[node_name],
                        timestamp=datetime.now().isoformat()
                    )
            except ValueError:
                pass
        
        return None
    
    def _calculate_freerun_duration(self, events: List[PTPEvent]) -> float:
        """Calculate how long node has been in FREERUN state"""
        freerun_events = [e for e in events if e.value == 'FREERUN']
        if not freerun_events:
            return 0
            
        first_freerun = min(freerun_events, key=lambda e: self._parse_event_time(e.time))
        duration = datetime.now() - self._parse_event_time(first_freerun.time)
        return duration.total_seconds() / 60
    
    def _count_state_changes(self, events: List[PTPEvent]) -> int:
        """Count state changes in the last hour"""
        hour_ago = datetime.now() - timedelta(hours=1)
        recent_events = [
            e for e in events 
            if self._parse_event_time(e.time) > hour_ago and e.data_type == 'notification'
        ]
        
        if len(recent_events) < 2:
            return 0
            
        changes = 0
        prev_value = None
        for event in sorted(recent_events, key=lambda e: self._parse_event_time(e.time)):
            if prev_value and event.value != prev_value:
                changes += 1
            prev_value = event.value
            
        return changes

class PTPAgenticService:
    """Main agentic service combining subscription and diagnosis"""
    
    def __init__(self, ptp_namespace: str = 'openshift-ptp', agent_namespace: str = 'ptp-agent'):
        self.subscriber = PTPEventSubscriber(ptp_namespace, agent_namespace)
        self.diagnostic_agent = PTPDiagnosticAgent()
        self.alerts: List[DiagnosticResult] = []
        self.mcp_integration_port = int(os.getenv('MCP_INTEGRATION_PORT', '8081'))
        
    async def analyze_event(self, event: PTPEvent):
        """Analyze event and generate alerts"""
        diagnosis = await self.diagnostic_agent.analyze_event(event)
        if diagnosis:
            self.alerts.append(diagnosis)
            logger.warning(f"ALERT: {diagnosis.severity} - {diagnosis.summary}")
            
            # Send to configured alerting channels
            await self._send_alert(diagnosis)
    
    async def _send_alert(self, diagnosis: DiagnosticResult):
        """Send alert to configured channels (Slack, etc.)"""
        slack_webhook = os.getenv('SLACK_WEBHOOK_URL')
        if slack_webhook:
            try:
                import aiohttp
                async with aiohttp.ClientSession() as session:
                    payload = {
                        'text': f"🚨 PTP Alert: {diagnosis.summary}\n"
                               f"Severity: {diagnosis.severity}\n"
                               f"Details: {diagnosis.details}\n"
                               f"Recommendations: {', '.join(diagnosis.recommendations)}"
                    }
                    await session.post(slack_webhook, json=payload)
            except Exception as e:
                logger.error(f"Failed to send Slack alert: {e}")
    
    async def start_mcp_integration_server(self):
        """Start HTTP server for MCP server integration"""
        from aiohttp import web
        
        async def get_recent_alerts(request):
            """Get recent alerts for MCP server"""
            hours = int(request.query.get('hours', '24'))
            cutoff = datetime.now() - timedelta(hours=hours)
            
            recent_alerts = [
                asdict(alert) for alert in self.alerts
                if datetime.fromisoformat(alert.timestamp) > cutoff
            ]
            
            return web.json_response(recent_alerts)
        
        async def get_event_summary(request):
            """Get event summary by node"""
            summary = {}
            for node_name, events in self.diagnostic_agent.event_history.items():
                recent_events = [
                    e for e in events
                    if self.diagnostic_agent._parse_event_time(e.time) > datetime.now() - timedelta(hours=1)
                ]
                
                summary[node_name] = {
                    'total_events': len(recent_events),
                    'latest_state': recent_events[-1].value if recent_events else 'unknown',
                    'event_types': list(set(e.type for e in recent_events))
                }
            
            return web.json_response(summary)
        
        app = web.Application()
        app.router.add_get('/alerts', get_recent_alerts)
        app.router.add_get('/summary', get_event_summary)
        app.router.add_get('/health', lambda req: web.Response(text='OK'))
        
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, '0.0.0.0', self.mcp_integration_port)
        await site.start()
        logger.info(f"MCP integration server started on port {self.mcp_integration_port}")
        
        return runner
    
    async def wait_for_consumer_ready(self, max_wait_seconds: int = 30):
        """Wait for consumer server to be ready before subscribing"""
        logger.info("Waiting for consumer server to be ready...")
        
        for i in range(max_wait_seconds):
            try:
                # Test our own health endpoint
                if not hasattr(self, '_health_session'):
                    self._health_session = aiohttp.ClientSession()
                
                consumer_endpoint = await self.subscriber.get_host_ip_endpoint()
                health_url = consumer_endpoint.replace('/event', '/health')
                
                async with self._health_session.get(health_url, timeout=aiohttp.ClientTimeout(total=2)) as response:
                    if response.status == 200:
                        logger.info(f"Consumer server ready at {consumer_endpoint}")
                        return
                        
            except Exception as e:
                if i == 0:  # Log only first attempt
                    logger.debug(f"Consumer not ready yet: {e}")
                    
            await asyncio.sleep(1)
            
        logger.warning(f"Consumer server not ready after {max_wait_seconds}s, proceeding anyway")
    
    async def run(self):
        """Main run loop"""
        logger.info("Starting PTP Agentic Service...")
        
        # Start consumer server
        consumer_runner = await self.subscriber.start_consumer_server()
        
        # Start MCP integration server
        mcp_runner = await self.start_mcp_integration_server()
        
        # Wait for consumer server to be ready
        await self.wait_for_consumer_ready()
        
        # Discover and subscribe to publishers
        endpoints = await self.subscriber.discover_publisher_endpoints()
        
        subscription_tasks = []
        for endpoint in endpoints:
            task = asyncio.create_task(
                self.subscriber.subscribe_to_endpoint(endpoint, self.analyze_event)
            )
            subscription_tasks.append(task)
        
        # Wait for subscriptions to complete
        results = await asyncio.gather(*subscription_tasks, return_exceptions=True)
        successful_subs = sum(1 for r in results if r is True)
        logger.info(f"Successfully subscribed to {successful_subs}/{len(endpoints)} endpoints")
        
        # Keep running
        try:
            while True:
                await asyncio.sleep(60)  # Reduce frequency of status logs
                logger.info(f"Status: {len(self.alerts)} active alerts, {len(self.subscriber.event_buffer)} events buffered")
        except KeyboardInterrupt:
            logger.info("Shutting down...")
        finally:
            await consumer_runner.cleanup()
            await mcp_runner.cleanup()
            if self.subscriber.session:
                await self.subscriber.session.close()

async def main():
    """Main entry point"""
    ptp_namespace = os.getenv('PTP_NAMESPACE', 'openshift-ptp')
    agent_namespace = os.getenv('AGENT_NAMESPACE', 'ptp-agent')
    service = PTPAgenticService(ptp_namespace, agent_namespace)
    await service.run()

if __name__ == '__main__':
    asyncio.run(main())
