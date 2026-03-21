// VERSION 3.0.0 FULL APP WITH FIREBASE INTEGRATION AND REACT FRONTEND
// VERSION 3.1.0 ADMIN DATABASE BACKUP AND RESTORE OPTION ADDED
import React, { useState, useEffect, useMemo } from 'react';
import { 
  LayoutDashboard, Box, Users, Calendar, FileText, 
  DollarSign, CheckCircle, AlertTriangle, Menu, X, 
  LogOut, Plus, Search, Filter, Upload, Image as ImageIcon,
  ChevronRight, ArrowLeft, Save, Trash2, MapPin, Edit, History,
  Phone, Mail, User, UserCog, Key, Shield, MoreVertical, Truck,
  Utensils, Hotel, Hammer, Briefcase, AlertCircle, Wallet, CreditCard,
  TrendingUp, TrendingDown, ShoppingBag, Percent, Calculator, Camera, FileCheck, Download, Settings
} from 'lucide-react';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell 
} from 'recharts';


import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';
//import { saveAs } from 'file-saver';

import { initializeApp } from 'firebase/app';
import { getAnalytics } from "firebase/analytics";

import { 
  getAuth, signInAnonymously, onAuthStateChanged, signOut, signInWithCustomToken 
} from 'firebase/auth';
import { 
  getFirestore, collection, addDoc, updateDoc, doc, 
  deleteDoc, onSnapshot, query, where, serverTimestamp, setDoc, getDoc, arrayUnion, arrayRemove, getDocs
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

const CATEGORIES = ['Sound', 'Lighting', 'Video', 'Camera', 'Trussing', 'Projectors', 'LED', 'Power'];
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

// --- Shared Components ---

const LoadingSpinner = () => (
  <div className="flex h-screen items-center justify-center bg-slate-50">
    <div className="h-12 w-12 animate-spin rounded-full border-4 border-slate-300 border-t-indigo-600"></div>
  </div>
);

const Modal = ({ isOpen, onClose, title, children }) => {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-lg bg-white shadow-xl flex flex-col">
        <div className="flex items-center justify-between border-b p-4 shrink-0">
          <h3 className="text-lg font-semibold">{title}</h3>
          <button onClick={onClose} className="rounded-full p-1 hover:bg-slate-100"><X size={20} /></button>
        </div>
        <div className="p-4 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
};

const NavItem = ({ id, activeTab, setActiveTab, setMobileMenuOpen, icon: Icon, label }) => (
  <button 
    onClick={() => { setActiveTab(id); setMobileMenuOpen(false); }} 
    className={`flex w-full items-center gap-3 rounded-lg p-3 transition-colors ${activeTab === id ? 'bg-indigo-50 text-indigo-600' : 'text-slate-600 hover:bg-slate-50'}`}
  >
    <Icon size={20} />
    <span className="font-medium">{label}</span>
  </button>
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

const Dashboard = ({ projects, expenses, role, clients }) => {
  const [currentMonth, setCurrentMonth] = useState(new Date());

  const activeProjects = projects.filter(p => ['Confirmed', 'Ongoing'].includes(p.status)).length;
  const pendingQuotes = projects.filter(p => p.status === 'Quoted').length;
  const totalExpenses = expenses.reduce((sum, e) => sum + parseFloat(e.amount || 0), 0);
  const revenue = projects.filter(p => p.status === 'Completed' || p.status === 'Closed').reduce((sum, p) => sum + getProjectGrandTotal(p), 0);

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
  const calendarDays = useMemo(() => {
    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const days = [];
    
    for(let i=0; i<firstDay.getDay(); i++) days.push(null);
    for(let i=1; i<=lastDay.getDate(); i++) days.push(new Date(year, month, i));
    return days;
  }, [currentMonth]);

  const getProjectsForDay = (date) => {
    if(!date) return [];
    return projects.filter(p => {
        const start = p.setup_date ? new Date(p.setup_date) : new Date(p.start_date);
        const end = new Date(p.end_date);
        const d = new Date(date);
        d.setHours(0,0,0,0); start.setHours(0,0,0,0); end.setHours(0,0,0,0);
        return d >= start && d <= end;
    });
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
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <div className="rounded-xl bg-white p-4 shadow-sm border border-slate-100">
          <div className="text-sm text-slate-500">Active Events</div>
          <div className="mt-1 text-2xl font-bold text-blue-600">{activeProjects}</div>
        </div>
        <div className="rounded-xl bg-white p-4 shadow-sm border border-slate-100">
          <div className="text-sm text-slate-500">Pending Quotes</div>
          <div className="mt-1 text-2xl font-bold text-orange-600">{pendingQuotes}</div>
        </div>
        {(role === 'admin' || role === 'manager') && (
          <div className="rounded-xl bg-white p-4 shadow-sm border border-slate-100">
            <div className="text-sm text-slate-500">Pending Expenses</div>
            <div className="mt-1 text-2xl font-bold text-red-600">
              {expenses.filter(e => e.status === 'Pending').length}
            </div>
          </div>
        )}
        {role === 'admin' && (
           <div className="rounded-xl bg-white p-4 shadow-sm border border-slate-100">
           <div className="text-sm text-slate-500">Gross Revenue</div>
           <div className="mt-1 text-xl font-bold text-green-700">{formatCurrency(revenue)}</div>
         </div>
        )}
      </div>

      {role === 'admin' && (
        <div className="rounded-xl bg-white p-6 shadow-sm border border-slate-100">
          <h3 className="mb-4 font-semibold text-slate-700">Monthly Revenue</h3>
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
      <div className="rounded-xl bg-white shadow-sm border border-slate-100 p-6">
          <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-slate-700">Project Calendar</h3>
              <div className="flex items-center gap-4">
                  <button onClick={() => changeMonth(-1)} className="p-1 hover:bg-slate-100 rounded"><ChevronRight className="rotate-180" size={20}/></button>
                  <span className="font-bold text-slate-800">{currentMonth.toLocaleString('default', { month: 'long', year: 'numeric' })}</span>
                  <button onClick={() => changeMonth(1)} className="p-1 hover:bg-slate-100 rounded"><ChevronRight size={20}/></button>
              </div>
          </div>
          <div className="grid grid-cols-7 gap-px bg-slate-200 border border-slate-200 rounded overflow-hidden">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
                  <div key={d} className="bg-slate-50 p-2 text-center text-xs font-bold text-slate-500 uppercase">{d}</div>
              ))}
              {calendarDays.map((date, idx) => (
                  <div key={idx} className="bg-white min-h-[100px] p-1 relative group">
                      {date && (
                          <>
                              <div className={`text-xs font-medium mb-1 ${date.toDateString() === new Date().toDateString() ? 'bg-indigo-600 text-white w-6 h-6 rounded-full flex items-center justify-center' : 'text-slate-400'}`}>
                                  {date.getDate()}
                              </div>
                              <div className="space-y-1 overflow-y-auto max-h-[80px]">
                                  {getProjectsForDay(date).map(p => (
                                      <div key={p.id} className={`text-[10px] p-1 rounded border truncate cursor-pointer ${STATUS_COLORS[p.status]}`} title={`${p.project_name} | ${clients.find(c=>c.id===p.client_id)?.name} | ${p.venue}`}>
                                          <div className="font-bold truncate">{clients.find(c=>c.id===p.client_id)?.name || 'Unknown'}</div>
                                          <div className="truncate opacity-75">{p.venue}</div>
                                      </div>
                                  ))}
                              </div>
                          </>
                      )}
                  </div>
              ))}
          </div>
      </div>

      <div className="rounded-xl bg-white shadow-sm border border-slate-100">
        <div className="border-b p-4">
          <h3 className="font-semibold text-slate-700">Recent & Upcoming (Setup +/- 7 Days)</h3>
        </div>
        <div className="divide-y">
          {recentProjects.map(project => (
            <div key={project.id} className="flex items-center justify-between p-4 hover:bg-slate-50">
              <div>
                <div className="font-medium text-slate-800">{project.project_name}</div>
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

const Clients = ({ clients, role, db, appId }) => {
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [formData, setFormData] = useState({ 
    name: '', type: 'Client', gstin: '', state: '', address: '', contacts: [],
    billing_terms: 'Net 15', custom_terms: '', remarks: ''
  });
  const [newContact, setNewContact] = useState({ name: '', role: '', phone: '', email: '' });

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
    if(!confirm("Are you sure you want to delete this client?")) return;
    await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'clients', id));
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
    } else {
      await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'clients'), { ...data, created_at: serverTimestamp() });
    }
    setIsAddOpen(false);
  };

  const filteredClients = clients.filter(client => 
    client.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-slate-800">Clients & Vendors</h2>
        <div className="flex gap-2">
          <div className="hidden md:flex items-center rounded border px-3 py-1 bg-white">
            <Search size={16} className="text-slate-400 mr-2" />
            <input placeholder="Search..." className="text-sm outline-none" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
          </div>
          {role !== 'tech' && role !== 'auditor' && (
            <button onClick={openAdd} className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-white hover:bg-indigo-700"><Plus size={18} /> Add New</button>
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
                    <div>{GST_STATE_CODES[client.gstin?.substring(0,2)] || 'Unknown State'}</div>
                    <div className="text-slate-500 text-xs mt-1">{client.address || 'No address provided'}</div>
                  </div>
                </div>
              </div>
            </div>
            <div className="mt-4 border-t pt-3">
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
          </div>
        ))}
      </div>
      <Modal isOpen={isAddOpen} onClose={() => setIsAddOpen(false)} title={editingId ? "Edit Client/Vendor" : "Add Client/Vendor"}>
        <div className="space-y-6">
          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-white border-b pb-1">Basic Details</h4>
            <div className="grid grid-cols-2 gap-3">
              <div><label className="block text-sm font-medium text-slate-700">Type</label><select className="w-full rounded border p-2" value={formData.type} onChange={e => setFormData({...formData, type: e.target.value})}><option value="Client">Client</option><option value="Vendor">Vendor</option><option value="Both">Both</option></select></div>
              <div><label className="block text-sm font-medium text-slate-700">GSTIN</label><input className="w-full rounded border p-2 uppercase" maxLength={15} placeholder="15 char GSTIN" value={formData.gstin} onChange={e => setFormData({...formData, gstin: e.target.value.toUpperCase()})} /></div>
            </div>
            <div><label className="block text-sm font-medium text-slate-700">Company Name</label><input className="w-full rounded border p-2" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} /></div>
            <div><label className="block text-sm font-medium text-slate-700">Full Address</label><textarea className="w-full rounded border p-2 text-sm" rows={2} value={formData.address} onChange={e => setFormData({...formData, address: e.target.value})} /></div>
          </div>
          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-white border-b pb-1">Financial & Terms</h4>
            <div><label className="block text-sm font-medium text-slate-700">Credit Terms</label><select className="w-full rounded border p-2" value={formData.billing_terms} onChange={e => setFormData({...formData, billing_terms: e.target.value})}><option value="Net 15">Net 15 Days</option><option value="Net 30">Net 30 Days</option><option value="Net 45">Net 45 Days</option><option value="Net 60">Net 60 Days</option><option value="Net 90">Net 90 Days</option></select></div>
          </div>
          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-white border-b pb-1">Contact Persons</h4>
            {formData.contacts.length > 0 && (
              <div className="space-y-2 mb-3">{formData.contacts.map((c, idx) => (<div key={idx} className="flex items-center justify-between bg-slate-50 p-2 rounded border border-slate-200"><div><div className="text-sm font-medium text-slate-800">{c.name}</div><div className="text-xs text-slate-500">{c.phone}</div></div><button onClick={() => handleRemoveContact(idx)} className="text-red-500 hover:text-red-700"><Trash2 size={14} /></button></div>))}</div>
            )}
            <div className="bg-slate-50 p-3 rounded border border-dashed border-slate-300"><div className="grid grid-cols-2 gap-2 mb-2"><input className="rounded border p-1.5 text-sm" placeholder="Name *" value={newContact.name} onChange={e => setNewContact({...newContact, name: e.target.value})} /><input className="rounded border p-1.5 text-sm" placeholder="Role" value={newContact.role} onChange={e => setNewContact({...newContact, role: e.target.value})} /><input className="rounded border p-1.5 text-sm" placeholder="Phone *" value={newContact.phone} onChange={e => setNewContact({...newContact, phone: e.target.value})} /><input className="rounded border p-1.5 text-sm" placeholder="Email" value={newContact.email} onChange={e => setNewContact({...newContact, email: e.target.value})} /></div><button onClick={handleAddContact} className="w-full rounded border border-indigo-200 bg-white py-1 text-sm text-indigo-600 hover:bg-indigo-50">+ Add to List</button></div>
          </div>
          <button onClick={handleSave} className="w-full rounded bg-indigo-600 py-3 text-white font-medium hover:bg-indigo-700 shadow-sm mt-4">Save Client / Vendor</button>
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
const Projects = ({ projects, clients, inventory, expenses, employees, role, user, db, appId }) => {
  const [selectedProjectId, setSelectedProjectId] = useState(null);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  
  // --- Filter State ---
  const [filters, setFilters] = useState({
    startDate: '', endDate: '', clientId: '', status: '', setupDate: '', invoiceStatus: ''
  });

  const [isAllocationModalOpen, setIsAllocationModalOpen] = useState(false);
  const [allocationForm, setAllocationForm] = useState({ item_id: '', qty: 1, rate: 0, days: 1, gst_rate: 18, available_qty: 0 });
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
    await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', id));
  };

  const handleSaveProject = async () => {
    if(!newProj.client_id || !newProj.project_name) return alert("Missing fields");
    
    // Ensure default invoice status
    const data = { 
        ...newProj, 
        invoice_status: newProj.invoice_status || 'Not Invoiced',
        updated_at: serverTimestamp() 
    };

    if (editingId) {
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', editingId), data);
    } else {
      await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'projects'), { ...data, created_by: user.uid, created_at: serverTimestamp() });
    }
    setIsCreateOpen(false); 
  };

  const updateStatus = async (pid, newStatus) => {
    if (newStatus === 'Closed' && role !== 'admin') return alert("Only Admin can close projects.");
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', pid), { status: newStatus });
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
  };

  // ... (Keep existing toggleEmployee, updateLogisticsCost, Modal handlers) ...
  const toggleEmployee = async (empId) => {
    const currentAssigned = selectedProject.assigned_employees || [];
    const newAssigned = currentAssigned.includes(empId) ? currentAssigned.filter(id => id !== empId) : [...currentAssigned, empId];
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), { assigned_employees: newAssigned });
  };

  const updateLogisticsCost = async (type, field, value) => {
    const currentCosts = selectedProject.logistics_costs || {};
    const newCosts = { ...currentCosts, [type]: { ...(currentCosts[type] || { amount: 0, gst: 0 }), [field]: parseFloat(value) || 0 } };
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), { logistics_costs: newCosts });
  };

  const openAllocationModal = () => {
    const days = selectedProject?.start_date && selectedProject?.end_date ? getDaysDifference(selectedProject.start_date, selectedProject.end_date) : 1;
    setAllocationForm({ item_id: '', qty: 1, rate: 0, days: days, gst_rate: 18, available_qty: 0 });
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
    const newItem = { id: Date.now().toString(), item_id: item.id, item_name: item.name, category: item.category, is_external: item.is_external || false, qty: parseInt(allocationForm.qty), rate: parseFloat(allocationForm.rate), days: parseInt(allocationForm.days), gst_rate: parseFloat(allocationForm.gst_rate), amount, gst_amount: amount * (allocationForm.gst_rate/100), total: amount * (1 + allocationForm.gst_rate/100) };
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), { items: arrayUnion(newItem) });
    setAllocationForm(p => ({...p, item_id: '', qty: 1, available_qty: 0})); 
  };

  const handleRemoveAllocation = async (item) => {
    if(confirm("Remove this item?")) await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), { items: arrayRemove(item) });
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
          <div><h1 className="text-2xl font-bold text-slate-800">{selectedProject.project_name}</h1><div className="flex items-center gap-2 text-slate-500"><span>{clients.find(c=>c.id === selectedProject.client_id)?.name}</span><span>•</span><span>{selectedProject.start_date} to {selectedProject.end_date}</span>{selectedProject.setup_date && <span className="text-indigo-600 font-medium"> (Setup: {selectedProject.setup_date})</span>}</div></div>
          <div className="flex items-center gap-3"><span className={`px-3 py-1 rounded-full text-sm font-bold border ${STATUS_COLORS[selectedProject.status]}`}>{selectedProject.status}</span>{(role === 'admin' || role === 'manager') && (<select className="rounded border p-1 text-sm bg-slate-50" value={selectedProject.status} onChange={(e) => updateStatus(selectedProject.id, e.target.value)}><option value="Quoted">Quoted</option><option value="Confirmed">Confirmed</option><option value="Ongoing">Ongoing</option><option value="Completed">Completed</option><option value="Closed">Closed</option><option value="Cancelled">Cancelled</option></select>)}</div>
        </div>

        {/* --- NEW INVOICING CARD --- */}
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

        {/* Profit & Loss Summary */}
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

        <div className="grid gap-6 md:grid-cols-3">
          {/* ... (Keep existing layout for Team, Logistics, Equipment) ... */}
          <div className="md:col-span-2 space-y-6">
            <div className="rounded-xl bg-white p-6 shadow-sm">
               <div className="flex items-center justify-between mb-4"><h3 className="font-semibold text-slate-800 flex items-center gap-2"><Users size={18} /> Assigned Team</h3>{(role === 'admin' || role === 'manager') && (<button onClick={() => setIsEmpModalOpen(true)} className="text-xs font-medium text-indigo-600 hover:underline">Manage Team</button>)}</div>
               <div className="flex flex-wrap gap-2">{(selectedProject.assigned_employees || []).length > 0 ? (selectedProject.assigned_employees || []).map(empId => { const emp = employees.find(e => e.id === empId); return (<div key={empId} className="flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1 text-sm"><div className="h-5 w-5 rounded-full bg-indigo-200 flex items-center justify-center text-[10px] font-bold text-indigo-700">{emp?.name?.charAt(0) || '?'}</div><span className="text-slate-700">{emp?.name || 'Unknown'}</span></div>); }) : (<div className="text-sm text-slate-400 italic">No employees assigned.</div>)}</div>
            </div>
            <div className="rounded-xl bg-white p-6 shadow-sm">
               <h3 className="font-semibold text-slate-800 mb-4 flex items-center gap-2"><DollarSign size={18} /> Logistics & Services</h3>
               <div className="overflow-x-auto"><table className="w-full text-sm text-left"><thead className="bg-slate-50 text-slate-500"><tr><th className="p-3">Cost Type</th><th className="p-3 w-32">Amount</th><th className="p-3 w-24">GST %</th><th className="p-3 text-right">Total</th></tr></thead><tbody className="divide-y divide-slate-100">{LOGISTICS_TYPES.map(type => { const saved = (selectedProject.logistics_costs || {})[type.id] || { amount: 0, gst: 18 }; const total = (saved.amount || 0) * (1 + (saved.gst || 0)/100); return (<tr key={type.id}><td className="p-3 flex items-center gap-2"><span className="text-slate-400">{type.icon}</span><span className="text-slate-700 font-medium">{type.label}</span></td><td className="p-3"><input type="number" min="0" className="w-full rounded border p-1" value={saved.amount} onChange={(e) => updateLogisticsCost(type.id, 'amount', e.target.value)} disabled={role === 'tech'} /></td><td className="p-3"><select className="w-full rounded border p-1" value={saved.gst} onChange={(e) => updateLogisticsCost(type.id, 'gst', e.target.value)} disabled={role === 'tech'}><option value="0">0%</option><option value="5">5%</option><option value="12">12%</option><option value="18">18%</option><option value="28">28%</option></select></td><td className="p-3 text-right font-medium text-slate-800">{formatCurrency(total)}</td></tr>); })}</tbody><tfoot className="bg-slate-50 font-bold text-slate-800 border-t"><tr><td colSpan={3} className="p-3 text-right">Logistics Total:</td><td className="p-3 text-right">{formatCurrency(totals.logistics)}</td></tr></tfoot></table></div>
            </div>
            <div className="rounded-xl bg-white p-6 shadow-sm">
              <div className="flex items-center justify-between mb-4"><h3 className="font-semibold text-slate-800">Allocated Equipment</h3>{(role === 'manager' || role === 'admin') && selectedProject.status !== 'Closed' && (<button onClick={openAllocationModal} className="rounded bg-indigo-50 px-3 py-1 text-sm font-medium text-indigo-600 hover:bg-indigo-100">+ Add Item</button>)}</div>
              <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-slate-50 text-slate-500"><tr><th className="p-2">Item</th><th className="p-2 text-center">Qty</th><th className="p-2 text-center">Days</th><th className="p-2 text-right">Rate</th><th className="p-2 text-right">Total</th><th className="p-2"></th></tr></thead><tbody className="divide-y divide-slate-100">{(selectedProject.items || []).map((item, idx) => (<tr key={idx} className="hover:bg-slate-50"><td className="p-2"><div className="font-medium text-slate-800">{item.item_name}</div>{item.is_external && <span className="text-xs text-purple-600 bg-purple-50 px-1 rounded">Ext</span>}</td><td className="p-2 text-center">{item.qty}</td><td className="p-2 text-center">{item.days}</td><td className="p-2 text-right">{formatCurrency(item.rate)}</td><td className="p-2 text-right font-medium">{formatCurrency(item.total)}</td><td className="p-2 text-right">{(role === 'manager' || role === 'admin') && (<button onClick={() => handleRemoveAllocation(item)} className="text-red-400 hover:text-red-600"><Trash2 size={14} /></button>)}</td></tr>))}</tbody><tfoot className="bg-slate-50 font-bold text-slate-800"><tr><td colSpan={4} className="p-2 text-right">Equipment Total:</td><td className="p-2 text-right">{formatCurrency(totals.equipment)}</td><td></td></tr></tfoot></table></div>
            </div>
          </div>
          <div className="space-y-6">
            <div className="rounded-xl bg-white p-6 shadow-sm border border-indigo-100"><h3 className="mb-4 font-bold text-slate-800 text-lg">Project Summary</h3><div className="space-y-3 text-sm"><div className="flex justify-between"><span className="text-slate-500">Equipment Cost</span><span className="font-medium">{formatCurrency(totals.equipment)}</span></div><div className="flex justify-between"><span className="text-slate-500">Logistics & Services</span><span className="font-medium">{formatCurrency(totals.logistics)}</span></div><div className="border-t pt-3 flex justify-between text-lg font-bold text-indigo-700"><span>Grand Total</span><span>{formatCurrency(totals.total_revenue)}</span></div></div></div>
            <div className="rounded-xl bg-white p-6 shadow-sm"><h3 className="mb-4 font-semibold text-slate-800">Expenses</h3><div className="text-2xl font-bold text-slate-800">{formatCurrency(expenses.filter(e => e.project_id === selectedProject.id).reduce((s,e)=>s + parseFloat(e.amount), 0))}</div><div className="mt-2 text-xs text-slate-500">Total recorded expenses</div></div>
          </div>
        </div>
        {/* ... (Keep existing Modals: Allocation, Employee) ... */}
        <Modal isOpen={isAllocationModalOpen} onClose={() => setIsAllocationModalOpen(false)} title="Allocate Equipment">
          <div className="space-y-4">
            <div><label className="block text-sm font-medium text-slate-700">Select Item</label><select className="w-full rounded border p-2" value={allocationForm.item_id} onChange={handleItemSelect}><option value="">-- Choose Equipment --</option>{inventory.map(item => (<option key={item.id} value={item.id}>{item.name}</option>))}</select>{allocationForm.item_id && (<div className={`mt-1 text-xs font-medium ${allocationForm.available_qty > 0 ? 'text-green-600' : 'text-red-600'}`}>Available for dates: {allocationForm.available_qty} units</div>)}</div>
            <div className="grid grid-cols-2 gap-4"><div><label className="block text-sm font-medium text-slate-700">Quantity</label><input type="number" min="1" className={`w-full rounded border p-2 ${allocationForm.qty > allocationForm.available_qty ? 'border-red-500 bg-red-50' : ''}`} value={allocationForm.qty} onChange={e => setAllocationForm({...allocationForm, qty: e.target.value})} />{allocationForm.qty > allocationForm.available_qty && (<div className="text-xs text-red-600 mt-1 flex items-center gap-1"><AlertCircle size={10} /> Overbooking warning</div>)}</div><div><label className="block text-sm font-medium text-slate-700">Days</label><input type="number" min="1" className="w-full rounded border p-2" value={allocationForm.days} onChange={e => setAllocationForm({...allocationForm, days: e.target.value})} /></div><div><label className="block text-sm font-medium text-slate-700">Rate / Day</label><input type="number" className="w-full rounded border p-2" value={allocationForm.rate} onChange={e => setAllocationForm({...allocationForm, rate: e.target.value})} /></div><div><label className="block text-sm font-medium text-slate-700">GST %</label><input type="number" disabled className="w-full rounded border p-2 bg-slate-50" value={allocationForm.gst_rate} /></div></div>
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
          <h2 className="text-2xl font-bold text-slate-800">Projects</h2>
          {(role === 'manager' || role === 'admin') && (
            <button onClick={openCreate} className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-white hover:bg-indigo-700">
                <Plus size={18} /> New Quote
            </button>
          )}
      </div>

      {/* --- Filter Bar with Invoice Status --- */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-2 bg-white p-3 rounded-lg border border-slate-200 shadow-sm">
         <div><label className="text-[10px] font-bold text-slate-400 uppercase">From Date</label><input type="date" className="w-full text-xs rounded border p-1" value={filters.startDate} onChange={e => setFilters({...filters, startDate: e.target.value})} /></div>
         <div><label className="text-[10px] font-bold text-slate-400 uppercase">To Date</label><input type="date" className="w-full text-xs rounded border p-1" value={filters.endDate} onChange={e => setFilters({...filters, endDate: e.target.value})} /></div>
         <div><label className="text-[10px] font-bold text-slate-400 uppercase">Setup Date {'>='}</label><input type="date" className="w-full text-xs rounded border p-1" value={filters.setupDate} onChange={e => setFilters({...filters, setupDate: e.target.value})} /></div>
         <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase">Client</label>
            <select className="w-full text-xs rounded border p-1" value={filters.clientId} onChange={e => setFilters({...filters, clientId: e.target.value})}>
                <option value="">All Clients</option>
                {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
         </div>
         <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase">Status</label>
            <select className="w-full text-xs rounded border p-1" value={filters.status} onChange={e => setFilters({...filters, status: e.target.value})}>
                <option value="">All Statuses</option>
                <option value="Quoted">Quoted</option>
                <option value="Confirmed">Confirmed</option>
                <option value="Ongoing">Ongoing</option>
                <option value="Completed">Completed</option>
                <option value="Closed">Closed</option>
            </select>
         </div>
         <div>
            <label className="text-[10px] font-bold text-slate-400 uppercase">Invoice</label>
            <select className="w-full text-xs rounded border p-1" value={filters.invoiceStatus} onChange={e => setFilters({...filters, invoiceStatus: e.target.value})}>
                <option value="">All</option>
                <option value="Not Invoiced">Not Invoiced</option>
                <option value="Invoiced">Invoiced</option>
            </select>
         </div>
      </div>

      <div className="space-y-3">
        {filteredProjects.length === 0 ? <div className="text-center text-slate-400 py-10">No projects match your filters.</div> : 
        filteredProjects.map(project => (
          <div key={project.id} onClick={() => setSelectedProjectId(project.id)} className="cursor-pointer rounded-xl border border-slate-200 bg-white p-4 transition hover:shadow-md group relative">
            <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
              <div>
                <div className="flex items-center gap-2">
                    <div className="font-bold text-slate-800">{project.project_name}</div>
                    {project.invoice_status === 'Invoiced' && <span className="text-[10px] bg-green-100 text-green-700 px-1 rounded border border-green-200" title={`Inv#: ${project.invoice_no}`}>INV</span>}
                </div>
                <div className="text-sm text-slate-500">{clients.find(c=>c.id === project.client_id)?.name || 'Unknown Client'}</div>
                {project.setup_date && <div className="text-xs text-indigo-600 mt-1">Setup: {project.setup_date}</div>}
              </div>
              <div className="flex items-center gap-4">
                <div className="text-right text-sm">
                  <div className="text-white">{project.start_date}</div>
                  <div className="text-slate-400">{project.venue}</div>
                </div>
                <span className={`px-2 py-1 text-xs rounded border ${STATUS_COLORS[project.status]}`}>{project.status}</span>
              </div>
            </div>
            {(role==='admin'||role==='manager') && (
              <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button onClick={(e)=>{e.stopPropagation();openEdit(project)}} className="p-1 text-blue-600 bg-blue-50 rounded hover:bg-blue-100"><Edit size={14}/></button>
                <button onClick={(e)=>{e.stopPropagation();handleDelete(project.id)}} className="p-1 text-red-600 bg-red-50 rounded hover:bg-red-100"><Trash2 size={14}/></button>
              </div>
            )}
          </div>
        ))}
      </div>

      <Modal isOpen={isCreateOpen} onClose={() => setIsCreateOpen(false)} title={editingId ? "Edit Project" : "Create New Quote"}>
        <div className="space-y-3">
          <div><label className="text-sm font-medium">Project Name</label><input className="w-full rounded border p-2" value={newProj.project_name} onChange={e => setNewProj({...newProj, project_name: e.target.value})} /></div>
          <div><label className="text-sm font-medium">Client</label><select className="w-full rounded border p-2" value={newProj.client_id} onChange={e => setNewProj({...newProj, client_id: e.target.value})}><option value="">Select Client</option>{clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
          <div className="grid grid-cols-3 gap-2">
              <div><label className="text-sm font-medium">Setup Date</label><input type="date" className="w-full rounded border p-2" value={newProj.setup_date} onChange={e => setNewProj({...newProj, setup_date: e.target.value})} /></div>
              <div><label className="text-sm font-medium">Start Date</label><input type="date" className="w-full rounded border p-2" value={newProj.start_date} onChange={e => setNewProj({...newProj, start_date: e.target.value})} /></div>
              <div><label className="text-sm font-medium">End Date</label><input type="date" className="w-full rounded border p-2" value={newProj.end_date} onChange={e => setNewProj({...newProj, end_date: e.target.value})} /></div>
          </div>
          <div><label className="text-sm font-medium">Venue</label><input className="w-full rounded border p-2" value={newProj.venue} onChange={e => setNewProj({...newProj, venue: e.target.value})} /></div>
          <button onClick={handleSaveProject} className="w-full rounded bg-indigo-600 py-2 text-white mt-4">{editingId ? 'Update Project' : 'Create Quote'}</button>
        </div>
      </Modal>
    </div>
  );
};

// version 1.3.0 finance implementation

const Finance = ({ clients, employees, projects, payments, payouts, expenses, advances, role, db, appId, user }) => {
  const [activeTab, setActiveTab] = useState('client_in'); // 'client_in' or 'emp_out'
  const [form, setForm] = useState({ 
    entity_id: '', amount: '', date: new Date().toISOString().split('T')[0], 
    mode: 'Bank Transfer', reference: '', remarks: '', project_id: '' 
  });

  // --- Client Payment Logic ---
  const handleClientPayment = async () => {
    if (!form.entity_id || !form.amount) return alert("Select Client and Amount");
    const client = clients.find(c => c.id === form.entity_id);
    
    await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'payments'), {
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
    alert("Payment Received Recorded");
    setForm({ ...form, amount: '', reference: '', remarks: '' });
  };

  // --- Employee Payout Logic ---
  const handleEmpPayout = async () => {
    if (!form.entity_id || !form.amount) return alert("Select Employee and Amount");
    const emp = employees.find(e => e.id === form.entity_id);

    await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'payouts'), {
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
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-slate-800">Finance & Payments</h2>
        <div className="flex bg-white rounded-lg border p-1">
          <button onClick={() => {setActiveTab('client_in'); setForm({...form, entity_id: ''})}} className={`px-4 py-2 text-sm rounded-md font-medium transition-colors ${activeTab === 'client_in' ? 'bg-green-100 text-green-700' : 'text-slate-600 hover:bg-slate-50'}`}>Receive Payment (In)</button>
          <button onClick={() => {setActiveTab('emp_out'); setForm({...form, entity_id: ''})}} className={`px-4 py-2 text-sm rounded-md font-medium transition-colors ${activeTab === 'emp_out' ? 'bg-red-100 text-red-700' : 'text-slate-600 hover:bg-slate-50'}`}>Make Payout (Out)</button>
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
                <label className="text-xs font-bold text-slate-500 uppercase">{activeTab === 'client_in' ? 'Received From Client' : 'Pay To Employee'}</label>
                <select className="w-full rounded border p-2 bg-slate-50" value={form.entity_id} onChange={e => setForm({...form, entity_id: e.target.value})}>
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
                   <label className="text-xs font-bold text-slate-500 uppercase">Against Project (Optional)</label>
                   <select className="w-full rounded border p-2" value={form.project_id} onChange={e => setForm({...form, project_id: e.target.value})}>
                      <option value="">General Payment (On Account)</option>
                      {projects.filter(p => p.client_id === form.entity_id).map(p => (
                        <option key={p.id} value={p.id}>{p.project_name} ({p.status})</option>
                      ))}
                   </select>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-bold text-slate-500 uppercase">Amount</label>
                  <input type="number" className="w-full rounded border p-2" value={form.amount} onChange={e => setForm({...form, amount: e.target.value})} />
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-500 uppercase">Date</label>
                  <input type="date" className="w-full rounded border p-2" value={form.date} onChange={e => setForm({...form, date: e.target.value})} />
                </div>
              </div>

              <div>
                <label className="text-xs font-bold text-slate-500 uppercase">Payment Mode</label>
                <select className="w-full rounded border p-2" value={form.mode} onChange={e => setForm({...form, mode: e.target.value})}>
                  <option>Bank Transfer</option><option>Cash</option><option>Cheque</option><option>UPI / Online</option>
                </select>
              </div>

              <div>
                <label className="text-xs font-bold text-slate-500 uppercase">Reference / Trx ID</label>
                <input type="text" className="w-full rounded border p-2" value={form.reference} onChange={e => setForm({...form, reference: e.target.value})} />
              </div>
              
              <div>
                <label className="text-xs font-bold text-slate-500 uppercase">Remarks</label>
                <textarea className="w-full rounded border p-2 text-sm" rows={2} value={form.remarks} onChange={e => setForm({...form, remarks: e.target.value})} />
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
                 <thead className="bg-white text-slate-500 border-b">
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

const Inventory = ({ inventory, role, db, appId }) => {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterCategory, setFilterCategory] = useState('All');
  const [formData, setFormData] = useState({ name: '', category: '', total: 0, location: '', rate_per_day: 0, gst_rate: 18, remarks: '', specifications: '', is_external: false, hsn_code: '' });

  const openAdd = () => { setEditingId(null); setFormData({ name: '', category: '', total: 0, location: '', rate_per_day: 0, gst_rate: 18, remarks: '', specifications: '', is_external: false, hsn_code: '' }); setIsModalOpen(true); };
  const openEdit = (item) => { setEditingId(item.id); setFormData({ name: item.name, category: item.category, total: item.total, location: item.location, rate_per_day: item.rate_per_day || 0, gst_rate: item.gst_rate || 18, remarks: item.remarks || '', specifications: item.specifications || '', is_external: item.is_external || false, hsn_code: item.hsn_code || '' }); setIsModalOpen(true); };
  const handleDelete = async (id) => { if (confirm('Delete item?')) await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'inventory', id)); };
  
  const handleSave = async () => {
    const itemData = { name: formData.name, category: formData.category, total: parseInt(formData.total), location: formData.location, rate_per_day: parseFloat(formData.rate_per_day), gst_rate: parseFloat(formData.gst_rate), remarks: formData.remarks, specifications: formData.specifications, is_external: formData.is_external, hsn_code: formData.hsn_code };
    if (editingId) {
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'inventory', editingId), itemData);
    } else {
      await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'inventory'), { ...itemData, gst_history: [], created_at: serverTimestamp() });
    }
    setIsModalOpen(false);
  };

  const filteredInventory = inventory.filter(item => item.name.toLowerCase().includes(searchTerm.toLowerCase()) && (filterCategory === 'All' || item.category === filterCategory));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between"><h2 className="text-2xl font-bold text-slate-800">Inventory</h2><div className="flex gap-2"><div className="hidden md:flex items-center rounded border px-3 py-1 bg-white"><Search size={16} className="text-slate-400 mr-2" /><input placeholder="Search items..." className="text-sm outline-none" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} /></div><select className="rounded border px-3 py-1 bg-white text-sm outline-none" value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}><option value="All">All Categories</option>{CATEGORIES.map(cat => <option key={cat} value={cat}>{cat}</option>)}</select>{role === 'admin' && (<button onClick={openAdd} className="flex items-center gap-2 rounded bg-indigo-600 px-3 py-1 text-white text-sm hover:bg-indigo-700"><Plus size={16} /> Add Item</button>)}</div></div>
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-left text-sm"><thead className="bg-slate-50 text-slate-500"><tr><th className="p-4 font-medium">Item Name</th><th className="p-4 font-medium hidden md:table-cell">Category</th><th className="p-4 font-medium text-right">Rate/Day</th><th className="p-4 font-medium text-center">Total</th><th className="p-4 font-medium hidden md:table-cell">Loc</th>{role === 'admin' && <th className="p-4 font-medium text-center">Actions</th>}</tr></thead><tbody className="divide-y divide-slate-100">{filteredInventory.map((item, idx) => (<tr key={idx} className="hover:bg-slate-50 group"><td className="p-4 font-medium text-slate-800"><div className="flex flex-col"><span className="flex items-center gap-2">{item.name}{item.is_external && (<span className="rounded bg-purple-100 px-2 py-0.5 text-xs text-purple-700 border border-purple-200">Ext</span>)}</span></div></td><td className="p-4 text-slate-500 hidden md:table-cell">{item.category}</td><td className="p-4 text-right text-slate-800 font-mono">{formatCurrency(item.rate_per_day || 0)}</td><td className="p-4 text-center text-slate-800">{item.total}</td><td className="p-4 text-slate-500 hidden md:table-cell">{item.location}</td>{role === 'admin' && (<td className="p-4 text-center"><div className="flex items-center justify-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity"><button onClick={() => openEdit(item)} className="rounded p-1 text-blue-600 hover:bg-blue-50"><Edit size={16} /></button><button onClick={() => handleDelete(item.id)} className="rounded p-1 text-red-600 hover:bg-red-50"><Trash2 size={16} /></button></div></td>)}</tr>))}</tbody></table>
      </div>
      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title={editingId ? "Edit Item" : "Add Inventory Item"}>
        <div className="space-y-4">
          <div><label className="text-sm font-medium text-slate-700">Item Name</label><input className="w-full rounded border p-2" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} /></div>
          <div className="grid grid-cols-2 gap-4"><div><label className="text-sm font-medium text-slate-700">Category</label><input className="w-full rounded border p-2" value={formData.category} onChange={e => setFormData({...formData, category: e.target.value})} list="categories" /><datalist id="categories">{CATEGORIES.map(cat => <option key={cat} value={cat} />)}</datalist></div><div><label className="text-sm font-medium text-slate-700">Location</label><input className="w-full rounded border p-2" value={formData.location} onChange={e => setFormData({...formData, location: e.target.value})} /></div></div>
          <div className="grid grid-cols-3 gap-4"><div><label className="text-sm font-medium text-slate-700">Total Qty</label><input type="number" className="w-full rounded border p-2" value={formData.total} onChange={e => setFormData({...formData, total: e.target.value})} /></div><div><label className="text-sm font-medium text-slate-700">Rate / Day</label><input type="number" className="w-full rounded border p-2" value={formData.rate_per_day} onChange={e => setFormData({...formData, rate_per_day: e.target.value})} /></div><div><label className="text-sm font-medium text-slate-700">GST %</label><select className="w-full rounded border p-2" value={formData.gst_rate} onChange={e => setFormData({...formData, gst_rate: e.target.value})}><option value="5">5%</option><option value="12">12%</option><option value="18">18%</option><option value="28">28%</option></select></div></div>
          <div><label className="text-sm font-medium text-slate-700">HSN/SAC Code</label><input className="w-full rounded border p-2" value={formData.hsn_code} onChange={e => setFormData({...formData, hsn_code: e.target.value})} /></div>
          <div className="rounded-lg bg-slate-50 p-3 border border-slate-100 space-y-3"><div className="flex items-center gap-2"><input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" checked={formData.is_external} onChange={e => setFormData({...formData, is_external: e.target.checked})} /><label className="text-sm font-medium text-slate-700 select-none">External (Outsourced)</label></div><div><label className="text-sm font-medium text-slate-700">Specifications</label><textarea className="w-full rounded border p-2 text-sm" rows={2} value={formData.specifications} onChange={e => setFormData({...formData, specifications: e.target.value})} /></div></div>
          <div className="flex justify-end gap-2 pt-2"><button onClick={() => setIsModalOpen(false)} className="rounded px-4 py-2 text-sm text-slate-600 hover:bg-slate-100">Cancel</button><button onClick={handleSave} className="rounded bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-700">{editingId ? 'Update Item' : 'Create Item'}</button></div>
        </div>
      </Modal>
    </div>
  );
};

const Outsourcing = ({ projects, clients, inventory, role, db, appId }) => {
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [vendorForm, setVendorForm] = useState({
    vendor_id: '', item_id: '', qty: 1, rate: 0, days: 1, gst: 18
  });
  const [editingAlloc, setEditingAlloc] = useState(null); // Track edit state

  const vendors = clients.filter(c => c.type === 'Vendor' || c.type === 'Both');
  const selectedProject = projects.find(p => p.id === selectedProjectId);

  const allProjectItems = selectedProject?.items || [];
  const externalItems = allProjectItems.filter(i => i.is_external);
  const internalItems = allProjectItems.filter(i => !i.is_external);

  const getRemainingOutsourceQty = (itemId, requiredQty) => {
    const allocations = selectedProject?.vendor_allocations || [];
    const allocated = allocations
      .filter(a => a.item_id === itemId && a.id !== editingAlloc?.id) // Exclude current if editing
      .reduce((sum, a) => sum + parseInt(a.qty || 0), 0);
    return Math.max(0, requiredQty - allocated);
  };

  const handleAllocate = async () => {
    if (!selectedProjectId || !vendorForm.vendor_id || !vendorForm.item_id) return alert("Select Project, Vendor and Item");
    
    const item = allProjectItems.find(i => i.item_id === vendorForm.item_id);
    const vendor = vendors.find(v => v.id === vendorForm.vendor_id);
    
    const remaining = getRemainingOutsourceQty(item.item_id, item.qty);
    if (vendorForm.qty > remaining) {
      if(!confirm(`You are allocating ${vendorForm.qty} but only ${remaining} is pending. Continue?`)) return;
    }

    const amount = vendorForm.qty * vendorForm.rate * vendorForm.days;
    const tax_amount = amount * (1 + vendorForm.gst/100);

    const allocation = {
      id: editingAlloc ? editingAlloc.id : Date.now().toString(),
      vendor_id: vendor.id,
      vendor_name: vendor.name,
      item_id: item.item_id,
      item_name: item.item_name,
      qty: parseInt(vendorForm.qty),
      rate: parseFloat(vendorForm.rate),
      days: parseInt(vendorForm.days),
      gst: parseFloat(vendorForm.gst),
      amount: amount,
      tax_amount: tax_amount,
      allocated_at: new Date().toISOString()
    };

    try {
      const projectRef = doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProjectId);
      if (editingAlloc) {
        // Remove old, add new
        await updateDoc(projectRef, { vendor_allocations: arrayRemove(editingAlloc) });
        await updateDoc(projectRef, { vendor_allocations: arrayUnion(allocation) });
        setEditingAlloc(null);
      } else {
        await updateDoc(projectRef, { vendor_allocations: arrayUnion(allocation) });
      }
      setVendorForm({ vendor_id: '', item_id: '', qty: 1, rate: 0, days: 1, gst: 18 });
    } catch (err) {
      console.error(err);
      alert("Failed to save allocation");
    }
  };

  const handleEdit = (alloc) => {
    setEditingAlloc(alloc);
    setVendorForm({
      vendor_id: alloc.vendor_id,
      item_id: alloc.item_id,
      qty: alloc.qty,
      rate: alloc.rate,
      days: alloc.days,
      gst: alloc.gst
    });
  };

  const handleCancelEdit = () => {
    setEditingAlloc(null);
    setVendorForm({ vendor_id: '', item_id: '', qty: 1, rate: 0, days: 1, gst: 18 });
  };

  const handleRemove = async (alloc) => {
    if(!confirm("Remove this vendor allocation?")) return;
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProjectId), {
      vendor_allocations: arrayRemove(alloc)
    });
  };

  const renderItemList = (items, title, colorClass) => (
    <div className="mb-6">
      <h4 className={`text-xs font-bold uppercase tracking-wider mb-2 ${colorClass}`}>{title}</h4>
      <div className="space-y-2">
        {items.map(item => {
          const remaining = getRemainingOutsourceQty(item.item_id, item.qty);
          const isDone = remaining === 0;
          return (
            <div key={item.item_id} className={`p-3 rounded border flex justify-between items-center ${isDone ? 'bg-slate-50 border-slate-200 opacity-70' : 'bg-white border-slate-200'}`}>
              <div>
                <div className="font-medium text-slate-800">{item.item_name}</div>
                <div className="text-xs text-slate-500">Required: {item.qty}</div>
              </div>
              <div className="text-right">
                <div className="text-xs text-slate-500">Pending</div>
                <div className={`font-bold ${remaining > 0 ? 'text-orange-600' : 'text-green-600'}`}>{remaining}</div>
              </div>
            </div>
          );
        })}
        {items.length === 0 && <div className="text-xs text-slate-400 italic">No items in this category.</div>}
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-slate-800">Outsourcing Manager</h2>
        <div className="w-64">
          <select 
            className="w-full rounded border p-2 text-sm"
            value={selectedProjectId}
            onChange={(e) => { setSelectedProjectId(e.target.value); handleCancelEdit(); }}
          >
            <option value="">-- Select Project --</option>
            {projects.filter(p => ['Confirmed', 'Ongoing'].includes(p.status)).map(p => (
              <option key={p.id} value={p.id}>{p.project_name}</option>
            ))}
          </select>
        </div>
      </div>

      {selectedProject ? (
        <div className="grid gap-6 md:grid-cols-2 h-[calc(100vh-200px)]">
          {/* Left: Requirements */}
          <div className="rounded-xl border bg-slate-50 p-4 shadow-sm flex flex-col overflow-y-auto">
            <h3 className="font-bold text-slate-700 mb-4 flex items-center gap-2">
              <AlertCircle size={18} className="text-indigo-500" /> 
              Project Requirements
            </h3>
            {renderItemList(externalItems, "External Items (Priority)", "text-orange-600")}
            {renderItemList(internalItems, "Internal Items (Can Outsource)", "text-slate-500")}
          </div>

          {/* Right: Vendor Allocation */}
          <div className="rounded-xl border bg-white p-4 shadow-sm flex flex-col overflow-hidden">
            <h3 className="font-bold text-slate-700 mb-4 flex items-center gap-2">
              <Truck size={18} className="text-indigo-500" />
              Vendor Allocations
            </h3>
            
            {/* Allocation Form */}
            <div className={`p-4 rounded-lg border mb-4 space-y-3 ${editingAlloc ? 'bg-orange-50 border-orange-200' : 'bg-slate-50 border-slate-200'}`}>
              <div className="flex justify-between items-center mb-2">
                <span className="text-xs font-bold uppercase text-slate-500">{editingAlloc ? 'Edit Allocation' : 'New Allocation'}</span>
                {editingAlloc && <button onClick={handleCancelEdit} className="text-xs text-slate-500 underline">Cancel</button>}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-slate-500">Vendor</label>
                  <select className="w-full rounded border p-1.5 text-sm" value={vendorForm.vendor_id} onChange={e => setVendorForm({...vendorForm, vendor_id: e.target.value})}>
                    <option value="">Select Vendor</option>
                    {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-slate-500">Item to Outsource</label>
                  <select className="w-full rounded border p-1.5 text-sm" value={vendorForm.item_id} onChange={e => {
                     const itm = allProjectItems.find(i => i.item_id === e.target.value);
                     setVendorForm({
                       ...vendorForm, 
                       item_id: e.target.value,
                       qty: itm ? getRemainingOutsourceQty(itm.item_id, itm.qty) : 1, 
                       days: selectedProject ? getDaysDifference(selectedProject.start_date, selectedProject.end_date) : 1
                     })
                  }}>
                    <option value="">Select Item</option>
                    {allProjectItems.filter(i => getRemainingOutsourceQty(i.item_id, i.qty) > 0 || (editingAlloc && i.item_id === editingAlloc.item_id)).map(i => (
                      <option key={i.item_id} value={i.item_id}>
                        {i.item_name} {i.is_external ? '(Ext)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-4 gap-2">
                <div><label className="text-xs text-slate-500">Qty</label><input type="number" className="w-full rounded border p-1" value={vendorForm.qty} onChange={e => setVendorForm({...vendorForm, qty: e.target.value})}/></div>
                <div><label className="text-xs text-slate-500">Rate</label><input type="number" className="w-full rounded border p-1" value={vendorForm.rate} onChange={e => setVendorForm({...vendorForm, rate: e.target.value})}/></div>
                <div><label className="text-xs text-slate-500">Days</label><input type="number" className="w-full rounded border p-1" value={vendorForm.days} onChange={e => setVendorForm({...vendorForm, days: e.target.value})}/></div>
                <div><label className="text-xs text-slate-500">GST %</label><input type="number" className="w-full rounded border p-1" value={vendorForm.gst} onChange={e => setVendorForm({...vendorForm, gst: e.target.value})}/></div>
              </div>
              <div className="flex justify-between items-center pt-2">
                <div className="text-xs font-bold text-slate-700">
                  Total: {formatCurrency(vendorForm.qty * vendorForm.rate * vendorForm.days * (1 + vendorForm.gst/100))}
                </div>
                <button onClick={handleAllocate} className={`px-4 py-1.5 rounded text-sm text-white ${editingAlloc ? 'bg-orange-500 hover:bg-orange-600' : 'bg-indigo-600 hover:bg-indigo-700'}`}>
                  {editingAlloc ? 'Update' : 'Allocate'}
                </button>
              </div>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto space-y-2">
              {(selectedProject.vendor_allocations || []).map((alloc, idx) => (
                <div key={idx} className="p-3 border rounded bg-white hover:bg-slate-50 flex justify-between items-center text-sm">
                  <div>
                    <div className="font-bold text-slate-800">{alloc.vendor_name}</div>
                    <div className="text-slate-600">{alloc.item_name} <span className="text-xs bg-slate-100 px-1 rounded">x{alloc.qty}</span></div>
                    <div className="text-xs text-slate-400">Rate: {alloc.rate} | Days: {alloc.days} | GST: {alloc.gst}%</div>
                  </div>
                  <div className="text-right">
                    <div className="font-bold text-slate-800">{formatCurrency(alloc.tax_amount)}</div>
                    <div className="flex justify-end gap-2 mt-1">
                      <button onClick={() => handleEdit(alloc)} className="text-blue-500 text-xs hover:underline">Edit</button>
                      <button onClick={() => handleRemove(alloc)} className="text-red-500 text-xs hover:underline">Remove</button>
                    </div>
                  </div>
                </div>
              ))}
              {(selectedProject.vendor_allocations || []).length === 0 && <div className="text-center text-slate-400 italic mt-4">No allocations yet.</div>}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex h-64 items-center justify-center rounded-xl bg-white border border-dashed border-slate-300 text-slate-400">
          Select a project to manage outsourcing
        </div>
      )}
    </div>
  );
};

const Expenses = ({ expenses, projects, user, role, db, appId, advances = [], currentEmpId }) => {
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
      await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'expenses'), item);
    }
    setBatchList([]);
    alert("Expenses submitted successfully");
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
        <h2 className="text-2xl font-bold text-slate-800">Expense Tracker</h2>
        <div className="flex gap-2 bg-white rounded-lg border p-1">
          <button onClick={() => setViewMode('submit')} className={`px-3 py-1 text-sm rounded ${viewMode === 'submit' ? 'bg-indigo-100 text-indigo-700 font-medium' : 'text-slate-600'}`}>Submit</button>
          <button onClick={() => setViewMode('history')} className={`px-3 py-1 text-sm rounded ${viewMode === 'history' ? 'bg-indigo-100 text-indigo-700 font-medium' : 'text-slate-600'}`}>My History</button>
          <button onClick={() => setViewMode('ledger')} className={`px-3 py-1 text-sm rounded ${viewMode === 'ledger' ? 'bg-indigo-100 text-indigo-700 font-medium' : 'text-slate-600'}`}>My Ledger</button>
        </div>
      </div>

      {viewMode === 'submit' && (
        <div className="grid gap-6 md:grid-cols-2">
          <div className="rounded-xl bg-white p-6 shadow-sm border border-slate-200 h-fit">
            <h3 className="mb-4 font-semibold text-slate-700">New Expense Entry</h3>
            <div className="space-y-4">
              <div className="flex gap-4 border-b pb-4">
                <label className="flex items-center gap-2 cursor-pointer"><input type="radio" name="exptype" checked={!expenseForm.is_general} onChange={() => setExpenseForm({...expenseForm, is_general: false})} /><span className="text-sm font-medium">Project Expense</span></label>
                <label className="flex items-center gap-2 cursor-pointer"><input type="radio" name="exptype" checked={expenseForm.is_general} onChange={() => setExpenseForm({...expenseForm, is_general: true, project_id: ''})} /><span className="text-sm font-medium">General / Ops</span></label>
              </div>
              {!expenseForm.is_general && (
                <div>
                  <label className="text-xs font-medium text-slate-500">Select Project</label>
                  <input type="text" className="w-full rounded border p-2 mb-1 text-xs" placeholder="Search project..." value={projectSearch} onChange={e => setProjectSearch(e.target.value)} />
                  <select className="w-full rounded border p-2" value={expenseForm.project_id} onChange={e => setExpenseForm({...expenseForm, project_id: e.target.value})}>
                    <option value="">-- Choose Project --</option>
                    {filteredProjects.map(p => <option key={p.id} value={p.id}>{p.project_name}</option>)}
                  </select>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3"><div><label className="text-xs font-medium text-slate-500">Date</label><input type="date" className="w-full rounded border p-2" value={expenseForm.date} onChange={e => setExpenseForm({...expenseForm, date: e.target.value})} /></div><div><label className="text-xs font-medium text-slate-500">Category</label><select className="w-full rounded border p-2" value={expenseForm.category} onChange={e => setExpenseForm({...expenseForm, category: e.target.value})}>{EXPENSE_CATS.map(c => <option key={c}>{c}</option>)}</select></div></div>
              <div><label className="text-xs font-medium text-slate-500">Amount</label><input type="number" className="w-full rounded border p-2" placeholder="0.00" value={expenseForm.amount} onChange={e => setExpenseForm({...expenseForm, amount: e.target.value})} /></div>
              <div><label className="text-xs font-medium text-slate-500">Remarks</label><textarea className="w-full rounded border p-2 text-sm" rows={2} value={expenseForm.remarks} onChange={e => setExpenseForm({...expenseForm, remarks: e.target.value})} placeholder="Description..." /></div>
              <button onClick={handleAddToBatch} className="w-full rounded bg-slate-50 text-white py-2 hover:bg-slate-50">+ Add to Batch</button>
            </div>
          </div>
          <div className="rounded-xl bg-white p-6 shadow-sm border border-slate-200 flex flex-col h-full">
            <h3 className="mb-4 font-semibold text-slate-700 flex justify-between items-center"><span>Ready to Submit</span><span className="text-xs bg-slate-100 px-2 py-1 rounded">{batchList.length} items</span></h3>
            <div className="flex-1 overflow-y-auto space-y-2 mb-4 pr-1">{batchList.length === 0 && <div className="text-center text-slate-400 italic mt-10">No items added yet.</div>}{batchList.map(item => (<div key={item.id} className="flex justify-between items-start p-3 bg-slate-50 rounded border border-slate-100"><div><div className="font-medium text-slate-800">{item.category} - {formatCurrency(item.amount)}</div><div className="text-xs text-slate-500">{item.is_general ? 'General Ops' : projects.find(p=>p.id===item.project_id)?.project_name || 'Unknown Project'}</div>{item.remarks && <div className="text-xs text-slate-400 mt-1">"{item.remarks}"</div>}</div><button onClick={() => removeBatchItem(item.id)} className="text-red-400 hover:text-red-600"><X size={16} /></button></div>))}</div>
            <div className="border-t pt-4"><div className="flex justify-between mb-4 font-bold text-slate-800"><span>Total</span><span>{formatCurrency(batchList.reduce((s, i) => s + parseFloat(i.amount), 0))}</span></div><button onClick={handleSubmitBatch} disabled={batchList.length === 0} className={`w-full rounded py-3 font-medium text-white ${batchList.length > 0 ? 'bg-indigo-600 hover:bg-indigo-700' : 'bg-slate-300 cursor-not-allowed'}`}>Submit All Expenses</button></div>
          </div>
        </div>
      )}

      {viewMode === 'history' && (
        <div className="space-y-4">
          <div className="flex gap-4 p-4 bg-white rounded-xl shadow-sm border border-slate-200">
             <select className="rounded border p-1 text-sm" value={historyFilter.time} onChange={e => setHistoryFilter({...historyFilter, time: e.target.value})}><option value="all">All Time</option><option value="week">This Week</option><option value="month">This Month</option></select>
             <select className="rounded border p-1 text-sm" value={historyFilter.project} onChange={e => setHistoryFilter({...historyFilter, project: e.target.value})}><option value="all">All Projects</option>{availableProjects.map(p => <option key={p.id} value={p.id}>{p.project_name}</option>)}</select>
          </div>
          <div className="rounded-xl bg-white shadow-sm border border-slate-200 overflow-hidden"><table className="w-full text-left text-sm"><thead className="bg-slate-50 text-slate-500"><tr><th className="p-4">Date</th><th className="p-4">Project / Type</th><th className="p-4">Category</th><th className="p-4 text-right">Amount</th><th className="p-4 text-center">Status</th></tr></thead><tbody className="divide-y divide-slate-100">{filteredHistory.map(exp => (<tr key={exp.id}><td className="p-4">{new Date(exp.date).toLocaleDateString()}</td><td className="p-4">{exp.is_general ? <span className="text-orange-600 bg-orange-50 px-2 py-0.5 rounded text-xs">General Ops</span> : projects.find(p=>p.id===exp.project_id)?.project_name}</td><td className="p-4">{exp.category}</td><td className="p-4 text-right font-medium">{formatCurrency(exp.amount)}</td><td className="p-4 text-center"><span className="text-xs bg-slate-100 px-2 py-1 rounded">{exp.status}</span></td></tr>))}</tbody></table>{filteredHistory.length === 0 && <div className="p-8 text-center text-slate-400">No records found.</div>}</div>
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

const Employees = ({ employees, role, db, appId, advances = [] }) => {
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
    if (editingId) { await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'employees', editingId), empData); } 
    else { await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'employees'), { ...empData, created_at: serverTimestamp() }); }
    setIsModalOpen(false);
  };

  const handlePasswordChange = async () => {
    if (!newPassword) return alert("Enter password");
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'employees', selectedEmp.id), { password_updated_at: serverTimestamp() });
    alert("Password updated"); setPasswordModalOpen(false); setNewPassword('');
  };

  const updateStatus = async (id, status) => {
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'employees', id), { status });
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
      <div className="flex items-center justify-between"><h2 className="text-2xl font-bold text-slate-800">Employee Management</h2><button onClick={openAdd} className="flex items-center gap-2 rounded bg-indigo-600 px-4 py-2 text-white hover:bg-indigo-700"><Plus size={18} /> Add Employee</button></div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">{employees.map(emp => (
        <div key={emp.id} className={`rounded-xl border bg-white p-4 shadow-sm relative ${emp.status === 'Disabled' || emp.status === 'Deactivated' ? 'opacity-60 bg-slate-50' : ''}`}>
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
          </div>
        </div>
      ))}</div>
      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title={editingId ? "Edit Employee" : "New Employee"}>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3"><div><label className="text-xs font-medium text-slate-500">Full Name</label><input className="w-full rounded border p-2" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} /></div><div><label className="text-xs font-medium text-slate-500">Address</label><input className="w-full rounded border p-2" value={formData.address} onChange={e => setFormData({...formData, address: e.target.value})} /></div></div>
          <div className="grid grid-cols-3 gap-3">
             <div><label className="text-xs font-medium text-slate-500">Mobile 1</label><input className="w-full rounded border p-2" value={formData.mobile1} onChange={e => setFormData({...formData, mobile1: e.target.value})} /></div>
             <div><label className="text-xs font-medium text-slate-500">Mobile 2</label><input className="w-full rounded border p-2" value={formData.mobile2} onChange={e => setFormData({...formData, mobile2: e.target.value})} /></div>
             <div><label className="text-xs font-medium text-slate-500">Alt Mobile</label><input className="w-full rounded border p-2" value={formData.alt_mobile} onChange={e => setFormData({...formData, alt_mobile: e.target.value})} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3"><div><label className="text-xs font-medium text-slate-500">Email</label><input className="w-full rounded border p-2" value={formData.email} onChange={e => setFormData({...formData, email: e.target.value})} /></div><div><label className="text-xs font-medium text-slate-500">Role</label><select className="w-full rounded border p-2" value={formData.role} onChange={e => setFormData({...formData, role: e.target.value})}><option value="admin">Admin</option><option value="manager">Manager</option><option value="tech">Field Tech</option><option value="auditor">Auditor</option></select></div></div>
          
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
      <Modal isOpen={passwordModalOpen} onClose={() => setPasswordModalOpen(false)} title={`Change Password: ${selectedEmp?.name}`}><div className="space-y-4"><div><label className="text-sm font-medium">New Password</label><input type="password" className="w-full rounded border p-2" value={newPassword} onChange={e => setNewPassword(e.target.value)} /></div><button onClick={handlePasswordChange} className="w-full rounded bg-red-600 text-white py-2 hover:bg-red-700">Update Password</button></div></Modal>
      <Modal isOpen={isAdvanceModalOpen} onClose={() => setIsAdvanceModalOpen(false)} title={`Give Advance: ${selectedEmp?.name}`}>
         <div className="space-y-4">
            <div><label className="text-sm font-medium">Amount (INR)</label><input type="number" className="w-full rounded border p-2" value={advanceForm.amount} onChange={e => setAdvanceForm({...advanceForm, amount: e.target.value})} /></div>
            <div><label className="text-sm font-medium">Date</label><input type="date" className="w-full rounded border p-2" value={advanceForm.date} onChange={e => setAdvanceForm({...advanceForm, date: e.target.value})} /></div>
            <div><label className="text-sm font-medium">Remarks</label><input className="w-full rounded border p-2" placeholder="Reason for advance..." value={advanceForm.remarks} onChange={e => setAdvanceForm({...advanceForm, remarks: e.target.value})} /></div>
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
const Reports = ({ projects, clients, employees, expenses, inventory, payments }) => {
  const [reportType, setReportType] = useState('ledger'); 
  const [filterId, setFilterId] = useState(''); // Client ID
  const [selectedProjId, setSelectedProjId] = useState(''); // Project ID
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

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-bold text-slate-800">System Reports</h2>
      
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm space-y-4">
        <div className="flex flex-wrap gap-4 items-end">
          <div className="w-full md:w-auto">
            <label className="block text-sm font-medium text-slate-700 mb-1">Report Type</label>
            <select className="w-full rounded border p-2 min-w-[250px]" value={reportType} onChange={(e) => { setReportType(e.target.value); setFilterId(''); setSelectedProjId(''); }}>
               <option value="ledger">Client Ledger (Statement)</option>
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
               <select className="w-full rounded border p-2 min-w-[200px]" value={filterId} onChange={(e) => setFilterId(e.target.value)}>
                  <option value="">-- Choose Client --</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
               </select>
            </div>
          )}

          {['project_ops', 'project_expenses', 'project_pnl'].includes(reportType) && (
            <div className="w-full md:w-auto">
               <label className="block text-sm font-medium text-slate-700 mb-1">Select Project</label>
               <select className="w-full rounded border p-2 min-w-[250px]" value={selectedProjId} onChange={(e) => setSelectedProjId(e.target.value)}>
                  <option value="">-- Choose Project --</option>
                  {projects.sort((a,b) => new Date(b.start_date) - new Date(a.start_date)).map(p => (
                      <option key={p.id} value={p.id}>{p.project_name} ({p.status})</option>
                  ))}
               </select>
            </div>
          )}

          {reportType === 'projects_summary' && (
            <>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">From</label><input type="date" className="rounded border p-2" value={startDate} onChange={e => setStartDate(e.target.value)} /></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1">To</label><input type="date" className="rounded border p-2" value={endDate} onChange={e => setEndDate(e.target.value)} /></div>
            </>
          )}

          <div className="flex gap-2 ml-auto w-full md:w-auto">
             <button onClick={exportPDF} className="flex-1 md:flex-none justify-center bg-red-600 text-white px-4 py-2 rounded hover:bg-red-700 flex gap-2 items-center"><FileText size={16} /> PDF</button>
             <button onClick={exportExcel} className="flex-1 md:flex-none justify-center bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700 flex gap-2 items-center"><FileText size={16} /> Excel</button>
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

const AdminTools = ({ db, appId }) => {
  const [backupStatus, setBackupStatus] = useState('idle');
  const [restoreStatus, setRestoreStatus] = useState('idle');

  const collections = ['projects', 'clients', 'inventory', 'expenses', 'employees', 'advances', 'payments', 'payouts'];

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

  return (
    <div className="space-y-6">
       <h2 className="text-2xl font-bold text-slate-800">Admin Tools</h2>
       <div className="grid md:grid-cols-2 gap-6">
          <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
             <h3 className="font-bold text-lg mb-2 flex items-center gap-2"><Download size={20} /> Backup Data</h3>
             <p className="text-slate-500 text-sm mb-4">Download a full JSON backup of all system data (Projects, Clients, Inventory, etc).</p>
             <button onClick={handleBackup} disabled={backupStatus === 'loading'} className="bg-indigo-600 text-white px-4 py-2 rounded hover:bg-indigo-700 disabled:bg-indigo-300">
                {backupStatus === 'loading' ? 'Generating Backup...' : 'Download Backup'}
             </button>
             {backupStatus === 'success' && <span className="ml-3 text-green-600 text-sm font-medium">Backup Downloaded!</span>}
          </div>

          <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
             <h3 className="font-bold text-lg mb-2 flex items-center gap-2"><Upload size={20} /> Restore Data</h3>
             <p className="text-slate-500 text-sm mb-4">Upload a previously generated JSON backup file. Existing records with matching IDs will be updated.</p>
             <div className="relative">
                <input type="file" accept=".json" onChange={handleRestore} disabled={restoreStatus === 'loading'} className="block w-full text-sm text-slate-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100"/>
             </div>
             {restoreStatus === 'loading' && <div className="mt-2 text-indigo-600 text-sm">Restoring data... please wait...</div>}
             {restoreStatus === 'success' && <div className="mt-2 text-green-600 text-sm font-medium">Restore Complete!</div>}
          </div>
       </div>
    </div>
  );
};

// REPORTS VERSION 2.0.0


//version 1.1.0   reports, employee mgmt, expense mgmt, inventory mgmt

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [role, setRole] = useState(null); 
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [currentEmpId, setCurrentEmpId] = useState('');

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

  const handleLogin = (e) => {
    e.preventDefault();
    setLoginError('');
    const { username, password } = loginForm;

    // Admin Check with Employee Matching
    if (username === 'admin' && password === 'admin123') {
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
      return;
    }

    // Employee Check
    const emp = employees.find(e => e.username === username || e.email === username);
    if (emp) {
      const validPass = emp.password || 'psw123'; 
      if (password === validPass) {
        if (emp.status === 'Disabled' || emp.status === 'Deactivated') {
          setLoginError('Account is disabled. Contact Admin.');
          return;
        }
        setRole(emp.role);
        setCurrentEmpId(emp.id);
        return;
      }
    }

    setLoginError('Invalid username or password');
  };

  const handleLogout = () => {
    setRole(null);
    setCurrentEmpId(null);
    setLoginForm({ username: '', password: '' });
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
               <label className="block text-sm font-medium text-slate-700 mb-1">Username / Email</label>
               <input 
                 className="w-full rounded border p-3 outline-none focus:border-indigo-500" 
                 placeholder="admin or email@example.com"
                 value={loginForm.username}
                 onChange={e => setLoginForm({...loginForm, username: e.target.value})}
               />
             </div>
             <div>
               <label className="block text-sm font-medium text-slate-700 mb-1">Password</label>
               <input 
                 type="password"
                 className="w-full rounded border p-3 outline-none focus:border-indigo-500" 
                 placeholder="••••••••"
                 value={loginForm.password}
                 onChange={e => setLoginForm({...loginForm, password: e.target.value})}
               />
             </div>
             {loginError && <div className="text-red-500 text-sm bg-red-50 p-2 rounded text-center">{loginError}</div>}
             <button type="submit" className="w-full bg-indigo-600 text-white p-3 rounded font-medium hover:bg-indigo-700 transition">Sign In</button>
          </form>
          
          <div className="mt-6 text-center text-xs text-slate-400">
            <p>Default Admin: admin / admin123</p>
            <p>Default Employee: [email] / psw123</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-full bg-slate-50 text-white font-sans overflow-hidden">
      <aside className="hidden w-64 flex-col border-r bg-white md:flex shadow-sm z-10">
        <div className="flex h-16 items-center px-6 font-bold text-xl text-indigo-600 tracking-tight">TERMS <span className="ml-2 text-xs font-normal text-slate-400 border border-slate-200 rounded px-1">v1.0</span></div>
        <div className="flex-1 space-y-1 p-4">
          <NavItem id="dashboard" activeTab={activeTab} setActiveTab={setActiveTab} setMobileMenuOpen={setMobileMenuOpen} icon={LayoutDashboard} label="Dashboard" />
          <NavItem id="projects" activeTab={activeTab} setActiveTab={setActiveTab} setMobileMenuOpen={setMobileMenuOpen} icon={Calendar} label="Projects" />
          <NavItem id="outsourcing" activeTab={activeTab} setActiveTab={setActiveTab} setMobileMenuOpen={setMobileMenuOpen} icon={ShoppingBag} label="Outsource" />
          <NavItem id="clients" activeTab={activeTab} setActiveTab={setActiveTab} setMobileMenuOpen={setMobileMenuOpen} icon={Users} label="Clients" />
          <NavItem id="inventory" activeTab={activeTab} setActiveTab={setActiveTab} setMobileMenuOpen={setMobileMenuOpen} icon={Box} label="Inventory" />
          <NavItem id="expenses" activeTab={activeTab} setActiveTab={setActiveTab} setMobileMenuOpen={setMobileMenuOpen} icon={DollarSign} label="Expenses" />
          {role === 'admin' && (<><div className="my-2 border-t border-slate-100"></div><NavItem id="employees" activeTab={activeTab} setActiveTab={setActiveTab} setMobileMenuOpen={setMobileMenuOpen} icon={UserCog} label="Employees" /><NavItem id="reports" activeTab={activeTab} setActiveTab={setActiveTab} setMobileMenuOpen={setMobileMenuOpen} icon={FileText} label="Reports" /><NavItem id="admin" activeTab={activeTab} setActiveTab={setActiveTab} setMobileMenuOpen={setMobileMenuOpen} icon={Settings} label="Admin" /></>)}
        
        {(role === 'admin' || role === 'manager') && (
         <NavItem id="finance" activeTab={activeTab} setActiveTab={setActiveTab} setMobileMenuOpen={setMobileMenuOpen} icon={Wallet} label="Finance" />
        )}
        </div>
        <div className="border-t p-4"><div className="mb-2 flex items-center gap-3 px-2"><div className={`h-8 w-8 rounded-full flex items-center justify-center text-white text-xs font-bold ${role==='admin'?'bg-red-500':role==='manager'?'bg-blue-500':'bg-green-500'}`}>{role[0].toUpperCase()}</div><div><div className="text-sm font-medium capitalize">{role}</div><div className="text-xs text-slate-400">Online</div></div></div><button onClick={handleLogout} className="flex w-full items-center gap-2 rounded p-2 text-sm text-red-600 hover:bg-red-50"><LogOut size={16} /> Sign Out</button></div>
      </aside>
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-16 items-center justify-between border-b bg-white px-4 md:hidden shadow-sm z-20"><div className="font-bold text-indigo-600">TERMS</div><button onClick={() => setMobileMenuOpen(!mobileMenuOpen)} className="p-2 text-slate-600">{mobileMenuOpen ? <X /> : <Menu />}</button></header>
        {mobileMenuOpen && (
          <div className="absolute inset-0 top-16 z-30 bg-white p-4 md:hidden">
            <div className="space-y-2">
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
                  <NavItem id="employees" activeTab={activeTab} setActiveTab={setActiveTab} setMobileMenuOpen={setMobileMenuOpen} icon={UserCog} label="Employees" />
                  <NavItem id="reports" activeTab={activeTab} setActiveTab={setActiveTab} setMobileMenuOpen={setMobileMenuOpen} icon={FileText} label="Reports" />
                  <NavItem id="admin" activeTab={activeTab} setActiveTab={setActiveTab} setMobileMenuOpen={setMobileMenuOpen} icon={Settings} label="Admin" />
                </>
              )}
            </div>
            <div className="mt-8 border-t pt-4">
              <button onClick={handleLogout} className="flex items-center gap-2 text-red-600"><LogOut size={16} /> Sign Out</button>
            </div>
          </div>
        )}
        <main className="flex-1 overflow-y-auto p-4 md:p-8 relative">
          <div className="mx-auto max-w-5xl">
            {activeTab === 'dashboard' && <Dashboard projects={projects} expenses={expenses} role={role} clients={clients} />}
            {activeTab === 'projects' && <Projects projects={projects} clients={clients} inventory={inventory} expenses={expenses} employees={employees} role={role} user={user} db={db} appId={appId} />}
            {activeTab === 'outsourcing' && <Outsourcing projects={projects} clients={clients} inventory={inventory} role={role} db={db} appId={appId} />}
            {activeTab === 'clients' && <Clients clients={clients} role={role} db={db} appId={appId} />}
            {activeTab === 'inventory' && <Inventory inventory={inventory} role={role} db={db} appId={appId} />}
            {activeTab === 'expenses' && <Expenses expenses={expenses} projects={projects} user={user} role={role} db={db} appId={appId} advances={advances} currentEmpId={currentEmpId} />}
            {activeTab === 'employees' && <Employees employees={employees} role={role} db={db} appId={appId} advances={advances} />}
            {activeTab === 'admin' && <AdminTools db={db} appId={appId} />}
            {/* {activeTab === 'reports' && (
               <Reports 
                  projects={projects} 
                  clients={clients} 
                  employees={employees} 
                  expenses={expenses} 
                  inventory={inventory} 
               />
            )} */}
            {activeTab === 'finance' && (
  <Finance 
    clients={clients} 
    employees={employees} 
    projects={projects} 
    payments={payments} 
    payouts={payouts}
    expenses={expenses}
    advances={advances}
    role={role} 
    db={db} 
    appId={appId} 
    user={user} 
  />
)}
{activeTab === 'reports' && (
   <Reports 
      projects={projects} 
      clients={clients} 
      employees={employees} 
      expenses={expenses} 
      inventory={inventory}
      payments={payments} // Pass payments here
   />
)}
           {/* /*activeTab === 'reports' && (<div className="flex h-64 items-center justify-center rounded-xl bg-white text-slate-400 border border-slate-200">Report Generation Module (Admin Only)</div>)}
        */ }
          </div>
        </main>
      </div>
    </div>
  );
}