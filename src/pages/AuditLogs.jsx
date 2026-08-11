import React, { useState, useEffect } from 'react';
import { Activity } from 'lucide-react';
import { collection, query, getDocs } from 'firebase/firestore';
import { can } from '../utils/permissions';

const AuditLogs = ({ db, appId, role }) => {
  // Component-level view gate
  if (!can(role, 'audit_logs', 'view')) {
    return <div className="p-8 text-center text-red-500 font-bold">Access Denied</div>;
  }
  const [logs, setLogs] = useState([]);
  const [filters, setFilters] = useState({ category: '', user: '', startDate: '', endDate: '' });
  const [limitCount, setLimitCount] = useState(100);

  useEffect(() => {
    const fetchLogs = async () => {
        const q = query(collection(db, 'artifacts', appId, 'public', 'data', 'audit_logs'));
        const snap = await getDocs(q);
        const allLogs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        setLogs(allLogs.sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp)));
    };
    fetchLogs();
  }, [db, appId]);

  const filteredLogs = logs.filter(log => {
    const d = new Date(log.timestamp);
    const s = filters.startDate ? new Date(filters.startDate) : null;
    const e = filters.endDate ? new Date(filters.endDate) : null;
    if (e) e.setHours(23,59,59);

    const matchCat = filters.category ? log.collection === filters.category : true;
    const matchUser = filters.user ? (log.performed_by || '').toLowerCase().includes(filters.user.toLowerCase()) : true;
    const matchDate = (!s || d >= s) && (!e || d <= e);

    return matchCat && matchUser && matchDate;
  }).slice(0, limitCount);

  return (
    <div className="space-y-6">
        <h2 className="text-2xl font-bold text-slate-800 flex items-center gap-2"><Activity /> Audit Logs</h2>
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm grid grid-cols-1 md:grid-cols-4 gap-4">
            <div><label className="text-xs font-bold text-slate-700 uppercase">Category</label><select className="w-full rounded border border-slate-300 p-2 text-sm text-black" value={filters.category} onChange={e => setFilters({...filters, category: e.target.value})}><option value="">All Categories</option><option value="projects">Projects</option><option value="clients">Clients</option><option value="inventory">Inventory</option><option value="expenses">Expenses</option><option value="payments">Payments</option><option value="employees">Employees</option><option value="admin">Admin</option></select></div>
            <div><label className="text-xs font-bold text-slate-700 uppercase">User (Email)</label><input className="w-full rounded border border-slate-300 p-2 text-sm text-black" placeholder="Search user..." value={filters.user} onChange={e => setFilters({...filters, user: e.target.value})} /></div>
            <div><label className="text-xs font-bold text-slate-700 uppercase">From Date</label><input type="date" className="w-full rounded border border-slate-300 p-2 text-sm text-black" value={filters.startDate} onChange={e => setFilters({...filters, startDate: e.target.value})} /></div>
            <div><label className="text-xs font-bold text-slate-700 uppercase">To Date</label><input type="date" className="w-full rounded border border-slate-300 p-2 text-sm text-black" value={filters.endDate} onChange={e => setFilters({...filters, endDate: e.target.value})} /></div>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-x-auto">
            <div className="max-h-[600px] overflow-y-auto">
                <table className="w-full text-left text-sm">
                    <thead className="bg-slate-50 text-slate-700 font-semibold sticky top-0"><tr><th className="p-3">Timestamp</th><th className="p-3">User</th><th className="p-3">Action</th><th className="p-3">Category</th><th className="p-3">Target</th><th className="p-3">Details</th></tr></thead>
                    <tbody className="divide-y divide-slate-100">
                        {filteredLogs.map(log => (
                            <tr key={log.id} className="hover:bg-slate-50">
                                <td className="p-3 text-slate-500 text-xs">{new Date(log.timestamp).toLocaleString()}</td>
                                <td className="p-3 font-medium">{log.performed_by}</td>
                                <td className="p-3 uppercase text-xs font-bold text-slate-600">{log.action}</td>
                                <td className="p-3"><span className="px-2 py-1 rounded bg-slate-100 text-xs">{log.collection}</span></td>
                                <td className="p-3 text-slate-700">{log.doc_name || log.doc_id}</td>
                                <td className="p-3 text-xs text-slate-500 max-w-xs truncate" title={JSON.stringify(log.details)}>{JSON.stringify(log.details)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {filteredLogs.length === 0 && <div className="p-8 text-center text-slate-400">No logs found.</div>}
            </div>
        </div>
    </div>
  );
};

export default AuditLogs;
