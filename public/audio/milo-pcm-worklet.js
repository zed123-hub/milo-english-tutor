// Capture mono PCM in 100 ms frames, preserving fractional resampling state across callbacks.
class MiloPCM extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const rate = options.processorOptions.targetRate;
    this.ratio = sampleRate / rate;
    this.frame = new Int16Array(rate / 10);
    this.index = 0;
    this.weight = 0;
    this.sum = 0;
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (const sample of input) {
      let left = 1;
      while (left > 1e-8) {
        const used = Math.min(left, this.ratio - this.weight);
        this.sum += sample * used;
        this.weight += used;
        left -= used;
        if (this.weight >= this.ratio - 1e-8) {
          const value = Math.max(-1, Math.min(1, this.sum / this.ratio));
          this.frame[this.index++] = Math.round(
            value * (value < 0 ? 32768 : 32767),
          );
          this.weight = 0;
          this.sum = 0;
          if (this.index === this.frame.length) {
            const pcm = new ArrayBuffer(this.frame.length * 2);
            const view = new DataView(pcm);
            for (let i = 0; i < this.frame.length; i++)
              view.setInt16(i * 2, this.frame[i], true);
            this.port.postMessage(pcm, [pcm]);
            this.index = 0;
          }
        }
      }
    }
    return true;
  }
}
registerProcessor('milo-pcm', MiloPCM);
