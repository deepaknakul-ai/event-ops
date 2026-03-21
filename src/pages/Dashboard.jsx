// c:\APP\temp\rental-ops\src\pages\Dashboard.jsx
import React, { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer, Legend
} from 'recharts';
import { AlertTriangle, AlertCircle, ChevronRight, Truck, CalendarDays, TrendingUp, Clock, FileText, DollarSign } from 'lucide-react';
import { doc, getDoc } from 'firebase/firestore';
import { STATUS_COLORS } from '../utils/constants';
import { formatCurrency, getProjectGrandTotal, getProjectNetTotal, getProjectGST } from '../utils/helpers';
import { can } from '../utils/permissions';

const DEFAULT_STATUS_BG = {
  Quoted: '#ffedd5',
  Confirmed: '#dcfce7',
  Cancelled: '#f3f4f6',
  Ongoing: '#fee2e2',
  Completed: '#dbeafe',
  Closed: '#003366'
};

const DEFAULT_INVOICE_TEXT = {
  Invoiced: '',
  'Not Invoiced': ''
};

const Dashboard = ({ projects, expenses, role, clients, onProjectClick, employees = [], payments = [], db, appId }) => {
  const navigate = useNavigate();
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [calendarColors, setCalendarColors] = useState({
    statusColors: { ...DEFAULT_STATUS_BG },
    invoiceTextColors: { ...DEFAULT_INVOICE_TEXT }
  });

  const activeProjects = projects.filter(p => ['Confirmed', 'Ongoing'].includes(p.status)).length;
  const pendingQuotes = projects.filter(p => p.status === 'Quoted').length;
  const revenue = projects.filter(p => p.status === 'Completed' || p.status === 'Closed').reduce((sum, p) => sum + getProjectGrandTotal(p), 0);
  
  const overdueProjects = projects.filter(p => {
    const end = new Date(p.end_date); end.setHours(23,59,59);
    return p.status === 'Ongoing' && end < new Date();
  }).length;

  const lockedEmployees = employees.filter(e => e.is_locked);

  useEffect(() => {
    const loadCalendarColors = async () => {
      if (!db || !appId) return;
      try {
        const docRef = doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'organization');
        const snap = await getDoc(docRef);
        if (!snap.exists()) return;
        const stored = snap.data()?.calendar_color_settings || {};
        setCalendarColors({
          statusColors: { ...DEFAULT_STATUS_BG, ...(stored.statusColors || {}) },
          invoiceTextColors: { ...DEFAULT_INVOICE_TEXT, ...(stored.invoiceTextColors || {}) }
        });
      } catch (error) {
        console.error('Failed to load calendar colors', error);
      }
    };
    loadCalendarColors();
  }, [db, appId]);

  const getStatusBgColor = (status) => calendarColors.statusColors?.[status] || DEFAULT_STATUS_BG[status];

  const getInvoiceTextColor = (project) => {
    if (project.status !== 'Closed') return null;
    const key = project.invoice_status || '';
    const value = calendarColors.invoiceTextColors?.[key] || '';
    return value && value.trim() ? value.trim() : null;
  };

  // Revenue Data (Monthwise)
  const revenueData = useMemo(() => {
    // Build last 6 months keys (including current month)
    const now = new Date();
    const monthKeys = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      monthKeys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }

    // Initialize all 6 months with zeros
    const data = {};
    monthKeys.forEach(key => {
      data[key] = { totalRevenue: 0, netRevenue: 0, gst: 0, expenses: 0, outsourcing: 0 };
    });

    // Aggregate revenue & outsourcing from Completed/Closed projects
    projects.forEach(p => {
      if (['Completed', 'Closed'].includes(p.status)) {
         const d = new Date(p.end_date);
         if (!isNaN(d)) {
             const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
             if (data[key]) {
               data[key].totalRevenue += getProjectGrandTotal(p);
               data[key].netRevenue += getProjectNetTotal(p);
               data[key].gst += getProjectGST(p);
               // Outsourcing: vendor_allocations total (tax-inclusive)
               (p.vendor_allocations || []).forEach(v => {
                 data[key].outsourcing += parseFloat(v.tax_amount || v.amount || 0);
               });
             }
         }
      }
    });

    // Aggregate approved expenses by month
    (expenses || []).forEach(exp => {
      if (exp.status === 'Approved' && exp.date) {
        const d = new Date(exp.date);
        if (!isNaN(d)) {
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
          if (data[key]) {
            data[key].expenses += parseFloat(exp.amount) || 0;
          }
        }
      }
    });

    return monthKeys.map(key => {
       const [y, m] = key.split('-');
       const monthName = new Date(y, m - 1).toLocaleString('default', { month: 'short' });
       return { 
         name: `${monthName} ${y.slice(2)}`,
         'Revenue': Math.round(data[key].netRevenue),
         'GST': Math.round(data[key].gst),
         'Expenses': Math.round(data[key].expenses),
         'Outsourcing': Math.round(data[key].outsourcing)
       };
    });
  }, [projects, expenses]);

  // Calendar Logic
  const weeks = useMemo(() => {
    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const days = [];
    
    for(let i=0; i<firstDay.getDay(); i++) days.push(null);
    for(let i=1; i<=lastDay.getDate(); i++) days.push(new Date(year, month, i));
    
    const weeksArray = [];
    for (let i = 0; i < days.length; i += 7) {
        weeksArray.push(days.slice(i, i + 7));
    }
    return weeksArray;
  }, [currentMonth]);

  const getWeekRange = (week) => {
    const firstValidIndex = week.findIndex(d => d !== null);
    if (firstValidIndex === -1) return null;
    const firstValidDate = week[firstValidIndex];
    const startOfWeek = new Date(firstValidDate);
    startOfWeek.setDate(firstValidDate.getDate() - firstValidIndex);
    startOfWeek.setHours(0,0,0,0);
    
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6);
    endOfWeek.setHours(23,59,59,999);
    
    return { start: startOfWeek, end: endOfWeek };
  };

  const getProjectBars = (week) => {
    const range = getWeekRange(week);
    if (!range) return { bars: [], totalRows: 0 };
    
    const weekProjects = projects.filter(p => {
        const pStart = p.setup_date ? new Date(p.setup_date) : new Date(p.start_date);
        const pEnd = new Date(p.end_date);
        pStart.setHours(0,0,0,0); pEnd.setHours(23,59,59,999);
        return pStart <= range.end && pEnd >= range.start;
    });

    weekProjects.sort((a, b) => {
        const startA = a.setup_date ? new Date(a.setup_date) : new Date(a.start_date);
        const startB = b.setup_date ? new Date(b.setup_date) : new Date(b.start_date);
        if (startA - startB !== 0) return startA - startB;
        return (new Date(b.end_date) - startB) - (new Date(a.end_date) - startA);
    });

    const rows = [];
    const bars = weekProjects.map(p => {
        const pStart = p.setup_date ? new Date(p.setup_date) : new Date(p.start_date);
        const pEnd = new Date(p.end_date);
        pStart.setHours(0,0,0,0); pEnd.setHours(23,59,59,999);

        const start = pStart < range.start ? range.start : pStart;
        const end = pEnd > range.end ? range.end : pEnd;

        const diffStart = Math.floor((start - range.start) / (1000 * 60 * 60 * 24));
        const diffDuration = Math.floor((end - start) / (1000 * 60 * 60 * 24)) + 1;
        
        const startCol = Math.max(0, Math.min(6, diffStart));
        const span = Math.max(1, Math.min(7 - startCol, diffDuration));

        let rowIndex = 0;
        while (true) {
            if (!rows[rowIndex]) rows[rowIndex] = Array(7).fill(false);
            let collision = false;
            for (let i = startCol; i < startCol + span; i++) {
                if (rows[rowIndex][i]) { collision = true; break; }
            }
            if (!collision) {
                for (let i = startCol; i < startCol + span; i++) rows[rowIndex][i] = true;
                break;
            }
            rowIndex++;
        }
        return { project: p, startCol, span, rowIndex };
    });
    return { bars, totalRows: rows.length };
  };

  const changeMonth = (offset) => {
    const newDate = new Date(currentMonth);
    newDate.setMonth(newDate.getMonth() + offset);
    setCurrentMonth(newDate);
  };

  // Recent/Upcoming List (Setup Date +/- 7 days)
  const recentProjects = useMemo(() => {
      const today = new Date();
      today.setHours(0,0,0,0);
      const minDate = new Date(today); minDate.setDate(today.getDate() - 7);
      const maxDate = new Date(today); maxDate.setDate(today.getDate() + 7);
      
      return projects.filter(p => {
          const d = p.setup_date ? new Date(p.setup_date) : new Date(p.start_date);
          d.setHours(0,0,0,0);
          return d >= minDate && d <= maxDate;
      }).sort((a,b) => new Date(a.start_date) - new Date(b.start_date));
  }, [projects]);

  const todaysBrief = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = today.toISOString().split('T')[0];
    return {
      setupToday: projects.filter(p => p.setup_date === todayStr && !['Cancelled', 'Closed'].includes(p.status)),
      startingToday: projects.filter(p => p.start_date === todayStr && !['Cancelled', 'Closed'].includes(p.status)),
      endingToday: projects.filter(p => p.end_date === todayStr && p.status === 'Ongoing'),
      ongoingNoChallan: projects.filter(p => p.status === 'Ongoing' && !(p.challans || []).some(c => c.type === 'delivery')),
    };
  }, [projects]);

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-slate-800">Dashboard</h2>
        <span className="text-xs text-slate-400">{new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span>
      </div>
      
      {can(role, 'employees', 'edit') && lockedEmployees.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex flex-col md:flex-row items-start md:items-center justify-between gap-4 animate-pulse">
           <div className="flex items-center gap-3 text-red-800">
              <div className="bg-red-100 p-2 rounded-full"><AlertTriangle className="text-red-600" size={24} /></div>
              <div>
                 <div className="font-bold text-lg">Security Alert</div>
                 <div className="text-sm">{lockedEmployees.length} account(s) are currently locked due to failed login attempts.</div>
              </div>
           </div>
           <button onClick={() => navigate('/employees')} className="whitespace-nowrap bg-red-600 text-white px-4 py-2 rounded shadow-sm text-sm font-medium hover:bg-red-700">Review Accounts</button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <div className="rounded-xl bg-white p-4 shadow-sm border border-slate-200 flex items-start gap-3">
          <div className="p-2 rounded-lg bg-blue-50 text-blue-600"><CalendarDays size={18} /></div>
          <div>
            <div className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Active Events</div>
            <div className="mt-0.5 text-2xl font-bold text-slate-800">{activeProjects}</div>
          </div>
        </div>
        <div className="rounded-xl bg-white p-4 shadow-sm border border-slate-200 flex items-start gap-3">
          <div className="p-2 rounded-lg bg-amber-50 text-amber-600"><Clock size={18} /></div>
          <div>
            <div className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Pending Quotes</div>
            <div className="mt-0.5 text-2xl font-bold text-slate-800">{pendingQuotes}</div>
          </div>
        </div>
        {overdueProjects > 0 && (
          <div className="rounded-xl bg-red-50 p-4 shadow-sm border border-red-100 animate-pulse flex items-start gap-3">
            <div className="p-2 rounded-lg bg-red-100 text-red-600"><AlertCircle size={18} /></div>
            <div>
              <div className="text-xs text-red-600 font-semibold uppercase tracking-wide">Overdue Returns</div>
              <div className="mt-0.5 text-2xl font-bold text-red-700">{overdueProjects}</div>
            </div>
          </div>
        )}
        {can(role, 'expenses', 'approve') && (
          <div className="rounded-xl bg-white p-4 shadow-sm border border-slate-200 flex items-start gap-3">
            <div className="p-2 rounded-lg bg-rose-50 text-rose-600"><FileText size={18} /></div>
            <div>
              <div className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Pending Expenses</div>
              <div className="mt-0.5 text-2xl font-bold text-slate-800">
                {expenses.filter(e => e.status === 'Pending').length}
              </div>
            </div>
          </div>
        )}
        {can(role, 'finance', 'view') && (
          <div className="rounded-xl bg-white p-4 shadow-sm border border-slate-200 flex items-start gap-3">
            <div className="p-2 rounded-lg bg-emerald-50 text-emerald-600"><TrendingUp size={18} /></div>
            <div>
              <div className="text-xs text-slate-500 font-semibold uppercase tracking-wide">Gross Revenue</div>
              <div className="mt-0.5 text-xl font-bold text-slate-800">{formatCurrency(revenue)}</div>
            </div>
          </div>
        )}
      </div>

      {can(role, 'finance', 'view') && (
        <div className="rounded-xl bg-white p-6 shadow-sm border border-slate-200">
          <h3 className="mb-4 text-sm font-bold text-slate-800 uppercase tracking-wide">Revenue & Expenses — Last 6 Months</h3>
          <div className="h-80 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={revenueData} margin={{ top: 10, right: 20, left: 20, bottom: 5 }} barSize={20} barGap={2} barCategoryGap="20%">
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis
                  width={80}
                  tick={{ fontSize: 11 }}
                  tickFormatter={(value) => {
                    if (value >= 100000) return `₹${(value / 100000).toFixed(1)}L`;
                    if (value >= 1000) return `₹${(value / 1000).toFixed(0)}K`;
                    return `₹${value}`;
                  }}
                />
                <RechartsTooltip formatter={(value) => formatCurrency(value)} />
                <Legend />
                <Bar dataKey="Revenue" fill="#4f46e5" radius={[4, 4, 0, 0]} />
                <Bar dataKey="GST" fill="#818cf8" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Expenses" fill="#ef4444" radius={[4, 4, 0, 0]} />
                <Bar dataKey="Outsourcing" fill="#f97316" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}


      {/* ===== TODAY'S OPERATIONS ===== */}
      {can(role, 'projects', 'edit') && (
        Object.values(todaysBrief).some(arr => arr.length > 0) ? (
        <div className="rounded-xl bg-white shadow-sm border border-slate-200 overflow-hidden">
          <div className="border-b px-5 py-3 bg-indigo-50 flex items-center gap-2">
            <Truck size={16} className="text-indigo-500" />
            <h3 className="font-bold text-indigo-800">Today's Operations — {new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' })}</h3>
          </div>
          <div className="grid md:grid-cols-2 gap-0 divide-y md:divide-y-0 md:divide-x divide-slate-100">
            {todaysBrief.setupToday.length > 0 && (
              <div className="p-4">
                <div className="text-xs font-semibold text-amber-600 uppercase mb-2">🔧 Setup Today ({todaysBrief.setupToday.length})</div>
                {todaysBrief.setupToday.map(p => (
                  <div key={p.id} className="text-sm text-slate-700 mb-1">
                    <span className="font-medium">{p.project_name}</span>
                    {p.venue && <span className="text-slate-400 text-xs ml-1">@ {p.venue}</span>}
                  </div>
                ))}
              </div>
            )}
            {todaysBrief.startingToday.length > 0 && (
              <div className="p-4">
                <div className="text-xs font-semibold text-green-600 uppercase mb-2">▶ Starting Today ({todaysBrief.startingToday.length})</div>
                {todaysBrief.startingToday.map(p => (
                  <div key={p.id} className="text-sm text-slate-700 mb-1">
                    <span className="font-medium">{p.project_name}</span>
                    {p.venue && <span className="text-slate-400 text-xs ml-1">@ {p.venue}</span>}
                  </div>
                ))}
              </div>
            )}
            {todaysBrief.endingToday.length > 0 && (
              <div className="p-4">
                <div className="text-xs font-semibold text-blue-600 uppercase mb-2">⏹ Wrapping Up Today ({todaysBrief.endingToday.length})</div>
                {todaysBrief.endingToday.map(p => (
                  <div key={p.id} className="text-sm text-slate-700 mb-1">
                    <span className="font-medium">{p.project_name}</span>
                    {p.venue && <span className="text-slate-400 text-xs ml-1">@ {p.venue}</span>}
                  </div>
                ))}
              </div>
            )}
            {todaysBrief.ongoingNoChallan.length > 0 && (
              <div className="p-4">
                <div className="text-xs font-semibold text-red-600 uppercase mb-2">⚠ Ongoing — No Delivery Challan ({todaysBrief.ongoingNoChallan.length})</div>
                {todaysBrief.ongoingNoChallan.map(p => (
                  <div key={p.id} className="text-sm text-slate-700 mb-1">
                    <span className="font-medium">{p.project_name}</span>
                    <span className="text-slate-400 text-xs ml-1">({p.start_date} → {p.end_date})</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        ) : null
      )}

      {/* Calendar */}
      <div className="rounded-xl bg-white shadow-sm border border-slate-200 p-5">
          <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wide">Project Calendar</h3>
              <div className="flex items-center gap-2">
                  <button
                    onClick={() => changeMonth(-1)}
                    className="flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                    aria-label="Previous month"
                  >
                    <ChevronRight className="rotate-180" size={16} /> Prev
                  </button>
                  <span className="min-w-[160px] text-center font-bold text-slate-800">
                    {currentMonth.toLocaleString('default', { month: 'long', year: 'numeric' })}
                  </span>
                  <button
                    onClick={() => changeMonth(1)}
                    className="flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                    aria-label="Next month"
                  >
                    Next <ChevronRight size={16} />
                  </button>
              </div>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="grid grid-cols-7 border-b border-slate-200 bg-slate-50">
                  {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
                      <div key={d} className="p-2 text-center text-xs font-bold text-slate-600 uppercase">{d}</div>
                  ))}
              </div>
              {weeks.map((week, wIdx) => {
                  const { bars, totalRows } = getProjectBars(week);
                  const minHeight = Math.max(100, (totalRows * 24) + 40);
                  return (
                      <div key={wIdx} className="grid grid-cols-7 border-b border-slate-100 relative" style={{ minHeight: `${minHeight}px` }}>
                          {week.map((date, dIdx) => (
                              <div key={dIdx} className={`border-r border-slate-100 p-1 ${!date ? 'bg-slate-50' : ''}`}>
                                  {date && (
                                      <div className={`text-xs font-medium mb-1 ${date.toDateString() === new Date().toDateString() ? 'bg-indigo-600 text-white w-6 h-6 rounded-full flex items-center justify-center' : 'text-slate-400'}`}>
                                          {date.getDate()}
                                      </div>
                                  )}
                              </div>
                          ))}
                          <div className="absolute inset-0 top-8 flex flex-col pointer-events-none z-10">
                              {bars.map((bar, idx) => (
                                  (() => {
                                  const statusBg = getStatusBgColor(bar.project.status);
                                  const invoiceColor = getInvoiceTextColor(bar.project);
                                  const barStyle = { backgroundColor: statusBg, borderColor: statusBg };
                                  if (invoiceColor) barStyle.color = invoiceColor;
                                  return (
                                  <div 
                                      key={idx} 
                                      onClick={() => {
                                        if (onProjectClick) onProjectClick(bar.project.id);
                                        navigate(`/projects/${bar.project.id}`);
                                      }}
                                      className={`absolute h-5 rounded text-[10px] px-1 truncate cursor-pointer pointer-events-auto shadow-sm border ${STATUS_COLORS[bar.project.status]} hover:opacity-90`}
                                      style={{
                                          left: `${bar.startCol * 14.28}%`,
                                          width: `${bar.span * 14.28}%`,
                                          top: `${bar.rowIndex * 22}px`,
                                      margin: '0 2px',
                                      ...barStyle
                                      }}
                                      title={`${bar.project.project_name} (${bar.project.status})`}
                                  >
                                      <span className="font-bold mr-1">{clients.find(c=>c.id===bar.project.client_id)?.name}</span>
                                      {bar.project.project_name}
                                  </div>
                                  );
                                  })()
                              ))}
                          </div>
                      </div>
                  );
              })}
          </div>
      </div>

      <div className="rounded-xl bg-white shadow-sm border border-slate-200">
        <div className="border-b border-slate-100 px-5 py-3">
          <h3 className="text-sm font-bold text-slate-800 uppercase tracking-wide">Recent & Upcoming — Setup ±7 Days</h3>
        </div>
        <div className="divide-y divide-slate-100">
          {recentProjects.map(project => (
            <div key={project.id} className="flex items-center justify-between p-4 hover:bg-slate-50">
              <div>
                <div className="font-bold text-slate-800">{project.project_name}</div>
                <div className="text-sm text-slate-500">
                    <span className="font-medium text-indigo-600">{clients.find(c=>c.id===project.client_id)?.name}</span> • {project.venue}
                </div>
                <div className="text-xs text-slate-400 mt-1">
                    Start: {project.start_date} {project.setup_date && `| Setup: ${project.setup_date}`}
                </div>
              </div>
              <span className={`rounded-full px-2 py-1 text-xs font-medium border ${STATUS_COLORS[project.status]}`}>
                {project.status}
              </span>
            </div>
          ))}
          {recentProjects.length === 0 && <div className="p-4 text-center text-slate-400">No projects in range.</div>}
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
