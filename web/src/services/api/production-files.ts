import { ApiError } from "./request";

export const productionFileLimit = 20 * 1024 * 1024;
const imageTypes = ["image/png", "image/jpeg", "image/webp"];
export type ProductionFile = { id: string; projectId: string; assetId: string; name: string; mimeType: string; bytes: number; createdAt: string };
export type ProductionFileList = { items: ProductionFile[]; total: number };
export type ProductionFileUploadReceipt = { requestId: string; file: ProductionFile };
export type ProductionFileUploadRequest = { requestId: string; projectId: string; assetId: string; name: string; bytes: number };
const base = (projectId: string) => `/api/v1/production/projects/${encodeURIComponent(projectId)}`;
const uploadID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function productionImageError(file: Pick<File, "name" | "size" | "type">): string {
    const name = file.name.trim();
    if (!name || Array.from(name).length > 180 || /[\\/\u0000-\u001f\u007f-\u009f]/.test(file.name)) return "图片名称须为 1–180 个字，不能包含路径或控制字符";
    const extension = name.split(".").pop()?.toLowerCase();
    const mime = extension === "png" ? "image/png" : extension === "jpg" || extension === "jpeg" ? "image/jpeg" : extension === "webp" ? "image/webp" : "";
    if (!mime || (file.type && file.type.toLowerCase() !== mime)) return "请选择 PNG、JPEG 或 WebP 图片，文件扩展名需与图片格式一致";
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > productionFileLimit) return "请选择大于 0 且不超过 20 MB 的图片";
    return "";
}

export function validProductionUpload(value: unknown, projectId: string, assetId: string): value is ProductionFileUploadRequest {
    if (!value || typeof value !== "object") return false;
    const request = value as ProductionFileUploadRequest;
    return typeof request.requestId === "string" && uploadID.test(request.requestId) && typeof request.projectId === "string" && Boolean(request.projectId) && typeof request.assetId === "string" && Boolean(request.assetId) && request.projectId === projectId && request.assetId === assetId
        && typeof request.name === "string" && request.name === request.name.trim() && !productionImageError({ name: request.name, size: request.bytes, type: "" });
}

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

export async function fetchProductionFile(token: string, projectId: string, assetId: string, fileId: string, signal: AbortSignal) {
    return requestFile(`${base(projectId)}/files/${encodeURIComponent(fileId)}`, token, signal, async (response) => {
        const payload = await response.json() as { code: number; data: ProductionFile };
        if (payload?.code !== 0 || payload.data?.id !== fileId) throw new ApiError("文件信息异常，请重新载入图片", 502);
        return checkedFile(payload.data, projectId, assetId);
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

async function requestUpload(token: string, request: ProductionFileUploadRequest, signal: AbortSignal, file?: File) {
    if (!validProductionUpload(request, request.projectId, request.assetId)) throw new ApiError("上传确认信息无效，请重新选择图片", 400);
    if (file && (productionImageError(file) || file.name.trim() !== request.name || file.size !== request.bytes)) throw new ApiError("请选择原来同名、同大小的图片，再重试确认", 400);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) controller.abort();
    const timer = setTimeout(abort, 60_000);
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    let body: FormData | undefined;
    if (file) {
        headers["X-Upload-Request-Id"] = request.requestId;
        body = new FormData();
        body.append("file", file, request.name);
    }
    const path = `${base(request.projectId)}/assets/${encodeURIComponent(request.assetId)}`;
    try {
        const response = await fetch(file ? `${path}/files` : `${path}/file-uploads/${encodeURIComponent(request.requestId)}`, { method: file ? "POST" : "GET", body, headers, cache: "no-store", redirect: "error", signal: controller.signal });
        const payload = await response.json().catch(() => null) as { code?: number; msg?: string; data?: ProductionFileUploadReceipt } | null;
        if (!response.ok) {
            const fallback = response.status === 401 ? "登录已失效，请重新登录" : response.status === 429 ? "当前上传较多，请稍后使用原请求重试" : response.status === 409 ? "这次上传与原请求不一致，请选择原图片后重试" : "图片上传未能确认，请稍后重试";
            throw new ApiError(typeof payload?.msg === "string" && payload.msg.length <= 240 ? payload.msg : fallback, response.status);
        }
        const receipt = payload?.data;
        if (response.status !== 200 || payload?.code !== 0 || !receipt || receipt.requestId !== request.requestId) throw new ApiError("上传回执异常，请使用原请求重试确认", 502);
        checkedFile(receipt.file, request.projectId, request.assetId);
        if (receipt.file.name !== request.name || receipt.file.bytes !== request.bytes) throw new ApiError("上传回执与原图片不符，请使用原请求重试确认", 502);
        return receipt;
    } catch (error) {
        if (signal.aborted) throw new DOMException("请求已取消", "AbortError");
        if (error instanceof ApiError) throw error;
        throw new ApiError(controller.signal.aborted ? "上传确认超时，请使用原请求重试确认" : "连接中断，上传结果尚未确认，请使用原请求重试确认", 0);
    } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
    }
}

export const uploadProductionFile = (token: string, request: ProductionFileUploadRequest, file: File, signal: AbortSignal) => requestUpload(token, request, signal, file);
export const fetchProductionFileUpload = (token: string, request: ProductionFileUploadRequest, signal: AbortSignal) => requestUpload(token, request, signal);
