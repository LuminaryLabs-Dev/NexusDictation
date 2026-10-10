# NexusDictation browser backend
The standalone Redux / Photon local Python bridge remains supported for native macOS use.

For **static GitHub Pages**, import the browser ESM module:

```js
import { NexusDictationBrowser } from "https://cdn.jsdelivr.net/gh/LuminaryLabs-Dev/NexusDictation@<pin-a-commit-sha>/esm/browser.js";
const dictator = new NexusDictationBrowser();
await dictator.health(); // Downloads model, requires WebGPU.
dictator.on("final", event => console.log(event.text));
await dictator.start();
```

This uses the browser-compatible **Parakeet TDT v3** ONNX model instead of native-only packed Parakeet Redux. [Model weights](https://huggingface.co/efederici/parakeet-tdt-0.6b-v3-onnx-int4) (~409 MB), accelerated with `parakeet.js` using WebGPU encoder and WASM decoder. Audio capture uses an AudioWorklet and is local-only. Microphone input is never uploaded to a server. Transcription happens after silence, and final text alone is sent to the conversation controller.

Initial network access and a WebGPU browser are required; runtime behavior and accuracy must be checked on the target MacBook before production use.
