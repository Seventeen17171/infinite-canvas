"use client";

import { App, Button, Form, Input, Modal, Select, Switch } from "antd";
import { useEffect, useRef, useState } from "react";

import { GrokTtsVoiceSelect } from "@/components/grok-tts-voice-select";
import { ModelPicker } from "@/components/model-picker";
import { fetchUserConfig, measureUserStorageProvider, syncUserStorageProvider } from "@/services/api/user-config";
import { clearStorageConfigCache as clearFileStorageCache } from "@/services/file-storage";
import { clearStorageConfigCache as clearImageStorageCache, defaultUserStorageProvider, defaultUserWebDAVStorageProvider, loadStorageConfig, loadUserS3StorageProvider, loadUserWebDAVStorageProvider, saveUserStorageProvider, saveUserWebDAVStorageProvider, type UserStorageProvider } from "@/services/image-storage";
import { audioFormatOptions, audioVoiceOptions, glmTtsFormatOptions, glmTtsVoiceOptions, isGlmTtsModel, normalizeAudioSpeedValue, normalizeGlmTtsFormat, normalizeGlmTtsSpeed, normalizeGlmTtsVoice } from "@/lib/audio-generation";
import { grokTtsFormatOptions, grokTtsLanguageOptions, isGrok2APITtsConfig, normalizeGrokTtsFormat, normalizeGrokTtsLanguage, normalizeGrokTtsSpeed } from "@/lib/grok-tts";
import { isGeminiConfig, isGeminiTtsModel } from "@/lib/gemini";
import { geminiTtsVoiceOptions, normalizeGeminiTtsVoice } from "@/lib/gemini-tts";
import { isMimoPresetTtsModel, isMimoTtsModel, isMimoVoiceCloneModel, isMimoVoiceDesignModel, mimoTtsFormatOptions, mimoTtsVoiceOptions } from "@/lib/mimo-tts";
import { useConfigStore, useEffectiveConfig, type ModelCapability } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

type ModelGroup = {
    capability: ModelCapability;
    modelKey: "imageModel" | "videoModel" | "textModel" | "audioModel";
    workflowKey?: "imageWorkflowRef" | "videoWorkflowRef" | "audioWorkflowRef";
    channelKey: "imageChannelId" | "videoChannelId" | "textChannelId" | "audioChannelId";
    modelsKey: "imageModels" | "videoModels" | "textModels" | "audioModels";
    defaultLabel: string;
    optionsLabel: string;
};

const modelGroups: ModelGroup[] = [
    { capability: "image", modelKey: "imageModel", workflowKey: "imageWorkflowRef", channelKey: "imageChannelId", modelsKey: "imageModels", defaultLabel: "默认生图模型", optionsLabel: "生图模型可选项" },
    { capability: "video", modelKey: "videoModel", workflowKey: "videoWorkflowRef", channelKey: "videoChannelId", modelsKey: "videoModels", defaultLabel: "默认视频模型", optionsLabel: "视频模型可选项" },
    { capability: "text", modelKey: "textModel", channelKey: "textChannelId", modelsKey: "textModels", defaultLabel: "默认文本模型", optionsLabel: "文本模型可选项" },
    { capability: "audio", modelKey: "audioModel", workflowKey: "audioWorkflowRef", channelKey: "audioChannelId", modelsKey: "audioModels", defaultLabel: "默认音频模型", optionsLabel: "音频模型可选项" },
];

export function AppConfigModal() {
    const { message } = App.useApp();
    const [savingConfig, setSavingConfig] = useState(false);
    const accountConfigRef = useRef(false);
    const [remoteStorageSyncEnabled, setRemoteStorageSyncEnabled] = useState(false);
    const [remoteWebDAVStorageSyncEnabled, setRemoteWebDAVStorageSyncEnabled] = useState(false);
    const [allowUserStorageProvider, setAllowUserStorageProvider] = useState(false);
    const [userStorage, setUserStorage] = useState(() => defaultUserStorageProvider());
    const [userWebDAVStorage, setUserWebDAVStorage] = useState(() => defaultUserWebDAVStorageProvider());
    const [measuringStorageType, setMeasuringStorageType] = useState<"s3" | "webdav" | null>(null);
    const [storageUsageText, setStorageUsageText] = useState("");
    const [webDAVStorageUsageText, setWebDAVStorageUsageText] = useState("");
    const config = useConfigStore((state) => state.config);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isConfigOpen = useConfigStore((state) => state.isConfigOpen);
    const shouldPromptContinue = useConfigStore((state) => state.shouldPromptContinue);
    const setConfigDialogOpen = useConfigStore((state) => state.setConfigDialogOpen);
    const clearPromptContinue = useConfigStore((state) => state.clearPromptContinue);
    const isSettingsLoading = useConfigStore((state) => state.isPublicSettingsLoading);
    const token = useUserStore((state) => state.token);
    const user = useUserStore((state) => state.user);
    const modelConfig = useEffectiveConfig();
    const canUseUserStorageProvider = allowUserStorageProvider;
    const glmTts = isGlmTtsModel(modelConfig.audioModel);
    const audioConfig = { ...modelConfig, model: modelConfig.audioModel, activeChannelId: modelConfig.audioChannelId };
    const grokTts = isGrok2APITtsConfig(audioConfig, modelConfig.audioModel);
    const geminiTts = isGeminiTtsModel(modelConfig.audioModel) && isGeminiConfig(audioConfig, modelConfig.audioModel);

    useEffect(() => {
        setUserStorage(loadUserS3StorageProvider() || defaultUserStorageProvider());
        setUserWebDAVStorage(loadUserWebDAVStorageProvider() || defaultUserWebDAVStorageProvider());
        accountConfigRef.current = false;
        if (!isConfigOpen || !token || !user?.id) return;
        const accountToken = token;
        const accountId = user.id;
        let canceled = false;
        void fetchUserConfig(accountToken).then((payload) => {
            if (canceled || useUserStore.getState().token !== accountToken || useUserStore.getState().user?.id !== accountId) return;
            const syncS3 = payload.storageSync?.s3 === true;
            const syncWebDAV = payload.storageSync?.webdav === true;
            setRemoteStorageSyncEnabled(syncS3);
            setRemoteWebDAVStorageSyncEnabled(syncWebDAV);
            updateConfig("syncStorageConfig", syncS3);
            updateConfig("syncWebDAVStorageConfig", syncWebDAV);
            if (syncS3 && payload.storageProvider?.s3) {
                const next = { ...defaultUserStorageProvider(), ...payload.storageProvider.s3, type: "s3" as const };
                setUserStorage(next); saveUserStorageProvider(next);
            }
            if (syncWebDAV && payload.storageProvider?.webdav) {
                const next = { ...defaultUserWebDAVStorageProvider(), ...payload.storageProvider.webdav, type: "webdav" as const };
                setUserWebDAVStorage(next); saveUserWebDAVStorageProvider(next);
            }
            accountConfigRef.current = true;
        }).catch(() => {});
        return () => { canceled = true; };
    }, [isConfigOpen, token, updateConfig, user?.id]);

    useEffect(() => {
        if (!isConfigOpen) return;
        let canceled = false;
        void loadStorageConfig()
            .then((storage) => {
                if (!canceled) setAllowUserStorageProvider(storage.allowUserProvider === true);
            })
            .catch(() => {
                if (!canceled) setAllowUserStorageProvider(false);
            });
        return () => {
            canceled = true;
        };
    }, [isConfigOpen]);

    const finishConfig = async () => {
        if (userStorage.enabled && userWebDAVStorage.enabled) return void message.error("S3/R2 与 WebDAV 不能同时启用");
        if (token && canUseUserStorageProvider && !accountConfigRef.current) return void message.warning("存储配置尚未加载成功，请重新打开后保存");
        if (canUseUserStorageProvider) {
            saveUserStorageProvider(userStorage);
            saveUserWebDAVStorageProvider(userWebDAVStorage);
        }
        setSavingConfig(true);
        const accountToken = token;
        try {
            const providers = {
                ...(config.syncStorageConfig || remoteStorageSyncEnabled ? { s3: config.syncStorageConfig ? userStorage : { ...userStorage, enabled: false, endpoint: "", bucket: "", accessKeyId: "", secretAccessKey: "" } } : {}),
                ...(config.syncWebDAVStorageConfig || remoteWebDAVStorageSyncEnabled ? { webdav: config.syncWebDAVStorageConfig ? userWebDAVStorage : { ...userWebDAVStorage, enabled: false, endpoint: "", username: "", password: "" } } : {}),
            };
            if (accountToken && canUseUserStorageProvider) {
                await syncUserStorageProvider(accountToken, providers, { s3: config.syncStorageConfig, webdav: config.syncWebDAVStorageConfig });
                if (useUserStore.getState().token !== accountToken) return;
                setRemoteStorageSyncEnabled(config.syncStorageConfig);
                setRemoteWebDAVStorageSyncEnabled(config.syncWebDAVStorageConfig);
            }
            clearImageStorageCache(); clearFileStorageCache();
            setConfigDialogOpen(false);
            message.success(shouldPromptContinue ? "偏好已保存，请继续刚才的请求" : "偏好已保存");
            clearPromptContinue();
        } catch (error) {
            if (useUserStore.getState().token === accountToken) message.error(error instanceof Error ? "同步配置失败：" + error.message : "同步配置失败");
        } finally { setSavingConfig(false); }
    };

    const measureStorage = async (provider: UserStorageProvider) => {
        if (!token) {
            message.warning("请先登录后再统计容量");
            return;
        }
        setMeasuringStorageType(provider.type);
        try {
            const result = await measureUserStorageProvider(token, provider);
            const usageText = formatBytes(result.bytes) + " / " + formatBytes(result.limitBytes) + (result.overLimit ? "，已达到上限" : "");
            if (provider.type === "webdav") {
                setWebDAVStorageUsageText(usageText);
                if (result.overLimit) {
                    const next = { ...userWebDAVStorage, enabled: false };
                    setUserWebDAVStorage(next);
                    saveUserWebDAVStorageProvider(next);
                }
            } else {
                setStorageUsageText(usageText);
                if (result.overLimit) {
                    const next = { ...userStorage, enabled: false };
                    setUserStorage(next);
                    saveUserStorageProvider(next);
                }
            }
            message.success("容量统计完成");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "容量统计失败");
        } finally {
            setMeasuringStorageType(null);
        }
    };

    return (
        <>
            <Modal
            title={
                <div>
                    <div className="text-lg font-semibold">配置与用户偏好</div>
                    <div className="mt-1 text-xs font-normal text-stone-500">后台模型与画布默认行为</div>
                </div>
            }
            open={isConfigOpen}
            width={960}
            centered
            onCancel={() => setConfigDialogOpen(false)}
            styles={{ body: { maxHeight: "72vh", overflowY: "auto", paddingRight: 18 } }}
            footer={
                <Button type="primary" loading={savingConfig} onClick={() => void finishConfig()}>
                    完成
                </Button>
            }
        >
            <div className="pt-1">
                <Form layout="vertical" requiredMark={false}>
                    <div className="mb-5 rounded-lg border border-stone-200 p-3 text-sm text-stone-500 dark:border-stone-800">
                        <div className="font-medium text-stone-900 dark:text-stone-100">统一云端模型</div>
                        <div className="mt-1">{isSettingsLoading ? "正在加载后台模型…" : modelConfig.models.length ? `管理员已开放 ${modelConfig.models.length} 个模型，请选择创作所需模型。` : "暂无可用模型，请联系管理员配置并开放模型。"}</div>
                    </div>
                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                        {modelGroups.map((group) => (
                            <Form.Item key={group.modelKey} label={group.defaultLabel} className="mb-4">
                                <ModelPicker config={modelConfig} value={modelConfig[group.modelKey]} channelId={modelConfig[group.channelKey]} workflowRef={group.workflowKey ? modelConfig[group.workflowKey] : undefined} onWorkflowChange={group.workflowKey ? (ref) => updateConfig(group.workflowKey!, ref) : undefined} onChange={(model, channelId) => { updateConfig(group.modelKey, model); if (channelId) updateConfig(group.channelKey, channelId); }} capability={group.capability} fullWidth />
                            </Form.Item>
                        ))}
                    </div>
                    <div className="grid gap-4 md:grid-cols-4">
                        <Form.Item label="画布默认生图张数" extra="新建画布生图和配置节点默认使用，单个节点仍可单独覆盖。" className="mb-4">
                            <Input
                                type="number"
                                min={1}
                                max={15}
                                value={config.canvasImageCount}
                                onChange={(event) => updateConfig("canvasImageCount", event.target.value)}
                                onBlur={(event) => updateConfig("canvasImageCount", normalizeImageCount(event.target.value))}
                            />
                        </Form.Item>
                        {geminiTts ? (
                            <Form.Item label="默认 Gemini 音色" className="mb-4">
                                <Select showSearch optionFilterProp="label" value={normalizeGeminiTtsVoice(config.geminiTtsVoice)} options={geminiTtsVoiceOptions} onChange={(value) => updateConfig("geminiTtsVoice", value)} />
                            </Form.Item>
                        ) : isMimoPresetTtsModel(modelConfig.audioModel) ? (
                            <Form.Item label="默认 MiMo 音色" className="mb-4">
                                <Select value={config.mimoTtsVoice} options={[...mimoTtsVoiceOptions]} onChange={(value) => updateConfig("mimoTtsVoice", value)} />
                            </Form.Item>
                        ) : isMimoVoiceDesignModel(modelConfig.audioModel) ? (
                            <Form.Item label="默认音色描述" className="mb-4">
                                <Input value={config.mimoVoiceDesignPrompt} placeholder="例如：年轻女性，声音清亮自然，有亲和力。" onChange={(event) => updateConfig("mimoVoiceDesignPrompt", event.target.value)} />
                            </Form.Item>
                        ) : isMimoTtsModel(modelConfig.audioModel) ? null : (
                            <Form.Item label="默认音频声音" className="mb-4">
                                {grokTts ? <GrokTtsVoiceSelect config={audioConfig} model={modelConfig.audioModel} value={config.grokTtsVoice} enabled={isConfigOpen} onChange={(value) => updateConfig("grokTtsVoice", value)} /> : <Select value={glmTts ? normalizeGlmTtsVoice(config.glmTtsVoice) : config.audioVoice} options={glmTts ? glmTtsVoiceOptions : audioVoiceOptions} onChange={(value) => updateConfig(glmTts ? "glmTtsVoice" : "audioVoice", value)} />}
                            </Form.Item>
                        )}
                        {grokTts ? (
                            <Form.Item label="默认音频语言" className="mb-4">
                                <Select value={normalizeGrokTtsLanguage(config.grokTtsLanguage)} options={grokTtsLanguageOptions} showSearch optionFilterProp="label" onChange={(value) => updateConfig("grokTtsLanguage", value)} />
                            </Form.Item>
                        ) : null}
                        {!geminiTts ? (
                            <Form.Item label="默认音频格式" className="mb-4">
                                <Select value={isMimoTtsModel(modelConfig.audioModel) ? config.mimoTtsFormat : glmTts ? normalizeGlmTtsFormat(config.glmTtsFormat) : grokTts ? normalizeGrokTtsFormat(config.grokTtsFormat) : config.audioFormat} options={isMimoTtsModel(modelConfig.audioModel) ? [...mimoTtsFormatOptions] : glmTts ? glmTtsFormatOptions : grokTts ? grokTtsFormatOptions : audioFormatOptions} onChange={(value) => isMimoTtsModel(modelConfig.audioModel) ? updateConfig("mimoTtsFormat", value) : updateConfig(glmTts ? "glmTtsFormat" : grokTts ? "grokTtsFormat" : "audioFormat", value)} />
                            </Form.Item>
                        ) : null}
                        {!geminiTts && !isMimoTtsModel(modelConfig.audioModel) ? (
                            <Form.Item label="默认音频语速" className="mb-4">
                                <Input
                                    type="number"
                                    min={glmTts ? 0.5 : grokTts ? 0.7 : 0.25}
                                    max={glmTts ? 2 : grokTts ? 1.5 : 4}
                                    step={0.05}
                                    value={glmTts ? config.glmTtsSpeed : grokTts ? config.grokTtsSpeed : config.audioSpeed}
                                    onChange={(event) => updateConfig(glmTts ? "glmTtsSpeed" : grokTts ? "grokTtsSpeed" : "audioSpeed", event.target.value)}
                                    onBlur={(event) => updateConfig(glmTts ? "glmTtsSpeed" : grokTts ? "grokTtsSpeed" : "audioSpeed", glmTts ? normalizeGlmTtsSpeed(event.target.value) : grokTts ? normalizeGrokTtsSpeed(event.target.value) : normalizeAudioSpeedValue(event.target.value))}
                                />
                            </Form.Item>
                        ) : null}
                    </div>
                    <div className="mb-4 grid gap-3 md:grid-cols-3">
                        <FeatureSwitch title="流式传输" description="开启后请求中追加 stream，支持读取中间图片事件并避免长时间无数据。" checked={Boolean(config.streamImages)} onChange={(checked) => updateConfig("streamImages", checked ? "1" : "")} />
                        <FeatureSwitch title="返回 Base64 图片数据" description="开启后 Image API 请求会追加 response_format: b64_json。" checked={Boolean(config.responseFormatB64Json)} onChange={(checked) => updateConfig("responseFormatB64Json", checked ? "1" : "")} />
                    </div>
                    {canUseUserStorageProvider ? (
                        <>
                            <section className="mb-5 mt-4 rounded-xl border border-stone-200 bg-stone-50/70 p-3 dark:border-stone-800 dark:bg-stone-900/50">
                                <div className="flex items-center justify-between gap-3">
                                    <div>
                                        <div className="text-sm font-medium">用户 S3/R2 存储</div>
                                        <div className="mt-1 text-xs text-stone-500">
                                            开启后，新生成图片和媒体文件会优先保存到你的 S3 兼容对象存储。
                                            {storageUsageText ? <>当前容量：{storageUsageText}</> : null}
                                        </div>
                                    </div>
                                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                                        <Button size="small" loading={measuringStorageType === "s3"} onClick={() => void measureStorage(userStorage)}>
                                            统计容量
                                        </Button>
                                        <span className="text-xs text-stone-500">自动同步</span>
                                        <Switch size="small" checked={config.syncStorageConfig} onChange={(checked) => updateConfig("syncStorageConfig", checked)} />
                                        <Switch checked={userStorage.enabled} disabled={userWebDAVStorage.enabled} onChange={(enabled) => setUserStorage((value) => ({ ...value, enabled }))} />
                                    </div>
                                </div>
                                {userStorage.enabled ? (
                                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                                        <Input value={userStorage.name} placeholder="配置名称" onChange={(event) => setUserStorage((value) => ({ ...value, name: event.target.value }))} />
                                        <Input value={userStorage.endpoint} placeholder="Endpoint，例如 https://<account>.r2.cloudflarestorage.com" onChange={(event) => setUserStorage((value) => ({ ...value, endpoint: event.target.value }))} />
                                        <Input value={userStorage.region} placeholder="Region，R2 通常为 auto" onChange={(event) => setUserStorage((value) => ({ ...value, region: event.target.value }))} />
                                        <Input value={userStorage.bucket} placeholder="Bucket 名称" onChange={(event) => setUserStorage((value) => ({ ...value, bucket: event.target.value }))} />
                                        <Input value={userStorage.accessKeyId} placeholder="Access Key ID" onChange={(event) => setUserStorage((value) => ({ ...value, accessKeyId: event.target.value }))} />
                                        <Input.Password value={userStorage.secretAccessKey} placeholder="Secret Access Key" onChange={(event) => setUserStorage((value) => ({ ...value, secretAccessKey: event.target.value }))} />
                                        <Input value={userStorage.publicBaseUrl} placeholder="公开访问地址，例如 https://pub-xxx.r2.dev" onChange={(event) => setUserStorage((value) => ({ ...value, publicBaseUrl: event.target.value }))} />
                                        <Input value={userStorage.pathPrefix} placeholder="保存路径前缀，例如 images" onChange={(event) => setUserStorage((value) => ({ ...value, pathPrefix: event.target.value }))} />
                                    </div>
                                ) : null}
                            </section>
                            <section className="mb-5 mt-4 rounded-xl border border-stone-200 bg-stone-50/70 p-3 dark:border-stone-800 dark:bg-stone-900/50">
                                <div className="flex items-center justify-between gap-3">
                                    <div>
                                        <div className="text-sm font-medium">WebDAV 存储</div>
                                        <div className="mt-1 text-xs text-stone-500">
                                            开启后，新生成图片和媒体文件会优先保存到你的 WebDAV。
                                            {webDAVStorageUsageText ? <>当前容量：{webDAVStorageUsageText}</> : null}
                                        </div>
                                    </div>
                                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                                        <Button size="small" loading={measuringStorageType === "webdav"} onClick={() => void measureStorage(userWebDAVStorage)}>
                                            统计容量
                                        </Button>
                                        <span className="text-xs text-stone-500">自动同步</span>
                                        <Switch size="small" checked={config.syncWebDAVStorageConfig} onChange={(checked) => updateConfig("syncWebDAVStorageConfig", checked)} />
                                        <Switch checked={userWebDAVStorage.enabled} disabled={userStorage.enabled} onChange={(enabled) => setUserWebDAVStorage((value) => ({ ...value, enabled }))} />
                                    </div>
                                </div>
                                {userWebDAVStorage.enabled ? (
                                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                                        <Input value={userWebDAVStorage.name} placeholder="配置名称" onChange={(event) => setUserWebDAVStorage((value) => ({ ...value, name: event.target.value }))} />
                                        <Input value={userWebDAVStorage.endpoint} placeholder="WebDAV 地址" onChange={(event) => setUserWebDAVStorage((value) => ({ ...value, endpoint: event.target.value }))} />
                                        <Input value={userWebDAVStorage.pathPrefix} placeholder="远程目录" onChange={(event) => setUserWebDAVStorage((value) => ({ ...value, pathPrefix: event.target.value }))} />
                                        <Input value={userWebDAVStorage.username} placeholder="用户名" onChange={(event) => setUserWebDAVStorage((value) => ({ ...value, username: event.target.value }))} />
                                        <Input.Password value={userWebDAVStorage.password} placeholder="密码 / 应用密码" onChange={(event) => setUserWebDAVStorage((value) => ({ ...value, password: event.target.value }))} />
                                    </div>
                                ) : null}
                            </section>
                        </>
                    ) : null}
                    {(!isMimoTtsModel(modelConfig.audioModel) || isMimoPresetTtsModel(modelConfig.audioModel) || isMimoVoiceCloneModel(modelConfig.audioModel)) && !glmTts && !grokTts ? (
                        <Form.Item label="默认音频指令" className="mb-4">
                            <Input.TextArea rows={2} value={config.audioInstructions} placeholder="例如：自然、温暖、适合旁白。" onChange={(event) => updateConfig("audioInstructions", event.target.value)} />
                        </Form.Item>
                    ) : null}
                </Form>
            </div>
            </Modal>
        </>
    );
}

function FeatureSwitch({ title, description, checked, onChange }: { title: string; description: string; checked: boolean; onChange: (checked: boolean) => void }) {
    return (
        <div className="rounded-lg border border-stone-200 px-3 py-2 dark:border-stone-800">
            <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-medium">{title}</div>
                <Switch checked={checked} onChange={onChange} />
            </div>
            <div className="mt-1 text-xs leading-5 text-stone-500">{description}</div>
        </div>
    );
}

function normalizeImageCount(value: string) {
    return String(Math.max(1, Math.min(15, Math.floor(Math.abs(Number(value)) || 3))));
}


function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
