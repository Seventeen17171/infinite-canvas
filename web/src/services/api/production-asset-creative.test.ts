import assert from "node:assert/strict";
import test from "node:test";
import { emptyCreative, validCreativeFields } from "./production-asset-creative";

test("creative text accepts CRLF and tab but rejects C0/C1 controls", () => {
    assert.equal(validCreativeFields({ ...emptyCreative, prompt: "人物：林川\r\n\t冷色侧光" }), true);
    for (const control of ["\u0000", "\u000b", "\u001f", "\u007f", "\u0085", "\u009f"]) {
        assert.equal(validCreativeFields({ ...emptyCreative, prompt: `a${control}b` }), false);
    }
});

test("creative prompt limit counts Unicode characters rather than UTF-16 units", () => {
    assert.equal(validCreativeFields({ ...emptyCreative, prompt: "🎬".repeat(8000) }), true);
    assert.equal(validCreativeFields({ ...emptyCreative, prompt: "🎬".repeat(8001) }), false);
});

test("creative models may be omitted but a partial model reference cannot be restored", () => {
    assert.equal(validCreativeFields(emptyCreative), true);
    assert.equal(validCreativeFields({ ...emptyCreative, modelChannelId: "channel" }), false);
    assert.equal(validCreativeFields({ ...emptyCreative, modelName: "image-model" }), false);
    assert.equal(validCreativeFields({ ...emptyCreative, modelChannelId: "channel", modelName: "image-model" }), true);
});
