import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "./request";
import { fetchAssetFiles, fetchProductionFileBlob, productionFileLimit, type ProductionFile } from "./production-files";

const file: ProductionFile = { id: "file-2e43e9f3-8343-4aae-9eb0-cb9a46145d3e", projectId: "project-a", assetId: "asset-a", name: "人物参考.png", mimeType: "image/png", bytes: 3, createdAt: "2026-10-10T00:00:00Z" };
const signal = () => new AbortController().signal;
async function withFetch(mock: typeof fetch, run: () => Promise<void>) {
    const original = globalThis.fetch;
    globalThis.fetch = mock;
    try { await run(); } finally { globalThis.fetch = original; }
}
const rejectStatus = (status: number) => (error: unknown) => error instanceof ApiError && error.status === status;

test("private list sends bearer only as a header and validates project/asset ownership", async () => {
    await withFetch((async (input, init) => {
        assert.equal(input, "/api/v1/production/projects/project-a/assets/asset-a/files?page=1&pageSize=20");
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer account-token");
        assert.equal(init?.cache, "no-store");
        assert.equal(init?.redirect, "error");
        return Response.json({ code: 0, data: { items: [{ ...file, projectId: "project-b" }], total: 1 } });
    }) as typeof fetch, async () => {
        await assert.rejects(fetchAssetFiles("account-token", "project-a", "asset-a", 1, signal()), rejectStatus(502));
    });
});

test("download requests fresh authorized bytes independently of preview", async () => {
    const paths: string[] = [];
    await withFetch((async (input, init) => {
        paths.push(String(input));
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer token");
        return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png", "content-length": "3" } });
    }) as typeof fetch, async () => {
        const preview = await fetchProductionFileBlob("token", "project-a", "asset-a", file, false, signal());
        const download = await fetchProductionFileBlob("token", "project-a", "asset-a", file, true, signal());
        assert.equal(preview.size, 3);
        assert.deepEqual(new Uint8Array(await download.arrayBuffer()), new Uint8Array([1, 2, 3]));
        assert.equal(paths.length, 2);
        assert.equal(paths[1], `${paths[0]}?download=1`);
        assert.ok(paths.every((path) => !path.includes("token")));
    });
});

test("private content rejects MIME swaps, truncated bodies, and oversized streaming bodies", async () => {
    for (const response of [new Response("abc", { headers: { "content-type": "text/html" } }), new Response(new Uint8Array([1, 2]), { headers: { "content-type": "image/png" } }), new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "content-type": "image/png" } }), new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png", "content-length": "4" } })]) {
        await withFetch((async () => response) as typeof fetch, async () => {
            await assert.rejects(fetchProductionFileBlob("token", "project-a", "asset-a", file, false, signal()), rejectStatus(502));
        });
    }
});

test("private bytes cannot be requested using untrusted metadata or a different asset", async () => {
    await withFetch((async () => { assert.fail("invalid metadata must not trigger a fetch"); }) as typeof fetch, async () => {
        for (const invalid of [{ ...file, bytes: productionFileLimit + 1 }, { ...file, mimeType: "image/svg+xml" }, { ...file, id: "../outside" }]) {
            await assert.rejects(fetchProductionFileBlob("token", "project-a", "asset-a", invalid, false, signal()), rejectStatus(502));
        }
        await assert.rejects(fetchProductionFileBlob("token", "project-a", "asset-b", file, false, signal()), rejectStatus(502));
    });
});

test("denied downloads retain their HTTP status and cancellation does not become a retry error", async () => {
    await withFetch((async () => new Response("", { status: 404 })) as typeof fetch, async () => {
        await assert.rejects(fetchProductionFileBlob("token", "project-a", "asset-a", file, true, signal()), rejectStatus(404));
    });
    const controller = new AbortController();
    controller.abort();
    await withFetch((async (_input, init) => {
        assert.equal(init?.signal?.aborted, true);
        throw new DOMException("aborted", "AbortError");
    }) as typeof fetch, async () => {
        await assert.rejects(fetchProductionFileBlob("token", "project-a", "asset-a", file, true, controller.signal), (error: unknown) => error instanceof DOMException && error.name === "AbortError");
    });
});
