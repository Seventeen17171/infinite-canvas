import { CanvasNodeType, type ViewportTransform } from "@/app/(user)/canvas/types";
import type { ProductionCanvasNode } from "@/services/api/production-canvas-documents";

export const canvasImageLimit = 20;
export const canvasImageSlots = 4;
export type ImageReference = { assetId: string; fileId: string };
export const imageReferenceKey = (reference: ImageReference) => `${reference.assetId}:${reference.fileId}`;
export function imageReference(node: ProductionCanvasNode): ImageReference | undefined {
    if (node.type !== CanvasNodeType.Image || !node.metadata?.assetId || !node.metadata.fileId) return;
    return { assetId: node.metadata.assetId, fileId: node.metadata.fileId };
}
export function visibleImageReferences(nodes: ProductionCanvasNode[], viewport: ViewportTransform, size: { width: number; height: number }, preferred: string) {
    const references = new Map<string, ImageReference>();
    for (const node of nodes) {
        const reference = imageReference(node);
        if (!reference) continue;
        const x = node.position.x * viewport.k + viewport.x;
        const y = node.position.y * viewport.k + viewport.y;
        if (x + node.width * viewport.k < 0 || y + node.height * viewport.k < 0 || x > size.width || y > size.height) continue;
        references.set(imageReferenceKey(reference), reference);
    }
    return [...references.values()].sort((a, b) => Number(imageReferenceKey(b) === preferred) - Number(imageReferenceKey(a) === preferred)).slice(0, canvasImageSlots);
}
export function referenceNode(reference: ImageReference, title: string, width: number, height: number, center: { x: number; y: number }, id = crypto.randomUUID()): ProductionCanvasNode {
    const scale = Math.min(1, 420 / width, 340 / height);
    // Extreme source aspect ratios use a bounded frame; object-fit preserves every image pixel.
    const frameWidth = Math.max(80, width * scale);
    const frameHeight = Math.max(80, height * scale);
    const bound = (value: number) => Math.min(1_000_000, Math.max(-1_000_000, value));
    return { id, type: CanvasNodeType.Image, title: title.slice(0, 200), width: frameWidth, height: frameHeight, position: { x: bound(center.x - frameWidth / 2), y: bound(center.y - frameHeight / 2) }, metadata: { assetId: reference.assetId, fileId: reference.fileId } };
}

export function decodeReferenceImage(url: string, signal: AbortSignal): Promise<{ width: number; height: number }> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        const timer = setTimeout(() => { clear(); reject(new Error("图片解码超时，请重新加载")); }, 15_000);
        const clear = () => { clearTimeout(timer); image.onload = null; image.onerror = null; image.src = ""; signal.removeEventListener("abort", abort); };
        const abort = () => { clear(); reject(new DOMException("图片读取已取消", "AbortError")); };
        image.onload = () => {
            const width = image.naturalWidth, height = image.naturalHeight;
            clear();
            if (!width || !height || width > 8192 || height > 8192 || width * height > 24_000_000) reject(new Error("图片尺寸不可用，请在资产工作台重新上传"));
            else resolve({ width, height });
        };
        image.onerror = () => { clear(); reject(new Error("图片无法解码，请在资产工作台检查原文件")); };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort(); else image.src = url;
    });
}
