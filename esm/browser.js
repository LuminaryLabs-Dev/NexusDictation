// Browser-only NexusDictation adapter. Redux/Photon remains the native backend.
// This path uses browser-compatible NVIDIA Parakeet TDT v3 ONNX via parakeet.js.
export const BROWSER_ASR_MODEL = "efederici/parakeet-tdt-0.6b-v3-onnx-int4";
export const BROWSER_ASR_CARD = "https://huggingface.co/" + BROWSER_ASR_MODEL;
const BASE = BROWSER_ASR_CARD + "/resolve/main";
const PARAKET_LIB = "https://esm.sh/parakeet.js@1.3.1?bundle";
function resample(pcm, src, dst=16000) {
  if (!src || !pcm.length) return new Float32Array();
  if (src === dst) return pcm;
  const out = new Float32Array(Math.round(pcm.length * dst / src));
  for(let i=0;i<out.length;i++){
    const at=i*src/dst, a=Math.min(pcm.length-1,Math.floor(at)),b=Math.min(pcm.length-1,a+1),f=at-a;
    out[i]=pcm[a]*(1-f)+pcm[b]*f;
  }
  return out;
}
export class NexusDictationBrowser {
  constructor({minSpeechMs=320,silenceMs=920,maxSpeechMs=27000,threshold=.013,loader}={}){
    Object.assign(this,{minSpeechMs,silenceMs,maxSpeechMs,threshold,loader});
    this.events=new Map(); this.state="idle"; this.run=0; this.ready=false;
  }
  on(name,fn){
    if(!this.events.has(name))this.events.set(name,new Set());
    this.events.get(name).add(fn); return ()=>this.events.get(name)?.delete(fn);
  }
  emit(name,payload){for(const fn of this.events.get(name)||[])fn(payload);}
  async health(){await this.load();return {ready:true,model:BROWSER_ASR_MODEL,backend:"webgpu"};}
  async load(){
    if(this.ready)return;
    if(this.loading)return this.loading;
    if(!globalThis.navigator?.gpu)throw new Error("NexusDictation browser backend requires WebGPU");
    this.emit("status",{phase:"loading",detail:"Downloading Parakeet WebGPU (~409 MB)"});
    this.loading=(async()=>{
      const {fromUrls}=this.loader?await this.loader():await import(PARAKET_LIB);
      this.model=await fromUrls({
        encoderUrl:BASE+"/encoder-model.int4.onnx",
        decoderUrl:BASE+"/decoder_joint-model.int8.onnx",
        tokenizerUrl:BASE+"/vocab.txt",
        preprocessorBackend:"js",backend:"webgpu"
      });
      this.ready=true;this.emit("status",{phase:"ready",detail:"Parakeet WebGPU ready"});
    })();
    try{await this.loading;}catch(error){this.loading=null;throw error;}
  }
  async start(){
    if(this.state!=="idle")throw new Error("Dictation microphone already active");
    if(!globalThis.navigator?.mediaDevices?.getUserMedia||!globalThis.AudioContext)
      throw new Error("Microphone requires HTTPS and AudioWorklet support");
    await this.load();
    const run=++this.run;this.state="starting";
    try{
      this.stream=await navigator.mediaDevices.getUserMedia({audio:{
        echoCancellation:true,noiseSuppression:true,autoGainControl:true
      }});
      if(run!==this.run){this.stream.getTracks().forEach(t=>t.stop());return;}
      this.context=new AudioContext();await this.context.resume();
      this.source=this.context.createMediaStreamSource(this.stream);
      const processor=`class NexusCapture extends AudioWorkletProcessor {
        process(inputs,outputs) {
          const pcm=inputs[0]?.[0];if(pcm)this.port.postMessage(pcm.slice());
          for(const ch of outputs[0]||[])ch.fill(0);
          return true;
        }
      }registerProcessor("nexus-dictation-capture",NexusCapture);`;
      const blob=URL.createObjectURL(new Blob([processor],{type:"application/javascript"}));
      try{await this.context.audioWorklet.addModule(blob);}finally{URL.revokeObjectURL(blob);}
      this.worklet=new AudioWorkletNode(this.context,"nexus-dictation-capture");
      this.silent=this.context.createGain();this.silent.gain.value=0;
      this.source.connect(this.worklet);this.worklet.connect(this.silent);
      this.silent.connect(this.context.destination);
      this.chunks=[];this.samples=0;this.speechMs=0;this.quietMs=0;
      this.rate=this.context.sampleRate;this.utteranceId=crypto.randomUUID();
      this.worklet.port.onmessage=({data})=>this.accept(data,run);
      this.state="listening";this.emit("state","listening");
    }catch(error){await this.cleanup();this.state="idle";this.emit("error",error);throw error;}
  }
  accept(chunk,run){
    if(this.state!=="listening"||run!==this.run)return;
    this.chunks.push(chunk);this.samples+=chunk.length;
    let power=0;for(const x of chunk)power+=x*x;
    const ms=chunk.length/this.rate*1000;
    if(Math.sqrt(power/chunk.length)>this.threshold){this.speechMs+=ms;this.quietMs=0;}
    else if(this.speechMs)this.quietMs+=ms;
    if(this.speechMs>=this.minSpeechMs&&(this.quietMs>=this.silenceMs||
       this.samples/this.rate*1000>=this.maxSpeechMs)){
      void this.stop({finalize:true}).catch(e=>this.emit("error",e));
    }else if(this.samples/this.rate*1000>this.maxSpeechMs&&!this.speechMs){
      this.chunks=[];this.samples=0;
    }
  }
  snapshot(){
    const pcm=new Float32Array(this.samples);let offset=0;
    for(const chunk of this.chunks||[]){pcm.set(chunk,offset);offset+=chunk.length;}
    return pcm;
  }
  async stop({finalize=false}={}){
    if(this.state==="idle")return "";
    if(this.stopping)return this.stopping;
    const run=this.run,pcm=finalize&&this.speechMs>=this.minSpeechMs?this.snapshot():null;
    const rate=this.rate,utteranceId=this.utteranceId;
    this.state="finalizing";
    if(!finalize)++this.run;
    this.stopping=(async()=>{
      try{
        await this.cleanup();
        if(!pcm||run!==this.run)return "";
        this.emit("status",{phase:"transcribing",detail:"Recognizing speech"});
        const result=await this.model.transcribe(resample(pcm,rate),16000);
        const text=String(result.utterance_text??result.text??"").trim();
        if(run===this.run&&text)this.emit("final",{utteranceId,text,revision:1,isFinal:true});
        return text;
      }catch(error){this.emit("error",error);throw error;}
      finally{this.state="idle";this.stopping=null;}
    })();
    return this.stopping;
  }
  async cleanup(){
    if(this.worklet){this.worklet.port.onmessage=null;this.worklet.disconnect();}
    this.source?.disconnect();this.silent?.disconnect();
    this.stream?.getTracks().forEach(t=>t.stop());
    if(this.context)await this.context.close().catch(()=>{});
    this.worklet=this.source=this.silent=this.stream=this.context=null;
    this.chunks=[];this.samples=0;
  }
  async dispose(){await this.stop({finalize:false});++this.run;this.events.clear();}
}
