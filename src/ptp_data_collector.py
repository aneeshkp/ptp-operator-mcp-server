#!/usr/bin/env python3
"""
PTP Data Collector - Enhanced data collection for ML training
Collects temporal sequences of PTP events for training prediction models
"""

import asyncio
import json
import logging
import numpy as np
import os
import pickle
import time
from collections import defaultdict, deque
from dataclasses import dataclass, asdict
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Any, Tuple
from pathlib import Path

logger = logging.getLogger(__name__)

@dataclass
class PTPEventSequence:
    """A sequence of PTP events for ML training"""
    node_name: str
    profile_type: str  # OC, BC, dual_BC, T_GM
    sequence: List[Dict[str, Any]]
    timeline: List[float]  # timestamps as seconds since epoch
    target_events: List[Dict[str, Any]]  # events to predict
    metadata: Dict[str, Any]

@dataclass
class PTPProfileConfig:
    """PTP profile configuration detected from events"""
    profile_type: str  # OC, BC, dual_BC, T_GM
    has_gnss: bool
    has_phc2sys: bool
    has_ptp4l: bool
    interfaces: List[str]
    clock_sources: List[str]
    detected_from: List[str]  # resource addresses that led to detection

class PTPDataCollector:
    """Enhanced data collector for PTP event ML training"""

    def __init__(self, max_sequence_length: int = 50, prediction_horizon: int = 10):
        self.max_sequence_length = max_sequence_length
        self.prediction_horizon = prediction_horizon  # events to predict ahead

        # Data storage
        self.node_sequences: Dict[str, deque] = defaultdict(lambda: deque(maxlen=max_sequence_length))
        self.node_profiles: Dict[str, PTPProfileConfig] = {}
        self.training_sequences: List[PTPEventSequence] = []

        # Event encoding mappings
        self.state_encoding = {
            'LOCKED': 0, 'FREERUN': 1, 'HOLDOVER': 2, 'FAULTY': 3,
            'ANTENNA-DISCONNECTED': 4, 'ANTENNA-SHORT-CIRCUIT': 5,
            'NO-FIX': 6, 'SURVEY-FAIL': 7, 'TRACKING': 8
        }

        self.clock_class_encoding = {
            6: 0, 7: 1, 248: 2, 52: 3, 58: 4, 165: 5, 193: 6
        }

        self.resource_type_encoding = {
            'sync-status/sync-state': 0,
            'sync-status/os-clock-sync-state': 1,
            'ptp-status/lock-state': 2,
            'ptp-status/clock-class': 3,
            'ptp-status/ptp-clock-class': 4,
            'gnss-status/gnss-sync-status': 5
        }

        # Profile detection patterns
        self.profile_patterns = {
            'T_GM': {
                'required_resources': ['gnss-status', 'ptp-status', 'sync-status'],
                'clock_sources': ['GNSS', 'GPS'],
                'typical_states': ['TRACKING', 'LOCKED', 'ANTENNA-DISCONNECTED']
            },
            'BC': {
                'required_resources': ['ptp-status', 'sync-status'],
                'clock_sources': ['PTP'],
                'typical_states': ['LOCKED', 'HOLDOVER', 'FREERUN']
            },
            'dual_BC': {
                'required_resources': ['ptp-status', 'sync-status'],
                'interfaces_count': 2,
                'clock_sources': ['PTP'],
                'typical_states': ['LOCKED', 'HOLDOVER', 'FREERUN']
            },
            'OC': {
                'required_resources': ['sync-status'],
                'clock_sources': ['PTP', 'SYS'],
                'typical_states': ['LOCKED', 'FREERUN']
            }
        }

        # Training data path
        self.data_path = Path(os.getenv('PTP_TRAINING_DATA_PATH', '/tmp/ptp_training_data'))
        self.data_path.mkdir(exist_ok=True)

    def detect_profile_type(self, node_name: str, recent_events: List[Dict]) -> str:
        """Detect PTP profile type based on event patterns"""
        if node_name in self.node_profiles:
            return self.node_profiles[node_name].profile_type

        resource_types = set()
        clock_sources = set()
        interfaces = set()
        detected_resources = []

        for event in recent_events:
            resource_addr = event.get('resource_address', '')
            detected_resources.append(resource_addr)

            # Extract resource type
            if '/sync-status/' in resource_addr:
                resource_types.add('sync-status')
            if '/ptp-status/' in resource_addr:
                resource_types.add('ptp-status')
            if '/gnss-status/' in resource_addr:
                resource_types.add('gnss-status')
                clock_sources.add('GNSS')

            # Extract interface info from resource address
            parts = resource_addr.split('/')
            for part in parts:
                if part.startswith('ens') or part.startswith('eth'):
                    interfaces.add(part)

        # Profile detection logic
        profile_type = 'OC'  # default

        if 'gnss-status' in resource_types:
            profile_type = 'T_GM'
        elif 'ptp-status' in resource_types and len(interfaces) >= 2:
            profile_type = 'dual_BC'
        elif 'ptp-status' in resource_types:
            profile_type = 'BC'

        # Store detected profile
        self.node_profiles[node_name] = PTPProfileConfig(
            profile_type=profile_type,
            has_gnss='gnss-status' in resource_types,
            has_phc2sys='sync-status' in resource_types,
            has_ptp4l='ptp-status' in resource_types,
            interfaces=list(interfaces),
            clock_sources=list(clock_sources),
            detected_from=detected_resources
        )

        logger.info(f"Detected profile {profile_type} for node {node_name}")
        return profile_type

    def encode_event(self, event: Dict[str, Any]) -> np.ndarray:
        """Encode PTP event into numerical features for ML"""
        features = np.zeros(20)  # Feature vector size

        # Basic event features
        features[0] = time.time() - float(event.get('timestamp', time.time()))  # time since event

        # State encoding
        value = event.get('value', '')
        if value in self.state_encoding:
            features[1] = self.state_encoding[value]
        elif value.isdigit():
            # Clock class value
            clock_class = int(value)
            if clock_class in self.clock_class_encoding:
                features[2] = self.clock_class_encoding[clock_class]
            else:
                features[2] = 7  # unknown clock class

        # Resource type encoding
        resource_addr = event.get('resource_address', '')
        for resource_type, encoding in self.resource_type_encoding.items():
            if resource_type in resource_addr:
                features[3] = encoding
                break

        # Data type (notification vs metric)
        features[4] = 1 if event.get('data_type') == 'notification' else 0

        # Event severity (derived)
        if value in ['FREERUN', 'FAULTY', 'ANTENNA-DISCONNECTED']:
            features[5] = 2  # critical
        elif value in ['HOLDOVER', 'ANTENNA-SHORT-CIRCUIT']:
            features[5] = 1  # warning
        else:
            features[5] = 0  # info

        # Profile-specific features (filled when we know the profile)
        # features[6-10] reserved for profile-specific encodings

        # Temporal features
        features[11] = datetime.now().hour  # hour of day
        features[12] = datetime.now().weekday()  # day of week

        # Network/cluster features (could be enhanced)
        features[13] = hash(event.get('node_name', '')) % 100  # node hash

        return features

    def add_event(self, event: Dict[str, Any]):
        """Add new event to training data collection"""
        node_name = event.get('node_name', 'unknown')

        # Encode event
        encoded_event = {
            'features': self.encode_event(event).tolist(),
            'raw_event': event,
            'timestamp': time.time()
        }

        # Add to node sequence
        self.node_sequences[node_name].append(encoded_event)

        # Check if we have enough events to create training sequence
        if len(self.node_sequences[node_name]) >= self.max_sequence_length:
            self.create_training_sequence(node_name)

    def create_training_sequence(self, node_name: str):
        """Create a training sequence from recent events"""
        events = list(self.node_sequences[node_name])
        if len(events) < self.max_sequence_length:
            return

        # Detect profile type
        recent_raw_events = [e['raw_event'] for e in events[-20:]]
        profile_type = self.detect_profile_type(node_name, recent_raw_events)

        # Split into input sequence and target events
        input_events = events[:-self.prediction_horizon]
        target_events = events[-self.prediction_horizon:]

        # Create sequence
        sequence = PTPEventSequence(
            node_name=node_name,
            profile_type=profile_type,
            sequence=[e['features'] for e in input_events],
            timeline=[e['timestamp'] for e in input_events],
            target_events=[e['features'] for e in target_events],
            metadata={
                'profile_config': asdict(self.node_profiles.get(node_name)),
                'sequence_length': len(input_events),
                'created_at': datetime.now().isoformat()
            }
        )

        self.training_sequences.append(sequence)
        logger.info(f"Created training sequence for {node_name} ({profile_type}): {len(input_events)} -> {len(target_events)}")

        # Save periodically
        if len(self.training_sequences) % 10 == 0:
            self.save_training_data()

    def save_training_data(self):
        """Save collected training data to disk"""
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

        # Save sequences
        sequences_file = self.data_path / f"ptp_sequences_{timestamp}.pkl"
        with open(sequences_file, 'wb') as f:
            pickle.dump(self.training_sequences, f)

        # Save profiles
        profiles_file = self.data_path / f"ptp_profiles_{timestamp}.json"
        with open(profiles_file, 'w') as f:
            json.dump({
                node: asdict(profile) for node, profile in self.node_profiles.items()
            }, f, indent=2)

        logger.info(f"Saved {len(self.training_sequences)} training sequences to {sequences_file}")

    def get_profile_statistics(self) -> Dict[str, Any]:
        """Get statistics about collected data"""
        profile_counts = defaultdict(int)
        event_counts = defaultdict(int)

        for sequence in self.training_sequences:
            profile_counts[sequence.profile_type] += 1
            event_counts[sequence.node_name] += len(sequence.sequence)

        return {
            'total_sequences': len(self.training_sequences),
            'profile_distribution': dict(profile_counts),
            'events_per_node': dict(event_counts),
            'detected_profiles': {
                node: profile.profile_type for node, profile in self.node_profiles.items()
            }
        }

    def prepare_training_data(self) -> Tuple[np.ndarray, np.ndarray, List[str]]:
        """Prepare data for training the ML model"""
        if not self.training_sequences:
            logger.warning("No training sequences available")
            return np.array([]), np.array([]), []

        # Group by profile type for balanced training
        sequences_by_profile = defaultdict(list)
        for seq in self.training_sequences:
            sequences_by_profile[seq.profile_type].append(seq)

        X_sequences = []
        y_sequences = []
        profile_labels = []

        for profile_type, sequences in sequences_by_profile.items():
            for seq in sequences:
                if len(seq.sequence) == len(seq.target_events):
                    continue  # Skip if sequence lengths don't match expected format

                X_sequences.append(seq.sequence)
                y_sequences.append(seq.target_events)
                profile_labels.append(profile_type)

        if not X_sequences:
            logger.warning("No valid sequences for training")
            return np.array([]), np.array([]), []

        X = np.array(X_sequences)
        y = np.array(y_sequences)

        logger.info(f"Prepared training data: X shape {X.shape}, y shape {y.shape}")
        return X, y, profile_labels