import assert from "node:assert/strict";
import test from "node:test";

import type { AdminPublicSettings } from "@/services/api/admin";
import { channelIdForActiveModel, defaultConfig, resolveEffectiveConfig, resolveModelForCapability, sanitizeConfigPreferences } from "./use-config-store";

const modelChannel: AdminPublicSettings["modelChannel"] = {
    availableWorkflows: [], modelCosts: [], systemPrompts: { ...defaultConfig.systemPrompts },
    availableModels: ["gpt-cloud", "gpt-image-cloud", "disabled-image"],
    channels: [
        { id: "cloud", protocol: "openai", name: "后台渠道", weight: 1, timeout: 600, remark: "", enabled: true, models: ["gpt-cloud", "gpt-image-cloud"], modelCapabilities: { "gpt-cloud": "text", "gpt-image-cloud": "image" } },
        { id: "disabled", protocol: "openai", name: "停用", weight: 1, timeout: 600, remark: "", enabled: false, models: ["disabled-image"], modelCapabilities: { "disabled-image": "image" } },
    ],
    defaultModel: "gpt-cloud", defaultTextModel: "gpt-cloud", defaultImageModel: "gpt-image-cloud", defaultVideoModel: "", systemPrompt: "后台指令",
};

test("retired credentials, channel catalogs and nested unknown keys never enter persisted preferences", () => {
    const preferences = sanitizeConfigPreferences({
        channelMode: "local", baseUrl: "https://retired.invalid", apiKey: "retired-secret",
        localChannels: [{ apiKey: "retired-secret" }], models: ["old-model"], publicChannels: [{ id: "forged" }],
        model: "gpt-cloud", size: "16:9", syncStorageConfig: true,
        systemPrompts: { image: "创作偏好", apiKey: "retired-secret" },
        videoMultiPrompt: [{ prompt: "镜头", duration: "2", apiKey: "retired-secret" }],
        videoElementList: [{ name: "人物", apiKey: "retired-secret", references: [{ id: "ref", kind: "image", name: "参考", type: "image/png", apiKey: "retired-secret" }] }],
        imageWorkflowRef: { scope: "personal", channelId: "legacy", kind: "workflow", workflowId: "old" },
        videoWorkflowRef: { scope: "system", channelId: "cloud", kind: "workflow", workflowId: "approved", apiKey: "retired-secret" },
    });
    assert.equal(preferences.size, "16:9");
    assert.equal(preferences.syncStorageConfig, true);
    assert.equal(preferences.imageWorkflowRef, undefined);
    assert.deepEqual(preferences.videoWorkflowRef, { scope: "system", channelId: "cloud", kind: "workflow", workflowId: "approved" });
    for (const key of ["channelMode", "baseUrl", "apiKey", "localChannels", "models", "publicChannels"]) assert.equal(Object.hasOwn(preferences, key), false);
    assert.equal(JSON.stringify(preferences).includes("retired-secret"), false);
});

test("empty settings and logged-out state have no fallback model or channel", () => {
    for (const config of [resolveEffectiveConfig({ ...defaultConfig, model: "old-model", imageModel: "gpt-image-cloud" }, null, true), resolveEffectiveConfig(defaultConfig, modelChannel, false)]) {
        assert.deepEqual(config.models, []);
        assert.deepEqual(config.publicChannels, []);
        for (const key of ["model", "imageModel", "videoModel", "textModel", "audioModel"] as const) assert.equal(config[key], "");
        assert.equal(resolveModelForCapability(config, "gpt-image-cloud", "image"), "");
    }
});

test("available choices are the intersection of enabled backend channels and published models", () => {
    const config = resolveEffectiveConfig({ ...defaultConfig, imageModel: "disabled-image" }, modelChannel, true);
    assert.deepEqual(config.models, ["gpt-cloud", "gpt-image-cloud"]);
    assert.equal(config.model, "gpt-cloud");
    assert.equal(config.imageModel, "gpt-image-cloud");
    assert.equal(config.videoModel, "");
    assert.equal(config.publicChannels.some((channel) => channel.id === "disabled"), false);
    assert.equal(resolveModelForCapability(config, "unpublished-image", "image"), "gpt-image-cloud");
});

test("stale or forged channel preference cannot select a channel outside the published model", () => {
    const config = resolveEffectiveConfig(defaultConfig, modelChannel, true);
    assert.equal(channelIdForActiveModel({ ...config, model: "gpt-image-cloud", activeChannelId: "legacy", imageChannelId: "disabled" }), "cloud");
    assert.equal(channelIdForActiveModel({ ...config, model: "unpublished-image", activeChannelId: "cloud" }), "");
});
