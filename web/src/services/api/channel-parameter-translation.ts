import { type TranslationVariables } from "@/lib/channel-parameter-translation";
import { readFileAsDataUrl } from "@/lib/image-utils";
import { channelIdForActiveModel, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

export type TranslationInput = { kind: "image" | "video" | "audio"; variables: TranslationVariables };
export type MatchedTranslation = { channelId: string; timeout: number };
export type TranslationResult = { status: string; progress: number; taskIds?: string[]; urls: string[]; storageKey?: string; responseBody?: unknown };

export async function findParameterTranslation(config: AiConfig): Promise<MatchedTranslation | null> {
    const channelId = channelIdForActiveModel(config);
    if (!channelId) return null;
    const channel = config.publicChannels.find((item) => item.id === channelId);
    return channel?.parameterTranslationModels?.includes(config.model) ? { channelId, timeout: channel.timeout || 600 } : null;
}

export function translationHeaders(config: AiConfig, match: MatchedTranslation): Record<string, string> {
    const token = useUserStore.getState().token;
    if (!token) throw new Error("请先登录后再使用账号渠道");
    return { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Model-Channel-ID": match.channelId };
}

export function translationBody(config: AiConfig, input: TranslationInput) {
    return { model: config.model, n: input.variables.count || 1, ...(input.kind === "video" ? { seconds: input.variables.seconds } : {}), _parameterTranslation: input };
}

export function translationMediaURLs(value: unknown, kind: TranslationInput["kind"], mimeType = `${kind}/${kind === "image" ? "png" : kind === "video" ? "mp4" : "mpeg"}`, depth = 0): string[] {
    if (depth > 8 || value == null) return [];
    if (typeof value === "string") {
        const text = value.trim();
        if (/^https?:\/\//i.test(text) || text.startsWith(`data:${kind}/`)) return [text];
        if (text && mimeType.startsWith(`${kind}/`)) {
            try {
                atob(text);
                return [`data:${mimeType.split(";")[0]};base64,${text}`];
            } catch {}
        }
        return [];
    }
    if (Array.isArray(value)) return value.flatMap((item) => translationMediaURLs(item, kind, mimeType, depth + 1));
    if (typeof value !== "object") return [];
    const object = value as Record<string, unknown>;
    const mime = typeof object.mime_type === "string" ? object.mime_type : typeof object.mimeType === "string" ? object.mimeType : mimeType;
    return ["url", "uri", "download_url", "image_url", "video_url", "audio_url", "images", "videos", "audios", "data", "outputs", "results", "result", "b64_json", "base64"].flatMap((key) => translationMediaURLs(object[key], kind, mime, depth + 1));
}

export async function executeParameterTranslation(config: AiConfig, match: MatchedTranslation, input: TranslationInput): Promise<TranslationResult> {
    const endpoint = input.kind === "audio" ? "/audio/speech" : Array.isArray(input.variables.images) && input.variables.images.length ? "/images/edits" : "/images/generations";
    const response = await fetch(`/api/v1${endpoint}`, { method: "POST", headers: translationHeaders(config, match), body: JSON.stringify(translationBody(config, input)), signal: AbortSignal.timeout(match.timeout * 1000) });
    const data = response.headers.get("Content-Type")?.includes("json") ? await response.json() : await response.blob();
    if (!response.ok || (data.code && data.code !== 0)) throw new Error(data.msg || data.error?.message || `请求失败（${response.status}）`);
    const urls = data instanceof Blob ? [await readFileAsDataUrl(new File([data], "media", { type: data.type }))] : translationMediaURLs(data, input.kind);
    if (!urls.length) throw new Error("接口没有返回可用媒体结果");
    return { status: "completed", progress: 100, urls };
}

export async function translationMediaAddress(url: string): Promise<string> {
    if (!url) throw new Error("参考素材不可用");
    if (url.startsWith("data:")) return url;
    if (/^https?:\/\//i.test(url) && new URL(url).origin !== location.origin && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)) return url;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`读取参考素材失败（${response.status}）`);
    const blob = await response.blob();
    return readFileAsDataUrl(new File([blob], "reference", { type: blob.type }));
}
