// VERSION 3.0.0 FULL APP WITH FIREBASE INTEGRATION AND REACT FRONTEND
// VERSION 3.1.0 ADMIN DATABASE BACKUP AND RESTORE OPTION ADDED
// version 3.5.0 challan manager search added


import React, { useState, useEffect, useMemo } from 'react';
import { 
  LayoutDashboard, Box, Users, Calendar, FileText, 
  DollarSign, CheckCircle, AlertTriangle, Menu, X, 
  LogOut, Plus, Search, Filter, Upload, Image as ImageIcon,
  ChevronRight, ArrowLeft, Save, Trash2, MapPin, Edit, History,
  Phone, Mail, User, UserCog, Key, Shield, MoreVertical, Truck,
  Utensils, Hotel, Hammer, Briefcase, AlertCircle, Wallet, CreditCard,
  TrendingUp, TrendingDown, ShoppingBag, Percent, Calculator, Camera, FileCheck, Download, Settings
, Printer, Activity, RotateCcw, Copy, Layers, ListChecks, ClipboardList, Paperclip
} from 'lucide-react';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell 
} from 'recharts';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation, Link, useNavigate } from 'react-router-dom';


import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';
//import { saveAs } from 'file-saver';

import { initializeApp } from 'firebase/app';
import { getAnalytics } from "firebase/analytics";

import { 
  getAuth, signInAnonymously, onAuthStateChanged, signOut, signInWithCustomToken 
} from 'firebase/auth';
import {   getFirestore, collection, addDoc, updateDoc, doc, 
  deleteDoc, onSnapshot, query, where, serverTimestamp, setDoc, getDoc, arrayUnion, arrayRemove, getDocs, runTransaction
} from 'firebase/firestore';

// --- Configuration & Constants ---


const firebaseConfig = {
  apiKey: "AIzaSyBjd7u6nS7FD2Xr4aRe0WBu7CgAvmeIjcQ",
  authDomain: "terms-a005e.firebaseapp.com",
  projectId: "terms-a005e",
  storageBucket: "terms-a005e.firebasestorage.app",
  messagingSenderId: "269962655904",
  appId: "1:269962655904:web:7a59b171cfd80ac4d6b1c5",
  measurementId: "G-D0HZ3NB682"
};


const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const analytics = getAnalytics(app);
const appId = 'TERMS 1.0.0'; // You can name this whatever you want

const GST_STATE_CODES = {
  "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh",
  "05": "Uttarakhand", "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh",
  "10": "Bihar", "11": "Sikkim", "12": "Arunachal Pradesh", "19": "West Bengal", "27": "Maharashtra",
  "29": "Karnataka", "33": "Tamil Nadu", "36": "Telangana"
};

const STATUS_COLORS = {
  'Quoted': 'bg-orange-100 text-orange-800 border-orange-200',
  'Confirmed': 'bg-green-100 text-green-800 border-green-200',
  'Cancelled': 'bg-gray-100 text-gray-800 border-gray-200',
  'Ongoing': 'bg-red-100 text-red-800 border-red-200',
  'Completed': 'bg-blue-100 text-blue-800 border-blue-200',
  'Closed': 'bg-black text-white border-black',
};

const LOGISTICS_TYPES = [
  { id: 'travel', label: 'Travel Cost', icon: <Truck size={14} /> },
  { id: 'accommodation', label: 'Accommodation', icon: <Hotel size={14} /> },
  { id: 'food', label: 'Food & Beverage', icon: <Utensils size={14} /> },
  { id: 'labour', label: 'Labour Cost', icon: <Briefcase size={14} /> },
  { id: 'transport', label: 'Transportation', icon: <Truck size={14} /> },
];

const CATEGORIES = ['Sound', 'Lighting', 'Video', 'Camera', 'Trussing', 'Rigging', 'Projectors', 'LED', 'Power', 'Cables', 'Accessories'];
const EXPENSE_CATS = ['Travel', 'Food', 'Lodging', 'Fuel', 'Local Transport', 'Consumables', 'Misc', 'Labour'];

// --- Helper Functions ---


//version 1.3.0 finance implementation

const getProjectGrandTotal = (project) => {
  if (!project) return 0;
  // Equipment
  const equipment = (project.items || []).reduce((acc, i) => acc + (i.total || 0), 0);
  // Logistics
  let logistics = 0;
  if (project.logistics_costs) {
    Object.values(project.logistics_costs).forEach(c => {
       const base = c.amount || 0;
       logistics += base * (1 + (c.gst || 0)/100);
    });
  }
  return equipment + logistics;
};
//version 1.3.0 finance implementation

const formatCurrency = (amount) => {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(amount || 0);
};

const formatCurrencyPDF = (amount) => {
  return "Rs. " + new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount || 0);
};

const validateGSTIN = (gstin, stateCode) => {
  if (!gstin || gstin.length !== 15) return { valid: false, msg: 'Length must be 15' };
  const firstTwo = gstin.substring(0, 2);
  if (!GST_STATE_CODES[firstTwo]) return { valid: false, msg: 'Invalid State Code' };
  const regex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
  if (!regex.test(gstin)) return { valid: false, msg: 'Invalid Format Pattern' };
  return { valid: true, msg: 'Valid' };
};

const getDaysDifference = (start, end) => {
  if (!start || !end) return 1;
  const startDate = new Date(start);
  const endDate = new Date(end);
  const diffTime = Math.abs(endDate - startDate);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1; 
  return diffDays > 0 ? diffDays : 1;
};

const isDateOverlap = (start1, end1, start2, end2) => {
  if (!start1 || !end1 || !start2 || !end2) return false;
  const s1 = new Date(start1); const e1 = new Date(end1);
  const s2 = new Date(start2); const e2 = new Date(end2);
  return s1 <= e2 && s2 <= e1;
};

const getFinancialYear = () => {
  const now = new Date();
  const m = now.getMonth(); // 0 = Jan
  const y = now.getFullYear();
  if (m < 3) return `${y-1}-${String(y).slice(-2)}`;
  return `${y}-${String(y+1).slice(-2)}`;
};

// --- Shared Components ---

const LoadingSpinner = () => (
  <div className="flex h-screen items-center justify-center bg-slate-50">
    <div className="h-12 w-12 animate-spin rounded-full border-4 border-slate-300 border-t-indigo-600"></div>
  </div>
);

const ConfirmationModal = ({ isOpen, onClose, onConfirm, title, message }) => {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl bg-slate-50 border border-slate-200">
        <h3 className="text-lg font-bold text-white text-white mb-2">{title}</h3>
        <p className="text-slate-600 text-slate-300 mb-6">{message}</p>
        <div className="flex justify-end gap-3">
          <button onClick={onClose} className="px-4 py-2 rounded text-slate-600 hover:bg-slate-100 text-slate-300 hover:bg-slate-50">Cancel</button>
          <button onClick={() => { onConfirm(); onClose(); }} className="px-4 py-2 rounded bg-red-600 text-white hover:bg-red-700">Confirm</button>
        </div>
      </div>
    </div>
  );
};

const Toast = ({ message, type, onClose }) => {
  useEffect(() => {
    const timer = setTimeout(onClose, 3000);
    return () => clearTimeout(timer);
  }, [onClose]);
  const bg = type === 'error' ? 'bg-red-600' : type === 'success' ? 'bg-green-600' : 'bg-slate-50';
  return (
    <div className={`flex items-center gap-3 rounded-lg px-4 py-3 text-white shadow-lg ${bg} transition-all`}>
      <span className="text-sm font-medium">{message}</span>
      <button onClick={onClose} className="opacity-80 hover:opacity-100"><X size={16} /></button>
    </div>
  );
};

const Modal = ({ isOpen, onClose, title, children }) => {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-lg bg-white shadow-xl flex flex-col bg-slate-50 border border-slate-200">
        <div className="flex items-center justify-between border-b p-4 shrink-0 border-slate-200">
          <h3 className="text-lg font-semibold text-slate-800 text-white">{title}</h3>
          <button onClick={onClose} className="rounded-full p-1 hover:bg-slate-100 hover:bg-slate-50 text-slate-500 text-slate-400"><X size={20} /></button>
        </div>
        <div className="p-4 overflow-y-auto text-slate-800 text-slate-200">{children}</div>
      </div>
    </div>
  );
};

const NavItem = ({ to, icon: Icon, label, badge, setMobileMenuOpen }) => {
  const location = useLocation();
  const isActive = location.pathname.startsWith(to);
  return (
    <Link 
      to={to} 
      onClick={() => setMobileMenuOpen(false)} 
      className={`flex w-full items-center gap-3 rounded-lg p-3 transition-colors ${isActive ? 'bg-indigo-50 text-indigo-600 font-bold bg-indigo-900/50 text-indigo-300' : 'text-slate-600 hover:bg-slate-50 font-medium text-slate-300 hover:bg-slate-50'}`}
    >
      <Icon size={20} />
      <span className="font-medium flex-1 text-left">{label}</span>
      {badge > 0 && <span className="bg-red-600 text-white text-[10px] font-bold px-2 py-0.5 rounded-full">{badge}</span>}
    </Link>
  );
};

const NotFound = () => (
  <div className="flex flex-col items-center justify-center h-[60vh] text-slate-400">
    <AlertTriangle size={48} className="mb-4 text-slate-300" />
    <h2 className="text-2xl font-bold text-slate-600 text-slate-300">404 - Page Not Found</h2>
    <p className="mb-6">The page you are looking for does not exist.</p>
    <Link to="/dashboard" className="px-4 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700">Go Home</Link>
  </div>
);

// --- Initial Seed Data ---
const SEED_EMPLOYEES = [
  { name: 'System Admin', email: 'admin@rentalops.com', role: 'admin', status: 'Active', mobile1: '9999999999', address: 'HQ', photo_url: '', id_proof_url: '', address_proof_url: '' },
  { name: 'Sarah Manager', email: 'sarah@rentalops.com', role: 'manager', status: 'Active', mobile1: '9876543211', address: '456 Market St', photo_url: '', id_proof_url: '', address_proof_url: '' },
  { name: 'Mike Tech', email: 'mike@rentalops.com', role: 'tech', status: 'Active', mobile1: '9876543212', address: '789 Tech Park', photo_url: '', id_proof_url: '', address_proof_url: '' },
];
const SEED_INVENTORY = [
  { name: '4K Projector Laser 10k', category: 'Projectors', total: 5, rate_per_day: 15000, gst_rate: 18, hsn_code: '8528', location: 'Warehouse A', gst_history: [] },
  { name: 'JBL VRX Line Array', category: 'Sound', total: 12, rate_per_day: 4500, gst_rate: 18, hsn_code: '8518', location: 'Warehouse B', gst_history: [] },
  { name: 'Sony A7S III', category: 'Camera', total: 3, rate_per_day: 8000, gst_rate: 18, hsn_code: '8525', location: 'Safe Room', gst_history: [] },
];

// --- Sub-Components ---

const Dashboard = ({ projects, expenses, role, clients, onProjectClick, employees = [], payments = [] }) => {
  const navigate = useNavigate();
  const [currentMonth, setCurrentMonth] = useState(new Date());

  const activeProjects = projects.filter(p => ['Confirmed', 'Ongoing'].includes(p.status)).length;
  const pendingQuotes = projects.filter(p => p.status === 'Quoted').length;
  const totalExpenses = expenses.reduce((sum, e) => sum + parseFloat(e.amount || 0), 0);
  const revenue = projects.filter(p => p.status === 'Completed' || p.status === 'Closed').reduce((sum, p) => sum + getProjectGrandTotal(p), 0);
  
  const overdueProjects = projects.filter(p => {
    const end = new Date(p.end_date); end.setHours(23,59,59);
    return p.status === 'Ongoing' && end < new Date();
  }).length;

  const lockedEmployees = employees.filter(e => e.is_locked);

  // Revenue Data (Monthwise)
  const revenueData = useMemo(() => {
    const data = {};
    projects.forEach(p => {
      if (['Completed', 'Closed'].includes(p.status)) {
         const d = new Date(p.end_date);
         if(!isNaN(d)) {
             const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2, '0')}`;
             data[key] = (data[key] || 0) + getProjectGrandTotal(p);
         }
      }
    });
    return Object.keys(data).sort().map(key => {
       const [y, m] = key.split('-');
       const monthName = new Date(y, m-1).toLocaleString('default', { month: 'short' });
       return { name: `${monthName} ${y}`, value: data[key] };
    });
  }, [projects]);

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

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-slate-800">Dashboard</h2>
      
      {role === 'admin' && lockedEmployees.length > 0 && (
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
        <div className="rounded-xl bg-white p-4 shadow-sm border border-slate-200">
          <div className="text-sm text-slate-600 font-bold uppercase">Active Events</div>
          <div className="mt-1 text-2xl font-bold text-blue-600">{activeProjects}</div>
        </div>
        <div className="rounded-xl bg-white p-4 shadow-sm border border-slate-200">
          <div className="text-sm text-slate-600 font-bold uppercase">Pending Quotes</div>
          <div className="mt-1 text-2xl font-bold text-orange-600">{pendingQuotes}</div>
        </div>
        {overdueProjects > 0 && (
          <div className="rounded-xl bg-red-50 p-4 shadow-sm border border-red-100 animate-pulse">
            <div className="text-sm text-red-600 font-bold flex items-center gap-1"><AlertCircle size={14}/> Overdue Returns</div>
            <div className="mt-1 text-2xl font-bold text-red-700">{overdueProjects}</div>
          </div>
        )}
        {(role === 'admin' || role === 'manager') && (
          <div className="rounded-xl bg-white p-4 shadow-sm border border-slate-200">
            <div className="text-sm text-slate-600 font-bold uppercase">Pending Expenses</div>
            <div className="mt-1 text-2xl font-bold text-red-600">
              {expenses.filter(e => e.status === 'Pending').length}
            </div>
          </div>
        )}
        {role === 'admin' && (
           <div className="rounded-xl bg-white p-4 shadow-sm border border-slate-200">
           <div className="text-sm text-slate-600 font-bold uppercase">Gross Revenue</div>
           <div className="mt-1 text-xl font-bold text-green-700">{formatCurrency(revenue)}</div>
         </div>
        )}
      </div>

      {role === 'admin' && (
        <div className="rounded-xl bg-white p-6 shadow-sm border border-slate-200">
          <h3 className="mb-4 font-bold text-slate-800">Monthly Revenue</h3>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={revenueData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="name" />
                <YAxis />
                <RechartsTooltip formatter={(value) => formatCurrency(value)} />
                <Bar dataKey="value" fill="#4f46e5" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Calendar */}
      <div className="rounded-xl bg-white shadow-sm border border-slate-200 p-6">
          <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-slate-800">Project Calendar</h3>
              <div className="flex items-center gap-4">
                  <button onClick={() => changeMonth(-1)} className="p-1 hover:bg-slate-100 rounded"><ChevronRight className="rotate-180" size={20}/></button>
                  <span className="font-bold text-slate-800">{currentMonth.toLocaleString('default', { month: 'long', year: 'numeric' })}</span>
                  <button onClick={() => changeMonth(1)} className="p-1 hover:bg-slate-100 rounded"><ChevronRight size={20}/></button>
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
                                  <div 
                                      key={idx} 
                                      onClick={() => {
                                        if (onProjectClick) onProjectClick(bar.project.id);
                                        navigate('/projects');
                                      }}
                                      className={`absolute h-5 rounded text-[10px] px-1 truncate cursor-pointer pointer-events-auto shadow-sm border ${STATUS_COLORS[bar.project.status]} hover:opacity-90`}
                                      style={{
                                          left: `${bar.startCol * 14.28}%`,
                                          width: `${bar.span * 14.28}%`,
                                          top: `${bar.rowIndex * 22}px`,
                                          margin: '0 2px'
                                      }}
                                      title={`${bar.project.project_name} (${bar.project.status})`}
                                  >
                                      <span className="font-bold mr-1">{clients.find(c=>c.id===bar.project.client_id)?.name}</span>
                                      {bar.project.project_name}
                                  </div>
                              ))}
                          </div>
                      </div>
                  );
              })}
          </div>
      </div>

      <div className="rounded-xl bg-white shadow-sm border border-slate-200">
        <div className="border-b p-4">
          <h3 className="font-bold text-slate-800">Recent & Upcoming (Setup +/- 7 Days)</h3>
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

const Clients = ({ clients, inventory, role, db, appId, logAction }) => {
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [formData, setFormData] = useState({ 
    name: '', type: 'Client', gstin: '', state: '', address: '', contacts: [],
    billing_terms: 'Net 15', custom_terms: '', remarks: ''
  });
  const [newContact, setNewContact] = useState({ name: '', role: '', phone: '', email: '' });
  const [selectedVendorForAssets, setSelectedVendorForAssets] = useState(null);
  const [vendorAssetForm, setVendorAssetForm] = useState({ name: '', category: 'Sound', qty: 1, price: 0 });
  const [confirmModal, setConfirmModal] = useState({ isOpen: false, title: '', message: '', onConfirm: () => {} });


  const openAdd = () => {
    setEditingId(null);
    setFormData({ name: '', type: 'Client', gstin: '', state: '', address: '', contacts: [], billing_terms: 'Net 15', custom_terms: '', remarks: '' });
    setIsAddOpen(true);
  };

  const openEdit = (client) => {
    setEditingId(client.id);
    setFormData({
      name: client.name, type: client.type, gstin: client.gstin || '', state: client.state || '', 
      address: client.address || '', contacts: client.contacts || [], 
      billing_terms: client.billing_terms || 'Net 15', custom_terms: client.custom_terms || '', remarks: client.remarks || ''
    });
    setIsAddOpen(true);
  };

  const handleDelete = async (id) => {
    setConfirmModal({
      isOpen: true,
      title: 'Delete Client',
      message: 'Are you sure you want to delete this client? This action cannot be undone.',
      onConfirm: async () => {
        const clientName = clients.find(c => c.id === id)?.name;
        await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'clients', id));
        logAction('clients', 'delete', id, { name: clientName }, clientName);
      }
    });
  };

  const handleAddContact = () => {
    if (!newContact.name || !newContact.phone) return alert("Name and Phone are required.");
    setFormData({ ...formData, contacts: [...formData.contacts, newContact] });
    setNewContact({ name: '', role: '', phone: '', email: '' });
  };

  const handleRemoveContact = (index) => {
    const updated = [...formData.contacts];
    updated.splice(index, 1);
    setFormData({ ...formData, contacts: updated });
  };

  const handleSave = async () => {
    if (formData.gstin) {
      const val = validateGSTIN(formData.gstin, formData.state);
      if (!val.valid) return alert(`GST Error: ${val.msg}`);
    }
    const data = { ...formData, updated_at: serverTimestamp() };
    
    if (editingId) {
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'clients', editingId), data);
      logAction('clients', 'update', editingId, data, formData.name);
    } else {
      const docRef = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'clients'), { ...data, created_at: serverTimestamp() });
      logAction('clients', 'create', docRef.id, data, formData.name);
    }
    setIsAddOpen(false);
  };

  const handleSaveVendorAsset = async () => {
    if (!vendorAssetForm.name || !vendorAssetForm.qty) return alert("Name and Qty required");
    
    const newItem = {
      name: vendorAssetForm.name,
      category: vendorAssetForm.category || 'Accessories',
      total: parseInt(vendorAssetForm.qty),
      rate_per_day: parseFloat(vendorAssetForm.price) || 0,
      vendor_id: selectedVendorForAssets.id,
      is_external: true,
      status: 'Available',
      created_at: new Date().toISOString(),
      brand: '', sub_category: '', serial_number: '', location: 'Vendor Premise', gst_rate: 18
    };

    const docRef = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'inventory'), newItem);
    logAction('inventory', 'create_vendor_asset', docRef.id, newItem, newItem.name);
    setVendorAssetForm({ name: '', category: 'Sound', qty: 1, price: 0 });
  };

  const handleDeleteAsset = async (assetId) => {
    if (confirm('Remove this asset from vendor list?')) {
        await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'inventory', assetId));
        logAction('inventory', 'delete_vendor_asset', assetId, {}, 'Vendor Asset');
    }
  };

  const filteredClients = clients.filter(client => 
    client.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <h2 className="text-2xl font-bold text-slate-800">Clients & Vendors</h2>
        <div className="flex gap-2 w-full md:w-auto">
          <div className="hidden md:flex items-center rounded border px-3 py-1 bg-white flex-1">
            <Search size={16} className="text-slate-400 mr-2" />
            <input placeholder="Search..." className="text-sm outline-none text-black" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
          </div>
          {role !== 'tech' && role !== 'auditor' && (
            <button onClick={openAdd} className="flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-white hover:bg-indigo-700 whitespace-nowrap flex-1 md:flex-none"><Plus size={18} /> Add Client/Vendor</button>
          )}
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {filteredClients.map(client => (
          <div key={client.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm flex flex-col justify-between group relative">
            {(role === 'admin' || role === 'manager') && (
              <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button onClick={(e) => {e.stopPropagation(); openEdit(client)}} className="p-1 text-blue-600 hover:bg-blue-50 rounded"><Edit size={14}/></button>
                <button onClick={(e) => {e.stopPropagation(); handleDelete(client.id)}} className="p-1 text-red-600 hover:bg-red-50 rounded"><Trash2 size={14}/></button>
              </div>
            )}
            <div>
              <div className="flex justify-between items-start">
                <h3 className="font-bold text-slate-800 text-lg">{client.name}</h3>
                <div className="flex flex-col items-end gap-1 mt-6">
                  <span className={`px-2 py-0.5 text-xs rounded ${client.type === 'Vendor' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>{client.type}</span>
                  {client.billing_terms && <span className="px-2 py-0.5 text-xs rounded bg-slate-100 text-slate-600 border border-slate-200">{client.billing_terms}</span>}
                </div>
              </div>
              <div className="mt-3 space-y-2 text-sm text-slate-600">
                <div className="flex items-start gap-2">
                  <MapPin size={16} className="mt-0.5 text-slate-400 shrink-0" />
                  <div>
                    <div className="text-slate-600">{GST_STATE_CODES[client.gstin?.substring(0,2)] || 'Unknown State'}</div>
                    <div className="text-slate-500 text-xs mt-1">{client.address || 'No address provided'}</div>
                  </div>
                </div>
              </div>
            </div>
            <div className="mt-4 border-t pt-3 border-slate-100">
                <div className="text-xs font-semibold text-slate-400 mb-2 uppercase tracking-wide">Primary Contact</div>
                {client.contacts?.[0] ? (
                  <div className="flex items-center gap-3">
                    <div className="h-8 w-8 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-700 font-bold">{client.contacts[0].name.charAt(0)}</div>
                    <div className="text-sm">
                      <div className="font-medium text-slate-800">{client.contacts[0].name}</div>
                      <div className="text-slate-500 text-xs">{client.contacts[0].phone}</div>
                    </div>
                  </div>
                ) : <div className="text-sm text-slate-400 italic">No contact persons added</div>}
            </div>
            {(client.type === 'Vendor' || client.type === 'Both') && (
                <button onClick={(e) => {e.stopPropagation(); setSelectedVendorForAssets(client)}} className="mt-3 w-full flex items-center justify-center gap-2 rounded border border-indigo-200 bg-indigo-50 py-1.5 text-sm font-medium text-indigo-700 hover:bg-indigo-100">
                    <Box size={16} /> Manage Assets ({inventory ? inventory.filter(i => i.vendor_id === client.id).length : 0})
                </button>
            )}
          </div>
        ))}
      </div>
      <Modal isOpen={isAddOpen} onClose={() => setIsAddOpen(false)} title={editingId ? "Edit Client/Vendor" : "Add Client/Vendor"}>
        <div className="space-y-6">
          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-white border-b pb-1 text-slate-200 border-slate-200">Basic Details</h4>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="block text-sm font-bold text-slate-800 text-slate-300">Type</label><select className="w-full rounded border p-2 text-black bg-slate-50 border-slate-200 text-white" value={formData.type} onChange={e => setFormData({...formData, type: e.target.value})}><option value="Client">Client</option><option value="Vendor">Vendor</option><option value="Both">Both</option></select></div>
              <div><label className="block text-sm font-bold text-slate-800 text-slate-300">GSTIN</label><input className="w-full rounded border p-2 uppercase text-black bg-slate-50 border-slate-200 text-white" maxLength={15} placeholder="15 char GSTIN" value={formData.gstin} onChange={e => setFormData({...formData, gstin: e.target.value.toUpperCase()})} /></div>
            </div>
            <div><label className="block text-sm font-bold text-slate-800 text-slate-300">Company Name</label><input className="w-full rounded border p-2 text-black bg-slate-50 border-slate-200 text-white" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} /></div>
            <div><label className="block text-sm font-bold text-slate-800 text-slate-300">Full Address</label><textarea className="w-full rounded border p-2 text-sm text-black bg-slate-50 border-slate-200 text-white" rows={2} value={formData.address} onChange={e => setFormData({...formData, address: e.target.value})} /></div>
          </div>
          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-white border-b pb-1 text-slate-200 border-slate-200">Financial & Terms</h4>
            <div><label className="block text-sm font-bold text-slate-800 text-slate-300">Credit Terms</label><select className="w-full rounded border p-2 text-black bg-slate-50 border-slate-200 text-white" value={formData.billing_terms} onChange={e => setFormData({...formData, billing_terms: e.target.value})}><option value="Net 15">Net 15 Days</option><option value="Net 30">Net 30 Days</option><option value="Net 45">Net 45 Days</option><option value="Net 60">Net 60 Days</option><option value="Net 90">Net 90 Days</option></select></div>
          </div>
          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-white border-b pb-1 text-slate-200 border-slate-200">Contact Persons</h4>
            {formData.contacts.length > 0 && (
              <div className="space-y-2 mb-3">{formData.contacts.map((c, idx) => (<div key={idx} className="flex items-center justify-between bg-slate-50 p-2 rounded border border-slate-200 bg-slate-50 border-slate-200"><div><div className="text-sm font-medium text-slate-800 text-slate-200">{c.name}</div><div className="text-xs text-slate-500 text-slate-400">{c.phone}</div></div><button onClick={() => handleRemoveContact(idx)} className="text-red-500 hover:text-red-700"><Trash2 size={14} /></button></div>))}</div>
            )}
            <div className="bg-slate-50 p-3 rounded border border-dashed border-slate-300 bg-slate-50 border-slate-200"><div className="grid grid-cols-2 gap-2 mb-2"><input className="rounded border p-1.5 text-sm text-black bg-slate-50 border-slate-200 text-white" placeholder="Name *" value={newContact.name} onChange={e => setNewContact({...newContact, name: e.target.value})} /><input className="rounded border p-1.5 text-sm text-black bg-slate-50 border-slate-200 text-white" placeholder="Role" value={newContact.role} onChange={e => setNewContact({...newContact, role: e.target.value})} /><input className="rounded border p-1.5 text-sm text-black bg-slate-50 border-slate-200 text-white" placeholder="Phone *" value={newContact.phone} onChange={e => setNewContact({...newContact, phone: e.target.value})} /><input className="rounded border p-1.5 text-sm text-black bg-slate-50 border-slate-200 text-white" placeholder="Email" value={newContact.email} onChange={e => setNewContact({...newContact, email: e.target.value})} /></div><button onClick={handleAddContact} className="w-full rounded border border-indigo-200 bg-white py-1 text-sm text-indigo-600 hover:bg-indigo-50 bg-slate-50 border-slate-200 text-indigo-400 hover:bg-slate-50">+ Add to List</button></div>
          </div>
          <button onClick={handleSave} className="w-full rounded bg-indigo-600 py-3 text-white font-medium hover:bg-indigo-700 shadow-sm mt-4">Save Client / Vendor</button>
        </div>
      </Modal>

      {/* Vendor Assets Modal */}
      <Modal isOpen={!!selectedVendorForAssets} onClose={() => setSelectedVendorForAssets(null)} title={`Vendor Assets: ${selectedVendorForAssets?.name}`}>
        <div className="space-y-6">
            <div className="bg-slate-50 p-4 rounded-lg border border-slate-200">
                <h4 className="text-sm font-bold text-slate-700 mb-3 text-slate-200">Add New Asset</h4>
                <div className="grid grid-cols-2 gap-3 mb-3">
                    <div><label className="text-xs font-bold text-white">Item Name</label><input className="w-full rounded border border-slate-300 p-2 text-sm text-white" value={vendorAssetForm.name} onChange={e => setVendorAssetForm({...vendorAssetForm, name: e.target.value})} placeholder="e.g. LED Wall Panel" /></div>
                    <div><label className="text-xs font-bold text-white">Category</label><select className="w-full rounded border border-slate-300 p-2 text-sm text-white" value={vendorAssetForm.category} onChange={e => setVendorAssetForm({...vendorAssetForm, category: e.target.value})}>{CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}</select></div>
                    <div><label className="text-xs font-bold text-white">Quantity</label><input type="number" className="w-full rounded border border-slate-300 p-2 text-sm text-white" value={vendorAssetForm.qty} onChange={e => setVendorAssetForm({...vendorAssetForm, qty: e.target.value})} /></div>
                    <div><label className="text-xs font-bold text-white">Offered Price (Rate)</label><input type="number" className="w-full rounded border border-slate-300 p-2 text-sm text-white" value={vendorAssetForm.price} onChange={e => setVendorAssetForm({...vendorAssetForm, price: e.target.value})} /></div>
                </div>
                <button onClick={handleSaveVendorAsset} className="w-full rounded bg-indigo-600 py-2 text-white text-sm font-medium hover:bg-indigo-700">Add Asset</button>
            </div>

            <div>
                <h4 className="text-sm font-bold text-white mb-2">Current Assets</h4>
                <div className="max-h-60 overflow-y-auto border rounded-lg">
                    <table className="w-full text-sm text-left"><thead className="bg-slate-100 text-white font-bold sticky top-0"><tr><th className="p-2">Item</th><th className="p-2">Qty</th><th className="p-2">Price</th><th className="p-2"></th></tr></thead><tbody className="divide-y divide-slate-100">
                        {inventory.filter(i => i.vendor_id === selectedVendorForAssets?.id).map(item => (
                            <tr key={item.id}><td className="p-2 text-white">{item.name}<div className="text-xs text-slate-500">{item.category}</div></td><td className="p-2 text-white">{item.total}</td><td className="p-2 text-white">{formatCurrency(item.rate_per_day)}</td><td className="p-2 text-right"><button onClick={() => handleDeleteAsset(item.id)} className="text-red-500 hover:text-red-700"><Trash2 size={14}/></button></td></tr>
                        ))}
                        {inventory.filter(i => i.vendor_id === selectedVendorForAssets?.id).length === 0 && <tr><td colSpan={4} className="p-4 text-center text-slate-400">No assets listed.</td></tr>}
                    </tbody></table>
                </div>
            </div>
        </div>
      </Modal>
    </div>
  );
};


// version with Projects component commented to project filter out version 1.0.0
// const Projects = ({ projects, clients, inventory, expenses, employees, role, user, db, appId }) => {
//   const [selectedProjectId, setSelectedProjectId] = useState(null);
//   const [isCreateOpen, setIsCreateOpen] = useState(false);
//   const [editingId, setEditingId] = useState(null);
//   const [isAllocationModalOpen, setIsAllocationModalOpen] = useState(false);
//   const [allocationForm, setAllocationForm] = useState({ item_id: '', qty: 1, rate: 0, days: 1, gst_rate: 18, available_qty: 0 });
//   const [isEmpModalOpen, setIsEmpModalOpen] = useState(false);
//   const [newProj, setNewProj] = useState({ project_name: '', client_id: '', start_date: '', end_date: '', venue: '', status: 'Quoted', items: [], assigned_employees: [], logistics_costs: {} });

//   const selectedProject = useMemo(() => projects.find(p => p.id === selectedProjectId), [projects, selectedProjectId]);

//   const getAvailableQty = (itemId) => {
//     const item = inventory.find(i => i.id === itemId);
//     if (!item) return 0;
//     if (!selectedProject?.start_date || !selectedProject?.end_date) return item.total;
//     const overlappingProjs = projects.filter(p => p.id !== selectedProject.id && ['Confirmed', 'Ongoing'].includes(p.status) && isDateOverlap(selectedProject.start_date, selectedProject.end_date, p.start_date, p.end_date));
//     const usedQty = overlappingProjs.reduce((acc, p) => {
//       const alloc = (p.items || []).find(i => i.item_id === itemId);
//       return acc + (alloc ? (parseInt(alloc.qty) || 0) : 0);
//     }, 0);
//     return Math.max(0, item.total - usedQty);
//   };

//   const isEmployeeBusy = (empId) => {
//     if (!selectedProject?.start_date || !selectedProject?.end_date) return false;
//     const overlappingProjs = projects.filter(p => p.id !== selectedProject.id && ['Confirmed', 'Ongoing'].includes(p.status) && isDateOverlap(selectedProject.start_date, selectedProject.end_date, p.start_date, p.end_date));
//     return overlappingProjs.some(p => (p.assigned_employees || []).includes(empId));
//   };

//   const openCreate = () => {
//     setEditingId(null);
//     setNewProj({ project_name: '', client_id: '', start_date: '', end_date: '', venue: '', status: 'Quoted', items: [], assigned_employees: [], logistics_costs: {} });
//     setIsCreateOpen(true);
//   };

//   const openEdit = (proj) => {
//     setEditingId(proj.id);
//     setNewProj({ 
//       project_name: proj.project_name, client_id: proj.client_id, 
//       start_date: proj.start_date, end_date: proj.end_date, 
//       venue: proj.venue, status: proj.status, 
//       items: proj.items || [], assigned_employees: proj.assigned_employees || [], logistics_costs: proj.logistics_costs || {} 
//     });
//     setIsCreateOpen(true);
//   };

//   const handleDelete = async (id) => {
//     if(!confirm("Are you sure? This will delete the project and all associated data.")) return;
//     await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', id));
//   };

//   const handleSaveProject = async () => {
//     if(!newProj.client_id || !newProj.project_name) return alert("Missing fields");
//     const data = { ...newProj, updated_at: serverTimestamp() };
//     if (editingId) {
//       await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', editingId), data);
//     } else {
//       await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'projects'), { ...data, created_by: user.uid, created_at: serverTimestamp() });
//     }
//     setIsCreateOpen(false); 
//   };

//   const updateStatus = async (pid, newStatus) => {
//     if (newStatus === 'Closed' && role !== 'admin') return alert("Only Admin can close projects.");
//     await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', pid), { status: newStatus });
//   };

//   const toggleEmployee = async (empId) => {
//     const currentAssigned = selectedProject.assigned_employees || [];
//     const newAssigned = currentAssigned.includes(empId) ? currentAssigned.filter(id => id !== empId) : [...currentAssigned, empId];
//     await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), { assigned_employees: newAssigned });
//   };

//   const updateLogisticsCost = async (type, field, value) => {
//     const currentCosts = selectedProject.logistics_costs || {};
//     const newCosts = { ...currentCosts, [type]: { ...(currentCosts[type] || { amount: 0, gst: 0 }), [field]: parseFloat(value) || 0 } };
//     await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), { logistics_costs: newCosts });
//   };

//   const openAllocationModal = () => {
//     const days = selectedProject?.start_date && selectedProject?.end_date ? getDaysDifference(selectedProject.start_date, selectedProject.end_date) : 1;
//     setAllocationForm({ item_id: '', qty: 1, rate: 0, days: days, gst_rate: 18, available_qty: 0 });
//     setIsAllocationModalOpen(true);
//   };

//   const handleItemSelect = (e) => {
//     const itemId = e.target.value;
//     if (!itemId) return setAllocationForm(p => ({...p, item_id: '', available_qty: 0}));
//     const item = inventory.find(i => i.id === itemId);
//     if (item) setAllocationForm(p => ({ ...p, item_id: itemId, rate: item.rate_per_day || 0, gst_rate: item.gst_rate || 18, available_qty: getAvailableQty(itemId) }));
//   };

//   const handleSaveAllocation = async () => {
//     if(!allocationForm.item_id) return alert("Select an item");
//     const item = inventory.find(i => i.id === allocationForm.item_id);
//     if (allocationForm.qty > allocationForm.available_qty) {
//       if(!confirm(`Warning: You are allocating ${allocationForm.qty} but only ${allocationForm.available_qty} are available. Proceed?`)) return;
//     }
//     const amount = allocationForm.qty * allocationForm.rate * allocationForm.days;
//     const newItem = { id: Date.now().toString(), item_id: item.id, item_name: item.name, category: item.category, is_external: item.is_external || false, qty: parseInt(allocationForm.qty), rate: parseFloat(allocationForm.rate), days: parseInt(allocationForm.days), gst_rate: parseFloat(allocationForm.gst_rate), amount, gst_amount: amount * (allocationForm.gst_rate/100), total: amount * (1 + allocationForm.gst_rate/100) };
//     await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), { items: arrayUnion(newItem) });
//     setAllocationForm(p => ({...p, item_id: '', qty: 1, available_qty: 0})); 
//   };

//   const handleRemoveAllocation = async (item) => {
//     if(confirm("Remove this item?")) await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), { items: arrayRemove(item) });
//   };

//   const calculateProjectTotals = () => {
//     if (!selectedProject) return { equipment: 0, logistics: 0, total: 0, gst_output: 0, gst_input: 0, outsourcing: 0, direct_expense: 0 };
    
//     // Revenue
//     const equipmentBase = (selectedProject.items || []).reduce((acc, i) => acc + (i.amount || 0), 0);
//     const equipmentGST = (selectedProject.items || []).reduce((acc, i) => acc + (i.gst_amount || 0), 0);
    
//     let logisticsBase = 0;
//     let logisticsGST = 0;
//     if (selectedProject.logistics_costs) {
//       Object.values(selectedProject.logistics_costs).forEach(c => {
//          const base = c.amount || 0;
//          logisticsBase += base;
//          logisticsGST += base * ((c.gst || 0)/100);
//       });
//     }

//     // Costs
//     const outsourcingBase = (selectedProject.vendor_allocations || []).reduce((acc, v) => acc + (v.amount || 0), 0);
//     const outsourcingGST = (selectedProject.vendor_allocations || []).reduce((acc, v) => acc + (v.amount * (v.gst/100) || 0), 0);
    
//     // Direct Expenses (Logged by employees against this project)
//     const directExpenses = expenses
//       .filter(e => e.project_id === selectedProject.id && e.status !== 'Rejected')
//       .reduce((acc, e) => acc + parseFloat(e.amount || 0), 0);

//     const gstOutput = equipmentGST + logisticsGST;
//     const gstInput = outsourcingGST; // Assuming direct expenses are inclusive or GST not tracked separately yet
    
//     return { 
//       equipment: equipmentBase, 
//       logistics: logisticsBase, 
//       outsourcing: outsourcingBase,
//       direct_expense: directExpenses,
//       gst_output: gstOutput,
//       gst_input: gstInput,
//       gst_payable: gstOutput - gstInput,
//       total_revenue: equipmentBase + logisticsBase + gstOutput,
//       total_cost: outsourcingBase + directExpenses + gstInput // cost to company
//     };
//   };

//   if (selectedProject) {
//     const totals = calculateProjectTotals();
//     const margin = (totals.equipment + totals.logistics) - (totals.outsourcing + totals.direct_expense);

//     return (
//       <div className="space-y-6">
//         <button onClick={() => setSelectedProjectId(null)} className="flex items-center text-slate-500 hover:text-indigo-600"><ArrowLeft size={16} className="mr-1" /> Back to Projects</button>
//         <div className="flex flex-col justify-between gap-4 rounded-xl bg-white p-6 shadow-sm md:flex-row md:items-center">
//           <div><h1 className="text-2xl font-bold text-slate-800">{selectedProject.project_name}</h1><div className="flex items-center gap-2 text-slate-500"><span>{clients.find(c=>c.id === selectedProject.client_id)?.name}</span><span>•</span><span>{selectedProject.start_date} to {selectedProject.end_date}</span></div></div>
//           <div className="flex items-center gap-3"><span className={`px-3 py-1 rounded-full text-sm font-bold border ${STATUS_COLORS[selectedProject.status]}`}>{selectedProject.status}</span>{(role === 'admin' || role === 'manager') && (<select className="rounded border p-1 text-sm bg-slate-50" value={selectedProject.status} onChange={(e) => updateStatus(selectedProject.id, e.target.value)}><option value="Quoted">Quoted</option><option value="Confirmed">Confirmed</option><option value="Ongoing">Ongoing</option><option value="Completed">Completed</option><option value="Closed">Closed</option><option value="Cancelled">Cancelled</option></select>)}</div>
//         </div>

//         {/* Profit & Loss Summary */}
//         <div className="rounded-xl bg-white p-6 shadow-sm border border-indigo-100">
//            <h3 className="mb-4 font-bold text-slate-800 text-lg flex items-center gap-2"><Calculator size={20} className="text-indigo-600"/> Profit & Loss Summary</h3>
//            <div className="grid grid-cols-2 md:grid-cols-4 gap-6 text-sm">
//               <div className="space-y-2">
//                  <div className="font-semibold text-slate-500 border-b pb-1">REVENUE (Excl. GST)</div>
//                  <div className="flex justify-between"><span>Equipment</span><span className="font-medium">{formatCurrency(totals.equipment)}</span></div>
//                  <div className="flex justify-between"><span>Logistics</span><span className="font-medium">{formatCurrency(totals.logistics)}</span></div>
//                  <div className="flex justify-between text-indigo-700 font-bold border-t pt-1"><span>Total</span><span>{formatCurrency(totals.equipment + totals.logistics)}</span></div>
//               </div>
//               <div className="space-y-2">
//                  <div className="font-semibold text-slate-500 border-b pb-1">DIRECT COSTS</div>
//                  <div className="flex justify-between"><span>Outsourcing</span><span className="font-medium text-red-600">-{formatCurrency(totals.outsourcing)}</span></div>
//                  <div className="flex justify-between"><span>Expenses</span><span className="font-medium text-red-600">-{formatCurrency(totals.direct_expense)}</span></div>
//                  <div className="flex justify-between text-red-700 font-bold border-t pt-1"><span>Total</span><span>-{formatCurrency(totals.outsourcing + totals.direct_expense)}</span></div>
//               </div>
//               <div className="space-y-2">
//                  <div className="font-semibold text-slate-500 border-b pb-1">GST ANALYSIS</div>
//                  <div className="flex justify-between"><span>Output (Coll)</span><span className="font-medium text-green-600">{formatCurrency(totals.gst_output)}</span></div>
//                  <div className="flex justify-between"><span>Input (Paid)</span><span className="font-medium text-red-600">{formatCurrency(totals.gst_input)}</span></div>
//                  <div className="flex justify-between font-bold border-t pt-1"><span>Payable</span><span>{formatCurrency(totals.gst_payable)}</span></div>
//               </div>
//               <div className="bg-slate-50 p-3 rounded flex flex-col justify-center text-center">
//                  <div className="text-xs font-semibold text-slate-500 uppercase">Est. Gross Margin</div>
//                  <div className={`text-2xl font-bold ${margin >= 0 ? 'text-green-600' : 'text-red-600'}`}>{formatCurrency(margin)}</div>
//                  <div className="text-xs text-slate-400 mt-1">Revenue - Direct Costs</div>
//               </div>
//            </div>
//         </div>

//         <div className="grid gap-6 md:grid-cols-3">
//           <div className="md:col-span-2 space-y-6">
//             <div className="rounded-xl bg-white p-6 shadow-sm">
//                <div className="flex items-center justify-between mb-4"><h3 className="font-semibold text-slate-800 flex items-center gap-2"><Users size={18} /> Assigned Team</h3>{(role === 'admin' || role === 'manager') && (<button onClick={() => setIsEmpModalOpen(true)} className="text-xs font-medium text-indigo-600 hover:underline">Manage Team</button>)}</div>
//                <div className="flex flex-wrap gap-2">{(selectedProject.assigned_employees || []).length > 0 ? (selectedProject.assigned_employees || []).map(empId => { const emp = employees.find(e => e.id === empId); return (<div key={empId} className="flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1 text-sm"><div className="h-5 w-5 rounded-full bg-indigo-200 flex items-center justify-center text-[10px] font-bold text-indigo-700">{emp?.name?.charAt(0) || '?'}</div><span className="text-slate-700">{emp?.name || 'Unknown'}</span></div>); }) : (<div className="text-sm text-slate-400 italic">No employees assigned.</div>)}</div>
//             </div>
//             <div className="rounded-xl bg-white p-6 shadow-sm">
//                <h3 className="font-semibold text-slate-800 mb-4 flex items-center gap-2"><DollarSign size={18} /> Logistics & Services</h3>
//                <div className="overflow-x-auto"><table className="w-full text-sm text-left"><thead className="bg-slate-50 text-slate-500"><tr><th className="p-3">Cost Type</th><th className="p-3 w-32">Amount</th><th className="p-3 w-24">GST %</th><th className="p-3 text-right">Total</th></tr></thead><tbody className="divide-y divide-slate-100">{LOGISTICS_TYPES.map(type => { const saved = (selectedProject.logistics_costs || {})[type.id] || { amount: 0, gst: 18 }; const total = (saved.amount || 0) * (1 + (saved.gst || 0)/100); return (<tr key={type.id}><td className="p-3 flex items-center gap-2"><span className="text-slate-400">{type.icon}</span><span className="text-slate-700 font-medium">{type.label}</span></td><td className="p-3"><input type="number" min="0" className="w-full rounded border p-1" value={saved.amount} onChange={(e) => updateLogisticsCost(type.id, 'amount', e.target.value)} disabled={role === 'tech'} /></td><td className="p-3"><select className="w-full rounded border p-1" value={saved.gst} onChange={(e) => updateLogisticsCost(type.id, 'gst', e.target.value)} disabled={role === 'tech'}><option value="0">0%</option><option value="5">5%</option><option value="12">12%</option><option value="18">18%</option><option value="28">28%</option></select></td><td className="p-3 text-right font-medium text-slate-800">{formatCurrency(total)}</td></tr>); })}</tbody><tfoot className="bg-slate-50 font-bold text-slate-800 border-t"><tr><td colSpan={3} className="p-3 text-right">Logistics Total:</td><td className="p-3 text-right">{formatCurrency(totals.logistics)}</td></tr></tfoot></table></div>
//             </div>
//             <div className="rounded-xl bg-white p-6 shadow-sm">
//               <div className="flex items-center justify-between mb-4"><h3 className="font-semibold text-slate-800">Allocated Equipment</h3>{(role === 'manager' || role === 'admin') && selectedProject.status !== 'Closed' && (<button onClick={openAllocationModal} className="rounded bg-indigo-50 px-3 py-1 text-sm font-medium text-indigo-600 hover:bg-indigo-100">+ Add Item</button>)}</div>
//               <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-slate-50 text-slate-500"><tr><th className="p-2">Item</th><th className="p-2 text-center">Qty</th><th className="p-2 text-center">Days</th><th className="p-2 text-right">Rate</th><th className="p-2 text-right">Total</th><th className="p-2"></th></tr></thead><tbody className="divide-y divide-slate-100">{(selectedProject.items || []).map((item, idx) => (<tr key={idx} className="hover:bg-slate-50"><td className="p-2"><div className="font-medium text-slate-800">{item.item_name}</div>{item.is_external && <span className="text-xs text-purple-600 bg-purple-50 px-1 rounded">Ext</span>}</td><td className="p-2 text-center">{item.qty}</td><td className="p-2 text-center">{item.days}</td><td className="p-2 text-right">{formatCurrency(item.rate)}</td><td className="p-2 text-right font-medium">{formatCurrency(item.total)}</td><td className="p-2 text-right">{(role === 'manager' || role === 'admin') && (<button onClick={() => handleRemoveAllocation(item)} className="text-red-400 hover:text-red-600"><Trash2 size={14} /></button>)}</td></tr>))}</tbody><tfoot className="bg-slate-50 font-bold text-slate-800"><tr><td colSpan={4} className="p-2 text-right">Equipment Total:</td><td className="p-2 text-right">{formatCurrency(totals.equipment)}</td><td></td></tr></tfoot></table></div>
//             </div>
//           </div>
//           <div className="space-y-6">
//             <div className="rounded-xl bg-white p-6 shadow-sm border border-indigo-100"><h3 className="mb-4 font-bold text-slate-800 text-lg">Project Summary</h3><div className="space-y-3 text-sm"><div className="flex justify-between"><span className="text-slate-500">Equipment Cost</span><span className="font-medium">{formatCurrency(totals.equipment)}</span></div><div className="flex justify-between"><span className="text-slate-500">Logistics & Services</span><span className="font-medium">{formatCurrency(totals.logistics)}</span></div><div className="border-t pt-3 flex justify-between text-lg font-bold text-indigo-700"><span>Grand Total</span><span>{formatCurrency(totals.total_revenue)}</span></div></div></div>
//             <div className="rounded-xl bg-white p-6 shadow-sm"><h3 className="mb-4 font-semibold text-slate-800">Expenses</h3><div className="text-2xl font-bold text-slate-800">{formatCurrency(expenses.filter(e => e.project_id === selectedProject.id).reduce((s,e)=>s + parseFloat(e.amount), 0))}</div><div className="mt-2 text-xs text-slate-500">Total recorded expenses</div></div>
//           </div>
//         </div>
//         <Modal isOpen={isAllocationModalOpen} onClose={() => setIsAllocationModalOpen(false)} title="Allocate Equipment">
//           <div className="space-y-4">
//             <div><label className="block text-sm font-medium text-slate-700">Select Item</label><select className="w-full rounded border p-2" value={allocationForm.item_id} onChange={handleItemSelect}><option value="">-- Choose Equipment --</option>{inventory.map(item => (<option key={item.id} value={item.id}>{item.name}</option>))}</select>{allocationForm.item_id && (<div className={`mt-1 text-xs font-medium ${allocationForm.available_qty > 0 ? 'text-green-600' : 'text-red-600'}`}>Available for dates: {allocationForm.available_qty} units</div>)}</div>
//             <div className="grid grid-cols-2 gap-4"><div><label className="block text-sm font-medium text-slate-700">Quantity</label><input type="number" min="1" className={`w-full rounded border p-2 ${allocationForm.qty > allocationForm.available_qty ? 'border-red-500 bg-red-50' : ''}`} value={allocationForm.qty} onChange={e => setAllocationForm({...allocationForm, qty: e.target.value})} />{allocationForm.qty > allocationForm.available_qty && (<div className="text-xs text-red-600 mt-1 flex items-center gap-1"><AlertCircle size={10} /> Overbooking warning</div>)}</div><div><label className="block text-sm font-medium text-slate-700">Days</label><input type="number" min="1" className="w-full rounded border p-2" value={allocationForm.days} onChange={e => setAllocationForm({...allocationForm, days: e.target.value})} /></div><div><label className="block text-sm font-medium text-slate-700">Rate / Day</label><input type="number" className="w-full rounded border p-2" value={allocationForm.rate} onChange={e => setAllocationForm({...allocationForm, rate: e.target.value})} /></div><div><label className="block text-sm font-medium text-slate-700">GST %</label><input type="number" disabled className="w-full rounded border p-2 bg-slate-50" value={allocationForm.gst_rate} /></div></div>
//             <div className="rounded bg-slate-50 p-3 text-right space-y-1 text-sm"><div className="flex justify-between"><span>Subtotal:</span><span>{formatCurrency((allocationForm.qty || 0) * (allocationForm.rate || 0) * (allocationForm.days || 0))}</span></div><div className="flex justify-between font-bold text-lg text-slate-800 border-t pt-1 mt-1"><span>Total:</span><span>{formatCurrency(((allocationForm.qty || 0) * (allocationForm.rate || 0) * (allocationForm.days || 0)) * (1 + allocationForm.gst_rate/100))}</span></div></div>
//             <div className="flex justify-end pt-2"><button onClick={handleSaveAllocation} className="rounded bg-indigo-600 px-6 py-2 text-white hover:bg-indigo-700">Add & Keep Open</button></div>
//           </div>
//         </Modal>
//         <Modal isOpen={isEmpModalOpen} onClose={() => setIsEmpModalOpen(false)} title="Assign Team to Project">
//             <div className="space-y-4"><div className="space-y-2 max-h-96 overflow-y-auto">{employees.map(emp => { const isAssigned = (selectedProject.assigned_employees || []).includes(emp.id); const isBusy = !isAssigned && isEmployeeBusy(emp.id); return (<div key={emp.id} className={`flex items-center justify-between p-3 rounded border cursor-pointer ${isAssigned ? 'bg-indigo-50 border-indigo-200' : isBusy ? 'bg-orange-50 border-orange-200' : 'bg-white hover:bg-slate-50'}`} onClick={() => toggleEmployee(emp.id)}><div className="flex items-center gap-3"><div className={`h-8 w-8 rounded-full flex items-center justify-center font-bold ${isBusy ? 'bg-orange-200 text-orange-700' : 'bg-slate-200 text-slate-600'}`}>{emp.name.charAt(0)}</div><div><div className="font-medium text-slate-800 flex items-center gap-2">{emp.name}{isBusy && <span className="text-[10px] bg-orange-100 text-orange-700 px-1 rounded border border-orange-200">Busy</span>}</div><div className="text-xs text-slate-500 capitalize">{emp.role}</div></div></div><div className={`h-5 w-5 rounded border flex items-center justify-center ${isAssigned ? 'bg-indigo-600 border-indigo-600 text-white' : 'border-slate-300'}`}>{isAssigned && <CheckCircle size={14} />}</div></div>); })}</div><div className="flex justify-end pt-2"><button onClick={() => setIsEmpModalOpen(false)} className="rounded bg-slate-50 px-6 py-2 text-white hover:bg-slate-50">Done</button></div></div>
//         </Modal>
//       </div>
//     );
//   }
//   return (
//     <div className="space-y-4">
//       <div className="flex items-center justify-between"><h2 className="text-2xl font-bold text-slate-800">Projects</h2>{(role === 'manager' || role === 'admin') && (<button onClick={openCreate} className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-white hover:bg-indigo-700"><Plus size={18} /> New Quote</button>)}</div>
//       <div className="space-y-3">{projects.map(project => (<div key={project.id} onClick={() => setSelectedProjectId(project.id)} className="cursor-pointer rounded-xl border border-slate-200 bg-white p-4 transition hover:shadow-md group relative"><div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center"><div><div className="font-bold text-slate-800">{project.project_name}</div><div className="text-sm text-slate-500">{clients.find(c=>c.id === project.client_id)?.name || 'Unknown Client'}</div></div><div className="flex items-center gap-4"><div className="text-right text-sm"><div className="text-white">{project.start_date}</div><div className="text-slate-400">{project.venue}</div></div><span className={`px-2 py-1 text-xs rounded border ${STATUS_COLORS[project.status]}`}>{project.status}</span></div></div>{(role==='admin'||role==='manager') && (<div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity"><button onClick={(e)=>{e.stopPropagation();openEdit(project)}} className="p-1 text-blue-600 bg-blue-50 rounded hover:bg-blue-100"><Edit size={14}/></button><button onClick={(e)=>{e.stopPropagation();handleDelete(project.id)}} className="p-1 text-red-600 bg-red-50 rounded hover:bg-red-100"><Trash2 size={14}/></button></div>)}</div>))}</div>
//       <Modal isOpen={isCreateOpen} onClose={() => setIsCreateOpen(false)} title={editingId ? "Edit Project" : "Create New Quote"}>
//         <div className="space-y-3">
//           <div><label className="text-sm font-medium">Project Name</label><input className="w-full rounded border p-2" value={newProj.project_name} onChange={e => setNewProj({...newProj, project_name: e.target.value})} /></div>
//           <div><label className="text-sm font-medium">Client</label><select className="w-full rounded border p-2" value={newProj.client_id} onChange={e => setNewProj({...newProj, client_id: e.target.value})}><option value="">Select Client</option>{clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
//           <div className="grid grid-cols-2 gap-2"><div><label className="text-sm font-medium">Start Date</label><input type="date" className="w-full rounded border p-2" value={newProj.start_date} onChange={e => setNewProj({...newProj, start_date: e.target.value})} /></div><div><label className="text-sm font-medium">End Date</label><input type="date" className="w-full rounded border p-2" value={newProj.end_date} onChange={e => setNewProj({...newProj, end_date: e.target.value})} /></div></div>
//           <div><label className="text-sm font-medium">Venue</label><input className="w-full rounded border p-2" value={newProj.venue} onChange={e => setNewProj({...newProj, venue: e.target.value})} /></div>
//           <button onClick={handleSaveProject} className="w-full rounded bg-indigo-600 py-2 text-white mt-4">{editingId ? 'Update Project' : 'Create Quote'}</button>
//         </div>
//       </Modal>
//     </div>
//   );
// };

// version 1.2.0 Project Invoice Status Update
// const Projects = ({ projects, clients, inventory, expenses, employees, role, user, db, appId }) => {
//   const [selectedProjectId, setSelectedProjectId] = useState(null);
//   const [isCreateOpen, setIsCreateOpen] = useState(false);
//   const [editingId, setEditingId] = useState(null);
  
//   // --- Filter State ---
//   const [filters, setFilters] = useState({
//     startDate: '',
//     endDate: '',
//     clientId: '',
//     status: '',
//     setupDate: ''
//   });

//   const [isAllocationModalOpen, setIsAllocationModalOpen] = useState(false);
//   const [allocationForm, setAllocationForm] = useState({ item_id: '', qty: 1, rate: 0, days: 1, gst_rate: 18, available_qty: 0 });
//   const [isEmpModalOpen, setIsEmpModalOpen] = useState(false);
  
//   // Added setup_date to state
//   const [newProj, setNewProj] = useState({ 
//     project_name: '', client_id: '', start_date: '', end_date: '', setup_date: '', 
//     venue: '', status: 'Quoted', items: [], assigned_employees: [], logistics_costs: {} 
//   });

//   const selectedProject = useMemo(() => projects.find(p => p.id === selectedProjectId), [projects, selectedProjectId]);

//   // --- Filtering Logic ---
//   const filteredProjects = useMemo(() => {
//     return projects.filter(p => {
//       const pStart = new Date(p.start_date);
//       const pEnd = new Date(p.end_date);
//       const pSetup = p.setup_date ? new Date(p.setup_date) : null;
      
//       const fStart = filters.startDate ? new Date(filters.startDate) : null;
//       const fEnd = filters.endDate ? new Date(filters.endDate) : null;
//       const fSetup = filters.setupDate ? new Date(filters.setupDate) : null;

//       // Filter Logic: 
//       // 1. If Filter Start exists, Project Start must be >= Filter Start
//       // 2. If Filter End exists, Project End must be <= Filter End
//       const matchesStart = fStart ? pStart >= fStart : true;
//       const matchesEnd = fEnd ? pEnd <= fEnd : true;
      
//       // 3. Setup Date: Exact match or on/after
//       const matchesSetup = fSetup && pSetup ? pSetup >= fSetup : true;

//       const matchesClient = filters.clientId ? p.client_id === filters.clientId : true;
//       const matchesStatus = filters.status ? p.status === filters.status : true;

//       return matchesStart && matchesEnd && matchesSetup && matchesClient && matchesStatus;
//     });
//   }, [projects, filters]);

//   const getAvailableQty = (itemId) => {
//     const item = inventory.find(i => i.id === itemId);
//     if (!item) return 0;
//     if (!selectedProject?.start_date || !selectedProject?.end_date) return item.total;
//     const overlappingProjs = projects.filter(p => p.id !== selectedProject.id && ['Confirmed', 'Ongoing'].includes(p.status) && isDateOverlap(selectedProject.start_date, selectedProject.end_date, p.start_date, p.end_date));
//     const usedQty = overlappingProjs.reduce((acc, p) => {
//       const alloc = (p.items || []).find(i => i.item_id === itemId);
//       return acc + (alloc ? (parseInt(alloc.qty) || 0) : 0);
//     }, 0);
//     return Math.max(0, item.total - usedQty);
//   };

//   const isEmployeeBusy = (empId) => {
//     if (!selectedProject?.start_date || !selectedProject?.end_date) return false;
//     const overlappingProjs = projects.filter(p => p.id !== selectedProject.id && ['Confirmed', 'Ongoing'].includes(p.status) && isDateOverlap(selectedProject.start_date, selectedProject.end_date, p.start_date, p.end_date));
//     return overlappingProjs.some(p => (p.assigned_employees || []).includes(empId));
//   };

//   const openCreate = () => {
//     setEditingId(null);
//     setNewProj({ project_name: '', client_id: '', start_date: '', end_date: '', setup_date: '', venue: '', status: 'Quoted', items: [], assigned_employees: [], logistics_costs: {} });
//     setIsCreateOpen(true);
//   };

//   const openEdit = (proj) => {
//     setEditingId(proj.id);
//     setNewProj({ 
//       project_name: proj.project_name, client_id: proj.client_id, 
//       start_date: proj.start_date, end_date: proj.end_date, setup_date: proj.setup_date || '',
//       venue: proj.venue, status: proj.status, 
//       items: proj.items || [], assigned_employees: proj.assigned_employees || [], logistics_costs: proj.logistics_costs || {} 
//     });
//     setIsCreateOpen(true);
//   };

//   const handleDelete = async (id) => {
//     if(!confirm("Are you sure? This will delete the project and all associated data.")) return;
//     await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', id));
//   };

//   const handleSaveProject = async () => {
//     if(!newProj.client_id || !newProj.project_name) return alert("Missing fields");
//     const data = { ...newProj, updated_at: serverTimestamp() };
//     if (editingId) {
//       await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', editingId), data);
//     } else {
//       await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'projects'), { ...data, created_by: user.uid, created_at: serverTimestamp() });
//     }
//     setIsCreateOpen(false); 
//   };

//   const updateStatus = async (pid, newStatus) => {
//     if (newStatus === 'Closed' && role !== 'admin') return alert("Only Admin can close projects.");
//     await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', pid), { status: newStatus });
//   };

//   const toggleEmployee = async (empId) => {
//     const currentAssigned = selectedProject.assigned_employees || [];
//     const newAssigned = currentAssigned.includes(empId) ? currentAssigned.filter(id => id !== empId) : [...currentAssigned, empId];
//     await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), { assigned_employees: newAssigned });
//   };

//   const updateLogisticsCost = async (type, field, value) => {
//     const currentCosts = selectedProject.logistics_costs || {};
//     const newCosts = { ...currentCosts, [type]: { ...(currentCosts[type] || { amount: 0, gst: 0 }), [field]: parseFloat(value) || 0 } };
//     await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), { logistics_costs: newCosts });
//   };

//   const openAllocationModal = () => {
//     const days = selectedProject?.start_date && selectedProject?.end_date ? getDaysDifference(selectedProject.start_date, selectedProject.end_date) : 1;
//     setAllocationForm({ item_id: '', qty: 1, rate: 0, days: days, gst_rate: 18, available_qty: 0 });
//     setIsAllocationModalOpen(true);
//   };

//   const handleItemSelect = (e) => {
//     const itemId = e.target.value;
//     if (!itemId) return setAllocationForm(p => ({...p, item_id: '', available_qty: 0}));
//     const item = inventory.find(i => i.id === itemId);
//     if (item) setAllocationForm(p => ({ ...p, item_id: itemId, rate: item.rate_per_day || 0, gst_rate: item.gst_rate || 18, available_qty: getAvailableQty(itemId) }));
//   };

//   const handleSaveAllocation = async () => {
//     if(!allocationForm.item_id) return alert("Select an item");
//     const item = inventory.find(i => i.id === allocationForm.item_id);
//     if (allocationForm.qty > allocationForm.available_qty) {
//       if(!confirm(`Warning: You are allocating ${allocationForm.qty} but only ${allocationForm.available_qty} are available. Proceed?`)) return;
//     }
//     const amount = allocationForm.qty * allocationForm.rate * allocationForm.days;
//     const newItem = { id: Date.now().toString(), item_id: item.id, item_name: item.name, category: item.category, is_external: item.is_external || false, qty: parseInt(allocationForm.qty), rate: parseFloat(allocationForm.rate), days: parseInt(allocationForm.days), gst_rate: parseFloat(allocationForm.gst_rate), amount, gst_amount: amount * (allocationForm.gst_rate/100), total: amount * (1 + allocationForm.gst_rate/100) };
//     await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), { items: arrayUnion(newItem) });
//     setAllocationForm(p => ({...p, item_id: '', qty: 1, available_qty: 0})); 
//   };

//   const handleRemoveAllocation = async (item) => {
//     if(confirm("Remove this item?")) await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), { items: arrayRemove(item) });
//   };

//   const calculateProjectTotals = () => {
//     if (!selectedProject) return { equipment: 0, logistics: 0, total: 0, gst_output: 0, gst_input: 0, outsourcing: 0, direct_expense: 0 };
    
//     // Revenue
//     const equipmentBase = (selectedProject.items || []).reduce((acc, i) => acc + (i.amount || 0), 0);
//     const equipmentGST = (selectedProject.items || []).reduce((acc, i) => acc + (i.gst_amount || 0), 0);
    
//     let logisticsBase = 0;
//     let logisticsGST = 0;
//     if (selectedProject.logistics_costs) {
//       Object.values(selectedProject.logistics_costs).forEach(c => {
//          const base = c.amount || 0;
//          logisticsBase += base;
//          logisticsGST += base * ((c.gst || 0)/100);
//       });
//     }

//     // Costs
//     const outsourcingBase = (selectedProject.vendor_allocations || []).reduce((acc, v) => acc + (v.amount || 0), 0);
//     const outsourcingGST = (selectedProject.vendor_allocations || []).reduce((acc, v) => acc + (v.amount * (v.gst/100) || 0), 0);
    
//     const directExpenses = expenses
//       .filter(e => e.project_id === selectedProject.id && e.status !== 'Rejected')
//       .reduce((acc, e) => acc + parseFloat(e.amount || 0), 0);

//     const gstOutput = equipmentGST + logisticsGST;
//     const gstInput = outsourcingGST;

    
//       return { 
//       equipment: equipmentBase, 
//       logistics: logisticsBase, 
//       outsourcing: outsourcingBase,
//       direct_expense: directExpenses,
//       gst_output: gstOutput,
//       gst_input: gstInput,
//       gst_payable: gstOutput - gstInput,
//       total_revenue: equipmentBase + logisticsBase + gstOutput,
//       total_cost: outsourcingBase + directExpenses + gstInput 
//     };
//   };

//   if (selectedProject) {
//     const totals = calculateProjectTotals();
//     const margin = (totals.equipment + totals.logistics) - (totals.outsourcing + totals.direct_expense);

//     return (
//       <div className="space-y-6">
//         <button onClick={() => setSelectedProjectId(null)} className="flex items-center text-slate-500 hover:text-indigo-600"><ArrowLeft size={16} className="mr-1" /> Back to Projects</button>
//         <div className="flex flex-col justify-between gap-4 rounded-xl bg-white p-6 shadow-sm md:flex-row md:items-center">
//           <div><h1 className="text-2xl font-bold text-slate-800">{selectedProject.project_name}</h1><div className="flex items-center gap-2 text-slate-500"><span>{clients.find(c=>c.id === selectedProject.client_id)?.name}</span><span>•</span><span>{selectedProject.start_date} to {selectedProject.end_date}</span>{selectedProject.setup_date && <span className="text-indigo-600 font-medium"> (Setup: {selectedProject.setup_date})</span>}</div></div>
//           <div className="flex items-center gap-3"><span className={`px-3 py-1 rounded-full text-sm font-bold border ${STATUS_COLORS[selectedProject.status]}`}>{selectedProject.status}</span>{(role === 'admin' || role === 'manager') && (<select className="rounded border p-1 text-sm bg-slate-50" value={selectedProject.status} onChange={(e) => updateStatus(selectedProject.id, e.target.value)}><option value="Quoted">Quoted</option><option value="Confirmed">Confirmed</option><option value="Ongoing">Ongoing</option><option value="Completed">Completed</option><option value="Closed">Closed</option><option value="Cancelled">Cancelled</option></select>)}</div>
//         </div>

//         {/* Profit & Loss Summary */}
//         <div className="rounded-xl bg-white p-6 shadow-sm border border-indigo-100">
//            <h3 className="mb-4 font-bold text-slate-800 text-lg flex items-center gap-2"><Calculator size={20} className="text-indigo-600"/> Profit & Loss Summary</h3>
//            <div className="grid grid-cols-2 md:grid-cols-4 gap-6 text-sm">
//               <div className="space-y-2">
//                  <div className="font-semibold text-slate-500 border-b pb-1">REVENUE (Excl. GST)</div>
//                  <div className="flex justify-between"><span>Equipment</span><span className="font-medium">{formatCurrency(totals.equipment)}</span></div>
//                  <div className="flex justify-between"><span>Logistics</span><span className="font-medium">{formatCurrency(totals.logistics)}</span></div>
//                  <div className="flex justify-between text-indigo-700 font-bold border-t pt-1"><span>Total</span><span>{formatCurrency(totals.equipment + totals.logistics)}</span></div>
//               </div>
//               <div className="space-y-2">
//                  <div className="font-semibold text-slate-500 border-b pb-1">DIRECT COSTS</div>
//                  <div className="flex justify-between"><span>Outsourcing</span><span className="font-medium text-red-600">-{formatCurrency(totals.outsourcing)}</span></div>
//                  <div className="flex justify-between"><span>Expenses</span><span className="font-medium text-red-600">-{formatCurrency(totals.direct_expense)}</span></div>
//                  <div className="flex justify-between text-red-700 font-bold border-t pt-1"><span>Total</span><span>-{formatCurrency(totals.outsourcing + totals.direct_expense)}</span></div>
//               </div>
//               <div className="space-y-2">
//                  <div className="font-semibold text-slate-500 border-b pb-1">GST ANALYSIS</div>
//                  <div className="flex justify-between"><span>Output (Coll)</span><span className="font-medium text-green-600">{formatCurrency(totals.gst_output)}</span></div>
//                  <div className="flex justify-between"><span>Input (Paid)</span><span className="font-medium text-red-600">{formatCurrency(totals.gst_input)}</span></div>
//                  <div className="flex justify-between font-bold border-t pt-1"><span>Payable</span><span>{formatCurrency(totals.gst_payable)}</span></div>
//               </div>
//               <div className="bg-slate-50 p-3 rounded flex flex-col justify-center text-center">
//                  <div className="text-xs font-semibold text-slate-500 uppercase">Est. Gross Margin</div>
//                  <div className={`text-2xl font-bold ${margin >= 0 ? 'text-green-600' : 'text-red-600'}`}>{formatCurrency(margin)}</div>
//                  <div className="text-xs text-slate-400 mt-1">Revenue - Direct Costs</div>
//               </div>
//            </div>
//         </div>

//         <div className="grid gap-6 md:grid-cols-3">
//           <div className="md:col-span-2 space-y-6">
//             <div className="rounded-xl bg-white p-6 shadow-sm">
//                <div className="flex items-center justify-between mb-4"><h3 className="font-semibold text-slate-800 flex items-center gap-2"><Users size={18} /> Assigned Team</h3>{(role === 'admin' || role === 'manager') && (<button onClick={() => setIsEmpModalOpen(true)} className="text-xs font-medium text-indigo-600 hover:underline">Manage Team</button>)}</div>
//                <div className="flex flex-wrap gap-2">{(selectedProject.assigned_employees || []).length > 0 ? (selectedProject.assigned_employees || []).map(empId => { const emp = employees.find(e => e.id === empId); return (<div key={empId} className="flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1 text-sm"><div className="h-5 w-5 rounded-full bg-indigo-200 flex items-center justify-center text-[10px] font-bold text-indigo-700">{emp?.name?.charAt(0) || '?'}</div><span className="text-slate-700">{emp?.name || 'Unknown'}</span></div>); }) : (<div className="text-sm text-slate-400 italic">No employees assigned.</div>)}</div>
//             </div>
//             <div className="rounded-xl bg-white p-6 shadow-sm">
//                <h3 className="font-semibold text-slate-800 mb-4 flex items-center gap-2"><DollarSign size={18} /> Logistics & Services</h3>
//                <div className="overflow-x-auto"><table className="w-full text-sm text-left"><thead className="bg-slate-50 text-slate-500"><tr><th className="p-3">Cost Type</th><th className="p-3 w-32">Amount</th><th className="p-3 w-24">GST %</th><th className="p-3 text-right">Total</th></tr></thead><tbody className="divide-y divide-slate-100">{LOGISTICS_TYPES.map(type => { const saved = (selectedProject.logistics_costs || {})[type.id] || { amount: 0, gst: 18 }; const total = (saved.amount || 0) * (1 + (saved.gst || 0)/100); return (<tr key={type.id}><td className="p-3 flex items-center gap-2"><span className="text-slate-400">{type.icon}</span><span className="text-slate-700 font-medium">{type.label}</span></td><td className="p-3"><input type="number" min="0" className="w-full rounded border p-1" value={saved.amount} onChange={(e) => updateLogisticsCost(type.id, 'amount', e.target.value)} disabled={role === 'tech'} /></td><td className="p-3"><select className="w-full rounded border p-1" value={saved.gst} onChange={(e) => updateLogisticsCost(type.id, 'gst', e.target.value)} disabled={role === 'tech'}><option value="0">0%</option><option value="5">5%</option><option value="12">12%</option><option value="18">18%</option><option value="28">28%</option></select></td><td className="p-3 text-right font-medium text-slate-800">{formatCurrency(total)}</td></tr>); })}</tbody><tfoot className="bg-slate-50 font-bold text-slate-800 border-t"><tr><td colSpan={3} className="p-3 text-right">Logistics Total:</td><td className="p-3 text-right">{formatCurrency(totals.logistics)}</td></tr></tfoot></table></div>
//             </div>
//             <div className="rounded-xl bg-white p-6 shadow-sm">
//               <div className="flex items-center justify-between mb-4"><h3 className="font-semibold text-slate-800">Allocated Equipment</h3>{(role === 'manager' || role === 'admin') && selectedProject.status !== 'Closed' && (<button onClick={openAllocationModal} className="rounded bg-indigo-50 px-3 py-1 text-sm font-medium text-indigo-600 hover:bg-indigo-100">+ Add Item</button>)}</div>
//               <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-slate-50 text-slate-500"><tr><th className="p-2">Item</th><th className="p-2 text-center">Qty</th><th className="p-2 text-center">Days</th><th className="p-2 text-right">Rate</th><th className="p-2 text-right">Total</th><th className="p-2"></th></tr></thead><tbody className="divide-y divide-slate-100">{(selectedProject.items || []).map((item, idx) => (<tr key={idx} className="hover:bg-slate-50"><td className="p-2"><div className="font-medium text-slate-800">{item.item_name}</div>{item.is_external && <span className="text-xs text-purple-600 bg-purple-50 px-1 rounded">Ext</span>}</td><td className="p-2 text-center">{item.qty}</td><td className="p-2 text-center">{item.days}</td><td className="p-2 text-right">{formatCurrency(item.rate)}</td><td className="p-2 text-right font-medium">{formatCurrency(item.total)}</td><td className="p-2 text-right">{(role === 'manager' || role === 'admin') && (<button onClick={() => handleRemoveAllocation(item)} className="text-red-400 hover:text-red-600"><Trash2 size={14} /></button>)}</td></tr>))}</tbody><tfoot className="bg-slate-50 font-bold text-slate-800"><tr><td colSpan={4} className="p-2 text-right">Equipment Total:</td><td className="p-2 text-right">{formatCurrency(totals.equipment)}</td><td></td></tr></tfoot></table></div>
//             </div>
//           </div>
//           <div className="space-y-6">
//             <div className="rounded-xl bg-white p-6 shadow-sm border border-indigo-100"><h3 className="mb-4 font-bold text-slate-800 text-lg">Project Summary</h3><div className="space-y-3 text-sm"><div className="flex justify-between"><span className="text-slate-500">Equipment Cost</span><span className="font-medium">{formatCurrency(totals.equipment)}</span></div><div className="flex justify-between"><span className="text-slate-500">Logistics & Services</span><span className="font-medium">{formatCurrency(totals.logistics)}</span></div><div className="border-t pt-3 flex justify-between text-lg font-bold text-indigo-700"><span>Grand Total</span><span>{formatCurrency(totals.total_revenue)}</span></div></div></div>
//             <div className="rounded-xl bg-white p-6 shadow-sm"><h3 className="mb-4 font-semibold text-slate-800">Expenses</h3><div className="text-2xl font-bold text-slate-800">{formatCurrency(expenses.filter(e => e.project_id === selectedProject.id).reduce((s,e)=>s + parseFloat(e.amount), 0))}</div><div className="mt-2 text-xs text-slate-500">Total recorded expenses</div></div>
//           </div>
//         </div>
//         <Modal isOpen={isAllocationModalOpen} onClose={() => setIsAllocationModalOpen(false)} title="Allocate Equipment">
//           <div className="space-y-4">
//             <div><label className="block text-sm font-medium text-slate-700">Select Item</label><select className="w-full rounded border p-2" value={allocationForm.item_id} onChange={handleItemSelect}><option value="">-- Choose Equipment --</option>{inventory.map(item => (<option key={item.id} value={item.id}>{item.name}</option>))}</select>{allocationForm.item_id && (<div className={`mt-1 text-xs font-medium ${allocationForm.available_qty > 0 ? 'text-green-600' : 'text-red-600'}`}>Available for dates: {allocationForm.available_qty} units</div>)}</div>
//             <div className="grid grid-cols-2 gap-4"><div><label className="block text-sm font-medium text-slate-700">Quantity</label><input type="number" min="1" className={`w-full rounded border p-2 ${allocationForm.qty > allocationForm.available_qty ? 'border-red-500 bg-red-50' : ''}`} value={allocationForm.qty} onChange={e => setAllocationForm({...allocationForm, qty: e.target.value})} />{allocationForm.qty > allocationForm.available_qty && (<div className="text-xs text-red-600 mt-1 flex items-center gap-1"><AlertCircle size={10} /> Overbooking warning</div>)}</div><div><label className="block text-sm font-medium text-slate-700">Days</label><input type="number" min="1" className="w-full rounded border p-2" value={allocationForm.days} onChange={e => setAllocationForm({...allocationForm, days: e.target.value})} /></div><div><label className="block text-sm font-medium text-slate-700">Rate / Day</label><input type="number" className="w-full rounded border p-2" value={allocationForm.rate} onChange={e => setAllocationForm({...allocationForm, rate: e.target.value})} /></div><div><label className="block text-sm font-medium text-slate-700">GST %</label><input type="number" disabled className="w-full rounded border p-2 bg-slate-50" value={allocationForm.gst_rate} /></div></div>
//             <div className="rounded bg-slate-50 p-3 text-right space-y-1 text-sm"><div className="flex justify-between"><span>Subtotal:</span><span>{formatCurrency((allocationForm.qty || 0) * (allocationForm.rate || 0) * (allocationForm.days || 0))}</span></div><div className="flex justify-between font-bold text-lg text-slate-800 border-t pt-1 mt-1"><span>Total:</span><span>{formatCurrency(((allocationForm.qty || 0) * (allocationForm.rate || 0) * (allocationForm.days || 0)) * (1 + allocationForm.gst_rate/100))}</span></div></div>
//             <div className="flex justify-end pt-2"><button onClick={handleSaveAllocation} className="rounded bg-indigo-600 px-6 py-2 text-white hover:bg-indigo-700">Add & Keep Open</button></div>
//           </div>
//         </Modal>
//         <Modal isOpen={isEmpModalOpen} onClose={() => setIsEmpModalOpen(false)} title="Assign Team to Project">
//             <div className="space-y-4"><div className="space-y-2 max-h-96 overflow-y-auto">{employees.map(emp => { const isAssigned = (selectedProject.assigned_employees || []).includes(emp.id); const isBusy = !isAssigned && isEmployeeBusy(emp.id); return (<div key={emp.id} className={`flex items-center justify-between p-3 rounded border cursor-pointer ${isAssigned ? 'bg-indigo-50 border-indigo-200' : isBusy ? 'bg-orange-50 border-orange-200' : 'bg-white hover:bg-slate-50'}`} onClick={() => toggleEmployee(emp.id)}><div className="flex items-center gap-3"><div className={`h-8 w-8 rounded-full flex items-center justify-center font-bold ${isBusy ? 'bg-orange-200 text-orange-700' : 'bg-slate-200 text-slate-600'}`}>{emp.name.charAt(0)}</div><div><div className="font-medium text-slate-800 flex items-center gap-2">{emp.name}{isBusy && <span className="text-[10px] bg-orange-100 text-orange-700 px-1 rounded border border-orange-200">Busy</span>}</div><div className="text-xs text-slate-500 capitalize">{emp.role}</div></div></div><div className={`h-5 w-5 rounded border flex items-center justify-center ${isAssigned ? 'bg-indigo-600 border-indigo-600 text-white' : 'border-slate-300'}`}>{isAssigned && <CheckCircle size={14} />}</div></div>); })}</div><div className="flex justify-end pt-2"><button onClick={() => setIsEmpModalOpen(false)} className="rounded bg-slate-50 px-6 py-2 text-white hover:bg-slate-50">Done</button></div></div>
//         </Modal>
//       </div>
//     );
//   }

//   return (
//     <div className="space-y-4">
//       <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
//           <h2 className="text-2xl font-bold text-slate-800">Projects</h2>
//           {(role === 'manager' || role === 'admin') && (
//             <button onClick={openCreate} className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-white hover:bg-indigo-700">
//                 <Plus size={18} /> New Quote
//             </button>
//           )}
//       </div>

//       {/* --- Filter Bar --- */}
//       <div className="grid grid-cols-2 md:grid-cols-5 gap-2 bg-white p-3 rounded-lg border border-slate-200 shadow-sm">
//          <div>
//             <label className="text-[10px] font-bold text-slate-400 uppercase">From Date</label>
//             <input type="date" className="w-full text-xs rounded border p-1" value={filters.startDate} onChange={e => setFilters({...filters, startDate: e.target.value})} />
//          </div>
//          <div>
//             <label className="text-[10px] font-bold text-slate-400 uppercase">To Date</label>
//             <input type="date" className="w-full text-xs rounded border p-1" value={filters.endDate} onChange={e => setFilters({...filters, endDate: e.target.value})} />
//          </div>
//          <div>
//             <label className="text-[10px] font-bold text-slate-400 uppercase">Setup Date {'>='}</label>
//             <input type="date" className="w-full text-xs rounded border p-1" value={filters.setupDate} onChange={e => setFilters({...filters, setupDate: e.target.value})} />
//          </div>
//          <div>
//             <label className="text-[10px] font-bold text-slate-400 uppercase">Client</label>
//             <select className="w-full text-xs rounded border p-1" value={filters.clientId} onChange={e => setFilters({...filters, clientId: e.target.value})}>
//                 <option value="">All Clients</option>
//                 {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
//             </select>
//          </div>
//          <div>
//             <label className="text-[10px] font-bold text-slate-400 uppercase">Status</label>
//             <select className="w-full text-xs rounded border p-1" value={filters.status} onChange={e => setFilters({...filters, status: e.target.value})}>
//                 <option value="">All Status</option>
//                 <option value="Quoted">Quoted</option>
//                 <option value="Confirmed">Confirmed</option>
//                 <option value="Ongoing">Ongoing</option>
//                 <option value="Completed">Completed</option>
//                 <option value="Closed">Closed</option>
//             </select>
//          </div>
//       </div>

//       <div className="space-y-3">
//         {filteredProjects.length === 0 ? <div className="text-center text-slate-400 py-10">No projects match your filters.</div> : 
//         filteredProjects.map(project => (
//           <div key={project.id} onClick={() => setSelectedProjectId(project.id)} className="cursor-pointer rounded-xl border border-slate-200 bg-white p-4 transition hover:shadow-md group relative">
//             <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
//               <div>
//                 <div className="font-bold text-slate-800">{project.project_name}</div>
//                 <div className="text-sm text-slate-500">{clients.find(c=>c.id === project.client_id)?.name || 'Unknown Client'}</div>
//                 {project.setup_date && <div className="text-xs text-indigo-600 mt-1">Setup: {project.setup_date}</div>}
//               </div>
//               <div className="flex items-center gap-4">
//                 <div className="text-right text-sm">
//                   <div className="text-white">{project.start_date}</div>
//                   <div className="text-slate-400">{project.venue}</div>
//                 </div>
//                 <span className={`px-2 py-1 text-xs rounded border ${STATUS_COLORS[project.status]}`}>{project.status}</span>
//               </div>
//             </div>
//             {(role==='admin'||role==='manager') && (
//               <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
//                 <button onClick={(e)=>{e.stopPropagation();openEdit(project)}} className="p-1 text-blue-600 bg-blue-50 rounded hover:bg-blue-100"><Edit size={14}/></button>
//                 <button onClick={(e)=>{e.stopPropagation();handleDelete(project.id)}} className="p-1 text-red-600 bg-red-50 rounded hover:bg-red-100"><Trash2 size={14}/></button>
//               </div>
//             )}
//           </div>
//         ))}
//       </div>

//       <Modal isOpen={isCreateOpen} onClose={() => setIsCreateOpen(false)} title={editingId ? "Edit Project" : "Create New Quote"}>
//         <div className="space-y-3">
//           <div><label className="text-sm font-medium">Project Name</label><input className="w-full rounded border p-2" value={newProj.project_name} onChange={e => setNewProj({...newProj, project_name: e.target.value})} /></div>
//           <div><label className="text-sm font-medium">Client</label><select className="w-full rounded border p-2" value={newProj.client_id} onChange={e => setNewProj({...newProj, client_id: e.target.value})}><option value="">Select Client</option>{clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
//           <div className="grid grid-cols-3 gap-2">
//               <div><label className="text-sm font-medium">Setup Date</label><input type="date" className="w-full rounded border p-2" value={newProj.setup_date} onChange={e => setNewProj({...newProj, setup_date: e.target.value})} /></div>
//               <div><label className="text-sm font-medium">Start Date</label><input type="date" className="w-full rounded border p-2" value={newProj.start_date} onChange={e => setNewProj({...newProj, start_date: e.target.value})} /></div>
//               <div><label className="text-sm font-medium">End Date</label><input type="date" className="w-full rounded border p-2" value={newProj.end_date} onChange={e => setNewProj({...newProj, end_date: e.target.value})} /></div>
//           </div>
//           <div><label className="text-sm font-medium">Venue</label><input className="w-full rounded border p-2" value={newProj.venue} onChange={e => setNewProj({...newProj, venue: e.target.value})} /></div>
//           <button onClick={handleSaveProject} className="w-full rounded bg-indigo-600 py-2 text-white mt-4">{editingId ? 'Update Project' : 'Create Quote'}</button>
//         </div>
//       </Modal>
//     </div>
//   );
// };
const Projects = ({ projects, clients, inventory, expenses, employees, role, user, db, appId, selectedProjectId, setSelectedProjectId, logAction }) => {
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [isEditItemModalOpen, setIsEditItemModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  
  // Challan State
  const [isChallanModalOpen, setIsChallanModalOpen] = useState(false);
  const [challanType, setChallanType] = useState('delivery'); // 'delivery' or 'return'
  const [challanForm, setChallanForm] = useState({ mode: 'Road', vehicle_no: '', driver_name: '', driver_mobile: '', eway_bill: '', dispatch_address: '', date: '' });
  const [challanSelection, setChallanSelection] = useState({});
  const [isChallanHistoryOpen, setIsChallanHistoryOpen] = useState(false);
  const [editingChallan, setEditingChallan] = useState(null);
  
  // --- Filter State ---
  const [filters, setFilters] = useState({
    startDate: '', endDate: '', clientId: '', status: '', setupDate: '', invoiceStatus: ''
  });
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;

  const [isAllocationModalOpen, setIsAllocationModalOpen] = useState(false);
  const [allocationForm, setAllocationForm] = useState({ item_id: '', qty: 1, rate: 0, days: 1, gst_rate: 18, available_qty: 0, description: '' });
  const [isEmpModalOpen, setIsEmpModalOpen] = useState(false);
  
  // Initialize State (Added invoice fields)
  const [newProj, setNewProj] = useState({ 
    project_name: '', client_id: '', start_date: '', end_date: '', setup_date: '', 
    venue: '', status: 'Quoted', invoice_status: 'Not Invoiced', invoice_no: '', invoice_date: '',
    items: [], assigned_employees: [], logistics_costs: {} 
  });

  const selectedProject = useMemo(() => projects.find(p => p.id === selectedProjectId), [projects, selectedProjectId]);

  // --- Filtering Logic (Updated with Invoice Status) ---
  const filteredProjects = useMemo(() => {
    return projects.filter(p => {
      const pStart = new Date(p.start_date);
      const pEnd = new Date(p.end_date);
      const pSetup = p.setup_date ? new Date(p.setup_date) : null;
      
      const fStart = filters.startDate ? new Date(filters.startDate) : null;
      const fEnd = filters.endDate ? new Date(filters.endDate) : null;
      const fSetup = filters.setupDate ? new Date(filters.setupDate) : null;

      const matchesStart = fStart ? pStart >= fStart : true;
      const matchesEnd = fEnd ? pEnd <= fEnd : true;
      const matchesSetup = fSetup && pSetup ? pSetup >= fSetup : true;
      const matchesClient = filters.clientId ? p.client_id === filters.clientId : true;
      const matchesStatus = filters.status ? p.status === filters.status : true;
      // Invoice Filter
      const matchesInvoice = filters.invoiceStatus ? (p.invoice_status || 'Not Invoiced') === filters.invoiceStatus : true;

      return matchesStart && matchesEnd && matchesSetup && matchesClient && matchesStatus && matchesInvoice;
    });
  }, [projects, filters]);

  useEffect(() => {
    setCurrentPage(1);
  }, [filters]);

  const paginatedProjects = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return filteredProjects.slice(start, start + itemsPerPage);
  }, [filteredProjects, currentPage]);

  // ... (Keep existing helpers: getAvailableQty, isEmployeeBusy) ...
  const getAvailableQty = (itemId) => {
    const item = inventory.find(i => i.id === itemId);
    if (!item) return 0;
    if (!selectedProject?.start_date || !selectedProject?.end_date) return item.total;
    const overlappingProjs = projects.filter(p => p.id !== selectedProject.id && ['Confirmed', 'Ongoing'].includes(p.status) && isDateOverlap(selectedProject.start_date, selectedProject.end_date, p.start_date, p.end_date));
    const usedQty = overlappingProjs.reduce((acc, p) => {
      const alloc = (p.items || []).find(i => i.item_id === itemId);
      return acc + (alloc ? (parseInt(alloc.qty) || 0) : 0);
    }, 0);
    return Math.max(0, item.total - usedQty);
  };

  const isEmployeeBusy = (empId) => {
    if (!selectedProject?.start_date || !selectedProject?.end_date) return false;
    const overlappingProjs = projects.filter(p => p.id !== selectedProject.id && ['Confirmed', 'Ongoing'].includes(p.status) && isDateOverlap(selectedProject.start_date, selectedProject.end_date, p.start_date, p.end_date));
    return overlappingProjs.some(p => (p.assigned_employees || []).includes(empId));
  };

  // --- CRUD Handlers ---

  const openCreate = () => {
    setEditingId(null);
    setNewProj({ 
      project_name: '', client_id: '', start_date: '', end_date: '', setup_date: '', 
      venue: '', status: 'Quoted', invoice_status: 'Not Invoiced', invoice_no: '', invoice_date: '', 
      items: [], assigned_employees: [], logistics_costs: {} 
    });
    setIsCreateOpen(true);
  };

  const openEdit = (proj) => {
    setEditingId(proj.id);
    setNewProj({ 
      project_name: proj.project_name, client_id: proj.client_id, 
      start_date: proj.start_date, end_date: proj.end_date, setup_date: proj.setup_date || '',
      venue: proj.venue, status: proj.status, 
      invoice_status: proj.invoice_status || 'Not Invoiced', // Load existing
      invoice_no: proj.invoice_no || '', 
      invoice_date: proj.invoice_date || '',
      items: proj.items || [], assigned_employees: proj.assigned_employees || [], logistics_costs: proj.logistics_costs || {} 
    });
    setIsCreateOpen(true);
  };

  const handleDelete = async (id) => {
    if(!confirm("Are you sure? This will delete the project and all associated data.")) return;
    const projName = projects.find(p => p.id === id)?.project_name;
    await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', id));
    logAction('projects', 'delete', id, {}, projName);
  };

  const handleSaveProject = async () => {
    if(!newProj.client_id || !newProj.project_name) return addToast("Missing Client or Project Name", 'error');
    
    // Ensure default invoice status
    const data = { 
        ...newProj, 
        invoice_status: newProj.invoice_status || 'Not Invoiced',
        updated_at: serverTimestamp() 
    };

    if (editingId) {
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', editingId), data);
      logAction('projects', 'update', editingId, data, newProj.project_name);
      addToast("Project updated successfully", 'success');
    } else {
      const docRef = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'projects'), { ...data, created_by: user.uid, created_at: serverTimestamp() });
      logAction('projects', 'create', docRef.id, data, newProj.project_name);
      addToast("Quote created successfully", 'success');
    }
    setIsCreateOpen(false); 
  };

  const updateStatus = async (pid, newStatus) => {
    if (newStatus === 'Closed' && role !== 'admin') return alert("Only Admin can close projects.");
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', pid), { status: newStatus });
    logAction('projects', 'status_change', pid, { status: newStatus }, selectedProject?.project_name);
  };

  const handleDuplicate = (project) => {
    if(!confirm(`Duplicate "${project.project_name}" to create a new quote?`)) return;
    
    // Deep copy items to ensure new IDs
    const itemsCopy = (project.items || []).map(item => ({...item, id: Date.now() + Math.random().toString()}));
    
    setNewProj({ 
      project_name: `Copy of ${project.project_name}`, 
      client_id: project.client_id, 
      start_date: '', end_date: '', setup_date: '', 
      venue: project.venue, status: 'Quoted', 
      invoice_status: 'Not Invoiced', invoice_no: '', invoice_date: '',
      items: itemsCopy, assigned_employees: [], logistics_costs: project.logistics_costs || {} 
    });
    setEditingId(null);
    setIsCreateOpen(true);
  };

  // --- Helper to fetch Org Settings ---
  const getOrgSettings = async () => {
    try {
        const docSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'organization'));
        if (docSnap.exists()) return docSnap.data();
    } catch (e) { console.error(e); }
    return null;
  };

  const getChallanedQty = (allocationId, type, excludeChallanId = null) => {
    return (selectedProject.challans || [])
        .filter(c => c.type === type && c.id !== excludeChallanId)
        .reduce((acc, c) => {
            const item = c.items.find(i => i.id === allocationId);
            return acc + (item ? (parseInt(item.qty) || 0) : 0);
        }, 0);
  };

  const openChallanModal = (type, challanToEdit = null) => {
    setChallanType(type);
    setEditingChallan(challanToEdit);
    
    const initialSelection = {};
    if (challanToEdit) {
        setChallanForm({
            ...(challanToEdit.transport || {}),
            date: challanToEdit.date ? new Date(challanToEdit.date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0]
        });
        (selectedProject.items || []).forEach(item => {
            const existing = challanToEdit.items.find(i => i.id === item.id);
            initialSelection[item.id] = existing ? existing.qty : 0;
        });
    } else {
        setChallanForm({ 
            mode: 'Road', vehicle_no: '', driver_name: '', driver_mobile: '', eway_bill: '', dispatch_address: '',
            date: new Date().toISOString().split('T')[0]
        });
        (selectedProject.items || []).forEach(item => {
            initialSelection[item.id] = 0;
        });
    }
    
    setChallanSelection(initialSelection);
    setIsChallanModalOpen(true);
    setIsChallanHistoryOpen(false);
  };

  // --- Print Handler ---
  const printProjectDocument = async (type) => {
    if (type === 'challan') {
        setIsChallanModalOpen(true);
        return;
    }

    const pdfDoc = new jsPDF();
    const pageWidth = pdfDoc.internal.pageSize.width;
    
    // Job Sheet Header
    const addHeader = (title) => {
        pdfDoc.setFontSize(18);
        pdfDoc.text(title, 14, 20);
        pdfDoc.setFontSize(10);
        pdfDoc.text(`Project: ${selectedProject.project_name}`, 14, 30);
        pdfDoc.text(`Client: ${clients.find(c=>c.id===selectedProject.client_id)?.name || '-'}`, 14, 35);
        pdfDoc.text(`Venue: ${selectedProject.venue}`, 14, 40);
        pdfDoc.text(`Dates: ${selectedProject.start_date} to ${selectedProject.end_date}`, 14, 45);
        if (selectedProject.setup_date) pdfDoc.text(`Setup: ${selectedProject.setup_date}`, 14, 50);
        return 60;
    };

    if (type === 'pick_list') {
        let y = addHeader("WAREHOUSE PICK LIST");
        
        const pickMap = new Map();

        const processItem = (itemId, qty) => {
            const item = inventory.find(i => i.id === itemId);
            if (!item) return;

            if (item.is_composite && item.composition?.length > 0) {
                item.composition.forEach(comp => {
                    processItem(comp.item_id, qty * (parseInt(comp.qty) || 1));
                });
            } else {
                const existing = pickMap.get(item.id) || {
                    name: item.name,
                    location: item.location || '-',
                    weight: parseFloat(item.weight || 0),
                    qty: 0
                };
                existing.qty += qty;
                pickMap.set(item.id, existing);
            }
        };

        (selectedProject.items || []).forEach(pItem => {
            processItem(pItem.item_id, parseInt(pItem.qty) || 0);
        });

        const pickRows = Array.from(pickMap.values()).map(item => [
            item.name,
            item.qty,
            item.location,
            item.weight > 0 ? `${(item.weight * item.qty).toFixed(2)} kg` : '-'
        ]);

        // Sort by Location then Name
        pickRows.sort((a, b) => (a[2] || '').localeCompare(b[2] || '') || a[0].localeCompare(b[0]));

        pdfDoc.setFontSize(11);
        pdfDoc.text("Consolidated Component List (Kits Broken Down)", 14, y);
        y += 6;

        autoTable(pdfDoc, {
            startY: y,
            head: [['Item Name', 'Total Qty', 'Location', 'Total Weight']],
            body: pickRows,
            theme: 'grid',
            headStyles: { fillColor: [234, 88, 12], textColor: 255 }, // Orange
            styles: { fontSize: 10, cellPadding: 3 },
            columnStyles: {
                0: { cellWidth: 'auto' },
                1: { cellWidth: 25, halign: 'center' },
                2: { cellWidth: 40 },
                3: { cellWidth: 30, halign: 'right' }
            }
        });
        
        pdfDoc.save(`PickList_${selectedProject.project_name}.pdf`);
        return;
    }

    if (type === 'job_sheet') {
        let y = addHeader("PROJECT JOB SHEET");
        
        let totalWatts = 0;
        let totalWeight = 0;
        const equipmentRows = (selectedProject.items || []).map(i => {
            const inv = inventory.find(x => x.id === i.item_id);
            const w = (inv?.weight || 0) * i.qty;
            const p = (inv?.power_watts || 0) * i.qty;
            totalWeight += w;
            totalWatts += p;
            return [i.item_name, i.qty, inv?.location || '-', `${inv?.weight || 0} kg`, `${inv?.power_watts || 0} W`];
        });

        pdfDoc.setFillColor(245, 247, 250);
        pdfDoc.rect(14, y, pageWidth - 28, 22, 'F');
        pdfDoc.setFontSize(11);
        pdfDoc.setTextColor(60);
        pdfDoc.text(`Est. Total Weight: ${totalWeight.toFixed(2)} kg`, 20, y + 14);
        pdfDoc.text(`Est. Total Power: ${(totalWatts/1000).toFixed(2)} kW (${(totalWatts/230).toFixed(1)}A @ 230V)`, 100, y + 14);
        pdfDoc.setTextColor(0);
        y += 30;

        pdfDoc.setFontSize(12);
        pdfDoc.text("Internal Equipment List", 14, y);
        y += 4;
        autoTable(pdfDoc, {
            startY: y,
            head: [['Item', 'Qty', 'Location', 'Unit Wt', 'Unit Pwr']],
            body: equipmentRows,
            theme: 'grid',
            headStyles: { fillColor: [79, 70, 229] },
            styles: { fontSize: 9 }
        });
        y = pdfDoc.lastAutoTable.finalY + 15;

        if ((selectedProject.vendor_allocations || []).length > 0) {
            pdfDoc.text("Outsourced / Vendor Equipment", 14, y);
            y += 4;
            const vendorRows = selectedProject.vendor_allocations.map(v => [
                v.vendor_name, v.item_name, v.qty, `${v.days} days`
            ]);
            autoTable(pdfDoc, {
                startY: y,
                head: [['Vendor', 'Item', 'Qty', 'Duration']],
                body: vendorRows,
                theme: 'grid',
                headStyles: { fillColor: [220, 38, 38] },
                styles: { fontSize: 9 }
            });
        }
        pdfDoc.save(`JobSheet_${selectedProject.project_name}.pdf`);
    }
  };

  const printChallanPDF = async (challanData) => {
    try {
        const pdfDoc = new jsPDF();
        const pageWidth = pdfDoc.internal.pageSize.width;
        const orgSettings = await getOrgSettings();
        const isReturn = challanData.type === 'return';
        const displayChallanNo = isReturn ? `RET/${challanData.challan_no}` : challanData.challan_no;
        const todayStr = new Date(challanData.date).toLocaleDateString('en-IN');

        // --- Header Section (Org Details) ---
        let y = 15;
        if (orgSettings?.logo) {
            try {
                pdfDoc.addImage(orgSettings.logo, 'JPEG', 14, 10, 25, 25);
            } catch (e) { console.warn("Logo add failed", e); }
        }
        
        pdfDoc.setFontSize(16);
        pdfDoc.setFont("helvetica", "bold");
        pdfDoc.text(orgSettings?.name || "RENTAL OPS", 45, 18);
        
        pdfDoc.setFontSize(9);
        pdfDoc.setFont("helvetica", "normal");
        const addrLines = pdfDoc.splitTextToSize(orgSettings?.address || "", 100);
        pdfDoc.text(addrLines, 45, 24);
        
        let headerY = 24 + (addrLines.length * 4);
        if (orgSettings?.gstin) pdfDoc.text(`GSTIN: ${orgSettings.gstin}`, 45, headerY);
        if (orgSettings?.pan) pdfDoc.text(`PAN: ${orgSettings.pan}`, 100, headerY);
        
        // Ensure we start below the header
        y = Math.max(y + 25, headerY + 10);

        // Title
        pdfDoc.setFontSize(14);
        pdfDoc.setFont("helvetica", "bold");
        pdfDoc.text(isReturn ? "RETURN CHALLAN" : "DELIVERY CHALLAN", pageWidth - 14, 20, { align: 'right' });
        pdfDoc.setFontSize(8);
        pdfDoc.setFont("helvetica", "normal");
        pdfDoc.text(isReturn ? "(Material Returning from Project)" : "(Authority to carry inventory for Project Execution)", pageWidth - 14, 25, { align: 'right' });

        pdfDoc.setFontSize(10);
        pdfDoc.text(`Challan No: ${displayChallanNo}`, pageWidth - 14, 32, { align: 'right' });
        pdfDoc.text(`Date: ${todayStr}`, pageWidth - 14, 37, { align: 'right' });

        pdfDoc.setLineWidth(0.5); pdfDoc.line(14, y, pageWidth - 14, y);
        y += 5;

        // --- Consignee & Transport Details ---
        const client = clients.find(c=>c.id===selectedProject.client_id);
        
        // Left: Consignee
        pdfDoc.setFontSize(10);
        pdfDoc.setFont("helvetica", "bold");
        pdfDoc.text(isReturn ? "Received From (Client):" : "Consignee (Client):", 14, y);
        pdfDoc.setFont("helvetica", "normal");
        pdfDoc.text(client?.name || '-', 14, y + 5);
        const clientAddr = pdfDoc.splitTextToSize(client?.address || "Address not available", 80);
        pdfDoc.text(clientAddr, 14, y + 10);
        if (client?.gstin) pdfDoc.text(`GSTIN: ${client.gstin}`, 14, y + 10 + (clientAddr.length * 4) + 2);

        // Right: Transport & Project
        pdfDoc.text(`Project: ${selectedProject.project_name}`, 110, y);
        pdfDoc.text(`Venue: ${selectedProject.venue}`, 110, y + 5);
        pdfDoc.text(isReturn ? `Return To: ${orgSettings?.address ? 'Warehouse / Office' : 'Warehouse'}` : `Dispatch To: ${challanForm.dispatch_address || selectedProject.venue}`, 110, y + 10);
        
        // Calculate Y based on address height to avoid overlap
        y = Math.max(y + 25, y + 10 + (clientAddr.length * 4) + 10);

        const transport = challanData.transport || {};
        pdfDoc.rect(14, y, pageWidth - 28, 18);
        pdfDoc.setFontSize(9);
        pdfDoc.text(`Transport Mode: ${transport.mode || '-'}`, 16, y + 6);
        pdfDoc.text(`Vehicle No: ${transport.vehicle_no || '-'}`, 80, y + 6);
        pdfDoc.text(`E-Way Bill: ${transport.eway_bill || '-'}`, 150, y + 6);
        pdfDoc.text(`Driver: ${transport.driver_name || '-'} (${transport.driver_mobile || '-'})`, 16, y + 12);

        // --- Inventory Table ---
        y += 25;
        const items = (challanData.items || []).map((i, idx) => {
            const invItem = inventory.find(inv => inv.id === i.item_id);
            return [
                idx + 1, 
                `${i.item_name}\nSN: ${invItem?.serial_number || '-'}`, 
                invItem?.hsn_code || '-',
                i.qty, 
                `${i.days} Days`,
                formatCurrencyPDF(i.rate),
                formatCurrencyPDF(i.total)
            ];
        });

        autoTable(pdfDoc, { 
            startY: y, 
            head: [['#', 'Description of Goods', 'HSN/SAC', 'Qty', 'Duration', 'Rate', 'Amount']], 
            body: items, 
            theme: 'grid',
            margin: { left: 14, right: 14 },
            styles: { fontSize: 8, cellPadding: 2, overflow: 'linebreak' }, 
            headStyles: { fillColor: [50, 50, 50], textColor: 255 },
            columnStyles: { 
                0: { cellWidth: 8 }, 
                1: { cellWidth: 58 }, 
                2: { cellWidth: 14 },
                3: { cellWidth: 10, halign: 'center' },
                4: { cellWidth: 14, halign: 'center' },
                5: { cellWidth: 18, halign: 'right' },
                6: { cellWidth: 54, halign: 'right', cellPadding: { top: 2, bottom: 2, left: 2, right: 10 } }
            }
        });
        
        let finalY = ((pdfDoc.lastAutoTable && pdfDoc.lastAutoTable.finalY) || y + 50) + 10;

        if (orgSettings?.challan_terms) {
            pdfDoc.setFontSize(9);
            pdfDoc.setFont("helvetica", "bold");
            pdfDoc.text("Terms & Conditions:", 14, finalY);
            pdfDoc.setFont("helvetica", "normal");
            pdfDoc.setFontSize(8);
            const terms = pdfDoc.splitTextToSize(orgSettings.challan_terms, pageWidth - 28);
            pdfDoc.text(terms, 14, finalY + 5);
            finalY += 10 + (terms.length * 3.5);
        }
        
        // --- Footer / Declarations ---
        pdfDoc.setFontSize(8);
        pdfDoc.text("Declaration:", 14, finalY);
        pdfDoc.text(isReturn ? "1. Material returning from project site to warehouse." : "1. The goods are being transported for project execution purpose only and not for sale.", 14, finalY + 5);
        pdfDoc.text(isReturn ? "2. Not for sale." : "2. The goods will be returned to the consignor after completion of the project.", 14, finalY + 9);
        
        pdfDoc.setLineWidth(0.5); 
        pdfDoc.line(14, finalY + 25, 80, finalY + 25); 
        pdfDoc.text("Authorized Signatory", 14, finalY + 30); 
        pdfDoc.text(`For ${orgSettings?.name || 'Company'}`, 14, finalY + 34);

        pdfDoc.line(pageWidth - 90, finalY + 25, pageWidth - 14, finalY + 25); 
        pdfDoc.text(isReturn ? "Sender's Signature (Client)" : "Receiver's Signature & Stamp", pageWidth - 90, finalY + 30);
        
        pdfDoc.save(`${isReturn ? 'Return' : 'Delivery'}_Challan_${displayChallanNo.replace('/','-')}.pdf`);
    } catch (error) {
        console.error("Challan PDF Error:", error);
        alert("Failed to generate Challan PDF. See console for details.");
    }
  };

  const handleSaveChallan = async () => {
    const itemsToShip = [];
    
    // Validate and build items list
    for (const item of (selectedProject.items || [])) {
        const qty = parseInt(challanSelection[item.id] || 0);
        if (qty > 0) {
            const excludeId = editingChallan ? editingChallan.id : null;
            const alreadyChallaned = getChallanedQty(item.id, challanType, excludeId);
            
            let maxQty = 0;
            if (challanType === 'delivery') {
                maxQty = item.qty - alreadyChallaned;
            } else {
                // Return: Max is what was delivered - what was already returned
                const delivered = getChallanedQty(item.id, 'delivery');
                const returned = getChallanedQty(item.id, 'return', excludeId);
                maxQty = delivered - returned;
            }

            if (qty > maxQty) {
                alert(`Error: Item "${item.item_name}" exceeds available quantity. Max: ${maxQty}, Requested: ${qty}`);
                return;
            }
            itemsToShip.push({ ...item, qty });
        }
    }

    if (itemsToShip.length === 0) return alert("Please select at least one item.");

    try {
        let challanData = { ...editingChallan };
        
        if (!editingChallan) {
            const fy = getFinancialYear();
            const newChallanNo = await runTransaction(db, async (transaction) => {
                const counterRef = doc(db, 'artifacts', appId, 'public', 'data', 'counters', 'challan');
                const counterDoc = await transaction.get(counterRef);
                let currentCount = 0;
                if (counterDoc.exists()) {
                    const data = counterDoc.data();
                    currentCount = (data && typeof data[fy] === 'number') ? data[fy] : 0;
                }
                const nextCount = currentCount + 1;
                transaction.set(counterRef, { [fy]: nextCount }, { merge: true });
                return `${fy}/${String(nextCount).padStart(4, '0')}`;
            });
            
            challanData = {
                id: Date.now().toString(),
                challan_no: newChallanNo,
                type: challanType,
                created_by: user.uid,
                date: new Date().toISOString()
            };
        }

        challanData.items = itemsToShip;
        challanData.transport = challanForm;
        challanData.date = new Date(challanForm.date).toISOString();
        challanData.updated_at = new Date().toISOString();

        const projectRef = doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id);
        
        if (editingChallan) {
            await updateDoc(projectRef, { challans: arrayRemove(editingChallan) });
        }
        
        await updateDoc(projectRef, { 
            challans: arrayUnion(challanData),
            ...(!selectedProject.challan_no && challanType === 'delivery' ? { challan_no: challanData.challan_no, challan_date: challanData.date } : {})
        });
        
        logAction('projects', editingChallan ? 'update_challan' : 'create_challan', selectedProject.id, { challan_no: challanData.challan_no }, selectedProject.project_name);
        
        if (confirm("Challan Saved. Print now?")) {
            printChallanPDF(challanData);
        }
        setIsChallanModalOpen(false);
    } catch (e) {
        console.error(e);
        alert(`Error saving challan: ${e.message}`);
    }
  };

  const handleDeleteChallan = async (challan) => {
    if(!confirm(`Are you sure you want to delete Challan ${challan.challan_no}?`)) return;
    try {
        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), {
            challans: arrayRemove(challan)
        });
        logAction('projects', 'delete_challan', selectedProject.id, { challan_no: challan.challan_no }, selectedProject.project_name);
    } catch(e) {
        console.error(e);
        alert("Failed to delete challan");
    }
  };

  const downloadEWayBillJSON = async () => {
    const orgSettings = await getOrgSettings();
    const client = clients.find(c => c.id === selectedProject.client_id);
    
    if (!orgSettings || !client) return alert("Organization or Client details missing.");

    const itemsToShip = (selectedProject.items || []).filter(item => (challanSelection[item.id] || 0) > 0).map(item => ({
        ...item,
        qty: parseInt(challanSelection[item.id])
    }));

    if (itemsToShip.length === 0) return alert("Select items first.");

    const ewayData = {
        "supplyType": "O",
        "subSupplyType": "8", // Exhibition or Fairs
        "docType": "CHL",
        "docNo": "DRAFT",
        "docDate": new Date().toLocaleDateString('en-IN'),
        "fromGstin": orgSettings.gstin || "URP",
        "fromTrdName": orgSettings.name || "",
        "fromAddr1": orgSettings.address || "",
        "fromPlace": "", 
        "fromPincode": 100000, // Placeholder
        "toGstin": client.gstin || "URP",
        "toTrdName": client.name || "",
        "toAddr1": client.address || "",
        "toPlace": "",
        "toPincode": 100000, // Placeholder
        "itemList": itemsToShip.map(item => ({
            "productName": item.item_name,
            "hsnCode": parseInt(inventory.find(i=>i.id===item.item_id)?.hsn_code || 0),
            "quantity": parseInt(item.qty),
            "qtyUnit": "NOS",
            "taxableAmount": parseFloat(item.amount),
            "sgstRate": 0, "cgstRate": 0, "igstRate": 0 // Rates to be filled by user in portal if needed
        })),
        "transMode": challanForm.mode === 'Road' ? 1 : challanForm.mode === 'Rail' ? 2 : challanForm.mode === 'Air' ? 3 : 4,
        "transDistance": 0,
        "transporterName": "",
        "transDocNo": challanForm.eway_bill || "",
        "transDocDate": new Date().toLocaleDateString('en-IN'),
        "vehicleNo": challanForm.vehicle_no || ""
    };

    const blob = new Blob([JSON.stringify(ewayData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `EWayBill_${selectedProject.challan_no || 'Draft'}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  // --- NEW INVOICE HANDLER ---
  const updateInvoiceDetails = async (field, value) => {
    // Constraint: Can only update if Completed or Closed
    const isCompleted = selectedProject.status === 'Completed' || selectedProject.status === 'Closed';
    
    // Allow Admin to force edit even if not completed, otherwise block
    if (!isCompleted && role !== 'admin') {
        return alert("Project must be 'Completed' before invoicing.");
    }

    const updates = { [field]: value };
    
    // Logic: If setting status to 'Not Invoiced', clear details
    if (field === 'invoice_status' && value === 'Not Invoiced') {
        updates.invoice_no = '';
        updates.invoice_date = '';
    }

    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), updates);
    logAction('projects', 'invoice_update', selectedProject.id, updates, selectedProject.project_name);
  };

  // ... (Keep existing toggleEmployee, updateLogisticsCost, Modal handlers) ...
  const toggleEmployee = async (empId) => {
    const currentAssigned = selectedProject.assigned_employees || [];
    const newAssigned = currentAssigned.includes(empId) ? currentAssigned.filter(id => id !== empId) : [...currentAssigned, empId];
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), { assigned_employees: newAssigned });
    logAction('projects', 'assign_employee', selectedProject.id, { empId, action: currentAssigned.includes(empId) ? 'remove' : 'add' }, selectedProject.project_name);
  };

  const updateLogisticsCost = async (type, field, value) => {
    const currentCosts = selectedProject.logistics_costs || {};
    const newCosts = { ...currentCosts, [type]: { ...(currentCosts[type] || { amount: 0, gst: 0 }), [field]: parseFloat(value) || 0 } };
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), { logistics_costs: newCosts });
    logAction('projects', 'update_logistics', selectedProject.id, { type, field, value }, selectedProject.project_name);
  };

  const openAllocationModal = () => {
    const days = selectedProject?.start_date && selectedProject?.end_date ? getDaysDifference(selectedProject.start_date, selectedProject.end_date) : 1;
    setAllocationForm({ item_id: '', qty: 1, rate: 0, days: days, gst_rate: 18, available_qty: 0, description: '' });
    setIsAllocationModalOpen(true);
  };

  const handleItemSelect = (e) => {
    const itemId = e.target.value;
    if (!itemId) return setAllocationForm(p => ({...p, item_id: '', available_qty: 0}));
    const item = inventory.find(i => i.id === itemId);
    if (item) setAllocationForm(p => ({ ...p, item_id: itemId, rate: item.rate_per_day || 0, gst_rate: item.gst_rate || 18, available_qty: getAvailableQty(itemId) }));
  };

  const handleSaveAllocation = async () => {
    if(!allocationForm.item_id) return alert("Select an item");
    const item = inventory.find(i => i.id === allocationForm.item_id);
    if (allocationForm.qty > allocationForm.available_qty) {
      if(!confirm(`Warning: You are allocating ${allocationForm.qty} but only ${allocationForm.available_qty} are available. Proceed?`)) return;
    }
    const amount = allocationForm.qty * allocationForm.rate * allocationForm.days;
    const newItem = { id: Date.now().toString(), item_id: item.id, item_name: item.name, category: item.category, is_external: item.is_external || false, qty: parseInt(allocationForm.qty), rate: parseFloat(allocationForm.rate), days: parseInt(allocationForm.days), gst_rate: parseFloat(allocationForm.gst_rate), amount, gst_amount: amount * (allocationForm.gst_rate/100), total: amount * (1 + allocationForm.gst_rate/100), description: allocationForm.description || '' };
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), { items: arrayUnion(newItem) });
    logAction('projects', 'allocate_item', selectedProject.id, newItem, selectedProject.project_name);
    setAllocationForm(p => ({...p, item_id: '', qty: 1, available_qty: 0, description: ''})); 
  };

  const handleUpdateItemAllocation = async (updatedItem) => {
    const qty = parseInt(updatedItem.qty) || 0;
    const rate = parseFloat(updatedItem.rate) || 0;
    const days = parseInt(updatedItem.days) || 0;
    const gst_rate = parseFloat(updatedItem.gst_rate) || 0;
    
    const amount = qty * rate * days;
    const gst_amount = amount * (gst_rate / 100);
    const total = amount + gst_amount;

    const finalItem = { ...updatedItem, qty, rate, days, amount, gst_amount, total };

    const newItems = selectedProject.items.map(item => {
      if (item.id === finalItem.id) {
        return finalItem;
      }
      return item;
    });
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), { items: newItems });
    logAction('projects', 'update_item_allocation', selectedProject.id, { item: finalItem }, selectedProject.project_name);
    setIsEditItemModalOpen(false);
  };

  const handleRemoveAllocation = async (item) => {
    if(confirm("Remove this item?")) {
        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), { items: arrayRemove(item) });
        logAction('projects', 'remove_item', selectedProject.id, item, selectedProject.project_name);
    }
  };

  const calculateProjectTotals = () => {
    if (!selectedProject) return { equipment: 0, logistics: 0, total: 0, gst_output: 0, gst_input: 0, outsourcing: 0, direct_expense: 0 };
    const equipmentBase = (selectedProject.items || []).reduce((acc, i) => acc + (i.amount || 0), 0);
    const equipmentGST = (selectedProject.items || []).reduce((acc, i) => acc + (i.gst_amount || 0), 0);
    let logisticsBase = 0; let logisticsGST = 0;
    if (selectedProject.logistics_costs) {
      Object.values(selectedProject.logistics_costs).forEach(c => {
         const base = c.amount || 0; logisticsBase += base; logisticsGST += base * ((c.gst || 0)/100);
      });
    }
    const outsourcingBase = (selectedProject.vendor_allocations || []).reduce((acc, v) => acc + (v.amount || 0), 0);
    const outsourcingGST = (selectedProject.vendor_allocations || []).reduce((acc, v) => acc + (v.amount * (v.gst/100) || 0), 0);
    const directExpenses = expenses.filter(e => e.project_id === selectedProject.id && e.status !== 'Rejected').reduce((acc, e) => acc + parseFloat(e.amount || 0), 0);
    const gstOutput = equipmentGST + logisticsGST;
    const gstInput = outsourcingGST;
    return { 
      equipment: equipmentBase, logistics: logisticsBase, outsourcing: outsourcingBase,
      direct_expense: directExpenses, gst_output: gstOutput, gst_input: gstInput,
      gst_payable: gstOutput - gstInput,
      total_revenue: equipmentBase + logisticsBase + gstOutput,
      total_cost: outsourcingBase + directExpenses + gstInput 
    };
  };

  if (selectedProject) {
    const totals = calculateProjectTotals();
    const margin = (totals.equipment + totals.logistics) - (totals.outsourcing + totals.direct_expense);
    const isInvoicingEnabled = selectedProject.status === 'Completed' || selectedProject.status === 'Closed' || role === 'admin';

    return (
      <div className="space-y-6">
        <button onClick={() => setSelectedProjectId(null)} className="flex items-center text-slate-500 hover:text-indigo-600"><ArrowLeft size={16} className="mr-1" /> Back to Projects</button>
        <div className="flex flex-col justify-between gap-4 rounded-xl bg-white p-6 shadow-sm md:flex-row md:items-center">
          <div>
            <h1 className="text-2xl font-bold text-slate-800">{selectedProject.project_name}</h1>
            <div className="flex items-center gap-2 text-slate-500">
                <span>{clients.find(c=>c.id === selectedProject.client_id)?.name}</span><span>•</span><span>{selectedProject.start_date} to {selectedProject.end_date}</span>{selectedProject.setup_date && <span className="text-indigo-600 font-medium"> (Setup: {selectedProject.setup_date})</span>}
            </div>
            {selectedProject.challan_no && <div className="mt-1 text-xs font-mono text-slate-500 bg-slate-100 inline-block px-2 py-0.5 rounded">Challan #: {selectedProject.challan_no}</div>}
          </div>
          <div className="flex items-center gap-3">
            <button onClick={() => printProjectDocument('job_sheet')} className="flex items-center gap-1 rounded border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50 text-slate-700" title="Print Job Sheet">
                <Printer size={16} /> <span className="hidden sm:inline">Job Sheet</span>
            </button>
            <button onClick={() => printProjectDocument('pick_list')} className="flex items-center gap-1 rounded border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50 text-slate-700" title="Print Pick List">
                <ListChecks size={16} /> <span className="hidden sm:inline">Pick List</span>
            </button>
            <button onClick={() => openChallanModal('delivery', null)} className="flex items-center gap-1 rounded border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50 text-slate-700" title="Create Delivery Challan">
                <FileCheck size={16} /> <span className="hidden sm:inline">Challan</span>
            </button>
            <button onClick={() => openChallanModal('return', null)} className="flex items-center gap-1 rounded border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50 text-slate-700" title="Create Return Challan">
                <RotateCcw size={16} /> <span className="hidden sm:inline">Return</span>
            </button>
            <button onClick={() => setIsChallanHistoryOpen(true)} className="flex items-center gap-1 rounded border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50 text-slate-700" title="Challan History">
                <History size={16} />
            </button>
            <span className={`px-3 py-1 rounded-full text-sm font-bold border ${STATUS_COLORS[selectedProject.status]}`}>{selectedProject.status}</span>{(role === 'admin' || role === 'manager') && (<select className="rounded border p-1 text-sm bg-slate-50" value={selectedProject.status} onChange={(e) => updateStatus(selectedProject.id, e.target.value)}><option value="Quoted">Quoted</option><option value="Confirmed">Confirmed</option><option value="Ongoing">Ongoing</option><option value="Completed">Completed</option><option value="Closed">Closed</option><option value="Cancelled">Cancelled</option></select>)}
          </div>
        </div>

        {/* --- NEW INVOICING CARD --- */}
        {role !== 'tech' && (
        <div className={`rounded-xl p-6 shadow-sm border transition-colors ${selectedProject.invoice_status === 'Invoiced' ? 'bg-green-50 border-green-200' : 'bg-white border-slate-200'}`}>
            <div className="flex items-center justify-between mb-4">
                <h3 className="font-bold text-slate-800 flex items-center gap-2"><FileText size={18} className="text-indigo-600" /> Invoicing & Billing</h3>
                <div className={`text-xs px-2 py-1 rounded border font-medium ${selectedProject.invoice_status === 'Invoiced' ? 'bg-green-100 text-green-700 border-green-200' : 'bg-slate-100 text-slate-600 border-slate-200'}`}>
                    {selectedProject.invoice_status || 'Not Invoiced'}
                </div>
            </div>
            
            <div className="flex flex-wrap items-end gap-4">
                <div className="flex-1 min-w-[200px]">
                    <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Invoice Status</label>
                    <select 
                        disabled={!isInvoicingEnabled}
                        className={`w-full rounded border p-2 text-sm ${!isInvoicingEnabled ? 'bg-slate-100 cursor-not-allowed' : 'bg-white'}`}
                        value={selectedProject.invoice_status || 'Not Invoiced'}
                        onChange={(e) => updateInvoiceDetails('invoice_status', e.target.value)}
                    >
                        <option value="Not Invoiced">Not Invoiced</option>
                        <option value="Invoiced">Invoiced</option>
                    </select>
                </div>

                {selectedProject.invoice_status === 'Invoiced' && (
                    <>
                        <div className="flex-1 min-w-[200px]">
                            <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Invoice Number</label>
                            <input 
                                type="text" 
                                className="w-full rounded border p-2 text-sm"
                                placeholder="e.g. INV-2024-001"
                                value={selectedProject.invoice_no || ''}
                                onChange={(e) => updateInvoiceDetails('invoice_no', e.target.value)}
                            />
                        </div>
                        <div className="flex-1 min-w-[200px]">
                            <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Invoice Date</label>
                            <input 
                                type="date" 
                                className="w-full rounded border p-2 text-sm"
                                value={selectedProject.invoice_date || ''}
                                onChange={(e) => updateInvoiceDetails('invoice_date', e.target.value)}
                            />
                        </div>
                    </>
                )}
                
                {!isInvoicingEnabled && (
                    <div className="text-xs text-orange-600 flex items-center gap-1 font-medium bg-orange-50 px-3 py-2 rounded">
                        <AlertCircle size={12} /> Project must be "Completed" to invoice.
                    </div>
                )}
            </div>
        </div>
        )}

        {/* Profit & Loss Summary */}
        {role !== 'tech' && (
        <div className="rounded-xl bg-white p-6 shadow-sm border border-indigo-100">
           <h3 className="mb-4 font-bold text-slate-800 text-lg flex items-center gap-2"><Calculator size={20} className="text-indigo-600"/> Profit & Loss Summary</h3>
           <div className="grid grid-cols-2 md:grid-cols-4 gap-6 text-sm">
              <div className="space-y-2">
                 <div className="font-semibold text-slate-500 border-b pb-1">REVENUE (Excl. GST)</div>
                 <div className="flex justify-between"><span>Equipment</span><span className="font-medium">{formatCurrency(totals.equipment)}</span></div>
                 <div className="flex justify-between"><span>Logistics</span><span className="font-medium">{formatCurrency(totals.logistics)}</span></div>
                 <div className="flex justify-between text-indigo-700 font-bold border-t pt-1"><span>Total</span><span>{formatCurrency(totals.equipment + totals.logistics)}</span></div>
              </div>
              <div className="space-y-2">
                 <div className="font-semibold text-slate-500 border-b pb-1">DIRECT COSTS</div>
                 <div className="flex justify-between"><span>Outsourcing</span><span className="font-medium text-red-600">-{formatCurrency(totals.outsourcing)}</span></div>
                 <div className="flex justify-between"><span>Expenses</span><span className="font-medium text-red-600">-{formatCurrency(totals.direct_expense)}</span></div>
                 <div className="flex justify-between text-red-700 font-bold border-t pt-1"><span>Total</span><span>-{formatCurrency(totals.outsourcing + totals.direct_expense)}</span></div>
              </div>
              <div className="space-y-2">
                 <div className="font-semibold text-slate-500 border-b pb-1">GST ANALYSIS</div>
                 <div className="flex justify-between"><span>Output (Coll)</span><span className="font-medium text-green-600">{formatCurrency(totals.gst_output)}</span></div>
                 <div className="flex justify-between"><span>Input (Paid)</span><span className="font-medium text-red-600">{formatCurrency(totals.gst_input)}</span></div>
                 <div className="flex justify-between font-bold border-t pt-1"><span>Payable</span><span>{formatCurrency(totals.gst_payable)}</span></div>
              </div>
              <div className="bg-slate-50 p-3 rounded flex flex-col justify-center text-center">
                 <div className="text-xs font-semibold text-slate-500 uppercase">Est. Gross Margin</div>
                 <div className={`text-2xl font-bold ${margin >= 0 ? 'text-green-600' : 'text-red-600'}`}>{formatCurrency(margin)}</div>
                 <div className="text-xs text-slate-400 mt-1">Revenue - Direct Costs</div>
              </div>
           </div>
        </div>
        )}

        <div className="grid gap-6 md:grid-cols-3">
          {/* ... (Keep existing layout for Team, Logistics, Equipment) ... */}
          <div className="md:col-span-2 space-y-6">
            <div className="rounded-xl bg-white p-6 shadow-sm">
               <div className="flex items-center justify-between mb-4"><h3 className="font-semibold text-slate-800 flex items-center gap-2"><Users size={18} /> Assigned Team</h3>{(role === 'admin' || role === 'manager') && (<button onClick={() => setIsEmpModalOpen(true)} className="text-xs font-medium text-indigo-600 hover:underline">Manage Team</button>)}</div>
               <div className="flex flex-wrap gap-2">{(selectedProject.assigned_employees || []).length > 0 ? (selectedProject.assigned_employees || []).map(empId => { const emp = employees.find(e => e.id === empId); return (<div key={empId} className="flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1 text-sm"><div className="h-5 w-5 rounded-full bg-indigo-200 flex items-center justify-center text-[10px] font-bold text-indigo-700">{emp?.name?.charAt(0) || '?'}</div><span className="text-slate-700">{emp?.name || 'Unknown'}</span></div>); }) : (<div className="text-sm text-slate-400 italic">No employees assigned.</div>)}</div>
            </div>
            {role !== 'tech' && (
            <div className="rounded-xl bg-white p-6 shadow-sm">
               <h3 className="font-semibold text-slate-800 mb-4 flex items-center gap-2"><DollarSign size={18} /> Logistics & Services</h3>
               <div className="overflow-x-auto"><table className="w-full text-sm text-left"><thead className="bg-slate-50 text-slate-500"><tr><th className="p-3">Cost Type</th><th className="p-3 w-32">Amount</th><th className="p-3 w-24">GST %</th><th className="p-3 text-right">Total</th></tr></thead><tbody className="divide-y divide-slate-100">{LOGISTICS_TYPES.map(type => { const saved = (selectedProject.logistics_costs || {})[type.id] || { amount: 0, gst: 18 }; const total = (saved.amount || 0) * (1 + (saved.gst || 0)/100); return (<tr key={type.id}><td className="p-3 flex items-center gap-2"><span className="text-slate-400">{type.icon}</span><span className="text-slate-700 font-medium">{type.label}</span></td><td className="p-3"><input type="number" min="0" className="w-full rounded border p-1" value={saved.amount} onChange={(e) => updateLogisticsCost(type.id, 'amount', e.target.value)} disabled={role === 'tech'} /></td><td className="p-3"><select className="w-full rounded border p-1" value={saved.gst} onChange={(e) => updateLogisticsCost(type.id, 'gst', e.target.value)} disabled={role === 'tech'}><option value="0">0%</option><option value="5">5%</option><option value="12">12%</option><option value="18">18%</option><option value="28">28%</option></select></td><td className="p-3 text-right font-medium text-slate-800">{formatCurrency(total)}</td></tr>); })}</tbody><tfoot className="bg-slate-50 font-bold text-slate-800 border-t"><tr><td colSpan={3} className="p-3 text-right">Logistics Total:</td><td className="p-3 text-right">{formatCurrency(totals.logistics)}</td></tr></tfoot></table></div>
            </div>
            )}
            <div className="rounded-xl bg-white p-6 shadow-sm">
              <div className="flex items-center justify-between mb-4"><h3 className="font-semibold text-slate-800">Allocated Equipment</h3>{(role === 'manager' || role === 'admin') && selectedProject.status !== 'Closed' && (<button onClick={openAllocationModal} className="rounded bg-indigo-50 px-3 py-1 text-sm font-medium text-indigo-600 hover:bg-indigo-100">+ Add Item</button>)}</div>
              <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-slate-50 text-slate-500"><tr><th className="p-2">Item</th><th className="p-2 text-center">Qty</th><th className="p-2 text-center">Days</th>{role !== 'tech' && <th className="p-2 text-right">Rate</th>}{role !== 'tech' && <th className="p-2 text-right">Total</th>}<th className="p-2"></th></tr></thead><tbody className="divide-y divide-slate-100">{(selectedProject.items || []).map((item, idx) => (<tr key={idx} className="hover:bg-slate-50"><td className="p-2"><div className="font-medium text-slate-800">{item.item_name}</div>{item.description && <div className="text-xs text-slate-500 italic">{item.description}</div>}{item.is_external && <span className="text-xs text-purple-600 bg-purple-50 px-1 rounded">Ext</span>}</td><td className="p-2 text-center">{item.qty}</td><td className="p-2 text-center">{item.days}</td>{role !== 'tech' && <td className="p-2 text-right">{formatCurrency(item.rate)}</td>}{role !== 'tech' && <td className="p-2 text-right font-medium">{formatCurrency(item.total)}</td>}<td className="p-2 text-right">{(role === 'manager' || role === 'admin') && (<div className='flex justify-end'><button onClick={() => { setEditingItem(item); setIsEditItemModalOpen(true);}} className="text-blue-500 hover:text-blue-700"><Edit size={14} /></button><button onClick={() => handleRemoveAllocation(item)} className="text-red-400 hover:text-red-600"><Trash2 size={14} /></button></div>)}</td></tr>))}</tbody>{role !== 'tech' && <tfoot className="bg-slate-50 font-bold text-slate-800"><tr><td colSpan={4} className="p-2 text-right">Equipment Total:</td><td className="p-2 text-right">{formatCurrency(totals.equipment)}</td><td></td></tr></tfoot>}</table></div>
            </div>
          </div>
          <div className="space-y-6">
            {role !== 'tech' && (
            <div className="rounded-xl bg-white p-6 shadow-sm border border-indigo-100"><h3 className="mb-4 font-bold text-slate-800 text-lg">Project Summary</h3><div className="space-y-3 text-sm"><div className="flex justify-between"><span className="text-slate-500">Equipment Cost</span><span className="font-medium">{formatCurrency(totals.equipment)}</span></div><div className="flex justify-between"><span className="text-slate-500">Logistics & Services</span><span className="font-medium">{formatCurrency(totals.logistics)}</span></div><div className="border-t pt-3 flex justify-between text-lg font-bold text-indigo-700"><span>Grand Total</span><span>{formatCurrency(totals.total_revenue)}</span></div></div></div>
            )}
            <div className="rounded-xl bg-white p-6 shadow-sm"><h3 className="mb-4 font-semibold text-slate-800">Expenses</h3><div className="text-2xl font-bold text-slate-800">{formatCurrency(expenses.filter(e => e.project_id === selectedProject.id).reduce((s,e)=>s + parseFloat(e.amount), 0))}</div><div className="mt-2 text-xs text-slate-500">Total recorded expenses</div></div>
          </div>
        </div>
        <EditItemAllocationModal
          isOpen={isEditItemModalOpen}
          onClose={() => setIsEditItemModalOpen(false)}
          item={editingItem}
          onSave={handleUpdateItemAllocation}
        />
        <Modal isOpen={isChallanModalOpen} onClose={() => setIsChallanModalOpen(false)} title={`${editingChallan ? 'Edit' : 'Generate'} ${challanType === 'return' ? 'Return' : 'Delivery'} Challan`}>
            <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-2">
              <div className="bg-blue-50 p-3 rounded text-xs text-blue-700">Enter transport details to be printed on the official {challanType} challan.</div>
              <div className="grid grid-cols-2 gap-4">
                <div><label className="text-xs font-bold text-slate-500">Transport Mode</label><select className="w-full rounded border p-2" value={challanForm.mode} onChange={e => setChallanForm({ ...challanForm, mode: e.target.value })}><option>Road</option><option>Air</option><option>Train</option><option>Hand Carry</option></select></div>
                <div><label className="text-xs font-bold text-slate-500">Vehicle No</label><input className="w-full rounded border p-2" value={challanForm.vehicle_no} onChange={e => setChallanForm({ ...challanForm, vehicle_no: e.target.value })} placeholder="MH-01-AB-1234" /></div>
                <div><label className="text-xs font-bold text-slate-500">Driver Name</label><input className="w-full rounded border p-2" value={challanForm.driver_name} onChange={e => setChallanForm({ ...challanForm, driver_name: e.target.value })} /></div>
                <div><label className="text-xs font-bold text-slate-500">Driver Mobile</label><input className="w-full rounded border p-2" value={challanForm.driver_mobile} onChange={e => setChallanForm({ ...challanForm, driver_mobile: e.target.value })} /></div>
                <div><label className="text-xs font-bold text-slate-500">E-Way Bill No</label><input className="w-full rounded border p-2" value={challanForm.eway_bill} onChange={e => setChallanForm({ ...challanForm, eway_bill: e.target.value })} /></div>
                <div><label className="text-xs font-bold text-slate-500">Dispatch Address</label><input className="w-full rounded border p-2" value={challanForm.dispatch_address} onChange={e => setChallanForm({ ...challanForm, dispatch_address: e.target.value })} placeholder="Leave empty for Venue" /></div>
                <div><label className="text-xs font-bold text-slate-500">Challan Date</label><input type="date" className="w-full rounded border p-2" value={challanForm.date} onChange={e => setChallanForm({ ...challanForm, date: e.target.value })} /></div>
              </div>
              
              <div className="border-t pt-4">
                <h4 className="text-sm font-bold text-slate-700 mb-2">Select Items to Include</h4>
                <div className="border rounded overflow-hidden">
                    <table className="w-full text-xs text-left text-slate-600">
                        <thead className="bg-slate-50 text-slate-500"><tr><th className="p-2 w-8"></th><th className="p-2">Item</th><th className="p-2 text-center">Total</th><th className="p-2 text-center">{challanType === 'delivery' ? 'Sent' : 'Returned'}</th><th className="p-2 text-center">Avail</th><th className="p-2 w-20">Current</th></tr></thead>
                        <tbody className="divide-y divide-slate-100">
                            {(selectedProject.items || []).map(item => {
                                const excludeId = editingChallan ? editingChallan.id : null;
                                const alreadyChallaned = getChallanedQty(item.id, challanType, excludeId);
                                let maxQty = 0;
                                if (challanType === 'delivery') maxQty = item.qty - alreadyChallaned;
                                else {
                                    const delivered = getChallanedQty(item.id, 'delivery');
                                    const returned = getChallanedQty(item.id, 'return', excludeId);
                                    maxQty = delivered - returned;
                                }
                                return (
                                    <tr key={item.id} className={challanSelection[item.id] > 0 ? 'bg-indigo-50' : ''}>
                                        <td className="p-2"><input type="checkbox" checked={challanSelection[item.id] > 0} onChange={e => setChallanSelection({...challanSelection, [item.id]: e.target.checked ? maxQty : 0})} disabled={maxQty <= 0 && !challanSelection[item.id]} /></td>
                                        <td className="p-2">{item.item_name}</td>
                                        <td className="p-2 text-center">{item.qty}</td>
                                        <td className="p-2 text-center">{alreadyChallaned}</td>
                                        <td className="p-2 text-center font-bold">{maxQty}</td>
                                        <td className="p-2"><input type="number" min="0" max={maxQty} className="w-full border rounded p-1" value={challanSelection[item.id] || 0} onChange={e => setChallanSelection({...challanSelection, [item.id]: parseInt(e.target.value) || 0})} /></td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
              </div>

              <div className="flex gap-2">
                <button onClick={downloadEWayBillJSON} className="flex-1 rounded border border-indigo-600 text-indigo-600 py-2 font-bold hover:bg-indigo-50">Export E-Way JSON</button>
                <button onClick={() => {
                    const tempChallan = {
                        ...editingChallan,
                        challan_no: editingChallan ? editingChallan.challan_no : 'DRAFT',
                        type: challanType,
                        date: challanForm.date,
                        transport: challanForm,
                        items: (selectedProject.items || []).filter(item => (challanSelection[item.id] || 0) > 0).map(item => ({...item, qty: parseInt(challanSelection[item.id])}))
                    };
                    printChallanPDF(tempChallan);
                }} className="flex-1 rounded border border-slate-200 text-slate-700 py-2 font-bold hover:bg-slate-50">Preview / Print</button>
                <button onClick={handleSaveChallan} className="flex-1 rounded bg-indigo-600 py-2 text-white font-bold hover:bg-indigo-700">{editingChallan ? 'Update Challan' : 'Generate Challan'}</button>
              </div>
            </div>
        </Modal>
        <Modal isOpen={isChallanHistoryOpen} onClose={() => setIsChallanHistoryOpen(false)} title="Challan History">
            <div className="space-y-2">
                {(selectedProject.challans || []).length === 0 ? <div className="text-center text-slate-400 p-4">No challans generated yet.</div> : 
                (selectedProject.challans || []).sort((a,b) => new Date(b.date) - new Date(a.date)).map((c, idx) => (
                    <div key={idx} className="flex items-center justify-between p-3 border rounded hover:bg-slate-50">
                        <div>
                            <div className="font-bold text-slate-800">{c.type === 'return' ? 'Return' : 'Delivery'} Challan #{c.challan_no}</div>
                            <div className="text-xs text-slate-500">{new Date(c.date).toLocaleString()} | {c.items?.length || 0} items</div>
                        </div>
                        <div className="flex gap-2">
                            <button onClick={() => printChallanPDF(c)} className="text-indigo-600 hover:underline text-xs font-medium border border-indigo-200 px-2 py-1 rounded">Reprint</button>
                            <button onClick={() => openChallanModal(c.type, c)} className="text-blue-600 hover:underline text-xs font-medium border border-blue-200 px-2 py-1 rounded">Edit</button>
                            <button onClick={() => handleDeleteChallan(c)} className="text-red-600 hover:underline text-xs font-medium border border-red-200 px-2 py-1 rounded">Delete</button>
                        </div>
                    </div>
                ))}
            </div>
        </Modal>
        {/* ... (Keep existing Modals: Allocation, Employee) ... */}
        <Modal isOpen={isAllocationModalOpen} onClose={() => setIsAllocationModalOpen(false)} title="Allocate Equipment">
          <div className="space-y-4">
            <div><label className="block text-sm font-medium text-slate-700">Select Item</label><select className="w-full rounded border p-2" value={allocationForm.item_id} onChange={handleItemSelect}><option value="">-- Choose Equipment --</option>{inventory.map(item => (<option key={item.id} value={item.id}>{item.name}</option>))}</select>{allocationForm.item_id && (<div className={`mt-1 text-xs font-medium ${allocationForm.available_qty > 0 ? 'text-green-600' : 'text-red-600'}`}>Available for dates: {allocationForm.available_qty} units</div>)}</div>
            <div className="grid grid-cols-2 gap-4"><div><label className="block text-sm font-medium text-slate-700">Quantity</label><input type="number" min="1" className={`w-full rounded border p-2 ${allocationForm.qty > allocationForm.available_qty ? 'border-red-500 bg-red-50' : ''}`} value={allocationForm.qty} onChange={e => setAllocationForm({...allocationForm, qty: e.target.value})} />{allocationForm.qty > allocationForm.available_qty && (<div className="text-xs text-red-600 mt-1 flex items-center gap-1"><AlertCircle size={10} /> Overbooking warning</div>)}</div><div><label className="block text-sm font-medium text-slate-700">Days</label><input type="number" min="1" className="w-full rounded border p-2" value={allocationForm.days} onChange={e => setAllocationForm({...allocationForm, days: e.target.value})} /></div><div><label className="block text-sm font-medium text-slate-700">Rate / Day</label><input type="number" className="w-full rounded border p-2" value={allocationForm.rate} onChange={e => setAllocationForm({...allocationForm, rate: e.target.value})} /></div><div><label className="block text-sm font-medium text-slate-700">GST %</label><input type="number" disabled className="w-full rounded border p-2 bg-slate-50" value={allocationForm.gst_rate} /></div></div>
            <div><label className="block text-sm font-medium text-slate-700">Description / Remarks</label><input type="text" className="w-full rounded border p-2" placeholder="Optional notes..." value={allocationForm.description} onChange={e => setAllocationForm({...allocationForm, description: e.target.value})} /></div>
            <div className="rounded bg-slate-50 p-3 text-right space-y-1 text-sm"><div className="flex justify-between"><span>Subtotal:</span><span>{formatCurrency((allocationForm.qty || 0) * (allocationForm.rate || 0) * (allocationForm.days || 0))}</span></div><div className="flex justify-between font-bold text-lg text-slate-800 border-t pt-1 mt-1"><span>Total:</span><span>{formatCurrency(((allocationForm.qty || 0) * (allocationForm.rate || 0) * (allocationForm.days || 0)) * (1 + allocationForm.gst_rate/100))}</span></div></div>
            <div className="flex justify-end pt-2"><button onClick={handleSaveAllocation} className="rounded bg-indigo-600 px-6 py-2 text-white hover:bg-indigo-700">Add & Keep Open</button></div>
          </div>
        </Modal>
        <Modal isOpen={isEmpModalOpen} onClose={() => setIsEmpModalOpen(false)} title="Assign Team to Project">
            <div className="space-y-4"><div className="space-y-2 max-h-96 overflow-y-auto">{employees.map(emp => { const isAssigned = (selectedProject.assigned_employees || []).includes(emp.id); const isBusy = !isAssigned && isEmployeeBusy(emp.id); return (<div key={emp.id} className={`flex items-center justify-between p-3 rounded border cursor-pointer ${isAssigned ? 'bg-indigo-50 border-indigo-200' : isBusy ? 'bg-orange-50 border-orange-200' : 'bg-white hover:bg-slate-50'}`} onClick={() => toggleEmployee(emp.id)}><div className="flex items-center gap-3"><div className={`h-8 w-8 rounded-full flex items-center justify-center font-bold ${isBusy ? 'bg-orange-200 text-orange-700' : 'bg-slate-200 text-slate-600'}`}>{emp.name.charAt(0)}</div><div><div className="font-medium text-slate-800 flex items-center gap-2">{emp.name}{isBusy && <span className="text-[10px] bg-orange-100 text-orange-700 px-1 rounded border border-orange-200">Busy</span>}</div><div className="text-xs text-slate-500 capitalize">{emp.role}</div></div></div><div className={`h-5 w-5 rounded border flex items-center justify-center ${isAssigned ? 'bg-indigo-600 border-indigo-600 text-white' : 'border-slate-300'}`}>{isAssigned && <CheckCircle size={14} />}</div></div>); })}</div><div className="flex justify-end pt-2"><button onClick={() => setIsEmpModalOpen(false)} className="rounded bg-slate-50 px-6 py-2 text-white hover:bg-slate-50">Done</button></div></div>
        </Modal>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <h2 className="text-2xl font-bold text-slate-800 text-white">Projects</h2>
          {(role === 'manager' || role === 'admin') && (
            <button onClick={openCreate} className="flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-white hover:bg-indigo-700 whitespace-nowrap w-full md:w-auto">
                <Plus size={18} /> Create New Quote
            </button>
          )}
      </div>

      {/* --- Filter Bar with Invoice Status --- */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-2 bg-white p-3 rounded-lg border border-slate-200 shadow-sm bg-slate-50 border-slate-200">
         <div><label className="text-[10px] font-bold text-slate-700 uppercase">From Date</label><input type="date" className="w-full text-xs rounded border p-1 text-black bg-slate-50 border-slate-200 text-white" value={filters.startDate} onChange={e => setFilters({...filters, startDate: e.target.value})} /></div>
         <div><label className="text-[10px] font-bold text-slate-700 uppercase">To Date</label><input type="date" className="w-full text-xs rounded border p-1 text-black bg-slate-50 border-slate-200 text-white" value={filters.endDate} onChange={e => setFilters({...filters, endDate: e.target.value})} /></div>
         <div><label className="text-[10px] font-bold text-slate-700 uppercase">Setup Date {'>='}</label><input type="date" className="w-full text-xs rounded border p-1 text-black bg-slate-50 border-slate-200 text-white" value={filters.setupDate} onChange={e => setFilters({...filters, setupDate: e.target.value})} /></div>
         <div>
            <label className="text-[10px] font-bold text-slate-700 uppercase">Client</label>
            <select className="w-full text-xs rounded border p-1 text-black bg-slate-50 border-slate-200 text-white" value={filters.clientId} onChange={e => setFilters({...filters, clientId: e.target.value})}>
                <option value="">All Clients</option>
                {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
         </div>
         <div>
            <label className="text-[10px] font-bold text-slate-700 uppercase">Status</label>
            <select className="w-full text-xs rounded border p-1 text-black bg-slate-50 border-slate-200 text-white" value={filters.status} onChange={e => setFilters({...filters, status: e.target.value})}>
                <option value="">All Status</option>
                <option value="Quoted">Quoted</option>
                <option value="Confirmed">Confirmed</option>
                <option value="Ongoing">Ongoing</option>
                <option value="Completed">Completed</option>
                <option value="Closed">Closed</option>
            </select>
         </div>
         <div>
            <label className="text-[10px] font-bold text-slate-700 uppercase">Invoice</label>
            <select className="w-full text-xs rounded border p-1 text-black bg-slate-50 border-slate-200 text-white" value={filters.invoiceStatus} onChange={e => setFilters({...filters, invoiceStatus: e.target.value})}>
                <option value="">All</option>
                <option value="Not Invoiced">Not Invoiced</option>
                <option value="Invoiced">Invoiced</option>
            </select>
         </div>
      </div>

      <div className="space-y-3">
        {paginatedProjects.length === 0 ? <div className="text-center text-slate-400 py-10">No projects match your filters.</div> : 
        paginatedProjects.map(project => (
          <div key={project.id} onClick={() => setSelectedProjectId(project.id)} className="cursor-pointer rounded-xl border border-slate-200 bg-white p-4 transition hover:shadow-md group relative bg-slate-50 border-slate-200">
            <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
              <div>
                <div className="flex items-center gap-2">
                    <div className="font-bold text-slate-800 text-slate-200">{project.project_name}</div>
                    {project.invoice_status === 'Invoiced' && <span className="text-[10px] bg-green-100 text-green-700 px-1 rounded border border-green-200" title={`Inv#: ${project.invoice_no}`}>INV</span>}
                </div>
                <div className="text-sm text-slate-500">{clients.find(c=>c.id === project.client_id)?.name || 'Unknown Client'}</div>
                {project.setup_date && <div className="text-xs text-indigo-600 mt-1">Setup: {project.setup_date}</div>}
              </div>
              <div className="flex items-center gap-4">
                <div className="text-right text-sm">
                  <div className="text-white text-slate-300">{project.start_date}</div>
                  <div className="text-slate-400">{project.venue}</div>
                </div>
                <span className={`px-2 py-1 text-xs rounded border ${STATUS_COLORS[project.status]}`}>{project.status}</span>
              </div>
            </div>
            {(role==='admin'||role==='manager') && (
              <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button onClick={(e)=>{e.stopPropagation();openEdit(project)}} className="p-1 text-blue-600 bg-blue-50 rounded hover:bg-blue-100"><Edit size={14}/></button>
                <button onClick={(e)=>{e.stopPropagation();handleDuplicate(project)}} className="p-1 text-indigo-600 bg-indigo-50 rounded hover:bg-indigo-100" title="Duplicate Project"><Copy size={14}/></button>
                <button onClick={(e)=>{e.stopPropagation();handleDelete(project.id)}} className="p-1 text-red-600 bg-red-50 rounded hover:bg-red-100"><Trash2 size={14}/></button>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Pagination Controls */}
      {filteredProjects.length > 0 && (
        <div className="flex items-center justify-between p-4 border-t bg-white rounded-lg border border-slate-200 shadow-sm bg-slate-50 border-slate-200">
            <div className="text-sm text-slate-500 text-slate-400">
                Showing {Math.min((currentPage - 1) * itemsPerPage + 1, filteredProjects.length)} to {Math.min(currentPage * itemsPerPage, filteredProjects.length)} of {filteredProjects.length} results
            </div>
            <div className="flex gap-2">
                <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1} className="px-3 py-1 rounded border bg-white hover:bg-slate-50 disabled:opacity-50 text-sm bg-slate-50 border-slate-200 text-white hover:bg-slate-50">Previous</button>
                <button onClick={() => setCurrentPage(p => Math.min(Math.ceil(filteredProjects.length / itemsPerPage), p + 1))} disabled={currentPage === Math.ceil(filteredProjects.length / itemsPerPage)} className="px-3 py-1 rounded border bg-white hover:bg-slate-50 disabled:opacity-50 text-sm bg-slate-50 border-slate-200 text-white hover:bg-slate-50">Next</button>
            </div>
        </div>
      )}

      <Modal isOpen={isCreateOpen} onClose={() => setIsCreateOpen(false)} title={editingId ? "Edit Project" : "Create New Quote"}>
        <div className="space-y-3">
          <div><label className="text-sm font-bold text-slate-800">Project Name</label><input className="w-full rounded border p-2 text-black" value={newProj.project_name} onChange={e => setNewProj({...newProj, project_name: e.target.value})} /></div>
          <div><label className="text-sm font-bold text-slate-800">Client</label><select className="w-full rounded border p-2 text-black" value={newProj.client_id} onChange={e => setNewProj({...newProj, client_id: e.target.value})}><option value="">Select Client</option>{clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
          <div className="grid grid-cols-3 gap-2">
              <div><label className="text-sm font-bold text-slate-800">Setup Date</label><input type="date" className="w-full rounded border p-2 text-black" value={newProj.setup_date} onChange={e => setNewProj({...newProj, setup_date: e.target.value})} /></div>
              <div><label className="text-sm font-bold text-slate-800">Start Date</label><input type="date" className="w-full rounded border p-2 text-black" value={newProj.start_date} onChange={e => setNewProj({...newProj, start_date: e.target.value})} /></div>
              <div><label className="text-sm font-bold text-slate-800">End Date</label><input type="date" className="w-full rounded border p-2 text-black" value={newProj.end_date} onChange={e => setNewProj({...newProj, end_date: e.target.value})} /></div>
          </div>
          <div><label className="text-sm font-bold text-slate-800">Venue</label><input className="w-full rounded border p-2 text-black" value={newProj.venue} onChange={e => setNewProj({...newProj, venue: e.target.value})} /></div>
          <button onClick={handleSaveProject} className="w-full rounded bg-indigo-600 py-2 text-white mt-4">{editingId ? 'Update Project' : 'Create Quote'}</button>
        </div>
      </Modal>
    </div>
  );
};

// version 1.3.0 finance implementation

const Finance = ({ clients, employees, projects, payments, payouts, expenses, advances, role, db, appId, user, logAction }) => {
  const [activeTab, setActiveTab] = useState('client_in'); // 'client_in' or 'emp_out'
  const [form, setForm] = useState({ 
    entity_id: '', amount: '', date: new Date().toISOString().split('T')[0], 
    mode: 'Bank Transfer', reference: '', remarks: '', project_id: '' 
  });

  // --- Client Payment Logic ---
  const handleClientPayment = async () => {
    if (!form.entity_id || !form.amount) return alert("Select Client and Amount");
    const client = clients.find(c => c.id === form.entity_id);
    
    const docRef = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'payments'), {
      client_id: client.id,
      client_name: client.name,
      project_id: form.project_id || 'general', // General or Specific Project
      amount: parseFloat(form.amount),
      date: form.date,
      mode: form.mode,
      reference: form.reference,
      remarks: form.remarks,
      created_at: new Date().toISOString(),
      created_by: user.uid
    });
    logAction('payments', 'receive_payment', docRef.id, { amount: form.amount, client: client.name }, `Payment from ${client.name}`);
    alert("Payment Received Recorded");
    setForm({ ...form, amount: '', reference: '', remarks: '' });
  };

  // --- Employee Payout Logic ---
  const handleEmpPayout = async () => {
    if (!form.entity_id || !form.amount) return alert("Select Employee and Amount");
    const emp = employees.find(e => e.id === form.entity_id);

    const docRef = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'payouts'), {
      employee_id: emp.id,
      employee_name: emp.name,
      amount: parseFloat(form.amount),
      date: form.date,
      mode: form.mode,
      reference: form.reference,
      remarks: form.remarks,
      created_at: new Date().toISOString(),
      created_by: user.uid
    });
    logAction('payouts', 'make_payout', docRef.id, { amount: form.amount, employee: emp.name }, `Payout to ${emp.name}`);
    alert("Employee Payout Recorded");
    setForm({ ...form, amount: '', reference: '', remarks: '' });
  };

  // --- Calc Emp Balance ---
  const getEmpBalance = (empId) => {
    const myExpenses = expenses.filter(e => e.employee_id === empId && e.status !== 'Rejected').reduce((s, e) => s + parseFloat(e.amount), 0);
    const myAdvances = advances.filter(a => a.employee_id === empId).reduce((s, a) => s + parseFloat(a.amount), 0);
    const myPayouts = payouts.filter(p => p.employee_id === empId).reduce((s, p) => s + parseFloat(p.amount), 0);
    return myAdvances + myPayouts - myExpenses; // Positive = Employee owes company (Advance), Negative = Company owes Employee
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <h2 className="text-2xl font-bold text-slate-800 text-white">Finance & Payments</h2>
        <div className="flex bg-white rounded-lg border p-1">
          <button onClick={() => {setActiveTab('client_in'); setForm({...form, entity_id: ''})}} className={`px-4 py-2 text-sm rounded-md font-medium transition-colors flex-1 ${activeTab === 'client_in' ? 'bg-green-100 text-green-700' : 'text-slate-600 hover:bg-slate-50'}`}>Receive Payment (In)</button>
          <button onClick={() => {setActiveTab('emp_out'); setForm({...form, entity_id: ''})}} className={`px-4 py-2 text-sm rounded-md font-medium transition-colors flex-1 ${activeTab === 'emp_out' ? 'bg-red-100 text-red-700' : 'text-slate-600 hover:bg-slate-50'}`}>Make Payout (Out)</button>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-12">
        {/* --- FORM SECTION --- */}
        <div className="md:col-span-4 space-y-4">
          <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
            <h3 className={`font-bold text-lg mb-4 flex items-center gap-2 ${activeTab === 'client_in' ? 'text-green-700' : 'text-red-700'}`}>
              {activeTab === 'client_in' ? <TrendingUp /> : <TrendingDown />}
              {activeTab === 'client_in' ? 'Record Incoming Payment' : 'Record Employee Payout'}
            </h3>
            
            <div className="space-y-3">
              <div>
                <label className="text-xs font-bold text-slate-700 uppercase">{activeTab === 'client_in' ? 'Received From Client' : 'Pay To Employee'}</label>
                <select className="w-full rounded border p-2 bg-slate-50 text-black" value={form.entity_id} onChange={e => setForm({...form, entity_id: e.target.value})}>
                  <option value="">-- Select --</option>
                  {activeTab === 'client_in' 
                    ? clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)
                    : employees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)
                  }
                </select>
              </div>

              {/* Show Balance Context */}
              {form.entity_id && activeTab === 'emp_out' && (
                <div className={`p-2 rounded text-xs font-bold border ${getEmpBalance(form.entity_id) < 0 ? 'bg-red-50 border-red-200 text-red-700' : 'bg-green-50 border-green-200 text-green-700'}`}>
                  Current Balance: {formatCurrency(Math.abs(getEmpBalance(form.entity_id)))} 
                  {getEmpBalance(form.entity_id) < 0 ? ' (Company owes Employee)' : ' (Employee has Advance)'}
                </div>
              )}

              {activeTab === 'client_in' && (
                <div>
                   <label className="text-xs font-bold text-slate-700 uppercase">Against Project (Optional)</label>
                   <select className="w-full rounded border p-2 text-black" value={form.project_id} onChange={e => setForm({...form, project_id: e.target.value})}>
                      <option value="">General Payment (On Account)</option>
                      {projects.filter(p => p.client_id === form.entity_id).map(p => (
                        <option key={p.id} value={p.id}>{p.project_name} ({p.status})</option>
                      ))}
                   </select>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-bold text-slate-700 uppercase">Amount</label>
                  <input type="number" className="w-full rounded border p-2 text-black" value={form.amount} onChange={e => setForm({...form, amount: e.target.value})} />
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-700 uppercase">Date</label>
                  <input type="date" className="w-full rounded border p-2 text-black" value={form.date} onChange={e => setForm({...form, date: e.target.value})} />
                </div>
              </div>

              <div>
                <label className="text-xs font-bold text-slate-700 uppercase">Payment Mode</label>
                <select className="w-full rounded border p-2 text-black" value={form.mode} onChange={e => setForm({...form, mode: e.target.value})}>
                  <option>Bank Transfer</option><option>Cash</option><option>Cheque</option><option>UPI / Online</option>
                </select>
              </div>

              <div>
                <label className="text-xs font-bold text-slate-700 uppercase">Reference / Trx ID</label>
                <input type="text" className="w-full rounded border p-2 text-black" value={form.reference} onChange={e => setForm({...form, reference: e.target.value})} />
              </div>
              
              <div>
                <label className="text-xs font-bold text-slate-700 uppercase">Remarks</label>
                <textarea className="w-full rounded border p-2 text-sm text-black" rows={2} value={form.remarks} onChange={e => setForm({...form, remarks: e.target.value})} />
              </div>

              <button 
                onClick={activeTab === 'client_in' ? handleClientPayment : handleEmpPayout}
                className={`w-full py-3 rounded text-white font-bold shadow-sm ${activeTab === 'client_in' ? 'bg-green-600 hover:bg-green-700' : 'bg-red-600 hover:bg-red-700'}`}
              >
                {activeTab === 'client_in' ? 'Receive Payment' : 'Process Payout'}
              </button>
            </div>
          </div>
        </div>

        {/* --- LIST SECTION --- */}
        <div className="md:col-span-8">
           <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
             <div className="p-4 border-b bg-slate-50 font-bold text-slate-700">
               Recent {activeTab === 'client_in' ? 'Client Payments' : 'Employee Payouts'}
             </div>
             <div className="overflow-x-auto">
               <table className="w-full text-left text-sm">
                 <thead className="bg-white text-slate-700 font-semibold border-b">
                   <tr>
                     <th className="p-3">Date</th>
                     <th className="p-3">Name</th>
                     <th className="p-3">{activeTab === 'client_in' ? 'Project' : 'Mode'}</th>
                     <th className="p-3">Reference</th>
                     <th className="p-3 text-right">Amount</th>
                   </tr>
                 </thead>
                 <tbody className="divide-y divide-slate-50">
                   {(activeTab === 'client_in' ? payments : payouts)
                      .sort((a,b) => new Date(b.date) - new Date(a.date))
                      .slice(0, 20) // Show last 20
                      .map(item => (
                     <tr key={item.id} className="hover:bg-slate-50">
                       <td className="p-3">{item.date}</td>
                       <td className="p-3 font-medium text-slate-800">{item.client_name || item.employee_name}</td>
                       <td className="p-3 text-slate-500">
                         {activeTab === 'client_in' 
                           ? (item.project_id === 'general' || !item.project_id ? 'General Account' : projects.find(p=>p.id===item.project_id)?.project_name) 
                           : item.mode
                         }
                       </td>
                       <td className="p-3 text-slate-500 text-xs">{item.reference || '-'}</td>
                       <td className={`p-3 text-right font-bold ${activeTab === 'client_in' ? 'text-green-600' : 'text-red-600'}`}>
                         {formatCurrency(item.amount)}
                       </td>
                     </tr>
                   ))}
                 </tbody>
               </table>
               {(activeTab === 'client_in' ? payments : payouts).length === 0 && (
                 <div className="p-8 text-center text-slate-400">No records found.</div>
               )}
             </div>
           </div>
        </div>
      </div>
    </div>
  );
};

// version 1.3.0 finance implementation

const Inventory = ({ inventory, clients, role, db, appId, logAction }) => { // version 3.3.0 vendors database addition: added clients prop
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterCategory, setFilterCategory] = useState('All');
  const [activeTab, setActiveTab] = useState('general');
  const [compForm, setCompForm] = useState({ item_id: '', qty: 1 });

  const initialForm = {
    // General
    asset_id: '', name: '', brand: '', category: '', sub_category: '', 
    serial_number: '', status: 'Available', location: '', total: 0,
    is_composite: false, composition: [],
    vendor_id: '', // version 3.3.0 vendors database addition
    // Commercial
    purchase_date: '', purchase_cost: '', rate_per_day: 0, rate_per_week: 0,
    replacement_value: '', supplier: '',
    // Logistics
    weight: '', dimensions: '', power_watts: '', current_amps: '', 
    connector_type: '', ip_rating: '',
    // Specs (Attributes)
    attributes: {},
    // Maintenance
    last_service_date: '', next_test_due: '', service_notes: '',
    // Misc
    gst_rate: 18, is_external: false, hsn_code: '', remarks: '', specifications: ''
  };

  const [formData, setFormData] = useState(initialForm);

  const openAdd = () => { setEditingId(null); setFormData(initialForm); setActiveTab('general'); setIsModalOpen(true); };
  
  const openEdit = (item) => { 
    setEditingId(item.id); 
    setFormData({ ...initialForm, ...item, attributes: item.attributes || {} }); 
    setActiveTab('general');
    setIsModalOpen(true); 
  };

  const handleDelete = async (id) => { 
    if (confirm('Delete item?')) {
        const itemName = inventory.find(i => i.id === id)?.name;
        await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'inventory', id)); 
        logAction('inventory', 'delete', id, {}, itemName);
    }
  };
  
  const handleSave = async () => {
    const itemData = {
      ...formData,
      total: parseInt(formData.total) || 0,
      rate_per_day: parseFloat(formData.rate_per_day) || 0,
      rate_per_week: parseFloat(formData.rate_per_week) || 0,
      purchase_cost: parseFloat(formData.purchase_cost) || 0,
      replacement_value: parseFloat(formData.replacement_value) || 0,
      weight: parseFloat(formData.weight) || 0,
      power_watts: parseFloat(formData.power_watts) || 0,
      current_amps: parseFloat(formData.current_amps) || 0,
      gst_rate: parseFloat(formData.gst_rate) || 18,
      is_composite: formData.is_composite || false,
      composition: formData.composition || [],
      vendor_id: formData.vendor_id || '', // version 3.3.0 vendors database addition
      updated_at: new Date().toISOString()
    };

    if (editingId) {
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'inventory', editingId), itemData);
      logAction('inventory', 'update', editingId, itemData, formData.name);
    } else {
      const docRef = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'inventory'), { ...itemData, gst_history: [], created_at: new Date().toISOString() });
      logAction('inventory', 'create', docRef.id, itemData, formData.name);
    }
    setIsModalOpen(false);
  };

  const addComponent = () => {
      if (!compForm.item_id || !compForm.qty) return;
      if (compForm.item_id === editingId) return alert("Cannot add self as component");
      if (formData.composition && formData.composition.some(c => c.item_id === compForm.item_id)) return alert("Item already in composition");
      
      setFormData({
          ...formData,
          composition: [...(formData.composition || []), { item_id: compForm.item_id, qty: parseInt(compForm.qty) }]
      });
      setCompForm({ item_id: '', qty: 1 });
  };

  const removeComponent = (index) => {
      const newComp = [...(formData.composition || [])];
      newComp.splice(index, 1);
      setFormData({ ...formData, composition: newComp });
  };

  const updateAttribute = (key, value) => {
    setFormData(prev => ({ ...prev, attributes: { ...prev.attributes, [key]: value } }));
  };

  const filteredInventory = inventory.filter(item => 
    (item.name.toLowerCase().includes(searchTerm.toLowerCase()) || 
     (item.brand && item.brand.toLowerCase().includes(searchTerm.toLowerCase())) ||
     (item.asset_id && item.asset_id.toLowerCase().includes(searchTerm.toLowerCase()))) && 
    (filterCategory === 'All' || item.category === filterCategory)
  );

  const renderField = (label, key, type='text', placeholder='') => (
    <div>
      <label className="block text-xs font-bold text-white mb-1">{label}</label>
      <input 
        type={type} 
        className="w-full rounded border border-slate-300 p-2 text-sm text-white" 
        placeholder={placeholder}
        value={formData[key]} 
        onChange={e => setFormData({...formData, [key]: e.target.value})} 
      />
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <h2 className="text-2xl font-bold text-slate-800">Inventory Manager</h2>
        <div className="flex gap-2 w-full md:w-auto">
          <div className="flex items-center rounded border px-3 py-1 bg-white flex-1 bg-slate-50 border-slate-200">
            <Search size={16} className="text-slate-400 mr-2" />
            <input placeholder="Search name, brand, tag..." className="text-sm outline-none text-black bg-transparent text-white" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
          </div>
          <select className="rounded border px-3 py-1 bg-white text-sm outline-none flex-1 md:flex-none bg-slate-50 border-slate-200 text-white" value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}>
            <option value="All">All Categories</option>
            {CATEGORIES.map(cat => <option key={cat} value={cat}>{cat}</option>)}
          </select>
          {role === 'admin' && (
            <button onClick={openAdd} className="flex items-center justify-center gap-2 rounded bg-indigo-600 px-3 py-1 text-white text-sm hover:bg-indigo-700 whitespace-nowrap flex-1 md:flex-none">
              <Plus size={16} /> Add Item
            </button>
          )}
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-slate-700 font-semibold">
            <tr>
              <th className="p-4 font-medium">Asset / Model</th>
              <th className="p-4 font-medium hidden md:table-cell">Brand</th>
              <th className="p-4 font-medium hidden md:table-cell">Category</th>
              {role !== 'tech' && <th className="p-4 font-medium text-right">Rate/Day</th>}
              <th className="p-4 font-medium text-center">Qty</th>
              <th className="p-4 font-medium hidden md:table-cell">Loc</th>
              {role === 'admin' && <th className="p-4 font-medium text-center">Actions</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filteredInventory.map((item, idx) => (
              <tr key={idx} className="hover:bg-slate-50 group">
                <td className="p-4 font-medium text-slate-800">
                  <div className="flex flex-col">
                    <span className="flex items-center gap-2">
                      {item.name}
                      {item.is_composite && <span className="rounded bg-indigo-100 px-2 py-0.5 text-xs text-indigo-700 border border-indigo-200">Kit</span>}
                      {item.is_external && <span className="rounded bg-purple-100 px-2 py-0.5 text-xs text-purple-700 border border-purple-200">Ext</span>}
                    </span>
                    {item.asset_id && <span className="text-xs text-slate-400 font-mono">ID: {item.asset_id}</span>}
                    {/* version 3.3.0 vendors database addition: Show vendor name */}
                    {item.is_external && item.vendor_id && (
                        <span className="text-[10px] text-slate-500">via {clients.find(c => c.id === item.vendor_id)?.name}</span>
                    )}
                  </div>
                </td>
                <td className="p-4 text-slate-500 hidden md:table-cell">{item.brand || '-'}</td>
                <td className="p-4 text-slate-500 hidden md:table-cell">{item.category}</td>
                {role !== 'tech' && <td className="p-4 text-right text-slate-800 font-mono">{formatCurrency(item.rate_per_day || 0)}</td>}
                <td className="p-4 text-center text-slate-800">
                    <span className={`px-2 py-1 rounded text-xs font-bold ${item.total > 0 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                        {item.total}
                    </span>
                </td>
                <td className="p-4 text-slate-500 hidden md:table-cell">{item.location}</td>
                {role === 'admin' && (
                  <td className="p-4 text-center">
                    <div className="flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button onClick={() => openEdit(item)} className="rounded p-1 text-blue-600 hover:bg-blue-50"><Edit size={16} /></button>
                      <button onClick={() => handleDelete(item.id)} className="rounded p-1 text-red-600 hover:bg-red-50"><Trash2 size={16} /></button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title={editingId ? "Edit Inventory Item" : "Add Inventory Item"}>
        <div className="flex flex-col h-[70vh]">
            {/* Tabs */}
            <div className="flex border-b mb-4 overflow-x-auto">
                {[
                    { id: 'general', label: 'General', icon: Box },
                    { id: 'composition', label: 'Composition', icon: Layers },
                    (role !== 'tech' ? { id: 'commercial', label: 'Commercial', icon: DollarSign } : null),
                    { id: 'logistics', label: 'Logistics', icon: Truck },
                    { id: 'specs', label: 'Tech Specs', icon: Settings },
                    { id: 'maintenance', label: 'Maintenance', icon: Hammer },
                ].map(tab => (
                    <button 
                        key={tab.id}
                        onClick={() => setActiveTab(tab.id)}
                        className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${activeTab === tab.id ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
                    >
                        <tab.icon size={16} /> {tab.label}
                    </button>
                ))}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto pr-2 space-y-4">
                {activeTab === 'general' && (
                    <div className="space-y-4">
                        <div className="grid grid-cols-2 gap-4">
                            {renderField('Asset ID / Barcode', 'asset_id', 'text', 'Scan Code')}
                            {renderField('Serial Number', 'serial_number')}
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            {renderField('Item Name / Model', 'name')}
                            {renderField('Brand / Manufacturer', 'brand')}
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="block text-xs font-bold text-slate-700 mb-1">Category</label>
                                <input className="w-full rounded border p-2 text-sm text-black bg-slate-50 border-slate-200 text-white" value={formData.category} onChange={e => setFormData({...formData, category: e.target.value})} list="categories" />
                                <datalist id="categories">{CATEGORIES.map(cat => <option key={cat} value={cat} />)}</datalist>
                            </div>
                            {renderField('Sub-Category', 'sub_category')}
                        </div>
                        <div className="grid grid-cols-3 gap-4">
                            {renderField('Total Qty', 'total', 'number')}
                            {renderField('Location', 'location')}
                            <div>
                                <label className="block text-xs font-bold text-white mb-1">Status</label>
                                <select className="w-full rounded border border-slate-300 p-2 text-sm text-white" value={formData.status} onChange={e => setFormData({...formData, status: e.target.value})}>
                                    <option>Available</option><option>Rented</option><option>In Repair</option><option>Lost/Stolen</option><option>Retired</option>
                                </select>
                            </div>
                        </div>
                        <div className="flex items-center gap-2 mt-2 p-3 bg-slate-50 rounded border border-slate-200">
                            <input type="checkbox" checked={formData.is_external} onChange={e => setFormData({...formData, is_external: e.target.checked})} />
                            <label className="text-sm font-bold text-white">Is External / Cross-Hired Item</label>
                        </div>
                        {/* version 3.3.0 vendors database addition: Vendor Selection */}
                        {formData.is_external && (
                            <div className="mt-2 pl-3 border-l-2 border-purple-200">
                                <label className="block text-xs font-bold text-white mb-1">Select Vendor (Owner)</label>
                                <select 
                                    className="w-full rounded border border-slate-300 p-2 text-sm text-white" 
                                    value={formData.vendor_id} 
                                    onChange={e => setFormData({...formData, vendor_id: e.target.value})}
                                >
                                    <option value="">-- Generic / Unknown --</option>
                                    {clients.filter(c => c.type === 'Vendor' || c.type === 'Both').map(v => (
                                        <option key={v.id} value={v.id}>{v.name}</option>
                                    ))}
                                </select>
                            </div>
                        )}
                    </div>
                )}

                {activeTab === 'composition' && (
                    <div className="space-y-4">
                        <div className="flex items-center gap-2 p-3 bg-slate-50 rounded border border-slate-200">
                            <input type="checkbox" checked={formData.is_composite} onChange={e => setFormData({...formData, is_composite: e.target.checked})} />
                            <label className="text-sm font-bold text-white">Is Composite Item (Kit/Bundle)</label>
                        </div>
                        {formData.is_composite && (
                            <div className="border rounded p-3">
                                <h4 className="text-xs font-bold text-slate-500 uppercase mb-2">Components</h4>
                                <div className="space-y-2 mb-3">
                                    {(formData.composition || []).map((comp, idx) => {
                                        const compItem = inventory.find(i => i.id === comp.item_id);
                                        return (
                                            <div key={idx} className="flex justify-between items-center bg-slate-50 p-2 rounded border border-slate-200">
                                                <div className="text-sm">
                                                    <span className="font-bold text-white">{compItem?.name || 'Unknown'}</span>
                                                    <span className="text-slate-500 mx-2">x</span>
                                                    <span className="font-bold">{comp.qty}</span>
                                                </div>
                                                <button onClick={() => removeComponent(idx)} className="text-red-500 hover:text-red-700"><Trash2 size={14}/></button>
                                            </div>
                                        );
                                    })}
                                    {(formData.composition || []).length === 0 && <div className="text-sm text-slate-400 italic">No components added.</div>}
                                </div>
                                <div className="flex gap-2 items-end border-t pt-3">
                                    <div className="flex-1">
                                        <label className="text-xs font-bold text-white">Add Item</label>
                                        <select className="w-full rounded border border-slate-300 p-1.5 text-sm text-white" value={compForm.item_id} onChange={e => setCompForm({...compForm, item_id: e.target.value})}>
                                            <option value="">-- Select --</option>
                                            {inventory.filter(i => i.id !== editingId && !i.is_composite).map(i => (
                                                <option key={i.id} value={i.id}>{i.name}</option>
                                            ))}
                                        </select>
                                    </div>
                                    <div className="w-20">
                                        <label className="text-xs font-bold text-white">Qty</label>
                                        <input type="number" className="w-full rounded border border-slate-300 p-1.5 text-sm text-white" value={compForm.qty} onChange={e => setCompForm({...compForm, qty: e.target.value})} />
                                    </div>
                                    <button onClick={addComponent} className="bg-indigo-600 text-white px-3 py-1.5 rounded text-sm hover:bg-indigo-700">Add</button>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {activeTab === 'commercial' && (
                    <div className="space-y-4">
                        <div className="grid grid-cols-2 gap-4">
                            {renderField('Daily Rate', 'rate_per_day', 'number')}
                            {renderField('Weekly Rate', 'rate_per_week', 'number')}
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            {renderField('Purchase Cost', 'purchase_cost', 'number')}
                            {renderField('Purchase Date', 'purchase_date', 'date')}
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            {renderField('Replacement Value', 'replacement_value', 'number')}
                            {renderField('Supplier / Vendor', 'supplier')}
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            {renderField('GST Rate %', 'gst_rate', 'number')}
                            {renderField('HSN Code', 'hsn_code')}
                        </div>
                    </div>
                )}

                {activeTab === 'logistics' && (
                    <div className="space-y-4">
                        <div className="grid grid-cols-2 gap-4">
                            {renderField('Weight (kg)', 'weight', 'number')}
                            {renderField('Dimensions (LxWxH)', 'dimensions')}
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            {renderField('Power (Watts)', 'power_watts', 'number')}
                            {renderField('Current (Amps)', 'current_amps', 'number')}
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            {renderField('Connector Type', 'connector_type')}
                            {renderField('IP Rating', 'ip_rating')}
                        </div>
                    </div>
                )}

                {activeTab === 'specs' && (
                    <div className="space-y-4">
                        <div className="bg-blue-50 p-3 rounded text-xs text-blue-700 mb-2">
                            Specific attributes for <strong>{formData.category || 'General'}</strong> items.
                        </div>
                        
                        {/* Audio Fields */}
                        {(formData.category === 'Sound' || formData.category === 'Audio') && (
                            <div className="grid grid-cols-2 gap-4">
                                <div><label className="text-xs font-bold text-white">Signal Type</label><input className="w-full border border-slate-300 rounded p-2 text-sm text-white" value={formData.attributes.signal_type || ''} onChange={e => updateAttribute('signal_type', e.target.value)} placeholder="Analog, Dante..." /></div>
                                <div><label className="text-xs font-bold text-white">Wireless Freq</label><input className="w-full border border-slate-300 rounded p-2 text-sm text-white" value={formData.attributes.frequency || ''} onChange={e => updateAttribute('frequency', e.target.value)} placeholder="470-530 MHz" /></div>
                                <div><label className="text-xs font-bold text-white">Channels</label><input className="w-full border border-slate-300 rounded p-2 text-sm text-white" value={formData.attributes.channels || ''} onChange={e => updateAttribute('channels', e.target.value)} /></div>
                                <div><label className="text-xs font-bold text-white">Mic Pattern</label><input className="w-full border border-slate-300 rounded p-2 text-sm text-white" value={formData.attributes.pattern || ''} onChange={e => updateAttribute('pattern', e.target.value)} /></div>
                            </div>
                        )}

                        {/* Video Fields */}
                        {['Video', 'Projectors', 'LED', 'Camera'].includes(formData.category) && (
                            <div className="grid grid-cols-2 gap-4">
                                <div><label className="text-xs font-bold text-white">Resolution</label><input className="w-full border border-slate-300 rounded p-2 text-sm text-white" value={formData.attributes.resolution || ''} onChange={e => updateAttribute('resolution', e.target.value)} placeholder="1080p, 4K..." /></div>
                                <div><label className="text-xs font-bold text-white">Lumens / Brightness</label><input className="w-full border border-slate-300 rounded p-2 text-sm text-white" value={formData.attributes.lumens || ''} onChange={e => updateAttribute('lumens', e.target.value)} /></div>
                                <div><label className="text-xs font-bold text-white">Inputs</label><input className="w-full border border-slate-300 rounded p-2 text-sm text-white" value={formData.attributes.inputs || ''} onChange={e => updateAttribute('inputs', e.target.value)} placeholder="HDMI, SDI..." /></div>
                                <div><label className="text-xs font-bold text-white">Throw Ratio / Pitch</label><input className="w-full border border-slate-300 rounded p-2 text-sm text-white" value={formData.attributes.ratio || ''} onChange={e => updateAttribute('ratio', e.target.value)} /></div>
                            </div>
                        )}

                        {/* Lighting Fields */}
                        {formData.category === 'Lighting' && (
                            <div className="grid grid-cols-2 gap-4">
                                <div><label className="text-xs font-bold text-white">Fixture Type</label><input className="w-full border border-slate-300 rounded p-2 text-sm text-white" value={formData.attributes.fixture_type || ''} onChange={e => updateAttribute('fixture_type', e.target.value)} placeholder="Spot, Wash..." /></div>
                                <div><label className="text-xs font-bold text-white">DMX Mode</label><input className="w-full border border-slate-300 rounded p-2 text-sm text-white" value={formData.attributes.dmx_mode || ''} onChange={e => updateAttribute('dmx_mode', e.target.value)} /></div>
                                <div><label className="text-xs font-bold text-white">Lamp Type</label><input className="w-full border border-slate-300 rounded p-2 text-sm text-white" value={formData.attributes.lamp_type || ''} onChange={e => updateAttribute('lamp_type', e.target.value)} /></div>
                                <div><label className="text-xs font-bold text-white">Beam Angle</label><input className="w-full border border-slate-300 rounded p-2 text-sm text-white" value={formData.attributes.beam_angle || ''} onChange={e => updateAttribute('beam_angle', e.target.value)} /></div>
                            </div>
                        )}

                        {/* Rigging Fields */}
                        {['Trussing', 'Rigging'].includes(formData.category) && (
                            <div className="grid grid-cols-2 gap-4">
                                <div><label className="text-xs font-bold text-white">Truss Type</label><input className="w-full border border-slate-300 rounded p-2 text-sm text-white" value={formData.attributes.truss_type || ''} onChange={e => updateAttribute('truss_type', e.target.value)} placeholder="Box, Triangle..." /></div>
                                <div><label className="text-xs font-bold text-white">Length</label><input className="w-full border border-slate-300 rounded p-2 text-sm text-white" value={formData.attributes.length || ''} onChange={e => updateAttribute('length', e.target.value)} /></div>
                                <div><label className="text-xs font-bold text-white">Connection</label><input className="w-full border border-slate-300 rounded p-2 text-sm text-white" value={formData.attributes.connection || ''} onChange={e => updateAttribute('connection', e.target.value)} placeholder="Spigot, Bolt..." /></div>
                                <div><label className="text-xs font-bold text-white">Load Capacity</label><input className="w-full border border-slate-300 rounded p-2 text-sm text-white" value={formData.attributes.load_capacity || ''} onChange={e => updateAttribute('load_capacity', e.target.value)} /></div>
                            </div>
                        )}

                        <div className="mt-4">
                            <label className="block text-xs font-bold text-white mb-1">Other Specifications</label>
                            <textarea className="w-full rounded border border-slate-300 p-2 text-sm text-white" rows={3} value={formData.specifications} onChange={e => setFormData({...formData, specifications: e.target.value})} />
                        </div>
                    </div>
                )}

                {activeTab === 'maintenance' && (
                    <div className="space-y-4">
                        <div className="grid grid-cols-2 gap-4">
                            {renderField('Last Service Date', 'last_service_date', 'date')}
                            {renderField('Next Test Due', 'next_test_due', 'date')}
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-white mb-1">Service History / Notes</label>
                            <textarea className="w-full rounded border border-slate-300 p-2 text-sm text-white" rows={4} value={formData.service_notes} onChange={e => setFormData({...formData, service_notes: e.target.value})} />
                        </div>
                    </div>
                )}
            </div>

            {/* Footer */}
            <div className="flex justify-end gap-2 pt-4 border-t mt-2">
                <button onClick={() => setIsModalOpen(false)} className="rounded px-4 py-2 text-sm text-slate-600 hover:bg-slate-100">Cancel</button>
                <button onClick={handleSave} className="rounded bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-700">{editingId ? 'Update Item' : 'Create Item'}</button>
            </div>
        </div>
      </Modal>
      <ConfirmationModal isOpen={confirmModal.isOpen} onClose={() => setConfirmModal({...confirmModal, isOpen: false})} onConfirm={confirmModal.onConfirm} title={confirmModal.title} message={confirmModal.message} />
    </div>
  );
};

const EditItemAllocationModal = ({ isOpen, onClose, item, onSave }) => {
  const [formData, setFormData] = useState(item || {});

  useEffect(() => {
    setFormData(item || {});
  }, [item]);

  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Edit Allocated Item">
      <div className="space-y-4">
        <div>
          <label className="text-xs font-bold text-slate-700">Quantity</label>
          <input
            type="number"
            className="w-full rounded border p-1 text-black bg-slate-50 border-slate-200 text-white"
            value={formData?.qty || ''}
            onChange={(e) => setFormData({ ...formData, qty: e.target.value })} />
        </div>
        <div>
          <label className="text-xs font-bold text-slate-700">Rate</label>
          <input
            type="number"
            className="w-full rounded border p-1 text-black bg-slate-50 border-slate-200 text-white"
            value={formData?.rate || ''}
            onChange={(e) => setFormData({ ...formData, rate: e.target.value })} />
        </div>
        <div>
          <label className="text-xs font-bold text-slate-700">Days</label>
          <input
            type="number"
            className="w-full rounded border p-1 text-black bg-slate-50 border-slate-200 text-white"
            value={formData?.days || ''}
            onChange={(e) => setFormData({ ...formData, days: e.target.value })} />
        </div>
        <div>
          <label className="text-xs font-bold text-slate-700">Description</label>
          <input
            type="text"
            className="w-full rounded border p-1 text-black bg-slate-50 border-slate-200 text-white"
            value={formData?.description || ''}
            onChange={(e) => setFormData({ ...formData, description: e.target.value })} />
        </div>
        <div className="flex justify-end pt-2">
          <button
            onClick={() => onSave(formData)}
            className="rounded bg-indigo-600 px-6 py-2 text-white hover:bg-indigo-700"
          >
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
};

const Outsourcing = ({ projects, clients, inventory, role, db, appId, logAction }) => {
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [activeTab, setActiveTab] = useState('allocations');
  
  // Allocation Wizard State
  const [isAllocWizardOpen, setIsAllocWizardOpen] = useState(false);
  const [vendorForm, setVendorForm] = useState({ vendor_id: '', item_id: '', qty: 1, rate: 0, days: 1, gst: 18, description: '' });
  const [editingAlloc, setEditingAlloc] = useState(null);
  
  // PO States
  const [isPOModalOpen, setIsPOModalOpen] = useState(false);
  const [poVendorData, setPoVendorData] = useState(null);
  const [poForm, setPoForm] = useState({ 
    po_no: '', 
    date: '', 
    terms: '', 
    subject: '', 
    notes: '',
    equipment_cost: 0,
    labour_cost: 0,
    transport_cost: 0,
    fnb_cost: 0,
    travel_cost: 0,
    accommodation_cost: 0,
    misc_cost: 0,
    gst_rate: 18,
    is_package: false,
    attachments: []
  });
  const [poSearch, setPoSearch] = useState('');
  const PO_STATUSES = ['Draft', 'Sent', 'Approved', 'Partial', 'Paid', 'Closed', 'Cancelled'];

  // Edit States
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editingAllocation, setEditingAllocation] = useState(null);
  const [showPendingOnly, setShowPendingOnly] = useState(false);
  const [showCancelledPOs, setShowCancelledPOs] = useState(false);

  // NEW STATES FOR EDITING PO
  const [editingPO, setEditingPO] = useState(null);
  const [poItems, setPoItems] = useState([]);
  
  const [allocWizardSelection, setAllocWizardSelection] = useState({}); // { itemId: { selected: true, qty, rate, days } }

  const selectedProject = projects.find(p => p.id === selectedProjectId);
  const vendors = clients.filter(c => c.type === 'Vendor' || c.type === 'Both'); // Ensure vendors are filtered correctly
  
  const allProjectItems = useMemo(() => {
      if (!selectedProject?.items) return [];
      return selectedProject.items.filter(i => i.item_id);
  }, [selectedProject]);

  const externalItems = allProjectItems.filter(i => i.is_external);
  const internalItems = allProjectItems.filter(i => !i.is_external);

  const allocationsByVendor = useMemo(() => {
      if (!selectedProject?.vendor_allocations) return [];
      const groups = {};
      selectedProject.vendor_allocations.forEach(alloc => {
          if (!groups[alloc.vendor_id]) {
              groups[alloc.vendor_id] = {
                  id: alloc.vendor_id,
                  name: alloc.vendor_name,
                  items: [],
                  totalBase: 0,
                  totalGst: 0,
                  totalAmount: 0
              };
          }
          const base = parseFloat(alloc.amount || 0);
          const taxAmt = parseFloat(alloc.tax_amount || 0);
          groups[alloc.vendor_id].items.push(alloc);
          groups[alloc.vendor_id].totalBase += base;
          groups[alloc.vendor_id].totalGst += (taxAmt - base);
          groups[alloc.vendor_id].totalAmount += taxAmt;
      });
      return Object.values(groups);
  }, [selectedProject]);

  // Helper: Remaining Qty
  const getRemainingQty = (itemId) => {
      if (!selectedProject) return 0;
      const totalRequired = (selectedProject.items || [])
          .filter(i => i.item_id === itemId)
          .reduce((sum, i) => sum + (parseInt(i.qty) || 0), 0);
      const allocated = (selectedProject.vendor_allocations || [])
          .filter(a => a.item_id === itemId)
          .reduce((sum, a) => sum + (parseInt(a.qty) || 0), 0);
      return Math.max(0, totalRequired - allocated);
  };

  const renderItemList = (items, title, colorClass) => (
    <div className="mb-4">
      <h4 className={`text-xs font-bold uppercase mb-2 ${colorClass}`}>{title}</h4>
      <div className="space-y-1">
        {items.map(item => {
           const remaining = getRemainingQty(item.item_id);
           if (remaining <= 0 && !showPendingOnly) return null;
           return (
             <div key={item.id} className="p-2 border rounded text-sm flex justify-between items-center bg-white">
                <div className="flex items-center gap-2">
                  <span className={remaining <= 0 ? 'text-slate-400 line-through' : 'text-slate-700'}>{item.item_name}</span>
                  {item.description && <span className="text-xs text-slate-500 italic">({item.description})</span>}
                </div>
                <div className="text-xs font-bold text-slate-500">Qty: {item.qty}</div>
             </div>
           );
        })}
        {items.length === 0 && <div className="text-xs text-slate-400 italic">No items.</div>}
      </div>
    </div>
  );

  // Handlers
  const handleSaveWizardAllocation = async () => {
      if (!vendorForm.vendor_id) return alert("Select Vendor first");
      
      const selectedItemIds = Object.keys(allocWizardSelection).filter(id => allocWizardSelection[id]?.selected);
      if (selectedItemIds.length === 0) return alert("Select at least one item to allocate");

      const vendor = clients.find(c => c.id === vendorForm.vendor_id);
      const newAllocations = [];

      selectedItemIds.forEach(itemId => {
          const item = allProjectItems.find(i => i.item_id === itemId);
          if (!item) return;
          
          const selection = allocWizardSelection[itemId];
          const qtyToAlloc = parseInt(selection.qty) || 0;
          
          if (qtyToAlloc <= 0) return;

          let rate = parseFloat(selection.rate) || 0;
          let days = parseInt(selection.days) || 1;
          let gst = 18; // Default GST
          
          // Try to find item gst from inventory if possible, else default
          const invItem = inventory.find(i => i.id === item.item_id);
          if (invItem) gst = invItem.gst_rate || 18;

          const amount = qtyToAlloc * rate * days;
          const tax = amount * (gst/100);

          newAllocations.push({
              id: Date.now().toString() + Math.random().toString().substr(2,5) + itemId,
              vendor_id: vendor.id,
              vendor_name: vendor.name,
              item_id: item.item_id, // This is the inventory ID
              item_name: item.item_name,
              qty: qtyToAlloc,
              rate: rate,
              days: days,
              gst: gst,
              amount: amount,
              tax_amount: amount + tax,
              description: item.description || '',
              allocated_at: new Date().toISOString()
          });
      });

      if (newAllocations.length === 0) return;

      try {
          const projectRef = doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProjectId);
          await updateDoc(projectRef, { vendor_allocations: arrayUnion(...newAllocations) });
          logAction('projects', 'add_outsourcing', selectedProjectId, { count: newAllocations.length }, selectedProject.project_name);
          setIsAllocWizardOpen(false);
          setAllocWizardSelection({});
      } catch (e) {
          console.error(e);
          alert("Failed to allocate");
      }
  };

  const handleUpdateAllocation = async (updatedAllocation) => {
    try {
      // Check if linked to PO
      if (updatedAllocation.po_id) {
          alert("Notice: This item is linked to a PO. Please update the PO if necessary.");
      }

      // Recalculate totals
      const qty = parseInt(updatedAllocation.qty) || 0;
      const rate = parseFloat(updatedAllocation.rate) || 0;
      const days = parseInt(updatedAllocation.days) || 0;
      const gst = parseFloat(updatedAllocation.gst) || 0;
      const amount = qty * rate * days;
      const tax_amount = amount * (1 + gst/100);
      
      const finalAllocation = {
          ...updatedAllocation,
          qty, rate, days, gst, amount, tax_amount
      };

      const projectRef = doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProjectId);
      await runTransaction(db, async (transaction) => {
        const pDoc = await transaction.get(projectRef);
        if (!pDoc.exists()) throw "Project not found";
        const pData = pDoc.data();
        const newAllocations = (pData.vendor_allocations || []).map(a => a.id === editingAllocation.id ? finalAllocation : a);
        transaction.update(projectRef, { vendor_allocations: newAllocations });
      });
      logAction('projects', 'update_outsourcing', selectedProjectId, { old: editingAllocation, new: finalAllocation }, selectedProject.project_name);
      setEditingAllocation(null);
      setIsEditModalOpen(false);
    } catch (err) {
      console.error(err);
      alert("Failed to update allocation: " + err.message);
    }
  };

  const handleRemove = async (alloc) => {
    if(confirm("Remove this vendor allocation?")) {
        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProjectId), {
          vendor_allocations: arrayRemove(alloc)
        });
        logAction('projects', 'remove_outsourcing', selectedProjectId, alloc, selectedProject.project_name);
    }
  };

  // --- PO Logic ---
  const getOrgSettings = async () => {
    try {
        const docSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'organization'));
        if (docSnap.exists()) return docSnap.data();
    } catch (e) { console.error(e); }
    return null;
  };

  const pendingPOVendors = useMemo(() => {
      if (!selectedProject) return [];
      const groups = {};
      (selectedProject.vendor_allocations || []).forEach(alloc => {
          if (!alloc.po_id) {
              if (!groups[alloc.vendor_id]) {
                  groups[alloc.vendor_id] = { 
                      vendor: clients.find(c => c.id === alloc.vendor_id) || { name: alloc.vendor_name, id: alloc.vendor_id }, 
                      items: [], 
                      totalAmount: 0 
                  };
              }
              groups[alloc.vendor_id].items.push(alloc);
              groups[alloc.vendor_id].totalAmount += (alloc.tax_amount || 0);
          }
      });
      return Object.values(groups);
  }, [selectedProject, clients]);

  const openPOModal = (vData, isEdit = false) => {
      if (isEdit) {
          setEditingPO(vData); // vData is the PO object here
          setPoVendorData({ 
              vendor: { name: vData.vendor_name, id: vData.vendor_id }, 
              items: vData.items,
              totalAmount: vData.amount,
              projectId: vData.projectId
          });
          setPoItems(vData.items.map(i => ({...i}))); // Deep copy for editing
          setPoForm({
              po_no: vData.po_no,
              date: vData.date.split('T')[0],
              terms: vData.terms || '',
              subject: vData.subject || '',
              notes: vData.notes || '',
              equipment_cost: vData.costs?.equipment || 0,
              labour_cost: vData.costs?.labour || 0,
              transport_cost: vData.costs?.transport || 0,
              fnb_cost: vData.costs?.fnb || 0,
              travel_cost: vData.costs?.travel || 0,
              accommodation_cost: vData.costs?.accommodation || 0,
              misc_cost: vData.costs?.misc || 0,
              gst_rate: vData.gst_rate || 18,
              is_package: vData.is_package || false,
              attachments: vData.attachments || []
          });
      } else {
          setEditingPO(null);
          const equipmentBase = vData.items.reduce((sum, item) => sum + (item.amount || 0), 0);
          setPoVendorData(vData);
          setPoItems(vData.items.map(i => ({...i})));
          setPoForm({
              po_no: `PO/${new Date().getFullYear()}/${Date.now().toString().substr(-5)}`,
              date: new Date().toISOString().split('T')[0],
              terms: vData.vendor.billing_terms || '',
              subject: `Purchase Order for ${selectedProject.project_name}`,
              notes: '',
              equipment_cost: equipmentBase,
              labour_cost: 0,
              transport_cost: 0,
              fnb_cost: 0,
              travel_cost: 0,
              accommodation_cost: 0,
              misc_cost: 0,
              gst_rate: 18,
              is_package: false,
              attachments: []
          });
      }
      setIsPOModalOpen(true);
  };

  const handleDuplicatePO = (po) => {
      // Use the edit logic but clear the editingPO ID to treat as new
      openPOModal(po, true);
      setEditingPO(null);
      setPoForm(prev => ({
          ...prev,
          po_no: `PO/${new Date().getFullYear()}/${Date.now().toString().substr(-5)}`,
          attachments: []
      }));
  };

  const handleCreatePO = async () => {
      if (!poForm.po_no || !poForm.date) return alert("PO Number and Date required");
      const pId = selectedProjectId || poVendorData?.projectId;
      if (!pId) return alert("Project context missing");
      
      const subtotal = (poForm.equipment_cost || 0) + (poForm.labour_cost || 0) + (poForm.transport_cost || 0) + (poForm.fnb_cost || 0) + (poForm.travel_cost || 0) + (poForm.accommodation_cost || 0) + (poForm.misc_cost || 0);
      const gstAmount = subtotal * ((poForm.gst_rate || 0) / 100);
      const grandTotal = subtotal + gstAmount;

      const poId = Date.now().toString();
      const newPO = {
          id: poId,
          po_no: poForm.po_no,
          date: poForm.date,
          vendor_id: poVendorData.vendor.id,
          vendor_name: poVendorData.vendor.name,
          subject: poForm.subject,
          terms: poForm.terms,
          notes: poForm.notes,
          status: 'Draft',
          amount: grandTotal,
          costs: {
            equipment: poForm.equipment_cost || 0,
            labour: poForm.labour_cost || 0,
            transport: poForm.transport_cost || 0,
            fnb: poForm.fnb_cost || 0,
            travel: poForm.travel_cost || 0,
            accommodation: poForm.accommodation_cost || 0,
            misc: poForm.misc_cost || 0,
          },
          subtotal: subtotal,
          gst_rate: poForm.gst_rate,
          is_package: poForm.is_package,
          gst_amount: gstAmount,
          created_at: new Date().toISOString(),
          items: poItems, // Use edited items
          attachments: poForm.attachments
      };

      try {
          await runTransaction(db, async (transaction) => {
              const projectRef = doc(db, 'artifacts', appId, 'public', 'data', 'projects', pId);
              const pDoc = await transaction.get(projectRef);
              if (!pDoc.exists()) throw "Project not found";
              
              const pData = pDoc.data();
              const updatedAllocations = (pData.vendor_allocations || []).map(alloc => {
                  if (poVendorData.items.find(i => i.id === alloc.id)) {
                      return { ...alloc, po_id: poId, po_no: newPO.po_no };
                  }
                  return alloc;
              });
              
              const updatedPOs = [...(pData.purchase_orders || []), newPO];
              
              transaction.update(projectRef, { 
                  vendor_allocations: updatedAllocations,
                  purchase_orders: updatedPOs
              });
          });
          
          logAction('projects', 'create_po', pId, { po_no: newPO.po_no }, selectedProject?.project_name || 'Unknown Project');
          setIsPOModalOpen(false);
          if(confirm("PO Created. Print now?")) generatePOPDF(newPO, 'print');
      } catch (e) {
          console.error(e);
          alert("Error creating PO: " + e.message);
      }
  };

  const handleUpdatePO = async () => {
      if (!poForm.po_no || !poForm.date) return alert("PO Number and Date required");
      const pId = selectedProjectId || editingPO?.projectId;
      if (!pId) return alert("Project context missing");

      // Recalculate totals based on poForm costs
      const subtotal = (poForm.equipment_cost || 0) + (poForm.labour_cost || 0) + (poForm.transport_cost || 0) + (poForm.fnb_cost || 0) + (poForm.travel_cost || 0) + (poForm.accommodation_cost || 0) + (poForm.misc_cost || 0);
      const gstAmount = subtotal * ((poForm.gst_rate || 0) / 100);
      const grandTotal = subtotal + gstAmount;

      const updatedPO = {
          ...editingPO,
          po_no: poForm.po_no,
          date: poForm.date,
          subject: poForm.subject,
          terms: poForm.terms,
          notes: poForm.notes,
          amount: grandTotal,
          costs: {
            equipment: poForm.equipment_cost || 0,
            labour: poForm.labour_cost || 0,
            transport: poForm.transport_cost || 0,
            fnb: poForm.fnb_cost || 0,
            travel: poForm.travel_cost || 0,
            accommodation: poForm.accommodation_cost || 0,
            misc: poForm.misc_cost || 0,
          },
          subtotal: subtotal,
          gst_rate: poForm.gst_rate,
          is_package: poForm.is_package,
          gst_amount: gstAmount,
          items: poItems, // Updated items
          attachments: poForm.attachments
      };

      try {
          await runTransaction(db, async (transaction) => {
              const projectRef = doc(db, 'artifacts', appId, 'public', 'data', 'projects', pId);
              const pDoc = await transaction.get(projectRef);
              if (!pDoc.exists()) throw "Project not found";
              
              const pData = pDoc.data();
              
              // Update PO in purchase_orders
              const updatedPOs = (pData.purchase_orders || []).map(p => p.id === editingPO.id ? updatedPO : p);
              
              // Update linked allocations if items changed (optional but good)
              // We match by ID.
              const updatedAllocations = (pData.vendor_allocations || []).map(alloc => {
                  const matchingItem = poItems.find(i => i.id === alloc.id);
                  if (matchingItem) {
                      return { ...alloc, description: matchingItem.description, qty: matchingItem.qty }; // Sync description and qty
                  }
                  return alloc;
              });

              transaction.update(projectRef, { 
                  purchase_orders: updatedPOs,
                  vendor_allocations: updatedAllocations
              });
          });
          
          logAction('projects', 'update_po', pId, { po_no: updatedPO.po_no }, selectedProject?.project_name || 'Unknown Project');
          setIsPOModalOpen(false);
          if(confirm("PO Updated. Print now?")) generatePOPDF(updatedPO, 'print');
      } catch (e) {
          console.error(e);
          alert("Error updating PO: " + e.message);
      }
  };

  const handleFileUpload = (e) => {
      const files = Array.from(e.target.files);
      files.forEach(file => {
          if (file.size > 1024 * 1024) { // 1MB limit per file
              alert(`File ${file.name} is too large (max 1MB)`);
              return;
          }
          const reader = new FileReader();
          reader.onloadend = () => {
              setPoForm(prev => ({
                  ...prev,
                  attachments: [...prev.attachments, { name: file.name, type: file.type, data: reader.result }]
              }));
          };
          reader.readAsDataURL(file);
      });
  };

  const removeAttachment = (index) => {
      setPoForm(prev => ({
          ...prev,
          attachments: prev.attachments.filter((_, i) => i !== index)
      }));
  };

  const updatePOStatus = async (po, newStatus) => {
      const pId = selectedProjectId || po.projectId;
      if (!pId) return;

      if (newStatus === 'Cancelled') {
          if (!confirm("Are you sure you want to cancel this PO? This will release the allocated inventory for re-allocation.")) return;
      }

      try {
          const projectRef = doc(db, 'artifacts', appId, 'public', 'data', 'projects', pId);
          await runTransaction(db, async (transaction) => {
              const pDoc = await transaction.get(projectRef);
              if (!pDoc.exists()) throw "Project not found";
              
              const pData = pDoc.data();
              const updatedPOs = (pData.purchase_orders || []).map(p => {
                  if (p.id === po.id) {
                      return { ...p, status: newStatus };
                  }
                  return p;
              });

              let updatedAllocations = pData.vendor_allocations || [];
              if (newStatus === 'Cancelled') {
                  updatedAllocations = updatedAllocations.filter(alloc => alloc.po_id !== po.id);
              }
              
              transaction.update(projectRef, { purchase_orders: updatedPOs, vendor_allocations: updatedAllocations });
          });
          logAction('projects', 'update_po_status', pId, { po_no: po.po_no, status: newStatus }, "PO Status Update");
      } catch (e) {
          console.error(e);
          alert("Error updating status: " + e.message);
      }
  };

  const generatePOPDF = async (po, mode = 'print') => {
      try {
      const doc = new jsPDF();
      const org = await getOrgSettings();
      const vendor = clients.find(c => c.id === po.vendor_id) || { name: po.vendor_name || 'Vendor', address: '' };
      const pageWidth = doc.internal.pageSize.width;
      const pageHeight = doc.internal.pageSize.height;
      const margin = 10;
      
      // Find project details if not selected
      let projectDetails = selectedProject;
      if (!projectDetails) {
          projectDetails = projects.find(p => (p.purchase_orders || []).some(order => order.id === po.id));
      }
      
      if (org?.logo) {
          try {
              doc.addImage(org.logo, 'JPEG', margin, 10, 25, 25);
          } catch (e) { console.warn("Logo add failed", e); }
      }
      
      doc.setFontSize(14); doc.text("PURCHASE ORDER", pageWidth - margin, 20, { align: 'right' });
      doc.setFontSize(8); doc.text(`PO No: ${po.po_no}`, pageWidth - margin, 30, { align: 'right' }); 
      doc.text(`Date: ${new Date(po.date).toLocaleDateString()}`, pageWidth - margin, 35, { align: 'right' });
      
      doc.setFontSize(9); doc.setFont("helvetica", "bold"); doc.text("Buyer:", margin, 50);
      doc.setFontSize(8); doc.setFont("helvetica", "normal"); doc.text(org?.name || "Company Name", margin, 55);
      const orgAddr = doc.splitTextToSize(org?.address || "", 80); doc.text(orgAddr, margin, 60);
      if(org?.gstin) doc.text(`GSTIN: ${org.gstin}`, margin, 60 + (orgAddr.length * 5));

      doc.setFontSize(9); doc.setFont("helvetica", "bold"); doc.text("Vendor:", 110, 50);
      doc.setFontSize(8); doc.setFont("helvetica", "normal"); doc.text(vendor.name, 110, 55);
      const vendAddr = doc.splitTextToSize(vendor.address || "", 80); doc.text(vendAddr, 110, 60);
      if(vendor.gstin) doc.text(`GSTIN: ${vendor.gstin}`, 110, 60 + (vendAddr.length * 5));

      let y = Math.max(60 + (orgAddr.length * 5), 60 + (vendAddr.length * 5)) + 10;

      // --- Added Project Details ---
      if (projectDetails) {
          doc.setFontSize(8);
          doc.setFont("helvetica", "bold");
          doc.text("Project Details:", margin, y);
          y += 5;
          doc.setFont("helvetica", "normal");
          doc.text(`Project: ${projectDetails.project_name}`, margin, y);
          
          const venueText = `Venue: ${projectDetails.venue || '-'}`;
          const venueLines = doc.splitTextToSize(venueText, pageWidth - 120);
          doc.text(venueLines, 110, y);
          
          y += Math.max(5, venueLines.length * 5);
          
          let dateStr = `Dates: ${projectDetails.start_date} to ${projectDetails.end_date}`;
          if (projectDetails.setup_date) dateStr += ` | Setup: ${projectDetails.setup_date}`;
          doc.text(dateStr, margin, y);
          y += 10;
      }
      // -----------------------------

      doc.text(`Subject: ${po.subject || '-'}`, margin, y); y += 10;

      const rows = (po.items || []).map((item, i) => [ 
          item.item_name + (item.description ? `\n(${item.description})` : ''), 
          item.qty, 
          item.days, 
          formatCurrencyPDF(item.rate), 
          formatCurrencyPDF(item.amount), // Base Amount
          `${item.gst}%`, 
          formatCurrencyPDF(item.tax_amount) // Total Amount
      ]);

      autoTable(doc, { 
          startY: y, 
          head: [['Item', 'Qty', 'Days', 'Rate', 'Base', 'GST', 'Total']], 
          body: rows, 
          theme: 'grid', 
          headStyles: { fillColor: [50, 50, 50] }, 
          styles: { cellPadding: 2, fontSize: 7, valign: 'middle' },
          columnStyles: { 
              0: { cellWidth: 'auto' },             // Item Description
              1: { cellWidth: 12, halign: 'center' }, // Qty
              2: { cellWidth: 12, halign: 'center' }, // Days
              3: { cellWidth: 25, halign: 'right' },  // Rate (Widened)
              4: { cellWidth: 28, halign: 'right' },  // Base (Widened)
              5: { cellWidth: 12, halign: 'center' }, // GST
              6: { cellWidth: 32, halign: 'right' }   // Total (Widened significantly) 
          },
          margin: { top: 20, bottom: 20, left: margin ,right: margin }
      });
      
      let finalY = (doc.lastAutoTable ? doc.lastAutoTable.finalY : y) + 10;
      
      // Pagination Helper
      const checkAddPage = (heightNeeded) => {
          if (finalY + heightNeeded > pageHeight - 20) {
              doc.addPage();
              finalY = 20;
              return true;
          }
          return false;
      };

      // Cost Breakdown for POs with costs object
      if (po.costs) {
        checkAddPage(40);
        doc.setFontSize(8);
        doc.setFont("helvetica", "bold");
        doc.text("Cost Breakdown:", margin, finalY);
        finalY += 5;
        doc.setFont("helvetica", "normal");
        
        const costItems = [
            { label: po.is_package ? "Package Cost" : "Equipment Cost", value: po.costs.equipment },
            { label: "Labour Cost", value: po.costs.labour },
            { label: "Transport Cost", value: po.costs.transport },
            { label: "Travel Cost", value: po.costs.travel },
            { label: "F&B Cost", value: po.costs.fnb },
            { label: "Accommodation Cost", value: po.costs.accommodation },
            { label: "Misc Cost", value: po.costs.misc },
        ].filter(c => c.value > 0);

        costItems.forEach(c => {
            doc.text(c.label, margin, finalY);
            doc.text(formatCurrencyPDF(c.value), margin + 50, finalY, { align: 'right' });
            finalY += 4;
        });
        finalY += 5;
      }

      // Calculate Totals
      const totalBase = po.subtotal !== undefined ? po.subtotal : (po.items || []).reduce((sum, item) => sum + (parseFloat(item.amount) || 0), 0);
      const totalGST = po.gst_amount !== undefined ? po.gst_amount : (po.items || []).reduce((sum, item) => sum + ((parseFloat(item.tax_amount) || 0) - (parseFloat(item.amount) || 0)), 0);
      const grandTotal = po.amount !== undefined ? po.amount : (po.items || []).reduce((sum, item) => sum + (parseFloat(item.tax_amount) || 0), 0);

      checkAddPage(35); // Space for totals box

      const boxX = pageWidth - margin - 60;
      
      doc.setDrawColor(200);
      doc.setFillColor(250, 250, 250);
      
      // Base Amount
      doc.rect(boxX, finalY, 60, 8, 'FD');
      doc.setFontSize(8);
      doc.setFont("helvetica", "normal");
      doc.text("Total Base Amount:", boxX + 2, finalY + 5.5);
      doc.setFont("helvetica", "bold");
      doc.text(formatCurrencyPDF(totalBase), boxX + 58, finalY + 5.5, { align: 'right' });
      
      // GST
      doc.setFillColor(240, 240, 240);
      doc.rect(boxX, finalY + 8, 60, 8, 'FD');
      doc.setFont("helvetica", "normal");
      doc.text("Total GST:", boxX + 2, finalY + 13.5);
      doc.setFont("helvetica", "bold");
      doc.text(formatCurrencyPDF(totalGST), boxX + 58, finalY + 13.5, { align: 'right' });
      
      // Grand Total
      doc.setFillColor(230, 230, 230); // Slightly darker for total
      doc.rect(boxX, finalY + 16, 60, 10, 'FD');
      doc.setFontSize(9);
      doc.setTextColor(0, 0, 0);
      doc.text("Grand Total:", boxX + 2, finalY + 22.5);
      doc.text(formatCurrencyPDF(grandTotal), boxX + 58, finalY + 22.5, { align: 'right' });
      
      finalY += 35;

      checkAddPage(10);
      doc.setFontSize(8);
      doc.text("Terms & Conditions:", margin, finalY); 
      finalY += 5;
      doc.setFontSize(7); 
      doc.setFont("helvetica", "normal");
      
      const terms = doc.splitTextToSize(po.terms || '-', pageWidth - (margin * 2));
      if (checkAddPage(terms.length * 5)) {
          doc.text("Terms & Conditions (Cont.):", margin, finalY - 5);
      }
      doc.text(terms, margin, finalY);
      finalY += (terms.length * 5) + 5;

      if (po.notes) { 
          checkAddPage(15);
          doc.setFontSize(10); doc.setFont("helvetica", "bold"); doc.text("Notes:", margin, finalY); 
          finalY += 5;
          doc.setFontSize(9); doc.setFont("helvetica", "normal");
          const notes = doc.splitTextToSize(po.notes, pageWidth - (margin * 2));
          checkAddPage(notes.length * 5);
          doc.text(notes, margin, finalY);
          finalY += (notes.length * 5) + 5;
      }
      
      if (org?.po_terms) {
          checkAddPage(15);
          doc.setFontSize(10); doc.setFont("helvetica", "bold"); doc.text("Standard Terms:", margin, finalY);
          doc.setFontSize(9);
          doc.setFont("helvetica", "normal");
          const stdTerms = doc.splitTextToSize(org.po_terms, pageWidth - (margin * 2));
          
          if (finalY + (stdTerms.length * 5) > pageHeight - 20) {
              doc.addPage();
              finalY = 20;
          }
          doc.text(stdTerms, margin, finalY);
          finalY += (stdTerms.length * 5) + 10;
      }

      // Signatures
      if (finalY + 40 > pageHeight - 20) {
          doc.addPage();
          finalY = 20;
      }
      
      doc.setLineWidth(0.5);
      doc.line(margin, finalY + 25, 80, finalY + 25);
      doc.setFontSize(7); doc.setFont("helvetica", "bold");
      doc.text("Authorized Signatory", margin, finalY + 30);
      doc.setFont("helvetica", "normal");
      doc.text(org?.name || "Company", margin, finalY + 35);

      doc.line(pageWidth - 90, finalY + 25, pageWidth - margin, finalY + 25);
      doc.setFont("helvetica", "bold");
      doc.text("Vendor Acceptance", pageWidth - 90, finalY + 30);
      doc.setFont("helvetica", "normal");
      doc.text("Signature & Stamp", pageWidth - 90, finalY + 35);

      if (mode === 'print') {
          doc.autoPrint();
          window.open(doc.output('bloburl'), '_blank');
      } else {
          doc.save(`PO_${po.po_no.replace(/\//g, '-')}.pdf`);
      }
      } catch (e) {
          console.error("PDF Generation Error", e);
          alert("Failed to generate PDF. Check console for details.");
      }
  };

  const allPOs = useMemo(() => {
      if (selectedProjectId) return [];
      const list = [];
      projects.forEach(p => {
          if (p.purchase_orders) {
              p.purchase_orders.forEach(po => list.push({ ...po, projectName: p.project_name, projectId: p.id }));
          }
      });
      return list.sort((a, b) => {
          const dateDiff = new Date(b.date) - new Date(a.date);
          if (dateDiff !== 0) return dateDiff;
          return (b.po_no || '').localeCompare(a.po_no || '');
      });
  }, [projects, selectedProjectId]);

  const exportAllocationSummary = async () => {
      try {
        const doc = new jsPDF();
        const org = await getOrgSettings();
        const pageWidth = doc.internal.pageSize.width;
        const pageHeight = doc.internal.pageSize.height;
        
        let isFirst = true;

        for (const group of allocationsByVendor) {
            if (!isFirst) doc.addPage();
            isFirst = false;

            // Header (Org)
            let y = 15;
            if (org?.logo) {
                try { doc.addImage(org.logo, 'JPEG', 14, 10, 25, 25); } catch (e) { console.warn('Logo error', e); }
            }
            doc.setFontSize(16); doc.setFont("helvetica", "bold"); doc.text(org?.name || "RENTAL OPS", 45, 18);
            doc.setFontSize(9); doc.setFont("helvetica", "normal");
            const addrLines = doc.splitTextToSize(org?.address || "", 100); doc.text(addrLines, 45, 24);
            
            let headerY = 24 + (addrLines.length * 4);
            if (org?.gstin) doc.text(`GSTIN: ${org.gstin}`, 45, headerY);
            
            // Title
            doc.setFontSize(14); doc.setFont("helvetica", "bold");
            doc.text("VENDOR ALLOCATION SUMMARY", pageWidth - 14, 20, { align: 'right' });
            doc.setFontSize(10); doc.setFont("helvetica", "normal");
            doc.text(`Date: ${new Date().toLocaleDateString()}`, pageWidth - 14, 26, { align: 'right' });

            y = Math.max(y + 25, headerY + 10);
            doc.setLineWidth(0.5); doc.line(14, y, pageWidth - 14, y); y += 10;

            // Project & Vendor Info
            doc.setFontSize(11); doc.setFont("helvetica", "bold");
            doc.text("Project Details:", 14, y);
            doc.text("Vendor Details:", 110, y);
            y += 6;
            
            doc.setFontSize(10); doc.setFont("helvetica", "normal");
            doc.text(`Project: ${selectedProject.project_name}`, 14, y);
            doc.text(`Vendor: ${group.name}`, 110, y);
            y += 5;
            doc.text(`Venue: ${selectedProject.venue}`, 14, y);
            
            const vendorDetails = clients.find(c => c.id === group.id);
            if (vendorDetails?.address) {
                const vAddr = doc.splitTextToSize(vendorDetails.address, 80);
                doc.text(vAddr, 110, y);
            }
            y += 5;
            doc.text(`Dates: ${selectedProject.start_date} to ${selectedProject.end_date}`, 14, y);
            y += 10;

            // Table
            const rows = group.items.map((item, i) => [
                i + 1,
                item.item_name + (item.description ? `\n(${item.description})` : ''),
                item.qty,
                item.days,
                role !== 'tech' ? formatCurrencyPDF(item.rate) : '-',
                role !== 'tech' ? formatCurrencyPDF(item.amount) : '-'
            ]);

            autoTable(doc, {
                startY: y,
                head: [['#', 'Item', 'Qty', 'Days', 'Rate', 'Amount']],
                body: rows,
                theme: 'grid',
                headStyles: { fillColor: [70, 70, 70] },
                styles: { fontSize: 9, cellPadding: 3 },
                columnStyles: {
                    4: { halign: 'right' },
                    5: { halign: 'right' }
                }
            });

            y = doc.lastAutoTable.finalY + 10;

            // Totals
            if (role !== 'tech') {
                doc.setFontSize(10); doc.setFont("helvetica", "bold");
                doc.text(`Total Base: ${formatCurrencyPDF(group.totalBase)}`, pageWidth - 14, y, { align: 'right' });
                y += 5;
                doc.text(`Total GST: ${formatCurrencyPDF(group.totalGst)}`, pageWidth - 14, y, { align: 'right' });
                y += 5;
                doc.text(`Grand Total: ${formatCurrencyPDF(group.totalAmount)}`, pageWidth - 14, y, { align: 'right' });
                y += 10;
            }

            // Terms
            if (org?.po_terms) {
                if (y + 30 > pageHeight) { doc.addPage(); y = 20; }
                doc.setFontSize(10); doc.setFont("helvetica", "bold");
                doc.text("Terms & Conditions:", 14, y);
                y += 5;
                doc.setFontSize(8); doc.setFont("helvetica", "normal");
                const terms = doc.splitTextToSize(org.po_terms, pageWidth - 28);
                doc.text(terms, 14, y);
                y += (terms.length * 3.5) + 10;
            }

            // Signatures
            if (y + 40 > pageHeight) { doc.addPage(); y = 20; }
            
            doc.setLineWidth(0.5);
            doc.line(14, y + 25, 80, y + 25);
            doc.setFontSize(9); doc.setFont("helvetica", "bold");
            doc.text("Authorized Signatory", 14, y + 30);
            doc.setFont("helvetica", "normal");
            doc.text(org?.name || "Company", 14, y + 35);

            doc.line(110, y + 25, 180, y + 25);
            doc.setFont("helvetica", "bold");
            doc.text("Supplier Acknowledgement", 110, y + 30);
            doc.setFont("helvetica", "normal");
            doc.text("Signature & Stamp", 110, y + 35);
        }

        doc.save(`Outsourcing_Summary_${selectedProject.project_name.replace(/\s+/g, '_')}.pdf`);
      } catch (e) {
          console.error(e);
          alert("Failed to generate PDF");
      }
  };

  const filteredAllPOs = useMemo(() => {
      return allPOs.filter(po => 
          ((po.vendor_name || '').toLowerCase().includes(poSearch.toLowerCase()) ||
          (po.po_no || '').toLowerCase().includes(poSearch.toLowerCase())) &&
          (showCancelledPOs || po.status !== 'Cancelled')
      ).slice(0, 30);
  }, [allPOs, poSearch, showCancelledPOs]);

  const poSubtotal = (poForm.equipment_cost || 0) + (poForm.labour_cost || 0) + (poForm.transport_cost || 0) + (poForm.fnb_cost || 0) + (poForm.travel_cost || 0) + (poForm.accommodation_cost || 0) + (poForm.misc_cost || 0);
  const poGstAmount = poSubtotal * ((poForm.gst_rate || 0) / 100);
  const poGrandTotal = poSubtotal + poGstAmount;

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <h2 className="text-2xl font-bold text-slate-800 text-white">Outsourcing Manager</h2>
        <div className="flex gap-2 w-full md:w-auto">
          <div className="flex bg-white rounded-lg border p-1">
             <button onClick={() => setActiveTab('allocations')} className={`px-3 py-1 text-sm rounded flex-1 ${activeTab === 'allocations' ? 'bg-indigo-100 text-indigo-700 font-medium' : 'text-slate-600'}`}>Allocations</button>
             <button onClick={() => setActiveTab('pos')} className={`px-3 py-1 text-sm rounded flex-1 ${activeTab === 'pos' ? 'bg-indigo-100 text-indigo-700 font-medium' : 'text-slate-600'}`}>Purchase Orders</button>
          </div>
          <select 
            className="rounded border p-2 text-sm w-full md:w-64 text-black"
            value={selectedProjectId}
            onChange={(e) => { setSelectedProjectId(e.target.value); setEditingAlloc(null); setVendorForm({ vendor_id: '', item_id: '', qty: 1, rate: 0, days: 1, gst: 18, description: '' }); setActiveTab('allocations'); setAllocWizardSelection({}); }}
          >
            <option value="">-- Select Project --</option>
            {projects.filter(p => ['Confirmed', 'Ongoing'].includes(p.status)).map(p => (
              <option key={p.id} value={p.id}>{p.project_name}</option>
            ))}
          </select>
        </div>
      </div>

      {selectedProject ? (
        activeTab === 'allocations' ? (
        <div className="grid gap-6 md:grid-cols-2 h-[calc(100vh-200px)]">
          {/* Left: Requirements */}
          <div className="rounded-xl border bg-slate-50 p-4 shadow-sm flex flex-col overflow-y-auto bg-slate-50 border-slate-200">
            <div className="flex justify-between items-center mb-4">
                <h3 className="font-bold text-slate-700 flex items-center gap-2 text-slate-200">
                    <AlertCircle size={18} className="text-indigo-500" /> Project Requirements
                </h3>
                <label className="flex items-center gap-2 text-xs cursor-pointer select-none bg-white px-2 py-1 rounded border border-slate-200 hover:bg-slate-50 bg-slate-50 border-slate-200 hover:bg-slate-50">
                    <input type="checkbox" checked={showPendingOnly} onChange={e => setShowPendingOnly(e.target.checked)} className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
                    <span className="text-slate-600 font-medium text-slate-300">Pending Only</span>
                </label>
            </div>
            {renderItemList(externalItems, "External Items (Priority)", "text-orange-600")}
            {renderItemList(internalItems, "Internal Items (Can Outsource)", "text-slate-500")}
          </div>

          {/* Right: Vendor Allocation */}
          <div className="rounded-xl border bg-white p-4 shadow-sm flex flex-col overflow-hidden bg-slate-50 border-slate-200">
            <div className="flex justify-between items-center mb-4">
                <h3 className="font-bold text-slate-700 flex items-center gap-2 text-slate-200">
                  <Truck size={18} className="text-indigo-500" />
                  Vendor Allocations
                </h3>
                <button onClick={exportAllocationSummary} className="text-xs flex items-center gap-1 bg-white border border-slate-200 rounded px-2 py-1 hover:bg-slate-50 text-slate-600 bg-slate-50 border-slate-200 text-slate-300 hover:bg-slate-50"><FileText size={14} /> Export PDF</button>
            </div>
            
            {/* New Allocation Button */}
            <div className="mb-4">
                <button onClick={() => setIsAllocWizardOpen(true)} className="w-full py-3 rounded-lg bg-indigo-600 text-white font-bold hover:bg-indigo-700 flex items-center justify-center gap-2">
                    <Plus size={20} /> Create New Allocation
                </button>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto space-y-4">
              {allocationsByVendor.map(group => (
                <div key={group.id} className="border rounded-lg overflow-hidden bg-white bg-slate-50 border-slate-200">
                    <div className="bg-slate-100 p-2 px-3 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 bg-slate-50">
                        <div className="font-bold text-slate-700 text-slate-200">{group.name}</div>
                        {role !== 'tech' && (
                        <div className="text-xs text-slate-600 flex gap-3 bg-white px-2 py-1 rounded border bg-slate-50 border-slate-200 text-slate-300">
                            <span>Base: <span className="font-semibold">{formatCurrency(group.totalBase)}</span></span>
                            <span className="text-slate-300">|</span>
                            <span>GST: <span className="font-semibold">{formatCurrency(group.totalGst)}</span></span>
                            <span className="text-slate-300">|</span>
                            <span className="text-indigo-700 font-bold">Total: {formatCurrency(group.totalAmount)}</span>
                        </div>
                        )}
                    </div>
                    <div className="divide-y divide-slate-100 divide-slate-100">
                        {group.items.map((alloc, idx) => (
                            <div key={idx} className="p-3 hover:bg-slate-50 flex justify-between items-center text-sm hover:bg-slate-50">
                                <div>
                                    <div className="font-medium text-slate-800 text-slate-200">{alloc.item_name} {alloc.description && <span className="text-xs font-normal text-slate-500 italic">- {alloc.description}</span>}</div>
                                    <div className="text-xs text-slate-500 text-slate-400"><span className="bg-slate-100 px-1 rounded bg-slate-600 text-slate-200">x{alloc.qty}</span> {role !== 'tech' ? `| Rate: ${alloc.rate} | Days: ${alloc.days} | GST: ${alloc.gst}%` : `| Days: ${alloc.days}`}</div>
                                </div>
                                <div className="text-right">
                                    {role !== 'tech' && <div className="font-bold text-slate-800 text-slate-200">{formatCurrency(alloc.tax_amount)}</div>}
                                    <div className="flex justify-end gap-2 mt-1">
                                        <button onClick={() => {
                                            setEditingAllocation(alloc);
                                            setIsEditModalOpen(true);
                                        }} className="text-blue-500 text-xs hover:underline">Edit</button>
                                        <button onClick={() => handleRemove(alloc)} className="text-red-500 text-xs hover:underline">Remove</button>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
              ))}
              {allocationsByVendor.length === 0 && <div className="text-center text-slate-400 italic mt-4">No allocations yet.</div>}
            </div>
          </div>
        </div>
        ) : (
          <div className="space-y-6">
             {/* Pending POs */}
             <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm bg-slate-50 border-slate-200">
                <h3 className="font-bold text-slate-700 mb-4 flex items-center gap-2 text-slate-200"><AlertCircle size={18} className="text-orange-500"/> Pending Purchase Orders</h3>
                <div className="grid md:grid-cols-3 gap-4">
                   {pendingPOVendors.map((group, idx) => (
                      <div key={idx} className="border rounded-lg p-4 hover:shadow-md transition-shadow border-slate-200">
                         <div className="flex justify-between items-start mb-2">
                            <div className="font-bold text-slate-800 text-slate-200">{group.vendor.name}</div>
                            <div className="text-xs bg-orange-100 text-orange-700 px-2 py-1 rounded">{group.items.length} Items</div>
                         </div>
                         <div className="text-sm text-slate-500 mb-3 text-slate-400">Total Value: {formatCurrency(group.totalAmount)}</div>
                         <button onClick={() => openPOModal(group)} className="w-full py-2 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700">Create PO</button>
                      </div>
                   ))}
                   {pendingPOVendors.length === 0 && <div className="col-span-3 text-center text-slate-400 py-4">No pending items for PO.</div>}
                </div>
             </div>

             {/* Issued POs */}
             <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm bg-slate-50 border-slate-200">
                <div className="flex justify-between items-center mb-4">
                    <h3 className="font-bold text-slate-700 flex items-center gap-2 text-slate-200"><FileCheck size={18} className="text-green-600"/> Issued Purchase Orders</h3>
                    <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
                        <input type="checkbox" checked={showCancelledPOs} onChange={e => setShowCancelledPOs(e.target.checked)} className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
                        <span className="text-slate-600 text-slate-400">Show Cancelled</span>
                    </label>
                </div>
                <div className="overflow-x-auto">
                   <table className="w-full text-sm text-left">
                      <thead className="bg-slate-50 text-slate-700 font-semibold bg-slate-50 text-slate-200"><tr><th className="p-3">PO No</th><th className="p-3">Date</th><th className="p-3">Vendor</th><th className="p-3">Subject</th><th className="p-3 text-right">Amount</th><th className="p-3">Status</th><th className="p-3 text-center">Action</th></tr></thead>
                      <tbody className="divide-y divide-slate-100 divide-slate-100">
                         {(selectedProject.purchase_orders || []).filter(po => showCancelledPOs || po.status !== 'Cancelled').map((po, idx) => (
                            <tr key={idx} className="hover:bg-slate-50 hover:bg-slate-50 text-slate-300">
                               <td className="p-3 font-medium text-slate-200">{po.po_no}</td><td className="p-3">{new Date(po.date).toLocaleDateString()}</td><td className="p-3">{po.vendor_name}</td><td className="p-3 text-slate-500 truncate max-w-[200px] text-slate-400">{po.subject}</td><td className="p-3 text-right font-bold">{formatCurrency(po.amount)}</td>
                               <td className="p-3">
                                   <select className={`text-xs border rounded p-1 text-black ${po.status === 'Paid' ? 'bg-green-50 text-green-700 border-green-200' : 'bg-slate-50'}`} value={po.status || 'Draft'} onChange={(e) => updatePOStatus(po, e.target.value)}>
                                       {PO_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                                   </select>
                               </td>
                               <td className="p-3 text-center flex justify-center gap-2">
                                   <button onClick={() => generatePOPDF(po, 'print')} className="text-indigo-600 hover:underline flex items-center gap-1"><Printer size={14}/> Print</button>
                                   <button onClick={() => generatePOPDF(po, 'download')} className="text-blue-600 hover:underline flex items-center gap-1"><Download size={14}/> PDF</button>
                                   <button onClick={() => openPOModal(po, true)} className="text-orange-600 hover:underline flex items-center gap-1"><Edit size={14}/> Edit</button>
                                   <button onClick={() => handleDuplicatePO(po)} className="text-green-600 hover:underline flex items-center gap-1"><Copy size={14}/> Copy</button>
                               </td>
                            </tr>
                         ))}
                         {(selectedProject.purchase_orders || []).filter(po => showCancelledPOs || po.status !== 'Cancelled').length === 0 && <tr><td colSpan={7} className="p-6 text-center text-slate-400">No POs to display.</td></tr>}
                      </tbody>
                   </table>
                </div>
             </div>
          </div>
        )
      ) : (
             <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm bg-slate-50 border-slate-200">
                <div className="flex justify-between items-center mb-4">
                    <h3 className="font-bold text-slate-700 flex items-center gap-2 text-slate-200"><FileCheck size={18} className="text-green-600"/> Recent Purchase Orders</h3>
                    <div className="flex items-center gap-4">
                        <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
                            <input type="checkbox" checked={showCancelledPOs} onChange={e => setShowCancelledPOs(e.target.checked)} className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
                            <span className="text-slate-600 text-slate-400">Show Cancelled</span>
                        </label>
                        <div className="flex items-center rounded border px-3 py-1 bg-white bg-slate-50 border-slate-200">
                            <Search size={16} className="text-slate-400 mr-2" />
                            <input placeholder="Search Vendor or PO..." className="text-sm outline-none text-black bg-transparent text-white" value={poSearch} onChange={(e) => setPoSearch(e.target.value)} />
                        </div>
                    </div>
                </div>
                <div className="overflow-x-auto">
                     <table className="w-full text-sm text-left">
                        <thead className="bg-slate-50 text-slate-700 font-semibold bg-slate-50 text-slate-200"><tr><th className="p-3">PO No</th><th className="p-3">Date</th><th className="p-3">Project</th><th className="p-3">Vendor</th><th className="p-3 text-right">Amount</th><th className="p-3">Status</th><th className="p-3 text-center">Actions</th></tr></thead>
                        <tbody className="divide-y divide-slate-100 divide-slate-100">
                           {filteredAllPOs.map((po, idx) => (
                              <tr key={idx} className="hover:bg-slate-50 hover:bg-slate-50 text-slate-300">
                                 <td className="p-3 font-medium text-slate-200">{po.po_no}</td>
                                 <td className="p-3">{new Date(po.date).toLocaleDateString()}</td>
                                 <td className="p-3">{po.projectName}</td>
                                 <td className="p-3">{po.vendor_name}</td>
                                 <td className="p-3 text-right font-bold">{formatCurrency(po.amount)}</td>
                                 <td className="p-3">
                                     <select className={`text-xs border rounded p-1 text-black ${po.status === 'Paid' ? 'bg-green-50 text-green-700 border-green-200' : 'bg-slate-50'}`} value={po.status || 'Draft'} onChange={(e) => updatePOStatus(po, e.target.value)}>
                                         {PO_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                                     </select>
                                 </td>
                                 <td className="p-3 text-center flex justify-center gap-2">
                                     <button onClick={() => generatePOPDF(po, 'print')} className="text-indigo-600 hover:underline flex items-center gap-1"><Printer size={14}/> Print</button>
                                     <button onClick={() => generatePOPDF(po, 'download')} className="text-blue-600 hover:underline flex items-center gap-1"><Download size={14}/> PDF</button>
                                      <button onClick={() => openPOModal(po, true)} className="text-orange-600 hover:underline flex items-center gap-1"><Edit size={14}/> Edit</button>
                                      <button onClick={() => handleDuplicatePO(po)} className="text-green-600 hover:underline flex items-center gap-1"><Copy size={14}/> Copy</button>
                                 </td>
                              </tr>
                           ))}
                           {filteredAllPOs.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-slate-400">No POs found.</td></tr>}
                        </tbody>
                     </table>
                </div>
             </div>
          )}
      <EditAllocationModal
        isOpen={isEditModalOpen}
        onClose={() => setIsEditModalOpen(false)}
        allocation={editingAllocation}
        onSave={handleUpdateAllocation}
      />
      
      {/* Allocation Wizard Modal */}
      <Modal isOpen={isAllocWizardOpen} onClose={() => setIsAllocWizardOpen(false)} title="New Allocation">
          <div className="space-y-4 h-[70vh] flex flex-col">
              <div className="grid grid-cols-2 gap-4">
                  <div>
                      <label className="text-xs font-bold text-white">Project</label>
                      <input className="w-full rounded border border-slate-300 p-2 bg-slate-50 text-white" value={selectedProject?.project_name || ''} disabled />
                  </div>
                  <div>
                      <label className="text-xs font-bold text-white">Vendor</label>
                      <select className="w-full rounded border border-slate-300 p-2 text-white" value={vendorForm.vendor_id} onChange={e => setVendorForm({...vendorForm, vendor_id: e.target.value})}>
                          <option value="">-- Select Vendor --</option>
                          {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                      </select>
                  </div>
              </div>

              <div className="flex-1 overflow-y-auto border rounded-lg border-slate-300">
                  <table className="w-full text-sm text-left">
                      <thead className="bg-slate-100 text-white font-bold sticky top-0"><tr><th className="p-2 w-8"></th><th className="p-2">Item</th><th className="p-2 text-center">Req</th><th className="p-2 text-center">Rem</th><th className="p-2 w-20">Qty</th><th className="p-2 w-24">Rate</th><th className="p-2 w-16">Days</th></tr></thead>
                      <tbody className="divide-y divide-slate-100">
                          {allProjectItems.map(item => {
                              const remaining = getRemainingQty(item.item_id);
                              const isSelected = allocWizardSelection[item.item_id]?.selected;
                              return (
                                  <tr key={item.item_id} className={isSelected ? 'bg-indigo-50' : ''}>
                                      <td className="p-2"><input type="checkbox" checked={!!isSelected} onChange={e => setAllocWizardSelection(prev => ({...prev, [item.item_id]: { ...prev[item.item_id], selected: e.target.checked, qty: prev[item.item_id]?.qty || remaining, rate: prev[item.item_id]?.rate || 0, days: prev[item.item_id]?.days || getDaysDifference(selectedProject.start_date, selectedProject.end_date) } }))} /></td>
                                      <td className="p-2"><div className="font-medium">{item.item_name}</div>{item.is_external && <span className="text-[10px] bg-purple-100 text-purple-700 px-1 rounded">Ext</span>}</td>
                                      <td className="p-2 text-center text-slate-500">{item.qty}</td>
                                      <td className="p-2 text-center font-bold">{remaining}</td>
                                      <td className="p-2"><input type="number" className="w-full border border-slate-300 rounded p-1 text-white" value={allocWizardSelection[item.item_id]?.qty || ''} onChange={e => setAllocWizardSelection(prev => ({...prev, [item.item_id]: { ...prev[item.item_id], qty: e.target.value } }))} disabled={!isSelected} /></td>
                                      <td className="p-2"><input type="number" className="w-full border border-slate-300 rounded p-1 text-white" value={allocWizardSelection[item.item_id]?.rate || ''} onChange={e => setAllocWizardSelection(prev => ({...prev, [item.item_id]: { ...prev[item.item_id], rate: e.target.value } }))} disabled={!isSelected} /></td>
                                      <td className="p-2"><input type="number" className="w-full border border-slate-300 rounded p-1 text-white" value={allocWizardSelection[item.item_id]?.days || ''} onChange={e => setAllocWizardSelection(prev => ({...prev, [item.item_id]: { ...prev[item.item_id], days: e.target.value } }))} disabled={!isSelected} /></td>
                                  </tr>
                              );
                          })}
                      </tbody>
                  </table>
              </div>
              <button onClick={handleSaveWizardAllocation} className="w-full rounded bg-indigo-600 py-3 text-white font-bold hover:bg-indigo-700">Save Allocation</button>
          </div>
      </Modal>

      <Modal isOpen={isPOModalOpen} onClose={() => setIsPOModalOpen(false)} title={editingPO ? "Edit Purchase Order" : "Create Purchase Order"}>
         <div className="space-y-4">
            <div className="bg-slate-50 p-3 rounded text-sm border text-white"><strong>Vendor:</strong> {poVendorData?.vendor.name} <br/> <strong>Items:</strong> {poItems.length}</div>
            <div className="grid grid-cols-2 gap-4"><div><label className="text-xs font-bold text-white">PO Number</label><input className="w-full rounded border border-slate-300 p-2 text-white" value={poForm.po_no} onChange={e => setPoForm({...poForm, po_no: e.target.value})} /></div><div><label className="text-xs font-bold text-white">Date</label><input type="date" className="w-full rounded border border-slate-300 p-2 text-white" value={poForm.date} onChange={e => setPoForm({...poForm, date: e.target.value})} /></div></div>
            <div><label className="text-xs font-bold text-white">Subject</label><input className="w-full rounded border border-slate-300 p-2 text-white" value={poForm.subject} onChange={e => setPoForm({...poForm, subject: e.target.value})} /></div>
            
            <div className="border rounded overflow-hidden max-h-40 overflow-y-auto">
                <table className="w-full text-xs text-left">
                    <thead className="bg-slate-100 text-white font-bold sticky top-0">
                        <tr>
                            <th className="p-2">Item</th>
                            <th className="p-2 w-16">Qty</th>
                            <th className="p-2">Description</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {poItems.map((item, idx) => (
                            <tr key={idx}>
                                <td className="p-2 text-white">{item.item_name}</td>
                                <td className="p-2"><input type="number" className="w-full border border-slate-300 rounded p-1 text-white" value={item.qty} onChange={(e) => {
                                    const newItems = [...poItems];
                                    newItems[idx].qty = parseInt(e.target.value) || 0;
                                    setPoItems(newItems);
                                }} /></td>
                                <td className="p-2"><input type="text" className="w-full border border-slate-300 rounded p-1 text-white" value={item.description || ''} onChange={(e) => {
                                    const newItems = [...poItems];
                                    newItems[idx].description = e.target.value;
                                    setPoItems(newItems);
                                }} /></td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <div className="border-t pt-4 mt-4">
              <h4 className="text-sm font-bold text-white mb-2">Cost Breakdown</h4>
              <div className="flex items-center gap-2 mb-3">
                  <input type="checkbox" id="isPackage" checked={poForm.is_package} onChange={e => setPoForm({...poForm, is_package: e.target.checked})} className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
                  <label htmlFor="isPackage" className="text-xs font-bold text-white">Package Rate (Lump Sum)</label>
              </div>
              <div className="grid grid-cols-3 gap-4">
                  <div><label className="text-xs font-bold text-white">{poForm.is_package ? 'Package Cost' : 'Equipment Cost'}</label><input type="number" className="w-full rounded border border-slate-300 p-2 text-white" value={poForm.equipment_cost} onChange={e => setPoForm({...poForm, equipment_cost: parseFloat(e.target.value) || 0})} disabled={!poForm.is_package} /></div>
                  <div><label className="text-xs font-bold text-white">Labour Cost</label><input type="number" className="w-full rounded border border-slate-300 p-2 text-white" value={poForm.labour_cost} onChange={e => setPoForm({...poForm, labour_cost: parseFloat(e.target.value) || 0})} /></div>
                  <div><label className="text-xs font-bold text-white">Transport Cost</label><input type="number" className="w-full rounded border border-slate-300 p-2 text-white" value={poForm.transport_cost} onChange={e => setPoForm({...poForm, transport_cost: parseFloat(e.target.value) || 0})} /></div>
                  <div><label className="text-xs font-bold text-white">F&B Cost</label><input type="number" className="w-full rounded border border-slate-300 p-2 text-white" value={poForm.fnb_cost} onChange={e => setPoForm({...poForm, fnb_cost: parseFloat(e.target.value) || 0})} /></div>
                  <div><label className="text-xs font-bold text-white">Travel Cost</label><input type="number" className="w-full rounded border border-slate-300 p-2 text-white" value={poForm.travel_cost} onChange={e => setPoForm({...poForm, travel_cost: parseFloat(e.target.value) || 0})} /></div>
                  <div><label className="text-xs font-bold text-white">Accommodation</label><input type="number" className="w-full rounded border border-slate-300 p-2 text-white" value={poForm.accommodation_cost} onChange={e => setPoForm({...poForm, accommodation_cost: parseFloat(e.target.value) || 0})} /></div>
                  <div><label className="text-xs font-bold text-white">Misc Cost</label><input type="number" className="w-full rounded border border-slate-300 p-2 text-white" value={poForm.misc_cost} onChange={e => setPoForm({...poForm, misc_cost: parseFloat(e.target.value) || 0})} /></div>
              </div>
              <div className="grid grid-cols-3 gap-4 mt-4">
                  <div className="col-span-1">
                      <label className="text-xs font-bold text-white">GST Rate</label>
                      <select className="w-full rounded border border-slate-300 p-2 text-white" value={poForm.gst_rate} onChange={e => setPoForm({...poForm, gst_rate: parseFloat(e.target.value) || 0})}>
                          <option value="0">0%</option><option value="5">5%</option><option value="12">12%</option><option value="18">18%</option><option value="28">28%</option>
                      </select>
                  </div>
                  <div className="col-span-2 bg-slate-100 p-3 rounded-lg text-right">
                      <div className="text-xs text-slate-500">Subtotal: {formatCurrency(poSubtotal)}</div>
                      <div className="text-xs text-slate-500">GST ({poForm.gst_rate}%): {formatCurrency(poGstAmount)}</div>
                      <div className="text-lg font-bold text-indigo-700">Total: {formatCurrency(poGrandTotal)}</div>
                  </div>
              </div>
            </div>

            <div className="border-t pt-4 mt-4">
                <h4 className="text-sm font-bold text-white mb-2 flex items-center gap-2"><Paperclip size={16}/> Attachments</h4>
                <div className="space-y-2 mb-2">
                    {poForm.attachments.map((file, idx) => (
                        <div key={idx} className="flex items-center justify-between bg-slate-50 p-2 rounded border text-xs">
                            <div className="flex items-center gap-2 truncate">
                                <FileText size={14} className="text-slate-400"/>
                                <span className="truncate max-w-[200px] text-slate-700" title={file.name}>{file.name}</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <a href={file.data} download={file.name} className="text-blue-600 hover:underline">Download</a>
                                <button onClick={() => removeAttachment(idx)} className="text-red-500 hover:text-red-700"><X size={14}/></button>
                            </div>
                        </div>
                    ))}
                    {poForm.attachments.length === 0 && <div className="text-xs text-slate-400 italic">No attachments.</div>}
                </div>
                <div className="relative">
                    <input type="file" multiple onChange={handleFileUpload} className="block w-full text-xs text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-xs file:font-semibold file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100"/>
                </div>
            </div>

            <div><label className="text-xs font-bold text-white">Terms & Conditions</label><textarea className="w-full rounded border border-slate-300 p-2 text-sm text-white" rows={3} value={poForm.terms} onChange={e => setPoForm({...poForm, terms: e.target.value})} /></div>
            <div><label className="text-xs font-bold text-white">Internal Notes</label><textarea className="w-full rounded border border-slate-300 p-2 text-sm text-white" rows={2} value={poForm.notes} onChange={e => setPoForm({...poForm, notes: e.target.value})} /></div>
            <button onClick={editingPO ? handleUpdatePO : handleCreatePO} className="w-full rounded bg-indigo-600 text-white py-2 font-bold hover:bg-indigo-700">{editingPO ? 'Update PO' : 'Generate & Save PO'}</button>
         </div>
      </Modal>
    </div>
  );
};

const EditAllocationModal = ({ isOpen, onClose, allocation, onSave }) => {
  const [formData, setFormData] = useState(allocation || {});

  useEffect(() => {
    setFormData(allocation || {});
  }, [allocation]);

  if (!isOpen || !formData?.id) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Edit Outsourced Item">
      <div className="space-y-4">
        <div>
          <label className="text-xs font-bold text-white">Quantity</label>
          <input
            type="number"
            className="w-full rounded border border-slate-300 p-1 text-white"
            value={formData.qty}
            onChange={(e) => setFormData({ ...formData, qty: e.target.value })}
          />
        </div>
        <div>
          <label className="text-xs font-bold text-white">Rate</label>
          <input
            type="number"
            className="w-full rounded border border-slate-300 p-1 text-white"
            value={formData.rate}
            onChange={(e) => setFormData({ ...formData, rate: e.target.value })}
          />
        </div>
        <div>
          <label className="text-xs font-bold text-white">Days</label>
          <input
            type="number"
            className="w-full rounded border border-slate-300 p-1 text-white"
            value={formData.days}
            onChange={(e) => setFormData({ ...formData, days: e.target.value })}
          />
        </div>
        <div>
          <label className="text-xs font-bold text-white">GST %</label>
          <input
            type="number"
            className="w-full rounded border border-slate-300 p-1 text-white"
            value={formData.gst}
            onChange={(e) => setFormData({ ...formData, gst: e.target.value })}
          />
        </div>
        <div>
          <label className="text-xs font-bold text-white">Description</label>
          <input
            type="text"
            className="w-full rounded border border-slate-300 p-1 text-white"
            value={formData.description || ''}
            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
          />
        </div>
        <div className="flex justify-end pt-2">
          <button
            onClick={() => onSave(formData)}
            className="rounded bg-indigo-600 px-6 py-2 text-white hover:bg-indigo-700"
          >
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
};


const Expenses = ({ expenses, projects, user, role, db, appId, advances = [], currentEmpId, employees = [], logAction }) => {
  const [viewMode, setViewMode] = useState('submit'); 
  const [batchList, setBatchList] = useState([]);
  const [expenseForm, setExpenseForm] = useState({ date: new Date().toISOString().split('T')[0], category: 'Travel', amount: '', remarks: '', is_general: false, project_id: '' });
  const [historyFilter, setHistoryFilter] = useState({ time: 'all', project: 'all' });
  const [projectSearch, setProjectSearch] = useState('');

  // Use currentEmpId if available (for mapped employees), otherwise fallback to user.uid
  const effectiveUserId = currentEmpId || user.uid;

  const availableProjects = role === 'tech'
    ? projects.filter(p => (p.assigned_employees || []).includes(effectiveUserId) || ['Confirmed','Ongoing'].includes(p.status)) 
    : projects.filter(p => ['Confirmed','Ongoing'].includes(p.status));

  const filteredProjects = availableProjects.filter(p => p.project_name.toLowerCase().includes(projectSearch.toLowerCase()));

  const handleAddToBatch = () => {
    if (!expenseForm.amount || (!expenseForm.is_general && !expenseForm.project_id)) return alert("Fill required fields");
    setBatchList([...batchList, { ...expenseForm, id: Date.now() }]);
    setExpenseForm({ ...expenseForm, amount: '', remarks: '' });
  };

  const removeBatchItem = (id) => setBatchList(batchList.filter(i => i.id !== id));

  const handleSubmitBatch = async () => {
    if(batchList.length === 0) return;
    const batch = batchList.map(({ id, ...rest }) => ({
      ...rest,
      employee_id: effectiveUserId, // Save against the Employee Profile ID
      status: 'Pending',
      created_at: new Date().toISOString()
    }));

    for (const item of batch) {
      const docRef = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'expenses'), item);
      logAction('expenses', 'create', docRef.id, item, `${item.category} - ${item.amount}`);
    }
    setBatchList([]);
    alert("Expenses submitted successfully");
  };

  const handleApprove = async (id) => {
    if(!confirm("Approve this expense?")) return;
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'expenses', id), { status: 'Approved' });
    logAction('expenses', 'approve', id, {}, 'Expense Approved');
  };

  const handleReject = async (id) => {
    if(!confirm("Reject this expense?")) return;
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'expenses', id), { status: 'Rejected' });
    logAction('expenses', 'reject', id, {}, 'Expense Rejected');
  };

  // Filter History & Ledger based on the Effective ID (Employee Profile ID)
  // Ensure we compare strings to strings
  const myExpenses = expenses.filter(e => String(e.employee_id) === String(effectiveUserId));
  const myAdvances = advances.filter(a => String(a.employee_id) === String(effectiveUserId));

  const filteredHistory = myExpenses.filter(e => {
    const d = new Date(e.date);
    const now = new Date();
    const isWeek = (now - d) / (1000 * 3600 * 24) <= 7;
    const isMonth = (now - d) / (1000 * 3600 * 24) <= 30;
    const timeMatch = historyFilter.time === 'all' ? true : historyFilter.time === 'week' ? isWeek : isMonth;
    const projMatch = historyFilter.project === 'all' ? true : e.project_id === historyFilter.project;
    return timeMatch && projMatch;
  });

  const totalAdvanced = myAdvances.reduce((acc, curr) => acc + parseFloat(curr.amount || 0), 0);
  const totalSpent = myExpenses.reduce((acc, curr) => acc + parseFloat(curr.amount || 0), 0);
  const balance = totalAdvanced - totalSpent;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-slate-800 text-white">Expense Tracker</h2>
        <div className="flex gap-2 bg-white rounded-lg border p-1">
          <button onClick={() => setViewMode('submit')} className={`px-3 py-1 text-sm rounded ${viewMode === 'submit' ? 'bg-indigo-100 text-indigo-700 font-medium' : 'text-slate-600'}`}>Submit</button>
          <button onClick={() => setViewMode('history')} className={`px-3 py-1 text-sm rounded ${viewMode === 'history' ? 'bg-indigo-100 text-indigo-700 font-medium' : 'text-slate-600'}`}>My History</button>
          <button onClick={() => setViewMode('ledger')} className={`px-3 py-1 text-sm rounded ${viewMode === 'ledger' ? 'bg-indigo-100 text-indigo-700 font-medium' : 'text-slate-600'}`}>My Ledger</button>
          {(role === 'admin' || role === 'manager') && (
            <button onClick={() => setViewMode('approvals')} className={`px-3 py-1 text-sm rounded ${viewMode === 'approvals' ? 'bg-indigo-100 text-indigo-700 font-medium' : 'text-slate-600'}`}>Approvals</button>
          )}
        </div>
      </div>

      {viewMode === 'submit' && (
        <div className="grid gap-6 md:grid-cols-2">
          <div className="rounded-xl bg-white p-6 shadow-sm border border-slate-200 h-fit">
            <h3 className="mb-4 font-semibold text-white">New Expense Entry</h3>
            <div className="space-y-4">
              <div className="flex gap-4 border-b pb-4">
                <label className="flex items-center gap-2 cursor-pointer"><input type="radio" name="exptype" checked={!expenseForm.is_general} onChange={() => setExpenseForm({...expenseForm, is_general: false})} /><span className="text-sm font-bold text-white">Project Expense</span></label>
                <label className="flex items-center gap-2 cursor-pointer"><input type="radio" name="exptype" checked={expenseForm.is_general} onChange={() => setExpenseForm({...expenseForm, is_general: true, project_id: ''})} /><span className="text-sm font-bold text-white">General / Ops</span></label>
              </div>
              {!expenseForm.is_general && (
                <div>
                  <label className="text-xs font-bold text-white">Select Project</label>
                  <input type="text" className="w-full rounded border border-slate-300 p-2 mb-1 text-xs text-white" placeholder="Search project..." value={projectSearch} onChange={e => setProjectSearch(e.target.value)} />
                  <select className="w-full rounded border border-slate-300 p-2 text-white" value={expenseForm.project_id} onChange={e => setExpenseForm({...expenseForm, project_id: e.target.value})}>
                    <option value="">-- Choose Project --</option>
                    {filteredProjects.map(p => <option key={p.id} value={p.id}>{p.project_name}</option>)}
                  </select>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3"><div><label className="text-xs font-bold text-white">Date</label><input type="date" className="w-full rounded border border-slate-300 p-2 text-white" value={expenseForm.date} onChange={e => setExpenseForm({...expenseForm, date: e.target.value})} /></div><div><label className="text-xs font-bold text-white">Category</label><select className="w-full rounded border border-slate-300 p-2 text-white" value={expenseForm.category} onChange={e => setExpenseForm({...expenseForm, category: e.target.value})}>{EXPENSE_CATS.map(c => <option key={c}>{c}</option>)}</select></div></div>
              <div><label className="text-xs font-bold text-white">Amount</label><input type="number" className="w-full rounded border border-slate-300 p-2 text-white" placeholder="0.00" value={expenseForm.amount} onChange={e => setExpenseForm({...expenseForm, amount: e.target.value})} /></div>
              <div><label className="text-xs font-bold text-white">Remarks</label><textarea className="w-full rounded border border-slate-300 p-2 text-sm text-white" rows={2} value={expenseForm.remarks} onChange={e => setExpenseForm({...expenseForm, remarks: e.target.value})} placeholder="Description..." /></div>
              <button onClick={handleAddToBatch} className="w-full rounded bg-slate-50 text-white py-2 hover:bg-slate-50">+ Add to Batch</button>
            </div>
          </div>
          <div className="rounded-xl bg-white p-6 shadow-sm border border-slate-200 flex flex-col h-full">
            <h3 className="mb-4 font-semibold text-white flex justify-between items-center"><span>Ready to Submit</span><span className="text-xs bg-slate-100 px-2 py-1 rounded">{batchList.length} items</span></h3>
            <div className="flex-1 overflow-y-auto space-y-2 mb-4 pr-1">{batchList.length === 0 && <div className="text-center text-slate-400 italic mt-10">No items added yet.</div>}{batchList.map(item => (<div key={item.id} className="flex justify-between items-start p-3 bg-slate-50 rounded border border-slate-100"><div><div className="font-medium text-white">{item.category} - {formatCurrency(item.amount)}</div><div className="text-xs text-slate-500">{item.is_general ? 'General Ops' : projects.find(p=>p.id===item.project_id)?.project_name || 'Unknown Project'}</div>{item.remarks && <div className="text-xs text-slate-400 mt-1">"{item.remarks}"</div>}</div><button onClick={() => removeBatchItem(item.id)} className="text-red-400 hover:text-red-600"><X size={16} /></button></div>))}</div>
            <div className="border-t pt-4"><div className="flex justify-between mb-4 font-bold text-white"><span>Total</span><span>{formatCurrency(batchList.reduce((s, i) => s + parseFloat(i.amount), 0))}</span></div><button onClick={handleSubmitBatch} disabled={batchList.length === 0} className={`w-full rounded py-3 font-medium text-white ${batchList.length > 0 ? 'bg-indigo-600 hover:bg-indigo-700' : 'bg-slate-300 cursor-not-allowed'}`}>Submit All Expenses</button></div>
          </div>
        </div>
      )}

      {viewMode === 'approvals' && (
        <div className="space-y-4">
            <h3 className="font-bold text-slate-700">Pending Approvals</h3>
            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
                <table className="w-full text-left text-sm">
                    <thead className="bg-slate-50 text-slate-700 font-semibold">
                        <tr>
                            <th className="p-4">Date</th>
                            <th className="p-4">Employee</th>
                            <th className="p-4">Project / Type</th>
                            <th className="p-4">Category</th>
                            <th className="p-4 text-right">Amount</th>
                            <th className="p-4 text-center">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {expenses.filter(e => e.status === 'Pending').map(exp => (
                            <tr key={exp.id}>
                                <td className="p-4">{new Date(exp.date).toLocaleDateString()}</td>
                                <td className="p-4 font-medium">{employees.find(e => e.id === exp.employee_id)?.name || 'Unknown'}</td>
                                <td className="p-4">{exp.is_general ? <span className="text-orange-600 bg-orange-50 px-2 py-0.5 rounded text-xs">General Ops</span> : projects.find(p=>p.id===exp.project_id)?.project_name}</td>
                                <td className="p-4">
                                    <div>{exp.category}</div>
                                    <div className="text-xs text-slate-400">{exp.remarks}</div>
                                </td>
                                <td className="p-4 text-right font-bold">{formatCurrency(exp.amount)}</td>
                                <td className="p-4 text-center">
                                    <div className="flex items-center justify-center gap-2">
                                        <button onClick={() => handleApprove(exp.id)} className="p-1 text-green-600 hover:bg-green-50 rounded" title="Approve"><CheckCircle size={18}/></button>
                                        <button onClick={() => handleReject(exp.id)} className="p-1 text-red-600 hover:bg-red-50 rounded" title="Reject"><X size={18}/></button>
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {expenses.filter(e => e.status === 'Pending').length === 0 && <div className="p-8 text-center text-slate-400">No pending expenses.</div>}
            </div>
        </div>
      )}

      {viewMode === 'history' && (
        <div className="space-y-4">
          <div className="flex gap-4 p-4 bg-white rounded-xl shadow-sm border border-slate-200">
             <select className="rounded border border-slate-300 p-1 text-sm text-white" value={historyFilter.time} onChange={e => setHistoryFilter({...historyFilter, time: e.target.value})}><option value="all">All Time</option><option value="week">This Week</option><option value="month">This Month</option></select>
             <select className="rounded border border-slate-300 p-1 text-sm text-white" value={historyFilter.project} onChange={e => setHistoryFilter({...historyFilter, project: e.target.value})}><option value="all">All Projects</option>{availableProjects.map(p => <option key={p.id} value={p.id}>{p.project_name}</option>)}</select>
          </div>
          <div className="rounded-xl bg-white shadow-sm border border-slate-200 overflow-hidden"><table className="w-full text-left text-sm"><thead className="bg-slate-50 text-slate-700 font-semibold"><tr><th className="p-4">Date</th><th className="p-4">Project / Type</th><th className="p-4">Category</th><th className="p-4 text-right">Amount</th><th className="p-4 text-center">Status</th></tr></thead><tbody className="divide-y divide-slate-100">{filteredHistory.map(exp => (<tr key={exp.id}><td className="p-4">{new Date(exp.date).toLocaleDateString()}</td><td className="p-4">{exp.is_general ? <span className="text-orange-600 bg-orange-50 px-2 py-0.5 rounded text-xs">General Ops</span> : projects.find(p=>p.id===exp.project_id)?.project_name}</td><td className="p-4">{exp.category}</td><td className="p-4 text-right font-medium">{formatCurrency(exp.amount)}</td><td className="p-4 text-center"><span className="text-xs bg-slate-100 px-2 py-1 rounded">{exp.status}</span></td></tr>))}</tbody></table>{filteredHistory.length === 0 && <div className="p-8 text-center text-slate-400">No records found.</div>}</div>
        </div>
      )}

      {viewMode === 'ledger' && (
        <div className="space-y-6">
          <div className="grid grid-cols-3 gap-4">
            <div className="rounded-xl bg-green-50 border border-green-100 p-4"><div className="text-green-600 text-sm font-medium flex items-center gap-2"><Wallet size={16} /> Total Advanced</div><div className="text-2xl font-bold text-slate-800 mt-1">{formatCurrency(totalAdvanced)}</div></div>
            <div className="rounded-xl bg-red-50 border border-red-100 p-4"><div className="text-red-600 text-sm font-medium flex items-center gap-2"><CreditCard size={16} /> Total Spent</div><div className="text-2xl font-bold text-slate-800 mt-1">{formatCurrency(totalSpent)}</div></div>
            <div className={`rounded-xl border p-4 ${balance >= 0 ? 'bg-slate-50 border-slate-200' : 'bg-orange-50 border-orange-200'}`}><div className="text-slate-600 text-sm font-medium">Balance (Due to You)</div><div className={`text-2xl font-bold mt-1 ${balance < 0 ? 'text-red-600' : 'text-slate-800'}`}>{balance < 0 ? `To Pay: ${formatCurrency(Math.abs(balance))}` : `In Hand: ${formatCurrency(balance)}`}</div></div>
          </div>
          
          <div className="grid md:grid-cols-2 gap-6">
             {/* Advance History Table */}
             <div className="rounded-xl bg-white shadow-sm border border-slate-200 overflow-hidden">
                <div className="bg-slate-50 px-4 py-3 border-b border-slate-200 font-semibold text-slate-700 flex items-center gap-2">
                   <TrendingDown size={16} className="text-green-600"/> Advances Received
                </div>
                <div className="max-h-96 overflow-y-auto">
                   {myAdvances.length === 0 ? <div className="p-6 text-center text-slate-400 italic">No advances recorded.</div> : (
                     <table className="w-full text-sm text-left">
                       <thead className="bg-slate-50 text-slate-500 text-xs uppercase"><tr><th className="px-4 py-2">Date</th><th className="px-4 py-2">Amount</th><th className="px-4 py-2">Note</th></tr></thead>
                       <tbody className="divide-y divide-slate-100">
                         {myAdvances.sort((a,b)=>new Date(b.date)-new Date(a.date)).map(adv => (
                           <tr key={adv.id} className="hover:bg-slate-50">
                             <td className="px-4 py-2">{new Date(adv.date).toLocaleDateString()}</td>
                             <td className="px-4 py-2 font-medium text-green-700">+{formatCurrency(adv.amount)}</td>
                             <td className="px-4 py-2 text-slate-500 truncate max-w-[150px]">{adv.remarks || '-'}</td>
                           </tr>
                         ))}
                       </tbody>
                     </table>
                   )}
                </div>
             </div>

             {/* Combined Ledger List */}
             <div className="rounded-xl bg-white shadow-sm border border-slate-200 p-6 flex flex-col">
                <h3 className="font-bold text-slate-800 mb-4">Recent Transactions</h3>
                <div className="flex-1 overflow-y-auto space-y-3 pr-1 max-h-96">
                   {[...myAdvances.map(a => ({...a, type: 'advance'})), ...myExpenses.map(e => ({...e, type: 'expense'}))]
                     .sort((a,b) => new Date(b.date || b.created_at) - new Date(a.date || a.created_at))
                     .map((item, idx) => (
                       <div key={idx} className="flex items-center justify-between p-3 border rounded hover:bg-slate-50">
                          <div className="flex items-center gap-3">
                            <div className={`p-2 rounded-full ${item.type === 'advance' ? 'bg-green-100 text-green-600' : 'bg-red-100 text-red-600'}`}>
                              {item.type === 'advance' ? <TrendingDown size={14} /> : <TrendingUp size={14} />}
                            </div>
                            <div>
                              <div className="text-sm font-medium text-slate-800">{item.type === 'advance' ? 'Advance' : item.category}</div>
                              <div className="text-xs text-slate-500">{new Date(item.date || item.created_at).toLocaleDateString()}</div>
                            </div>
                          </div>
                          <div className={`font-bold text-sm ${item.type === 'advance' ? 'text-green-600' : 'text-slate-800'}`}>
                            {item.type === 'advance' ? '+' : '-'}{formatCurrency(item.amount)}
                          </div>
                       </div>
                     ))
                   }
                   {myAdvances.length === 0 && myExpenses.length === 0 && <div className="text-center text-slate-400 mt-10">No transactions found.</div>}
                </div>
             </div>
          </div>
        </div>
      )}
    </div>
  );
};

const Employees = ({ employees, role, db, appId, advances = [], logAction }) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isAdvanceModalOpen, setIsAdvanceModalOpen] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [selectedEmp, setSelectedEmp] = useState(null);
  const [newPassword, setNewPassword] = useState('');
  
  const [advanceForm, setAdvanceForm] = useState({ amount: '', date: new Date().toISOString().split('T')[0], remarks: '' });
  
  // Updated initial form state for photos
  const initialFormState = { 
    name: '', email: '', role: 'tech', status: 'Active', 
    mobile1: '', mobile2: '', alt_mobile: '', address: '', 
    password: '', photo_url: '', id_proof_url: '', address_proof_url: '' 
  };
  const [formData, setFormData] = useState(initialFormState);

  const openAdd = () => { setEditingId(null); setFormData(initialFormState); setIsModalOpen(true); };
  
  const openEdit = (emp) => { 
    setEditingId(emp.id); 
    setFormData({ 
      name: emp.name || '', email: emp.email || '', role: emp.role || 'tech', 
      status: emp.status || 'Active', mobile1: emp.mobile1 || '', mobile2: emp.mobile2 || '', 
      alt_mobile: emp.alt_mobile || '', address: emp.address || '', password: '',
      photo_url: emp.photo_url || '', id_proof_url: emp.id_proof_url || '', address_proof_url: emp.address_proof_url || ''
    }); 
    setIsModalOpen(true); 
  };
  
  const handleSave = async () => {
    const empData = { 
      name: formData.name, email: formData.email, username: formData.email, 
      role: formData.role, status: formData.status, 
      mobile1: formData.mobile1, mobile2: formData.mobile2, alt_mobile: formData.alt_mobile, 
      address: formData.address,
      photo_url: formData.photo_url, id_proof_url: formData.id_proof_url, address_proof_url: formData.address_proof_url
    };
    if (editingId) { 
        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'employees', editingId), empData); 
        logAction('employees', 'update', editingId, empData, formData.name);
    } else { 
        const docRef = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'employees'), { ...empData, created_at: serverTimestamp() }); 
        logAction('employees', 'create', docRef.id, empData, formData.name);
    }
    setIsModalOpen(false);
  };

  const handlePasswordChange = async () => {
    if (!newPassword) return alert("Enter password");
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'employees', selectedEmp.id), { 
      password: newPassword,
      password_updated_at: serverTimestamp() 
    });
    logAction('employees', 'password_change', selectedEmp.id, {}, selectedEmp.name);
    alert("Password updated"); setPasswordModalOpen(false); setNewPassword('');
  };

  const handleUnlock = async (id) => {
    if(!confirm("Unlock this account?")) return;
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'employees', id), { 
        is_locked: false, 
        failed_login_attempts: 0 
    });
    logAction('employees', 'unlock', id, {}, 'Account Unlocked');
  };

  const updateStatus = async (id, status) => {
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'employees', id), { status });
    logAction('employees', 'status_change', id, { status }, `Status: ${status}`);
  };

  const submitAdvance = async () => {
    if(!advanceForm.amount) return alert("Enter amount");
    try {
      await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'advances'), {
        employee_id: selectedEmp.id,
        employee_name: selectedEmp.name,
        amount: parseFloat(advanceForm.amount),
        date: advanceForm.date,
        remarks: advanceForm.remarks,
        created_at: new Date().toISOString()
      });
      logAction('advances', 'create', selectedEmp.id, { amount: advanceForm.amount }, `Advance to ${selectedEmp.name}`);
      alert(`Advance of ${advanceForm.amount} recorded for ${selectedEmp.name}`);
      setIsAdvanceModalOpen(false);
      setAdvanceForm({ amount: '', date: new Date().toISOString().split('T')[0], remarks: '' });
    } catch (e) {
      console.error(e);
      alert("Error saving advance");
    }
  };

  // Simulated upload function for demo purposes
  const handleMockUpload = (field) => {
    const mockUrls = {
      photo: "https://via.placeholder.com/150",
      id: "https://via.placeholder.com/300x200?text=ID+Proof",
      addr: "https://via.placeholder.com/300x200?text=Address+Proof"
    };
    // Toggle between empty and mock URL
    const currentVal = formData[field];
    const newVal = currentVal ? '' : (field === 'photo_url' ? mockUrls.photo : field === 'id_proof_url' ? mockUrls.id : mockUrls.addr);
    setFormData({ ...formData, [field]: newVal });
  };

  const empAdvances = selectedEmp ? advances.filter(a => String(a.employee_id) === String(selectedEmp.id)) : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <h2 className="text-2xl font-bold text-slate-800 text-white">Employee Management</h2>
        <button onClick={openAdd} className="flex items-center justify-center gap-2 rounded bg-indigo-600 px-4 py-2 text-white hover:bg-indigo-700 whitespace-nowrap w-full md:w-auto"><Plus size={18} /> Add Employee</button>
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">{employees.map(emp => (
        <div key={emp.id} className={`rounded-xl border bg-white p-4 shadow-sm relative ${emp.status === 'Disabled' || emp.status === 'Deactivated' ? 'opacity-60 bg-slate-50' : ''}`}>
          {emp.is_locked && <div className="absolute top-2 left-2 bg-red-600 text-white text-[10px] px-2 py-1 rounded font-bold z-10 shadow-sm">LOCKED</div>}
          <div className="flex justify-between items-start mb-2">
            <div className="flex items-center gap-3">
              <div className="h-12 w-12 rounded-full bg-slate-100 flex items-center justify-center overflow-hidden border border-slate-200">
                 {emp.photo_url ? (
                   <img src={emp.photo_url} alt={emp.name} className="h-full w-full object-cover" />
                 ) : (
                   <span className="text-slate-500 font-bold text-lg">{emp.name.charAt(0)}</span>
                 )}
              </div>
              <div><h3 className="font-bold text-slate-800">{emp.name}</h3><div className="text-xs text-slate-500">{emp.email}</div></div>
            </div>
            <div className={`px-2 py-0.5 text-xs rounded border ${emp.status === 'Active' ? 'bg-green-100 text-green-700' : 'bg-slate-100'}`}>{emp.status}</div>
          </div>
          <div className="mt-4 space-y-2 text-sm text-slate-600">
            <div className="flex justify-between border-b pb-1"><span className="text-slate-400">Role:</span><span className="font-medium capitalize">{emp.role}</span></div>
            <div className="flex justify-between border-b pb-1"><span className="text-slate-400">Mobile:</span><span>{emp.mobile1 || '-'}</span></div>
            <div className="flex gap-2 pt-1">
              {emp.id_proof_url && <span title="ID Proof Attached" className="text-xs bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded border border-blue-100">ID</span>}
              {emp.address_proof_url && <span title="Addr Proof Attached" className="text-xs bg-purple-50 text-purple-600 px-1.5 py-0.5 rounded border border-purple-100">Addr</span>}
            </div>
          </div>
          <div className="mt-4 pt-2 flex gap-2">
            <button onClick={() => openEdit(emp)} className="flex-1 rounded border border-slate-200 py-1 text-xs font-medium hover:bg-slate-50">Edit</button>
            <button onClick={() => { setSelectedEmp(emp); setPasswordModalOpen(true); }} className="flex-1 rounded border border-slate-200 py-1 text-xs font-medium hover:bg-slate-50 flex justify-center gap-1"><Key size={12}/> Pass</button>
          </div>
          {(role === 'admin' || role === 'manager') && (
             <div className="flex gap-2 mt-2">
               <button onClick={() => { setSelectedEmp(emp); setIsAdvanceModalOpen(true); }} className="flex-1 rounded bg-emerald-50 text-emerald-700 border border-emerald-100 py-1 text-xs font-medium hover:bg-emerald-100 flex items-center justify-center gap-1"><Wallet size={12} /> Advance</button>
               <button onClick={() => { setSelectedEmp(emp); setIsHistoryOpen(true); }} className="flex-1 rounded bg-slate-50 text-slate-700 border border-slate-100 py-1 text-xs font-medium hover:bg-slate-100 flex items-center justify-center gap-1"><History size={12} /> View</button>
             </div>
          )}
          <div className="mt-2 grid grid-cols-2 gap-2 text-center border-t pt-2">
             {emp.status !== 'Active' && <button onClick={() => updateStatus(emp.id, 'Active')} className="text-xs text-green-600 hover:underline">Activate</button>}
             {emp.status === 'Active' && <button onClick={() => updateStatus(emp.id, 'Suspended')} className="text-xs text-orange-600 hover:underline">Suspend</button>}
             {emp.status !== 'Disabled' && <button onClick={() => updateStatus(emp.id, 'Disabled')} className="text-xs text-red-600 hover:underline">Disable</button>}
             {emp.status !== 'Deactivated' && <button onClick={() => updateStatus(emp.id, 'Deactivated')} className="text-xs text-gray-600 hover:underline">Deactivate</button>}
             {emp.is_locked && <button onClick={() => handleUnlock(emp.id)} className="col-span-2 text-xs text-purple-600 hover:underline font-bold bg-purple-50 py-1 rounded mt-1">Unlock Account</button>}
          </div>
        </div>
      ))}</div>
      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title={editingId ? "Edit Employee" : "New Employee"}>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3"><div><label className="text-xs font-bold text-white">Full Name</label><input className="w-full rounded border border-slate-300 p-2 text-white" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} /></div><div><label className="text-xs font-bold text-white">Address</label><input className="w-full rounded border border-slate-300 p-2 text-white" value={formData.address} onChange={e => setFormData({...formData, address: e.target.value})} /></div></div>
          <div className="grid grid-cols-3 gap-3">
             <div><label className="text-xs font-bold text-white">Mobile 1</label><input className="w-full rounded border border-slate-300 p-2 text-white" value={formData.mobile1} onChange={e => setFormData({...formData, mobile1: e.target.value})} /></div>
             <div><label className="text-xs font-bold text-white">Mobile 2</label><input className="w-full rounded border border-slate-300 p-2 text-white" value={formData.mobile2} onChange={e => setFormData({...formData, mobile2: e.target.value})} /></div>
             <div><label className="text-xs font-bold text-white">Alt Mobile</label><input className="w-full rounded border border-slate-300 p-2 text-white" value={formData.alt_mobile} onChange={e => setFormData({...formData, alt_mobile: e.target.value})} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3"><div><label className="text-xs font-bold text-white">Email</label><input className="w-full rounded border border-slate-300 p-2 text-white" value={formData.email} onChange={e => setFormData({...formData, email: e.target.value})} /></div><div><label className="text-xs font-bold text-white">Role</label><select className="w-full rounded border border-slate-300 p-2 text-white" value={formData.role} onChange={e => setFormData({...formData, role: e.target.value})}><option value="admin">Admin</option><option value="manager">Manager</option><option value="tech">Field Tech</option><option value="auditor">Auditor</option></select></div></div>
          
          <div className="border-t pt-3">
             <h4 className="text-sm font-semibold mb-2 text-slate-800">Documents & Photos</h4>
             <div className="grid grid-cols-3 gap-3">
                <div className="text-center">
                   <div className="h-20 w-full rounded border-2 border-dashed border-slate-300 flex flex-col items-center justify-center text-slate-400 mb-2 overflow-hidden bg-slate-50">
                      {formData.photo_url ? <img src={formData.photo_url} className="h-full w-full object-cover" /> : <Camera size={24} />}
                   </div>
                   <button onClick={() => handleMockUpload('photo_url')} className="text-xs text-indigo-600 hover:underline">{formData.photo_url ? 'Remove Photo' : 'Add Photo'}</button>
                </div>
                <div className="text-center">
                   <div className="h-20 w-full rounded border-2 border-dashed border-slate-300 flex flex-col items-center justify-center text-slate-400 mb-2 overflow-hidden bg-slate-50">
                      {formData.id_proof_url ? <div className="text-green-600 font-bold text-xs"><FileCheck size={24} className="mx-auto mb-1"/>ID Attached</div> : <FileText size={24} />}
                   </div>
                   <button onClick={() => handleMockUpload('id_proof_url')} className="text-xs text-indigo-600 hover:underline">{formData.id_proof_url ? 'Remove ID' : 'Add ID Proof'}</button>
                </div>
                <div className="text-center">
                   <div className="h-20 w-full rounded border-2 border-dashed border-slate-300 flex flex-col items-center justify-center text-slate-400 mb-2 overflow-hidden bg-slate-50">
                      {formData.address_proof_url ? <div className="text-purple-600 font-bold text-xs"><FileCheck size={24} className="mx-auto mb-1"/>Addr Attached</div> : <MapPin size={24} />}
                   </div>
                   <button onClick={() => handleMockUpload('address_proof_url')} className="text-xs text-indigo-600 hover:underline">{formData.address_proof_url ? 'Remove Addr' : 'Add Addr Proof'}</button>
                </div>
             </div>
          </div>

          <div className="pt-4 flex justify-end"><button onClick={handleSave} className="rounded bg-indigo-600 px-6 py-2 text-white hover:bg-indigo-700">Save Employee</button></div>
        </div>
      </Modal>
      <Modal isOpen={passwordModalOpen} onClose={() => setPasswordModalOpen(false)} title={`Change Password: ${selectedEmp?.name}`}><div className="space-y-4"><div><label className="text-sm font-bold text-white">New Password</label><input type="password" className="w-full rounded border border-slate-300 p-2 text-white" value={newPassword} onChange={e => setNewPassword(e.target.value)} /></div><button onClick={handlePasswordChange} className="w-full rounded bg-red-600 text-white py-2 hover:bg-red-700">Update Password</button></div></Modal>
      <Modal isOpen={isAdvanceModalOpen} onClose={() => setIsAdvanceModalOpen(false)} title={`Give Advance: ${selectedEmp?.name}`}>
         <div className="space-y-4">
            <div><label className="text-sm font-bold text-white">Amount (INR)</label><input type="number" className="w-full rounded border border-slate-300 p-2 text-white" value={advanceForm.amount} onChange={e => setAdvanceForm({...advanceForm, amount: e.target.value})} /></div>
            <div><label className="text-sm font-bold text-white">Date</label><input type="date" className="w-full rounded border border-slate-300 p-2 text-white" value={advanceForm.date} onChange={e => setAdvanceForm({...advanceForm, date: e.target.value})} /></div>
            <div><label className="text-sm font-bold text-white">Remarks</label><input className="w-full rounded border border-slate-300 p-2 text-white" placeholder="Reason for advance..." value={advanceForm.remarks} onChange={e => setAdvanceForm({...advanceForm, remarks: e.target.value})} /></div>
            <button onClick={submitAdvance} className="w-full rounded bg-emerald-600 text-white py-2 hover:bg-emerald-700">Record Advance</button>
         </div>
      </Modal>
      <Modal isOpen={isHistoryOpen} onClose={() => setIsHistoryOpen(false)} title={`Advance History: ${selectedEmp?.name}`}>
         <div className="space-y-2 max-h-96 overflow-y-auto">
            {empAdvances.length === 0 ? <p className="text-slate-400 text-sm">No advances recorded.</p> : empAdvances.sort((a,b)=> new Date(b.date)-new Date(a.date)).map(adv => (
              <div key={adv.id} className="flex justify-between items-center p-2 bg-slate-50 rounded border">
                 <div><div className="font-medium text-slate-800">{formatCurrency(adv.amount)}</div><div className="text-xs text-slate-500">{new Date(adv.date).toLocaleDateString()}</div></div>
                 <div className="text-xs text-slate-500 italic max-w-[150px] truncate">{adv.remarks}</div>
              </div>
            ))}
         </div>
      </Modal>
    </div>
  );
};

// --- Main App Component ---
//version 1.1.0   Addede reports, employee mgmt, expense mgmt, inventory mgmt
//addtion to version 1.0.0 - ledger, advances, role based access, photo uploads

// version 1.3.0 finance implementation deprecated code
// const Reports = ({ projects, clients, employees, expenses, inventory }) => {
//   const [reportType, setReportType] = useState('projects'); 
//   const [startDate, setStartDate] = useState('');
//   const [endDate, setEndDate] = useState('');

//   // --- Data Preparation Logic ---
//   const reportData = useMemo(() => {
//     if (reportType === 'projects') {
//       return projects.filter(p => {
//         const s = startDate ? new Date(startDate) : new Date('2000-01-01');
//         const e = endDate ? new Date(endDate) : new Date('2099-12-31');
//         const pStart = new Date(p.start_date);
//         return pStart >= s && pStart <= e;
//       }).map(p => {
//         const itemsTotal = (p.items || []).reduce((sum, i) => sum + (i.total || 0), 0);
//         return { 
//            id: p.id,
//            Project: p.project_name, 
//            Client: clients.find(c => c.id === p.client_id)?.name || 'Unknown', 
//            Start: p.start_date, 
//            End: p.end_date, 
//            Status: p.status, 
//            Revenue: itemsTotal 
//         };
//       });
//     }
    
//     if (reportType === 'clients') {
//        return clients.map(c => ({
//            Name: c.name,
//            GSTIN: c.gstin || 'N/A',
//            Terms: c.billing_terms,
//            Contact: c.contacts?.[0]?.name || '-',
//            Phone: c.contacts?.[0]?.phone || '-'
//        }));
//     }

//     if (reportType === 'employees') {
//         return employees.map(e => ({
//             Name: e.name,
//             Role: e.role,
//             Mobile: e.mobile1,
//             Status: e.status
//         }));
//     }
//     return [];
//   }, [reportType, startDate, endDate, projects, clients, employees]);

//   // --- Export Functions ---
//   const exportPDF = () => {
//     const doc = new jsPDF();
//     doc.text(`${reportType.toUpperCase()} REPORT`, 14, 20);
//     doc.text(`Generated: ${new Date().toLocaleDateString()}`, 14, 28);
    
//     if (reportData.length === 0) return alert("No data to export");
    
//     const headers = Object.keys(reportData[0]).filter(k => k !== 'id');
//     const data = reportData.map(row => headers.map(h => row[h]));

//     autoTable(doc, {
//       head: [headers],
//       body: data,
//       startY: 35,
//     });
    
//     doc.save(`report_${reportType}_${Date.now()}.pdf`);
//   };

//   const exportExcel = () => {
//     if (reportData.length === 0) return alert("No data to export");
//     const ws = XLSX.utils.json_to_sheet(reportData);
//     const wb = XLSX.utils.book_new();
//     XLSX.utils.book_append_sheet(wb, ws, "Report");
//     XLSX.writeFile(wb, `report_${reportType}_${Date.now()}.xlsx`);
//   };

//   return (
//     <div className="space-y-6">
//       <h2 className="text-2xl font-bold text-slate-800">System Reports</h2>
      
//       <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm space-y-4">
//         <div className="flex flex-wrap gap-4 items-end">
//           <div>
//             <label className="block text-sm font-medium text-slate-700 mb-1">Report Type</label>
//             <select className="rounded border p-2 min-w-[200px]" value={reportType} onChange={(e) => setReportType(e.target.value)}>
//                <option value="projects">Project Summary</option>
//                <option value="clients">Client List</option>
//                <option value="employees">Employee List</option>
//             </select>
//           </div>
          
//           {reportType === 'projects' && (
//             <>
//               <div>
//                 <label className="block text-sm font-medium text-slate-700 mb-1">From Date</label>
//                 <input type="date" className="rounded border p-2" value={startDate} onChange={e => setStartDate(e.target.value)} />
//               </div>
//               <div>
//                 <label className="block text-sm font-medium text-slate-700 mb-1">To Date</label>
//                 <input type="date" className="rounded border p-2" value={endDate} onChange={e => setEndDate(e.target.value)} />
//               </div>
//             </>
//           )}

//           <div className="flex gap-2 ml-auto">
//              <button onClick={exportPDF} className="flex items-center gap-2 bg-red-600 text-white px-4 py-2 rounded hover:bg-red-700">
//                 <FileText size={16} /> Export PDF
//              </button>
//              <button onClick={exportExcel} className="flex items-center gap-2 bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700">
//                 <FileText size={16} /> Export Excel
//              </button>
//           </div>
//         </div>
//       </div>

//       <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
//         <div className="p-4 border-b font-semibold bg-slate-50">Preview ({reportData.length} records)</div>
//         <div className="overflow-x-auto max-h-96">
//             <table className="w-full text-sm text-left">
//                 <thead className="bg-slate-50 text-slate-500">
//                    <tr>
//                      {reportData.length > 0 && Object.keys(reportData[0]).filter(k => k !== 'id').map(h => <th key={h} className="p-3">{h}</th>)}
//                    </tr>
//                 </thead>
//                 <tbody className="divide-y divide-slate-100">
//                    {reportData.map((row, idx) => (
//                       <tr key={idx} className="hover:bg-slate-50">
//                           {Object.keys(row).filter(k => k !== 'id').map(key => (
//                               <td key={key} className="p-3">
//                                  {key === 'Revenue' ? formatCurrency(row[key]) : row[key]}
//                               </td>
//                           ))}
//                       </tr>
//                    ))}
//                 </tbody>
//             </table>
//             {reportData.length === 0 && <div className="p-8 text-center text-slate-400">No data found for the selected criteria.</div>}
//         </div>
//       </div>
//     </div>
//   );
// };
// version 1.3.0 finance implementation deprecated code
// version 1.3.0 finance implementation enabled code
// const Reports = ({ projects, clients, employees, expenses, inventory, payments }) => {
//   const [reportType, setReportType] = useState('ledger'); 
//   const [filterId, setFilterId] = useState(''); // Client ID for ledger
//   const [startDate, setStartDate] = useState('');
//   const [endDate, setEndDate] = useState('');

//   // --- Data Preparation Logic ---
//   const reportData = useMemo(() => {
    
//     // --- 1. Client Ledger Report ---
//     if (reportType === 'ledger') {
//       if (!filterId) return [];
      
//       // Get Invoices (Completed/Closed Projects)
//       const clientInvoices = projects
//         .filter(p => p.client_id === filterId && ['Completed', 'Closed'].includes(p.status))
//         .map(p => ({
//           date: p.end_date, 
//           desc: `Invoice: ${p.project_name}`, 
//           debit: getProjectGrandTotal(p), // Invoice Amount
//           credit: 0,
//           type: 'invoice'
//         }));

//       // Get Payments
//       const clientPayments = payments
//         .filter(p => p.client_id === filterId)
//         .map(p => ({
//           date: p.date,
//           desc: `Payment: ${p.mode} - ${p.reference}`,
//           debit: 0,
//           credit: p.amount, // Payment Received
//           type: 'payment'
//         }));

//       // Merge & Sort
//       const combined = [...clientInvoices, ...clientPayments].sort((a,b) => new Date(a.date) - new Date(b.date));
      
//       // Calculate Running Balance
//       let balance = 0;
//       return combined.map(row => {
//         balance += (row.debit - row.credit);
//         return { 
//           Date: row.date, 
//           Description: row.desc, 
//           'Debit (Inv)': row.debit, 
//           'Credit (Rec)': row.credit, 
//           Balance: balance 
//         };
//       });
//     }

//     // --- 2. Existing Reports ---
//     if (reportType === 'projects') {
//       return projects.filter(p => {
//         const s = startDate ? new Date(startDate) : new Date('2000-01-01');
//         const e = endDate ? new Date(endDate) : new Date('2099-12-31');
//         const pStart = new Date(p.start_date);
//         return pStart >= s && pStart <= e;
//       }).map(p => ({ 
//            Project: p.project_name, 
//            Client: clients.find(c => c.id === p.client_id)?.name || 'Unknown', 
//            Start: p.start_date, 
//            Status: p.status, 
//            Revenue: getProjectGrandTotal(p) 
//       }));
//     }
    
//     // ... (Keep existing Clients/Employees logic if needed) ...
//     return [];
//   }, [reportType, filterId, startDate, endDate, projects, clients, payments]);

//   // --- Export Functions ---
//   const exportPDF = () => {
//     const doc = new jsPDF();
//     doc.text(`${reportType.toUpperCase()} REPORT`, 14, 20);
//     if(reportType === 'ledger') {
//        const clientName = clients.find(c => c.id === filterId)?.name;
//        doc.text(`Client: ${clientName}`, 14, 28);
//     }
    
//     if (reportData.length === 0) return alert("No data to export");
//     const headers = Object.keys(reportData[0]);
//     const data = reportData.map(row => headers.map(h => {
//         if(typeof row[h] === 'number') return row[h].toFixed(2);
//         return row[h];
//     }));

//     autoTable(doc, { head: [headers], body: data, startY: 35 });
//     doc.save(`report_${reportType}.pdf`);
//   };

//   const exportExcel = () => {
//     if (reportData.length === 0) return alert("No data to export");
//     const ws = XLSX.utils.json_to_sheet(reportData);
//     const wb = XLSX.utils.book_new();
//     XLSX.utils.book_append_sheet(wb, ws, "Report");
//     XLSX.writeFile(wb, `report_${reportType}.xlsx`);
//   };

//   return (
//     <div className="space-y-6">
//       <h2 className="text-2xl font-bold text-slate-800">System Reports</h2>
      
//       <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm space-y-4">
//         <div className="flex flex-wrap gap-4 items-end">
//           <div>
//             <label className="block text-sm font-medium text-slate-700 mb-1">Report Type</label>
//             <select className="rounded border p-2 min-w-[200px]" value={reportType} onChange={(e) => setReportType(e.target.value)}>
//                <option value="ledger">Client Ledger (Statement)</option>
//                <option value="projects">Project Revenue Summary</option>
//             </select>
//           </div>
          
//           {reportType === 'ledger' && (
//             <div>
//                <label className="block text-sm font-medium text-slate-700 mb-1">Select Client</label>
//                <select className="rounded border p-2 min-w-[200px]" value={filterId} onChange={(e) => setFilterId(e.target.value)}>
//                   <option value="">-- Choose Client --</option>
//                   {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
//                </select>
//             </div>
//           )}

//           {reportType === 'projects' && (
//             <>
//               <div><label className="block text-sm font-medium text-slate-700 mb-1">From</label><input type="date" className="rounded border p-2" value={startDate} onChange={e => setStartDate(e.target.value)} /></div>
//               <div><label className="block text-sm font-medium text-slate-700 mb-1">To</label><input type="date" className="rounded border p-2" value={endDate} onChange={e => setEndDate(e.target.value)} /></div>
//             </>
//           )}

//           <div className="flex gap-2 ml-auto">
//              <button onClick={exportPDF} className="bg-red-600 text-white px-4 py-2 rounded hover:bg-red-700 flex gap-2"><FileText size={16} /> PDF</button>
//              <button onClick={exportExcel} className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700 flex gap-2"><FileText size={16} /> Excel</button>
//           </div>
//         </div>
//       </div>

//       <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
//         <div className="p-4 border-b font-semibold bg-slate-50">Preview</div>
//         <div className="overflow-x-auto max-h-96">
//             <table className="w-full text-sm text-left">
//                 <thead className="bg-slate-50 text-slate-500">
//                    <tr>{reportData.length > 0 && Object.keys(reportData[0]).map(h => <th key={h} className="p-3 text-right first:text-left">{h}</th>)}</tr>
//                 </thead>
//                 <tbody className="divide-y divide-slate-100">
//                    {reportData.map((row, idx) => (
//                       <tr key={idx} className="hover:bg-slate-50">
//                           {Object.keys(row).map(key => (
//                               <td key={key} className={`p-3 text-right first:text-left ${key==='Balance' ? 'font-bold text-slate-800' : ''}`}>
//                                  {typeof row[key] === 'number' ? formatCurrency(row[key]) : row[key]}
//                               </td>
//                           ))}
//                       </tr>
//                    ))}
//                 </tbody>
//             </table>
//             {reportData.length === 0 && <div className="p-8 text-center text-slate-400">Select filters to view data.</div>}
//         </div>
//       </div>
//     </div>
//   );
// };
// version 1.3.0 finance implementation enabled code

// Replace the existing Reports component with this updated version
// REPORTS VERSION 2.0.0
const Reports = ({ projects, clients, employees, expenses, inventory, payments, payouts = [], advances = [] }) => {
  const [reportType, setReportType] = useState('ledger'); 
  const [filterId, setFilterId] = useState(''); // Client ID
  const [selectedProjId, setSelectedProjId] = useState(''); // Project ID
  const [isConsolidated, setIsConsolidated] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  // --- Helper: Get Project Specific Data ---
  const selectedProject = projects.find(p => p.id === selectedProjId);

  // --- Data Preparation Logic ---
  const reportData = useMemo(() => {
    
    // --- 1. Client Ledger Report ---
    if (reportType === 'ledger') {
      if (!filterId) return [];
      
      const clientInvoices = projects
        .filter(p => p.client_id === filterId && ['Completed', 'Closed'].includes(p.status))
        .map(p => ({
          date: p.end_date, 
          desc: `Invoice: ${p.project_name}`, 
          debit: getProjectGrandTotal(p), 
          credit: 0,
          type: 'invoice'
        }));

      const clientPayments = payments
        .filter(p => p.client_id === filterId)
        .map(p => ({
          date: p.date,
          desc: `Payment: ${p.mode} - ${p.reference}`,
          debit: 0,
          credit: p.amount, 
          type: 'payment'
        }));

      const combined = [...clientInvoices, ...clientPayments].sort((a,b) => new Date(a.date) - new Date(b.date));
      
      let balance = 0;
      return combined.map(row => {
        balance += (row.debit - row.credit);
        return { 
          Date: row.date, 
          Description: row.desc, 
          'Debit (Inv)': row.debit, 
          'Credit (Rec)': row.credit, 
          Balance: balance 
        };
      });
    }

    // --- 6. Employee Ledger (NEW) ---
    if (reportType === 'employee_ledger') {
      if (!filterId) return [];
      
      // Filter items
      let empAdvances = (advances || []).filter(a => String(a.employee_id) === String(filterId));
      let empPayouts = (payouts || []).filter(p => String(p.employee_id) === String(filterId));
      let empExpenses = (expenses || []).filter(e => String(e.employee_id) === String(filterId) && e.status !== 'Rejected');

      // Date Filtering
      const s = startDate ? new Date(startDate) : null;
      const e = endDate ? new Date(endDate) : null;
      if(e) e.setHours(23,59,59,999);

      const filterDate = (item) => {
          const d = new Date(item.date || item.created_at);
          if (s && d < s) return false;
          if (e && d > e) return false;
          return true;
      };

      empAdvances = empAdvances.filter(filterDate);
      empPayouts = empPayouts.filter(filterDate);
      empExpenses = empExpenses.filter(filterDate);

      const advanceRows = empAdvances.map(a => ({
          date: a.date, desc: `Advance: ${a.remarks || '-'}`, project: '-', debit: parseFloat(a.amount), credit: 0, type: 'advance'
      }));

      const payoutRows = empPayouts.map(p => ({
          date: p.date, desc: `Payout: ${p.mode} - ${p.reference || '-'}`, project: '-', debit: parseFloat(p.amount), credit: 0, type: 'payout'
      }));

      let expenseRows = [];
      if (isConsolidated) {
          const grouped = {};
          empExpenses.forEach(exp => {
              const pid = exp.project_id || 'general';
              if (!grouped[pid]) {
                  grouped[pid] = { amount: 0, name: exp.is_general ? 'General Ops' : (projects.find(p=>p.id===pid)?.project_name || 'Unknown') };
              }
              grouped[pid].amount += parseFloat(exp.amount);
          });
          expenseRows = Object.values(grouped).map(g => ({
              date: endDate || new Date().toISOString().split('T')[0],
              desc: `Consolidated Expenses`, project: g.name, debit: 0, credit: g.amount, type: 'expense'
          }));
      } else {
          expenseRows = empExpenses.map(exp => ({
              date: exp.date,
              desc: `${exp.category}: ${exp.remarks || '-'}`,
              project: exp.is_general ? 'General Ops' : (projects.find(p=>p.id===exp.project_id)?.project_name || 'Unknown'),
              debit: 0, credit: parseFloat(exp.amount), type: 'expense'
          }));
      }

      const combined = [...advanceRows, ...payoutRows, ...expenseRows].sort((a,b) => new Date(a.date) - new Date(b.date));
      
      let balance = 0;
      return combined.map(row => {
          balance += (row.credit - row.debit);
          return {
              Date: row.date, Description: row.desc, Project: row.project,
              'Expense (Cr)': row.credit, 'Payment (Dr)': row.debit, Balance: balance
          };
      });
    }

    // --- 7. Client Balance Report (NEW) ---
    if (reportType === 'client_balance') {
      return clients.map(c => {
          // Calculate Total Invoiced (Completed/Closed projects)
          const clientProjects = projects.filter(p => p.client_id === c.id && ['Completed', 'Closed'].includes(p.status));
          const totalInvoiced = clientProjects.reduce((sum, p) => sum + getProjectGrandTotal(p), 0);
          
          // Calculate Total Received
          const clientPayments = payments.filter(p => p.client_id === c.id);
          const totalReceived = clientPayments.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0);
          
          return {
              Client: c.name,
              'Total Invoiced': totalInvoiced,
              'Total Received': totalReceived,
              'Balance Due': totalInvoiced - totalReceived
          };
      }).sort((a, b) => b['Balance Due'] - a['Balance Due']);
    }

    // --- 2. Project Revenue Summary (Existing) ---
    if (reportType === 'projects_summary') {
      return projects.filter(p => {
        const s = startDate ? new Date(startDate) : new Date('2000-01-01');
        const e = endDate ? new Date(endDate) : new Date('2099-12-31');
        const pStart = new Date(p.start_date);
        return pStart >= s && pStart <= e;
      }).map(p => ({ 
           Project: p.project_name, 
           Client: clients.find(c => c.id === p.client_id)?.name || 'Unknown', 
           Start: p.start_date, 
           Status: p.status, 
           Revenue: getProjectGrandTotal(p) 
      }));
    }

    // --- 3. Project Operations / Tech Sheet (NEW) ---
    if (reportType === 'project_ops') {
        if (!selectedProject) return [];
        
        // Combine Internal Items and Outsourced Allocations for a full gear list
        const internalGear = (selectedProject.items || []).map(i => ({
            Category: i.category || 'Equipment',
            Item: i.item_name,
            Qty: i.qty,
            Source: i.is_external ? 'Cross-Hired' : 'In-House',
            Notes: '-'
        }));

        const outsourcedGear = (selectedProject.vendor_allocations || []).map(v => ({
            Category: 'Outsourced',
            Item: v.item_name,
            Qty: v.qty,
            Source: `Vendor: ${v.vendor_name}`,
            Notes: 'External Vendor'
        }));

        return [...internalGear, ...outsourcedGear];
    }

    // --- 4. Project Expenses Report (NEW) ---
    if (reportType === 'project_expenses') {
        if (!selectedProject) return [];
        
        const projExpenses = expenses.filter(e => e.project_id === selectedProject.id);
        return projExpenses.map(e => ({
            Date: e.date,
            Category: e.category,
            Amount: e.amount,
            'Logged By': employees.find(emp => emp.id === e.employee_id)?.name || 'Unknown',
            Remarks: e.remarks || '-'
        }));
    }

    // --- 5. Project Profit & Loss (NEW) ---
    if (reportType === 'project_pnl') {
        if (!selectedProject) return [];

        // Revenue Calculations
        const equipmentRevenue = (selectedProject.items || []).reduce((acc, i) => acc + (i.total || 0), 0);
        let logisticsRevenue = 0;
        if (selectedProject.logistics_costs) {
            Object.values(selectedProject.logistics_costs).forEach(c => {
               const base = c.amount || 0;
               logisticsRevenue += base * (1 + (c.gst || 0)/100);
            });
        }
        const totalRevenue = equipmentRevenue + logisticsRevenue;

        // Cost Calculations
        const outsourcingCost = (selectedProject.vendor_allocations || []).reduce((acc, v) => acc + (v.tax_amount || 0), 0); // Inclusive of tax for cost
        const directExpenses = expenses
            .filter(e => e.project_id === selectedProject.id && e.status !== 'Rejected')
            .reduce((acc, e) => acc + parseFloat(e.amount || 0), 0);
        
        const totalCost = outsourcingCost + directExpenses;
        const netProfit = totalRevenue - totalCost;

        return [
            { Section: 'REVENUE', Item: 'Equipment Rental', Amount: equipmentRevenue },
            { Section: 'REVENUE', Item: 'Logistics & Services', Amount: logisticsRevenue },
            { Section: 'REVENUE', Item: 'Total Revenue', Amount: totalRevenue, _isTotal: true }, // Marker for bolding
            { Section: 'COSTS', Item: 'Outsourcing (Vendors)', Amount: -outsourcingCost },
            { Section: 'COSTS', Item: 'Direct Expenses', Amount: -directExpenses },
            { Section: 'COSTS', Item: 'Total Costs', Amount: -totalCost, _isTotal: true },
            { Section: 'PROFIT', Item: 'Net Profit / Loss', Amount: netProfit, _isTotal: true }
        ];
    }

    return [];
  }, [reportType, filterId, selectedProjId, startDate, endDate, projects, clients, payments, expenses, employees]);

  // --- Export Functions ---
  const exportPDF = () => {
    const doc = new jsPDF();
    
    // Header Info
    doc.setFontSize(16);
    doc.text(`REPORT: ${reportType.toUpperCase().replace('_', ' ')}`, 14, 20);
    doc.setFontSize(10);
    doc.text(`Generated: ${new Date().toLocaleDateString()}`, 14, 26);

    // Contextual Header Info (Venue, Dates)
    if (selectedProject && ['project_ops', 'project_expenses', 'project_pnl'].includes(reportType)) {
        doc.setFontSize(12);
        doc.text(`Project: ${selectedProject.project_name}`, 14, 34);
        doc.setFontSize(10);
        doc.text(`Venue: ${selectedProject.venue} | Dates: ${selectedProject.start_date} to ${selectedProject.end_date}`, 14, 40);
        
        if (reportType === 'project_ops' && selectedProject.setup_date) {
            doc.text(`Setup Date: ${selectedProject.setup_date}`, 14, 46);
        }
    } else if(reportType === 'ledger') {
       const clientName = clients.find(c => c.id === filterId)?.name;
       doc.text(`Client: ${clientName}`, 14, 34);
    } else if(reportType === 'employee_ledger') {
       const empName = employees.find(e => e.id === filterId)?.name;
       doc.text(`Employee: ${empName}`, 14, 34);
       if (isConsolidated) doc.text(`(Consolidated View)`, 14, 40);
    }
    
    if (reportData.length === 0) return alert("No data to export");
    
    // Filter out internal keys like _isTotal
    const headers = Object.keys(reportData[0]).filter(k => !k.startsWith('_'));
    const data = reportData.map(row => headers.map(h => {
        if(typeof row[h] === 'number') return row[h].toFixed(2);
        return row[h];
    }));

    autoTable(doc, { 
        head: [headers], 
        body: data, 
        startY: 50,
        // Style specific rows (like totals in P&L)
        didParseCell: function (data) {
            if (reportType === 'project_pnl') {
                const rawRow = reportData[data.row.index];
                if (rawRow && rawRow._isTotal) {
                    data.cell.styles.fontStyle = 'bold';
                    data.cell.styles.fillColor = [240, 240, 240];
                }
            }
        }
    });
    doc.save(`report_${reportType}.pdf`);
  };

  const exportExcel = () => {
    if (reportData.length === 0) return alert("No data to export");
    // Clean data for excel (remove _isTotal)
    const cleanData = reportData.map(({ _isTotal, ...rest }) => rest);
    const ws = XLSX.utils.json_to_sheet(cleanData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Report");
    XLSX.writeFile(wb, `report_${reportType}.xlsx`);
  };

  const handleEmail = () => {
    let recipientEmail = '';
    let subject = `Report: ${reportType.toUpperCase().replace('_', ' ')}`;
    let body = "Please find the attached report.";
    
    if (reportType === 'ledger') {
       const client = clients.find(c => c.id === filterId);
       if (client && client.contacts?.length > 0) {
           const contact = client.contacts.find(c => c.email);
           if (contact) recipientEmail = contact.email;
       }
    } else if (reportType === 'employee_ledger') {
       const emp = employees.find(e => e.id === filterId);
       if (emp) recipientEmail = emp.email;
    }

    exportPDF();
    setTimeout(() => {
        window.location.href = `mailto:${recipientEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
        alert("Report downloaded. Please attach the file to the email draft.");
    }, 500);
  };

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-slate-800">System Reports</h2>
      
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm space-y-4">
        <div className="flex flex-wrap gap-4 items-end">
          <div className="w-full md:w-auto">
            <label className="block text-sm font-medium text-slate-700 mb-1">Report Type</label>
            <select className="w-full rounded border p-2 min-w-[250px] text-black" value={reportType} onChange={(e) => { setReportType(e.target.value); setFilterId(''); setSelectedProjId(''); }}>
               <option value="ledger">Client Ledger (Statement)</option>
               <option value="client_balance">Client Balance Summary</option>
               <option value="employee_ledger">Employee Ledger</option>
               <option value="projects_summary">Revenue Summary (Date Range)</option>
               <option disabled>--- Project Specific ---</option>
               <option value="project_ops">Project Operations (Tech Sheet)</option>
               <option value="project_expenses">Project Expenses Detailed</option>
               <option value="project_pnl">Project Profit & Loss</option>
            </select>
          </div>
          
          {/* Filters based on Type */}
          {reportType === 'ledger' && (
            <div className="w-full md:w-auto">
               <label className="block text-sm font-medium text-slate-700 mb-1">Select Client</label>
               <select className="w-full rounded border p-2 min-w-[200px] text-black" value={filterId} onChange={(e) => setFilterId(e.target.value)}>
                  <option value="">-- Choose Client --</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
               </select>
            </div>
          )}

          {reportType === 'employee_ledger' && (
            <div className="w-full md:w-auto flex flex-col gap-2">
               <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Select Employee</label>
                  <select className="w-full rounded border p-2 min-w-[200px] text-black" value={filterId} onChange={(e) => setFilterId(e.target.value)}>
                      <option value="">-- Choose Employee --</option>
                      {employees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                  </select>
               </div>
               <div className="flex items-center gap-2"><input type="checkbox" id="consolidated" checked={isConsolidated} onChange={e => setIsConsolidated(e.target.checked)} /><label htmlFor="consolidated" className="text-sm text-slate-700">Consolidate by Project</label></div>
            </div>
          )}

          {['project_ops', 'project_expenses', 'project_pnl'].includes(reportType) && (
            <div className="w-full md:w-auto">
               <label className="block text-sm font-medium text-slate-700 mb-1">Select Project</label>
               <select className="w-full rounded border p-2 min-w-[250px] text-black" value={selectedProjId} onChange={(e) => setSelectedProjId(e.target.value)}>
                  <option value="">-- Choose Project --</option>
                  {projects.sort((a,b) => new Date(b.start_date) - new Date(a.start_date)).map(p => (
                      <option key={p.id} value={p.id}>{p.project_name} ({p.status})</option>
                  ))}
               </select>
            </div>
          )}

          {['projects_summary', 'employee_ledger'].includes(reportType) && (
            <>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">From</label><input type="date" className="rounded border p-2 text-black" value={startDate} onChange={e => setStartDate(e.target.value)} /></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">To</label><input type="date" className="rounded border p-2 text-black" value={endDate} onChange={e => setEndDate(e.target.value)} /></div>
            </>
          )}

          <div className="flex gap-2 ml-auto w-full md:w-auto">
             <button onClick={exportPDF} className="flex-1 md:flex-none justify-center bg-red-600 text-white px-4 py-2 rounded hover:bg-red-700 flex gap-2 items-center"><FileText size={16} /> PDF</button>
             <button onClick={exportExcel} className="flex-1 md:flex-none justify-center bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700 flex gap-2 items-center"><FileText size={16} /> Excel</button>
             <button onClick={handleEmail} className="flex-1 md:flex-none justify-center bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 flex gap-2 items-center"><Mail size={16} /> Email</button>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="p-4 border-b font-semibold bg-slate-50 flex justify-between">
            <span>Preview</span>
            {selectedProject && ['project_ops', 'project_expenses', 'project_pnl'].includes(reportType) && (
                <span className="text-sm font-normal text-slate-500">
                    {selectedProject.venue} • {selectedProject.start_date}
                </span>
            )}
        </div>
        <div className="overflow-x-auto max-h-96">
            <table className="w-full text-sm text-left">
                <thead className="bg-slate-50 text-slate-500">
                   <tr>{reportData.length > 0 && Object.keys(reportData[0]).filter(k => !k.startsWith('_')).map(h => <th key={h} className="p-3 whitespace-nowrap">{h}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                   {reportData.map((row, idx) => (
                      <tr key={idx} className={`hover:bg-slate-50 ${row._isTotal ? 'bg-slate-100 font-bold' : ''}`}>
                          {Object.keys(row).filter(k => !k.startsWith('_')).map(key => (
                              <td key={key} className={`p-3 whitespace-nowrap ${typeof row[key] === 'number' ? 'text-right' : ''}`}>
                                 {typeof row[key] === 'number' ? formatCurrency(row[key]) : row[key]}
                              </td>
                          ))}
                      </tr>
                   ))}
                </tbody>
            </table>
            {reportData.length === 0 && <div className="p-8 text-center text-slate-400">Select filters to view data.</div>}
        </div>
      </div>
    </div>
  );
};

const AdminTools = ({ db, appId, logAction }) => {
  const [backupStatus, setBackupStatus] = useState('idle');
  const [restoreStatus, setRestoreStatus] = useState('idle');
  const [securityForm, setSecurityForm] = useState({ admin_password: '', recovery_key: '' });
  const [orgForm, setOrgForm] = useState({ name: '', address: '', pan: '', gstin: '', logo: '', currency: 'INR', email: '', phone: '', po_terms: '', challan_terms: '' });

  useEffect(() => {
    const fetchSettings = async () => {
        try {
            const docSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'security'));
            if (docSnap.exists()) {
                setSecurityForm(docSnap.data());
            }
            const orgSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'organization'));
            if (orgSnap.exists()) {
                setOrgForm(orgSnap.data());
            }
        } catch (e) { console.error(e); }
    };
    fetchSettings();
  }, [db, appId]);

  const collections = ['projects', 'clients', 'inventory', 'expenses', 'employees', 'advances', 'payments', 'payouts', 'audit_logs'];

  const handleBackup = async () => {
    setBackupStatus('loading');
    try {
      const backupData = {};
      for (const colName of collections) {
        const snap = await getDocs(collection(db, 'artifacts', appId, 'public', 'data', colName));
        backupData[colName] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      }
      
      const blob = new Blob([JSON.stringify(backupData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `rental_ops_backup_${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setBackupStatus('success');
      logAction('admin', 'backup', 'system', {}, 'Full System Backup');
    } catch (error) {
      console.error(error);
      setBackupStatus('error');
    }
    setTimeout(() => setBackupStatus('idle'), 3000);
  };

  const handleRestore = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    if (!confirm("WARNING: This will overwrite existing data with the same IDs. Continue?")) {
        e.target.value = null;
        return;
    }

    setRestoreStatus('loading');
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const data = JSON.parse(event.target.result);
        
        for (const colName of Object.keys(data)) {
          if (!collections.includes(colName)) continue;
          
          const items = data[colName];
          for (const item of items) {
            const { id, ...docData } = item;
            if (id) {
               await setDoc(doc(db, 'artifacts', appId, 'public', 'data', colName, id), docData);
            } else {
               await addDoc(collection(db, 'artifacts', appId, 'public', 'data', colName), docData);
            }
          }
        }
        setRestoreStatus('success');
        alert("Restore completed successfully. Please refresh the page.");
        logAction('admin', 'restore', 'system', {}, 'Full System Restore');
      } catch (error) {
        console.error(error);
        setRestoreStatus('error');
        alert("Error during restore. Check console.");
      }
      e.target.value = null;
      setTimeout(() => setRestoreStatus('idle'), 3000);
    };
    reader.readAsText(file);
  };

  const handleUpdateSecurity = async () => {
    if (!securityForm.admin_password || !securityForm.recovery_key) return alert("Both Password and Recovery Key are required.");
    await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'security'), securityForm);
    logAction('admin', 'update_security', 'security', {}, 'Updated Admin Credentials');
    alert("Admin Security Settings Updated Successfully.");
  };

  const handleSaveOrgSettings = async () => {
    await setDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'organization'), orgForm);
    logAction('admin', 'update_org', 'organization', {}, 'Updated Organization Details');
    alert("Organization Details Updated.");
  };

  const handleLogoUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
        if (file.size > 500000) return alert("File too large. Max 500KB.");
        const reader = new FileReader();
        reader.onloadend = () => {
            setOrgForm(prev => ({ ...prev, logo: reader.result }));
        };
        reader.readAsDataURL(file);
    }
  };

  return (
    <div className="space-y-6">
       <h2 className="text-2xl font-bold text-slate-800">Admin Tools</h2>
       <div className="grid md:grid-cols-2 gap-6">
          <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
             <h3 className="font-bold text-lg mb-2 flex items-center gap-2 text-slate-800"><Download size={20} /> Backup Data</h3>
             <p className="text-slate-500 text-sm mb-4">Download a full JSON backup of all system data (Projects, Clients, Inventory, etc).</p>
             <button onClick={handleBackup} disabled={backupStatus === 'loading'} className="bg-indigo-600 text-white px-4 py-2 rounded hover:bg-indigo-700 disabled:bg-indigo-300">
                {backupStatus === 'loading' ? 'Generating Backup...' : 'Download Backup'}
             </button>
             {backupStatus === 'success' && <span className="ml-3 text-green-600 text-sm font-medium">Backup Downloaded!</span>}
          </div>

          <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
             <h3 className="font-bold text-lg mb-2 flex items-center gap-2 text-slate-800"><Upload size={20} /> Restore Data</h3>
             <p className="text-slate-500 text-sm mb-4">Upload a previously generated JSON backup file. Existing records with matching IDs will be updated.</p>
             <div className="relative">
                <input type="file" accept=".json" onChange={handleRestore} disabled={restoreStatus === 'loading'} className="block w-full text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100"/>
             </div>
             {restoreStatus === 'loading' && <div className="mt-2 text-indigo-600 text-sm">Restoring data... please wait...</div>}
             {restoreStatus === 'success' && <div className="mt-2 text-green-600 text-sm font-medium">Restore Complete!</div>}
          </div>
       </div>

       <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
            <h3 className="font-bold text-lg mb-4 flex items-center gap-2 text-slate-800"><Briefcase size={20} /> Organization Settings</h3>
            <div className="grid md:grid-cols-2 gap-4">
                <div><label className="block text-sm font-bold text-white mb-1">Company Name</label><input className="w-full rounded border border-slate-300 p-2 text-white" value={orgForm.name} onChange={e => setOrgForm({...orgForm, name: e.target.value})} /></div>
                <div><label className="block text-sm font-bold text-white mb-1">GSTIN</label><input className="w-full rounded border border-slate-300 p-2 text-white" value={orgForm.gstin} onChange={e => setOrgForm({...orgForm, gstin: e.target.value})} /></div>
                <div><label className="block text-sm font-bold text-white mb-1">PAN</label><input className="w-full rounded border border-slate-300 p-2 text-white" value={orgForm.pan} onChange={e => setOrgForm({...orgForm, pan: e.target.value})} /></div>
                <div><label className="block text-sm font-bold text-white mb-1">Currency Symbol</label><input className="w-full rounded border border-slate-300 p-2 text-white" value={orgForm.currency} onChange={e => setOrgForm({...orgForm, currency: e.target.value})} /></div>
                <div className="md:col-span-2"><label className="block text-sm font-bold text-white mb-1">Address</label><textarea className="w-full rounded border border-slate-300 p-2 text-white" rows={2} value={orgForm.address} onChange={e => setOrgForm({...orgForm, address: e.target.value})} /></div>
                <div className="md:col-span-2"><label className="block text-sm font-bold text-white mb-1">PO Standard Terms</label><textarea className="w-full rounded border border-slate-300 p-2 text-white" rows={3} value={orgForm.po_terms || ''} onChange={e => setOrgForm({...orgForm, po_terms: e.target.value})} placeholder="Default terms for Purchase Orders..." /></div>
                <div className="md:col-span-2"><label className="block text-sm font-bold text-white mb-1">Challan Standard Terms</label><textarea className="w-full rounded border border-slate-300 p-2 text-white" rows={3} value={orgForm.challan_terms || ''} onChange={e => setOrgForm({...orgForm, challan_terms: e.target.value})} placeholder="Default terms for Challans..." /></div>
                
                <div className="md:col-span-2 border-t pt-4 mt-2">
                    <label className="block text-sm font-bold text-white mb-2">Company Logo (Image)</label>
                    <div className="flex items-center gap-4">
                        <div className="h-16 w-16 border rounded flex items-center justify-center bg-slate-50 overflow-hidden">
                            {orgForm.logo ? <img src={orgForm.logo} alt="Logo" className="h-full w-full object-contain" /> : <ImageIcon className="text-slate-300"/>}
                        </div>
                        <input type="file" accept="image/*" onChange={handleLogoUpload} className="text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100" />
                    </div>
                </div>
            </div>
            <button onClick={handleSaveOrgSettings} className="mt-4 bg-indigo-600 text-white px-6 py-2 rounded hover:bg-indigo-700">Save Organization Details</button>
       </div>

       <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
            <h3 className="font-bold text-lg mb-4 flex items-center gap-2 text-slate-800"><Shield size={20} /> Admin Security</h3>
            <div className="grid md:grid-cols-2 gap-4 max-w-2xl">
                <div><label className="block text-sm font-bold text-white mb-1">New Admin Password</label><input type="text" className="w-full rounded border border-slate-300 p-2 text-white" value={securityForm.admin_password} onChange={e => setSecurityForm({...securityForm, admin_password: e.target.value})} placeholder="Set new password" /></div>
                <div><label className="block text-sm font-bold text-white mb-1">Recovery Key</label><input type="text" className="w-full rounded border border-slate-300 p-2 text-white" value={securityForm.recovery_key} onChange={e => setSecurityForm({...securityForm, recovery_key: e.target.value})} placeholder="Key to reset password" /></div>
            </div>
            <button onClick={handleUpdateSecurity} className="mt-4 bg-slate-50 text-white px-6 py-2 rounded hover:bg-slate-50">Update Credentials</button>
       </div>
    </div>
  );
};

const AuditLogs = ({ db, appId }) => {
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
            <div><label className="text-xs font-bold text-white uppercase">Category</label><select className="w-full rounded border border-slate-300 p-2 text-sm text-white" value={filters.category} onChange={e => setFilters({...filters, category: e.target.value})}><option value="">All Categories</option><option value="projects">Projects</option><option value="clients">Clients</option><option value="inventory">Inventory</option><option value="expenses">Expenses</option><option value="payments">Payments</option><option value="employees">Employees</option><option value="admin">Admin</option></select></div>
            <div><label className="text-xs font-bold text-white uppercase">User (Email)</label><input className="w-full rounded border border-slate-300 p-2 text-sm text-white" placeholder="Search user..." value={filters.user} onChange={e => setFilters({...filters, user: e.target.value})} /></div>
            <div><label className="text-xs font-bold text-white uppercase">From Date</label><input type="date" className="w-full rounded border border-slate-300 p-2 text-sm text-white" value={filters.startDate} onChange={e => setFilters({...filters, startDate: e.target.value})} /></div>
            <div><label className="text-xs font-bold text-white uppercase">To Date</label><input type="date" className="w-full rounded border border-slate-300 p-2 text-sm text-white" value={filters.endDate} onChange={e => setFilters({...filters, endDate: e.target.value})} /></div>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
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

const ProfileSettings = ({ employee, db, appId, logAction }) => {
  const [formData, setFormData] = useState({ name: '', mobile1: '', mobile2: '', address: '', email: '' });
  const [passForm, setPassForm] = useState({ current: '', new: '', confirm: '' });

  useEffect(() => {
    if (employee) {
      setFormData({
        name: employee.name || '', email: employee.email || '',
        mobile1: employee.mobile1 || '', mobile2: employee.mobile2 || '', address: employee.address || ''
      });
    }
  }, [employee]);

  const handleUpdateDetails = async () => {
    if (!employee) return;
    try {
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'employees', employee.id), {
        name: formData.name, mobile1: formData.mobile1, mobile2: formData.mobile2, address: formData.address, updated_at: serverTimestamp()
      });
      logAction('employees', 'profile_update', employee.id, formData, employee.name);
      alert("Profile updated successfully.");
    } catch (e) { console.error(e); alert("Error updating profile."); }
  };

  const handleChangePassword = async () => {
    if (!passForm.current || !passForm.new || !passForm.confirm) return alert("All fields required");
    if (passForm.new !== passForm.confirm) return alert("New passwords do not match");
    if (passForm.current !== employee.password) return alert("Incorrect current password");

    try {
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'employees', employee.id), {
        password: passForm.new, password_updated_at: serverTimestamp()
      });
      logAction('employees', 'password_change_self', employee.id, {}, employee.name);
      alert("Password changed successfully.");
      setPassForm({ current: '', new: '', confirm: '' });
    } catch (e) { console.error(e); alert("Error changing password."); }
  };

  if (!employee) return <div className="p-8 text-center text-slate-500">Profile not available. Please contact admin.</div>;

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h2 className="text-2xl font-bold text-slate-800">My Profile</h2>

      <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
        <h3 className="font-bold text-lg mb-4 text-slate-700">Personal Details</h3>
        <div className="space-y-4">
           <div><label className="block text-sm font-bold text-white">Full Name</label><input className="w-full rounded border border-slate-300 p-2 text-white" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} /></div>
           <div><label className="block text-sm font-bold text-white">Email (Read-Only)</label><input className="w-full rounded border border-slate-300 p-2 bg-slate-50 text-slate-500" value={formData.email} disabled /></div>
           <div className="grid grid-cols-2 gap-4"><div><label className="block text-sm font-bold text-white">Mobile 1</label><input className="w-full rounded border border-slate-300 p-2 text-white" value={formData.mobile1} onChange={e => setFormData({...formData, mobile1: e.target.value})} /></div><div><label className="block text-sm font-bold text-white">Mobile 2</label><input className="w-full rounded border border-slate-300 p-2 text-white" value={formData.mobile2} onChange={e => setFormData({...formData, mobile2: e.target.value})} /></div></div>
           <div><label className="block text-sm font-bold text-white">Address</label><textarea className="w-full rounded border border-slate-300 p-2 text-white" rows={2} value={formData.address} onChange={e => setFormData({...formData, address: e.target.value})} /></div>
           <button onClick={handleUpdateDetails} className="bg-indigo-600 text-white px-4 py-2 rounded hover:bg-indigo-700">Save Changes</button>
        </div>
      </div>
      <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
        <h3 className="font-bold text-lg mb-4 text-slate-700">Security</h3>
        <div className="space-y-4 max-w-md"><div><label className="block text-sm font-bold text-white">Current Password</label><input type="password" className="w-full rounded border border-slate-300 p-2 text-white" value={passForm.current} onChange={e => setPassForm({...passForm, current: e.target.value})} /></div><div><label className="block text-sm font-bold text-white">New Password</label><input type="password" className="w-full rounded border border-slate-300 p-2 text-white" value={passForm.new} onChange={e => setPassForm({...passForm, new: e.target.value})} /></div><div><label className="block text-sm font-bold text-white">Confirm New Password</label><input type="password" className="w-full rounded border border-slate-300 p-2 text-white" value={passForm.confirm} onChange={e => setPassForm({...passForm, confirm: e.target.value})} /></div><button onClick={handleChangePassword} className="bg-red-600 text-white px-4 py-2 rounded hover:bg-red-700">Update Password</button></div>
      </div>
    </div>
  );
};

const ChallanManager = ({ projects, clients, inventory, db, appId, logAction, user }) => {
  const [sortOrder, setSortOrder] = useState('desc'); // 'asc' or 'desc'
  const [searchTerm, setSearchTerm] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editingChallan, setEditingChallan] = useState(null);
  const [challanForm, setChallanForm] = useState({});
  const [challanSelection, setChallanSelection] = useState({});

  const allChallans = useMemo(() => {
    const list = [];
    projects.forEach(p => {
      if (p.challans && p.challans.length > 0) {
        p.challans.forEach(c => {
          list.push({
            ...c,
            projectId: p.id,
            projectName: p.project_name,
            clientId: p.client_id,
            clientName: clients.find(cl => cl.id === p.client_id)?.name || 'Unknown'
          });
        });
      }
    });
    return list.filter(c => 
      (c.challan_no || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (c.clientName || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      (c.projectName || '').toLowerCase().includes(searchTerm.toLowerCase())
    ).sort((a, b) => {
      const valA = a.challan_no || '';
      const valB = b.challan_no || '';
      return sortOrder === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
    });
  }, [projects, clients, sortOrder, searchTerm]);

  const handleExportChallans = (type) => {
    const data = paginatedChallans.map(c => ({
      "Challan No": c.challan_no,
      "Date": new Date(c.date).toLocaleDateString(),
      "Type": c.type,
      "Project": c.projectName,
      "Client": c.clientName,
      "Items": c.items?.length || 0
    }));
    if (type === 'excel') {
      const ws = XLSX.utils.json_to_sheet(data);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Challans");
      XLSX.writeFile(wb, "Challans.xlsx");
    } else {
      const doc = new jsPDF();
      doc.text("Challans List", 14, 15);
      autoTable(doc, { startY: 20, head: [Object.keys(data[0])], body: data.map(Object.values), styles: { fontSize: 8 } });
      doc.save("Challans.pdf");
    }
  };

  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, sortOrder]);

  const paginatedChallans = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return allChallans.slice(start, start + itemsPerPage);
  }, [allChallans, currentPage]);

  const targetProject = useMemo(() => 
    editingChallan ? projects.find(p => p.id === editingChallan.projectId) : null
  , [projects, editingChallan]);

  const getOrgSettings = async () => {
    try {
        const docSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'organization'));
        if (docSnap.exists()) return docSnap.data();
    } catch (e) { console.error(e); }
    return null;
  };

  const getChallanedQty = (project, allocationId, type, excludeChallanId = null) => {
    return (project.challans || [])
        .filter(c => c.type === type && c.id !== excludeChallanId)
        .reduce((acc, c) => {
            const item = c.items.find(i => i.id === allocationId);
            return acc + (item ? (parseInt(item.qty) || 0) : 0);
        }, 0);
  };

  const handleDelete = async (challan) => {
    if(!confirm(`Are you sure you want to delete Challan ${challan.challan_no}?`)) return;
    try {
        const project = projects.find(p => p.id === challan.projectId);
        if (!project) return;
        const originalChallan = project.challans.find(c => c.id === challan.id);
        
        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', challan.projectId), {
            challans: arrayRemove(originalChallan)
        });
        logAction('projects', 'delete_challan', challan.projectId, { challan_no: challan.challan_no }, project.project_name);
    } catch(e) {
        console.error(e);
        alert("Failed to delete challan");
    }
  };

  const openEditModal = (challan) => {
    setEditingChallan(challan);
    setChallanForm({
        ...(challan.transport || {}),
        date: challan.date ? new Date(challan.date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0]
    });
    
    const initialSelection = {};
    const project = projects.find(p => p.id === challan.projectId);
    if (project) {
        (project.items || []).forEach(item => {
            const existing = challan.items.find(i => i.id === item.id);
            initialSelection[item.id] = existing ? existing.qty : 0;
        });
    }
    setChallanSelection(initialSelection);
    setIsEditOpen(true);
  };

  const handleSaveChallan = async () => {
    if (!targetProject) return;
    const itemsToShip = [];
    
    for (const item of (targetProject.items || [])) {
        const qty = parseInt(challanSelection[item.id] || 0);
        if (qty > 0) {
            const excludeId = editingChallan.id;
            const alreadyChallaned = getChallanedQty(targetProject, item.id, editingChallan.type, excludeId);
            
            let maxQty = 0;
            if (editingChallan.type === 'delivery') {
                maxQty = item.qty - alreadyChallaned;
            } else {
                const delivered = getChallanedQty(targetProject, item.id, 'delivery');
                const returned = getChallanedQty(targetProject, item.id, 'return', excludeId);
                maxQty = delivered - returned;
            }

            if (qty > maxQty) {
                alert(`Error: Item "${item.item_name}" exceeds available quantity. Max: ${maxQty}, Requested: ${qty}`);
                return;
            }
            itemsToShip.push({ ...item, qty });
        }
    }

    if (itemsToShip.length === 0) return alert("Please select at least one item.");

    try {
        const originalChallan = targetProject.challans.find(c => c.id === editingChallan.id);

        const updatedChallan = {
            ...originalChallan,
            items: itemsToShip,
            transport: challanForm,
            date: new Date(challanForm.date).toISOString(),
            updated_at: new Date().toISOString()
        };

        const projectRef = doc(db, 'artifacts', appId, 'public', 'data', 'projects', targetProject.id);
        
        await updateDoc(projectRef, { challans: arrayRemove(originalChallan) });
        await updateDoc(projectRef, { challans: arrayUnion(updatedChallan) });
        
        logAction('projects', 'update_challan', targetProject.id, { challan_no: updatedChallan.challan_no }, targetProject.project_name);
        setIsEditOpen(false);
        setEditingChallan(null);
    } catch (e) {
        console.error(e);
        alert(`Error saving challan: ${e.message}`);
    }
  };

  const printChallanPDF = async (challanData) => {
    try {
        const pdfDoc = new jsPDF();
        const pageWidth = pdfDoc.internal.pageSize.width;
        const orgSettings = await getOrgSettings();
        const isReturn = challanData.type === 'return';
        const displayChallanNo = isReturn ? `RET/${challanData.challan_no}` : challanData.challan_no;
        const todayStr = new Date(challanData.date).toLocaleDateString('en-IN');

        let y = 15;
        if (orgSettings?.logo) {
            try {
                pdfDoc.addImage(orgSettings.logo, 'JPEG', 14, 10, 25, 25);
            } catch (e) { console.warn("Logo add failed", e); }
        }
        
        pdfDoc.setFontSize(16);
        pdfDoc.setFont("helvetica", "bold");
        pdfDoc.text(orgSettings?.name || "RENTAL OPS", 45, 18);
        
        pdfDoc.setFontSize(9);
        pdfDoc.setFont("helvetica", "normal");
        const addrLines = pdfDoc.splitTextToSize(orgSettings?.address || "", 100);
        pdfDoc.text(addrLines, 45, 24);
        
        let headerY = 24 + (addrLines.length * 4);
        if (orgSettings?.gstin) pdfDoc.text(`GSTIN: ${orgSettings.gstin}`, 45, headerY);
        if (orgSettings?.pan) pdfDoc.text(`PAN: ${orgSettings.pan}`, 100, headerY);
        
        y = Math.max(y + 25, headerY + 10);

        pdfDoc.setFontSize(14);
        pdfDoc.setFont("helvetica", "bold");
        pdfDoc.text(isReturn ? "RETURN CHALLAN" : "DELIVERY CHALLAN", pageWidth - 14, 20, { align: 'right' });
        pdfDoc.setFontSize(8);
        pdfDoc.setFont("helvetica", "normal");
        pdfDoc.text(isReturn ? "(Material Returning from Project)" : "(Authority to carry inventory for Project Execution)", pageWidth - 14, 25, { align: 'right' });

        pdfDoc.setFontSize(10);
        pdfDoc.text(`Challan No: ${displayChallanNo}`, pageWidth - 14, 32, { align: 'right' });
        pdfDoc.text(`Date: ${todayStr}`, pageWidth - 14, 37, { align: 'right' });

        pdfDoc.setLineWidth(0.5); pdfDoc.line(14, y, pageWidth - 14, y);
        y += 5;

        let client = null;
        let project = null;
        
        if (challanData.clientId) {
             client = clients.find(c => c.id === challanData.clientId);
             const p = projects.find(p => p.id === challanData.projectId);
             if (p) project = p;
             else project = { project_name: challanData.projectName, venue: 'Unknown' };
        } else if (targetProject) {
             client = clients.find(c => c.id === targetProject.client_id);
             project = targetProject;
        }

        pdfDoc.setFontSize(10);
        pdfDoc.setFont("helvetica", "bold");
        pdfDoc.text(isReturn ? "Received From (Client):" : "Consignee (Client):", 14, y);
        pdfDoc.setFont("helvetica", "normal");
        pdfDoc.text(client?.name || '-', 14, y + 5);
        const clientAddr = pdfDoc.splitTextToSize(client?.address || "Address not available", 80);
        pdfDoc.text(clientAddr, 14, y + 10);
        if (client?.gstin) pdfDoc.text(`GSTIN: ${client.gstin}`, 14, y + 10 + (clientAddr.length * 4) + 2);

        pdfDoc.text(`Project: ${project?.project_name || '-'}`, 110, y);
        pdfDoc.text(`Venue: ${project?.venue || '-'}`, 110, y + 5);
        pdfDoc.text(isReturn ? `Return To: ${orgSettings?.address ? 'Warehouse / Office' : 'Warehouse'}` : `Dispatch To: ${challanData.transport?.dispatch_address || project?.venue || '-'}`, 110, y + 10);
        
        y = Math.max(y + 25, y + 10 + (clientAddr.length * 4) + 10);

        const transport = challanData.transport || {};
        pdfDoc.rect(14, y, pageWidth - 28, 18);
        pdfDoc.setFontSize(9);
        pdfDoc.text(`Transport Mode: ${transport.mode || '-'}`, 16, y + 6);
        pdfDoc.text(`Vehicle No: ${transport.vehicle_no || '-'}`, 80, y + 6);
        pdfDoc.text(`E-Way Bill: ${transport.eway_bill || '-'}`, 150, y + 6);
        pdfDoc.text(`Driver: ${transport.driver_name || '-'} (${transport.driver_mobile || '-'})`, 16, y + 12);

        y += 25;
        const items = (challanData.items || []).map((i, idx) => {
            const invItem = inventory.find(inv => inv.id === i.item_id);
            return [
                idx + 1, 
                `${i.item_name}\nSN: ${invItem?.serial_number || '-'}`, 
                invItem?.hsn_code || '-',
                i.qty, 
                `${i.days} Days`,
                formatCurrencyPDF(i.rate),
                formatCurrencyPDF(i.total)
            ];
        });

        autoTable(pdfDoc, { 
            startY: y, 
            head: [['#', 'Description of Goods', 'HSN/SAC', 'Qty', 'Duration', 'Rate', 'Amount']], 
            body: items, 
            theme: 'grid',
            margin: { left: 14, right: 14 },
            styles: { fontSize: 8, cellPadding: 2, overflow: 'linebreak' }, 
            headStyles: { fillColor: [50, 50, 50], textColor: 255 },
            columnStyles: { 
                0: { cellWidth: 8 }, 
                1: { cellWidth: 58 }, 
                2: { cellWidth: 14 },
                3: { cellWidth: 10, halign: 'center' },
                4: { cellWidth: 14, halign: 'center' },
                5: { cellWidth: 18, halign: 'right' },
                6: { cellWidth: 54, halign: 'right', cellPadding: { top: 2, bottom: 2, left: 2, right: 10 } }
            }
        });
        
        let finalY = ((pdfDoc.lastAutoTable && pdfDoc.lastAutoTable.finalY) || y + 50) + 10;

        if (orgSettings?.challan_terms) {
            pdfDoc.setFontSize(9);
            pdfDoc.setFont("helvetica", "bold");
            pdfDoc.text("Terms & Conditions:", 14, finalY);
            pdfDoc.setFont("helvetica", "normal");
            pdfDoc.setFontSize(8);
            const terms = pdfDoc.splitTextToSize(orgSettings.challan_terms, pageWidth - 28);
            pdfDoc.text(terms, 14, finalY + 5);
            finalY += 10 + (terms.length * 3.5);
        }
        
        pdfDoc.setFontSize(8);
        pdfDoc.text("Declaration:", 14, finalY);
        pdfDoc.text(isReturn ? "1. Material returning from project site to warehouse." : "1. The goods are being transported for project execution purpose only and not for sale.", 14, finalY + 5);
        pdfDoc.text(isReturn ? "2. Not for sale." : "2. The goods will be returned to the consignor after completion of the project.", 14, finalY + 9);
        
        pdfDoc.setLineWidth(0.5); 
        pdfDoc.line(14, finalY + 25, 80, finalY + 25); 
        pdfDoc.text("Authorized Signatory", 14, finalY + 30); 
        pdfDoc.text(`For ${orgSettings?.name || 'Company'}`, 14, finalY + 34);

        pdfDoc.line(pageWidth - 90, finalY + 25, pageWidth - 14, finalY + 25); 
        pdfDoc.text(isReturn ? "Sender's Signature (Client)" : "Receiver's Signature & Stamp", pageWidth - 90, finalY + 30);
        
        pdfDoc.save(`${isReturn ? 'Return' : 'Delivery'}_Challan_${displayChallanNo.replace('/','-')}.pdf`);
    } catch (error) {
        console.error("Challan PDF Error:", error);
        alert("Failed to generate Challan PDF. See console for details.");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <h2 className="text-2xl font-bold text-slate-800">Challan Manager</h2>
        <div className="flex gap-2 w-full md:w-auto">
            <div className="flex items-center rounded border px-3 py-1 bg-white flex-1">
                <Search size={16} className="text-slate-400 mr-2" />
                <input placeholder="Search challans..." className="text-sm outline-none" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
            </div>
            <button onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')} className="flex items-center justify-center gap-2 rounded border px-3 py-1 bg-white text-sm hover:bg-slate-50 whitespace-nowrap">
                Sort: {sortOrder === 'asc' ? 'Ascending' : 'Descending'}
            </button>
            <button onClick={() => handleExportChallans('excel')} className="p-2 bg-white border rounded hover:bg-slate-50 text-green-600" title="Export Excel"><FileText size={16}/></button>
            <button onClick={() => handleExportChallans('pdf')} className="p-2 bg-white border rounded hover:bg-slate-50 text-red-600" title="Export PDF"><FileText size={16}/></button>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-slate-700 font-semibold">
            <tr>
              <th className="p-4 font-medium">Challan No</th>
              <th className="p-4 font-medium">Date</th>
              <th className="p-4 font-medium">Type</th>
              <th className="p-4 font-medium">Project</th>
              <th className="p-4 font-medium">Client</th>
              <th className="p-4 font-medium text-center">Items</th>
              <th className="p-4 font-medium text-center">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {paginatedChallans.map((c, idx) => (
              <tr key={idx} className="hover:bg-slate-50">
                <td className="p-4 font-bold text-slate-800">{c.challan_no}</td>
                <td className="p-4 text-slate-600">{new Date(c.date).toLocaleDateString()}</td>
                <td className="p-4"><span className={`px-2 py-1 rounded text-xs font-bold ${c.type === 'return' ? 'bg-orange-100 text-orange-700' : 'bg-blue-100 text-blue-700'}`}>{c.type.toUpperCase()}</span></td>
                <td className="p-4 text-slate-800">{c.projectName}</td>
                <td className="p-4 text-slate-600">{c.clientName}</td>
                <td className="p-4 text-center">{c.items?.length || 0}</td>
                <td className="p-4 text-center">
                    <div className="flex items-center justify-center gap-2">
                        <button onClick={() => printChallanPDF(c)} className="p-1 text-indigo-600 hover:bg-indigo-50 rounded" title="Print"><Printer size={16}/></button>
                        <button onClick={() => openEditModal(c)} className="p-1 text-blue-600 hover:bg-blue-50 rounded" title="Edit"><Edit size={16}/></button>
                        <button onClick={() => handleDelete(c)} className="p-1 text-red-600 hover:bg-red-50 rounded" title="Delete"><Trash2 size={16}/></button>
                    </div>
                </td>
              </tr>
            ))}
            {paginatedChallans.length === 0 && <tr><td colSpan={7} className="p-8 text-center text-slate-400">No challans found.</td></tr>}
          </tbody>
        </table>
        {allChallans.length > 0 && (
          <div className="flex items-center justify-between p-4 border-t bg-slate-50">
            <div className="text-sm text-slate-500">
              Showing {Math.min((currentPage - 1) * itemsPerPage + 1, allChallans.length)} to {Math.min(currentPage * itemsPerPage, allChallans.length)} of {allChallans.length} results
            </div>
            <div className="flex gap-2">
              <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1} className="px-3 py-1 rounded border bg-white hover:bg-slate-50 disabled:opacity-50 text-sm">Previous</button>
              <button onClick={() => setCurrentPage(p => Math.min(Math.ceil(allChallans.length / itemsPerPage), p + 1))} disabled={currentPage === Math.ceil(allChallans.length / itemsPerPage)} className="px-3 py-1 rounded border bg-white hover:bg-slate-50 disabled:opacity-50 text-sm">Next</button>
            </div>
          </div>
        )}
      </div>

      <Modal isOpen={isEditOpen} onClose={() => setIsEditOpen(false)} title={`Edit ${editingChallan?.type === 'return' ? 'Return' : 'Delivery'} Challan`}>
            <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-2">
              <div className="grid grid-cols-2 gap-4">
                <div><label className="text-xs font-bold text-white">Transport Mode</label><select className="w-full rounded border border-slate-300 p-2 text-white" value={challanForm.mode} onChange={e => setChallanForm({ ...challanForm, mode: e.target.value })}><option>Road</option><option>Air</option><option>Train</option><option>Hand Carry</option></select></div>
                <div><label className="text-xs font-bold text-white">Vehicle No</label><input className="w-full rounded border border-slate-300 p-2 text-white" value={challanForm.vehicle_no} onChange={e => setChallanForm({ ...challanForm, vehicle_no: e.target.value })} placeholder="MH-01-AB-1234" /></div>
                <div><label className="text-xs font-bold text-white">Driver Name</label><input className="w-full rounded border border-slate-300 p-2 text-white" value={challanForm.driver_name} onChange={e => setChallanForm({ ...challanForm, driver_name: e.target.value })} /></div>
                <div><label className="text-xs font-bold text-white">Driver Mobile</label><input className="w-full rounded border border-slate-300 p-2 text-white" value={challanForm.driver_mobile} onChange={e => setChallanForm({ ...challanForm, driver_mobile: e.target.value })} /></div>
                <div><label className="text-xs font-bold text-white">E-Way Bill No</label><input className="w-full rounded border border-slate-300 p-2 text-white" value={challanForm.eway_bill} onChange={e => setChallanForm({ ...challanForm, eway_bill: e.target.value })} /></div>
                <div><label className="text-xs font-bold text-white">Dispatch Address</label><input className="w-full rounded border border-slate-300 p-2 text-white" value={challanForm.dispatch_address} onChange={e => setChallanForm({ ...challanForm, dispatch_address: e.target.value })} placeholder="Leave empty for Venue" /></div>
                <div><label className="text-xs font-bold text-white">Challan Date</label><input type="date" className="w-full rounded border border-slate-300 p-2 text-white" value={challanForm.date} onChange={e => setChallanForm({ ...challanForm, date: e.target.value })} /></div>
              </div>
              
              <div className="border-t pt-4">
                <h4 className="text-sm font-bold text-slate-700 mb-2">Select Items to Include</h4>
                <div className="border rounded overflow-hidden">
                    <table className="w-full text-xs text-left text-slate-600">
                        <thead className="bg-slate-50 text-slate-500"><tr><th className="p-2 w-8"></th><th className="p-2">Item</th><th className="p-2 text-center">Total</th><th className="p-2 text-center">{editingChallan?.type === 'delivery' ? 'Sent' : 'Returned'}</th><th className="p-2 text-center">Avail</th><th className="p-2 w-20">Current</th></tr></thead>
                        <tbody className="divide-y divide-slate-100">
                            {(targetProject?.items || []).map(item => {
                                const excludeId = editingChallan ? editingChallan.id : null;
                                const alreadyChallaned = getChallanedQty(targetProject, item.id, editingChallan?.type, excludeId);
                                let maxQty = 0;
                                if (editingChallan?.type === 'delivery') maxQty = item.qty - alreadyChallaned;
                                else {
                                    const delivered = getChallanedQty(targetProject, item.id, 'delivery');
                                    const returned = getChallanedQty(targetProject, item.id, 'return', excludeId);
                                    maxQty = delivered - returned;
                                }
                                return (
                                    <tr key={item.id} className={challanSelection[item.id] > 0 ? 'bg-indigo-50' : ''}>
                                        <td className="p-2"><input type="checkbox" checked={challanSelection[item.id] > 0} onChange={e => setChallanSelection({...challanSelection, [item.id]: e.target.checked ? maxQty : 0})} disabled={maxQty <= 0 && !challanSelection[item.id]} /></td>
                                        <td className="p-2">{item.item_name}</td>
                                        <td className="p-2 text-center">{item.qty}</td>
                                        <td className="p-2 text-center">{alreadyChallaned}</td>
                                        <td className="p-2 text-center font-bold">{maxQty}</td>
                                        <td className="p-2"><input type="number" min="0" max={maxQty} className="w-full border rounded p-1" value={challanSelection[item.id] || 0} onChange={e => setChallanSelection({...challanSelection, [item.id]: parseInt(e.target.value) || 0})} /></td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
              </div>

              <div className="flex gap-2">
                <button onClick={handleSaveChallan} className="w-full rounded bg-indigo-600 py-2 text-white font-bold hover:bg-indigo-700">Update Challan</button>
              </div>
            </div>
        </Modal>
    </div>
  );
};

// REPORTS VERSION 2.0.0


//version 1.1.0   reports, employee mgmt, expense mgmt, inventory mgmt

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState(null); 
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [currentEmpId, setCurrentEmpId] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState(null);
  const [showForgotPass, setShowForgotPass] = useState(false);
  const [showEmpForgotPass, setShowEmpForgotPass] = useState(false);
  const [recoveryForm, setRecoveryForm] = useState({ key: '', new_pass: '' });
  const [resetRequestEmail, setResetRequestEmail] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [toasts, setToasts] = useState([]);

  // Login Form State
  const [loginForm, setLoginForm] = useState({ username: '', password: '' });
  const [loginError, setLoginError] = useState('');

  // Data States
  const [projects, setProjects] = useState([]);
  const [clients, setClients] = useState([]);
  const [inventory, setInventory] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [advances, setAdvances] = useState([]);
// Inside App function, add these:
//version 1.3.0 finance implementation enabled code
const [payments, setPayments] = useState([]);
const [payouts, setPayouts] = useState([]);
//version 1.3.0 finance implementation enabled code
  // --- Auth & Data Fetching ---

  const currentEmployee = employees.find(e => e.id === currentEmpId);

  useEffect(() => {
    const initAuth = async () => {
      if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
        await signInWithCustomToken(auth, __initial_auth_token);
      } else {
        await signInAnonymously(auth);
      }
    };
    initAuth();
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (!u) setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (!user) return;
    
    // Only fetch data if logged in (role is set) or to check login
    // Fetching employees is needed for login check
    const unsubEmployees = onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', 'employees'), (snap) => {
      setEmployees(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });

    if (!role) {
      setLoading(false); // Stop loading to show login screen
      return () => unsubEmployees();
    }

    const unsubProjects = onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', 'projects'), (snap) => setProjects(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
    const unsubClients = onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', 'clients'), (snap) => setClients(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
    const unsubInventory = onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', 'inventory'), (snap) => {
      setInventory(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });
    const unsubExpenses = onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', 'expenses'), (snap) => setExpenses(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
    const unsubAdvances = onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', 'advances'), (snap) => {
      setAdvances(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    }); 
    //version 1.3.0 finance implementation enabled code
    const unsubPayments = onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', 'payments'), (snap) => setPayments(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
    const unsubPayouts = onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', 'payouts'), (snap) => setPayouts(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
//version 1.3.0 finance implementation enabled code

    setLoading(false);
//  //version 1.3.0 finance implementation depcreated code
    // return () => {
    //   unsubProjects(); unsubClients(); unsubInventory(); unsubExpenses(); unsubEmployees(); unsubAdvances();
    // };
//version 1.3.0 finance implementation depcreated code

  //version 1.3.0 finance implementation enabled code
    return () => {
    unsubProjects(); unsubClients(); unsubInventory(); unsubExpenses(); 
    unsubEmployees(); unsubAdvances(); unsubPayments(); unsubPayouts(); // Add cleanups
    };  
      //version 1.3.0 finance implementation enabled code
  }, [user, role]);

  useEffect(() => {
    const storedUid = localStorage.getItem('rentalOpsUser');
    if (storedUid && employees.length > 0 && !role) {
       if (storedUid === 'admin_temp') {
          setRole('admin');
          setCurrentEmpId('admin_temp');
       } else {
          const emp = employees.find(e => e.id === storedUid);
          if (emp) {
             if (emp.status === 'Disabled' || emp.status === 'Deactivated') {
                localStorage.removeItem('rentalOpsUser');
             } else {
                setRole(emp.role);
                setCurrentEmpId(emp.id);
             }
          }
       }
    }
  }, [employees, role]);

  const addToast = (msg, type = 'info') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, msg, type }]);
  };

  const logAction = async (collectionName, action, docId, data, docName = '') => {
    if (!user) return;
    try {
      await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'audit_logs'), {
        collection: collectionName,
        action: action,
        doc_id: docId,
        doc_name: docName,
        details: data,
        performed_by: user.email || user.uid,
        timestamp: new Date().toISOString()
      });
    } catch (e) {
      console.error("Audit Log Error", e);
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginError('');
    const { username, password } = { username: loginForm.username.trim(), password: loginForm.password };

    // Admin Check with Employee Matching
    if (username === 'admin') {
      let adminPass = 'admin123';
      try {
        const secSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'security'));
        if (secSnap.exists()) {
            adminPass = secSnap.data().admin_password || 'admin123';
        }
      } catch (err) { console.error("Error fetching admin settings", err); }

      if (password === adminPass) {
      setRole('admin');
      
      // Try to find the Admin employee record to link for ledger
      const adminEmp = employees.find(e => e.email === 'admin@rentalops.com' || e.role === 'admin');
      if (adminEmp) {
        setCurrentEmpId(adminEmp.id);
      } else {
        // If seeded admin isn't loaded yet or deleted, we can't link to a specific ID for ledger
        // Fallback: don't set a currentEmpId, or set a temp one. 
        // Best practice: The SEED_EMPLOYEES ensures admin exists.
        console.warn("Admin employee record not found for ledger linking.");
        setCurrentEmpId('admin_temp'); 
      }
      if (rememberMe) localStorage.setItem('rentalOpsUser', adminEmp ? adminEmp.id : 'admin_temp');
      return;
    }
    }

    // Employee Check
    const emp = employees.find(e => e.username === username || e.email === username);
    if (emp) {
      if (emp.is_locked) {
        setLoginError('Account is locked due to multiple failed attempts. Contact Admin.');
        return;
      }

      const validPass = emp.password || 'psw123'; 
      if (password === validPass) {
        if (emp.status === 'Disabled' || emp.status === 'Deactivated') {
          setLoginError('Account is disabled. Contact Admin.');
          return;
        }
        
        if (emp.failed_login_attempts > 0) {
            updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'employees', emp.id), { failed_login_attempts: 0 });
        }

        setRole(emp.role);
        setCurrentEmpId(emp.id);
        if (rememberMe) localStorage.setItem('rentalOpsUser', emp.id);
        return;
      } else {
        const attempts = (emp.failed_login_attempts || 0) + 1;
        if (attempts >= 5) {
            await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'employees', emp.id), { is_locked: true, failed_login_attempts: attempts });
            logAction('employees', 'lockout', emp.id, { attempts }, emp.name);
            setLoginError('Account Locked. Contact Admin.');
        } else {
            await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'employees', emp.id), { failed_login_attempts: attempts });
            setLoginError(`Invalid password. ${5 - attempts} attempts remaining.`);
        }
        return;
      }
    }

    setLoginError('Invalid username or password');
  };

  const handleRecovery = async () => {
    if (!recoveryForm.key || !recoveryForm.new_pass) return alert("Enter Recovery Key and New Password");
    try {
        const secRef = doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'security');
        const secSnap = await getDoc(secRef);
        const validKey = secSnap.exists() ? secSnap.data().recovery_key : 'rentalops'; // Default key if not set
        
        if (recoveryForm.key === validKey) {
            await setDoc(secRef, { admin_password: recoveryForm.new_pass, recovery_key: validKey });
            alert("Password Reset Successfully. Please Login.");
            setShowForgotPass(false);
        } else { alert("Invalid Recovery Key"); }
    } catch (e) { console.error(e); alert("Recovery Failed"); }
  };

  const handleEmpResetRequest = () => {
    if (!resetRequestEmail) return alert("Please enter your email or username");
    const emp = employees.find(e => e.email === resetRequestEmail || e.username === resetRequestEmail);
    
    if (!emp) return alert("No employee found with this email/username.");
    
    const admin = employees.find(e => e.role === 'admin') || { email: 'admin@rentalops.com' };
    const subject = `Password Reset Request: ${emp.name}`;
    const body = `Hello Admin,\n\nI (${emp.name}) have forgotten my password. Please reset it for me.\n\nUsername: ${emp.username}\nEmail: ${emp.email}`;
    
    window.location.href = `mailto:${admin.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    setShowEmpForgotPass(false); setResetRequestEmail('');
  };

  const handleLogout = () => {
    setRole(null);
    setCurrentEmpId(null);
    setLoginForm({ username: '', password: '' });
    localStorage.removeItem('rentalOpsUser');
  };

  const onProjectClick = (id) => {
    setSelectedProjectId(id);
  };

  if (loading) return <LoadingSpinner />;

  if (!user || !role) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-100 p-4">
        <div className="w-full max-w-md rounded-xl bg-white p-8 shadow-lg">
          <div className="mb-6 flex justify-center"><div className="flex h-16 w-16 items-center justify-center rounded-full bg-indigo-600"><Box className="h-8 w-8 text-white" /></div></div>
          <h1 className="mb-2 text-center text-2xl font-bold text-slate-800">RentalOps</h1>
          <p className="mb-6 text-center text-slate-500">Sign in to your account</p>
          
          <form onSubmit={handleLogin} className="space-y-4">
             <div>
               <label className="block text-sm font-bold text-slate-800 mb-1">Username / Email</label>
               <input 
                 className="w-full rounded border p-3 outline-none focus:border-indigo-500 text-black" 
                 placeholder="admin or email@example.com"
                 value={loginForm.username}
                 onChange={e => setLoginForm({...loginForm, username: e.target.value})}
               />
             </div>
             <div>
               <label className="block text-sm font-bold text-slate-800 mb-1">Password</label>
               <input 
                 type="password"
                 className="w-full rounded border p-3 outline-none focus:border-indigo-500 text-black" 
                 placeholder="••••••••"
                 value={loginForm.password}
                 onChange={e => setLoginForm({...loginForm, password: e.target.value})}
               />
             </div>
             <div className="flex items-center gap-2">
                <input type="checkbox" id="rememberMe" checked={rememberMe} onChange={e => setRememberMe(e.target.checked)} className="rounded border-slate-300" />
                <label htmlFor="rememberMe" className="text-sm text-slate-600">Remember Me</label>
             </div>
             {loginError && <div className="text-red-500 text-sm bg-red-50 p-2 rounded text-center">{loginError}</div>}
             <button type="submit" className="w-full bg-indigo-600 text-white p-3 rounded font-medium hover:bg-indigo-700 transition">Sign In</button>
             <div className="flex justify-between text-sm mt-4">
                <button type="button" onClick={() => setShowEmpForgotPass(true)} className="text-indigo-600 hover:underline">Forgot Employee Password?</button>
                <button type="button" onClick={() => setShowForgotPass(true)} className="text-slate-500 hover:underline">Admin Recovery</button>
             </div>
          </form>
        </div>
        <Modal isOpen={showForgotPass} onClose={() => setShowForgotPass(false)} title="Admin Password Recovery">
            <div className="space-y-4">
                <div><label className="text-sm font-medium">Recovery Key</label><input type="password" className="w-full rounded border p-2 text-black" value={recoveryForm.key} onChange={e => setRecoveryForm({...recoveryForm, key: e.target.value})} placeholder="Enter Recovery Key" /></div>
                <div><label className="text-sm font-medium">New Password</label><input type="password" className="w-full rounded border p-2 text-black" value={recoveryForm.new_pass} onChange={e => setRecoveryForm({...recoveryForm, new_pass: e.target.value})} placeholder="Set New Password" /></div>
                <button onClick={handleRecovery} className="w-full rounded bg-red-600 text-white py-2 hover:bg-red-700">Reset Password</button>
            </div>
        </Modal>
        <Modal isOpen={showEmpForgotPass} onClose={() => setShowEmpForgotPass(false)} title="Employee Password Reset">
            <div className="space-y-4">
                <p className="text-sm text-slate-600">Enter your registered email or username. We will draft an email to the administrator requesting a password reset.</p>
                <div><label className="text-sm font-medium">Email / Username</label><input className="w-full rounded border p-2 text-black" value={resetRequestEmail} onChange={e => setResetRequestEmail(e.target.value)} placeholder="Enter email or username" /></div>
                <button onClick={handleEmpResetRequest} className="w-full rounded bg-indigo-600 text-white py-2 hover:bg-indigo-700">Request Reset via Email</button>
            </div>
        </Modal>
      </div>
    );
  }

  return (
    <Router>
    <div className="flex h-screen w-full bg-slate-50 text-white font-sans overflow-hidden">
      <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2">
        {toasts.map(t => (
          <Toast key={t.id} message={t.msg} type={t.type} onClose={() => setToasts(p => p.filter(x => x.id !== t.id))} />
        ))}
      </div>
      <aside className="hidden w-64 flex-col border-r bg-white md:flex shadow-sm z-10">
        <div className="flex h-16 items-center px-6 font-bold text-xl text-indigo-600 tracking-tight">TERMS <span className="ml-2 text-xs font-normal text-slate-400 border border-slate-200 rounded px-1">v3.5.0</span></div>
        <div className="flex-1 space-y-1 p-4">
          <NavItem to="/dashboard" setMobileMenuOpen={setMobileMenuOpen} icon={LayoutDashboard} label="Dashboard" />
          <NavItem to="/projects" setMobileMenuOpen={setMobileMenuOpen} icon={Calendar} label="Projects" />
          <NavItem to="/outsourcing" setMobileMenuOpen={setMobileMenuOpen} icon={ShoppingBag} label="Outsource" />
          <NavItem to="/clients" setMobileMenuOpen={setMobileMenuOpen} icon={Users} label="Clients" />
          <NavItem to="/inventory" setMobileMenuOpen={setMobileMenuOpen} icon={Box} label="Inventory" />
          <NavItem to="/expenses" setMobileMenuOpen={setMobileMenuOpen} icon={DollarSign} label="Expenses" />
          {role === 'admin' && (<><div className="my-2 border-t border-slate-100"></div><NavItem to="/employees" setMobileMenuOpen={setMobileMenuOpen} icon={UserCog} label="Employees" badge={employees.filter(e => e.is_locked).length} /><NavItem to="/challans" setMobileMenuOpen={setMobileMenuOpen} icon={ClipboardList} label="Challans" /><NavItem to="/reports" setMobileMenuOpen={setMobileMenuOpen} icon={FileText} label="Reports" /><NavItem to="/admin" setMobileMenuOpen={setMobileMenuOpen} icon={Settings} label="Admin" /></>)}
        
        {(role === 'admin' || role === 'manager') && (
         <NavItem to="/finance" setMobileMenuOpen={setMobileMenuOpen} icon={Wallet} label="Finance" />
        )}
        {role === 'admin' && <NavItem to="/audit" setMobileMenuOpen={setMobileMenuOpen} icon={Activity} label="Audit Logs" />}
        </div>
        <div className="border-t p-4">
          <Link to="/profile" onClick={() => setMobileMenuOpen(false)} className="mb-2 flex w-full items-center gap-3 px-2 hover:bg-slate-50 hover:bg-slate-50 rounded p-2 text-left transition-colors group">
            <div className={`h-8 w-8 rounded-full flex items-center justify-center text-white text-xs font-bold ${role==='admin'?'bg-red-500':role==='manager'?'bg-blue-500':'bg-green-500'}`}>{role[0].toUpperCase()}</div>
            <div className="flex-1">
              <div className="text-sm font-medium capitalize">{role}</div>
              <div className="text-xs text-slate-400 group-hover:text-indigo-600">View Profile</div>
            </div>
            <Settings size={16} className="text-slate-400 group-hover:text-indigo-600" />
          </Link>
          <button onClick={handleLogout} className="flex w-full items-center gap-2 rounded p-2 text-sm text-red-600 hover:bg-red-50"><LogOut size={16} /> Sign Out</button>
        </div>
      </aside>
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-16 items-center justify-between border-b bg-white px-4 md:hidden shadow-sm z-20"><div className="font-bold text-indigo-600">TERMS</div><button onClick={() => setMobileMenuOpen(true)} className="p-2 text-slate-600"><Menu /></button></header>
        {mobileMenuOpen && (
          <div className="fixed inset-0 z-50 flex md:hidden">
            <div className="fixed inset-0 bg-black/50 backdrop-blur-sm transition-opacity" onClick={() => setMobileMenuOpen(false)}></div>
            <div className="relative flex w-64 flex-col bg-white shadow-xl h-full transform transition-transform">
              <div className="flex h-16 items-center justify-between px-6 border-b">
                 <div className="font-bold text-xl text-indigo-600 tracking-tight">TERMS <span className="ml-2 text-xs font-normal text-slate-400 border border-slate-200 rounded px-1">v3.5.0</span></div>
                 <button onClick={() => setMobileMenuOpen(false)} className="text-slate-500 hover:text-slate-700"><X size={20}/></button>
              </div>
              
              <div className="flex-1 overflow-y-auto p-4 space-y-1">
                  <NavItem id="dashboard" activeTab={activeTab} setActiveTab={setActiveTab} setMobileMenuOpen={setMobileMenuOpen} icon={LayoutDashboard} label="Dashboard" />
                  <NavItem id="projects" activeTab={activeTab} setActiveTab={setActiveTab} setMobileMenuOpen={setMobileMenuOpen} icon={Calendar} label="Projects" />
                  <NavItem id="outsourcing" activeTab={activeTab} setActiveTab={setActiveTab} setMobileMenuOpen={setMobileMenuOpen} icon={ShoppingBag} label="Outsource" />
                  <NavItem id="clients" activeTab={activeTab} setActiveTab={setActiveTab} setMobileMenuOpen={setMobileMenuOpen} icon={Users} label="Clients" />
                  <NavItem id="inventory" activeTab={activeTab} setActiveTab={setActiveTab} setMobileMenuOpen={setMobileMenuOpen} icon={Box} label="Inventory" />
                  <NavItem id="expenses" activeTab={activeTab} setActiveTab={setActiveTab} setMobileMenuOpen={setMobileMenuOpen} icon={DollarSign} label="Expenses" />
                  {(role === 'admin' || role === 'manager') && (
                    <NavItem id="finance" activeTab={activeTab} setActiveTab={setActiveTab} setMobileMenuOpen={setMobileMenuOpen} icon={Wallet} label="Finance" />
                  )}
                  {role === 'admin' && (
                    <>
                      <div className="my-2 border-t border-slate-100"></div>
                      <NavItem id="employees" activeTab={activeTab} setActiveTab={setActiveTab} setMobileMenuOpen={setMobileMenuOpen} icon={UserCog} label="Employees" badge={employees.filter(e => e.is_locked).length} />
                      <NavItem id="challans" activeTab={activeTab} setActiveTab={setActiveTab} setMobileMenuOpen={setMobileMenuOpen} icon={ClipboardList} label="Challans" />
                      <NavItem id="reports" activeTab={activeTab} setActiveTab={setActiveTab} setMobileMenuOpen={setMobileMenuOpen} icon={FileText} label="Reports" />
                      <NavItem id="admin" activeTab={activeTab} setActiveTab={setActiveTab} setMobileMenuOpen={setMobileMenuOpen} icon={Settings} label="Admin" />
                      <NavItem id="audit" activeTab={activeTab} setActiveTab={setActiveTab} setMobileMenuOpen={setMobileMenuOpen} icon={Activity} label="Audit Logs" />
                    </>
                  )}
              </div>

              <div className="border-t p-4">
                  <button onClick={() => { setActiveTab('profile'); setMobileMenuOpen(false); }} className="mb-2 flex w-full items-center gap-3 px-2 hover:bg-slate-50 rounded p-2 text-left transition-colors group">
                    <div className={`h-8 w-8 rounded-full flex items-center justify-center text-white text-xs font-bold ${role==='admin'?'bg-red-500':role==='manager'?'bg-blue-500':'bg-green-500'}`}>{role[0].toUpperCase()}</div>
                    <div className="flex-1">
                      <div className="text-sm font-medium capitalize">{role}</div>
                      <div className="text-xs text-slate-400 group-hover:text-indigo-600">View Profile</div>
                    </div>
                    <Settings size={16} className="text-slate-400 group-hover:text-indigo-600" />
                  </button>
                  <button onClick={handleLogout} className="flex w-full items-center gap-2 rounded p-2 text-sm text-red-600 hover:bg-red-50"><LogOut size={16} /> Sign Out</button>
              </div>
            </div>
          </div>
        )}
        <main className="flex-1 overflow-y-auto p-4 md:p-8 relative">
          <div className="mx-auto max-w-5xl">
            <Routes>
              <Route path="/" element={<Navigate to="/dashboard" />} />
              <Route path="/dashboard" element={<Dashboard projects={projects} expenses={expenses} role={role} clients={clients} onProjectClick={(id) => setSelectedProjectId(id)} employees={employees} payments={payments} />} />
              <Route path="/projects" element={<Projects projects={projects} clients={clients} inventory={inventory} expenses={expenses} employees={employees} role={role} user={user} db={db} appId={appId} selectedProjectId={selectedProjectId} setSelectedProjectId={setSelectedProjectId} logAction={logAction} addToast={addToast} />} />
              <Route path="/outsourcing" element={<Outsourcing projects={projects} clients={clients} inventory={inventory} role={role} db={db} appId={appId} logAction={logAction} />} />
              <Route path="/clients" element={<Clients clients={clients} inventory={inventory} role={role} db={db} appId={appId} logAction={logAction} />} />
              <Route path="/inventory" element={<Inventory inventory={inventory} clients={clients} role={role} db={db} appId={appId} logAction={logAction} />} />
              <Route path="/expenses" element={<Expenses expenses={expenses} projects={projects} user={user} role={role} db={db} appId={appId} advances={advances} currentEmpId={currentEmpId} employees={employees} logAction={logAction} />} />
              <Route path="/employees" element={<Employees employees={employees} role={role} db={db} appId={appId} advances={advances} logAction={logAction} />} />
              <Route path="/admin" element={<AdminTools db={db} appId={appId} logAction={logAction} />} />
              <Route path="/finance" element={<Finance clients={clients} employees={employees} projects={projects} payments={payments} payouts={payouts} vendorPayments={vendorPayments} expenses={expenses} advances={advances} role={role} db={db} appId={appId} user={user} logAction={logAction} />} />
              <Route path="/reports" element={<Reports projects={projects} clients={clients} employees={employees} expenses={expenses} inventory={inventory} payments={payments} vendorPayments={vendorPayments} payouts={payouts} advances={advances} />} />
              <Route path="/challans" element={<ChallanManager projects={projects} clients={clients} inventory={inventory} db={db} appId={appId} logAction={logAction} user={user} />} />
              <Route path="/audit" element={<AuditLogs db={db} appId={appId} />} />
              <Route path="/profile" element={<ProfileSettings employee={currentEmployee} db={db} appId={appId} logAction={logAction} darkMode={darkMode} setDarkMode={setDarkMode} />} />
            </Routes>
          </div>
        </main>
      </div>
    </div>
    </Router>
  );
}
