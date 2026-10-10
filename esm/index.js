// NexusDictation: dependency-free browser ESM facade for native Photon/Redux.
export const PARAKEET_REDUX_MODEL = "moondream/parakeet-redux";
export const DEFAULT_BRIDGE = "http://127.0.0.1:47832";

export function encodeWav16(samples, inputRate, outputRate = 16000) {
  if (!(samples instanceof Float32Array) || !Number.isFinite(inputRate) || inputRate <= 0) {
    throw new TypeError("Float32Array samples and positive sample rate required");
  }
  const length = Math.round(samples.length * outputRate / inputRate);
  if (length <= 0) throw new Error("Cannot encode an empty recording");
  const wav = new ArrayBuffer(44 + length * 2);
  const v = new DataView(wav);
  const text = (offset, value) => { for (let i = 0; i < value.length; i++) v.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, "RIFF"); v.setUint32(4, 36 + length * 2, true); text(8, "WAVE");
  text(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, outputRate, true);
  v.setUint32(28, outputRate * 2, true); v.setUint16(32, 2, true);
  v.setUint16(34, 16, true); text(36, "data"); v.setUint32(40, length * 2, true);
  for (let i = 0; i < length; i++) {
    const source = i * inputRate / outputRate;
    const a = Math.min(samples.length - 1, Math.floor(source));
    const b = Math.min(samples.length - 1, a + 1);
    const sample = Math.max(-1, Math.min(1, samples[a] + (samples[b] - samples[a]) * (source - a)));
    v.setInt16(44 + i * 2, sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767), true);
  }
  return wav;
}

export class NexusDictation {
  constructor({ endpoint = DEFAULT_BRIDGE, token = "", silenceMs = 850, minSpeechMs = 300,
    previewMs = 4500, threshold = 0.015, fetcher = globalThis.fetch?.bind(globalThis) } = {}) {
    if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(endpoint)) {
      throw new Error("NexusDictation only connects to a localhost bridge");
    }
    this.endpoint = endpoint.replace(/\/$/, "");
    this.token = token;
    this.silenceMs = silenceMs;
    this.minSpeechMs = minSpeechMs;
    this.previewMs = previewMs;
    this.threshold = threshold;
    this.fetcher = fetcher;
    this.events = new Map();
    this.state = "idle";
    this.generation = 0;
  }
  on(event, fn) {
    if (typeof fn !== "function") throw new TypeError("listener must be a function");
    if (!this.events.has(event)) this.events.set(event, new Set());
    this.events.get(event).add(fn);
    return () => this.events.get(event)?.delete(fn);
  }
  emit(event, value) { for (const fn of this.events.get(event) || []) fn(value); }
  async health() {
    const r = await this.fetcher(this.endpoint + "/health", { headers: { "X-Nexus-Token": this.token } });
    if (!r.ok) throw new Error("Dictation bridge unavailable: HTTP " + r.status);
    return r.json();
  }
  async transcribeWav(wav) {
    if (!this.fetcher) throw new Error("fetch is not available");
    const r = await this.fetcher(this.endpoint + "/transcribe", {
      method: "POST", headers: { "Content-Type": "audio/wav", "X-Nexus-Token": this.token }, body: wav
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error || "Transcription failed: HTTP " + r.status);
    }
    const result = await r.json();
    if (typeof result.text !== "string") throw new Error("Invalid Photon transcription response");
    return result;
  }
  async start() {
    if (this.state !== "idle") throw new Error("Dictation is already active");
    if (!globalThis.navigator?.mediaDevices?.getUserMedia || !globalThis.AudioContext) {
      throw new Error("Microphone and AudioContext require a secure browser context");
    }
    const id = ++this.generation;
    this.state = "starting";
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: {
        echoCancellation: true, noiseSuppression: true, autoGainControl: true
      } });
      if (id !== this.generation) { this.stream.getTracks().forEach(t => t.stop()); return; }
      this.context = new AudioContext();
      await this.context.resume();
      this.source = this.context.createMediaStreamSource(this.stream);
      this.processor = this.context.createScriptProcessor(4096, 1, 1);
      this.silentSink = this.context.createGain();
      this.silentSink.gain.value = 0;
      this.source.connect(this.processor);
      this.processor.connect(this.silentSink);
      this.silentSink.connect(this.context.destination);
      this.buffers = [];
      this.samples = 0;
      this.speechMs = 0;
      this.quietMs = 0;
      this.lastPreviewMs = 0;
      this.utteranceId = globalThis.crypto?.randomUUID?.() || String(id);
      this.revision = 0;
      this.state = "listening";
      this.processor.onaudioprocess = e => {
        if (this.state !== "listening") return;
        const chunk = e.inputBuffer.getChannelData(0).slice();
        this.buffers.push(chunk);
        this.samples += chunk.length;
        let sum = 0;
        for (const x of chunk) sum += x * x;
        const ms = 1000 * chunk.length / this.context.sampleRate;
        if (Math.sqrt(sum / chunk.length) >= this.threshold) {
          this.speechMs += ms; this.quietMs = 0;
        } else if (this.speechMs > 0) this.quietMs += ms;
        if (this.speechMs > this.minSpeechMs && this.quietMs >= this.silenceMs) {
          void this.stop({ finalize: true });
        } else if (this.speechMs > this.minSpeechMs
          && this.samples / this.context.sampleRate * 1000 - this.lastPreviewMs > this.previewMs) {
          this.lastPreviewMs = this.samples / this.context.sampleRate * 1000;
          void this.preview(id);
        }
      };
      this.emit("state", "listening");
    } catch (error) {
      await this.cleanup(); this.state = "idle"; this.emit("error", error); throw error;
    }
  }
  snapshot() {
    const out = new Float32Array(this.samples);
    let at = 0;
    for (const b of this.buffers || []) { out.set(b, at); at += b.length; }
    return out;
  }
  async preview(id) {
    if (this.pendingPreview || id !== this.generation || this.state !== "listening") return;
    const revision = ++this.revision;
    const wav = encodeWav16(this.snapshot(), this.context.sampleRate);
    this.pendingPreview = this.transcribeWav(wav);
    try {
      const result = await this.pendingPreview;
      if (id === this.generation && this.state === "listening") {
        this.emit("partial", { utteranceId: this.utteranceId, revision, text: result.text, isFinal: false });
      }
    } catch (error) { this.emit("error", error); }
    finally { this.pendingPreview = null; }
  }
  async stop({ finalize = false } = {}) {
    if (this.state === "idle") return "";
    if (this.stopping) return this.stopping;
    const id = this.generation;
    const hadSpeech = this.speechMs >= this.minSpeechMs;
    const sampleRate = this.context?.sampleRate;
    const pcm = finalize && hadSpeech ? this.snapshot() : null;
    const utteranceId = this.utteranceId;
    const revision = ++this.revision;
    this.state = "finalizing";
    this.stopping = (async () => {
      await this.cleanup();
      try {
        if (!pcm) return "";
        this.emit("state", "finalizing");
        const result = await this.transcribeWav(encodeWav16(pcm, sampleRate));
        if (id === this.generation) this.emit("final", {
          utteranceId, revision, text: result.text.trim(), isFinal: true
        });
        return result.text.trim();
      } catch (error) { this.emit("error", error); throw error; }
      finally {
        if (id === this.generation) { this.state = "idle"; this.emit("state", "idle"); }
        this.stopping = null;
      }
    })();
    return this.stopping;
  }
  async cleanup() {
    if (this.processor) { this.processor.onaudioprocess = null; this.processor.disconnect(); }
    this.source?.disconnect();
    this.silentSink?.disconnect();
    this.stream?.getTracks().forEach(t => t.stop());
    if (this.context) await this.context.close().catch(() => {});
    this.processor = this.source = this.silentSink = this.stream = this.context = null;
    this.buffers = []; this.samples = 0;
  }
  async dispose() { ++this.generation; await this.stop({ finalize: false }); this.events.clear(); }
}
