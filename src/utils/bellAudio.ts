import type { AudioTone } from '../types/bell.ts';

export interface PlayToneOptions {
  startSec?: number;
  playDurationSec?: number | null;
  onProgress?: (currentSec: number, totalSec: number) => void;
}

export function formatSecondsClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

class BellAudioEngine {
  private ctx: AudioContext | null = null;
  private activeNodes: AudioNode[] = [];
  private activeTimers: number[] = [];
  private progressInterval: number | null = null;
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
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
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

    if (this.progressInterval !== null) {
      window.clearInterval(this.progressInterval);
      this.progressInterval = null;
    }

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
      this.htmlAudio.onended = null;
      this.htmlAudio.onerror = null;
      this.htmlAudio.pause();
      this.htmlAudio.currentTime = 0;
      this.htmlAudio = null;
    }

    this.notify(null);
  }

  public seekHtmlAudio(second: number) {
    if (!this.htmlAudio) return;
    const dur = Number.isFinite(this.htmlAudio.duration) ? this.htmlAudio.duration : second;
    this.htmlAudio.currentTime = Math.max(0, Math.min(second, Math.max(0, dur - 0.1)));
  }

  public playTone(tone: AudioTone, volumePercent = 85, options: PlayToneOptions = {}) {
    this.stop();

    const gainValue = Math.max(0.02, Math.min(1, volumePercent / 100));
    const startSec = Math.max(0, Number(options.startSec) || 0);
    const playDurationSec =
      options.playDurationSec != null && Number(options.playDurationSec) > 0
        ? Number(options.playDurationSec)
        : null;

    if (tone.category === 'custom' && (tone.dataUrl || tone.fileName)) {
      const audioSrc = tone.dataUrl ?? `/audio/${encodeURIComponent(tone.fileName ?? '')}`;
      const audio = new Audio(audioSrc);
      audio.volume = gainValue;
      this.htmlAudio = audio;
      this.notify(tone.id);

      const startPlaybackFromOffset = () => {
        if (this.htmlAudio !== audio || this.currentToneId !== tone.id) return;
        const totalDur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : tone.durationSec || 10;
        const clampedStart = startSec > 0 ? Math.min(startSec, Math.max(0, totalDur - 0.25)) : 0;

        if (clampedStart > 0) {
          try {
            audio.currentTime = clampedStart;
          } catch {
            // Ignore seek failure if stream isn't seekable yet
          }
        }

        if (options.onProgress) {
          options.onProgress(clampedStart, totalDur);
          this.progressInterval = window.setInterval(() => {
            if (this.htmlAudio !== audio || this.currentToneId !== tone.id) return;
            const durNow = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : totalDur;
            options.onProgress?.(audio.currentTime, durNow);
            if (playDurationSec !== null && audio.currentTime >= clampedStart + playDurationSec) {
              this.stop();
            }
          }, 100);
        }

        if (playDurationSec !== null) {
          const stopTimer = window.setTimeout(() => {
            if (this.currentToneId === tone.id && this.htmlAudio === audio) {
              this.stop();
            }
          }, playDurationSec * 1000 + 80);
          this.activeTimers.push(stopTimer);
        }

        void audio.play().catch(() => {
          if (this.htmlAudio === audio) {
            this.stop();
          }
        });
      };

      audio.onended = () => {
        if (this.currentToneId === tone.id) {
          this.stop();
        }
      };
      audio.onerror = () => {
        if (this.currentToneId === tone.id) {
          this.stop();
        }
      };

      if (audio.readyState >= 1) {
        startPlaybackFromOffset();
      } else {
        audio.addEventListener('loadedmetadata', startPlaybackFromOffset, { once: true });
        audio.load();
      }
      return;
    }

    const ctx = this.ensureContext();
    this.notify(tone.id);

    const preset = tone.synthPreset ?? 'classic-bell';
    let naturalDurationMs = 3000;

    if (preset === 'classic-bell') {
      naturalDurationMs = 3900;
      this.playElectricSchoolBell(ctx, gainValue, 2.8, tone.id);
    } else if (preset === 'westminster') {
      naturalDurationMs = 6600;
      this.playWestminsterChime(ctx, gainValue, tone.id);
    } else if (preset === 'soft-chime') {
      naturalDurationMs = 3000;
      this.playSoftChime(ctx, gainValue, tone.id);
    } else if (preset === 'recess-bell') {
      naturalDurationMs = 2200;
      this.playRecessBell(ctx, gainValue, tone.id);
    } else if (preset === 'evacuation') {
      naturalDurationMs = 4900;
      this.playEvacuationSiren(ctx, gainValue, tone.id);
    }

    const capMs =
      playDurationSec !== null ? Math.min(naturalDurationMs, Math.max(300, playDurationSec * 1000)) : naturalDurationMs;
    this.scheduleAutoStop(capMs, tone.id);

    if (options.onProgress) {
      const startedAt = Date.now();
      const totalSec = capMs / 1000;
      options.onProgress(0, totalSec);
      this.progressInterval = window.setInterval(() => {
        if (this.currentToneId !== tone.id) return;
        const elapsed = (Date.now() - startedAt) / 1000;
        options.onProgress?.(Math.min(elapsed, totalSec), totalSec);
      }, 100);
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

  private playElectricSchoolBell(ctx: AudioContext, volume: number, durationSec: number, _toneId: string) {
    const now = ctx.currentTime;
    const strikes = Math.floor(durationSec * 16);
    for (let i = 0; i < strikes; i++) {
      const t = now + i * 0.062;
      this.playBellStrike(ctx, t, 1180 + (i % 2) * 18, 0.19, volume * 0.42);
    }
    this.playBellStrike(ctx, now + strikes * 0.062, 1180, 1.0, volume * 0.35);
  }

  private playWestminsterChime(ctx: AudioContext, volume: number, _toneId: string) {
    const notes = [659.25, 523.25, 587.33, 392.0, 392.0, 587.33, 659.25, 523.25];
    const now = ctx.currentTime;
    notes.forEach((freq, idx) => {
      const gap = idx >= 4 ? 0.55 : 0;
      const start = now + idx * 0.58 + gap;
      this.playBellStrike(ctx, start, freq, 1.5, volume * 0.55);
    });
  }

  private playSoftChime(ctx: AudioContext, volume: number, _toneId: string) {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    const now = ctx.currentTime;
    notes.forEach((freq, idx) => {
      this.playBellStrike(ctx, now + idx * 0.28, freq, 1.6, volume * 0.5);
    });
  }

  private playRecessBell(ctx: AudioContext, volume: number, _toneId: string) {
    const now = ctx.currentTime;
    this.playBellStrike(ctx, now, 880, 1.2, volume * 0.55);
    this.playBellStrike(ctx, now + 0.35, 1174.66, 1.5, volume * 0.55);
  }

  private playEvacuationSiren(ctx: AudioContext, volume: number, _toneId: string) {
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
  }
}

export const bellAudio = new BellAudioEngine();
