import test from "node:test";
import assert from "node:assert/strict";
import { encodeWav16, NexusDictation } from "../esm/index.js";

test("16 kHz PCM encoding creates a correctly sized RIFF WAV", () => {
  const wav = encodeWav16(Float32Array.from({ length: 48000 }, (_, i) => Math.sin(i / 10)), 48000);
  const view = new DataView(wav);
  assert.equal(wav.byteLength, 32044);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(40, true), 32000);
});
test("reject remote bridge to protect microphone contents", () => {
  assert.throws(() => new NexusDictation({ endpoint: "https://example.com" }));
});
test("bridge accepts text and rejects failed responses", async () => {
  const dictation = new NexusDictation({ fetcher: async () => ({ ok: true, json: async () => ({ text: "Hello." }) }) });
  assert.equal((await dictation.transcribeWav(new ArrayBuffer(44))).text, "Hello.");
  const failing = new NexusDictation({ fetcher: async () => ({ ok: false, status: 401, json: async () => ({ error: "No token" }) }) });
  await assert.rejects(failing.transcribeWav(new ArrayBuffer(44)), /No token/);
});
