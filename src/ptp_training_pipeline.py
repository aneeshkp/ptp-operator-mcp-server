#!/usr/bin/env python3
"""
PTP Training Pipeline - Complete training workflow for PTP event prediction
Integrates data collection, model training, and deployment
"""

import asyncio
import json
import logging
import numpy as np
import os
import pickle
import torch
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional, Any

from ptp_data_collector import PTPDataCollector, PTPEventSequence
from ptp_tcn_model import PTPTCNModel, PTPInferenceEngine

logger = logging.getLogger(__name__)

class PTPTrainingPipeline:
    """Complete training pipeline for PTP prediction model"""

    def __init__(self, config: Dict[str, Any] = None):
        self.config = config or self.get_default_config()

        # Initialize components
        self.data_collector = PTPDataCollector(
            max_sequence_length=self.config['sequence_length'],
            prediction_horizon=self.config['prediction_horizon']
        )

        self.model = PTPTCNModel(
            input_size=self.config['input_size'],
            num_channels=self.config['tcn_channels'],
            dropout=self.config['dropout'],
            prediction_horizon=self.config['prediction_horizon']
        )

        # Training state
        self.training_data = []
        self.profile_labels = []
        self.is_trained = False

        # Paths
        self.model_dir = Path(self.config['model_dir'])
        self.model_dir.mkdir(exist_ok=True)

    def get_default_config(self) -> Dict[str, Any]:
        """Default training configuration"""
        return {
            'sequence_length': 40,
            'prediction_horizon': 10,
            'input_size': 20,
            'tcn_channels': [32, 64, 32],
            'dropout': 0.2,
            'learning_rate': 0.001,
            'batch_size': 16,
            'num_epochs': 100,
            'early_stopping_patience': 15,
            'model_dir': '/tmp/ptp_models',
            'min_sequences_per_profile': 10,
            'training_split': 0.8
        }

    async def collect_training_data(self, events: List[Dict[str, Any]]):
        """Collect and process training data from PTP events"""
        logger.info(f"Processing {len(events)} events for training data")

        for event in events:
            self.data_collector.add_event(event)

        # Get training sequences
        self.training_data = self.data_collector.training_sequences
        logger.info(f"Collected {len(self.training_data)} training sequences")

        # Check data quality
        stats = self.data_collector.get_profile_statistics()
        logger.info(f"Profile distribution: {stats['profile_distribution']}")

        return stats

    def validate_training_data(self) -> bool:
        """Validate that we have sufficient training data"""
        if not self.training_data:
            logger.error("No training data available")
            return False

        # Check profile distribution
        profile_counts = {}
        for seq in self.training_data:
            profile_counts[seq.profile_type] = profile_counts.get(seq.profile_type, 0) + 1

        min_required = self.config['min_sequences_per_profile']
        insufficient_profiles = [
            profile for profile, count in profile_counts.items()
            if count < min_required
        ]

        if insufficient_profiles:
            logger.warning(f"Insufficient data for profiles: {insufficient_profiles}")
            logger.warning(f"Minimum required: {min_required}, found: {profile_counts}")

        # We can still train with insufficient data, just log warning
        return len(self.training_data) >= 20  # Minimum absolute requirement

    def prepare_training_split(self) -> Tuple[List[PTPEventSequence], List[PTPEventSequence]]:
        """Split data into training and validation sets"""
        # Group by profile for stratified split
        profiles_data = {}
        for seq in self.training_data:
            if seq.profile_type not in profiles_data:
                profiles_data[seq.profile_type] = []
            profiles_data[seq.profile_type].append(seq)

        train_data = []
        val_data = []

        for profile, sequences in profiles_data.items():
            # Shuffle sequences
            np.random.shuffle(sequences)

            # Split
            split_idx = int(len(sequences) * self.config['training_split'])
            train_data.extend(sequences[:split_idx])
            val_data.extend(sequences[split_idx:])

        logger.info(f"Training split: {len(train_data)} train, {len(val_data)} validation")
        return train_data, val_data

    def create_profile_balanced_batches(self, sequences: List[PTPEventSequence], batch_size: int) -> List[List[PTPEventSequence]]:
        """Create balanced batches with representation from each profile"""
        # Group by profile
        profile_sequences = {}
        for seq in sequences:
            if seq.profile_type not in profile_sequences:
                profile_sequences[seq.profile_type] = []
            profile_sequences[seq.profile_type].append(seq)

        # Create balanced batches
        batches = []
        profiles = list(profile_sequences.keys())

        while any(len(seqs) > 0 for seqs in profile_sequences.values()):
            batch = []

            # Try to get at least one from each profile
            for profile in profiles:
                if len(profile_sequences[profile]) > 0 and len(batch) < batch_size:
                    batch.append(profile_sequences[profile].pop(0))

            # Fill remaining batch slots
            for profile in profiles:
                while len(profile_sequences[profile]) > 0 and len(batch) < batch_size:
                    batch.append(profile_sequences[profile].pop(0))

            if batch:
                batches.append(batch)

        return batches

    def train_model(self) -> Dict[str, Any]:
        """Train the PTP prediction model"""
        if not self.validate_training_data():
            raise ValueError("Insufficient training data")

        logger.info("Starting model training...")

        # Prepare data split
        train_sequences, val_sequences = self.prepare_training_split()

        # Training setup
        device = torch.device('cpu')  # CPU-only for Kubernetes compatibility
        self.model.to(device)

        optimizer = torch.optim.Adam(
            self.model.parameters(),
            lr=self.config['learning_rate'],
            weight_decay=1e-5
        )

        scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(
            optimizer, mode='min', patience=10, factor=0.5
        )

        # Loss functions
        class_criterion = torch.nn.CrossEntropyLoss()
        regression_criterion = torch.nn.MSELoss()

        # Training loop
        best_val_loss = float('inf')
        patience_counter = 0
        training_history = []

        for epoch in range(self.config['num_epochs']):
            # Training phase
            self.model.train()
            train_loss = 0

            # Create balanced batches
            train_batches = self.create_profile_balanced_batches(
                train_sequences, self.config['batch_size']
            )

            for batch_sequences in train_batches:
                if len(batch_sequences) < 2:
                    continue

                try:
                    batch_loss = self._train_batch(
                        batch_sequences, optimizer, class_criterion, regression_criterion, device
                    )
                    train_loss += batch_loss
                except Exception as e:
                    logger.warning(f"Batch training error: {e}")
                    continue

            # Validation phase
            val_loss = self._validate_model(
                val_sequences, class_criterion, regression_criterion, device
            )

            # Update scheduler
            scheduler.step(val_loss)

            # Early stopping check
            if val_loss < best_val_loss:
                best_val_loss = val_loss
                patience_counter = 0
                # Save best model
                self._save_checkpoint(epoch, val_loss)
            else:
                patience_counter += 1

            # Log progress
            avg_train_loss = train_loss / max(1, len(train_batches))
            training_history.append({
                'epoch': epoch,
                'train_loss': avg_train_loss,
                'val_loss': val_loss,
                'learning_rate': optimizer.param_groups[0]['lr']
            })

            if epoch % 10 == 0:
                logger.info(f"Epoch {epoch}: train_loss={avg_train_loss:.4f}, val_loss={val_loss:.4f}")

            # Early stopping
            if patience_counter >= self.config['early_stopping_patience']:
                logger.info(f"Early stopping at epoch {epoch}")
                break

        self.is_trained = True

        return {
            'final_val_loss': best_val_loss,
            'epochs_trained': epoch + 1,
            'training_history': training_history
        }

    def _train_batch(self, batch_sequences, optimizer, class_criterion, regression_criterion, device):
        """Train on a single batch"""
        # Prepare batch data
        batch_data = self._prepare_batch_tensors(batch_sequences, device)

        optimizer.zero_grad()

        # Forward pass
        outputs = self.model(batch_data['sequences'], batch_data['profile_ids'])

        # Compute losses
        class_loss = class_criterion(
            outputs['class_logits'].view(-1, outputs['class_logits'].size(-1)),
            batch_data['class_targets'].view(-1)
        )

        regression_loss = regression_criterion(
            outputs['regression'],
            batch_data['regression_targets']
        )

        # Combined loss
        total_loss = class_loss + 0.1 * regression_loss

        # Backward pass
        total_loss.backward()
        torch.nn.utils.clip_grad_norm_(self.model.parameters(), max_norm=1.0)
        optimizer.step()

        return total_loss.item()

    def _validate_model(self, val_sequences, class_criterion, regression_criterion, device):
        """Validate model performance"""
        self.model.eval()
        total_val_loss = 0
        val_batches = 0

        val_batch_list = self.create_profile_balanced_batches(
            val_sequences, self.config['batch_size']
        )

        with torch.no_grad():
            for batch_sequences in val_batch_list:
                if len(batch_sequences) < 2:
                    continue

                try:
                    batch_data = self._prepare_batch_tensors(batch_sequences, device)
                    outputs = self.model(batch_data['sequences'], batch_data['profile_ids'])

                    class_loss = class_criterion(
                        outputs['class_logits'].view(-1, outputs['class_logits'].size(-1)),
                        batch_data['class_targets'].view(-1)
                    )

                    regression_loss = regression_criterion(
                        outputs['regression'],
                        batch_data['regression_targets']
                    )

                    batch_loss = class_loss + 0.1 * regression_loss
                    total_val_loss += batch_loss.item()
                    val_batches += 1
                except Exception as e:
                    logger.warning(f"Validation batch error: {e}")
                    continue

        return total_val_loss / max(1, val_batches)

    def _prepare_batch_tensors(self, batch_sequences, device):
        """Convert batch sequences to tensors"""
        # Extract features and targets
        sequences = []
        profile_ids = []
        class_targets = []
        regression_targets = []

        profile_to_id = {'OC': 0, 'BC': 1, 'dual_BC': 2, 'T_GM': 3}

        for seq in batch_sequences:
            sequences.append(seq.sequence)
            profile_ids.append(profile_to_id.get(seq.profile_type, 0))

            # Simple target extraction (use last few events as targets)
            if seq.target_events:
                # Extract class and regression targets from target events
                target_classes = []
                target_regressions = []

                for target in seq.target_events:
                    if isinstance(target, list) and len(target) >= 5:
                        target_classes.append(int(target[1]) if target[1] >= 0 else 0)
                        target_regressions.append([
                            target[2] if len(target) > 2 else 0,
                            target[11] if len(target) > 11 else 0,
                            target[12] if len(target) > 12 else 0
                        ])
                    else:
                        target_classes.append(0)
                        target_regressions.append([0, 0, 0])

                # Pad to prediction horizon
                while len(target_classes) < self.config['prediction_horizon']:
                    target_classes.append(0)
                    target_regressions.append([0, 0, 0])

                class_targets.append(target_classes[:self.config['prediction_horizon']])
                regression_targets.append(target_regressions[:self.config['prediction_horizon']])
            else:
                class_targets.append([0] * self.config['prediction_horizon'])
                regression_targets.append([[0, 0, 0]] * self.config['prediction_horizon'])

        return {
            'sequences': torch.FloatTensor(sequences).to(device),
            'profile_ids': torch.LongTensor(profile_ids).to(device),
            'class_targets': torch.LongTensor(class_targets).to(device),
            'regression_targets': torch.FloatTensor(regression_targets).to(device)
        }

    def _save_checkpoint(self, epoch, val_loss):
        """Save model checkpoint"""
        checkpoint_path = self.model_dir / f"ptp_model_epoch_{epoch}.pth"
        torch.save({
            'epoch': epoch,
            'model_state_dict': self.model.state_dict(),
            'val_loss': val_loss,
            'config': self.config
        }, checkpoint_path)

        # Also save as best model
        best_model_path = self.model_dir / "ptp_model_best.pth"
        torch.save({
            'epoch': epoch,
            'model_state_dict': self.model.state_dict(),
            'val_loss': val_loss,
            'config': self.config
        }, best_model_path)

    def export_for_deployment(self) -> str:
        """Export trained model to ONNX for deployment"""
        if not self.is_trained:
            raise ValueError("Model must be trained before export")

        onnx_path = self.model_dir / "ptp_model.onnx"

        # Export to ONNX
        self.model.eval()
        dummy_input = torch.randn(1, self.config['sequence_length'], self.config['input_size'])
        dummy_profile = torch.LongTensor([0])

        torch.onnx.export(
            self.model,
            (dummy_input, dummy_profile),
            str(onnx_path),
            export_params=True,
            opset_version=11,
            do_constant_folding=True,
            input_names=['input_sequence', 'profile_id'],
            output_names=['class_logits', 'regression', 'attention_weights']
        )

        logger.info(f"Model exported to ONNX: {onnx_path}")
        return str(onnx_path)

    def generate_training_report(self) -> Dict[str, Any]:
        """Generate comprehensive training report"""
        stats = self.data_collector.get_profile_statistics()

        return {
            'training_completed': self.is_trained,
            'data_statistics': stats,
            'model_config': self.config,
            'training_timestamp': datetime.now().isoformat(),
            'model_files': {
                'pytorch_model': str(self.model_dir / "ptp_model_best.pth"),
                'onnx_model': str(self.model_dir / "ptp_model.onnx") if self.is_trained else None
            }
        }

# Training workflow functions
async def run_training_workflow(events_data: List[Dict]) -> Dict[str, Any]:
    """Complete training workflow"""
    logger.info("Starting PTP model training workflow")

    # Initialize pipeline
    pipeline = PTPTrainingPipeline()

    # Collect training data
    data_stats = await pipeline.collect_training_data(events_data)

    # Train model
    training_results = pipeline.train_model()

    # Export for deployment
    onnx_path = pipeline.export_for_deployment()

    # Generate report
    report = pipeline.generate_training_report()
    report['training_results'] = training_results

    logger.info("Training workflow completed successfully")
    return report