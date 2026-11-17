import { useState } from 'react';
import { Check, Copy, Download, RefreshCw, Terminal } from 'lucide-react';
import type { BellAppState } from '../types/bell.ts';
import {
  generateInstallScript,
  generateReadme,
  generateRingServiceTemplate,
  generateScheduleJson,
  generateSudoersRule,
  generateSyncTimersPy,
  generateTimbreRunnerPy,
  generateTimerPreviewUnits,
  generateWebPanelPy,
  generateWebServiceUnit,
} from '../utils/linuxTemplates.ts';

interface LinuxDeployViewProps {
  state: BellAppState;
  onDownloadZip: () => void;
  onSyncTimers: () => Promise<void>;
}

type InspectFileKey =
  | 'timers'
  | 'ringService'
  | 'runner'
  | 'sync'
  | 'webPanel'
  | 'webService'
  | 'sudoers'
  | 'install'
  | 'schedule'
  | 'readme';

export function LinuxDeployView({ state, onDownloadZip, onSyncTimers }: LinuxDeployViewProps) {
  const [activeFile, setActiveFile] = useState<InspectFileKey>('install');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const mdns = state.security.hostnameMdns || 'campana-escolar';
  const port = state.security.webPort || 3000;

  const files: Record<InspectFileKey, { label: string; filename: string; content: string }> = {
    install: {
      label: 'install.sh',
      filename: 'install.sh',
      content: generateInstallScript(state),
    },
    timers: {
      label: 'campana-ring-*.timer',
      filename: 'campana-ring-*.timer',
      content: generateTimerPreviewUnits(state),
    },
    ringService: {
      label: 'campana-ring@.service',
      filename: 'campana-ring@.service',
      content: generateRingServiceTemplate(state),
    },
    runner: {
      label: 'timbre_runner.py',
      filename: 'timbre_runner.py',
      content: generateTimbreRunnerPy(state),
    },
    sync: {
      label: 'sync_timers.py',
      filename: 'sync_timers.py',
      content: generateSyncTimersPy(),
    },
    webPanel: {
      label: 'web_panel.py',
      filename: 'web_panel.py',
      content: generateWebPanelPy(),
    },
    webService: {
      label: 'campana-web.service',
      filename: 'campana-web.service',
      content: generateWebServiceUnit(state),
    },
    sudoers: {
      label: 'campana-os.sudoers',
      filename: 'campana-os.sudoers',
      content: generateSudoersRule(state),
    },
    schedule: {
      label: 'schedule.json',
      filename: 'schedule.json',
      content: generateScheduleJson(state),
    },
    readme: {
      label: 'README.md',
      filename: 'README.md',
      content: generateReadme(state),
    },
  };

  const quickCommands = `unzip campana-os-linux-rpi.zip -d campana-os
cd campana-os
sudo bash install.sh
systemctl list-timers 'campana-ring-*'`;

  const copyText = async (id: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedId(id);
    window.setTimeout(() => setCopiedId(null), 2000);
  };

  const handleSync = async () => {
    setSyncing(true);
    await onSyncTimers();
    setSyncing(false);
  };

  const currentFile = files[activeFile];

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            Despliegue Linux y Raspberry Pi (systemd .timer + Web Local)
          </h1>
          <p className="text-sm text-slate-500">
            Paquete autónomo en Python 3 (sin Node.js) compatible con Ubuntu 20.04, 22.04, 24.04 y Raspberry Pi OS (arm64 / armhf).
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => void handleSync()}
            disabled={syncing}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg border border-slate-300 bg-white text-slate-800 text-sm font-medium hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
          >
            <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
            Sincronizar timers ahora
          </button>

          <button
            type="button"
            onClick={onDownloadZip}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-4 h-4" />
            Descargar paquete (.zip)
          </button>
        </div>
      </div>

      {/* Systemd Sync, LAN Access & Compatibility Summary */}
      <section className="bg-white rounded-xl border border-slate-200 p-5 grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="space-y-1">
          <div className="text-xs font-medium text-slate-500">Unidades .timer del perfil activo</div>
          <div className="font-mono text-2xl font-semibold tabular-nums text-slate-900">
            {state.systemdSync.activeTimerCount}
          </div>
          <div className="text-xs text-slate-500">
            Audio puro hacia ecualizador · <span className="font-mono">Persistent=false</span>
          </div>
        </div>

        <div className="space-y-1 md:border-l md:border-slate-200 md:pl-6">
          <div className="text-xs font-medium text-slate-500">Acceso Web Local y en Red</div>
          <div className="font-mono text-sm font-semibold text-slate-900 truncate">
            http://localhost:{port}
          </div>
          <div className="font-mono text-sm font-semibold text-slate-700 truncate">
            http://{mdns}.local:{port}
          </div>
          <div className="text-xs text-slate-500">
            Servido por <span className="font-mono">web_panel.py</span> (Python 3 estándar)
          </div>
        </div>

        <div className="space-y-1 md:border-l md:border-slate-200 md:pl-6">
          <div className="text-xs font-medium text-slate-500">Compatibilidad y Audio Headless</div>
          <div className="text-sm font-semibold text-slate-900">
            Ubuntu 20/22/24 · RPi OS arm64/armhf
          </div>
          <div className="text-xs text-slate-500">
            Configura <span className="font-mono">linger</span>, UID dinámico y fallback ALSA/PipeWire/PulseAudio.
          </div>
        </div>
      </section>

      {/* Quick Start Terminal Box */}
      <section className="rounded-xl bg-slate-900 text-white p-6 border border-slate-800 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <Terminal className="w-5 h-5 text-emerald-400" />
            <div>
              <h2 className="text-sm font-semibold text-white">
                Instalación en el equipo anfitrión (Ubuntu 20/22/24 o Raspberry Pi OS)
              </h2>
              <p className="text-xs text-slate-400">
                Usuario <span className="font-mono text-slate-200">{state.hardware.linuxUser}</span>
                <span aria-hidden="true"> · </span>
                Reproductor <span className="font-mono text-slate-200">{state.hardware.audioBackend}</span>
                <span aria-hidden="true"> · </span>
                Salida <span className="font-mono text-slate-200">{state.hardware.audioOutput}</span>
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void copyText('cmd', quickCommands)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {copiedId === 'cmd' ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            {copiedId === 'cmd' ? 'Copiado' : 'Copiar comandos'}
          </button>
        </div>

        <pre className="p-4 rounded-lg bg-slate-950 border border-slate-800 font-mono text-xs text-emerald-300 overflow-x-auto leading-relaxed">
          {quickCommands}
        </pre>
      </section>

      {/* Generated Files Inspector */}
      <section className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1">
            {(Object.keys(files) as InspectFileKey[]).map((key) => {
              const active = key === activeFile;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setActiveFile(key)}
                  className={`px-3 py-1.5 rounded-md font-mono text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    active ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-200/70'
                  }`}
                >
                  {files[key].label}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => void copyText('file', currentFile.content)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0 cursor-pointer"
          >
            {copiedId === 'file' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
            {copiedId === 'file' ? 'Copiado' : `Copiar ${currentFile.filename}`}
          </button>
        </div>

        <pre className="p-5 font-mono text-xs text-slate-800 bg-white overflow-x-auto max-h-[480px] overflow-y-auto leading-relaxed">
          {currentFile.content}
        </pre>
      </section>
    </div>
  );
}
