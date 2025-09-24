#!/usr/bin/env python3

import asyncio
import json
from typing import Any, Dict

from kubernetes import client, config

from mcp.server.fastmcp import FastMCP


class PTPOperatorMCPServer:
    def __init__(self) -> None:
        self.server = FastMCP("ptp-operator-mcp-server")

        # Kubernetes client
        self.k8s_core: client.CoreV1Api | None = None
        self.custom_api: client.CustomObjectsApi | None = None
        self._init_kube()

        # Register tools via decorators
        self._register_tools()

    def _init_kube(self) -> None:
        try:
            # Honors KUBECONFIG env or in-cluster config
            try:
                config.load_kube_config()
            except Exception:
                config.load_incluster_config()

            self.k8s_core = client.CoreV1Api()
            self.custom_api = client.CustomObjectsApi()
        except Exception as e:  # keep server available for non-k8s operations
            print(f"Failed to initialize Kubernetes client: {e}", flush=True)

    def _register_tools(self) -> None:
        server = self.server

        @server.tool()
        async def list_ptp_pods(
            namespace: str = "openshift-ptp",
            labelSelector: str = "app=linuxptp-daemon",
        ) -> str:
            return await self.list_ptp_pods({
                "namespace": namespace,
                "labelSelector": labelSelector,
            })

        @server.tool()
        async def get_ptp_configs(
            namespace: str = "openshift-ptp",
            configName: str | None = None,
            includeStatus: bool = True,
        ) -> str:
            return await self.get_ptp_configs({
                "namespace": namespace,
                "configName": configName,
                "includeStatus": includeStatus,
            })

    # Tool handlers
    async def list_ptp_pods(self, arguments: Dict[str, Any]) -> str:
        namespace: str = arguments.get("namespace", "openshift-ptp")
        label: str = arguments.get("labelSelector", "app=linuxptp-daemon")
        if not self.k8s_core:
            return "Kubernetes client not initialized"
        try:
            resp = self.k8s_core.list_namespaced_pod(namespace, label_selector=label)
            pods = []
            for pod in resp.items:
                pods.append(
                    {
                        "name": pod.metadata.name,
                        "node": getattr(pod.spec, "node_name", None),
                        "phase": getattr(pod.status, "phase", None),
                    }
                )
            return f"PTP Pods in {namespace}:\n\n" + json.dumps(pods, indent=2)
        except Exception as e:
            return f"Failed to list pods: {e}"

    async def get_ptp_configs(self, arguments: Dict[str, Any]) -> str:
        namespace: str = arguments.get("namespace", "openshift-ptp")
        include_status: bool = arguments.get("includeStatus", True)
        config_name: str | None = arguments.get("configName")
        if not self.custom_api:
            return "Kubernetes client not initialized"
        group = "ptp.openshift.io"
        version = "v1"
        plural = "ptpconfigs"
        try:
            if config_name:
                resp = self.custom_api.get_namespaced_custom_object(group, version, namespace, plural, config_name)
                body = resp
            else:
                resp = self.custom_api.list_namespaced_custom_object(group, version, namespace, plural)
                items = resp.get("items", [])
                if not include_status:
                    for item in items:
                        item.pop("status", None)
                body = items
            return json.dumps(body, indent=2)
        except Exception as e:
            return f"Failed to get PtpConfigs: {e}"


def main() -> None:
    app = PTPOperatorMCPServer()
    app.server.run()


if __name__ == "__main__":
    main()


