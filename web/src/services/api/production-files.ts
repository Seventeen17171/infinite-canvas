import { ApiError } from "./request";

export const productionFileLimit = 20 * 1024 * 1024;
const imageTypes = ["image/png", "image/jpeg", "image/webp"];
export type ProductionFile = { id: string; projectId: string; assetId: string; name: string; mimeType: string; bytes: number; createdAt: string };
export type ProductionFileList = { items: ProductionFile[]; total: number };
const base = (projectId: string) => `/api/v1/production/projects/${encodeURIComponent(projectId)}`;

function checkedFile(file: ProductionFile, projectId: string, assetId: string) {
    if (!file || typeof file.id !== "string" || !/^file-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(file.id) || file.projectId !== projectId || file.assetId !== assetId || typeof file.name !== "string" || !file.name || !imageTypes.includes(file.mimeType) || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || file.bytes > productionFileLimit || typeof file.createdAt !== "string") throw new ApiError("文件信息异常，请重新载入图片列表", 502);
    return file;
}

async function requestFile<T>(url: string, token: string, signal: AbortSignal, read: (response: Response) => Promise<T>) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) controller.abort();
    const timer = setTimeout(abort, 30_000);
    try {
        const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", redirect: "error", signal: controller.signal });
        if (!response.ok) {
            await response.body?.cancel();
            throw new ApiError(response.status === 401 ? "登录已失效，请重新登录" : response.status === 403 || response.status === 404 ? "文件不可用，请重新载入确认访问权限" : "图片读取失败，请稍后重试", response.status);
        }
        return await read(response);
    } catch (error) {
        if (signal.aborted) throw new DOMException("请求已取消", "AbortError");
        if (error instanceof ApiError) throw error;
        throw new ApiError(controller.signal.aborted ? "图片读取超时，请重试" : "图片连接失败，请稍后重试", 0);
    } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
    }
}

export async function fetchAssetFiles(token: string, projectId: string, assetId: string, page: number, signal: AbortSignal) {
    return requestFile(`${base(projectId)}/assets/${encodeURIComponent(assetId)}/files?page=${page}&pageSize=20`, token, signal, async (response) => {
        const payload = await response.json() as { code: number; data: ProductionFileList };
        const result = payload?.data;
        if (payload?.code !== 0 || !result || !Array.isArray(result.items) || result.items.length > 20 || !Number.isSafeInteger(result.total) || result.total < result.items.length) throw new ApiError("图片列表响应异常，请重试", 502);
        result.items.forEach((file) => checkedFile(file, projectId, assetId));
        if (new Set(result.items.map((file) => file.id)).size !== result.items.length) throw new ApiError("图片列表响应异常，请重试", 502);
        return result;
    });
}

export async function fetchProductionFileBlob(token: string, projectId: string, assetId: string, file: ProductionFile, download: boolean, signal: AbortSignal) {
    checkedFile(file, projectId, assetId);
    return requestFile(`${base(projectId)}/files/${encodeURIComponent(file.id)}/content${download ? "?download=1" : ""}`, token, signal, async (response) => {
        const mime = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
        const length = response.headers.get("content-length");
        if (response.status !== 200 || mime !== file.mimeType || (length !== null && Number(length) !== file.bytes) || !response.body) {
            await response.body?.cancel();
            throw new ApiError("图片内容与文件信息不符，请重新载入", 502);
        }
        const reader = response.body.getReader();
        const chunks: BlobPart[] = [];
        let bytes = 0;
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                bytes += value.byteLength;
                if (bytes > productionFileLimit || bytes > file.bytes) throw new ApiError("图片超过允许的大小，请重新载入", 502);
                chunks.push(value as BlobPart);
            }
            if (bytes !== file.bytes) throw new ApiError("图片传输不完整，请重试", 502);
            return new Blob(chunks, { type: mime });
        } finally {
            await reader.cancel().catch(() => undefined);
            reader.releaseLock();
        }
    });
}
