import type { CanvasNodeType, Position, ViewportTransform, CanvasConnection } from "@/app/(user)/canvas/types";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import { ApiError, apiGet, apiPost, apiPut } from "./request";

export type ProductionCanvasNode = {
    id: string;
    type: CanvasNodeType.Text | CanvasNodeType.Group;
    title: string;
    position: Position;
    width: number;
    height: number;
    metadata?: { content?: string; groupId?: string; fontSize?: number };
};
export type ProductionCanvasContent = {
    schemaVersion: 1;
    nodes: ProductionCanvasNode[];
    connections: CanvasConnection[];
    viewport: ViewportTransform;
    backgroundMode: CanvasBackgroundMode;
};
export type CanvasDocumentMetadata = { id: string; projectId: string; workspaceId: string; title: string; revision: number; createdBy: string; updatedBy: string; createdAt: string; updatedAt: string };
export type ProductionCanvasDocument = CanvasDocumentMetadata & { content: ProductionCanvasContent };
export type CanvasDocumentInput = { title: string; content: ProductionCanvasContent; requestId: string };
export type CanvasSaveInput = CanvasDocumentInput & { revision: number };
export type CanvasSaveReceipt = Pick<CanvasDocumentMetadata, "id" | "projectId" | "workspaceId" | "revision" | "updatedAt"> & { requestId: string };
export function emptyCanvasContent(): ProductionCanvasContent {
    return { schemaVersion: 1, nodes: [], connections: [], viewport: { x: 0, y: 0, k: 1 }, backgroundMode: "lines" };
}
const base = (projectId: string) => `/api/v1/production/projects/${encodeURIComponent(projectId)}/workspaces/canvas/documents`;
export function fetchCanvasDocuments(token: string, projectId: string, page = 1) {
    return apiGet<{ items: CanvasDocumentMetadata[]; total: number }>(base(projectId), { page, pageSize: 20 }, token, 30_000);
}
export async function createCanvasDocument(token: string, projectId: string, input: CanvasDocumentInput) {
    return checkedDocument(await apiPost<ProductionCanvasDocument>(base(projectId), input, token, 30_000), projectId);
}
export async function fetchCanvasDocument(token: string, projectId: string, id: string) {
    return checkedDocument(await apiGet<ProductionCanvasDocument>(`${base(projectId)}/${encodeURIComponent(id)}`, undefined, token, 30_000), projectId, id);
}
export async function saveCanvasDocument(token: string, projectId: string, id: string, input: CanvasSaveInput) {
    const receipt = await apiPut<CanvasSaveReceipt>(`${base(projectId)}/${encodeURIComponent(id)}`, input, token, 30_000);
    if (!receipt || receipt.id !== id || receipt.projectId !== projectId || receipt.requestId !== input.requestId || !Number.isSafeInteger(receipt.revision) || receipt.revision < 1) throw new ApiError("保存回执异常，请重试确认提交结果", 502);
    return receipt;
}

function checkedDocument(document: ProductionCanvasDocument, projectId: string, id?: string) {
    if (
        !document ||
        !document.id ||
        (id && document.id !== id) ||
        document.projectId !== projectId ||
        typeof document.title !== "string" ||
        !Number.isSafeInteger(document.revision) ||
        document.revision < 1 ||
        document.content?.schemaVersion !== 1 ||
        !Array.isArray(document.content.nodes) ||
        !Array.isArray(document.content.connections) ||
        !document.content.viewport
    )
        throw new ApiError("画布响应异常，请重试确认提交结果", 502);
    return document;
}
