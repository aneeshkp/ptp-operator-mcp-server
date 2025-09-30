#!/usr/bin/env python3
"""
PTP ML Bridge - Connects PTP agent with ML inference service
Handles event forwarding and prediction integration without modifying the main agent
"""

import asyncio
import json
import logging
import os
import time
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Any
from dataclasses import asdict

import aiohttp
from aiohttp import web

logger = logging.getLogger(__name__)

class PTPMLBridge:
    """Bridge service between PTP agent and ML inference service"""

    def __init__(self,
                 agent_url: str = 'http://ptp-agent.ptp-agent.svc.cluster.local:8081',
                 inference_url: str = 'http://ptp-inference-service.ptp-ml.svc.cluster.local:8082'):
        self.agent_url = agent_url
        self.inference_url = inference_url

        # Event buffer for ML processing
        self.event_buffer = []
        self.max_buffer_size = 1000

        # Prediction cache
        self.predictions_cache = {}
        self.cache_ttl = 60  # seconds

        # Performance metrics
        self.events_processed = 0
        self.predictions_made = 0
        self.alerts_generated = 0

    async def start_bridge_service(self, port: int = 8083):
        """Start the bridge service"""
        app = await self.create_bridge_api()
        runner = web.AppRunner(app)
        await runner.setup()

        site = web.TCPSite(runner, '0.0.0.0', port)
        await site.start()

        logger.info(f"PTP ML Bridge started on port {port}")

        # Start background tasks
        asyncio.create_task(self.poll_agent_events())
        asyncio.create_task(self.process_ml_predictions())

        return runner

    async def create_bridge_api(self) -> web.Application:
        """Create HTTP API for bridge service"""

        async def health_check(request):
            return web.json_response({
                'status': 'healthy',
                'service': 'ptp-ml-bridge',
                'agent_url': self.agent_url,
                'inference_url': self.inference_url
            })

        async def get_predictions(request):
            """Get latest ML predictions"""
            try:
                # Clean expired cache
                self._clean_cache()

                return web.json_response({
                    'predictions': self.predictions_cache,
                    'total_predictions': len(self.predictions_cache),
                    'timestamp': datetime.now().isoformat()
                })
            except Exception as e:
                return web.json_response({'error': str(e)}, status=500)

        async def get_bridge_stats(request):
            """Get bridge service statistics"""
            stats = {
                'events_processed': self.events_processed,
                'predictions_made': self.predictions_made,
                'alerts_generated': self.alerts_generated,
                'cached_predictions': len(self.predictions_cache),
                'buffer_size': len(self.event_buffer),
                'uptime': datetime.now().isoformat()
            }
            return web.json_response(stats)

        async def trigger_prediction(request):
            """Manually trigger prediction for a node"""
            try:
                data = await request.json()
                node_name = data.get('node_name')

                if not node_name:
                    return web.json_response({'error': 'node_name required'}, status=400)

                prediction = await self.get_prediction_for_node(node_name)
                return web.json_response(prediction)

            except Exception as e:
                return web.json_response({'error': str(e)}, status=400)

        app = web.Application()
        app.router.add_get('/health', health_check)
        app.router.add_get('/predictions', get_predictions)
        app.router.add_get('/stats', get_bridge_stats)
        app.router.add_post('/predict', trigger_prediction)

        return app

    async def poll_agent_events(self):
        """Continuously poll PTP agent for new events"""
        logger.info("Starting agent event polling")

        while True:
            try:
                # Get recent alerts from agent
                async with aiohttp.ClientSession() as session:
                    async with session.get(f"{self.agent_url}/alerts?hours=1") as response:
                        if response.status == 200:
                            alerts = await response.json()
                            await self.process_agent_alerts(alerts)

                    # Get event summary
                    async with session.get(f"{self.agent_url}/summary") as response:
                        if response.status == 200:
                            summary = await response.json()
                            await self.process_agent_summary(summary)

            except Exception as e:
                logger.warning(f"Error polling agent: {e}")

            # Wait before next poll
            await asyncio.sleep(30)  # Poll every 30 seconds

    async def process_agent_alerts(self, alerts: List[Dict]):
        """Process alerts from PTP agent and forward to ML service"""
        for alert in alerts:
            # Convert alert to event format for ML
            event = self.alert_to_event(alert)
            if event:
                self.event_buffer.append(event)
                self.events_processed += 1

                # Trim buffer if needed
                if len(self.event_buffer) > self.max_buffer_size:
                    self.event_buffer = self.event_buffer[-self.max_buffer_size:]

    async def process_agent_summary(self, summary: Dict):
        """Process event summary from agent"""
        # Extract node states and create events
        for node_name, node_data in summary.items():
            if isinstance(node_data, dict):
                latest_state = node_data.get('latest_state', '')
                if latest_state and latest_state != 'unknown':
                    event = {
                        'node_name': node_name,
                        'value': latest_state,
                        'data_type': 'notification',
                        'resource_address': f'/cluster/node/{node_name}/sync/sync-status/sync-state',
                        'timestamp': time.time()
                    }
                    self.event_buffer.append(event)

    def alert_to_event(self, alert: Dict) -> Optional[Dict]:
        """Convert PTP agent alert to ML event format"""
        try:
            # Extract node name
            affected_nodes = alert.get('affected_nodes', [])
            if not affected_nodes:
                return None

            node_name = affected_nodes[0]

            # Extract state from summary
            summary = alert.get('summary', '')
            value = 'UNKNOWN'

            if '→' in summary:
                parts = summary.split('→')
                if len(parts) > 1:
                    value = parts[1].strip()
            elif 'Clock class' in summary:
                # Extract clock class value
                import re
                match = re.search(r'class (\d+)', summary)
                if match:
                    value = match.group(1)

            # Determine resource address based on alert type
            resource_address = '/cluster/node/{}/sync/sync-status/sync-state'.format(node_name)
            if 'Clock class' in summary:
                resource_address = '/cluster/node/{}/sync/ptp-status/clock-class'.format(node_name)
            elif 'OS Clock' in summary:
                resource_address = '/cluster/node/{}/sync/sync-status/os-clock-sync-state'.format(node_name)
            elif 'GNSS' in summary or 'GPS' in summary:
                resource_address = '/cluster/node/{}/sync/gnss-status/gnss-sync-status'.format(node_name)

            return {
                'node_name': node_name,
                'value': value,
                'data_type': 'notification' if alert.get('severity') in ['CRITICAL', 'WARNING'] else 'metric',
                'resource_address': resource_address,
                'timestamp': time.time(),
                'original_alert': alert
            }

        except Exception as e:
            logger.warning(f"Error converting alert to event: {e}")
            return None

    async def process_ml_predictions(self):
        """Process ML predictions periodically"""
        logger.info("Starting ML prediction processing")

        while True:
            try:
                if self.event_buffer:
                    # Group events by node
                    node_events = {}
                    for event in self.event_buffer[-100:]:  # Use recent events
                        node_name = event.get('node_name', 'unknown')
                        if node_name not in node_events:
                            node_events[node_name] = []
                        node_events[node_name].append(event)

                    # Get predictions for each node
                    for node_name, events in node_events.items():
                        if len(events) >= 5:  # Minimum events for prediction
                            await self.get_prediction_for_node(node_name, events)

            except Exception as e:
                logger.warning(f"Error in ML prediction processing: {e}")

            # Wait before next prediction cycle
            await asyncio.sleep(60)  # Predict every minute

    async def get_prediction_for_node(self, node_name: str, events: List[Dict] = None) -> Dict:
        """Get ML prediction for a specific node"""
        try:
            # Use cached prediction if recent
            cache_key = f"prediction_{node_name}"
            if cache_key in self.predictions_cache:
                cached = self.predictions_cache[cache_key]
                if time.time() - cached.get('timestamp', 0) < self.cache_ttl:
                    return cached

            # Send latest event to inference service
            if events:
                latest_event = events[-1]
            else:
                # Create dummy event for prediction
                latest_event = {
                    'node_name': node_name,
                    'value': 'LOCKED',
                    'data_type': 'notification',
                    'resource_address': f'/cluster/node/{node_name}/sync/sync-status/sync-state',
                    'timestamp': time.time()
                }

            async with aiohttp.ClientSession() as session:
                async with session.post(f"{self.inference_url}/events",
                                      json=latest_event) as response:
                    if response.status == 200:
                        prediction = await response.json()

                        # Cache prediction
                        prediction['timestamp'] = time.time()
                        self.predictions_cache[cache_key] = prediction
                        self.predictions_made += 1

                        # Check for proactive alerts
                        await self.check_proactive_alerts(prediction)

                        return prediction
                    else:
                        error_text = await response.text()
                        logger.warning(f"ML inference failed: {response.status} - {error_text}")

        except Exception as e:
            logger.error(f"Error getting prediction for {node_name}: {e}")

        return {'error': f'Prediction failed for {node_name}'}

    async def check_proactive_alerts(self, prediction: Dict):
        """Check prediction for proactive alerting opportunities"""
        try:
            predictions = prediction.get('predictions', [])
            node_name = prediction.get('node_name', 'unknown')

            for i, pred in enumerate(predictions):
                predicted_state = pred.get('predicted_state', '')
                confidence = pred.get('confidence', 0)
                time_step = pred.get('time_step', i + 1)

                # Generate proactive alerts for problematic states
                if predicted_state in ['FREERUN', 'FAULTY'] and confidence > 0.7:
                    alert_message = (
                        f"🔮 PROACTIVE ALERT: Node {node_name} predicted to enter "
                        f"{predicted_state} state in ~{time_step * 30} seconds "
                        f"(confidence: {confidence:.2f})"
                    )

                    logger.warning(alert_message)
                    self.alerts_generated += 1

                    # Could integrate with external alerting here
                    await self.send_proactive_alert(node_name, predicted_state, confidence, time_step)

        except Exception as e:
            logger.warning(f"Error checking proactive alerts: {e}")

    async def send_proactive_alert(self, node_name: str, predicted_state: str, confidence: float, time_step: int):
        """Send proactive alert to external systems"""
        # This could integrate with Slack, email, or other alerting systems
        alert_data = {
            'type': 'proactive_prediction',
            'node_name': node_name,
            'predicted_state': predicted_state,
            'confidence': confidence,
            'predicted_time_seconds': time_step * 30,
            'timestamp': datetime.now().isoformat(),
            'message': f"Predicted {predicted_state} state for {node_name} in {time_step * 30} seconds"
        }

        # Log for now (could be enhanced to send to webhooks, etc.)
        logger.info(f"PROACTIVE ALERT: {json.dumps(alert_data, indent=2)}")

    def _clean_cache(self):
        """Clean expired cache entries"""
        current_time = time.time()
        expired_keys = [
            key for key, value in self.predictions_cache.items()
            if current_time - value.get('timestamp', 0) > self.cache_ttl
        ]
        for key in expired_keys:
            del self.predictions_cache[key]

async def main():
    """Main entry point for ML bridge service"""
    # Configuration
    agent_url = os.getenv('PTP_AGENT_URL', 'http://ptp-agent.ptp-agent.svc.cluster.local:8081')
    inference_url = os.getenv('PTP_INFERENCE_URL', 'http://ptp-inference-service.ptp-ml.svc.cluster.local:8082')
    port = int(os.getenv('BRIDGE_PORT', '8083'))

    # Initialize bridge
    bridge = PTPMLBridge(agent_url, inference_url)

    # Start service
    runner = await bridge.start_bridge_service(port)

    # Keep running
    try:
        while True:
            await asyncio.sleep(60)
            # Periodic cleanup
            bridge._clean_cache()
    except KeyboardInterrupt:
        logger.info("Shutting down ML bridge service")
    finally:
        await runner.cleanup()

if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())