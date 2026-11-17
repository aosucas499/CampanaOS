import type { AudioTone } from '../types/bell.ts';

class BellAudioEngine {
  private ctx: AudioContext | null = null;
  private activeNodes: AudioNode[] = [];
  private activeTimers: number[] = [];
  private htmlAudio: HTMLAudioElement | null = null;
  private currentToneId: string | null = null;
  private onStateChange: ((playingToneId: string | null) => void) | null = null;

  public subscribe(listener: (playingToneId: string | null) => void) {
    this.onStateChange = listener;
  }

  public getPlayingToneId(): string | null {
    return this.currentToneId;
  }

  private notify(toneId: string | null) {
    this.currentToneId = toneId;
    if (this.onStateChange) {
      this.onStateChange(toneId);
    }
  }

  private ensureContext(): AudioContext {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  public stop() {
    for (const timer of this.activeTimers) {
      window.clearTimeout(timer);
    }
    this.activeTimers = [];

    for (const node of this.activeNodes) {
      try {
        if ('stop' in node && typeof (node as OscillatorNode).stop === 'function') {
          (node as OscillatorNode).stop();
        }
        node.disconnect();
      } catch {
        // Node already stopped
      }
    }
    this.activeNodes = [];

    if (this.htmlAudio) {
      this.htmlAudio.pause();
      this.htmlAudio.currentTime = 0;
      this.htmlAudio = null;
    }

    this.notify(null);
  }

  public playTone(tone: AudioTone, volumePercent = 85) {
    this.stop();

    const gainValue = Math.max(0.02, Math.min(1, volumePercent / 100));

    if (tone.category === 'custom' && (tone.dataUrl || tone.fileName)) {
      const audioSrc = tone.dataUrl ?? `/audio/${encodeURIComponent(tone.fileName ?? '')}`;
      const audio = new Audio(audioSrc);
      audio.volume = gainValue;
      this.htmlAudio = audio;
      this.notify(tone.id);
      audio.onended = () => {
        if (this.currentToneId === tone.id) {
          this.notify(null);
        }
      };
      audio.onerror = () => {
        if (this.currentToneId === tone.id) {
          this.notify(null);
        }
      };
      void audio.play().catch(() => {
        this.notify(null);
      });
      return;
    }

    const ctx = this.ensureContext();
    this.notify(tone.id);

    const preset = tone.synthPreset ?? 'classic-bell';

    if (preset === 'classic-bell') {
      this.playElectricSchoolBell(ctx, gainValue, 2.8, tone.id);
    } else if (preset === 'westminster') {
      this.playWestminsterChime(ctx, gainValue, tone.id);
    } else if (preset === 'soft-chime') {
      this.playSoftChime(ctx, gainValue, tone.id);
    } else if (preset === 'recess-bell') {
      this.playRecessBell(ctx, gainValue, tone.id);
    } else if (preset === 'evacuation') {
      this.playEvacuationSiren(ctx, gainValue, tone.id);
    }
  }

  private scheduleAutoStop(durationMs: number, toneId: string) {
    const t = window.setTimeout(() => {
      if (this.currentToneId === toneId) {
        this.stop();
      }
    }, durationMs);
    this.activeTimers.push(t);
  }

  private playBellStrike(ctx: AudioContext, startTime: number, freq: number, duration: number, volume: number) {
    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(0.0001, startTime);
    masterGain.gain.exponentialRampToValueAtTime(volume, startTime + 0.012);
    masterGain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
    masterGain.connect(ctx.destination);

    const partials = [
      { ratio: 1, amp: 0.6 },
      { ratio: 2.0, amp: 0.32 },
      { ratio: 2.76, amp: 0.24 },
      { ratio: 4.07, amp: 0.14 },
    ];

    for (const p of partials) {
      const osc = ctx.createOscillator();
      const pGain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq * p.ratio, startTime);
      pGain.gain.setValueAtTime(p.amp, startTime);
      osc.connect(pGain);
      pGain.connect(masterGain);
      osc.start(startTime);
      osc.stop(startTime + duration + 0.05);
      this.activeNodes.push(osc, pGain);
    }
    this.activeNodes.push(masterGain);
  }

  private playElectricSchoolBell(ctx: AudioContext, volume: number, durationSec: number, toneId: string) {
    const now = ctx.currentTime;
    const strikes = Math.floor(durationSec * 16);
    for (let i = 0; i < strikes; i++) {
      const t = now + i * 0.062;
      this.playBellStrike(ctx, t, 1180 + (i % 2) * 18, 0.19, volume * 0.42);
    }
    this.playBellStrike(ctx, now + strikes * 0.062, 1180, 1.0, volume * 0.35);
    this.scheduleAutoStop((durationSec + 1.1) * 1000, toneId);
  }

  private playWestminsterChime(ctx: AudioContext, volume: number, toneId: string) {
    const notes = [659.25, 523.25, 587.33, 392.0, 392.0, 587.33, 659.25, 523.25];
    const now = ctx.currentTime;
    notes.forEach((freq, idx) => {
      const gap = idx >= 4 ? 0.55 : 0;
      const start = now + idx * 0.58 + gap;
      this.playBellStrike(ctx, start, freq, 1.5, volume * 0.55);
    });
    this.scheduleAutoStop(6600, toneId);
  }

  private playSoftChime(ctx: AudioContext, volume: number, toneId: string) {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    const now = ctx.currentTime;
    notes.forEach((freq, idx) => {
      this.playBellStrike(ctx, now + idx * 0.28, freq, 1.6, volume * 0.5);
    });
    this.scheduleAutoStop(3000, toneId);
  }

  private playRecessBell(ctx: AudioContext, volume: number, toneId: string) {
    const now = ctx.currentTime;
    this.playBellStrike(ctx, now, 880, 1.2, volume * 0.55);
    this.playBellStrike(ctx, now + 0.35, 1174.66, 1.5, volume * 0.55);
    this.scheduleAutoStop(2200, toneId);
  }

  private playEvacuationSiren(ctx: AudioContext, volume: number, toneId: string) {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    gain.gain.setValueAtTime(volume * 0.3, now);

    const cycles = 6;
    for (let i = 0; i < cycles; i++) {
      const base = now + i * 0.8;
      osc.frequency.setValueAtTime(620, base);
      osc.frequency.linearRampToValueAtTime(980, base + 0.4);
      osc.frequency.linearRampToValueAtTime(620, base + 0.8);
    }

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + cycles * 0.8);
    this.activeNodes.push(osc, gain);
    this.scheduleAutoStop(cycles * 800 + 100, toneId);
  }
}

export const bellAudio = new BellAudioEngine();
