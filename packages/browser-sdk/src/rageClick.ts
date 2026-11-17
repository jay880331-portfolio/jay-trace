import { type PointerSample, sameArea } from "./dom.js";

export interface RageClickDetectorOptions {
  threshold: number;
  windowMs: number;
  radiusPx: number;
}

export interface RageClickResult {
  detected: boolean;
  count: number;
}

export class RageClickDetector {
  private readonly samples: PointerSample[] = [];

  constructor(private readonly options: RageClickDetectorOptions) {}

  record(sample: PointerSample): RageClickResult {
    const cutoff = sample.at - this.options.windowMs;
    while (this.samples.length > 0 && this.samples[0]?.at !== undefined && this.samples[0].at < cutoff) {
      this.samples.shift();
    }

    this.samples.push(sample);
    const count = this.samples.filter((item) => sameArea(item, sample, this.options.radiusPx)).length;

    return {
      detected: count >= this.options.threshold,
      count
    };
  }
}
