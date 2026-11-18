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

function dataUrlToBlobUrl(dataUrl: string): string | null {
  try {
    const commaIdx = dataUrl.indexOf(',');
    if (commaIdx === -1) return null;
    const header = dataUrl.slice(0, commaIdx);
    const base64 = dataUrl.slice(commaIdx + 1);
    const mimeMatch = /^data:([^;]+);base64/i.exec(header);
    const mime = mimeMatch ? mimeMatch[1] : 'audio/mpeg';
    const binary = window.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return URL.createObjectURL(new Blob([bytes], { type: mime }));
  } catch {
    return null;
  }
}

class BellAudioEngine {
  private ctx: AudioContext | null = null;
  private activeNodes: AudioNode[] = [];
  private activeTimers: number[] = [];
  private progressInterval: number | null = null;
  private htmlAudio: HTMLAudioElement | null = null;
  private activeObjectUrl: string | null = null;
  private currentToneId: string | null = null;
  private playToken = 0;
  private onStateChange: ((playingToneId: string | null) => void) | null = null;

  private bufferCache = new Map<string, AudioBuffer>();
  private activeBufferSession: {
    tone: AudioTone;
    buffer: AudioBuffer;
    gainValue: number;
    playDurationSec: number | null;
    onProgress?: (currentSec: number, totalSec: number) => void;
    source: AudioBufferSourceNode;
  } | null = null;

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

  private clearActivePlaybackOnly() {
    for (const timer of this.activeTimers) {
      window.clearTimeout(timer);
    }
    this.activeTimers = [];

    if (this.progressInterval !== null) {
      window.clearInterval(this.progressInterval);
      this.progressInterval = null;
    }

    if (this.activeBufferSession) {
      this.activeBufferSession.source.onended = null;
      this.activeBufferSession = null;
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
      this.htmlAudio.src = '';
      this.htmlAudio = null;
    }

    if (this.activeObjectUrl) {
      URL.revokeObjectURL(this.activeObjectUrl);
      this.activeObjectUrl = null;
    }
  }

  public stop() {
    this.playToken++;
    this.clearActivePlaybackOnly();
    this.notify(null);
  }

  public seek(second: number) {
    if (this.activeBufferSession) {
      const { tone, buffer, gainValue, playDurationSec, onProgress } = this.activeBufferSession;
      const target = Math.max(0, Math.min(second, Math.max(0, buffer.duration - 0.15)));
      this.startBufferPlayback(tone, buffer, gainValue, target, playDurationSec, onProgress);
      return;
    }
    if (this.htmlAudio) {
      const dur = Number.isFinite(this.htmlAudio.duration) ? this.htmlAudio.duration : second;
      this.htmlAudio.currentTime = Math.max(0, Math.min(second, Math.max(0, dur - 0.1)));
    }
  }

  public seekHtmlAudio(second: number) {
    this.seek(second);
  }

  private startBufferPlayback(
    tone: AudioTone,
    buffer: AudioBuffer,
    gainValue: number,
    startSec: number,
    playDurationSec: number | null,
    onProgress?: (currentSec: number, totalSec: number) => void,
  ) {
    const token = ++this.playToken;
    this.clearActivePlaybackOnly();

    const ctx = this.ensureContext();
    const totalDur = Math.max(0.25, buffer.duration);
    const clampedStart = startSec > 0 ? Math.min(startSec, Math.max(0, totalDur - 0.25)) : 0;
    const remaining = Math.max(0.1, totalDur - clampedStart);
    const effectiveDur = playDurationSec !== null ? Math.min(playDurationSec, remaining) : remaining;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(gainValue, ctx.currentTime);
    source.connect(gain);
    gain.connect(ctx.destination);

    this.activeNodes.push(source, gain);
    this.activeBufferSession = {
      tone,
      buffer,
      gainValue,
      playDurationSec,
      onProgress,
      source,
    };
    this.notify(tone.id);

    source.onended = () => {
      if (this.playToken === token) {
        this.stop();
      }
    };

    if (playDurationSec !== null) {
      source.start(0, clampedStart, effectiveDur);
    } else {
      source.start(0, clampedStart);
    }

    if (onProgress) {
      const startedAtMs = performance.now();
      onProgress(clampedStart, totalDur);
      this.progressInterval = window.setInterval(() => {
        if (this.playToken !== token) return;
        const elapsed = (performance.now() - startedAtMs) / 1000;
        const currentPos = Math.min(clampedStart + elapsed, clampedStart + effectiveDur, totalDur);
        onProgress(currentPos, totalDur);
      }, 100);
    }
  }

  private playWithHtmlAudio(
    tone: AudioTone,
    gainValue: number,
    startSec: number,
    playDurationSec: number | null,
    onProgress?: (currentSec: number, totalSec: number) => void,
    token?: number,
  ) {
    const activeToken = token ?? ++this.playToken;
    if (this.playToken !== activeToken) return;

    let srcUrl = tone.fileName ? `/audio/${encodeURIComponent(tone.fileName)}` : '';
    if (tone.dataUrl) {
      const blobUrl = dataUrlToBlobUrl(tone.dataUrl);
      if (blobUrl) {
        this.activeObjectUrl = blobUrl;
        srcUrl = blobUrl;
      } else if (!srcUrl) {
        srcUrl = tone.dataUrl;
      }
    }

    if (!srcUrl) {
      this.stop();
      return;
    }

    const audio = new Audio();
    audio.preload = 'auto';
    audio.volume = gainValue;
    audio.src = srcUrl;
    this.htmlAudio = audio;
    this.notify(tone.id);

    let started = false;

    const beginFromOffset = async () => {
      if (started || this.playToken !== activeToken || this.htmlAudio !== audio) return;
      started = true;

      const totalDur =
        Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : tone.durationSec || 10;
      const clampedStart = startSec > 0 ? Math.min(startSec, Math.max(0, totalDur - 0.25)) : 0;

      if (clampedStart > 0) {
        await new Promise<void>((resolve) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            audio.removeEventListener('seeked', finish);
            resolve();
          };
          audio.addEventListener('seeked', finish, { once: true });
          try {
            audio.currentTime = clampedStart;
          } catch {
            finish();
            return;
          }
          window.setTimeout(finish, 450);
        });
      }

      if (this.playToken !== activeToken || this.htmlAudio !== audio) return;

      const ensureSeekOnPlay = () => {
        if (clampedStart > 0 && audio.currentTime < clampedStart - 0.75) {
          try {
            audio.currentTime = clampedStart;
          } catch {
            // Ignore
          }
        }
      };
      audio.addEventListener('playing', ensureSeekOnPlay, { once: true });

      if (onProgress) {
        onProgress(clampedStart, totalDur);
        this.progressInterval = window.setInterval(() => {
          if (this.playToken !== activeToken || this.htmlAudio !== audio) return;
          const durNow = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : totalDur;
          onProgress(audio.currentTime, durNow);
          if (playDurationSec !== null && audio.currentTime >= clampedStart + playDurationSec) {
            this.stop();
          }
        }, 100);
      }

      if (playDurationSec !== null) {
        const stopTimer = window.setTimeout(() => {
          if (this.playToken === activeToken && this.htmlAudio === audio) {
            this.stop();
          }
        }, playDurationSec * 1000 + 120);
        this.activeTimers.push(stopTimer);
      }

      try {
        await audio.play();
      } catch {
        if (this.playToken === activeToken && this.htmlAudio === audio) {
          this.stop();
        }
      }
    };

    audio.onended = () => {
      if (this.playToken === activeToken) {
        this.stop();
      }
    };
    audio.onerror = () => {
      if (this.playToken === activeToken) {
        this.stop();
      }
    };

    if (audio.readyState >= 3) {
      void beginFromOffset();
    } else {
      audio.addEventListener('canplay', () => void beginFromOffset(), { once: true });
      audio.load();
    }
  }

  public playTone(tone: AudioTone, volumePercent = 85, options: PlayToneOptions = {}) {
    this.stop();

    const token = this.playToken;
    const gainValue = Math.max(0.02, Math.min(1, volumePercent / 100));
    const startSec = Math.max(0, Number(options.startSec) || 0);
    const playDurationSec =
      options.playDurationSec != null && Number(options.playDurationSec) > 0
        ? Number(options.playDurationSec)
        : null;

    if (tone.category === 'custom' && (tone.dataUrl || tone.fileName)) {
      const ctx = this.ensureContext();
      const cacheKey = `${tone.id}:${tone.fileName ?? ''}`;
      const cached = this.bufferCache.get(cacheKey);

      if (cached) {
        this.startBufferPlayback(
          tone,
          cached,
          gainValue,
          startSec,
          playDurationSec,
          options.onProgress,
        );
        return;
      }

      this.notify(tone.id);
      const audioSrc = tone.dataUrl ?? `/audio/${encodeURIComponent(tone.fileName ?? '')}`;

      void (async () => {
        try {
          const response = await fetch(audioSrc);
          if (!response.ok) throw new Error('Audio fetch failed');
          const arrayBuf = await response.arrayBuffer();
          if (this.playToken !== token) return;

          const decoded = await ctx.decodeAudioData(arrayBuf);
          if (this.playToken !== token) return;

          if (this.bufferCache.size >= 6) {
            const firstKey = this.bufferCache.keys().next().value;
            if (firstKey) this.bufferCache.delete(firstKey);
          }
          this.bufferCache.set(cacheKey, decoded);

          this.startBufferPlayback(
            tone,
            decoded,
            gainValue,
            startSec,
            playDurationSec,
            options.onProgress,
          );
        } catch {
          if (this.playToken === token) {
            this.playWithHtmlAudio(
              tone,
              gainValue,
              startSec,
              playDurationSec,
              options.onProgress,
              token,
            );
          }
        }
      })();
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
    this.scheduleAutoStop(capMs, tone.id, token);

    if (options.onProgress) {
      const startedAt = Date.now();
      const totalSec = capMs / 1000;
      options.onProgress(0, totalSec);
      this.progressInterval = window.setInterval(() => {
        if (this.playToken !== token || this.currentToneId !== tone.id) return;
        const elapsed = (Date.now() - startedAt) / 1000;
        options.onProgress?.(Math.min(elapsed, totalSec), totalSec);
      }, 100);
    }
  }

  private scheduleAutoStop(durationMs: number, toneId: string, token: number) {
    const t = window.setTimeout(() => {
      if (this.playToken === token && this.currentToneId === toneId) {
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
