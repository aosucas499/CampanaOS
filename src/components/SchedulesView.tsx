import { useState } from 'react';
import { Copy, Edit3, Play, Plus, Search, Trash2, X } from 'lucide-react';
import type { BellAppState, BellScheduleItem } from '../types/bell.ts';
import { DAY_LABELS, formatDaysSummary } from '../utils/scheduleHelpers.ts';

interface SchedulesViewProps {
  state: BellAppState;
  onCreateSchedule: (item: Omit<BellScheduleItem, 'id'>) => Promise<void>;
  onUpdateSchedule: (id: string, patch: Partial<BellScheduleItem>) => Promise<void>;
  onDeleteSchedule: (id: string) => Promise<void>;
  onCreateProfile: (name: string, description: string) => Promise<void>;
  onPreviewTone: (toneId: string) => void;
}

export function SchedulesView({
  state,
  onCreateSchedule,
  onUpdateSchedule,
  onDeleteSchedule,
  onCreateProfile,
  onPreviewTone,
}: SchedulesViewProps) {
  const [selectedProfileId, setSelectedProfileId] = useState<string>(state.activeProfileId);
  const [searchQuery, setSearchQuery] = useState('');
  const [editingItem, setEditingItem] = useState<BellScheduleItem | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);

  const [time, setTime] = useState('08:30');
  const [label, setLabel] = useState('');
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [toneId, setToneId] = useState(state.tones[0]?.id ?? 'classic-bell');

  const [newProfileName, setNewProfileName] = useState('');
  const [newProfileDesc, setNewProfileDesc] = useState('');

  const filteredSchedules = state.schedules
    .filter((s) => s.profileId === selectedProfileId)
    .filter(
      (s) =>
        s.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
        s.time.includes(searchQuery),
    )
    .sort((a, b) => a.time.localeCompare(b.time));

  const openNewModal = () => {
    setEditingItem(null);
    setTime('08:30');
    setLabel('');
    setDays([1, 2, 3, 4, 5]);
    setToneId(state.tones[0]?.id ?? 'classic-bell');
    setIsModalOpen(true);
  };

  const openEditModal = (item: BellScheduleItem) => {
    setEditingItem(item);
    setTime(item.time);
    setLabel(item.label);
    setDays([...item.days]);
    setToneId(item.toneId);
    setIsModalOpen(true);
  };

  const toggleDay = (dayId: number) => {
    setDays((prev) =>
      prev.includes(dayId) ? prev.filter((d) => d !== dayId) : [...prev, dayId].sort((a, b) => a - b),
    );
  };

  const handleSaveSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim() || days.length === 0) return;

    if (editingItem) {
      await onUpdateSchedule(editingItem.id, {
        time,
        label: label.trim(),
        days,
        toneId,
      });
    } else {
      await onCreateSchedule({
        profileId: selectedProfileId,
        time,
        label: label.trim(),
        days,
        toneId,
        enabled: true,
      });
    }
    setIsModalOpen(false);
  };

  const handleDuplicate = async (item: BellScheduleItem) => {
    await onCreateSchedule({
      profileId: item.profileId,
      time: item.time,
      label: `${item.label} (copia)`,
      days: [...item.days],
      toneId: item.toneId,
      enabled: item.enabled,
    });
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProfileName.trim()) return;
    await onCreateProfile(newProfileName.trim(), newProfileDesc.trim());
    setNewProfileName('');
    setNewProfileDesc('');
    setIsProfileModalOpen(false);
  };

  return (
    <div className="space-y-6">
      {/* Header & Profile Tabs */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
            Programación de horarios y toques
          </h1>
          <p className="text-sm text-slate-500">
            Define los periodos de entrada, cambios de clase, recreos y salidas por perfil.
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => setIsProfileModalOpen(true)}
            className="px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Nuevo perfil
          </button>
          <button
            type="button"
            onClick={openNewModal}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            Añadir toque
          </button>
        </div>
      </div>

      {/* Filter & Search Toolbar */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg">
          {state.profiles.map((prof) => {
            const active = prof.id === selectedProfileId;
            return (
              <button
                key={prof.id}
                type="button"
                onClick={() => setSelectedProfileId(prof.id)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  active ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {prof.name}
                {prof.id === state.activeProfileId ? ' (Activo)' : ''}
              </button>
            );
          })}
        </div>

        <div className="relative w-full lg:w-72">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Buscar hora o concepto..."
            className="w-full h-9 pl-9 pr-3 rounded-lg border border-slate-300 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-slate-900"
          />
        </div>
      </div>

      {/* Dense Schedule Table */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        {filteredSchedules.length === 0 ? (
          <div className="p-12 text-center space-y-3">
            <p className="text-sm font-medium text-slate-800">
              No hay toques configurados en este perfil
            </p>
            <p className="text-xs text-slate-500 max-w-md mx-auto">
              Añade un primer toque horario con la hora exacta, días de la semana y melodía de audio.
            </p>
            <button
              type="button"
              onClick={openNewModal}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 text-white text-xs font-medium hover:bg-slate-800 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              Añadir primer toque
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-500">
                  <th className="py-3 px-5">Hora</th>
                  <th className="py-3 px-5">Descripción</th>
                  <th className="py-3 px-5">Días</th>
                  <th className="py-3 px-5">Sonido / Melodía</th>
                  <th className="py-3 px-5">Estado</th>
                  <th className="py-3 px-5 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {filteredSchedules.map((item) => {
                  const tone = state.tones.find((t) => t.id === item.toneId);
                  return (
                    <tr key={item.id} className="hover:bg-slate-50/80 transition-colors">
                      <td className="py-3 px-5 font-mono font-semibold tabular-nums text-slate-900 whitespace-nowrap">
                        {item.time}
                      </td>
                      <td className="py-3 px-5 font-medium text-slate-900">{item.label}</td>
                      <td className="py-3 px-5 text-xs text-slate-600 whitespace-nowrap">
                        {formatDaysSummary(item.days)}
                      </td>
                      <td className="py-3 px-5 text-xs text-slate-700">
                        <button
                          type="button"
                          onClick={() => onPreviewTone(item.toneId)}
                          className="inline-flex items-center gap-1.5 text-slate-700 hover:text-slate-900 cursor-pointer"
                          title="Escuchar tono"
                        >
                          <Play className="w-3 h-3 text-slate-500" />
                          <span>{tone?.name ?? item.toneId}</span>
                        </button>
                      </td>
                      <td className="py-3 px-5 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => void onUpdateSchedule(item.id, { enabled: !item.enabled })}
                          className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                            item.enabled
                              ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                              : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                          }`}
                        >
                          {item.enabled ? 'Activo' : 'Pausado'}
                        </button>
                      </td>
                      <td className="py-3 px-5 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => openEditModal(item)}
                            title="Editar"
                            className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-100 cursor-pointer"
                          >
                            <Edit3 className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDuplicate(item)}
                            title="Duplicar"
                            className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-100 cursor-pointer"
                          >
                            <Copy className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void onDeleteSchedule(item.id)}
                            title="Eliminar"
                            className="p-1.5 rounded-md text-slate-500 hover:text-red-600 hover:bg-red-50 cursor-pointer"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Add / Edit Schedule Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4">
          <form
            onSubmit={handleSaveSchedule}
            className="bg-white rounded-xl border border-slate-200 max-w-lg w-full p-6 space-y-5"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-900">
                {editingItem ? 'Editar toque programado' : 'Añadir nuevo toque'}
              </h3>
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label htmlFor="sch-time" className="block text-xs font-medium text-slate-700 mb-1">
                  Hora (24h)
                </label>
                <input
                  id="sch-time"
                  type="time"
                  required
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 font-mono text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
                />
              </div>
              <div className="sm:col-span-2">
                <label htmlFor="sch-label" className="block text-xs font-medium text-slate-700 mb-1">
                  Nombre o periodo
                </label>
                <input
                  id="sch-label"
                  type="text"
                  required
                  placeholder="Ej: Inicio de Recreo"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
                />
              </div>
            </div>

            <div>
              <span className="block text-xs font-medium text-slate-700 mb-2">Días de la semana</span>
              <div className="flex flex-wrap gap-2">
                {DAY_LABELS.map((day) => {
                  const selected = days.includes(day.id);
                  return (
                    <button
                      key={day.id}
                      type="button"
                      onClick={() => toggleDay(day.id)}
                      className={`w-10 h-10 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
                        selected
                          ? 'bg-slate-900 text-white'
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                      }`}
                    >
                      {day.short}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label htmlFor="sch-tone" className="block text-xs font-medium text-slate-700 mb-1">
                Sonido de megafonía
              </label>
              <div className="flex items-center gap-2">
                <select
                  id="sch-tone"
                  value={toneId}
                  onChange={(e) => setToneId(e.target.value)}
                  className="flex-1 h-10 px-3 rounded-lg border border-slate-300 text-sm text-slate-900 bg-white focus:outline-none focus:ring-2 focus:ring-slate-900"
                >
                  {state.tones.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => onPreviewTone(toneId)}
                  className="h-10 px-3 rounded-lg border border-slate-300 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
                >
                  Probar
                </button>
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="px-4 py-2 rounded-lg border border-slate-300 text-sm font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 cursor-pointer"
              >
                {editingItem ? 'Guardar cambios' : 'Crear toque'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* New Profile Modal */}
      {isProfileModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4">
          <form
            onSubmit={handleSaveProfile}
            className="bg-white rounded-xl border border-slate-200 max-w-md w-full p-6 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-900">Crear perfil horario</h3>
              <button
                type="button"
                onClick={() => setIsProfileModalOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div>
              <label htmlFor="prof-name" className="block text-xs font-medium text-slate-700 mb-1">
                Nombre del perfil
              </label>
              <input
                id="prof-name"
                type="text"
                required
                placeholder="Ej: Turno de Tarde / FP"
                value={newProfileName}
                onChange={(e) => setNewProfileName(e.target.value)}
                className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
              />
            </div>
            <div>
              <label htmlFor="prof-desc" className="block text-xs font-medium text-slate-700 mb-1">
                Descripción
              </label>
              <input
                id="prof-desc"
                type="text"
                placeholder="Ej: Horario vespertino de 15:30 a 21:30"
                value={newProfileDesc}
                onChange={(e) => setNewProfileDesc(e.target.value)}
                className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900"
              />
            </div>
            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setIsProfileModalOpen(false)}
                className="px-4 py-2 rounded-lg border border-slate-300 text-sm font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 cursor-pointer"
              >
                Crear perfil
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
