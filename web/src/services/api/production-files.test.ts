import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "./request";
import { fetchAssetFiles, fetchProductionFile, fetchProductionFileBlob, fetchProductionFileUpload, productionFileLimit, productionImageError, uploadProductionFile, validProductionUpload, type ProductionFile, type ProductionFileUploadRequest } from "./production-files";

const file: ProductionFile = { id: "file-2e43e9f3-8343-4aae-9eb0-cb9a46145d3e", projectId: "project-a", assetId: "asset-a", name: "人物参考.png", mimeType: "image/png", bytes: 3, createdAt: "2026-10-10T00:00:00Z" };
const signal = () => new AbortController().signal;
async function withFetch(mock: typeof fetch, run: () => Promise<void>) {
    const original = globalThis.fetch;
    globalThis.fetch = mock;
    try { await run(); } finally { globalThis.fetch = original; }
}
const rejectStatus = (status: number) => (error: unknown) => error instanceof ApiError && error.status === status;

test("saved canvas reference metadata is reauthorized and checked against all scoped IDs", async () => {
    await withFetch((async (input, init) => {
        assert.equal(input, `/api/v1/production/projects/project-a/files/${file.id}`);
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer token");
        assert.equal(init?.cache, "no-store");
        assert.equal(init?.redirect, "error");
        return Response.json({ code: 0, data: file });
    }) as typeof fetch, async () => assert.deepEqual(await fetchProductionFile("token", "project-a", "asset-a", file.id, signal()), file));
    for (const invalid of [{ ...file, assetId: "asset-b" }, { ...file, projectId: "project-b" }, { ...file, id: "file-80972f80-b817-434e-90f9-b15664445c4e" }, { ...file, mimeType: "text/html" }]) {
        await withFetch((async () => Response.json({ code: 0, data: invalid })) as typeof fetch, async () => {
            await assert.rejects(fetchProductionFile("token", "project-a", "asset-a", file.id, signal()), rejectStatus(502));
        });
    }
});

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

const uploadRequest: ProductionFileUploadRequest = { requestId: "ef482bf5-99c6-4198-b075-4a45a3da29bd", projectId: file.projectId, assetId: file.assetId, name: file.name, bytes: file.bytes };
const imageFile = (name = file.name, bytes = new Uint8Array([1, 2, 3])) => new File([bytes], name, { type: "image/png" });

test("image selection rejects unsupported formats, paths and oversized bytes before upload", async () => {
    for (const invalid of [{ name: "../人物.png", size: 3, type: "image/png" }, { name: "\t人物.png", size: 3, type: "image/png" }, { name: "人物.png\n", size: 3, type: "image/png" }, { name: "人物.svg", size: 3, type: "image/svg+xml" }, { name: "人物.png", size: productionFileLimit + 1, type: "image/png" }, { name: "人物.png", size: 0, type: "image/png" }, { name: "人物.jpg", size: 3, type: "image/png" }]) assert.ok(productionImageError(invalid));
    assert.equal(productionImageError({ name: " 人物参考.png ", size: 3, type: "" }), "");
    assert.ok(validProductionUpload(uploadRequest, "project-a", "asset-a"));
    assert.equal(validProductionUpload(uploadRequest, "project-b", "asset-a"), false);
    assert.equal(validProductionUpload({ ...uploadRequest, requestId: "../unsafe" }, "project-a", "asset-a"), false);
    await withFetch((async () => { assert.fail("invalid upload must never fetch"); }) as typeof fetch, async () => {
        await assert.rejects(uploadProductionFile("token", uploadRequest, imageFile("other.png"), signal()), rejectStatus(400));
    });
});

test("upload sends one original binary file with normalized name, header identity and stable retry UUID", async () => {
    let calls = 0;
    await withFetch((async (input, init) => {
        calls++;
        assert.equal(input, "/api/v1/production/projects/project-a/assets/asset-a/files");
        assert.equal(init?.method, "POST");
        assert.equal(init?.cache, "no-store");
        assert.equal(init?.redirect, "error");
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("authorization"), "Bearer account-token");
        assert.equal(headers.get("x-upload-request-id"), uploadRequest.requestId);
        assert.equal(headers.get("content-type"), null, "browser must add the multipart boundary");
        assert.ok(init?.body instanceof FormData);
        assert.deepEqual([...init.body.keys()], ["file"]);
        const uploaded = init.body.get("file") as File;
        assert.ok((await new Response(init.body).text()).includes(`filename="${file.name}"`));
        assert.deepEqual(new Uint8Array(await uploaded.arrayBuffer()), new Uint8Array([1, 2, 3]));
        if (calls === 1) throw new TypeError("lost receipt");
        return Response.json({ code: 0, data: { requestId: uploadRequest.requestId, file } });
    }) as typeof fetch, async () => {
        await assert.rejects(uploadProductionFile("account-token", uploadRequest, imageFile(` ${file.name} `), signal()), rejectStatus(0));
        const receipt = await uploadProductionFile("account-token", uploadRequest, imageFile(` ${file.name} `), signal());
        assert.equal(receipt.file.id, file.id);
        assert.equal(calls, 2);
    });
});

test("receipt confirmation uses a fresh authorized GET and rejects swapped ownership or request identity", async () => {
    await withFetch((async (input, init) => {
        assert.equal(input, `/api/v1/production/projects/project-a/assets/asset-a/file-uploads/${uploadRequest.requestId}`);
        assert.equal(init?.method, "GET");
        assert.equal(init?.body, undefined);
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer token");
        return Response.json({ code: 0, data: { requestId: uploadRequest.requestId, file } });
    }) as typeof fetch, async () => {
        assert.equal((await fetchProductionFileUpload("token", uploadRequest, signal())).file.id, file.id);
    });
    for (const receipt of [{ requestId: "another-request", file }, { requestId: uploadRequest.requestId, file: { ...file, assetId: "asset-b" } }, { requestId: uploadRequest.requestId, file: { ...file, bytes: 4 } }, { requestId: uploadRequest.requestId, file: { ...file, name: "另一个.png" } }]) {
        await withFetch((async () => Response.json({ code: 0, data: receipt })) as typeof fetch, async () => {
            await assert.rejects(fetchProductionFileUpload("token", uploadRequest, signal()), rejectStatus(502));
        });
    }
});

test("upload response loss, conflict, backpressure, rejection and missing receipt remain distinguishable", async () => {
    for (const status of [400, 401, 403, 404, 409, 413, 415, 422, 429, 500]) {
        await withFetch((async () => Response.json({ code: 1, msg: "可操作的错误原因" }, { status })) as typeof fetch, async () => {
            await assert.rejects(uploadProductionFile("token", uploadRequest, imageFile(), signal()), (error: unknown) => error instanceof ApiError && error.status === status && error.message === "可操作的错误原因");
        });
    }
    await withFetch((async () => new Response("", { status: 404 })) as typeof fetch, async () => {
        await assert.rejects(fetchProductionFileUpload("token", uploadRequest, signal()), rejectStatus(404));
    });
    const controller = new AbortController();
    controller.abort();
    await withFetch((async (_input, init) => {
        assert.equal(init?.signal?.aborted, true);
        throw new DOMException("aborted", "AbortError");
    }) as typeof fetch, async () => {
        await assert.rejects(uploadProductionFile("token", uploadRequest, imageFile(), controller.signal), (error: unknown) => error instanceof DOMException && error.name === "AbortError");
    });
});
