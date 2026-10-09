import type { WorkflowCapability, WorkflowFieldMapping, WorkflowGraphPreview } from "@/lib/workflow-channel";
import { apiDelete, apiGet, apiPost } from "@/services/api/request";

export type ComfyBridgeSummary = {
    id: string;
    name: string;
    enabled: boolean;
    online: boolean;
    lastSeenAt?: string;
    capabilities?: {
        comfyOnline?: boolean;
        comfyUrl?: string;
        workflowDir?: string;
        workflows?: Array<{ workflowId: string; title?: string }>;
    };
};

export type ComfyBridgeRegistration = { bridge: ComfyBridgeSummary; token: string };
export type ComfyBridgeInspectInput = { bridgeId: string; workflowId: string; workflowJson?: Record<string, unknown>; capability: WorkflowCapability };
export type ComfyBridgeInspectResult = { workflowJson: Record<string, unknown>; workflowGraph?: WorkflowGraphPreview; fields: WorkflowFieldMapping[] };

const bridgePath = "/api/admin/comfy-bridges";

export function listComfyBridges(token: string) {
    return apiGet<ComfyBridgeSummary[]>(bridgePath, undefined, token);
}

export function createComfyBridge(token: string, name: string) {
    return apiPost<ComfyBridgeRegistration>(bridgePath, { name }, token);
}

export function deleteComfyBridge(token: string, id: string) {
    return apiDelete<{ deleted: boolean }>(`${bridgePath}/${encodeURIComponent(id)}`, token);
}

export function inspectComfyBridge(token: string, input: ComfyBridgeInspectInput) {
    return apiPost<ComfyBridgeInspectResult>(`${bridgePath}/inspect`, input, token);
}
