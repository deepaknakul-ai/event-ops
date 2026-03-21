import React, { useState, useMemo } from 'react';
import { ChevronRight, CalendarDays, X } from 'lucide-react';
import { Modal } from './Shared';
import { STATUS_COLORS } from '../utils/constants';

/**
 * InventoryCalendar
 * Shows a monthly availability heat-map for a selected inventory item.
 * Props: inventory[], projects[], isOpen, onClose, initialItemId
 */
const InventoryCalendar = ({ inventory = [], projects = [], clients = [], isOpen, onClose, initialItemId = '' }) => {
  const [selectedItemId, setSelectedItemId] = useState(initialItemId);
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [tooltipDay, setTooltipDay] = useState(null); // date string 'YYYY-MM-DD'

  const selectedItem = inventory.find(i => i.id === selectedItemId);

  // Changes month
  const changeMonth = (offset) => {
    const d = new Date(currentMonth);
    d.setDate(1);
    d.setMonth(d.getMonth() + offset);
    setCurrentMonth(d);
  };

  // Build per-day data for the month
  const { days, bookingsByDay } = useMemo(() => {
    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);

    // Calendar grid — pad with nulls for leading empty cells
    const dayList = [];
    for (let i = 0; i < firstDay.getDay(); i++) dayList.push(null);
    for (let d = 1; d <= lastDay.getDate(); d++) dayList.push(new Date(year, month, d));

    if (!selectedItemId) return { days: dayList, bookingsByDay: {} };

    // For each day, find which projects have this item booked and total qty
    const byDay = {};
    dayList.forEach(date => {
      if (!date) return;
      const key = date.toISOString().split('T')[0];
      const projectsOnDay = [];
      projects.forEach(p => {
        if (['Cancelled'].includes(p.status)) return;
        const pStart = new Date(p.start_date); pStart.setHours(0, 0, 0, 0);
        const pEnd = new Date(p.end_date); pEnd.setHours(23, 59, 59, 999);
        if (date < pStart || date > pEnd) return;
        const itemAllocs = (p.items || []).filter(i => i.item_id === selectedItemId);
        const qty = itemAllocs.reduce((s, i) => s + (parseInt(i.qty) || 0), 0);
        if (qty > 0) {
          projectsOnDay.push({ project: p, qty });
        }
      });
      const totalBooked = projectsOnDay.reduce((s, b) => s + b.qty, 0);
      byDay[key] = { totalBooked, bookings: projectsOnDay };
    });

    return { days: dayList, bookingsByDay: byDay };
  }, [currentMonth, selectedItemId, projects]);

  // Projects active in this month (for the list below calendar)
  const monthProjects = useMemo(() => {
    if (!selectedItemId) return [];
    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();
    const monthStart = new Date(year, month, 1);
    const monthEnd = new Date(year, month + 1, 0); monthEnd.setHours(23, 59, 59, 999);

    return projects
      .filter(p => {
        if (p.status === 'Cancelled') return false;
        const pStart = new Date(p.start_date); pStart.setHours(0, 0, 0, 0);
        const pEnd = new Date(p.end_date); pEnd.setHours(23, 59, 59, 999);
        if (pStart > monthEnd || pEnd < monthStart) return false;
        return (p.items || []).some(i => i.item_id === selectedItemId && parseInt(i.qty) > 0);
      })
      .map(p => {
        const qty = (p.items || [])
          .filter(i => i.item_id === selectedItemId)
          .reduce((s, i) => s + (parseInt(i.qty) || 0), 0);
        const clientName = clients.find(c => c.id === p.client_id)?.name || '—';
        return { ...p, bookedQty: qty, clientName };
      })
      .sort((a, b) => new Date(a.start_date) - new Date(b.start_date));
  }, [currentMonth, selectedItemId, projects, clients]);

  // Color for a cell based on utilization
  const getCellColor = (key) => {
    const data = bookingsByDay[key];
    if (!data || data.totalBooked === 0) return { bg: 'bg-green-50', text: 'text-green-700', label: 'Free' };
    const total = selectedItem?.total || 1;
    const ratio = data.totalBooked / total;
    if (ratio >= 1) return { bg: 'bg-red-100', text: 'text-red-700', label: 'Full' };
    if (ratio >= 0.7) return { bg: 'bg-orange-100', text: 'text-orange-700', label: 'Busy' };
    return { bg: 'bg-yellow-50', text: 'text-yellow-700', label: 'Partial' };
  };

  const today = new Date().toISOString().split('T')[0];
  const weeks = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Inventory Availability Calendar">
      <div className="space-y-4 min-w-0">

        {/* Item selector */}
        <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
          <div className="flex-1">
            <label className="block text-xs font-bold text-slate-600 uppercase mb-1">Select Item</label>
            <select
              className="w-full rounded border border-slate-200 p-2 text-sm text-black bg-white"
              value={selectedItemId}
              onChange={e => setSelectedItemId(e.target.value)}
            >
              <option value="">— Choose inventory item —</option>
              {inventory
                .filter(i => !i.is_external)
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(i => <option key={i.id} value={i.id}>{i.name} ({i.category}) — {i.total} units</option>)
              }
            </select>
          </div>
          {selectedItem && (
            <div className="text-xs bg-indigo-50 border border-indigo-100 rounded-lg px-3 py-2 text-indigo-700 whitespace-nowrap">
              <span className="font-bold">{selectedItem.total}</span> total units
            </div>
          )}
        </div>

        {/* Month navigation */}
        <div className="flex items-center justify-between">
          <button onClick={() => changeMonth(-1)} className="flex items-center gap-1 text-xs rounded border border-slate-200 px-2 py-1 hover:bg-slate-50 font-medium">
            <ChevronRight size={14} className="rotate-180" /> Prev
          </button>
          <span className="font-bold text-slate-800">
            {currentMonth.toLocaleString('default', { month: 'long', year: 'numeric' })}
          </span>
          <button onClick={() => changeMonth(1)} className="flex items-center gap-1 text-xs rounded border border-slate-200 px-2 py-1 hover:bg-slate-50 font-medium">
            Next <ChevronRight size={14} />
          </button>
        </div>

        {/* Legend */}
        <div className="flex flex-wrap gap-3 text-xs">
          {[['bg-green-50 border-green-200 text-green-700', 'Free'], ['bg-yellow-50 border-yellow-200 text-yellow-700', 'Partial (<70%)'], ['bg-orange-100 border-orange-200 text-orange-700', 'Busy (≥70%)'], ['bg-red-100 border-red-200 text-red-700', 'Fully Booked']].map(([cls, label]) => (
            <div key={label} className={`flex items-center gap-1.5 border rounded px-2 py-0.5 ${cls}`}>
              <div className={`w-2.5 h-2.5 rounded-sm ${cls.split(' ')[0]}`} /> {label}
            </div>
          ))}
        </div>

        {/* Calendar grid */}
        <div className="rounded-xl border border-slate-200 overflow-hidden">
          {/* Day headers */}
          <div className="grid grid-cols-7 bg-slate-50 border-b border-slate-200">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
              <div key={d} className="py-2 text-center text-xs font-bold text-slate-500 uppercase">{d}</div>
            ))}
          </div>

          {/* Weeks */}
          {weeks.map((week, wIdx) => (
            <div key={wIdx} className="grid grid-cols-7 border-b border-slate-100 last:border-0">
              {week.map((date, dIdx) => {
                if (!date) return <div key={dIdx} className="bg-slate-50 min-h-[56px]" />;
                const key = date.toISOString().split('T')[0];
                const color = selectedItemId ? getCellColor(key) : { bg: '', text: '' };
                const data = bookingsByDay[key];
                const isToday = key === today;

                return (
                  <div
                    key={dIdx}
                    className={`min-h-[56px] p-1.5 border-r border-slate-100 last:border-0 relative cursor-default transition-colors ${color.bg} ${data?.totalBooked > 0 ? 'cursor-pointer hover:opacity-80' : ''}`}
                    onMouseEnter={() => data?.totalBooked > 0 ? setTooltipDay(key) : null}
                    onMouseLeave={() => setTooltipDay(null)}
                  >
                    {/* Date number */}
                    <div className={`text-xs font-medium mb-1 ${isToday ? 'bg-indigo-600 text-white w-5 h-5 rounded-full flex items-center justify-center' : 'text-slate-500'}`}>
                      {date.getDate()}
                    </div>

                    {/* Booked qty pill */}
                    {selectedItemId && data?.totalBooked > 0 && (
                      <div className={`text-[10px] font-bold text-center rounded px-1 ${color.text}`}>
                        {data.totalBooked}/{selectedItem?.total || '?'}
                      </div>
                    )}

                    {/* Tooltip */}
                    {tooltipDay === key && data?.bookings?.length > 0 && (
                      <div className="absolute z-50 left-1/2 -translate-x-1/2 top-full mt-1 w-48 bg-white border border-slate-200 rounded-lg shadow-xl p-2 text-xs pointer-events-none">
                        <div className="font-bold text-slate-700 mb-1">{key}</div>
                        {data.bookings.map((b, i) => (
                          <div key={i} className="flex items-center justify-between gap-1 py-0.5 border-b border-slate-50 last:border-0">
                            <span className="truncate text-slate-600">{b.project.project_name}</span>
                            <span className={`rounded-full px-1 py-0.5 border font-bold ${STATUS_COLORS[b.project.status] || 'bg-gray-100'}`}>
                              ×{b.qty}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* Month projects list */}
        {selectedItemId && (
          <div>
            <div className="font-semibold text-sm text-slate-700 mb-2 flex items-center gap-2">
              <CalendarDays size={14} />
              Projects using this item in {currentMonth.toLocaleString('default', { month: 'long', year: 'numeric' })}
            </div>
            {monthProjects.length === 0 ? (
              <div className="text-sm text-slate-400 text-center py-4 rounded-lg border border-slate-100 bg-slate-50">No bookings this month.</div>
            ) : (
              <div className="divide-y divide-slate-100 rounded-xl border border-slate-200 overflow-hidden">
                {monthProjects.map(p => (
                  <div key={p.id} className="flex items-center justify-between gap-3 px-4 py-3 bg-white hover:bg-slate-50">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold text-slate-800 truncate">{p.project_name}</div>
                      <div className="text-xs text-slate-500 truncate">{p.clientName} • {p.start_date} → {p.end_date}</div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className={`text-xs px-2 py-0.5 rounded border font-bold ${STATUS_COLORS[p.status] || 'bg-gray-100'}`}>{p.status}</span>
                      <span className="text-xs font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 rounded px-2 py-0.5">×{p.bookedQty}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {!selectedItemId && (
          <div className="text-center py-6 text-slate-400 text-sm">
            Select an inventory item above to view its availability calendar.
          </div>
        )}
      </div>
    </Modal>
  );
};

export default InventoryCalendar;
