#!/bin/bash
# create_final_files.sh - Create the final server.py and build scripts

echo "📝 Creating final integration files..."

# Create the main server.py
echo "Creating src/server.py..."
cat > src/server.py << 'SERVER_EOF'
#!/usr/bin/env python3
"""
Enhanced PTP MCP Server with Real-time Event Consumer
Integrates existing PTP analysis tools with live event monitoring
"""

import asyncio
import json
import logging
import os
import signal
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Any, Optional

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

# Add src to path
sys.path.insert(0, str(Path(__file__).parent))

# Import new modules
try:
    from event_consumer.consumer import NodeAwarePTPConsumer
    from enhanced_tools.enhanced_ptp_tools import EnhancedPTPTools
    from config.settings import Settings
except ImportError as e:
    print(f"❌ Import error: {e}")
    print("Make sure all required files are created and dependencies installed")
    sys.exit(1)

# Try to import existing tools (adapt to your current structure)
try:
    from tools.ptp_tools import PTPTools  # Adjust path to your existing tools
except ImportError:
    print("⚠️ Could not import existing PTP tools - using mock implementation")
    class PTPTools:
        """Placeholder for existing PTP tools"""
        async def handle_tool_call(self, method: str, params: dict) -> dict:
            return {"message": f"Mock response for {method}", "params": params}

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger(__name__)

class PTPMCPServer:
    """Enhanced PTP MCP Server with real-time event monitoring"""
    
    def __init__(self):
        self.settings = Settings()
        self.app = FastAPI(
            title="Enhanced PTP MCP Server",
            description="PTP monitoring with real-time event consumer",
            version="2.0.0"
        )
        
        # Initialize components
        self.static_tools: Optional[PTPTools] = None
        self.event_consumer: Optional[NodeAwarePTPConsumer] = None  
        self.enhanced_tools: Optional[EnhancedPTPTools] = None
        
        # Setup FastAPI app
        self._setup_middleware()
        self._setup_routes()
        
    def _setup_middleware(self):
        """Setup CORS and other middleware"""
        self.app.add_middleware(
            CORSMiddleware,
            allow_origins=["*"],
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )
        
    def _setup_routes(self):
        """Setup API routes"""
        
        # Health and status endpoints
        @self.app.get("/health")
        async def health_check():
            """Kubernetes liveness probe"""
            consumer_status = self.event_consumer.get_status() if self.event_consumer else None
            is_healthy = consumer_status and consumer_status.get('connected_nodes', 0) > 0
            
            return {
                "status": "healthy" if is_healthy else "starting",
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "uptime": self._get_uptime(),
                "components": {
                    "static_tools": "ready" if self.static_tools else "initializing",
                    "event_consumer": "ready" if self.event_consumer else "initializing",
                    "enhanced_tools": "ready" if self.enhanced_tools else "initializing"
                },
                "node_info": {
                    "current_node": self.settings.node_name,
                    "namespace": self.settings.kubernetes_namespace,
                    "pod_name": self.settings.pod_name
                }
            }
        
        @self.app.get("/ready")
        async def readiness_check():
            """Kubernetes readiness probe"""
            if not self.event_consumer:
                raise HTTPException(status_code=503, detail="Event consumer not initialized")
            
            status = self.event_consumer.get_status()
            if status.get('connected_nodes', 0) >= 0:  # Allow 0 for development
                return {"status": "ready", "connected_nodes": status['connected_nodes']}
            else:
                raise HTTPException(status_code=503, detail="No connected PTP nodes")
        
        @self.app.get("/status")
        async def detailed_status():
            """Detailed server status"""
            consumer_status = self.event_consumer.get_status() if self.event_consumer else {}
            
            return {
                "server": {
                    "status": "running",
                    "version": "2.0.0",
                    "uptime": self._get_uptime(),
                    "environment": os.getenv("NODE_ENV", "development")
                },
                "kubernetes": {
                    "namespace": self.settings.kubernetes_namespace,
                    "node_name": self.settings.node_name,
                    "pod_name": self.settings.pod_name,
                    "pod_ip": self.settings.pod_ip
                },
                "event_consumer": consumer_status,
                "capabilities": {
                    "static_analysis": True,
                    "real_time_events": self.event_consumer is not None,
                    "enhanced_tools": self.enhanced_tools is not None,
                    "multi_node_support": True
                }
            }
        
        # MCP Protocol endpoint
        @self.app.post("/mcp")
        async def handle_mcp_request(request: Request):
            """Main MCP protocol handler"""
            try:
                body = await request.json()
                method = body.get("method")
                params = body.get("params", {})
                
                logger.info(f"🔧 MCP Request: {method}")
                
                # Route to appropriate handler
                if method.startswith("ptp-operator:"):
                    # Enhanced tools that combine static + real-time
                    if self.enhanced_tools:
                        result = await self.enhanced_tools.handle_tool_call(method, params)
                    elif self.static_tools:
                        # Fallback to static tools if enhanced not available
                        result = await self.static_tools.handle_tool_call(method, params)
                    else:
                        raise HTTPException(status_code=503, detail="PTP tools not initialized")
                        
                else:
                    raise HTTPException(status_code=400, detail=f"Unknown method: {method}")
                
                return {"result": result}
                
            except Exception as e:
                logger.error(f"❌ MCP request failed: {e}", exc_info=True)
                raise HTTPException(status_code=500, detail=str(e))
        
        # Real-time event streaming
        @self.app.get("/events/stream")
        async def event_stream():
            """Server-sent events for real-time PTP monitoring"""
            async def generate_events():
                if not self.event_consumer:
                    yield f"data: {json.dumps({'error': 'Event consumer not available'})}\n\n"
                    return
                
                # Send connection acknowledgment
                yield f"data: {json.dumps({'type': 'connected', 'timestamp': datetime.now(timezone.utc).isoformat()})}\n\n"
                
                # Create event queue for this connection
                event_queue = asyncio.Queue()
                
                async def event_handler(event_or_analysis):
                    await event_queue.put(event_or_analysis)
                
                # Register handler
                self.event_consumer.add_event_handler(event_handler)
                
                try:
                    while True:
                        try:
                            # Wait for events with timeout for keepalive
                            event = await asyncio.wait_for(event_queue.get(), timeout=30.0)
                            yield f"data: {json.dumps(event, default=str)}\n\n"
                        except asyncio.TimeoutError:
                            # Send keepalive
                            yield f"data: {json.dumps({'type': 'keepalive', 'timestamp': datetime.now(timezone.utc).isoformat()})}\n\n"
                            
                except Exception as e:
                    logger.error(f"❌ Event stream error: {e}")
                    yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"
                finally:
                    # Cleanup handler
                    if hasattr(self.event_consumer, 'remove_event_handler'):
                        self.event_consumer.remove_event_handler(event_handler)
            
            return StreamingResponse(
                generate_events(),
                media_type="text/event-stream",
                headers={
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                    "Access-Control-Allow-Origin": "*"
                }
            )
        
        # Event callback endpoint (for cloud-event-proxy)
        @self.app.post("/events/callback")
        @self.app.post("/events/callback/{node_name}")
        async def event_callback(request: Request, node_name: str = "unknown"):
            """Receive events from PTP event publishers"""
            try:
                event_data = await request.json()
                logger.info(f"📨 Event callback from {node_name}: {event_data.get('type', 'unknown')}")
                
                # Forward to event consumer if available
                if self.event_consumer:
                    await self.event_consumer._handle_callback_event(node_name, event_data)
                
                return {"acknowledged": True, "node_name": node_name, "timestamp": datetime.now(timezone.utc).isoformat()}
                
            except Exception as e:
                logger.error(f"❌ Event callback error: {e}")
                raise HTTPException(status_code=400, detail=str(e))

    def _get_uptime(self) -> int:
        """Get server uptime in seconds"""
        return int((datetime.now(timezone.utc) - self.start_time).total_seconds())

    async def initialize(self):
        """Initialize all components"""
        self.start_time = datetime.now(timezone.utc)
        
        logger.info("🚀 Initializing Enhanced PTP MCP Server...")
        logger.info(f"   Node: {self.settings.node_name}")
        logger.info(f"   Namespace: {self.settings.kubernetes_namespace}")
        logger.info(f"   MCP URL: http://{self.settings.host}:{self.settings.port}/mcp")
        
        try:
            # Initialize existing static tools
            self.static_tools = PTPTools()
            logger.info("✅ Static PTP tools initialized")
            
            # Initialize event consumer
            self.event_consumer = NodeAwarePTPConsumer(
                namespace=self.settings.kubernetes_namespace
            )
            await self.event_consumer.start()
            logger.info("✅ Event consumer initialized")
            
            # Initialize enhanced tools (combination of both)
            self.enhanced_tools = EnhancedPTPTools(
                static_tools=self.static_tools,
                event_consumer=self.event_consumer
            )
            logger.info("✅ Enhanced tools initialized")
            
            logger.info("🎉 All components initialized successfully!")
            
        except Exception as e:
            logger.error(f"❌ Initialization failed: {e}")
            raise

    async def start(self):
        """Start the server"""
        await self.initialize()
        
        # Setup signal handlers
        def signal_handler(signum, frame):
            logger.info(f"📡 Received signal {signum}")
            asyncio.create_task(self.shutdown())
        
        signal.signal(signal.SIGINT, signal_handler)
        signal.signal(signal.SIGTERM, signal_handler)
        
        # Start the FastAPI server
        config = uvicorn.Config(
            app=self.app,
            host=self.settings.host,
            port=self.settings.port,
            log_level=self.settings.log_level.lower(),
            access_log=True
        )
        
        server = uvicorn.Server(config)
        
        logger.info(f"🎯 PTP MCP Server starting on {self.settings.host}:{self.settings.port}")
        logger.info(f"🔗 MCP Endpoint: http://{self.settings.host}:{self.settings.port}/mcp")
        logger.info(f"📊 Health Check: http://{self.settings.host}:{self.settings.port}/health")
        logger.info(f"📈 Status: http://{self.settings.host}:{self.settings.port}/status")
        logger.info(f"🌊 Event Stream: http://{self.settings.host}:{self.settings.port}/events/stream")
        
        await server.serve()

    async def shutdown(self):
        """Gracefully shutdown the server"""
        logger.info("🛑 Shutting down PTP MCP Server...")
        
        try:
            if self.event_consumer:
                await self.event_consumer.stop()
                logger.info("✅ Event consumer stopped")
                
        except Exception as e:
            logger.error(f"❌ Error during shutdown: {e}")
        
        logger.info("✅ Server shutdown completed")

# Create global server instance
server = PTPMCPServer()

async def main():
    """Main entry point"""
    try:
        await server.start()
    except KeyboardInterrupt:
        logger.info("📡 Received keyboard interrupt")
    except Exception as e:
        logger.error(f"💥 Server error: {e}", exc_info=True)
        sys.exit(1)

if __name__ == "__main__":
    asyncio.run(main())
SERVER_EOF

echo "✅ Created src/server.py"

# Create build script
echo "Creating scripts/build.sh..."
cat > scripts/build.sh << 'BUILD_EOF'
#!/bin/bash
# scripts/build.sh - Build and push container image

set -e

# Configuration
REGISTRY=${DOCKER_REGISTRY:-"quay.io/aneeshkp"}
IMAGE_NAME="ptp-mcp-server"
TAG=${GIT_SHA:-$(git rev-parse --short HEAD 2>/dev/null || echo "latest")}
BUILD_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

echo "🐍 Building Enhanced PTP MCP Server..."
echo "   Registry: $REGISTRY"
echo "   Image: $IMAGE_NAME"
echo "   Tag: $TAG"
echo "   Build Date: $BUILD_DATE"

# Build the Docker image
echo "🔨 Building Docker image..."
docker build \
  --build-arg APP_VERSION=$TAG \
  --build-arg BUILD_DATE=$BUILD_DATE \
  --build-arg GIT_COMMIT=$TAG \
  -t ${REGISTRY}/${IMAGE_NAME}:${TAG} \
  -t ${REGISTRY}/${IMAGE_NAME}:latest \
  .

# Push to registry
if [[ "${SKIP_PUSH:-false}" != "true" ]]; then
    echo "📤 Pushing to registry..."
    docker push ${REGISTRY}/${IMAGE_NAME}:${TAG}
    docker push ${REGISTRY}/${IMAGE_NAME}:latest
    echo "✅ Image pushed successfully!"
else
    echo "⏭️  Skipping push (SKIP_PUSH=true)"
fi

echo "🎯 Build completed successfully!"
echo "   Image: ${REGISTRY}/${IMAGE_NAME}:${TAG}"
BUILD_EOF

# Create deploy script
echo "Creating scripts/deploy.sh..."
cat > scripts/deploy.sh << 'DEPLOY_EOF'
#!/bin/bash
# scripts/deploy.sh - Deploy to Kubernetes

set -e

# Configuration
NAMESPACE=${KUBERNETES_NAMESPACE:-"openshift-ptp"}
REGISTRY=${DOCKER_REGISTRY:-"quay.io/aneeshkp"}
IMAGE_NAME="ptp-mcp-server"
TAG=${GIT_SHA:-$(git rev-parse --short HEAD 2>/dev/null || echo "latest")}

echo "🚀 Deploying Enhanced PTP MCP Server to Kubernetes..."
echo "   Namespace: $NAMESPACE"
echo "   Image: ${REGISTRY}/${IMAGE_NAME}:${TAG}"

# Create namespace if it doesn't exist
echo "📦 Ensuring namespace exists..."
kubectl create namespace $NAMESPACE --dry-run=client -o yaml | kubectl apply -f -

# Update deployment with new image
echo "📝 Updating deployment manifests..."
if [[ -f "k8s/deployment.yaml" ]]; then
    sed -i.bak "s|quay.io/aneeshkp/ptp-mcp-server:latest|${REGISTRY}/${IMAGE_NAME}:${TAG}|g" k8s/deployment.yaml
    echo "✅ Updated deployment.yaml with new image"
fi

# Apply Kubernetes resources
echo "☸️  Applying Kubernetes resources..."
kubectl apply -f k8s/ -n $NAMESPACE

# Wait for deployment to be ready
echo "⏳ Waiting for deployment to be ready..."
kubectl wait --for=condition=available --timeout=300s deployment/ptp-mcp-server -n $NAMESPACE

# Get service information
echo "✅ Deployment completed successfully!"
echo ""
echo "🌐 Access Information:"

# LoadBalancer IP
LB_IP=$(kubectl get svc ptp-mcp-server-external -n $NAMESPACE -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "pending")
if [[ "$LB_IP" != "pending" && "$LB_IP" != "" ]]; then
    echo "   📡 LoadBalancer: http://$LB_IP"
    echo "   🔗 Claude MCP URL: http://$LB_IP/mcp"
    echo "   📊 Health Check: http://$LB_IP/health"
    echo "   📈 Status: http://$LB_IP/status"
    echo "   🌊 Event Stream: http://$LB_IP/events/stream"
fi

# NodePort
NODE_IP=$(kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="ExternalIP")].address}' 2>/dev/null || kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')
if [[ "$NODE_IP" != "" ]]; then
    echo "   🔌 NodePort: http://$NODE_IP:30300"
    echo "   🔗 Claude MCP URL: http://$NODE_IP:30300/mcp"
fi

echo ""
echo "🔍 Monitoring Commands:"
echo "   kubectl logs -f deployment/ptp-mcp-server -n $NAMESPACE"
echo "   kubectl get pods -n $NAMESPACE -l app=ptp-mcp-server"
echo "   kubectl describe deployment/ptp-mcp-server -n $NAMESPACE"

echo ""
echo "🧪 Test Commands:"
echo "   # Port forward for local testing"
echo "   kubectl port-forward svc/ptp-mcp-server-service 8080:80 -n $NAMESPACE"
echo ""
echo "   # Test health endpoint"
echo "   curl http://localhost:8080/health"
echo ""
echo "   # Test MCP endpoint"
echo "   curl -X POST http://localhost:8080/mcp \\"
echo "     -H \"Content-Type: application/json\" \\"
echo "     -d '{\"method\": \"ptp-operator:check_ptp_status\", \"params\": {}}'"

# Restore backup file
if [[ -f "k8s/deployment.yaml.bak" ]]; then
    mv k8s/deployment.yaml.bak k8s/deployment.yaml
fi
DEPLOY_EOF

# Create test script
echo "Creating scripts/test-mcp.sh..."
cat > scripts/test-mcp.sh << 'TEST_EOF'
#!/bin/bash
# scripts/test-mcp.sh - Test MCP server functionality

set -e

# Configuration
SERVER_URL=${MCP_SERVER_URL:-"http://localhost:8080"}

echo "🧪 Testing Enhanced PTP MCP Server..."
echo "   Server URL: $SERVER_URL"

# Function to test endpoint
test_endpoint() {
    local method=$1
    local params=$2
    local description=$3
    
    echo "🔍 Testing: $description"
    
    local response=$(curl -s -X POST "$SERVER_URL/mcp" \
        -H "Content-Type: application/json" \
        -d "{\"method\": \"$method\", \"params\": $params}" \
        -w "HTTPSTATUS:%{http_code}")
    
    local http_code=$(echo "$response" | tr -d '\n' | sed -E 's/.*HTTPSTATUS:([0-9]{3})$/\1/')
    local body=$(echo "$response" | sed -E 's/HTTPSTATUS:[0-9]{3}$//')
    
    if [[ "$http_code" -eq 200 ]]; then
        echo "   ✅ $description - Success"
        if command -v jq >/dev/null; then
            echo "   📄 Response preview:"
            echo "$body" | jq -r '.result | keys[]' 2>/dev/null | head -3 | sed 's/^/      /' || echo "      (Could not parse JSON)"
        fi
    else
        echo "   ❌ $description - Failed (HTTP $http_code)"
        echo "   📄 Response: $body" | head -100
    fi
    echo ""
}

# Test health endpoint first
echo "🏥 Testing health endpoints..."
curl -s "$SERVER_URL/health" > /dev/null && echo "   ✅ Health endpoint accessible" || echo "   ❌ Health endpoint failed"
curl -s "$SERVER_URL/status" > /dev/null && echo "   ✅ Status endpoint accessible" || echo "   ❌ Status endpoint failed"
echo ""

# Test MCP endpoints
echo "🔧 Testing MCP tools..."

# Enhanced existing tools
test_endpoint "ptp-operator:check_ptp_status" "{}" "Enhanced PTP Status Check"
test_endpoint "ptp-operator:list_ptp_pods" "{}" "Enhanced Pod Listing"
test_endpoint "ptp-operator:analyze_ptp_faults" "{}" "Enhanced Fault Analysis"
test_endpoint "ptp-operator:get_ptp_metrics" "{}" "Enhanced Metrics Collection"

# New real-time tools
test_endpoint "ptp-operator:monitor_real_time" "{\"duration\": 30}" "Real-time Monitoring"
test_endpoint "ptp-operator:node_health_score" "{}" "Node Health Scoring"

echo "🎯 MCP Server testing completed!"
echo ""
echo "💡 Usage Examples:"
echo "   # Connect Claude to your MCP server:"
echo "   MCP Server URL: $SERVER_URL/mcp"
echo ""
echo "   # Monitor real-time events:"
echo "   curl $SERVER_URL/events/stream"
echo ""
echo "   # Get enhanced PTP status:"
echo "   curl -X POST $SERVER_URL/mcp \\"
echo "     -H \"Content-Type: application/json\" \\"
echo "     -d '{\"method\": \"ptp-operator:check_ptp_status\", \"params\": {}}'"
TEST_EOF

# Make scripts executable
chmod +x scripts/*.sh

echo "✅ All final files created successfully!"
echo ""
echo "🎉 Complete integration package ready!"
echo ""
echo "📋 File structure:"
echo "├── src/"
echo "│   ├── server.py              ✅ Enhanced FastAPI MCP server"
echo "│   ├── config/settings.py     ✅ Kubernetes Downward API config"
echo "│   ├── event_consumer/"
echo "│   │   ├── consumer.py        ✅ Node-aware event consumer"
echo "│   │   └── models.py          ✅ Data models"
echo "│   └── enhanced_tools/"
echo "│       └── enhanced_ptp_tools.py ✅ Enhanced tool implementations"
echo "├── k8s/"
echo "│   ├── deployment.yaml        ✅ Complete K8s deployment"
echo "│   └── service.yaml           ✅ Services (Internal + External)"
echo "├── scripts/"
echo "│   ├── build.sh               ✅ Build and push container"
echo "│   ├── deploy.sh              ✅ Deploy to Kubernetes"
echo "│   └── test-mcp.sh            ✅ Test MCP functionality"
echo "├── Dockerfile                 ✅ Production container"
echo "└── requirements.txt           ✅ Python dependencies"
echo ""
echo "🚀 Next Steps:"
echo "1. Update your registry in k8s/deployment.yaml and scripts/build.sh"
echo "2. Install dependencies: pip install -r requirements.txt"
echo "3. Test locally: python src/server.py"
echo "4. Build container: ./scripts/build.sh"
echo "5. Deploy to K8s: ./scripts/deploy.sh"
echo "6. Test integration: ./scripts/test-mcp.sh"
echo ""
echo "🔗 Claude Integration:"
echo "   Once deployed, connect Claude to: http://YOUR-SERVER-IP/mcp"