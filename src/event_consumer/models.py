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
