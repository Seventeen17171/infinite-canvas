import assert from "node:assert/strict";
import test from "node:test";
import { CanvasNodeType } from "../../app/(user)/canvas/types";
import { imageReference, imageReferenceKey, referenceNode, visibleImageReferences } from "./image-reference";

const reference = { assetId: "asset-a", fileId: "file-a" };
const center = { x: 400, y: 300 };

test("inserted image serializes only IDs and geometry even when selection contains media fields", () => {
    const selection = { ...reference, url: "blob:private", bytes: new Uint8Array([1, 2, 3]), name: "original.png", token: "secret" };
    const node = referenceNode(selection, "林舟", 640, 480, center, "node-a");
    assert.equal(node.type, CanvasNodeType.Image);
    assert.deepEqual(node.metadata, reference);
    assert.equal(node.width / node.height, 640 / 480);
    const json = JSON.stringify({ past: [node], copy: { ...node, id: "copy" }, draft: node });
    for (const value of ["blob:", "private", "secret", "original.png", "bytes", "token", "url"]) assert.ok(!json.includes(value));
    assert.deepEqual(imageReference(node), reference);
});

test("display plan deduplicates file references, excludes offscreen nodes and never exceeds four slots", () => {
    const nodes = Array.from({ length: 8 }, (_, index) => referenceNode({ assetId: `asset-${index}`, fileId: `file-${index}` }, "图", 300, 200, center, `node-${index}`));
    const duplicate = { ...nodes[0], id: "duplicate" };
    const outside = { ...nodes[1], id: "outside", position: { x: 4000, y: 4000 } };
    const plan = visibleImageReferences([nodes[0], duplicate, outside, ...nodes.slice(2)], { x: 0, y: 0, k: 1 }, { width: 1000, height: 700 }, "");
    assert.equal(plan.length, 4);
    assert.deepEqual(plan.map(imageReferenceKey), ["asset-0:file-0", "asset-2:file-2", "asset-3:file-3", "asset-4:file-4"]);
    assert.equal(visibleImageReferences(nodes, { x: -4000, y: -4000, k: 1 }, { width: 1000, height: 700 }, "").length, 0);
});

test("explicit image loading promotes one visible image and releases the previous fourth slot", () => {
    const nodes = Array.from({ length: 5 }, (_, index) => referenceNode({ assetId: "asset", fileId: `file-${index}` }, "图", 300, 200, center, `node-${index}`));
    const plan = visibleImageReferences(nodes, { x: 0, y: 0, k: 1 }, { width: 1000, height: 700 }, "asset:file-4");
    assert.deepEqual(plan.map(imageReferenceKey), ["asset:file-4", "asset:file-0", "asset:file-1", "asset:file-2"]);
});

test("extreme image ratios and viewport positions keep a bounded contain frame", () => {
    for (const [width, height] of [[8192, 1], [1, 8192], [1, 1]]) {
        const node = referenceNode(reference, "图", width, height, { x: 1e12, y: -1e12 }, "node");
        assert.ok(node.width >= 16 && node.width <= 420 && node.height >= 16 && node.height <= 340);
        assert.ok(Math.abs(node.position.x) <= 1e6 && Math.abs(node.position.y) <= 1e6);
    }
});

test("text nodes and incomplete media cannot become image references", () => {
    const node = referenceNode(reference, "图", 300, 200, center, "node");
    assert.equal(imageReference({ ...node, type: CanvasNodeType.Text }), undefined);
    assert.equal(imageReference({ ...node, metadata: { assetId: "asset" } }), undefined);
});
