"""
Configuration settings for PTP MCP Server

Handles environment variables, Kubernetes Downward API,
and application configuration.
"""

import os
import socket
from pathlib import Path
from typing import Optional
from dataclasses import dataclass

@dataclass
class Settings:
    """Application settings loaded from environment and Downward API"""
    
    # Server configuration
    port: int
    host: str
    log_level: str
    
    # Kubernetes configuration  
    kubernetes_namespace: str
    pod_name: str
    node_name: str
    pod_ip: str
    service_account: str
    
    # PTP configuration
    health_check_interval: int
    event_buffer_size: int
    subscription_timeout: int
    
    # Feature flags
    enable_metrics: bool
    enable_tracing: bool
    
    def __init__(self):
        """Initialize settings from environment and Downward API"""
        
        # Server settings
        self.port = int(os.getenv('MCP_SERVER_PORT', 3000))
        self.host = os.getenv('MCP_SERVER_HOST', '0.0.0.0')
        self.log_level = os.getenv('LOG_LEVEL', 'INFO').upper()
        
        # Kubernetes settings from Downward API
        self.kubernetes_namespace = self._get_kubernetes_namespace()
        self.pod_name = self._get_pod_name()
        self.node_name = self._get_node_name()
        self.pod_ip = self._get_pod_ip()
        self.service_account = os.getenv('SERVICE_ACCOUNT', 'ptp-mcp-server')
        
        # PTP settings
        self.health_check_interval = int(os.getenv('HEALTH_CHECK_INTERVAL', 60))
        self.event_buffer_size = int(os.getenv('EVENT_BUFFER_SIZE', 1000))
        self.subscription_timeout = int(os.getenv('SUBSCRIPTION_TIMEOUT', 30))
        
        # Feature flags
        self.enable_metrics = os.getenv('ENABLE_METRICS', 'true').lower() == 'true'
        self.enable_tracing = os.getenv('ENABLE_TRACING', 'false').lower() == 'true'
    
    def _get_node_name(self) -> str:
        """Get node name from Kubernetes Downward API"""
        
        # Method 1: Environment variable from Downward API
        node_name = os.getenv('NODE_NAME')
        if node_name:
            return node_name
        
        # Method 2: Volume mount from Downward API
        node_name_file = Path('/etc/podinfo/nodename')
        if node_name_file.exists():
            return node_name_file.read_text().strip()
        
        # Method 3: spec.nodeName field file
        spec_node_name_file = Path('/etc/podinfo/spec.nodeName')
        if spec_node_name_file.exists():
            return spec_node_name_file.read_text().strip()
        
        # Fallback: hostname (not recommended for production)
        hostname = socket.gethostname()
        print(f"⚠️  Warning: Using hostname as node name fallback: {hostname}")
        return hostname
    
    def _get_pod_name(self) -> str:
        """Get pod name from Kubernetes Downward API"""
        
        # Method 1: Environment variable from Downward API
        pod_name = os.getenv('POD_NAME')
        if pod_name:
            return pod_name
        
        # Method 2: Volume mount from Downward API
        pod_name_file = Path('/etc/podinfo/podname')
        if pod_name_file.exists():
            return pod_name_file.read_text().strip()
        
        # Fallback: hostname
        return socket.gethostname()
    
    def _get_kubernetes_namespace(self) -> str:
        """Get Kubernetes namespace"""
        
        # Method 1: Environment variable from Downward API
        namespace = os.getenv('KUBERNETES_NAMESPACE')
        if namespace:
            return namespace
        
        # Method 2: Volume mount from Downward API
        namespace_file = Path('/etc/podinfo/podnamespace')
        if namespace_file.exists():
            return namespace_file.read_text().strip()
        
        # Method 3: Service account namespace file
        sa_namespace_file = Path('/var/run/secrets/kubernetes.io/serviceaccount/namespace')
        if sa_namespace_file.exists():
            return sa_namespace_file.read_text().strip()
        
        # Fallback: default PTP namespace
        return 'openshift-ptp'
    
    def _get_pod_ip(self) -> str:
        """Get pod IP from Kubernetes Downward API"""
        
        # Method 1: Environment variable from Downward API
        pod_ip = os.getenv('POD_IP')
        if pod_ip:
            return pod_ip
        
        # Method 2: Volume mount from Downward API
        pod_ip_file = Path('/etc/podinfo/podip')
        if pod_ip_file.exists():
            return pod_ip_file.read_text().strip()
        
        # Fallback: attempt to get local IP
        try:
            import socket
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            local_ip = s.getsockname()[0]
            s.close()
            return local_ip
        except Exception:
            return '127.0.0.1'
    
    @property
    def callback_url(self) -> str:
        """Generate callback URL for event subscriptions"""
        return f"http://ptp-mcp-server-service.{self.kubernetes_namespace}.svc.cluster.local/events/callback"
    
    @property
    def is_kubernetes_environment(self) -> bool:
        """Check if running in Kubernetes environment"""
        return os.path.exists('/var/run/secrets/kubernetes.io/serviceaccount')
    
    @property
    def metrics_enabled(self) -> bool:
        """Check if metrics collection is enabled"""
        return self.enable_metrics
    
    def get_publisher_url(self, node_name: str) -> str:
        """Generate publisher URL for a specific node"""
        return f"http://ptp-event-publisher-service-{node_name}.{self.kubernetes_namespace}.svc.cluster.local:9043"
    
    def get_node_callback_url(self, node_name: str) -> str:
        """Generate node-specific callback URL"""
        return f"{self.callback_url}/{node_name}"
    
    def to_dict(self) -> dict:
        """Convert settings to dictionary for logging/debugging"""
        return {
            'server': {
                'port': self.port,
                'host': self.host,
                'log_level': self.log_level
            },
            'kubernetes': {
                'namespace': self.kubernetes_namespace,
                'pod_name': self.pod_name,
                'node_name': self.node_name,
                'pod_ip': self.pod_ip,
                'service_account': self.service_account,
                'is_k8s_env': self.is_kubernetes_environment
            },
            'ptp': {
                'health_check_interval': self.health_check_interval,
                'event_buffer_size': self.event_buffer_size,
                'subscription_timeout': self.subscription_timeout
            },
            'features': {
                'metrics_enabled': self.enable_metrics,
                'tracing_enabled': self.enable_tracing
            }
        }
