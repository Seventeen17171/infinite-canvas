import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { AiConfig } from "@/stores/use-config-store";
import type { VideoResponse } from "./video";

const cases = ["headers", "multipart", "legacy", "poll", "audio-gemini", "translation", "unauthenticated"] as const;
type RoutingCase = (typeof cases)[number];

// Bun module mocks live in a separate process so they cannot replace dependencies
// used by unrelated tests in the same test run.
if (process.env.CLOUD_ROUTING_TEST_CASE) {
    await runClientCase(process.env.CLOUD_ROUTING_TEST_CASE as RoutingCase);
} else {
    for (const name of cases) {
        test(`cloud-only client routing: ${name}`, () => {
            const result = spawnSync(process.execPath, ["run", fileURLToPath(import.meta.url)], {
                cwd: fileURLToPath(new URL("../../../..", import.meta.url)),
                env: { ...process.env, CLOUD_ROUTING_TEST_CASE: name },
                encoding: "utf8",
                timeout: 20_000,
            });
            assert.equal(result.status, 0, `${name}: ${result.error?.message || result.stderr || result.stdout}`);
        });
    }
}

async function runClientCase(name: RoutingCase) {
    // Dynamic runtime import keeps the web TypeScript build independent of Bun types.
    const { mock } = await import("bun" + ":test");
    const calls: Array<{ method: string; url: string; body?: unknown; headers?: Record<string, string> }> = [];
    let token = "test-session-canary";
    let axiosData: unknown = { id: "server-task", video_id: "provider-task", status: "queued" };
    let fetchData: unknown = { data: [{ url: "https://media.invalid/generated.png" }] };
    const axios = {
        isAxiosError: () => false,
        post: async (url: string, body: unknown, options?: { headers?: Record<string, string> }) => {
            calls.push({ method: "POST", url, body, headers: options?.headers });
            return { data: axiosData };
        },
        get: async (url: string, options?: { headers?: Record<string, string> }) => {
            calls.push({ method: "GET", url, headers: options?.headers });
            return { data: axiosData };
        },
        request: async () => { throw new Error("Unexpected generic axios request in routing test"); },
    };
    mock.module("axios", () => ({ default: axios }));
    mock.module("@/stores/use-user-store", () => ({
        useUserStore: { getState: () => ({ token, user: token ? { id: "test-user" } : null, hydrateUser: async () => {} }) },
    }));
    mock.module("@/services/image-storage", () => ({
        imageToDataUrl: async (image: { dataUrl?: string }) => image.dataUrl || "",
        resolveImageUrl: async (_key: string, url = "") => url,
        autoSyncImage: async (url: string) => ({ url, storageKey: "mock-image" }),
        autoSyncToCloud: async () => null,
    }));
    mock.module("@/services/file-storage", () => ({
        resolveMediaUrl: async (_key: string, url = "") => url,
        uploadMediaFile: async () => ({ url: "/api/files/mock/content", storageKey: "mock-file" }),
        uploadRemoteMediaToServer: async () => ({ url: "/api/files/mock/content", storageKey: "mock-file" }),
    }));
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ method: init?.method || "GET", url: String(url), body: init?.body, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
        return Response.json(fetchData);
    }) as typeof fetch;

    const { defaultConfig } = await import("@/stores/use-config-store");
    const image = await import("./image");
    const video = await import("./video");
    const audio = await import("./audio");
    const translation = await import("./channel-parameter-translation");
    const agent = await import("./canvas-agent");
    const config = (model = "sora-2", protocol = "openai") => ({
        ...structuredClone(defaultConfig),
        model, imageModel: model, videoModel: model, audioModel: model, textModel: model,
        models: [model],
        activeChannelId: "server-channel", imageChannelId: "server-channel", videoChannelId: "server-channel", audioChannelId: "server-channel", textChannelId: "server-channel",
        publicChannels: [{ id: "server-channel", protocol, models: [model], enabled: true }],
        // Simulates stale browser documents and imported personal model settings.
        channelMode: "local", baseUrl: "http://127.0.0.1:19999/forbidden", apiKey: "legacy-key-canary",
        localChannels: [{ id: "personal-channel", baseUrl: "https://forbidden.invalid", apiKey: "legacy-key-canary", models: [model] }],
    }) as AiConfig;
    const assertCloudHeaders = (headers: Record<string, string> = {}) => {
        const normalized = new Headers(headers);
        assert.equal(normalized.get("Authorization"), `Bearer ${token}`);
        assert.equal(normalized.get("X-Model-Channel-ID"), "server-channel");
        assert.equal(normalized.has("X-User-Model-Channel-ID"), false);
        assert.equal(JSON.stringify(headers).includes("legacy-key-canary"), false);
    };

    if (name === "headers") {
        const injected = config();
        assert.equal(image.aiApiUrl(injected, "/images/generations"), "/api/v1/images/generations");
        const headers = image.aiHeaders(injected, "application/json");
        assertCloudHeaders(headers);
        assert.deepEqual(Object.keys(headers).sort(), ["Authorization", "Content-Type", "X-Model-Channel-ID"]);
        assert.equal(calls.length, 0);
    } else if (name === "multipart") {
        const reference = { id: "ref-1", name: "reference.png", type: "image/png", dataUrl: "data:image/png;base64,iVBORw0KGgo=" };
        const result = await video.createVideoGenerationTask(config(), "cloud video", [reference], undefined, { clientTaskId: "client-task", source: "canvas", sourceId: "node-1" });
        assert.equal(calls.length, 1);
        const call = calls[0];
        assert.equal(call.url, "/api/v1/videos");
        assertCloudHeaders(call.headers);
        assert.equal(new Headers(call.headers).has("Content-Type"), false, "browser must supply multipart boundary");
        assert.ok(call.body instanceof FormData);
        assert.equal(call.body.get("model"), "sora-2");
        const file = call.body.get("input_reference[]");
        assert.ok(file instanceof File, "reference must remain a File, not JSON or an empty object");
        assert.equal(file.type, "image/png");
        assert.equal(file.size, 8);
        assert.equal(result.pollId, "server-task");
    } else if (name === "legacy") {
        const oldTasks = [
            { id: "old-task", userChannelId: "personal-channel" },
            { id: "old-task", user_channel_id: "personal-channel" },
            { id: "old-task", translationSnapshot: { baseUrl: "https://forbidden.invalid", apiKey: "legacy-key-canary" } },
            { id: "local_video_task_old" },
        ];
        for (const task of oldTasks) {
            await assert.rejects(video.pollVideoGenerationTaskStatus(config(), task as VideoResponse));
            await assert.rejects(video.pollCreatedVideoGenerationTask(config(), task as VideoResponse));
        }
        assert.equal(calls.length, 0, "legacy personal tasks must fail before any cloud or local request");
    } else if (name === "poll") {
        await video.pollVideoGenerationTaskStatus(config(), { id: "server-task", video_id: "provider-task", task_id: "provider-task-2", status: "queued" });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, "/api/v1/videos/server-task");
        assertCloudHeaders(calls[0].headers);
    } else if (name === "audio-gemini") {
        axiosData = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/mpeg" });
        const blob = await audio.requestAudioGeneration(config("tts-1"), "cloud audio");
        assert.equal(blob.size, 3);
        assert.equal(calls[0].url, "/api/v1/audio/speech");
        assertCloudHeaders(calls[0].headers);
        fetchData = { candidates: [{ content: { parts: [{ text: "cloud response" }] }, finishReason: "STOP" }] };
        const turn = await agent.requestCanvasAgentTurn({ config: config("gemini-2.5-flash", "gemini"), systemPrompt: "test", messages: [{ role: "user", content: "hello" }], tools: [], toolMode: "native" });
        assert.equal(turn.content, "cloud response");
        assert.equal(calls[1].url, "/api/v1/chat/completions");
        assertCloudHeaders(calls[1].headers);
        const body = JSON.parse(String(calls[1].body));
        assert.equal(body.model, "gemini-2.5-flash");
        assert.ok(Array.isArray(body.contents));
    } else if (name === "translation") {
        const current = config("translated-image");
        current.publicChannels[0].parameterTranslationModels = [current.model];
        const match = await translation.findParameterTranslation(current);
        assert.ok(match);
        const result = await translation.executeParameterTranslation(current, match, { kind: "image", variables: { model: current.model, prompt: "cloud", count: 1, images: [] } });
        assert.equal(calls[0].url, "/api/v1/images/generations");
        assertCloudHeaders(calls[0].headers);
        assert.equal(result.urls[0], "https://media.invalid/generated.png");
        const body = JSON.parse(String(calls[0].body));
        assert.equal(body.model, current.model);
        assert.equal(JSON.stringify(body).includes("legacy-key-canary"), false);
        assert.equal(JSON.stringify(body).includes("forbidden"), false);
    } else if (name === "unauthenticated") {
        token = "";
        assert.throws(() => image.aiHeaders(config()), /登录/);
        await assert.rejects(video.createVideoGenerationTask(config(), "cloud only"), /登录/);
        await assert.rejects(audio.requestAudioGeneration(config("tts-1"), "cloud only"), /登录/);
        assert.throws(() => translation.translationHeaders(config(), { channelId: "server-channel", timeout: 10 }), /登录/);
        assert.equal(calls.length, 0, "legacy API keys never become a substitute for login");
    } else {
        throw new Error(`Unknown client routing case: ${name}`);
    }
    mock.restore();
}
