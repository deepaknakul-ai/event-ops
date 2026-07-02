import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, X, Calendar, Users, Box, Keyboard } from 'lucide-react';
import { formatCurrency, getProjectGrandTotal } from '../utils/helpers';
import { STATUS_COLORS } from '../utils/constants';
import { can } from '../utils/permissions';

const SHORTCUTS = [
  { keys: 'Ctrl+K  or  /', action: 'Open Global Search' },
  { keys: 'Esc', action: 'Close Search / Modal' },
  { keys: 'Alt+P', action: 'Go to Projects' },
  { keys: 'Alt+C', action: 'Go to Clients' },
  { keys: 'Alt+I', action: 'Go to Inventory' },
  { keys: 'Alt+F', action: 'Go to Finance' },
  { keys: 'Alt+R', action: 'Go to Reports' },
  { keys: 'Alt+D', action: 'Go to Dashboard' },
  { keys: '?', action: 'Show Keyboard Shortcuts' },
];

const GlobalSearch = ({ projects = [], clients = [], inventory = [], isOpen, onClose, role = 'user' }) => {
  const showProjectValue = can(role, 'projects', 'view_rates');
  const showInventoryRate = can(role, 'inventory', 'view_rates');
  const [query, setQuery] = useState('');
  const [showShortcuts, setShowShortcuts] = useState(false);
  const inputRef = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setShowShortcuts(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  const results = useMemo(() => {
    if (!query || query.trim().length < 2) return { projects: [], clients: [], inventory: [] };
    const q = query.toLowerCase();
    return {
      projects: projects
        .filter(p =>
          p.project_name?.toLowerCase().includes(q) ||
          p.venue?.toLowerCase().includes(q) ||
          clients.find(c => c.id === p.client_id)?.name?.toLowerCase().includes(q)
        )
        .slice(0, 6),
      clients: clients
        .filter(c =>
          c.name?.toLowerCase().includes(q) ||
          c.gstin?.toLowerCase().includes(q) ||
          c.contacts?.some(ct => ct.phone?.includes(q) || ct.email?.toLowerCase().includes(q))
        )
        .slice(0, 4),
      inventory: inventory
        .filter(i =>
          i.name?.toLowerCase().includes(q) ||
          i.category?.toLowerCase().includes(q)
        )
        .slice(0, 4),
    };
  }, [query, projects, clients, inventory]);

  const totalResults = results.projects.length + results.clients.length + results.inventory.length;

  const handleResultClick = (type, item) => {
    onClose();
    if (type === 'project') navigate(`/projects/${item.id}`);
    else if (type === 'client') navigate('/clients');
    else if (type === 'inventory') navigate('/inventory');
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-start justify-center pt-16 px-4">
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-2xl bg-white rounded-xl shadow-2xl border border-slate-200 overflow-hidden">

        {/* Search Input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-100">
          <Search size={18} className="text-slate-400 flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search projects, clients, inventory…"
            className="flex-1 outline-none text-slate-800 text-sm bg-transparent placeholder:text-slate-400"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowShortcuts(s => !s)}
              className="text-slate-400 hover:text-indigo-600 p-1 rounded"
              title="Keyboard Shortcuts (?)"
            >
              <Keyboard size={14} />
            </button>
            <span className="text-xs text-slate-400 border border-slate-200 rounded px-1.5 py-0.5 hidden sm:inline">ESC</span>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600 p-1">
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Keyboard Shortcuts Panel */}
        {showShortcuts && (
          <div className="px-4 py-3 border-b border-slate-100 bg-slate-50">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Keyboard Shortcuts</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
              {SHORTCUTS.map(s => (
                <div key={s.keys} className="flex items-center justify-between text-xs text-slate-600">
                  <span className="text-slate-400">{s.action}</span>
                  <kbd className="ml-2 font-mono bg-white border border-slate-200 rounded px-1.5 py-0.5 text-slate-700">{s.keys}</kbd>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Results */}
        <div className="max-h-[60vh] overflow-y-auto">
          {query.trim().length < 2 && !showShortcuts && (
            <div className="px-4 py-8 text-center">
              <Search size={32} className="text-slate-200 mx-auto mb-2" />
              <div className="text-sm text-slate-400">Type at least 2 characters to search across projects, clients, and inventory</div>
              <div className="mt-3 text-xs text-slate-400">
                Press <kbd className="border border-slate-200 rounded px-1">?</kbd> to see keyboard shortcuts
              </div>
            </div>
          )}

          {query.trim().length >= 2 && totalResults === 0 && (
            <div className="px-4 py-10 text-center">
              <div className="text-sm text-slate-400">No results for "{query}"</div>
            </div>
          )}

          {/* Projects */}
          {results.projects.length > 0 && (
            <div>
              <div className="px-4 py-2 text-xs font-semibold text-slate-500 uppercase tracking-wider bg-slate-50 border-b border-slate-100 flex items-center gap-1.5">
                <Calendar size={11} /> Projects
              </div>
              {results.projects.map(p => {
                const client = clients.find(c => c.id === p.client_id);
                return (
                  <button
                    key={p.id}
                    onClick={() => handleResultClick('project', p)}
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-indigo-50 text-left transition-colors border-b border-slate-50 last:border-0"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-800 truncate">{p.project_name}</div>
                      <div className="text-xs text-slate-500 truncate">
                        {client?.name}{p.venue ? ` • ${p.venue}` : ''}{p.start_date ? ` • ${p.start_date}` : ''}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className={`text-xs px-2 py-0.5 rounded-full border ${STATUS_COLORS[p.status] || 'bg-gray-100 text-gray-600 border-gray-200'}`}>{p.status}</span>
                      {showProjectValue && <span className="text-xs font-semibold text-slate-700 hidden sm:inline">{formatCurrency(getProjectGrandTotal(p))}</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {/* Clients */}
          {results.clients.length > 0 && (
            <div>
              <div className="px-4 py-2 text-xs font-semibold text-slate-500 uppercase tracking-wider bg-slate-50 border-b border-slate-100 flex items-center gap-1.5">
                <Users size={11} /> Clients & Vendors
              </div>
              {results.clients.map(c => (
                <button
                  key={c.id}
                  onClick={() => handleResultClick('client', c)}
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-indigo-50 text-left transition-colors border-b border-slate-50 last:border-0"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-slate-800 truncate">{c.name}</div>
                    <div className="text-xs text-slate-500 truncate">
                      {c.type}{c.gstin ? ` • GSTIN: ${c.gstin}` : ''}{c.contacts?.[0]?.phone ? ` • ${c.contacts[0].phone}` : ''}
                    </div>
                  </div>
                  <span className="text-xs px-2 py-0.5 rounded-full border bg-blue-50 text-blue-700 border-blue-200 flex-shrink-0">{c.type}</span>
                </button>
              ))}
            </div>
          )}

          {/* Inventory */}
          {results.inventory.length > 0 && (
            <div>
              <div className="px-4 py-2 text-xs font-semibold text-slate-500 uppercase tracking-wider bg-slate-50 border-b border-slate-100 flex items-center gap-1.5">
                <Box size={11} /> Inventory
              </div>
              {results.inventory.map(i => (
                <button
                  key={i.id}
                  onClick={() => handleResultClick('inventory', i)}
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-indigo-50 text-left transition-colors border-b border-slate-50 last:border-0"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-slate-800 truncate">{i.name}</div>
                    <div className="text-xs text-slate-500 truncate">{i.category} • {i.total} units available</div>
                  </div>
                  {showInventoryRate && <span className="text-xs font-semibold text-slate-700 flex-shrink-0">{formatCurrency(i.rate_per_day)}/day</span>}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 bg-slate-50 border-t border-slate-100 flex items-center justify-between">
          <span className="text-xs text-slate-400">
            {query.trim().length >= 2
              ? totalResults > 0
                ? `${totalResults} result${totalResults !== 1 ? 's' : ''} found`
                : 'No results'
              : 'Global Search'}
          </span>
          <div className="flex items-center gap-3 text-xs text-slate-400">
            <span><kbd className="border border-slate-200 rounded px-1">↑↓</kbd> navigate</span>
            <span><kbd className="border border-slate-200 rounded px-1">↵</kbd> open</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default GlobalSearch;
