import { useState } from 'react';
import { CalendarOff, Plus, Trash2 } from 'lucide-react';
import type { BellAppState, HolidayException } from '../types/bell.ts';

interface HolidaysViewProps {
  state: BellAppState;
  onCreateHoliday: (holiday: Omit<HolidayException, 'id'>) => Promise<void>;
  onDeleteHoliday: (id: string) => Promise<void>;
}

const PRESET_HOLIDAYS = [
  { name: 'Semana Santa', startDate: '2027-03-22', endDate: '2027-03-28' },
  { name: 'Puente de Mayo', startDate: '2027-05-01', endDate: '2027-05-03' },
  { name: 'Día de la Hispanidad', startDate: '2027-10-12', endDate: '2027-10-12' },
];

export function HolidaysView({ state, onCreateHoliday, onDeleteHoliday }: HolidaysViewProps) {
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !startDate) return;
    await onCreateHoliday({
      name: name.trim(),
      startDate,
      endDate: endDate && endDate >= startDate ? endDate : startDate,
    });
    setName('');
    setStartDate('');
    setEndDate('');
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Calendario escolar y días festivos
        </h1>
        <p className="text-sm text-slate-500">
          Durante los periodos no lectivos registrados aquí, el demonio Linux silenciará automáticamente todos los toques.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <form
          onSubmit={handleSubmit}
          className="lg:col-span-5 bg-white rounded-xl border border-slate-200 p-6 space-y-4 h-fit"
        >
          <h2 className="text-base font-semibold text-slate-900">Añadir periodo no lectivo</h2>

          <div>
            <label htmlFor="hol-name" className="block text-xs font-medium text-slate-700 mb-1">
              Motivo o festividad
            </label>
            <input
              id="hol-name"
              type="text"
              required
              placeholder="Ej: Vacaciones de Semana Santa"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="hol-start" className="block text-xs font-medium text-slate-700 mb-1">
                Fecha inicio
              </label>
              <input
                id="hol-start"
                type="date"
                required
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full h-10 px-3 rounded-lg border border-slate-300 font-mono text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
              />
            </div>

            <div>
              <label htmlFor="hol-end" className="block text-xs font-medium text-slate-700 mb-1">
                Fecha fin (opcional)
              </label>
              <input
                id="hol-end"
                type="date"
                value={endDate}
                min={startDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full h-10 px-3 rounded-lg border border-slate-300 font-mono text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
              />
            </div>
          </div>

          <button
            type="submit"
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            Registrar excepción
          </button>

          <div className="pt-4 border-t border-slate-100 space-y-2">
            <div className="text-xs font-medium text-slate-500">Añadir rápido</div>
            <div className="flex flex-wrap gap-2">
              {PRESET_HOLIDAYS.map((preset) => (
                <button
                  key={preset.name}
                  type="button"
                  onClick={() => void onCreateHoliday(preset)}
                  className="px-2.5 py-1.5 rounded-md bg-slate-100 hover:bg-slate-200 text-xs font-medium text-slate-700 transition-colors cursor-pointer"
                >
                  + {preset.name}
                </button>
              ))}
            </div>
          </div>
        </form>

        <section className="lg:col-span-7 bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-900">
              Festivos y cierres activos ({state.holidays.length})
            </h2>
          </div>

          {state.holidays.length === 0 ? (
            <div className="p-10 text-center space-y-2">
              <CalendarOff className="w-8 h-8 text-slate-300 mx-auto" />
              <p className="text-sm font-medium text-slate-700">No hay festivos registrados</p>
              <p className="text-xs text-slate-500">
                Añade fechas de vacaciones o días no lectivos para evitar que suene el timbre con el centro cerrado.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {state.holidays.map((h) => (
                <div key={h.id} className="px-6 py-4 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-900 truncate">{h.name}</div>
                    <div className="font-mono text-xs text-slate-500 mt-0.5 tabular-nums">
                      {h.startDate === h.endDate ? h.startDate : `${h.startDate} al ${h.endDate}`}
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => void onDeleteHoliday(h.id)}
                    title="Eliminar festivo"
                    className="p-2 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
