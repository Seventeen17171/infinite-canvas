"use client";

import { useMemo } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { isWorkflowProtocol, type ModelChannelProtocol } from "@/lib/model-channel";
import type { WorkflowRef, WorkflowSummary } from "@/lib/workflow-channel";
import { apiGet } from "@/services/api/request";
import type { AdminPublicSettings } from "@/services/api/admin";
import { useUserStore } from "@/stores/use-user-store";

export type PublicModelChannel = {
    id?: string;
    protocol?: ModelChannelProtocol;
    name?: string;
    models?: string[];
    modelCapabilities?: ModelCapabilities;
    parameterTranslationModels?: string[];
    workflows?: WorkflowSummary[];
    weight?: number;
    timeout?: number;
    enabled?: boolean;
    remark?: string;
};

export type VideoMultiPromptItem = { prompt: string; duration: string };
export type VideoElementReference = { id: string; kind: "image" | "video" | "audio"; name: string; type: string; dataUrl?: string; url?: string; storageKey?: string; bytes?: number; width?: number; height?: number; durationMs?: number };
export type VideoElementItem = { name: string; description: string; references: VideoElementReference[] };

export type AiConfig = {
    model: string;
    imageModel: string;
    videoModel: string;
    textModel: string;
    audioModel: string;
    imageWorkflowRef?: WorkflowRef;
    videoWorkflowRef?: WorkflowRef;
    audioWorkflowRef?: WorkflowRef;
    audioVoice: string;
    audioFormat: string;
    audioSpeed: string;
    audioInstructions: string;
    grokTtsVoice: string;
    grokTtsLanguage: string;
    grokTtsFormat: string;
    grokTtsSpeed: string;
    glmTtsVoice: string;
    glmTtsFormat: string;
    glmTtsSpeed: string;
    mimoTtsVoice: string;
    mimoTtsFormat: string;
    mimoVoiceDesignPrompt: string;
    geminiTtsVoice: string;
    videoSeconds: string;
    videoMode: string;
    videoNegativePrompt: string;
    videoMultiShot: string;
    videoShotType: string;
    videoMultiPrompt: VideoMultiPromptItem[];
    videoElementList: VideoElementItem[];
    vquality: string;
    videoGenerateAudio: string;
    videoWatermark: string;
    videoCharacterOrientation: string;
    systemPrompt: string;
    models: string[];
    imageModels: string[];
    videoModels: string[];
    textModels: string[];
    audioModels: string[];
    quality: string;
    size: string;
    videoSize: string;
    count: string;
    canvasImageCount: string;
    timeout: string;
    apiMode: string;
    streamImages: string;
    streamPartialImages: string;
    responseFormatB64Json: string;
    systemPrompts: {
        image: string;
        video: string;
        text: string;
        workflow: string;
        workflowAgent: string;
    };
    publicChannels: PublicModelChannel[];
    syncStorageConfig: boolean;
    syncWebDAVStorageConfig: boolean;
    activeChannelId: string;
    imageChannelId: string;
    videoChannelId: string;
    textChannelId: string;
    audioChannelId: string;
};

export const CONFIG_STORE_KEY = "infinite-canvas:ai_config_store";
export type ModelCapability = "image" | "video" | "text" | "audio";
export type ModelCapabilities = Partial<Record<string, ModelCapability>>;

export const defaultConfig: AiConfig = {
    model: "",
    imageModel: "",
    videoModel: "",
    textModel: "",
    audioModel: "",
    audioVoice: "alloy",
    audioFormat: "mp3",
    audioSpeed: "1",
    audioInstructions: "",
    grokTtsVoice: "eve",
    grokTtsLanguage: "auto",
    grokTtsFormat: "mp3",
    grokTtsSpeed: "1",
    glmTtsVoice: "tongtong",
    glmTtsFormat: "wav",
    glmTtsSpeed: "1",
    mimoTtsVoice: "冰糖",
    mimoTtsFormat: "wav",
    mimoVoiceDesignPrompt: "",
    geminiTtsVoice: "Kore",
    videoSeconds: "6",
    videoMode: "std",
    videoNegativePrompt: "",
    videoMultiShot: "false",
    videoShotType: "intelligence",
    videoMultiPrompt: [{ prompt: "", duration: "1" }],
    videoElementList: [{ name: "", description: "", references: [] }],
    vquality: "720",
    videoGenerateAudio: "true",
    videoWatermark: "false",
    videoCharacterOrientation: "video",
    systemPrompt: "",
    models: [],
    imageModels: [],
    videoModels: [],
    textModels: [],
    audioModels: [],
    quality: "auto",
    size: "1:1",
    videoSize: "1280x720",
    count: "1",
    canvasImageCount: "1",
    timeout: "600",
    apiMode: "images",
    streamImages: "",
    streamPartialImages: "1",
    responseFormatB64Json: "",
    systemPrompts: {
        image: "",
        video: "",
        text: "",
        workflow: "",
        workflowAgent: "",
    },
    publicChannels: [],
    syncStorageConfig: false,
    syncWebDAVStorageConfig: false,
    activeChannelId: "",
    imageChannelId: "",
    videoChannelId: "",
    textChannelId: "",
    audioChannelId: "",
};

type ConfigStore = {
    config: AiConfig;
    publicSettings: AdminPublicSettings | null;
    isPublicSettingsLoading: boolean;
    isConfigOpen: boolean;
    shouldPromptContinue: boolean;
    updateConfig: <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
    loadPublicSettings: () => Promise<void>;
    isAiConfigReady: (config: AiConfig, model: string) => boolean;
    openConfigDialog: (shouldPromptContinue?: boolean) => void;
    setConfigDialogOpen: (isOpen: boolean) => void;
    clearPromptContinue: () => void;
};

export function resolveEffectiveConfig(config: AiConfig, modelChannel: AdminPublicSettings["modelChannel"] | null, isLoggedIn: boolean): AiConfig {
    const channels = isLoggedIn && modelChannel ? modelChannel.channels.filter((channel) => channel.enabled !== false) : [];
    const channelModels = new Set(channels.flatMap((channel) => channel.models || []));
    const models = normalizeModelList(isLoggedIn && modelChannel ? modelChannel.availableModels : []).filter((model) => channelModels.has(model));
    modelChannel = modelChannel || { channels: [], availableModels: [], availableWorkflows: [], modelCosts: [], defaultModel: "", defaultTextModel: "", defaultImageModel: "", defaultVideoModel: "", systemPrompt: "", systemPrompts: { ...defaultConfig.systemPrompts } };
    const textModels = filterChannelModelsByCapability(channels, "text", models);
    const imageModels = filterChannelModelsByCapability(channels, "image", models);
    const videoModels = filterChannelModelsByCapability(channels, "video", models);
    const audioModels = filterChannelModelsByCapability(channels, "audio", models);
    const fallbackTextModel = validDefault(modelChannel.defaultTextModel, textModels) || preferredModel(textModels, isTextModelName) || textModels[0] || "";
    const fallbackModel = validDefault(modelChannel.defaultModel, textModels) || fallbackTextModel;
    const fallbackImageModel = validDefault(modelChannel.defaultImageModel, imageModels) || preferredModel(imageModels, isImageModelName) || imageModels[0] || "";
    const fallbackVideoModel = validDefault(modelChannel.defaultVideoModel, videoModels) || preferredModel(videoModels, isVideoModelName) || videoModels[0] || "";
    const fallbackAudioModel = preferredModel(audioModels, isAudioModelName) || audioModels[0] || "";
    return {
        ...config,
        models,
        imageModels,
        videoModels,
        textModels,
        audioModels,
        model: textModels.includes(config.model) ? config.model : fallbackModel,
        imageModel: imageModels.includes(config.imageModel) ? config.imageModel : fallbackImageModel,
        videoModel: videoModels.includes(config.videoModel) ? config.videoModel : fallbackVideoModel,
        textModel: textModels.includes(config.textModel) ? config.textModel : fallbackTextModel || fallbackModel,
        audioModel: audioModels.includes(config.audioModel) ? config.audioModel : fallbackAudioModel,
        systemPrompt: modelChannel.systemPrompt,
        publicChannels: channels.map((channel) => ({ ...channel, models: (channel.models || []).filter((model) => models.includes(model)) })),
    };
}

function validDefault(model: string, models: string[]) {
    return models.includes(model) ? model : "";
}

function preferredModel(models: string[], predicate: (model: string) => boolean) {
    return models.find(predicate) || "";
}

function isVideoModelName(model: string) {
    const value = model.toLowerCase();
    return (
        value === "wan2.2animate-v4-motion_retargeting" ||
        value.includes("video") ||
        value.includes("seedance") ||
        value.includes("sora") ||
        value.includes("veo") ||
        value.includes("kling") ||
        value.includes("hailuo") ||
        value.includes("minimax-h3") ||
        value.includes("skyreels") ||
        value.includes("happyhorse") ||
        value.includes("runway") ||
        value.includes("aleph") ||
        value.includes("vidu") ||
        value.includes("pixverse") ||
        value.includes("omni-flash") ||
        value.includes("gemini-omni-video") ||
        value.includes("veo3.1") ||
        value.includes("veo-3.1") ||
        value.includes("infinitalk") ||
        value.includes("wan2-5") ||
        value.includes("wan2.5") ||
        value.includes("wan2-6") ||
        value.includes("wan2.6") ||
        value.includes("wan2-7") ||
        value.includes("wan2.7") ||
        value.includes("wan2-7-r2v") ||
        value.includes("wan2.7-r2v") ||
        value.includes("wan2-7-videoedit") ||
        value.includes("wan2.7-videoedit") ||
        value.includes("wan/2-5") ||
        value.includes("wan/2-6") ||
        value.includes("wan/2-7-text-to-video") ||
        value.includes("wan/2-7-image-to-video") ||
        value.includes("wan/2-7-videoedit") ||
        value.includes("wan/2-7-r2v") ||
        (value.includes("sd") && !value.includes("sdxl")) ||
        (value.includes("grok-imagine") && (value.includes("/upscale") || value.includes("/extend")))
    );
}

function isImageModelName(model: string) {
    const value = model.toLowerCase();
    return !isVideoModelName(model) && !isAudioModelName(model) && (
        value.includes("image") ||
        value.includes("nano-banana") ||
        value.includes("seedream") ||
        value.includes("gpt-image") ||
        value.includes("cogview") ||
        value.includes("dall-e") ||
        value.includes("dalle") ||
        value.includes("imagen") ||
        value.includes("gemini-2.5-flash") ||
        value.includes("gemini-3-pro") ||
        value.includes("gemini-3.1-flash") ||
        value.includes("flux") ||
        value.includes("kontext") ||
        value.includes("4o-image") ||
        value.includes("4o image") ||
        value.includes("gpt-4o-image") ||
        value.includes("z-image") ||
        value.includes("qwen/image") ||
        value.includes("qwen2/image") ||
        value.includes("qwen/text-to-image") ||
        value.includes("qwen2/text-to-image") ||
        value.includes("ideogram") ||
        value.includes("recraft") ||
        value.includes("sdxl") ||
        value.includes("stable-diffusion") ||
        value.includes("midjourney") ||
        value.includes("wan2-7-image") ||
        value.includes("wan2.7-image") ||
        value.includes("wan/2-7-image") ||
        value.includes("topaz/image") ||
        value.includes("gemini-omni-character") ||
        (value.includes("grok-imagine") && !value.includes("video"))
    );
}

function isAudioModelName(model: string) {
    const value = model.toLowerCase();
    return value.includes("audio") || value.includes("tts") || value.includes("speech") || value.includes("voice") || value.includes("music") || value.includes("sound") || value.includes("elevenlabs") || value.includes("suno") || value.includes("lyrics") || value.includes("vocal") || value.includes("midi") || value.includes("wav");
}

function isTextModelName(model: string) {
    return !isImageModelName(model) && !isVideoModelName(model) && !isAudioModelName(model);
}

export function modelMatchesCapability(model: string, capability?: ModelCapability, protocol = "", modelCapabilities: ModelCapabilities = {}) {
    if (!capability) return true;
    if (Object.hasOwn(modelCapabilities, model)) return modelCapabilities[model] === capability;
    if (protocol === "autodl") {
        if (capability === "audio") return model === "indextts2-v1";
        return capability === "video" && (model.startsWith("minimax_h3_") || model === "wan2.2animate-v4-motion_retargeting");
    }
    if (protocol === "gemini") {
        const value = model.toLowerCase();
        const video = /^models\/veo-|^veo-/.test(value);
        const audio = value.includes("tts");
        const image = !video && !audio && value.includes("image");
        if (capability === "video") return video;
        if (capability === "audio") return audio;
        if (capability === "image") return image;
        return !video && !audio && !image;
    }
    if (capability === "image") return isImageModelName(model);
    if (capability === "video") return isVideoModelName(model);
    if (capability === "audio") return isAudioModelName(model);
    return isTextModelName(model);
}

export function filterModelsByCapability(models: string[], capability?: ModelCapability, protocol = "", modelCapabilities: ModelCapabilities = {}) {
    return capability ? models.filter((model) => modelMatchesCapability(model, capability, protocol, modelCapabilities)) : models;
}

export function filterChannelModelsByCapability(channels: Array<{ protocol?: ModelChannelProtocol; models: string[]; modelCapabilities?: ModelCapabilities }>, capability: ModelCapability, allowedModels?: string[]) {
    const allowed = allowedModels ? new Set(allowedModels) : null;
    return normalizeModelList(channels.flatMap((channel) => isWorkflowProtocol(channel.protocol || "") ? [] : filterModelsByCapability(channel.models, capability, channel.protocol || "", channel.modelCapabilities))).filter((model) => !allowed || allowed.has(model));
}

export function selectableModelsByCapability(config: AiConfig, capability?: ModelCapability) {
    if (!capability) return config.models;
    const channels = config.publicChannels.map((channel) => ({ ...channel, models: channel.models || [] }));
    return filterChannelModelsByCapability(channels, capability, config.models);
}

export function resolveModelForCapability(config: AiConfig, currentModel: string | undefined, capability: ModelCapability) {
    const configuredModel = capability === "image" ? config.imageModel : capability === "video" ? config.videoModel : capability === "audio" ? config.audioModel : config.textModel;
    const selectableModels = selectableModelsByCapability(config, capability);
    if (currentModel && selectableModels.includes(currentModel)) return currentModel;
    if (selectableModels.includes(configuredModel)) return configuredModel;
    return selectableModels[0] || "";
}

function isAiConfigReady(config: AiConfig, model: string) {
    const { token, user } = useUserStore.getState();
    return Boolean(token && user && model.trim() && config.models.includes(model) && modelChannelForActiveModel({ ...config, model }));
}

const serverConfigKeys = new Set(["models", "imageModels", "videoModels", "textModels", "audioModels", "publicChannels", "systemPrompt"]);

// Only explicit preference fields survive browser persistence; retired model credentials are never restored.
export function sanitizeConfigPreferences(value: unknown): Partial<AiConfig> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const input = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, defaultValue] of Object.entries(defaultConfig)) {
        if (serverConfigKeys.has(key)) continue;
        if (typeof defaultValue === "string" && typeof input[key] === "string") result[key] = input[key];
        if (typeof defaultValue === "boolean" && typeof input[key] === "boolean") result[key] = input[key];
    }
    const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const strings = (value: unknown, keys: string[]) => {
        const item = object(value);
        return Object.fromEntries(keys.filter((key) => typeof item[key] === "string").map((key) => [key, item[key]]));
    };
    if (input.systemPrompts) result.systemPrompts = { ...defaultConfig.systemPrompts, ...strings(input.systemPrompts, Object.keys(defaultConfig.systemPrompts)) };
    if (Array.isArray(input.videoMultiPrompt)) result.videoMultiPrompt = input.videoMultiPrompt.map((item) => ({ prompt: "", duration: "1", ...strings(item, ["prompt", "duration"]) }));
    if (Array.isArray(input.videoElementList)) result.videoElementList = input.videoElementList.map((item) => ({
        name: "", description: "", ...strings(item, ["name", "description"]),
        references: Array.isArray(object(item).references) ? (object(item).references as unknown[]).flatMap((value) => {
            const ref = object(value);
            if (typeof ref.id !== "string" || !["image", "video", "audio"].includes(String(ref.kind))) return [];
            return [{ ...strings(ref, ["id", "kind", "name", "type", "dataUrl", "url", "storageKey"]), ...Object.fromEntries(["bytes", "width", "height", "durationMs"].filter((key) => typeof ref[key] === "number" && Number.isFinite(ref[key])).map((key) => [key, ref[key]])) }];
        }) : [],
    }));
    for (const key of ["imageWorkflowRef", "videoWorkflowRef", "audioWorkflowRef"]) {
        const ref = object(input[key]);
        if (ref.scope === "system" && typeof ref.channelId === "string" && typeof ref.workflowId === "string" && ["app", "workflow"].includes(String(ref.kind))) result[key] = { scope: "system", ...strings(ref, ["channelId", "workflowId", "kind"]) };
    }
    return result as Partial<AiConfig>;
}

export const useConfigStore = create<ConfigStore>()(
    persist(
        (set, get) => ({
            config: defaultConfig,
            publicSettings: null,
            isPublicSettingsLoading: false,
            isConfigOpen: false,
            shouldPromptContinue: false,
            updateConfig: (key, value) =>
                set((state) => ({
                    config: {
                        ...state.config,
                        ...sanitizeConfigPreferences({ [key]: value }),
                        ...(["imageWorkflowRef", "videoWorkflowRef", "audioWorkflowRef"].includes(key) && value === undefined ? { [key]: undefined } : {}),
                    },
                })),
            loadPublicSettings: async () => {
                if (get().isPublicSettingsLoading) return;
                set({ isPublicSettingsLoading: true });
                try {
                    set({ publicSettings: await apiGet<AdminPublicSettings>("/api/settings") });
                } catch {
                    set({ publicSettings: null });
                } finally {
                    set({ isPublicSettingsLoading: false });
                }
            },
            isAiConfigReady: (config, model) => isAiConfigReady(config, model),
            openConfigDialog: (shouldPromptContinue = false) => set({ isConfigOpen: true, shouldPromptContinue }),
            setConfigDialogOpen: (isConfigOpen) => set({ isConfigOpen }),
            clearPromptContinue: () => set({ shouldPromptContinue: false }),
        }),
        {
            name: CONFIG_STORE_KEY,
            partialize: (state) => ({ config: sanitizeConfigPreferences(state.config) }),
            merge: (persisted, current) => ({
                ...current,
                config: { ...defaultConfig, ...sanitizeConfigPreferences((persisted as Partial<ConfigStore> | null)?.config) },
            }),
        },
    ),
);

function normalizeModelList(models: string[]) {
    return Array.from(new Set((models || []).map((model) => model.trim()).filter(Boolean)));
}

export function useEffectiveConfig() {
    const config = useConfigStore((state) => state.config);
    const modelChannel = useConfigStore((state) => state.publicSettings?.modelChannel || null);
    const token = useUserStore((state) => state.token);
    const user = useUserStore((state) => state.user);
    const isLoggedIn = Boolean(token && user);
    return useMemo(() => resolveEffectiveConfig(config, modelChannel, isLoggedIn), [isLoggedIn, config, modelChannel]);
}

export function channelIdForActiveModel(config: AiConfig) {
    const channels = config.publicChannels.filter((channel) => channel.enabled !== false && !isWorkflowProtocol(channel.protocol || "") && channel.models?.includes(config.model));
    const selectedId = config.model === config.imageModel ? config.imageChannelId : config.model === config.videoModel ? config.videoChannelId : config.model === config.audioModel ? config.audioChannelId : config.textChannelId;
    return channels.find((channel) => channel.id === config.activeChannelId)?.id || channels.find((channel) => channel.id === selectedId)?.id || channels[0]?.id || "";
}

export function modelChannelForActiveModel(config: AiConfig) {
    const channelId = channelIdForActiveModel(config);
    return config.publicChannels.find((channel) => channel.id === channelId && channel.enabled !== false && channel.models?.includes(config.model));
}

export function channelProtocolForConfig(config: AiConfig): ModelChannelProtocol {
    return modelChannelForActiveModel(config)?.protocol || "openai";
}
