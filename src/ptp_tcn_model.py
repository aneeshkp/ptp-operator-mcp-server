#!/usr/bin/env python3
"""
PTP TCN Model - Temporal Convolutional Network for PTP event prediction
Lightweight model designed for CPU-only inference in Kubernetes environments
"""

import logging
import numpy as np
import os
import pickle
import torch
import torch.nn as nn
import torch.nn.functional as F
from pathlib import Path
from typing import Dict, List, Optional, Tuple, Any
import onnx
import onnxruntime as ort

logger = logging.getLogger(__name__)

class TemporalBlock(nn.Module):
    """Basic building block of TCN with residual connections"""

    def __init__(self, n_inputs: int, n_outputs: int, kernel_size: int, stride: int,
                 dilation: int, padding: int, dropout: float = 0.2):
        super(TemporalBlock, self).__init__()

        self.conv1 = nn.Conv1d(n_inputs, n_outputs, kernel_size,
                               stride=stride, padding=padding, dilation=dilation)
        self.chomp1 = Chomp1d(padding)
        self.relu1 = nn.ReLU()
        self.dropout1 = nn.Dropout(dropout)

        self.conv2 = nn.Conv1d(n_outputs, n_outputs, kernel_size,
                               stride=stride, padding=padding, dilation=dilation)
        self.chomp2 = Chomp1d(padding)
        self.relu2 = nn.ReLU()
        self.dropout2 = nn.Dropout(dropout)

        self.net = nn.Sequential(self.conv1, self.chomp1, self.relu1, self.dropout1,
                                self.conv2, self.chomp2, self.relu2, self.dropout2)

        self.downsample = nn.Conv1d(n_inputs, n_outputs, 1) if n_inputs != n_outputs else None
        self.relu = nn.ReLU()

    def forward(self, x):
        out = self.net(x)
        res = x if self.downsample is None else self.downsample(x)
        return self.relu(out + res)

class Chomp1d(nn.Module):
    """Remove padding from the end of sequences"""
    def __init__(self, chomp_size):
        super(Chomp1d, self).__init__()
        self.chomp_size = chomp_size

    def forward(self, x):
        return x[:, :, :-self.chomp_size].contiguous()

class AttentionLayer(nn.Module):
    """Attention mechanism for focusing on important temporal patterns"""

    def __init__(self, hidden_size: int):
        super(AttentionLayer, self).__init__()
        self.hidden_size = hidden_size
        self.attn = nn.Linear(hidden_size, hidden_size)
        self.v = nn.Linear(hidden_size, 1, bias=False)

    def forward(self, hidden_states):
        # hidden_states: (batch, seq_len, hidden_size)
        attn_weights = torch.tanh(self.attn(hidden_states))
        attn_weights = self.v(attn_weights).squeeze(-1)
        attn_probs = F.softmax(attn_weights, dim=-1)
        attended = torch.bmm(attn_probs.unsqueeze(1), hidden_states).squeeze(1)
        return attended, attn_probs

class PTPTCNModel(nn.Module):
    """TCN + Attention model for PTP event prediction"""

    def __init__(self,
                 input_size: int = 20,
                 num_channels: List[int] = [32, 64, 32],
                 kernel_size: int = 3,
                 dropout: float = 0.2,
                 prediction_horizon: int = 10,
                 num_classes: int = 8):

        super(PTPTCNModel, self).__init__()
        self.input_size = input_size
        self.prediction_horizon = prediction_horizon
        self.num_classes = num_classes

        # TCN layers
        layers = []
        num_levels = len(num_channels)

        for i in range(num_levels):
            dilation_size = 2 ** i
            in_channels = input_size if i == 0 else num_channels[i-1]
            out_channels = num_channels[i]

            layers += [TemporalBlock(in_channels, out_channels, kernel_size,
                                   stride=1, dilation=dilation_size,
                                   padding=(kernel_size-1) * dilation_size,
                                   dropout=dropout)]

        self.tcn = nn.Sequential(*layers)
        self.attention = AttentionLayer(num_channels[-1])
        self.profile_embedding = nn.Embedding(4, 8)

        # Output layers
        self.classifier = nn.Sequential(
            nn.Linear(num_channels[-1] + 8, 128),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(128, 64),
            nn.ReLU(),
            nn.Linear(64, prediction_horizon * num_classes)
        )

        self.regressor = nn.Sequential(
            nn.Linear(num_channels[-1] + 8, 64),
            nn.ReLU(),
            nn.Dropout(dropout),
            nn.Linear(64, prediction_horizon * 3)
        )

    def forward(self, x, profile_ids):
        batch_size = x.size(0)
        x = x.transpose(1, 2)
        tcn_out = self.tcn(x)
        tcn_out = tcn_out.transpose(1, 2)
        attended, attn_weights = self.attention(tcn_out)
        profile_emb = self.profile_embedding(profile_ids)
        combined = torch.cat([attended, profile_emb], dim=-1)

        class_logits = self.classifier(combined)
        regression_out = self.regressor(combined)

        class_logits = class_logits.view(batch_size, self.prediction_horizon, self.num_classes)
        regression_out = regression_out.view(batch_size, self.prediction_horizon, 3)

        return {
            'class_logits': class_logits,
            'regression': regression_out,
            'attention_weights': attn_weights
        }

class PTPInferenceEngine:
    """CPU-only inference engine for PTP predictions"""

    def __init__(self, onnx_model_path: str):
        self.session = ort.InferenceSession(onnx_model_path)
        self.profile_to_id = {'OC': 0, 'BC': 1, 'dual_BC': 2, 'T_GM': 3}
        self.id_to_state = {0: 'LOCKED', 1: 'FREERUN', 2: 'HOLDOVER', 3: 'FAULTY'}

    def predict(self, sequence: np.ndarray, profile_type: str) -> Dict[str, Any]:
        """Make prediction for PTP event sequence"""
        input_sequence = sequence.reshape(1, -1, sequence.shape[-1]).astype(np.float32)
        profile_id = np.array([self.profile_to_id.get(profile_type, 0)], dtype=np.int64)

        outputs = self.session.run(None, {
            'input_sequence': input_sequence,
            'profile_id': profile_id
        })

        class_logits, regression, attention_weights = outputs

        predictions = []
        for t in range(class_logits.shape[1]):
            pred_class = np.argmax(class_logits[0, t])
            pred_state = self.id_to_state.get(pred_class, 'UNKNOWN')

            predictions.append({
                'predicted_state': pred_state,
                'confidence': float(np.max(class_logits[0, t])),
                'clock_class_pred': float(regression[0, t, 0]),
                'attention_score': float(attention_weights[0, t]) if t < len(attention_weights[0]) else 0.0
            })

        return {
            'predictions': predictions,
            'overall_attention': attention_weights[0].tolist()
        }