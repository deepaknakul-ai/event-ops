import React, { useState, useMemo, useRef, useEffect } from 'react';
import { Bell, Calendar, FileText, AlertTriangle, Package, ChevronRight, X, Wrench } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { formatCurrency, getProjectGrandTotal, isDateOverlap, getServiceStatus } from '../utils/helpers';

const NotificationBell = ({ projects = [], inventory = [], payments = [], clients = [], role = 'tech', expenses = [], hrLeaves = [] }) => {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setIsOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const notifications = useMemo(() => {
    const now = new Date(); now.setHours(0, 0, 0, 0);
    const next30 = new Date(now); next30.setDate(now.getDate() + 30);
    const items = [];

    // 1. Projects starting within 3 days (Confirmed/Quoted)
    projects
      .filter(p => ['Confirmed', 'Quoted'].includes(p.status))
      .forEach(p => {
        const start = new Date(p.start_date); start.setHours(0, 0, 0, 0);
        const daysUntil = Math.ceil((start - now) / (1000 * 60 * 60 * 24));
        if (daysUntil >= 0 && daysUntil <= 3) {
          const label = daysUntil === 0 ? 'Today' : daysUntil === 1 ? 'Tomorrow' : `In ${daysUntil} days`;
          items.push({
            type: 'upcoming_project',
            priority: daysUntil <= 1 ? 'high' : 'medium',
            title: `${label}: ${p.project_name}`,
            subtitle: `${p.start_date}${p.venue ? ` • ${p.venue}` : ''}`,
            action: () => navigate(`/projects/${p.id}`),
          });
        }
      });

    // 2. Overdue ongoing projects
    projects
      .filter(p => p.status === 'Ongoing')
      .forEach(p => {
        const end = new Date(p.end_date); end.setHours(23, 59, 59, 999);
        if (end < now) {
          const daysOverdue = Math.floor((now - end) / (1000 * 60 * 60 * 24));
          items.push({
            type: 'overdue',
            priority: 'high',
            title: `Overdue (${daysOverdue}d): ${p.project_name}`,
            subtitle: `Was due ${p.end_date}`,
            action: () => navigate(`/projects/${p.id}`),
          });
        }
      });

    // 2b. Pending approvals — for approvers (always-visible nudge from any page)
    if (['admin', 'manager', 'accountant'].includes(role)) {
      const pendExp = expenses.filter(e => e.status === 'Pending').length;
      if (pendExp > 0) items.push({
        type: 'approval', priority: 'high',
        title: `${pendExp} expense${pendExp > 1 ? 's' : ''} awaiting approval`,
        subtitle: 'Tap to review', action: () => navigate('/expenses'),
      });
      const pendLv = hrLeaves.filter(l => l.status === 'Pending').length;
      if (pendLv > 0) items.push({
        type: 'approval', priority: 'high',
        title: `${pendLv} leave request${pendLv > 1 ? 's' : ''} pending`,
        subtitle: 'Tap to review', action: () => navigate('/hr/leaves'),
      });
    }

    // 3. Unpaid invoices — only for admin/manager
    if (role === 'admin' || role === 'manager') {
      projects
        .filter(p => ['Completed', 'Closed'].includes(p.status))
        .forEach(p => {
          const total = getProjectGrandTotal(p);
          const received = payments
            .filter(pay => pay.client_id === p.client_id && pay.project_id === p.id)
            .reduce((s, pay) => s + parseFloat(pay.amount || 0), 0);
          const outstanding = total - received;
          if (outstanding > 0.5) {
            const clientName = clients.find(c => c.id === p.client_id)?.name || '—';
            items.push({
              type: 'unpaid_invoice',
              priority: 'medium',
              title: `Unpaid: ${p.project_name}`,
              subtitle: `${clientName} — ${formatCurrency(outstanding)} outstanding`,
              action: () => navigate('/finance'),
            });
          }
        });

      // 4. Low inventory — items >= 80% booked in next 30 days
      inventory.forEach(item => {
        if (!item.total || item.total <= 0 || item.is_external) return;
        let maxBooked = 0;
        projects
          .filter(p => !['Cancelled', 'Closed', 'Quoted'].includes(p.status))
          .forEach(p => {
            if (!isDateOverlap(p.start_date, p.end_date, now.toISOString().split('T')[0], next30.toISOString().split('T')[0])) return;
            const booked = (p.items || [])
              .filter(i => i.item_id === item.id)
              .reduce((s, i) => s + (parseInt(i.qty) || 0), 0);
            maxBooked = Math.max(maxBooked, booked);
          });
        if (maxBooked <= 0) return;
        const available = item.total - maxBooked;
        const ratio = available / item.total;
        if (ratio <= 0.2) {
          items.push({
            type: 'low_stock',
            priority: ratio <= 0 ? 'high' : 'medium',
            title: `${ratio <= 0 ? 'Fully Booked' : 'Low Stock'}: ${item.name}`,
            subtitle: `${Math.max(0, available)} of ${item.total} available in next 30 days`,
            action: () => navigate('/inventory'),
          });
        }
      });

      // 5. Maintenance / service due (overdue or within 14 days)
      inventory.forEach(item => {
        if (item.is_external) return;
        const svc = getServiceStatus(item);
        if (svc.status === 'overdue' || svc.status === 'due_soon') {
          items.push({
            type: 'service_due',
            priority: svc.status === 'overdue' ? 'high' : 'medium',
            title: `${svc.status === 'overdue' ? 'Service overdue' : 'Service due'}: ${item.name}`,
            subtitle: svc.status === 'overdue' ? `Was due ${svc.dueDate} (${Math.abs(svc.days)}d ago)` : `Due ${svc.dueDate} (in ${svc.days}d)`,
            action: () => navigate('/inventory'),
          });
        }
      });
    }

    return items.sort((a, b) => (a.priority === 'high' ? -1 : 1) - (b.priority === 'high' ? -1 : 1));
  }, [projects, inventory, payments, clients, role, navigate]);

  const highCount = notifications.filter(n => n.priority === 'high').length;
  const count = notifications.length;

  const iconMap = {
    upcoming_project: <Calendar size={14} className="text-indigo-500 flex-shrink-0" />,
    overdue: <AlertTriangle size={14} className="text-red-500 flex-shrink-0" />,
    unpaid_invoice: <FileText size={14} className="text-orange-500 flex-shrink-0" />,
    low_stock: <Package size={14} className="text-yellow-500 flex-shrink-0" />,
    service_due: <Wrench size={14} className="text-cyan-600 flex-shrink-0" />,
  };

  const badgeMap = {
    upcoming_project: 'bg-indigo-50 text-indigo-600 border-indigo-200',
    overdue: 'bg-red-50 text-red-600 border-red-200',
    unpaid_invoice: 'bg-orange-50 text-orange-600 border-orange-200',
    low_stock: 'bg-yellow-50 text-yellow-700 border-yellow-200',
    service_due: 'bg-cyan-50 text-cyan-700 border-cyan-200',
  };

  const labelMap = {
    upcoming_project: 'Upcoming',
    overdue: 'Overdue',
    unpaid_invoice: 'Unpaid',
    low_stock: 'Low Stock',
    service_due: 'Service Due',
  };

  // Group by type for section headers
  const grouped = notifications.reduce((acc, n) => {
    if (!acc[n.type]) acc[n.type] = [];
    acc[n.type].push(n);
    return acc;
  }, {});

  const typeOrder = ['overdue', 'service_due', 'upcoming_project', 'unpaid_invoice', 'low_stock'];

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setIsOpen(o => !o)}
        className="relative p-2 rounded-full hover:bg-slate-100 text-slate-500 hover:text-slate-700 transition-colors"
        title="Notifications"
      >
        <Bell size={18} />
        {count > 0 && (
          <span className={`absolute -top-0.5 -right-0.5 min-w-[16px] h-4 text-white text-[10px] font-bold rounded-full flex items-center justify-center px-0.5 ${highCount > 0 ? 'bg-red-500' : 'bg-orange-400'}`}>
            {count > 9 ? '9+' : count}
          </span>
        )}
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center px-4">
          <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setIsOpen(false)} />
          <div className="relative w-full max-w-md bg-white rounded-xl shadow-2xl border border-slate-200 overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b bg-slate-50">
            <div className="flex items-center gap-2">
              <Bell size={14} className="text-slate-600" />
              <span className="font-bold text-sm text-slate-800">Notifications</span>
              {count > 0 && (
                <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold ${highCount > 0 ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-600'}`}>
                  {count}
                </span>
              )}
            </div>
            <button onClick={() => setIsOpen(false)} className="text-slate-400 hover:text-slate-600 p-1">
              <X size={14} />
            </button>
          </div>

          {/* Body */}
          <div className="max-h-[400px] overflow-y-auto">
            {count === 0 && (
              <div className="px-4 py-10 text-center">
                <Bell size={32} className="text-slate-200 mx-auto mb-2" />
                <div className="text-sm text-slate-400 font-medium">All clear!</div>
                <div className="text-xs text-slate-400 mt-1">No alerts at this time.</div>
              </div>
            )}

            {typeOrder.map(type => {
              const group = grouped[type];
              if (!group || group.length === 0) return null;
              return (
                <div key={type}>
                  <div className={`px-4 py-1.5 text-[10px] font-bold uppercase tracking-wider border-b ${
                    type === 'overdue' ? 'bg-red-50 text-red-600 border-red-100' :
                    type === 'upcoming_project' ? 'bg-indigo-50 text-indigo-600 border-indigo-100' :
                    type === 'unpaid_invoice' ? 'bg-orange-50 text-orange-600 border-orange-100' :
                    'bg-yellow-50 text-yellow-700 border-yellow-100'
                  }`}>
                    {labelMap[type]} ({group.length})
                  </div>
                  {group.map((n, idx) => (
                    <button
                      key={idx}
                      onClick={() => { n.action(); setIsOpen(false); }}
                      className={`w-full flex items-start gap-3 px-4 py-3 hover:bg-slate-50 text-left transition-colors border-b border-slate-50 last:border-0 ${n.priority === 'high' ? 'bg-red-50/30' : ''}`}
                    >
                      <div className="mt-0.5">{iconMap[n.type]}</div>
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-semibold text-slate-800 truncate">{n.title}</div>
                        <div className="text-xs text-slate-500 mt-0.5 truncate">{n.subtitle}</div>
                      </div>
                      <ChevronRight size={12} className="text-slate-300 flex-shrink-0 mt-0.5" />
                    </button>
                  ))}
                </div>
              );
            })}
          </div>

          {count > 0 && (
            <div className="px-4 py-2 border-t bg-slate-50 text-xs text-slate-400 text-center">
              {highCount > 0 ? `${highCount} high-priority alert${highCount !== 1 ? 's' : ''}` : 'No critical alerts'}
            </div>
          )}
          </div>
        </div>
      )}
    </div>
  );
};

export default NotificationBell;
