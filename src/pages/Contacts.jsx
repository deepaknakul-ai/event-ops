import React, { useState, useMemo } from 'react';
import { Users, Search, Phone, Mail, MapPin, Building2 } from 'lucide-react';

// Read-only contact directory — name / people / phone / address / GSTIN only,
// NO financials. For roles without full Clients access (Coordinators, Field
// Techs): the client financial dashboard lives on the Clients page, which is
// gated to Owner / Accountant / Manager.
const Contacts = ({ clients = [] }) => {
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const isVendor = (c) => String(c.type || '').toLowerCase().includes('vendor');
    return (clients || [])
      .filter((c) => {
        if (typeFilter === 'client' && isVendor(c) && !String(c.type || '').toLowerCase().includes('both')) return false;
        if (typeFilter === 'vendor' && !isVendor(c)) return false;
        if (!q) return true;
        const people = (c.contacts || []).flatMap((p) => [p.name, p.phone, p.email]);
        return [c.name, c.gstin, c.address, c.state, ...people]
          .filter(Boolean).some((v) => String(v).toLowerCase().includes(q));
      })
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  }, [clients, search, typeFilter]);

  return (
    <div className="space-y-4 animate-fade-in">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2"><Users size={20} className="text-indigo-600" /> Contact Directory</h2>
        <span className="text-xs text-slate-400">{rows.length} contact(s)</span>
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <div className="flex items-center rounded border px-3 py-2 bg-white flex-1">
          <Search size={16} className="text-slate-400 mr-2" />
          <input placeholder="Search name, person, phone…" className="text-sm outline-none text-black w-full" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="rounded border px-3 py-2 text-sm bg-white text-slate-700">
          <option value="all">All</option>
          <option value="client">Clients</option>
          <option value="vendor">Vendors</option>
        </select>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {rows.map((c) => (
          <div key={c.id} className="rounded-xl bg-white border border-slate-200 p-4 shadow-sm">
            <div className="flex items-start justify-between gap-2">
              <div className="font-bold text-slate-800">{c.name || '—'}</div>
              <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${String(c.type || '').toLowerCase().includes('vendor') ? 'bg-purple-50 text-purple-600 border-purple-200' : 'bg-indigo-50 text-indigo-600 border-indigo-200'}`}>{c.type || 'Client'}</span>
            </div>
            {(c.address || c.state) && (
              <div className="mt-1 flex items-start gap-1.5 text-xs text-slate-500"><MapPin size={12} className="text-slate-400 mt-0.5 shrink-0" /><span>{[c.address, c.state].filter(Boolean).join(', ')}</span></div>
            )}
            {c.gstin && <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-500"><Building2 size={12} className="text-slate-400" /> {c.gstin}</div>}
            {(c.contacts || []).length > 0 && (
              <div className="mt-2 border-t border-slate-100 pt-2 space-y-1.5">
                {(c.contacts || []).map((p, i) => (
                  <div key={i} className="text-xs">
                    {p.name && <div className="font-medium text-slate-700">{p.name}</div>}
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-slate-500">
                      {p.phone && <span className="flex items-center gap-1"><Phone size={11} className="text-slate-400" /> {p.phone}</span>}
                      {p.email && <span className="flex items-center gap-1"><Mail size={11} className="text-slate-400" /> {p.email}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {rows.length === 0 && <div className="col-span-full text-center text-slate-400 py-10">No contacts found.</div>}
      </div>
    </div>
  );
};

export default Contacts;
