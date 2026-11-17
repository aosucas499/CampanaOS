import { useState } from 'react';
import { Lock, X } from 'lucide-react';

interface AuthGateModalProps {
  mode: 'fullscreen' | 'modal';
  schoolName: string;
  hostnameMdns: string;
  onUnlock: (pin: string) => Promise<{ ok: boolean; error?: string }>;
  onClose?: () => void;
}

export function AuthGateModal({
  mode,
  schoolName,
  hostnameMdns,
  onUnlock,
  onClose,
}: AuthGateModalProps) {
  const [pin, setPin] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pin.trim()) return;
    setSubmitting(true);
    setError(null);
    const res = await onUnlock(pin);
    setSubmitting(false);
    if (!res.ok) {
      setError(res.error ?? 'PIN o contraseña incorrectos.');
    } else {
      setPin('');
    }
  };

  const card = (
    <form
      onSubmit={handleSubmit}
      className="bg-white rounded-xl border border-slate-200 max-w-md w-full p-6 sm:p-8 space-y-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-lg bg-slate-900 text-white shrink-0">
            <Lock className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Acceso de administrador</h2>
            <p className="text-xs text-slate-500">
              {schoolName} · {hostnameMdns}.local
            </p>
          </div>
        </div>
        {mode === 'modal' && onClose && (
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 cursor-pointer"
            aria-label="Cerrar"
          >
            <X className="w-5 h-5" />
          </button>
        )}
      </div>

      <p className="text-sm text-slate-600">
        Introduce el PIN o contraseña del centro para modificar horarios, accionar el timbre manualmente o descargar la configuración.
      </p>

      <div>
        <label htmlFor="admin-pin-input" className="block text-xs font-medium text-slate-700 mb-1.5">
          PIN o contraseña de administrador
        </label>
        <input
          id="admin-pin-input"
          type="password"
          autoFocus
          required
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          placeholder="••••"
          className="w-full h-11 px-3.5 rounded-lg border border-slate-300 font-mono text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
        />
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs font-medium text-red-700">
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-3 pt-1">
        {mode === 'modal' && onClose && (
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2.5 rounded-lg border border-slate-300 text-sm font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
          >
            Cancelar
          </button>
        )}
        <button
          type="submit"
          disabled={submitting}
          className={`${mode === 'fullscreen' ? 'w-full' : ''} px-5 py-2.5 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 disabled:opacity-60 transition-colors cursor-pointer`}
        >
          {submitting ? 'Verificando...' : 'Desbloquear panel'}
        </button>
      </div>
    </form>
  );

  if (mode === 'fullscreen') {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4">
        <div className="mb-6 text-center">
          <span className="font-display text-xl font-bold tracking-tight text-slate-900">
            CampanaOS
          </span>
        </div>
        {card}
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4">
      {card}
    </div>
  );
}
