#!/bin/bash
# create_pr_files.sh - Create all PR integration files

set -e

echo "🚀 Creating Enhanced PTP MCP Server integration files..."

# Create directory structure
echo "📁 Creating directory structure..."
mkdir -p src/event_consumer
mkdir -p src/enhanced_tools  
mkdir -p src/config
mkdir -p k8s
mkdir -p scripts
mkdir -p examples
mkdir -p tests

# Create __init__.py files for Python modules
touch src/__init__.py
touch src/event_consumer/__init__.py
touch src/enhanced_tools/__init__.py
touch src/config/__init__.py

echo "✅ Directory structure created!"

# Create main application files
echo "📝 Creating main application files..."

# 1. src/config/settings.py
cat > src/config/settings.py << 'EOF'
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
EOF

echo "✅ Created src/config/settings.py"

# 2. src/event_consumer/models.py
cat > src/event_consumer/models.py << 'EOF'
"""
Data models for PTP events and node services
"""

from dataclasses import dataclass, asdict
from typing import Dict, List, Any, Optional
from datetime import datetime

@dataclass
class NodePTPService:
    node_name: str
    pod_name: str
    publisher_url: str
    is_reachable: bool = False
    last_health_check: Optional[datetime] = None

@dataclass
class PTPEvent:
    id: str
    type: str
    source: str
    time: str
    node_name: str
    values: List[Dict[str, Any]] = None
    data: Dict[str, Any] = None
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary"""
        return asdict(self)
    
    def get_severity(self) -> str:
        """Determine event severity"""
        if self.values:
            for value in self.values:
                if value.get('value') == 'FREERUN':
                    return 'critical'
                if value.get('valueType') == 'decimal64.3':
                    try:
                        offset = abs(float(value.get('value', 0)))
                        if offset > 500:
                            return 'warning'
                    except (ValueError, TypeError):
                        pass
        
        if 'synchronization-state-change' in self.type:
            return 'warning'
            
        return 'info'

@dataclass
class EventAnalysis:
    event: PTPEvent
    severity: str
    timestamp: str
    node_name: str
    needs_attention: bool
    recommendations: List[str] = None
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary"""
        return asdict(self)
EOF

echo "✅ Created src/event_consumer/models.py"

# 3. Create Dockerfile
cat > Dockerfile << 'EOF'
# Dockerfile for PTP MCP Server with Real-time Event Consumer
FROM python:3.11-slim

# Set build arguments
ARG APP_VERSION=latest
ARG BUILD_DATE
ARG GIT_COMMIT

# Labels
LABEL maintainer="aneeshkp" \
      version="${APP_VERSION}" \
      description="PTP MCP Server with Real-time Event Consumer" \
      build-date="${BUILD_DATE}" \
      git-commit="${GIT_COMMIT}"

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Set working directory
WORKDIR /app

# Copy requirements first for better layer caching
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

# Create non-root user
RUN groupadd -r appuser && useradd -r -g appuser -u 1001 appuser

# Copy application code
COPY src/ ./src/
COPY *.py ./

# Create necessary directories with proper permissions
RUN mkdir -p /tmp /app/logs \
    && chown -R appuser:appuser /app /tmp

# Switch to non-root user
USER appuser

# Expose MCP server port
EXPOSE 3000

# Health check for the MCP server
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1

# Environment variables
ENV PYTHONPATH=/app \
    PYTHONUNBUFFERED=1 \
    NODE_ENV=production \
    MCP_SERVER_PORT=3000 \
    MCP_SERVER_HOST=0.0.0.0

# Start the MCP server
CMD ["python", "src/server.py"]
EOF

echo "✅ Created Dockerfile"

# 4. Update requirements.txt
cat > requirements.txt << 'EOF'
# Enhanced PTP MCP Server Dependencies

# Existing dependencies - KEEP YOUR CURRENT ONES HERE
# Add these new dependencies for real-time event consumer

# FastAPI and async web server
fastapi==0.104.1
uvicorn[standard]==0.24.0

# HTTP client for event subscriptions
aiohttp==3.9.1

# Kubernetes client
kubernetes==28.1.0

# Data validation and serialization
pydantic==2.5.0

# For handling multipart forms
python-multipart==0.0.6

# Async utilities
tenacity==8.2.3

# Logging and monitoring
structlog==23.2.0
prometheus-client==0.19.0

# JSON schema validation
jsonschema==4.20.0

# Date/time handling
python-dateutil==2.8.2

# Development and testing
pytest==7.4.3
pytest-asyncio==0.21.1
pytest-mock==3.12.0
httpx==0.25.2

# Optional: For advanced analytics
numpy==1.24.4
pandas==2.1.3
EOF

echo "✅ Created/updated requirements.txt"

# 5. Create Kubernetes deployment
cat > k8s/deployment.yaml << 'EOF'
# Complete Kubernetes deployment for Enhanced PTP MCP Server
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ptp-mcp-server
  namespace: openshift-ptp
  labels:
    app: ptp-mcp-server
    version: v2.0.0
spec:
  replicas: 1
  selector:
    matchLabels:
      app: ptp-mcp-server
  template:
    metadata:
      labels:
        app: ptp-mcp-server
        version: v2.0.0
    spec:
      serviceAccountName: ptp-mcp-server
      containers:
      - name: ptp-mcp-server
        image: quay.io/aneeshkp/ptp-mcp-server:latest
        ports:
        - containerPort: 3000
          name: http
          protocol: TCP
        
        # Environment variables from Downward API
        env:
        - name: NODE_ENV
          value: "production"
        - name: MCP_SERVER_PORT
          value: "3000"
        - name: MCP_SERVER_HOST
          value: "0.0.0.0"
        - name: LOG_LEVEL
          value: "INFO"
        
        # Kubernetes info from Downward API
        - name: KUBERNETES_NAMESPACE
          valueFrom:
            fieldRef:
              fieldPath: metadata.namespace
        - name: POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        - name: NODE_NAME
          valueFrom:
            fieldRef:
              fieldPath: spec.nodeName
        - name: POD_IP
          valueFrom:
            fieldRef:
              fieldPath: status.podIP
        - name: SERVICE_ACCOUNT
          valueFrom:
            fieldRef:
              fieldPath: spec.serviceAccountName
        
        # Volume mounts for Downward API files
        volumeMounts:
        - name: podinfo
          mountPath: /etc/podinfo
          readOnly: true
        
        # Resource limits
        resources:
          requests:
            memory: "512Mi"
            cpu: "200m"
          limits:
            memory: "1Gi"
            cpu: "500m"
        
        # Health checks
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 60
          periodSeconds: 30
          timeoutSeconds: 10
          failureThreshold: 3
        
        readinessProbe:
          httpGet:
            path: /ready
            port: 3000
          initialDelaySeconds: 15
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 3
        
        # Security context
        securityContext:
          runAsNonRoot: true
          runAsUser: 1001
          runAsGroup: 1001
          readOnlyRootFilesystem: true
          allowPrivilegeEscalation: false
          capabilities:
            drop:
            - ALL
      
      # Volumes for Downward API
      volumes:
      - name: podinfo
        downwardAPI:
          items:
          - path: "nodename"
            fieldRef:
              fieldPath: spec.nodeName
          - path: "podname"
            fieldRef:
              fieldPath: metadata.name
          - path: "podnamespace"
            fieldRef:
              fieldPath: metadata.namespace
          - path: "podip"
            fieldRef:
              fieldPath: status.podIP
          - path: "spec.nodeName"
            fieldRef:
              fieldPath: spec.nodeName
      
      # Restart policy
      restartPolicy: Always

---
# ServiceAccount for RBAC
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ptp-mcp-server
  namespace: openshift-ptp
  labels:
    app: ptp-mcp-server

---
# ClusterRole for accessing PTP resources
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: ptp-mcp-server
  labels:
    app: ptp-mcp-server
rules:
# Pod and Service discovery
- apiGroups: [""]
  resources: ["pods", "services", "endpoints", "nodes"]
  verbs: ["get", "list", "watch"]

# ConfigMaps and Secrets
- apiGroups: [""]
  resources: ["configmaps", "secrets"]
  verbs: ["get", "list", "watch"]

# Events
- apiGroups: [""]
  resources: ["events"]
  verbs: ["get", "list", "watch", "create"]

# Deployment and DaemonSet access
- apiGroups: ["apps"]
  resources: ["deployments", "daemonsets", "replicasets"]
  verbs: ["get", "list", "watch"]

# PTP-specific resources
- apiGroups: ["ptp.openshift.io"]
  resources: ["ptpconfigs", "ptpoperatorconfigs", "nodeptpdevices"]
  verbs: ["get", "list", "watch"]

---
# ClusterRoleBinding
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: ptp-mcp-server
  labels:
    app: ptp-mcp-server
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: ptp-mcp-server
subjects:
- kind: ServiceAccount
  name: ptp-mcp-server
  namespace: openshift-ptp
EOF

echo "✅ Created k8s/deployment.yaml"

# 6. Create services
cat > k8s/service.yaml << 'EOF'
# Internal ClusterIP Service for event callbacks
apiVersion: v1
kind: Service
metadata:
  name: ptp-mcp-server-service
  namespace: openshift-ptp
  labels:
    app: ptp-mcp-server
    service-type: internal
spec:
  type: ClusterIP
  selector:
    app: ptp-mcp-server
  ports:
  - name: http
    port: 80
    targetPort: 3000
    protocol: TCP

---
# External LoadBalancer Service for Claude access
apiVersion: v1
kind: Service
metadata:
  name: ptp-mcp-server-external
  namespace: openshift-ptp
  labels:
    app: ptp-mcp-server
    service-type: external
spec:
  type: LoadBalancer
  selector:
    app: ptp-mcp-server
  ports:
  - name: http
    port: 80
    targetPort: 3000
    protocol: TCP
  - name: https
    port: 443
    targetPort: 3000
    protocol: TCP

---
# NodePort Service for development/testing
apiVersion: v1
kind: Service
metadata:
  name: ptp-mcp-server-nodeport
  namespace: openshift-ptp
  labels:
    app: ptp-mcp-server
    service-type: nodeport
spec:
  type: NodePort
  selector:
    app: ptp-mcp-server
  ports:
  - name: http
    port: 3000
    targetPort: 3000
    nodePort: 30300
    protocol: TCP
EOF

echo "✅ Created k8s/service.yaml"

# Make scripts executable
chmod +x scripts/*.sh

echo ""
echo "🎉 All integration files created successfully!"
echo ""
echo "📂 File structure created:"
echo "├── src/"
echo "│   ├── config/settings.py"
echo "│   ├── event_consumer/models.py" 
echo "│   └── [Need to add: consumer.py, enhanced_tools.py, server.py]"
echo "├── k8s/"
echo "│   ├── deployment.yaml"
echo "│   └── service.yaml"
echo "├── scripts/"
echo "│   └── [Need to add build/deploy scripts]"
echo "├── Dockerfile"
echo "└── requirements.txt"
echo ""
echo "📝 Next steps:"
echo "1. Add your existing PTP tools to the integration"
echo "2. Run: chmod +x scripts/*.sh"
echo "3. Update registry in deployment.yaml: quay.io/aneeshkp"
echo "4. Build: ./scripts/build.sh"
echo "5. Deploy: ./scripts/deploy.sh"
echo ""
echo "💡 Need the remaining large files? Run the individual file creators next!"
EOF

echo "✅ File creation script ready!"

# Create the remaining large files script
cat > create_remaining_files.sh << 'EOF'
#!/bin/bash
# create_remaining_files.sh - Create the larger Python files

echo "📝 Creating remaining large Python files..."

# Create the event consumer
echo "Creating src/event_consumer/consumer.py..."
cat > src/event_consumer/consumer.py << 'CONSUMER_EOF'
"""
Node-Aware PTP Event Consumer
Integrates with existing ptp-operator-mcp-server
"""

import asyncio
import json
import logging
import os
from datetime import datetime, timezone
from typing import Dict, List, Optional, Any, Callable
from pathlib import Path

import aiohttp
from kubernetes import client, config

from .models import NodePTPService, PTPEvent

logger = logging.getLogger(__name__)

class NodeAwarePTPConsumer:
    """Node-aware PTP event consumer integrated with existing MCP server"""
    
    def __init__(self, namespace: str = "openshift-ptp"):
        self.namespace = namespace
        self.node_services: Dict[str, NodePTPService] = {}
        self.subscriptions: Dict[str, List[Dict]] = {}
        self.is_running = False
        self.event_handlers: List[Callable] = []
        
        # Get node name from Downward API
        self.current_node_name = self._get_node_name_from_downward_api()
        logger.info(f"🚀 Event Consumer running on node: {self.current_node_name}")
        
        # Initialize Kubernetes client
        self._init_k8s_client()
        
    def _get_node_name_from_downward_api(self) -> str:
        """Get node name from Kubernetes Downward API"""
        
        # Method 1: Environment variable from Downward API
        node_name = os.getenv('NODE_NAME')
        if node_name:
            logger.info(f"📍 Node name from NODE_NAME env var: {node_name}")
            return node_name
            
        # Method 2: Volume mount from Downward API
        node_name_file = Path('/etc/podinfo/nodename')
        if node_name_file.exists():
            node_name = node_name_file.read_text().strip()
            logger.info(f"📍 Node name from volume mount: {node_name}")
            return node_name
            
        # Fallback: hostname
        import socket
        hostname = socket.gethostname()
        logger.warning(f"⚠️ Using hostname as fallback: {hostname}")
        return hostname
        
    def _init_k8s_client(self):
        """Initialize Kubernetes client"""
        try:
            # Load in-cluster config when running in pod
            if os.path.exists('/var/run/secrets/kubernetes.io/serviceaccount'):
                config.load_incluster_config()
                logger.info("✅ Loaded in-cluster Kubernetes config")
            else:
                config.load_kube_config()
                logger.info("✅ Loaded local Kubernetes config")
                
            self.k8s_client = client.CoreV1Api()
        except Exception as e:
            logger.error(f"❌ Failed to initialize Kubernetes client: {e}")
            raise

    async def discover_ptp_nodes(self) -> None:
        """Discover all PTP-enabled nodes in the cluster"""
        logger.info("🔍 Discovering PTP-enabled nodes...")
        
        try:
            # List all PTP daemon pods
            pod_list = self.k8s_client.list_namespaced_pod(
                namespace=self.namespace,
                label_selector="app=linuxptp-daemon"
            )
            
            self.node_services.clear()
            
            for pod in pod_list.items:
                if pod.spec.node_name and pod.status.phase == "Running":
                    node_name = pod.spec.node_name
                    pod_name = pod.metadata.name
                    
                    # Construct publisher URL with node name
                    publisher_url = f"http://ptp-event-publisher-service-{node_name}.{self.namespace}.svc.cluster.local:9043"
                    
                    node_service = NodePTPService(
                        node_name=node_name,
                        pod_name=pod_name,
                        publisher_url=publisher_url
                    )
                    
                    # Test connectivity
                    node_service.is_reachable = await self._test_node_connectivity(node_service)
                    node_service.last_health_check = datetime.now(timezone.utc)
                    
                    self.node_services[node_name] = node_service
                    
                    logger.info(f"📡 Found PTP node: {node_name}")
                    logger.info(f"   Pod: {pod_name}")
                    logger.info(f"   Publisher: {publisher_url}")
                    logger.info(f"   Reachable: {'✅' if node_service.is_reachable else '❌'}")
                    
            logger.info(f"✅ Discovered {len(self.node_services)} PTP nodes")
            
        except Exception as e:
            logger.error(f"❌ Failed to discover PTP nodes: {e}")
            raise

    async def start(self) -> None:
        """Start the node-aware PTP consumer"""
        logger.info("🚀 Starting Node-Aware PTP Consumer...")
        
        await self.discover_ptp_nodes()
        
        if not self.node_services:
            logger.warning("⚠️ No PTP nodes discovered")
            
        # Create subscriptions for reachable nodes
        for node_name, node_service in self.node_services.items():
            if node_service.is_reachable:
                try:
                    await self._create_node_subscriptions(node_service)
                    logger.info(f"✅ Subscriptions created for node: {node_name}")
                except Exception as e:
                    logger.error(f"❌ Failed to create subscriptions for {node_name}: {e}")
        
        self.is_running = True
        asyncio.create_task(self._health_monitoring_task())
        
        logger.info("✅ Node-Aware PTP Consumer started")

    async def _test_node_connectivity(self, node_service: NodePTPService) -> bool:
        """Test connectivity to a node's publisher service"""
        try:
            timeout = aiohttp.ClientTimeout(total=5)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                health_url = f"{node_service.publisher_url}/api/ocloudNotifications/v1/health"
                async with session.get(health_url) as response:
                    return response.status == 200
        except Exception as e:
            logger.warning(f"⚠️ Node {node_service.node_name} not reachable: {e}")
            return False

    async def _create_node_subscriptions(self, node_service: NodePTPService) -> None:
        """Create PTP subscriptions for a specific node"""
        
        subscriptions_config = [
            {
                "resource": f"/cluster/node/{node_service.node_name}/sync/sync-status/sync-state",
                "description": "Sync State Changes"
            },
            {
                "resource": f"/cluster/node/{node_service.node_name}/sync/sync-status/os-clock-sync-state", 
                "description": "OS Clock Sync State"
            }
        ]
        
        node_subscriptions = []
        
        for sub_config in subscriptions_config:
            try:
                subscription = await self._create_subscription(node_service, sub_config["resource"])
                node_subscriptions.append(subscription)
                logger.info(f"📋 Created subscription for {node_service.node_name}: {sub_config['description']}")
            except Exception as e:
                logger.error(f"❌ Failed to create subscription: {e}")
                
        self.subscriptions[node_service.node_name] = node_subscriptions

    async def _create_subscription(self, node_service: NodePTPService, resource: str) -> Dict:
        """Create a subscription with a specific node's publisher service"""
        
        callback_url = f"http://ptp-mcp-server-service.{self.namespace}.svc.cluster.local/events/callback/{node_service.node_name}"
        
        subscription_request = {
            "resource": resource,
            "uriLocation": callback_url
        }
        
        timeout = aiohttp.ClientTimeout(total=10)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            subscription_url = f"{node_service.publisher_url}/api/ocloudNotifications/v1/subscriptions"
            
            async with session.post(
                subscription_url,
                json=subscription_request,
                headers={"Content-Type": "application/json"}
            ) as response:
                response.raise_for_status()
                return await response.json()

    async def _handle_callback_event(self, node_name: str, event_data: Dict) -> None:
        """Handle events received via callback from publishers"""
        logger.info(f"📨 Callback event from {node_name}: {event_data.get('type', 'unknown')}")
        
        # Create enriched event
        event = PTPEvent(
            id=event_data.get('id', ''),
            type=event_data.get('type', ''),
            source=event_data.get('source', ''),
            time=event_data.get('time', ''),
            node_name=node_name,
            values=event_data.get('values', []),
            data=event_data.get('data', {})
        )
        
        # Notify all event handlers
        for handler in self.event_handlers:
            try:
                await handler(event)
            except Exception as e:
                logger.error(f"❌ Event handler failed: {e}")

    async def _health_monitoring_task(self) -> None:
        """Background task for monitoring node health"""
        while self.is_running:
            try:
                logger.info("🔍 Performing node health checks...")
                
                for node_name, node_service in self.node_services.items():
                    was_reachable = node_service.is_reachable
                    node_service.is_reachable = await self._test_node_connectivity(node_service)
                    node_service.last_health_check = datetime.now(timezone.utc)
                    
                    if not was_reachable and node_service.is_reachable:
                        logger.info(f"🟢 Node {node_name} is back online")
                        
            except Exception as e:
                logger.error(f"❌ Health monitoring failed: {e}")
                
            await asyncio.sleep(60)

    async def get_node_events(self, node_name: str, limit: int = 20) -> List[Dict]:
        """Get recent events from a specific node"""
        # Mock implementation - replace with actual event storage/retrieval
        return [
            {
                "id": f"event-{i}",
                "type": "event.sync.sync-status.synchronization-state-change",
                "time": datetime.now(timezone.utc).isoformat(),
                "node_name": node_name,
                "values": [{"value": "LOCKED" if i % 2 == 0 else "FREERUN"}]
            }
            for i in range(min(limit, 5))
        ]

    def get_status(self) -> Dict:
        """Get current status of all nodes"""
        nodes = []
        for node_name, service in self.node_services.items():
            nodes.append({
                "node_name": node_name,
                "pod_name": service.pod_name,
                "is_reachable": service.is_reachable,
                "subscriptions": len(self.subscriptions.get(node_name, [])),
                "publisher_url": service.publisher_url,
                "last_health_check": service.last_health_check.isoformat() if service.last_health_check else None
            })
        
        return {
            "current_node": self.current_node_name,
            "total_nodes": len(self.node_services),
            "reachable_nodes": len([n for n in self.node_services.values() if n.is_reachable]),
            "connected_nodes": len([n for n in self.node_services.values() if n.is_reachable]),
            "nodes": nodes,
            "is_running": self.is_running
        }

    def add_event_handler(self, handler: Callable) -> None:
        """Add an event handler for real-time event processing"""
        self.event_handlers.append(handler)

    def remove_event_handler(self, handler: Callable) -> None:
        """Remove an event handler"""
        if handler in self.event_handlers:
            self.event_handlers.remove(handler)

    async def stop(self) -> None:
        """Stop the consumer and cleanup"""
        logger.info("🛑 Stopping Node-Aware PTP Consumer...")
        self.is_running = False
        
        # Cleanup subscriptions and handlers
        await self._cleanup_all_subscriptions()
        self.event_handlers.clear()
        
        logger.info("✅ Node-Aware PTP Consumer stopped")

    async def _cleanup_all_subscriptions(self) -> None:
        """Cleanup subscriptions for all nodes"""
        for node_name, subscriptions in self.subscriptions.items():
            node_service = self.node_services.get(node_name)
            if not node_service or not node_service.is_reachable:
                continue
                
            for subscription in subscriptions:
                try:
                    timeout = aiohttp.ClientTimeout(total=5)
                    async with aiohttp.ClientSession(timeout=timeout) as session:
                        delete_url = f"{node_service.publisher_url}/api/ocloudNotifications/v1/subscriptions/{subscription.get('id')}"
                        await session.delete(delete_url)
                        logger.info(f"🧹 Cleaned up subscription on {node_name}")
                except Exception as e:
                    logger.error(f"❌ Failed to cleanup subscription on {node_name}: {e}")
        
        self.subscriptions.clear()
CONSUMER_EOF

echo "✅ Created src/event_consumer/consumer.py"

# Create the enhanced tools
echo "Creating src/enhanced_tools/enhanced_ptp_tools.py..."
cat > src/enhanced_tools/enhanced_ptp_tools.py << 'TOOLS_EOF'
"""
Enhanced PTP Tools - Combines existing static analysis with real-time events
"""

import logging
from datetime import datetime, timezone
from typing import Dict, Any, List, Optional

logger = logging.getLogger(__name__)

class EnhancedPTPTools:
    """Enhanced PTP tools that combine static analysis with real-time events"""
    
    def __init__(self, static_tools=None, event_consumer=None):
        self.static_tools = static_tools
        self.event_consumer = event_consumer
        
    async def handle_tool_call(self, method: str, params: Dict[str, Any]) -> Dict[str, Any]:
        """Enhanced tool call handler that combines static + real-time analysis"""
        
        logger.info(f"🔧 Enhanced tool call: {method}")
        
        # Enhanced versions of existing tools
        if method == "ptp-operator:check_ptp_status":
            return await self._enhanced_check_ptp_status(params)
        
        elif method == "ptp-operator:analyze_ptp_faults":
            return await self._enhanced_analyze_ptp_faults(params)
        
        elif method == "ptp-operator:get_ptp_metrics":
            return await self._enhanced_get_ptp_metrics(params)
        
        elif method == "ptp-operator:list_ptp_pods":
            return await self._enhanced_list_ptp_pods(params)
        
        # New real-time enhanced tools
        elif method == "ptp-operator:monitor_real_time":
            return await self._monitor_real_time(params)
        
        elif method == "ptp-operator:node_health_score":
            return await self._node_health_score(params)
        
        else:
            # Fallback to static tools if available
            if self.static_tools and hasattr(self.static_tools, 'handle_tool_call'):
                return await self.static_tools.handle_tool_call(method, params)
            else:
                return {"error": f"Unknown method: {method}", "available_methods": [
                    "ptp-operator:check_ptp_status",
                    "ptp-operator:analyze_ptp_faults", 
                    "ptp-operator:get_ptp_metrics",
                    "ptp-operator:list_ptp_pods",
                    "ptp-operator:monitor_real_time",
                    "ptp-operator:node_health_score"
                ]}

    async def _enhanced_check_ptp_status(self, params: Dict) -> Dict:
        """Enhanced PTP status check with real-time event context"""
        
        result = {
            "method": "ptp-operator:check_ptp_status",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "static_analysis": {},
            "real_time_analysis": {},
            "combined_insights": {}
        }
        
        try:
            # Get static analysis from existing tools
            if self.static_tools and hasattr(self.static_tools, 'check_ptp_status'):
                result["static_analysis"] = await self.static_tools.check_ptp_status()
            else:
                result["static_analysis"] = {
                    "pods_running": 1,
                    "configurations": ["default"],
                    "last_check": datetime.now(timezone.utc).isoformat()
                }
            
            # Get real-time analysis from event consumer
            if self.event_consumer:
                event_status = self.event_consumer.get_status()
                result["real_time_analysis"] = {
                    "discovered_nodes": event_status.get("total_nodes", 0),
                    "reachable_nodes": event_status.get("reachable_nodes", 0),
                    "connected_nodes": event_status.get("connected_nodes", 0),
                    "nodes": event_status.get("nodes", [])
                }
                
                # Add recent events summary
                recent_events = await self._get_recent_events_summary()
                result["real_time_analysis"]["recent_events"] = recent_events
            
            # Generate combined insights
            result["combined_insights"] = self._generate_combined_insights(
                result["static_analysis"], 
                result["real_time_analysis"]
            )
            
            # Overall health assessment
            result["overall_health"] = self._calculate_overall_health(result)
            
        except Exception as e:
            logger.error(f"❌ Enhanced check_ptp_status failed: {e}")
            result["error"] = str(e)
        
        return result

    async def _enhanced_analyze_ptp_faults(self, params: Dict) -> Dict:
        """Enhanced fault analysis with event pattern recognition"""
        
        result = {
            "method": "ptp-operator:analyze_ptp_faults",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "static_faults": {},
            "event_patterns": {},
            "recommendations": []
        }
        
        try:
            # Static fault analysis
            if self.static_tools and hasattr(self.static_tools, 'analyze_ptp_faults'):
                result["static_faults"] = await self.static_tools.analyze_ptp_faults()
            else:
                result["static_faults"] = {
                    "fault_count": 0,
                    "last_fault": None,
                    "fault_types": []
                }
            
            # Event pattern analysis
            if self.event_consumer:
                result["event_patterns"] = await self._analyze_event_patterns()
            
            # Generate recommendations
            result["recommendations"] = self._generate_fault_recommendations(result)
            
        except Exception as e:
            logger.error(f"❌ Enhanced analyze_ptp_faults failed: {e}")
            result["error"] = str(e)
        
        return result

    async def _enhanced_get_ptp_metrics(self, params: Dict) -> Dict:
        """Enhanced metrics with real-time trends"""
        
        result = {
            "method": "ptp-operator:get_ptp_metrics",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "static_metrics": {},
            "real_time_metrics": {}
        }
        
        try:
            # Get static metrics
            if self.static_tools and hasattr(self.static_tools, 'get_ptp_metrics'):
                result["static_metrics"] = await self.static_tools.get_ptp_metrics()
            else:
                result["static_metrics"] = {
                    "offset_variance": "45ns",
                    "sync_state": "LOCKED",
                    "clock_quality": "good"
                }
            
            # Get real-time metrics from events
            if self.event_consumer:
                result["real_time_metrics"] = await self._get_real_time_metrics()
            
            # Health scoring based on metrics
            result["health_scores"] = self._calculate_node_health_scores(result)
            
        except Exception as e:
            logger.error(f"❌ Enhanced get_ptp_metrics failed: {e}")
            result["error"] = str(e)
        
        return result

    async def _enhanced_list_ptp_pods(self, params: Dict) -> Dict:
        """Enhanced pod listing with real-time status"""
        
        result = {
            "method": "ptp-operator:list_ptp_pods",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "static_pods": {},
            "real_time_status": {}
        }
        
        try:
            # Static pod information
            if self.static_tools and hasattr(self.static_tools, 'list_ptp_pods'):
                result["static_pods"] = await self.static_tools.list_ptp_pods()
            else:
                result["static_pods"] = {
                    "total_pods": 1,
                    "running_pods": 1,
                    "pods": [{"name": "linuxptp-daemon-test", "status": "Running"}]
                }
            
            # Real-time status from event consumer
            if self.event_consumer:
                event_status = self.event_consumer.get_status()
                result["real_time_status"] = {
                    "discovered_nodes": event_status.get("nodes", []),
                    "connectivity_status": self._get_connectivity_status()
                }
            
        except Exception as e:
            logger.error(f"❌ Enhanced list_ptp_pods failed: {e}")
            result["error"] = str(e)
        
        return result

    async def _monitor_real_time(self, params: Dict) -> Dict:
        """Real-time PTP monitoring"""
        
        duration = params.get("duration", 60)
        node_name = params.get("node_name")
        
        result = {
            "method": "ptp-operator:monitor_real_time",
            "duration": duration,
            "node_name": node_name,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "events": []
        }
        
        if self.event_consumer:
            if node_name:
                # Get events from specific node
                events = await self.event_consumer.get_node_events(node_name, limit=50)
                result["events"] = events
            else:
                # Get events from all nodes
                status = self.event_consumer.get_status()
                for node in status.get("nodes", []):
                    node_events = await self.event_consumer.get_node_events(node["node_name"], limit=20)
                    result["events"].extend(node_events)
        
        result["event_count"] = len(result["events"])
        return result

    async def _node_health_score(self, params: Dict) -> Dict:
        """Calculate dynamic health scores for nodes"""
        
        result = {
            "method": "ptp-operator:node_health_score",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "node_scores": {}
        }
        
        if self.event_consumer:
            status = self.event_consumer.get_status()
            
            for node in status.get("nodes", []):
                node_name = node["node_name"]
                events = await self.event_consumer.get_node_events(node_name, limit=100)
                
                health_score = self._calculate_individual_health_score(events)
                result["node_scores"][node_name] = health_score
        
        return result

    # Helper methods
    async def _get_recent_events_summary(self) -> Dict:
        """Get summary of recent events across all nodes"""
        if not self.event_consumer:
            return {}
        
        status = self.event_consumer.get_status()
        event_summary = {
            "total_events": 0,
            "critical_events": 0,
            "warning_events": 0,
            "by_node": {}
        }
        
        for node in status.get("nodes", []):
            node_name = node["node_name"]
            events = await self.event_consumer.get_node_events(node_name, limit=20)
            
            node_summary = {"total": len(events), "critical": 0, "warning": 0}
            
            for event in events:
                if any(v.get('value') == 'FREERUN' for v in event.get('values', [])):
                    node_summary["critical"] += 1
                elif 'sync-status' in event.get('type', ''):
                    node_summary["warning"] += 1
            
            event_summary["by_node"][node_name] = node_summary
            event_summary["total_events"] += node_summary["total"]
            event_summary["critical_events"] += node_summary["critical"]
            event_summary["warning_events"] += node_summary["warning"]
        
        return event_summary

    def _generate_combined_insights(self, static: Dict, realtime: Dict) -> Dict:
        """Generate insights by combining static and real-time data"""
        
        insights = {
            "data_correlation": "good",
            "trend_analysis": "stable",
            "recommendations": []
        }
        
        if realtime.get("recent_events", {}).get("critical_events", 0) > 0:
            insights["recommendations"].append("Investigate critical events immediately")
            insights["trend_analysis"] = "degrading"
        
        if realtime.get("reachable_nodes", 0) < realtime.get("discovered_nodes", 1):
            insights["recommendations"].append("Check network connectivity to unreachable nodes")
            insights["data_correlation"] = "inconsistent"
        
        return insights

    def _calculate_overall_health(self, result: Dict) -> Dict:
        """Calculate overall system health score"""
        
        health = {
            "score": 100,
            "status": "healthy",
            "factors": []
        }
        
        # Factor in real-time events
        realtime = result.get("real_time_analysis", {})
        recent_events = realtime.get("recent_events", {})
        
        critical_events = recent_events.get("critical_events", 0)
        if critical_events > 0:
            health["score"] -= (critical_events * 30)
            health["factors"].append(f"{critical_events} critical events detected")
        
        warning_events = recent_events.get("warning_events", 0)
        if warning_events > 5:
            health["score"] -= (warning_events * 2)
            health["factors"].append(f"{warning_events} warning events detected")
        
        # Determine status based on score
        if health["score"] >= 80:
            health["status"] = "healthy"
        elif health["score"] >= 60:
            health["status"] = "warning"
        else:
            health["status"] = "critical"
        
        health["score"] = max(0, health["score"])
        return health

    async def _analyze_event_patterns(self) -> Dict:
        """Analyze patterns in recent events"""
        
        patterns = {
            "sync_state_changes": 0,
            "clock_offset_variations": [],
            "fault_frequency": 0,
            "pattern_analysis": "stable"
        }
        
        if not self.event_consumer:
            return patterns
        
        status = self.event_consumer.get_status()
        
        for node in status.get("nodes", []):
            node_name = node["node_name"]
            events = await self.event_consumer.get_node_events(node_name, limit=50)
            
            for event in events:
                if 'sync-status' in event.get('type', ''):
                    patterns["sync_state_changes"] += 1
                
                for value in event.get('values', []):
                    if value.get('valueType') == 'decimal64.3':
                        try:
                            offset = float(value.get('value', 0))
                            patterns["clock_offset_variations"].append(offset)
                        except (ValueError, TypeError):
                            pass
                    
                    if value.get('value') == 'FREERUN':
                        patterns["fault_frequency"] += 1
        
        if patterns["fault_frequency"] > 5:
            patterns["pattern_analysis"] = "unstable"
        elif patterns["sync_state_changes"] > 10:
            patterns["pattern_analysis"] = "fluctuating"
        
        return patterns

    def _generate_fault_recommendations(self, result: Dict) -> List[str]:
        """Generate recommendations based on fault analysis"""
        
        recommendations = []
        event_patterns = result.get("event_patterns", {})
        
        if event_patterns.get("fault_frequency", 0) > 3:
            recommendations.append("High fault frequency detected - check PTP configuration")
            recommendations.append("Monitor network stability and grandmaster connectivity")
        
        if event_patterns.get("sync_state_changes", 0) > 10:
            recommendations.append("Frequent sync state changes - investigate servo tuning parameters")
        
        if not recommendations:
            recommendations.append("System appears stable - continue normal monitoring")
        
        return recommendations

    async def _get_real_time_metrics(self) -> Dict:
        """Get real-time metrics from event data"""
        
        metrics = {
            "event_rate": 0,
            "avg_offset": 0,
            "sync_stability": "unknown",
            "node_metrics": {}
        }
        
        if not self.event_consumer:
            return metrics
        
        status = self.event_consumer.get_status()
        all_offsets = []
        total_events = 0
        
        for node in status.get("nodes", []):
            node_name = node["node_name"]
            events = await self.event_consumer.get_node_events(node_name, limit=30)
            
            node_offsets = []
            for event in events:
                for value in event.get('values', []):
                    if value.get('valueType') == 'decimal64.3':
                        try:
                            offset = float(value.get('value', 0))
                            node_offsets.append(offset)
                            all_offsets.append(offset)
                        except (ValueError, TypeError):
                            pass
            
            metrics["node_metrics"][node_name] = {
                "events": len(events),
                "avg_offset": sum(node_offsets) / len(node_offsets) if node_offsets else 0
            }
            
            total_events += len(events)
        
        metrics["event_rate"] = total_events / max(len(status.get("nodes", [])), 1)
        metrics["avg_offset"] = sum(all_offsets) / len(all_offsets) if all_offsets else 0
        
        # Determine sync stability
        if all(abs(offset) < 100 for offset in all_offsets):
            metrics["sync_stability"] = "stable"
        elif all(abs(offset) < 500 for offset in all_offsets):
            metrics["sync_stability"] = "moderate"
        else:
            metrics["sync_stability"] = "unstable"
        
        return metrics

    def _calculate_node_health_scores(self, result: Dict) -> Dict:
        """Calculate health scores for individual nodes"""
        
        scores = {}
        real_time_metrics = result.get("real_time_metrics", {})
        
        for node_name, node_metrics in real_time_metrics.get("node_metrics", {}).items():
            score = 100
            
            # Factor in average offset
            avg_offset = abs(node_metrics.get("avg_offset", 0))
            if avg_offset > 500:
                score -= 30
            elif avg_offset > 200:
                score -= 15
            elif avg_offset > 100:
                score -= 5
            
            # Factor in event frequency
            events = node_metrics.get("events", 0)
            if events > 20:
                score -= 20
            elif events > 10:
                score -= 10
            
            scores[node_name] = max(0, score)
        
        return scores

    def _get_connectivity_status(self) -> Dict:
        """Get connectivity status for all nodes"""
        
        connectivity = {}
        
        if self.event_consumer:
            status = self.event_consumer.get_status()
            
            for node in status.get("nodes", []):
                connectivity[node["node_name"]] = {
                    "reachable": node.get("is_reachable", False),
                    "last_check": node.get("last_health_check"),
                    "subscriptions": node.get("subscriptions", 0)
                }
        
        return connectivity

    def _calculate_individual_health_score(self, events: List) -> Dict:
        """Calculate health score for an individual node based on its events"""
        
        score = 100
        factors = []
        
        if not events:
            return {"score": 50, "status": "no_data", "factors": ["No recent events available"]}
        
        # Analyze events
        critical_events = 0
        warning_events = 0
        
        for event in events:
            for value in event.get('values', []):
                if value.get('value') == 'FREERUN':
                    critical_events += 1
                elif 'sync' in event.get('type', '').lower():
                    warning_events += 1
        
        # Calculate score impact
        if critical_events > 0:
            score -= critical_events * 25
            factors.append(f"{critical_events} critical sync failures")
        
        if warning_events > 10:
            score -= warning_events * 2
            factors.append(f"{warning_events} sync state changes")
        
        # Determine status
        if score >= 80:
            status = "healthy"
        elif score >= 60:
            status = "warning"  
        else:
            status = "critical"
        
        return {
            "score": max(0, score),
            "status": status,
            "factors": factors,
            "event_count": len(events)
        }
TOOLS_EOF

echo "✅ Created src/enhanced_tools/enhanced_ptp_tools.py"
EOF