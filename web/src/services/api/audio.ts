import axios from "axios";
import { nanoid } from "nanoid";
import { executeParameterTranslation, findParameterTranslation, translationBody, translationHeaders, translationMediaAddress, type TranslationInput } from "./channel-parameter-translation";

import { audioMimeType, isGlmTtsModel, normalizeAudioFormatValue, normalizeAudioSpeedValue, normalizeAudioVoiceValue, normalizeGlmTtsFormat, normalizeGlmTtsSpeed, normalizeGlmTtsVoice } from "@/lib/audio-generation";
import { isAutoDLConfig } from "@/lib/autodl";
import { geminiErrorMessage, isGeminiConfig, isGeminiTtsModel } from "@/lib/gemini";
import { geminiPcmBase64ToWav, normalizeGeminiTtsVoice } from "@/lib/gemini-tts";
import { isGrok2APITtsConfig, normalizeGrokTtsFormat, normalizeGrokTtsLanguage, normalizeGrokTtsSpeed, type GrokTtsVoice } from "@/lib/grok-tts";
import { isMimoPresetTtsModel, isMimoTtsModel, isMimoVoiceCloneModel, isMimoVoiceDesignModel, normalizeMimoTtsFormat, normalizeMimoTtsVoice } from "@/lib/mimo-tts";
import { resolveMediaUrl, uploadMediaFile, uploadRemoteMediaToServer, type UploadedFile } from "@/services/file-storage";
import { autoSyncToCloud } from "@/services/image-storage";
import { channelIdForActiveModel, type AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { ReferenceAudio } from "@/types/media";

export type CanvasAudioTask = {
    id: string;
    status: "queued" | "processing" | "completed" | "failed" | string;
    progress?: number;
    url?: string;
    audio_url?: string;
    storageKey?: string;
    mimeType?: string;
    bytes?: number;
    started_at?: string;
    startedAt?: string;
    created_at?: string;
    createdAt?: string;
    completed_at?: string;
    error?: { message?: string };
    error_detail?: string;
};
export type CanvasAudioTaskOptions = { nodeId?: string; sourceId?: string; clientTaskId?: string };
type GeminiAudioResponse = { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> } }>; error?: { message?: string }; promptFeedback?: { blockReason?: string } };
const grokTtsVoiceRequests = new Map<string, Promise<GrokTtsVoice[]>>();

function aiApiUrl(config: AiConfig, path: string) {
    return `/api/v1${path}`;
}

function aiHeaders(config: AiConfig, contentType = "application/json") {
    const token = useUserStore.getState().token;
    if (!token) throw new Error("请先登录后使用后台模型");
    return { Authorization: `Bearer ${token}`, ...(channelIdForActiveModel(config) ? { "X-Model-Channel-ID": channelIdForActiveModel(config) } : {}), ...(contentType ? { "Content-Type": contentType } : {}) };
}

function refreshRemoteUser(config: AiConfig) {
    void useUserStore.getState().hydrateUser();
}

export function fetchGrokTtsVoices(config: AiConfig, model: string) {
    const token = useUserStore.getState().token;
    if (!token) throw new Error("请先登录后使用后台模型");
    const requestConfig = { ...config, model, audioModel: model };
    const requestKey = `${token}|${aiApiUrl(requestConfig, "/tts/voices")}|${channelIdForActiveModel(requestConfig)}|${model}`;
    const existing = grokTtsVoiceRequests.get(requestKey);
    if (existing) return existing;

    const request = axios
        .get<{ voices?: GrokTtsVoice[] }>(aiApiUrl(requestConfig, "/tts/voices"), { headers: aiHeaders(requestConfig), params: { model } })
        .then((response) => (Array.isArray(response.data.voices) ? response.data.voices.filter((voice) => Boolean(voice.voice_id)) : []))
        .finally(() => grokTtsVoiceRequests.delete(requestKey));
    grokTtsVoiceRequests.set(requestKey, request);
    return request;
}

export async function requestAudioGeneration(config: AiConfig, prompt: string, referenceAudio?: ReferenceAudio): Promise<Blob> {
    const model = (config.model || config.audioModel).trim();
    const translation = await findParameterTranslation({ ...config, model });
    if (translation) {
        const result = await executeParameterTranslation({ ...config, model }, translation, await audioTranslationInput(config, model, prompt, referenceAudio));
        refreshRemoteUser(config);
        const response = await fetch(result.urls[0]);
        if (!response.ok) throw new Error("读取生成音频失败");
        return response.blob();
    }
    assertAudioConfig(config, model);

    try {
        if (isGeminiTtsModel(model) && isGeminiConfig(config, model)) {
            if (referenceAudio) throw new Error("Gemini TTS 不支持参考音频");
            const nativeBody = buildGeminiTtsRequest(config, prompt);
            const body = { model, ...nativeBody };

            const response = await axios.post<GeminiAudioResponse>("/api/v1/audio/speech", body, { headers: aiHeaders(config) });
            refreshRemoteUser(config);
            return decodeGeminiAudio(response.data);
        }

        const format = audioResponseFormat(config, model);
        const body = await buildAudioSpeechRequest(config, model, prompt, referenceAudio);
        const response = await axios.post<Blob>(aiApiUrl(config, "/audio/speech"), body, { headers: aiHeaders(config), responseType: "blob" });
        await assertAudioBlob(response.data);
        refreshRemoteUser(config);
        return response.data.type.startsWith("audio/") ? response.data : new Blob([response.data], { type: audioMimeType(format) });
    } catch (error) {
        throw new Error(readAxiosError(error, "音频生成失败"));
    }
}

export async function storeGeneratedAudio(blob: Blob, format = "mp3"): Promise<UploadedFile> {
    const audio = blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: audioMimeType(format) });
    return uploadMediaFile(audio, "audio");
}

export async function createCanvasAudioTask(config: AiConfig, prompt: string, options: CanvasAudioTaskOptions = {}, referenceAudio?: ReferenceAudio): Promise<CanvasAudioTask> {
    const model = (config.model || config.audioModel).trim();
    const translation = await findParameterTranslation({ ...config, model });
    if (!translation) {
        assertAudioConfig(config, model);

        if (isGeminiTtsModel(model) && isGeminiConfig(config, model)) {
            const blob = await requestAudioGeneration(config, prompt, referenceAudio);
            const format = audioResponseFormat(config, model);
            const stored = await storeGeneratedAudio(blob, format);
            const now = new Date().toISOString();
            return {
                id: options.clientTaskId || `cloud_audio_result_${nanoid()}`,
                status: "completed",
                progress: 100,
                url: stored.url,
                audio_url: stored.url,
                storageKey: stored.storageKey,
                mimeType: stored.mimeType,
                bytes: stored.bytes,
                started_at: now,
                startedAt: now,
                created_at: now,
                createdAt: now,
                completed_at: now,
            };
        }
    }
    const response = await fetch("/api/v1/canvas/audio-tasks", {
        method: "POST",
        headers: translation ? translationHeaders(config, translation) : aiHeaders(config),
        body: JSON.stringify({
            endpoint: "/audio/speech",
            nodeId: options.nodeId || "",
            sourceId: options.sourceId || "",
            clientTaskId: options.clientTaskId || "",
            prompt,
            request: translation ? translationBody({ ...config, model }, await audioTranslationInput(config, model, prompt, referenceAudio)) : await buildAudioSpeechRequest(config, model, prompt, referenceAudio),
        }),
    });
    if (!response.ok) throw new Error(await readFetchError(response, "音频任务创建失败"));
    const payload = (await response.json()) as { code?: number; msg?: string; data?: CanvasAudioTask };
    if (payload.code !== 0 || !payload.data) throw new Error(payload.msg || "音频任务创建失败");
    refreshRemoteUser(config);
    return syncGeneratedAudio(payload.data);
}

async function audioTranslationInput(config: AiConfig, model: string, prompt: string, referenceAudio?: ReferenceAudio): Promise<TranslationInput> {
    const voice =
        isGeminiTtsModel(model) && isGeminiConfig(config, model)
            ? config.geminiTtsVoice
            : isGlmTtsModel(model)
              ? config.glmTtsVoice
              : isMimoTtsModel(model)
                ? config.mimoTtsVoice
                : isGrok2APITtsConfig(config, model)
                  ? config.grokTtsVoice
                  : config.audioVoice;
    const speed = isGlmTtsModel(model) ? config.glmTtsSpeed : isGrok2APITtsConfig(config, model) ? config.grokTtsSpeed : config.audioSpeed;
    return {
        kind: "audio",
        variables: {
            model,
            prompt,
            voice,
            audioFormat: audioResponseFormat(config, model),
            speed: Number(speed),
            instructions: config.audioInstructions,
            audios: referenceAudio ? [await translationMediaAddress(await resolveMediaUrl(referenceAudio.storageKey, referenceAudio.url))] : [],
        },
    };
}

export async function pollCanvasAudioTaskStatus(taskId: string): Promise<CanvasAudioTask> {
    const token = useUserStore.getState().token;
    if (!token) throw new Error("请先登录后再使用云端渠道");
    const response = await fetch(`/api/v1/canvas/audio-tasks/${encodeURIComponent(taskId)}`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(await readFetchError(response, "读取音频任务失败"));
    const payload = (await response.json()) as { code?: number; msg?: string; data?: CanvasAudioTask };
    if (payload.code !== 0 || !payload.data) throw new Error(payload.msg || "读取音频任务失败");
    return syncGeneratedAudio(payload.data);
}

async function syncGeneratedAudio(task: CanvasAudioTask, resultId = task.started_at): Promise<CanvasAudioTask> {
    const url = task.audio_url || task.url || "";
    if (task.status !== "completed" || !url || task.storageKey) return task;
    const media = await autoSyncToCloud(`audio:${task.id}:${resultId}`, () => uploadRemoteMediaToServer(url, "media"));
    return media ? { ...task, url: media.url, audio_url: media.url, storageKey: media.storageKey, bytes: media.bytes, mimeType: media.mimeType } : task;
}

async function buildAudioSpeechRequest(config: AiConfig, model: string, prompt: string, referenceAudio?: ReferenceAudio) {
    if (isAutoDLConfig(config, model)) {
        if (!referenceAudio) throw new Error("请连接并选择参考音频节点");
        const { autoDLReferenceURL } = await import("./reference-url");
        return { model, input: prompt, reference_audio: await autoDLReferenceURL(referenceAudio) };
    }
    if (isGeminiTtsModel(model) && isGeminiConfig(config, model)) {
        if (referenceAudio) throw new Error("Gemini TTS 不支持参考音频");
        return { model, ...buildGeminiTtsRequest(config, prompt) };
    }
    if (isGlmTtsModel(model)) {
        if (prompt.length > 1024) throw new Error("GLM-TTS 文本不能超过 1024 个字符");
        return {
            model,
            input: prompt,
            voice: normalizeGlmTtsVoice(config.glmTtsVoice),
            response_format: normalizeGlmTtsFormat(config.glmTtsFormat),
            speed: Number(normalizeGlmTtsSpeed(config.glmTtsSpeed)),
        };
    }
    if (isMimoTtsModel(model)) {
        const instructions = config.audioInstructions.trim();
        return {
            model,
            input: prompt,
            ...(isMimoPresetTtsModel(model) ? { voice: normalizeMimoTtsVoice(config.mimoTtsVoice) } : {}),
            ...(isMimoVoiceDesignModel(model) ? { mimo_voice_design_prompt: config.mimoVoiceDesignPrompt.trim() } : {}),
            ...(isMimoVoiceCloneModel(model) ? { mimo_voice_clone_audio: await referenceAudioDataUrl(referenceAudio) } : {}),
            ...((isMimoPresetTtsModel(model) || isMimoVoiceCloneModel(model)) && instructions ? { instructions } : {}),
            response_format: normalizeMimoTtsFormat(config.mimoTtsFormat),
        };
    }
    if (isGrok2APITtsConfig(config, model)) {
        return {
            model,
            input: prompt,
            voice_id: config.grokTtsVoice || "eve",
            language: normalizeGrokTtsLanguage(config.grokTtsLanguage),
            output_format: { codec: normalizeGrokTtsFormat(config.grokTtsFormat) },
            speed: Number(normalizeGrokTtsSpeed(config.grokTtsSpeed)),
        };
    }

    const instructions = config.audioInstructions.trim();
    return {
        model,
        input: prompt,
        voice: normalizeAudioVoiceValue(config.audioVoice),
        response_format: normalizeAudioFormatValue(config.audioFormat),
        speed: Number(normalizeAudioSpeedValue(config.audioSpeed)),
        ...(instructions ? { instructions } : {}),
    };
}

function audioResponseFormat(config: AiConfig, model: string) {
    if (isGeminiTtsModel(model) && isGeminiConfig(config, model)) return "wav";
    if (isGlmTtsModel(model)) return normalizeGlmTtsFormat(config.glmTtsFormat);
    if (isMimoTtsModel(model)) return normalizeMimoTtsFormat(config.mimoTtsFormat);
    if (isGrok2APITtsConfig(config, model)) return normalizeGrokTtsFormat(config.grokTtsFormat);
    return normalizeAudioFormatValue(config.audioFormat);
}

function buildGeminiTtsRequest(config: AiConfig, prompt: string) {
    return {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: normalizeGeminiTtsVoice(config.geminiTtsVoice) } } },
        },
    };
}

function decodeGeminiAudio(payload: GeminiAudioResponse) {
    const inlineData = payload.candidates?.flatMap((candidate) => candidate.content?.parts || []).find((part) => Boolean(part.inlineData?.data))?.inlineData;
    if (!inlineData?.data) throw new Error(geminiErrorMessage(payload, "Gemini TTS 没有返回音频数据"));
    return geminiPcmBase64ToWav(inlineData.data);
}

async function referenceAudioDataUrl(referenceAudio?: ReferenceAudio) {
    if (!referenceAudio) throw new Error("请连接并选择参考音频节点");
    const url = await resolveMediaUrl(referenceAudio.storageKey, referenceAudio.url);
    if (!url) throw new Error("参考音频不可用");
    const response = await fetch(url);
    if (!response.ok) throw new Error(`读取参考音频失败（${response.status}）`);
    const blob = await response.blob();
    const mimeType = normalizeCloneMimeType(blob.type) || normalizeCloneMimeType(referenceAudio.type);
    if (!mimeType) throw new Error("参考音频仅支持 MP3 或 WAV");
    const base64 = await blobToBase64(blob);
    if (base64.length > 10 * 1024 * 1024) throw new Error("参考音频 Base64 编码后不能超过 10MB");
    return `data:${mimeType};base64,${base64}`;
}

function normalizeCloneMimeType(value: string) {
    const type = value.trim().toLowerCase().split(";")[0];
    if (type === "audio/mpeg" || type === "audio/mp3") return "audio/mpeg";
    if (type === "audio/wav" || type === "audio/x-wav" || type === "audio/wave") return "audio/wav";
    return "";
}

function blobToBase64(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("读取参考音频失败"));
        reader.onload = () => {
            const value = typeof reader.result === "string" ? reader.result : "";
            const separator = value.indexOf(",");
            resolve(separator >= 0 ? value.slice(separator + 1) : value);
        };
        reader.readAsDataURL(blob);
    });
}

function assertAudioConfig(config: AiConfig, model: string) {
    if (!model) throw new Error("请先选择后台开放的音频模型");
    if (!useUserStore.getState().token) throw new Error("请先登录后使用后台模型");
}

async function assertAudioBlob(blob: Blob) {
    if (!blob.type.includes("json")) return;
    let payload: { code?: number; msg?: string; error?: { message?: string } };
    try {
        payload = JSON.parse(await blob.text()) as { code?: number; msg?: string; error?: { message?: string } };
    } catch {
        return;
    }
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(payload.msg || "音频生成失败");
    if (payload.error?.message) throw new Error(payload.error.message);
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; code?: number }>(error)) {
        const responseData = error.response?.data;
        return responseData?.msg || responseData?.error?.message || statusMessage(error.response?.status, fallback);
    }
    return error instanceof Error ? error.message : fallback;
}

async function readFetchError(response: Response, fallback: string) {
    try {
        const payload = (await response.json()) as { msg?: string; error?: { message?: string } };
        return payload.msg || payload.error?.message || statusMessage(response.status, fallback);
    } catch {
        return statusMessage(response.status, fallback);
    }
}

function statusMessage(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return "鉴权失败，请检查 API Key、套餐权限或模型权限";
    if (status === 429) return "请求被限流或额度不足，请稍后重试";
    return status ? `${fallback}（${status}）` : fallback;
}
