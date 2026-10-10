# NexusDictation

Local speech-to-text ESM module using [moondream/parakeet-redux](https://huggingface.co/moondream/parakeet-redux) and Photon. Independent of NexusConversationalist and NexusVoice.

## Mac setup

Requires Python 3.11+, an Apple Silicon MacBook (or supported CPU), and a Chromium browser. Model weights download from Hugging Face the first time Photon starts.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install "moondream>=2.4.0"
python3 native/bridge.py --device cpu
```

The bridge prints a random session token. Copy it into the NexusConversationalist studio. It binds to **127.0.0.1:47832 only**, and allows origin `http://127.0.0.1:4173` by default. For an alternative local UI, pass `--allow-origin http://localhost:4173` (repeatable). Do not open the port to public networks.

## ESM API

```js
import { NexusDictation } from "./esm/index.js";
const dictation = new NexusDictation({ token: "<token from local bridge>" });
dictation.on("partial", event => console.log("preview:", event.text));
dictation.on("final", event => console.log("final:", event.text));
await dictation.start(); // needs microphone permission and user gesture
// after silence, emits final and stops capture; restart for another turn
```

The browser captures microphone samples, segments after silence, resamples to mono 16kHz WAV, and sends one utterance to the local Photon bridge. Four-second previews are replaceable hypotheses, not commands. Final transcript events are the only authoritative data.

### Delivery

Plain JS ESM source at `esm/index.js`, importable by local URL or after a published revision from jsDelivr:
`https://cdn.jsdelivr.net/gh/LuminaryLabs-Dev/NexusDictation@main/esm/index.js`. Pin a commit SHA or release tag for production.

## Boundaries

* Photon is native, **not WebGPU**. This avoids falsely claiming the Redux packed weights run in browser WebGPU.
* No audio is stored by default. Transcription requests are limited to 12 MB.
* No microphone request occurs until `start()`.
* Model download and actual inference require the local Photon environment; unit tests mock the bridge.
* Model and runtime redistribution terms should be reviewed before shipping compiled products.

## Test

`node --test tests/*.test.js`
