#!/usr/bin/env python3
"""
PTP Inference Service - CPU-only inference service for Kubernetes deployment
Provides real-time PTP event prediction capabilities
"""

import asyncio
import json
import logging
import numpy as np
import os
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional, Any
from collections import deque
import aiohttp
from aiohttp import web
import onnxruntime as ort

logger = logging.getLogger(__name__)

class PTPInferenceService:
    """Real-time PTP event prediction service"""

    def __init__(self, model_path: str, sequence_length: int = 40):
        self.model_path = model_path
        self.sequence_length = sequence_length

        # Initialize ONNX runtime session
        try:
            self.session = ort.InferenceSession(model_path)
            logger.info(f"Loaded ONNX model from {model_path}")
        except Exception as e:
            logger.error(f"Failed to load ONNX model: {e}")
            raise

        # Event encoding mappings (must match training)
        self.state_encoding = {
            'LOCKED': 0, 'FREERUN': 1, 'HOLDOVER': 2, 'FAULTY': 3,
            'ANTENNA-DISCONNECTED': 4, 'ANTENNA-SHORT-CIRCUIT': 5,
            'NO-FIX': 6, 'SURVEY-FAIL': 7, 'TRACKING': 8
        }

        self.profile_to_id = {'OC': 0, 'BC': 1, 'dual_BC': 2, 'T_GM': 3}
        self.id_to_state = {v: k for k, v in self.state_encoding.items()}

        # Node event buffers
        self.node_buffers: Dict[str, deque] = {}
        self.node_profiles: Dict[str, str] = {}

        # Prediction cache
        self.prediction_cache: Dict[str, Dict] = {}
        self.cache_ttl = 30  # seconds

        # Performance metrics
        self.prediction_count = 0
        self.avg_inference_time = 0.0

    def encode_event(self, event: Dict[str, Any]) -> np.ndarray:
        """Encode PTP event into numerical features (must match training)"""
        features = np.zeros(20)

        # Time since event
        features[0] = time.time() - float(event.get('timestamp', time.time()))

        # State encoding
        value = event.get('value', '')
        if value in self.state_encoding:
            features[1] = self.state_encoding[value]
        elif value.isdigit():
            clock_class = int(value)
            clock_class_encoding = {6: 0, 7: 1, 248: 2, 52: 3, 58: 4, 165: 5, 193: 6}
            features[2] = clock_class_encoding.get(clock_class, 7)

        # Resource type encoding
        resource_addr = event.get('resource_address', '')
        resource_type_encoding = {
            'sync-status/sync-state': 0,
            'sync-status/os-clock-sync-state': 1,
            'ptp-status/lock-state': 2,
            'ptp-status/clock-class': 3,
            'ptp-status/ptp-clock-class': 4,
            'gnss-status/gnss-sync-status': 5
        }

        for resource_type, encoding in resource_type_encoding.items():
            if resource_type in resource_addr:
                features[3] = encoding
                break

        # Data type
        features[4] = 1 if event.get('data_type') == 'notification' else 0

        # Event severity
        if value in ['FREERUN', 'FAULTY', 'ANTENNA-DISCONNECTED']:
            features[5] = 2  # critical
        elif value in ['HOLDOVER', 'ANTENNA-SHORT-CIRCUIT']:
            features[5] = 1  # warning
        else:
            features[5] = 0  # info

        # Temporal features
        features[11] = datetime.now().hour
        features[12] = datetime.now().weekday()

        # Node hash
        features[13] = hash(event.get('node_name', '')) % 100

        return features

    def detect_profile_type(self, node_name: str, recent_events: List[Dict]) -> str:
        """Detect PTP profile type from recent events"""
        if node_name in self.node_profiles:
            return self.node_profiles[node_name]

        # Profile detection logic
        resource_types = set()
        for event in recent_events:
            resource_addr = event.get('resource_address', '')
            if '/gnss-status/' in resource_addr:
                resource_types.add('gnss-status')
            if '/ptp-status/' in resource_addr:
                resource_types.add('ptp-status')
            if '/sync-status/' in resource_addr:
                resource_types.add('sync-status')

        # Determine profile
        if 'gnss-status' in resource_types:
            profile_type = 'T_GM'
        elif 'ptp-status' in resource_types:
            profile_type = 'BC'  # Could be dual_BC but hard to detect
        else:
            profile_type = 'OC'

        self.node_profiles[node_name] = profile_type
        logger.info(f"Detected profile {profile_type} for node {node_name}")
        return profile_type

    async def add_event(self, event: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Add new event and potentially trigger prediction"""
        node_name = event.get('node_name', 'unknown')

        # Initialize buffer if needed
        if node_name not in self.node_buffers:
            self.node_buffers[node_name] = deque(maxlen=self.sequence_length)

        # Encode and add event
        encoded_event = {
            'features': self.encode_event(event).tolist(),
            'raw_event': event,
            'timestamp': time.time()
        }

        self.node_buffers[node_name].append(encoded_event)

        # Check if we have enough events for prediction
        if len(self.node_buffers[node_name]) >= self.sequence_length:
            return await self.predict_for_node(node_name)

        return None

    async def predict_for_node(self, node_name: str) -> Dict[str, Any]:
        """Generate prediction for a specific node"""
        if node_name not in self.node_buffers:
            return {'error': f'No data for node {node_name}'}

        buffer = self.node_buffers[node_name]
        if len(buffer) < self.sequence_length:
            return {'error': f'Insufficient data for node {node_name}'}

        # Check cache
        cache_key = f"{node_name}_{buffer[-1]['timestamp']}"
        if cache_key in self.prediction_cache:
            cached = self.prediction_cache[cache_key]
            if time.time() - cached['created_at'] < self.cache_ttl:
                return cached['prediction']

        start_time = time.time()

        try:
            # Prepare input sequence
            sequence = np.array([event['features'] for event in buffer])
            sequence = sequence.reshape(1, self.sequence_length, -1).astype(np.float32)

            # Detect profile
            recent_raw_events = [event['raw_event'] for event in list(buffer)[-10:]]
            profile_type = self.detect_profile_type(node_name, recent_raw_events)
            profile_id = np.array([self.profile_to_id.get(profile_type, 0)], dtype=np.int64)

            # Run inference
            outputs = self.session.run(None, {
                'input_sequence': sequence,
                'profile_id': profile_id
            })

            class_logits, regression, attention_weights = outputs

            # Process predictions
            predictions = []
            for t in range(class_logits.shape[1]):
                pred_class = np.argmax(class_logits[0, t])
                confidence = float(np.max(class_logits[0, t]))
                pred_state = self.id_to_state.get(pred_class, 'UNKNOWN')

                predictions.append({
                    'time_step': t + 1,
                    'predicted_state': pred_state,
                    'confidence': confidence,
                    'clock_class_pred': float(regression[0, t, 0]),
                    'risk_score': 1.0 - confidence if pred_state in ['FREERUN', 'FAULTY'] else confidence
                })

            # Calculate inference time
            inference_time = time.time() - start_time
            self.prediction_count += 1
            self.avg_inference_time = (
                (self.avg_inference_time * (self.prediction_count - 1) + inference_time) /
                self.prediction_count
            )

            result = {
                'node_name': node_name,
                'profile_type': profile_type,
                'predictions': predictions,
                'inference_time_ms': inference_time * 1000,
                'attention_weights': attention_weights[0].tolist(),
                'current_state': buffer[-1]['raw_event'].get('value', 'UNKNOWN'),
                'timestamp': datetime.now().isoformat()
            }

            # Cache result
            self.prediction_cache[cache_key] = {
                'prediction': result,
                'created_at': time.time()
            }

            # Clean old cache entries
            self._clean_cache()

            return result

        except Exception as e:
            logger.error(f"Prediction error for node {node_name}: {e}")
            return {'error': str(e), 'node_name': node_name}

    def _clean_cache(self):
        """Remove expired cache entries"""
        current_time = time.time()
        expired_keys = [
            key for key, value in self.prediction_cache.items()
            if current_time - value['created_at'] > self.cache_ttl
        ]
        for key in expired_keys:
            del self.prediction_cache[key]

    async def get_predictions_for_all_nodes(self) -> Dict[str, Any]:
        """Get latest predictions for all nodes"""
        results = {}
        for node_name in self.node_buffers.keys():
            if len(self.node_buffers[node_name]) >= self.sequence_length:
                prediction = await self.predict_for_node(node_name)
                results[node_name] = prediction

        return {
            'predictions': results,
            'total_nodes': len(results),
            'timestamp': datetime.now().isoformat()
        }

    def get_service_stats(self) -> Dict[str, Any]:
        """Get service performance statistics"""
        return {
            'total_predictions': self.prediction_count,
            'avg_inference_time_ms': self.avg_inference_time * 1000,
            'active_nodes': len(self.node_buffers),
            'cached_predictions': len(self.prediction_cache),
            'model_path': self.model_path,
            'sequence_length': self.sequence_length
        }

# HTTP API Server
async def create_inference_api(inference_service: PTPInferenceService, port: int = 8082) -> web.Application:
    """Create HTTP API for inference service"""

    async def health_check(request):
        return web.json_response({'status': 'healthy', 'service': 'ptp-inference'})

    async def add_event_endpoint(request):
        try:
            event_data = await request.json()
            prediction = await inference_service.add_event(event_data)

            if prediction:
                return web.json_response(prediction)
            else:
                return web.json_response({'message': 'Event added, insufficient data for prediction'})

        except Exception as e:
            return web.json_response({'error': str(e)}, status=400)

    async def predict_node_endpoint(request):
        node_name = request.match_info.get('node_name')

        try:
            prediction = await inference_service.predict_for_node(node_name)
            return web.json_response(prediction)
        except Exception as e:
            return web.json_response({'error': str(e)}, status=400)

    async def get_all_predictions(request):
        try:
            predictions = await inference_service.get_predictions_for_all_nodes()
            return web.json_response(predictions)
        except Exception as e:
            return web.json_response({'error': str(e)}, status=500)

    async def get_stats(request):
        stats = inference_service.get_service_stats()
        return web.json_response(stats)

    # Create application
    app = web.Application()
    app.router.add_get('/health', health_check)
    app.router.add_post('/events', add_event_endpoint)
    app.router.add_get('/predict/{node_name}', predict_node_endpoint)
    app.router.add_get('/predictions', get_all_predictions)
    app.router.add_get('/stats', get_stats)

    return app

async def main():
    """Main entry point for inference service"""
    # Configuration
    model_path = os.getenv('PTP_MODEL_PATH', '/app/models/ptp_model.onnx')
    port = int(os.getenv('INFERENCE_PORT', '8082'))

    # Initialize service
    inference_service = PTPInferenceService(model_path)

    # Create and start API server
    app = await create_inference_api(inference_service, port)
    runner = web.AppRunner(app)
    await runner.setup()

    site = web.TCPSite(runner, '0.0.0.0', port)
    await site.start()

    logger.info(f"PTP Inference Service started on port {port}")

    # Keep running
    try:
        while True:
            await asyncio.sleep(60)
            # Periodic cleanup
            inference_service._clean_cache()
    except KeyboardInterrupt:
        logger.info("Shutting down inference service")
    finally:
        await runner.cleanup()

if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    asyncio.run(main())