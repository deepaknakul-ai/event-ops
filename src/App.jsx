// VERSION 3.0.0 FULL APP WITH FIREBASE INTEGRATION AND REACT FRONTEND
// VERSION 3.1.0 ADMIN DATABASE BACKUP AND RESTORE OPTION ADDED
// version 3.5.0 challan manager search added


import React, { useState, useEffect, useMemo, useRef, lazy, Suspense } from 'react';
import { confirmDialog } from './utils/dialog';
import { 
  LayoutDashboard, Box, Users, Calendar, FileText, 
  DollarSign, CheckCircle, AlertTriangle, Menu, X, 
  LogOut, Plus, Search, Filter, Upload, Image as ImageIcon,
  ChevronRight, ArrowLeft, Save, Trash2, MapPin, Edit, History,
  Phone, Mail, User, UserCog, Key, Shield, MoreVertical, Truck,
  Utensils, Hotel, Hammer, Briefcase, AlertCircle, Wallet, CreditCard,
  TrendingUp, TrendingDown, ShoppingBag, Percent, Calculator, Camera, FileCheck, Download, Settings,
  Printer, Activity, RotateCcw, Copy, Layers, ListChecks, ClipboardList, Paperclip, Sun, Moon,
  ArrowUpRight, ArrowDownRight, Monitor, Receipt, Package, FolderOpen, Eye, ReceiptText, WifiOff,
  Clock, CalendarDays, BarChart3, UserCheck, FileBarChart, Target, MessageSquare
} from 'lucide-react';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell 
} from 'recharts';
import { Routes, Route, Navigate, useLocation, Link, useNavigate, useParams } from 'react-router-dom';
import { auth, db } from './firebase';
import { appId, setAppId, GST_STATE_CODES, STATUS_COLORS, LOGISTICS_TYPES, CATEGORIES, EXPENSE_CATS, DEFAULT_HQ_SETTINGS } from './utils/constants';
import { IS_SAAS } from './utils/edition';
import { getProjectGrandTotal, formatCurrency, formatCurrencyPDF, validateGSTIN, getDaysDifference, isDateOverlap, getFinancialYear, calculateWallSpecs, LEDTileModel, calculateLEDSignalPorts, getEffectivePOCost, hashPassword, verifyPassword, generateSecureToken } from './utils/helpers';
import { upsertPartyAccount } from './utils/partyAccounts';
import { VERSION_LABEL } from './version';
import { registerToast, notify } from './utils/toast';
import DialogHost from './components/DialogHost';
import InstallPrompt from './components/InstallPrompt';
import LocationTracker from './components/LocationTracker';
import { useChatUnread } from './utils/useChatUnread';
import { LoadingSpinner, ConfirmationModal, ConfirmDeleteModal, Toast, Modal, GSTINField } from './components/Shared';
import NavItem from './components/NavItem';
import { partitionRules } from './utils/aiAccountant';
// Route pages are code-split (React.lazy) so heavy modules (PDF/Excel/charts and
// the large Accounting/Projects pages) load on demand instead of in the main bundle.
const Dashboard = lazy(() => import('./pages/Dashboard'));
const AuditLogs = lazy(() => import('./pages/AuditLogs'));
const ProfileSettings = lazy(() => import('./pages/ProfileSettings'));
const AdminTools = lazy(() => import('./pages/AdminTools'));
const PublicLedger = lazy(() => import('./pages/PublicLedger'));
const QuoteApproval = lazy(() => import('./pages/QuoteApproval'));
const PublicReimbursable = lazy(() => import('./pages/PublicReimbursable'));
const PublicEmployeeLedger = lazy(() => import('./pages/PublicEmployeeLedger'));
const Portal = lazy(() => import('./pages/Portal'));
const Finance = lazy(() => import('./pages/Finance'));
const Accounting = lazy(() => import('./pages/Accounting'));
const ChallanManager = lazy(() => import('./pages/ChallanManager'));
const DocumentsHub = lazy(() => import('./pages/DocumentsHub'));
const PurchaseInvoices = lazy(() => import('./pages/PurchaseInvoices'));
const TaxInvoices = lazy(() => import('./pages/TaxInvoices'));
const Expenses = lazy(() => import('./pages/Expenses'));
const Employees = lazy(() => import('./pages/Employees'));
const Reports = lazy(() => import('./pages/Reports'));
const BusinessReport = lazy(() => import('./pages/BusinessReport'));
const DailyReport = lazy(() => import('./pages/DailyReport'));
const Inventory = lazy(() => import('./pages/Inventory'));
const WarehouseScan = lazy(() => import('./pages/WarehouseScan'));
const Schedule = lazy(() => import('./pages/Schedule'));
const AssetAnalytics = lazy(() => import('./pages/AssetAnalytics'));
const Leads = lazy(() => import('./pages/Leads'));
const Chat = lazy(() => import('./pages/Chat'));
const LiveMap = lazy(() => import('./pages/LiveMap'));
const Commission = lazy(() => import('./pages/Commission'));
const Analytics = lazy(() => import('./pages/Analytics'));
const Projects = lazy(() => import('./pages/Projects'));
const Clients = lazy(() => import('./pages/Clients'));
const Contacts = lazy(() => import('./pages/Contacts'));
const ConfigurationBuilder = lazy(() => import('./pages/ConfigurationBuilder'));
const HRDashboard = lazy(() => import('./pages/HRDashboard'));
const HRAttendance = lazy(() => import('./pages/HRAttendance'));
const HRLeaves = lazy(() => import('./pages/HRLeaves'));
const HRReports = lazy(() => import('./pages/HRReports'));
const HRSettings = lazy(() => import('./pages/HRSettings'));
const HRPortal = lazy(() => import('./pages/HRPortal'));
const HRPayroll = lazy(() => import('./pages/HRPayroll'));
const DataPortal = lazy(() => import('./pages/DataPortal'));
// SaaS-only tenant-platform console. The inline env check folds to a literal in
// private builds so Rollup drops the import() entirely — no platform chunk ships
// to private (enforced by scripts/check-private-bundle.cjs). Do NOT replace this
// with the IS_SAAS const: DCE of the chunk relies on the textual env expression.
const PlatformConsole = import.meta.env.VITE_EDITION === 'saas'
  ? lazy(() => import('./platform'))
  : null;
import GlobalSearch from './components/GlobalSearch';
import AppAssistant, { AppAssistantLauncher } from './components/AppAssistant';
import NotificationBell from './components/NotificationBell';
import OfflineIndicator from './components/OfflineIndicator';
import ProtectedRoute from './components/ProtectedRoute';
import useOfflineMode from './hooks/useOfflineMode';
import { can, ROLE_LABELS, ROLE_COLOR, setLiveConfig } from './utils/permissions';
import { setEntitlements } from './utils/entitlements';

import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from '@e965/xlsx';
//import { saveAs } from 'file-saver';

import {
  signInAnonymously, onAuthStateChanged, signOut, signInWithCustomToken,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail,
  fetchSignInMethodsForEmail, getIdTokenResult
} from 'firebase/auth';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { collection, addDoc, updateDoc, doc, 
  deleteDoc, onSnapshot, query, where, serverTimestamp, setDoc, getDoc, arrayUnion, arrayRemove, getDocs, runTransaction
} from 'firebase/firestore';

// --- Configuration & Constants ---

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('UI render error:', error, info);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
    window.location.href = '/projects';
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-100 flex items-center justify-center p-6">
          <div className="max-w-2xl w-full rounded-xl bg-white border border-red-200 shadow p-6">
            <div className="text-lg font-bold text-red-700">Something went wrong</div>
            <div className="mt-2 text-sm text-slate-600">A render error occurred. This overlay is temporary for debugging.</div>
            {this.state.error && (
              <pre className="mt-4 whitespace-pre-wrap rounded bg-slate-50 p-3 text-xs text-slate-700 border border-slate-200">{String(this.state.error)}</pre>
            )}
            <div className="mt-4 flex gap-2">
              <button onClick={this.handleReset} className="rounded bg-indigo-600 px-4 py-2 text-white text-sm">Go to Projects</button>
              <button onClick={() => window.location.reload()} className="rounded border border-slate-300 px-4 py-2 text-sm">Reload</button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}


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

const isExpenseExcludedStatus = (status) => status === 'Rejected' || status === 'Disapproved';

// --- Sub-Components ---

const _ClientsOld = ({ clients, inventory, role, db, appId, logAction }) => {
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
  const [ledgerLinkModal, setLedgerLinkModal] = useState({ isOpen: false, client: null, link: '' });
  const [ledgerExpiryDays, setLedgerExpiryDays] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 12;


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
    const clientName = clients.find(c => c.id === id)?.name || 'this client';
    setConfirmModal({
      isOpen: true,
      requireTyped: true,
      title: 'Delete Client',
      message: `Permanently delete "${clientName}"? All associated data will be lost and this cannot be undone.`,
      onConfirm: async () => {
        await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'clients', id));
        logAction('clients', 'delete', id, { name: clientName }, clientName);
      }
    });
  };

  const handleAddContact = () => {
    if (!newContact.name || !newContact.phone) return notify("Name and Phone are required.", 'error');
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
      if (!val.valid) return notify(`GST Error: ${val.msg}`, 'error');
    }
    const data = { ...formData, updated_at: serverTimestamp() };
    
    const entityType = formData.type === 'Vendor' ? 'vendor' : 'client';
    if (editingId) {
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'clients', editingId), data);
      logAction('clients', 'update', editingId, data, formData.name);
      upsertPartyAccount(db, appId, editingId, entityType, formData.name);  // M-5
    } else {
      const docRef = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'clients'), { ...data, created_at: serverTimestamp() });
      logAction('clients', 'create', docRef.id, data, formData.name);
      upsertPartyAccount(db, appId, docRef.id, entityType, formData.name);  // M-5
    }
    setIsAddOpen(false);
  };

  const handleSaveVendorAsset = async () => {
    if (!vendorAssetForm.name || !vendorAssetForm.qty) return notify("Name and Qty required", 'error');
    
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
    setConfirmModal({
      isOpen: true,
      requireTyped: false,
      title: 'Remove Vendor Asset',
      message: 'Remove this asset from the vendor list? This action cannot be undone.',
      onConfirm: async () => {
        await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'inventory', assetId));
        logAction('inventory', 'delete_vendor_asset', assetId, {}, 'Vendor Asset');
      }
    });
  };

  const generateLedgerToken = () => generateSecureToken(16);

  const handleLedgerLink = async (client) => {
    let token = client.ledger_link_token;
    if (!token) {
      token = generateLedgerToken();
      await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'clients', client.id), {
        ledger_link_token: token,
        ledger_link_enabled: true,
        ledger_link_created_at: new Date().toISOString()
      });
      logAction('clients', 'create_ledger_link', client.id, { token }, client.name);
    }

    const link = `${window.location.origin}/ledger/${token}`;
    setLedgerLinkModal({ isOpen: true, client, link });
    setLedgerExpiryDays('');
  };

  const handleRegenerateLedgerLink = async () => {
    if (!ledgerLinkModal.client) return;
    const token = generateLedgerToken();
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'clients', ledgerLinkModal.client.id), {
      ledger_link_token: token,
      ledger_link_enabled: true,
      ledger_link_created_at: new Date().toISOString()
    });
    logAction('clients', 'regenerate_ledger_link', ledgerLinkModal.client.id, { token }, ledgerLinkModal.client.name);
    const link = `${window.location.origin}/ledger/${token}`;
    setLedgerLinkModal(prev => ({ ...prev, link }));
    setLedgerExpiryDays('');
  };

  const handleSetLedgerExpiry = async () => {
    if (!ledgerLinkModal.client) return;
    const days = parseInt(ledgerExpiryDays, 10);
    const payload = {
      ledger_link_expires_at: null
    };
    if (!Number.isNaN(days) && days > 0) {
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + days);
      payload.ledger_link_expires_at = expiresAt.toISOString();
    }
    await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'clients', ledgerLinkModal.client.id), payload);
    logAction('clients', 'update_ledger_link_expiry', ledgerLinkModal.client.id, payload, ledgerLinkModal.client.name);
    setLedgerLinkModal(prev => ({
      ...prev,
      client: { ...prev.client, ledger_link_expires_at: payload.ledger_link_expires_at }
    }));
    setLedgerExpiryDays('');
  };

  const handleCopyLedgerLink = async () => {
    if (!ledgerLinkModal.link) return;
    await navigator.clipboard.writeText(ledgerLinkModal.link);
    notify('Ledger link copied to clipboard.', 'success');
  };

  const handleCopyLedgerLinkValue = async (link) => {
    if (!link) return;
    await navigator.clipboard.writeText(link);
    notify('Ledger link copied to clipboard.', 'success');
  };

  const filteredClients = clients.filter(client => 
    client.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const paginatedClients = useMemo(() => {
    const start = (currentPage - 1) * itemsPerPage;
    return filteredClients.slice(start, start + itemsPerPage);
  }, [filteredClients, currentPage]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm]);

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
        {paginatedClients.map(client => {
          const ledgerLink = client.ledger_link_token
            ? `${window.location.origin}/ledger/${client.ledger_link_token}`
            : '';
          return (
          <div key={client.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm flex flex-col justify-between group relative">
            {(role === 'admin' || role === 'manager') && (
              <div className="absolute top-2 right-2 flex gap-1 opacity-100">
                <button onClick={(e) => {e.stopPropagation(); handleLedgerLink(client)}} className="p-1 text-slate-600 hover:bg-slate-50 rounded" title="Ledger Link"><Copy size={14}/></button>
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
            {(role === 'admin' || role === 'manager') && (
              <div className="mt-3 border-t pt-3 border-slate-100">
                <div className="text-xs font-semibold text-slate-400 mb-2 uppercase tracking-wide">Ledger Link</div>
                {ledgerLink ? (
                  <div className="flex items-center gap-2">
                    <input className="flex-1 rounded border p-2 text-xs text-black bg-white" value={ledgerLink} readOnly />
                    <button onClick={(e) => {e.stopPropagation(); handleCopyLedgerLinkValue(ledgerLink)}} className="rounded bg-indigo-600 text-white px-2 py-2 text-xs hover:bg-indigo-700">Copy</button>
                  </div>
                ) : (
                  <button onClick={(e) => {e.stopPropagation(); handleLedgerLink(client)}} className="w-full rounded border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50">Generate Link</button>
                )}
              </div>
            )}
            {(client.type === 'Vendor' || client.type === 'Both') && (
                <button onClick={(e) => {e.stopPropagation(); setSelectedVendorForAssets(client)}} className="mt-3 w-full flex items-center justify-center gap-2 rounded border border-indigo-200 bg-indigo-50 py-1.5 text-sm font-medium text-indigo-700 hover:bg-indigo-100">
                    <Box size={16} /> Manage Assets ({inventory ? inventory.filter(i => i.vendor_id === client.id).length : 0})
                </button>
            )}
          </div>
        );
        })}
      </div>
      {filteredClients.length > itemsPerPage && (
        <div className="flex items-center justify-between pt-4">
          <div className="text-sm text-slate-500">Showing {Math.min((currentPage - 1) * itemsPerPage + 1, filteredClients.length)} to {Math.min(currentPage * itemsPerPage, filteredClients.length)} of {filteredClients.length} entries</div>
          <div className="flex gap-2">
            
              <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1} className="px-3 py-1 rounded border bg-indigo-600 text-white hover:bg-indigo-700 border-indigo-600 disabled:opacity-50 text-sm">Previous</button>
              <button onClick={() => setCurrentPage(p => Math.min(Math.ceil(filteredClients.length / itemsPerPage), p + 1))} disabled={currentPage === Math.ceil(filteredClients.length / itemsPerPage)} className="px-3 py-1 rounded border bg-indigo-600 text-white hover:bg-indigo-700 border-indigo-600 disabled:opacity-50 text-sm">Next</button>
          </div>
        </div>
      )}
      <Modal isOpen={isAddOpen} onClose={() => setIsAddOpen(false)} title={editingId ? "Edit Client/Vendor" : "Add Client/Vendor"}>
        <div className="space-y-6">
          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-black border-b pb-1">Basic Details</h4>
            <h4 className="text-sm font-semibold text-slate-800 border-b pb-1">Basic Details</h4>
            <div className="grid grid-cols-2 gap-3">
              <div>
              <label htmlFor="client-type" className="block text-sm font-bold text-slate-800">Type</label>
              <select id="client-type" name="type" className="w-full rounded border p-2 bg-white text-black focus:ring-2 focus:ring-indigo-500" value={formData.type} onChange={e => setFormData({...formData, type: e.target.value})}>
                <option value="Client">Client</option>
                <option value="Vendor">Vendor</option>
                <option value="Both">Both</option>
              </select>
            </div>
              <div>
              <label htmlFor="client-gstin" className="block text-sm font-bold text-slate-800">GSTIN</label>
              <GSTINField
                id="client-gstin"
                value={formData.gstin}
                onChange={v => setFormData({ ...formData, gstin: v })}
                onAutofill={({ name, address }) => setFormData(prev => ({
                  ...prev,
                  name: name || prev.name,
                  address: address || prev.address
                }))}
                db={db}
                appId={appId}
              />
            </div>
            </div>
            <div>
              <label htmlFor="client-name" className="block text-sm font-bold text-slate-800">Company Name</label>
              <input id="client-name" name="name" className="w-full rounded border p-2 bg-white text-black placeholder-slate-400 focus:ring-2 focus:ring-indigo-500" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} />
            </div>
            <div>
              <label htmlFor="client-address" className="block text-sm font-bold text-slate-800">Full Address</label>
              <textarea id="client-address" name="address" className="w-full rounded border p-2 text-sm bg-white text-black placeholder-slate-400 focus:ring-2 focus:ring-indigo-500" rows={2} value={formData.address} onChange={e => setFormData({...formData, address: e.target.value})} />
            </div>
          </div>
          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-slate-800 border-b pb-1">Financial & Terms</h4>
            <div><label className="block text-sm font-bold text-slate-800">Credit Terms</label><select className="w-full rounded border p-2 bg-white text-slate-800" value={formData.billing_terms} onChange={e => setFormData({...formData, billing_terms: e.target.value})}><option value="Net 15">Net 15 Days</option><option value="Net 30">Net 30 Days</option><option value="Net 45">Net 45 Days</option><option value="Net 60">Net 60 Days</option><option value="Net 90">Net 90 Days</option></select></div>
          </div>
          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-slate-800 border-b pb-1">Contact Persons</h4>
            {formData.contacts.length > 0 && (
              <div className="space-y-2 mb-3">{formData.contacts.map((c, idx) => (<div key={idx} className="flex items-center justify-between bg-slate-50 p-2 rounded border border-slate-200"><div><div className="text-sm font-medium text-slate-800">{c.name}</div><div className="text-xs text-slate-500">{c.phone}</div></div><button onClick={() => handleRemoveContact(idx)} className="text-red-500 hover:text-red-700"><Trash2 size={14} /></button></div>))}</div>
            )}
            <div className="bg-slate-50 p-3 rounded border border-dashed border-slate-300"><div className="grid grid-cols-2 gap-2 mb-2"><input className="rounded border p-1.5 text-sm bg-white text-black placeholder-slate-400" placeholder="Name *" value={newContact.name} onChange={e => setNewContact({...newContact, name: e.target.value})} /><input className="rounded border p-1.5 text-sm bg-white text-black placeholder-slate-400" placeholder="Role" value={newContact.role} onChange={e => setNewContact({...newContact, role: e.target.value})} /><input className="rounded border p-1.5 text-sm bg-white text-black placeholder-slate-400" placeholder="Phone *" value={newContact.phone} onChange={e => setNewContact({...newContact, phone: e.target.value})} /><input className="rounded border p-1.5 text-sm bg-white text-black placeholder-slate-400" placeholder="Email" value={newContact.email} onChange={e => setNewContact({...newContact, email: e.target.value})} /></div><button onClick={handleAddContact} className="w-full rounded border border-indigo-200 bg-white py-1 text-sm text-indigo-600 hover:bg-indigo-50">+ Add to List</button></div>
          </div>
          <button onClick={handleSave} className="w-full rounded bg-indigo-600 py-3 text-white font-medium hover:bg-indigo-700 shadow-sm mt-4">Save Client / Vendor</button>
        </div>
      </Modal>

      <Modal isOpen={ledgerLinkModal.isOpen} onClose={() => setLedgerLinkModal({ isOpen: false, client: null, link: '' })} title="Ledger Link">
        <div className="space-y-4">
          <div className="text-sm text-slate-600">
            Share this link with {ledgerLinkModal.client?.name || 'the party'} to view and download their ledger.
          </div>
          <div className="flex items-center gap-2">
            <input className="flex-1 rounded border p-2 text-sm text-black bg-white" value={ledgerLinkModal.link} readOnly />
            <button onClick={handleCopyLedgerLink} className="rounded bg-indigo-600 text-white px-3 py-2 text-sm hover:bg-indigo-700">Copy</button>
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="1"
                className="w-28 rounded border p-2 text-sm text-black bg-white"
                placeholder="Days"
                value={ledgerExpiryDays}
                onChange={e => setLedgerExpiryDays(e.target.value)}
              />
              <button onClick={handleSetLedgerExpiry} className="rounded border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50">Set Expiry</button>
              <button onClick={handleRegenerateLedgerLink} className="rounded border border-slate-200 px-3 py-2 text-sm hover:bg-slate-50">Regenerate Link</button>
            </div>
            <div className="text-xs text-slate-500">
              {ledgerLinkModal.client?.ledger_link_expires_at
                ? `Expires: ${new Date(ledgerLinkModal.client.ledger_link_expires_at).toLocaleDateString()}`
                : 'No expiry set.'}
            </div>
            {ledgerLinkModal.client?.ledger_link_created_at && (
              <div className="text-xs text-slate-500">
                Created: {new Date(ledgerLinkModal.client.ledger_link_created_at).toLocaleDateString()}
              </div>
            )}
          </div>
          <div className="text-xs text-slate-500">Each link is unique to the selected client/vendor.</div>
        </div>
      </Modal>

      {/* Vendor Assets Modal */}
      <Modal isOpen={!!selectedVendorForAssets} onClose={() => setSelectedVendorForAssets(null)} title={`Vendor Assets: ${selectedVendorForAssets?.name}`}>
        <div className="space-y-6">
            <div className="bg-slate-50 p-4 rounded-lg border border-slate-200">
                <h4 className="text-sm font-bold text-slate-700 mb-3 text-slate-800">Add New Asset</h4>
                <div className="grid grid-cols-2 gap-3 mb-3">
                    <div>
                    <label htmlFor="vendor-asset-name" className="text-xs font-bold text-slate-700">Item Name</label>
                    <input id="vendor-asset-name" name="vendor_asset_name" className="w-full rounded border border-slate-300 p-2 text-sm text-slate-800 focus:ring-2 focus:ring-indigo-500" value={vendorAssetForm.name} onChange={e => setVendorAssetForm({...vendorAssetForm, name: e.target.value})} placeholder="e.g. LED Wall Panel" />
                  </div>
                    <div><label className="text-xs font-bold text-slate-700">Category</label><select className="w-full rounded border border-slate-300 p-2 text-sm text-slate-800" value={vendorAssetForm.category} onChange={e => setVendorAssetForm({...vendorAssetForm, category: e.target.value})}>{CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}</select></div>
                    <div>
                    <label htmlFor="vendor-asset-qty" className="text-xs font-bold text-slate-700">Quantity</label>
                    <input id="vendor-asset-qty" name="vendor_asset_qty" type="number" className="w-full rounded border border-slate-300 p-2 text-sm text-slate-800 focus:ring-2 focus:ring-indigo-500" value={vendorAssetForm.qty} onChange={e => setVendorAssetForm({...vendorAssetForm, qty: e.target.value})} />
                  </div>
                    <div>
                    <label htmlFor="vendor-asset-price" className="text-xs font-bold text-slate-700">Offered Price (Rate)</label>
                    <input id="vendor-asset-price" name="vendor_asset_price" type="number" className="w-full rounded border border-slate-300 p-2 text-sm text-slate-800 focus:ring-2 focus:ring-indigo-500" value={vendorAssetForm.price} onChange={e => setVendorAssetForm({...vendorAssetForm, price: e.target.value})} />
                  </div>
                </div>
                <button onClick={handleSaveVendorAsset} className="w-full rounded bg-indigo-600 py-2 text-white text-sm font-medium hover:bg-indigo-700">Add Asset</button>
            </div>

            <div>
                <h4 className="text-sm font-bold text-slate-800 mb-2">Current Assets</h4>
                <div className="max-h-60 overflow-y-auto border rounded-lg">
                    <table className="w-full text-sm text-left"><thead className="bg-slate-100 text-slate-800 font-bold sticky top-0"><tr><th className="p-2">Item</th><th className="p-2">Qty</th><th className="p-2">Price</th><th className="p-2"></th></tr></thead><tbody className="divide-y divide-slate-100">
                        {inventory.filter(i => i.vendor_id === selectedVendorForAssets?.id).map(item => (
                            <tr key={item.id}><td className="p-2 text-black">{item.name}<div className="text-xs text-slate-500">{item.category}</div></td><td className="p-2 text-black">{item.total}</td><td className="p-2 text-black">{formatCurrency(item.rate_per_day)}</td><td className="p-2 text-right"><button onClick={() => handleDeleteAsset(item.id)} className="text-red-500 hover:text-red-700"><Trash2 size={14}/></button></td></tr>
                        ))}
                        {inventory.filter(i => i.vendor_id === selectedVendorForAssets?.id).length === 0 && <tr><td colSpan={4} className="p-4 text-center text-slate-400">No assets listed.</td></tr>}
                    </tbody></table>
                </div>
            </div>
        </div>
      </Modal>
      <ConfirmDeleteModal isOpen={confirmModal.isOpen} onClose={() => setConfirmModal({...confirmModal, isOpen: false})} onConfirm={confirmModal.onConfirm} title={confirmModal.title} message={confirmModal.message} requireTyped={confirmModal.requireTyped} />
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
//     if(!await confirmDialog("Are you sure? This will delete the project and all associated data.")) return;
//     await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', id));
//   };

//   const handleSaveProject = async () => {
//     if(!newProj.client_id || !newProj.project_name) return addToast("Missing fields", 'error');
//     const data = { ...newProj, updated_at: serverTimestamp() };
//     if (editingId) {
//       await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', editingId), data);
//     } else {
//       await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'projects'), { ...data, created_by: user.uid, created_at: serverTimestamp() });
//     }
//     setIsCreateOpen(false); 
//   };

//   const updateStatus = async (pid, newStatus) => {
//     if (newStatus === 'Closed' && role !== 'admin') return addToast("Only Admin can close projects.", 'info');
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
//     if(!allocationForm.item_id) return addToast("Select an item", 'error');
//     const item = inventory.find(i => i.id === allocationForm.item_id);
//     if (allocationForm.qty > allocationForm.available_qty) {
//       if(!await confirmDialog(`Warning: You are allocating ${allocationForm.qty} but only ${allocationForm.available_qty} are available. Proceed?`)) return;
//     }
//     const amount = allocationForm.qty * allocationForm.rate * allocationForm.days;
//     const newItem = { id: Date.now().toString(), item_id: item.id, item_name: item.name, category: item.category, is_external: item.is_external || false, qty: parseInt(allocationForm.qty), rate: parseFloat(allocationForm.rate), days: parseInt(allocationForm.days), gst_rate: parseFloat(allocationForm.gst_rate), amount, gst_amount: amount * (allocationForm.gst_rate/100), total: amount * (1 + allocationForm.gst_rate/100) };
//     await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), { items: arrayUnion(newItem) });
//     setAllocationForm(p => ({...p, item_id: '', qty: 1, available_qty: 0})); 
//   };

//   const handleRemoveAllocation = async (item) => {
//     if(await confirmDialog("Remove this item?")) await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), { items: arrayRemove(item) });
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
//     if(!await confirmDialog("Are you sure? This will delete the project and all associated data.")) return;
//     await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', id));
//   };

//   const handleSaveProject = async () => {
//     if(!newProj.client_id || !newProj.project_name) return addToast("Missing fields", 'error');
//     const data = { ...newProj, updated_at: serverTimestamp() };
//     if (editingId) {
//       await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', editingId), data);
//     } else {
//       await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'projects'), { ...data, created_by: user.uid, created_at: serverTimestamp() });
//     }
//     setIsCreateOpen(false); 
//   };

//   const updateStatus = async (pid, newStatus) => {
//     if (newStatus === 'Closed' && role !== 'admin') return addToast("Only Admin can close projects.", 'info');
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
//     if(!allocationForm.item_id) return addToast("Select an item", 'error');
//     const item = inventory.find(i => i.id === allocationForm.item_id);
//     if (allocationForm.qty > allocationForm.available_qty) {
//       if(!await confirmDialog(`Warning: You are allocating ${allocationForm.qty} but only ${allocationForm.available_qty} are available. Proceed?`)) return;
//     }
//     const amount = allocationForm.qty * allocationForm.rate * allocationForm.days;
//     const newItem = { id: Date.now().toString(), item_id: item.id, item_name: item.name, category: item.category, is_external: item.is_external || false, qty: parseInt(allocationForm.qty), rate: parseFloat(allocationForm.rate), days: parseInt(allocationForm.days), gst_rate: parseFloat(allocationForm.gst_rate), amount, gst_amount: amount * (allocationForm.gst_rate/100), total: amount * (1 + allocationForm.gst_rate/100) };
//     await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), { items: arrayUnion(newItem) });
//     setAllocationForm(p => ({...p, item_id: '', qty: 1, available_qty: 0})); 
//   };

//   const handleRemoveAllocation = async (item) => {
//     if(await confirmDialog("Remove this item?")) await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProject.id), { items: arrayRemove(item) });
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


const Outsourcing = ({ projects, clients, inventory, role, currentEmpId = null, db, appId, logAction }) => {
  // A manager sees outsourcing (PO costs, vendor allocations, PI totals) only for
  // their OWN projects — never another manager's client's. (This is the inline,
  // routed copy; keep it in sync with src/pages/Outsourcing.jsx.)
  const scopedProjects = useMemo(
    () => (role === 'manager'
      ? (projects || []).filter(p => p.client_owner_id === currentEmpId || p.created_by === currentEmpId)
      : (projects || [])),
    [projects, role, currentEmpId],
  );
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
    package_cost: 0,
    package_cost_gst: 18,
    attachments: []
  });
  const [poSearch, setPoSearch] = useState('');
  const PO_STATUSES = ['Draft', 'Sent', 'Approved', 'Partial', 'Paid', 'Closed', 'Cancelled'];

  // Edit States
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editingAllocation, setEditingAllocation] = useState(null);
  const [showPendingOnly, setShowPendingOnly] = useState(false);
  const [showCancelledPOs, setShowCancelledPOs] = useState(false);
  const [poCurrentPage, setPoCurrentPage] = useState(1);
  const poItemsPerPage = 20;
  const [allocPage, setAllocPage] = useState(1);
  const allocItemsPerPage = 5;

  // Vendor Invoice States
  const [isInvoiceModalOpen, setIsInvoiceModalOpen] = useState(false);
  const [invoicingPO, setInvoicingPO] = useState(null);
  const [invoiceForm, setInvoiceForm] = useState({
    invoice_no: '',
    invoice_date: new Date().toISOString().split('T')[0],
    base_amount: 0,
    gst_rate: 18,
    gst_amount: 0,
    total_amount: 0,
    status: 'Received',
    notes: '',
    received_date: new Date().toISOString().split('T')[0],
  });

  // NEW STATES FOR EDITING PO
  const [editingPO, setEditingPO] = useState(null);
  const [poItems, setPoItems] = useState([]);
  
  const [allocWizardSelection, setAllocWizardSelection] = useState({}); // { itemId: { selected: true, qty, rate, days } }

  const selectedProject = projects.find(p => p.id === selectedProjectId);
  // Money arrays (vendor_allocations / purchase_orders) are stripped OFF the base doc
  // and mirrored into project_financials (onProjectWritten trigger). A getDoc/
  // transaction.get of the base returns them undefined, so read-modify-write against
  // the base alone would write back [] and wipe the sibling on the next mirror.
  // Fall back to the merged in-memory project (loader overlays the sibling).
  const getMergedProject = (pId) => projects.find(p => String(p.id) === String(pId));
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

  const paginatedAllocations = useMemo(() => {
    const start = (allocPage - 1) * allocItemsPerPage;
    return allocationsByVendor.slice(start, start + allocItemsPerPage);
  }, [allocationsByVendor, allocPage]);

  useEffect(() => {
    setAllocPage(1);
  }, [selectedProjectId]);

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
      if (!vendorForm.vendor_id) return notify("Select Vendor first", 'error');
      
      const selectedItemIds = Object.keys(allocWizardSelection).filter(id => allocWizardSelection[id]?.selected);
      if (selectedItemIds.length === 0) return notify("Select at least one item to allocate", 'error');

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
          if (invItem) gst = invItem.gst_rate != null ? invItem.gst_rate : 18; // 0% must stay 0%, not `|| 18`

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
          // Full-array write: arrayUnion onto the stripped base field would recreate
          // it with only the new rows and the mirror would wipe older allocations.
          await updateDoc(projectRef, { vendor_allocations: [...(selectedProject?.vendor_allocations || []), ...newAllocations] });
          logAction('projects', 'add_outsourcing', selectedProjectId, { count: newAllocations.length }, selectedProject.project_name);
          setIsAllocWizardOpen(false);
          setAllocWizardSelection({});
      } catch (e) {
          console.error(e);
          notify("Failed to allocate", 'error');
      }
  };

  const handleUpdateAllocation = async (updatedAllocation) => {
    try {
      // Check if linked to PO
      if (updatedAllocation.po_id) {
          notify("Notice: This item is linked to a PO. Please update the PO if necessary.", 'error');
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
        const baseAllocs = pData.vendor_allocations ?? getMergedProject(selectedProjectId)?.vendor_allocations ?? [];
        const newAllocations = baseAllocs.map(a => a.id === editingAllocation.id ? finalAllocation : a);
        transaction.update(projectRef, { vendor_allocations: newAllocations });
      });
      logAction('projects', 'update_outsourcing', selectedProjectId, { old: editingAllocation, new: finalAllocation }, selectedProject.project_name);
      setEditingAllocation(null);
      setIsEditModalOpen(false);
    } catch (err) {
      console.error(err);
      notify("Failed to update allocation: " + err.message, 'error');
    }
  };

  const handleRemove = async (alloc) => {
    if(await confirmDialog("Remove this vendor allocation?")) {
        // Filter by id: arrayRemove can't deep-equal-match the merged on-screen copy
        // against the stripped base field — it would reset the field to [] and the
        // mirror would wipe ALL allocations from the sibling.
        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'projects', selectedProjectId), {
          vendor_allocations: (selectedProject?.vendor_allocations || []).filter(a => a.id !== alloc.id)
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

  const openInvoiceModal = (po) => {
    setInvoicingPO(po);
    const existing = po.vendor_invoice || {};
    setInvoiceForm({
      invoice_no: existing.invoice_no || '',
      invoice_date: existing.invoice_date || new Date().toISOString().split('T')[0],
      base_amount: existing.base_amount || 0,
      gst_rate: existing.gst_rate !== undefined ? existing.gst_rate : 18,
      gst_amount: existing.gst_amount || 0,
      total_amount: existing.total_amount || 0,
      status: existing.status || 'Received',
      notes: existing.notes || '',
      received_date: existing.received_date || new Date().toISOString().split('T')[0],
    });
    setIsInvoiceModalOpen(true);
  };

  const handleSaveVendorInvoice = async () => {
    if (!invoiceForm.invoice_no || !invoiceForm.invoice_date) return notify('Invoice number and date required', 'error');
    const pId = selectedProjectId || invoicingPO?.projectId || invoicingPO?.project_id;
    if (!pId) return notify('Project context missing', 'error');
    const base = parseFloat(invoiceForm.base_amount) || 0;
    const gstRate = parseFloat(invoiceForm.gst_rate) || 0;
    const gst = base * (gstRate / 100);
    const total = base + gst;
    const vendorInvoice = {
      invoice_no: invoiceForm.invoice_no,
      invoice_date: invoiceForm.invoice_date,
      base_amount: base,
      gst_rate: gstRate,
      gst_amount: gst,
      total_amount: total,
      status: invoiceForm.status,
      notes: invoiceForm.notes,
      received_date: invoiceForm.received_date,
      updated_at: new Date().toISOString(),
    };
    try {
      const projectRef = doc(db, 'artifacts', appId, 'public', 'data', 'projects', pId);
      await runTransaction(db, async (transaction) => {
        const pDoc = await transaction.get(projectRef);
        if (!pDoc.exists()) throw new Error('Project not found');
        const pData = pDoc.data();
        const basePOs = pData.purchase_orders ?? getMergedProject(pId)?.purchase_orders ?? [];
        const updatedPOs = basePOs.map(p =>
          p.id === invoicingPO.id ? { ...p, vendor_invoice: vendorInvoice } : p
        );
        transaction.update(projectRef, { purchase_orders: updatedPOs });
      });
      logAction('projects', 'save_vendor_invoice', pId, { po_no: invoicingPO.po_no, invoice_no: vendorInvoice.invoice_no }, selectedProject?.project_name || 'Unknown');
      setIsInvoiceModalOpen(false);
      setInvoicingPO(null);
    } catch (e) {
      console.error(e);
      notify('Error saving invoice: ' + e.message, 'error');
    }
  };

  const getInvoiceBadge = (po) => {
    const inv = po.vendor_invoice;
    if (!inv || !inv.invoice_no) return <span className="text-xs text-slate-400 italic">—</span>;
    const colors = {
      Received: 'bg-yellow-100 text-yellow-800 border-yellow-200',
      Verified: 'bg-blue-100 text-blue-800 border-blue-200',
      Accepted: 'bg-green-100 text-green-800 border-green-200',
      Disputed: 'bg-red-100 text-red-800 border-red-200',
    };
    return (
      <div className="flex flex-col items-center gap-0.5">
        <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${colors[inv.status] || 'bg-slate-100 text-slate-600 border-slate-200'}`}>{inv.status}</span>
        <span className="text-xs text-slate-500 truncate max-w-[100px]" title={inv.invoice_no}>{inv.invoice_no}</span>
      </div>
    );
  };

  const handleCreatePO = async () => {
      if (!poForm.po_no || !poForm.date) return notify("PO Number and Date required", 'error');
      const pId = selectedProjectId || poVendorData?.projectId;
      if (!pId) return notify("Project context missing", 'error');
      
      // Use package cost if specified, otherwise sum all costs
      let subtotal = 0;
      let finalGstRate = poForm.gst_rate || 0;
      if (poForm.package_cost && poForm.package_cost > 0) {
        subtotal = poForm.package_cost;
        finalGstRate = poForm.package_cost_gst ?? 18;
      } else {
        subtotal = (poForm.equipment_cost || 0) + (poForm.labour_cost || 0) + (poForm.transport_cost || 0) + (poForm.fnb_cost || 0) + (poForm.travel_cost || 0) + (poForm.accommodation_cost || 0) + (poForm.misc_cost || 0);
      }
      const gstAmount = subtotal * (finalGstRate / 100);
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
          gst_rate_applied: finalGstRate,
          is_package: poForm.is_package,
          package_cost: poForm.package_cost || 0,
          package_cost_gst: poForm.package_cost_gst ?? 18,
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
              const baseAllocs = pData.vendor_allocations ?? getMergedProject(pId)?.vendor_allocations ?? [];
              const updatedAllocations = baseAllocs.map(alloc => {
                  if (poVendorData.items.find(i => i.id === alloc.id)) {
                      // Update allocation with PO details including package cost if specified
                      const updatedAlloc = { ...alloc, po_id: poId, po_no: newPO.po_no };
                      if (newPO.package_cost && newPO.package_cost > 0) {
                          // If PO has package cost, sync it to allocation
                          updatedAlloc.package_cost = newPO.package_cost;
                          updatedAlloc.package_cost_gst = newPO.package_cost_gst ?? 18;
                          updatedAlloc.gst_rate_applied = newPO.gst_rate_applied;
                          updatedAlloc.amount = newPO.amount; // Store the calculated total
                      }
                      return updatedAlloc;
                  }
                  return alloc;
              });
              
              const updatedPOs = [...(pData.purchase_orders ?? getMergedProject(pId)?.purchase_orders ?? []), newPO];

              transaction.update(projectRef, {
                  vendor_allocations: updatedAllocations,
                  purchase_orders: updatedPOs
              });
          });
          
          logAction('projects', 'create_po', pId, { po_no: newPO.po_no }, selectedProject?.project_name || 'Unknown Project');
          setIsPOModalOpen(false);
          if(await confirmDialog("PO Created. Print now?")) generatePOPDF(newPO, 'print');
      } catch (e) {
          console.error(e);
          notify("Error creating PO: " + e.message, 'error');
      }
  };

  const handleUpdatePO = async () => {
      if (!poForm.po_no || !poForm.date) return notify("PO Number and Date required", 'error');
      const pId = selectedProjectId || editingPO?.projectId;
      if (!pId) return notify("Project context missing", 'error');

      // Use package cost if specified, otherwise sum all costs
      let subtotal = 0;
      let finalGstRate = poForm.gst_rate || 0;
      if (poForm.package_cost && poForm.package_cost > 0) {
        subtotal = poForm.package_cost;
        finalGstRate = poForm.package_cost_gst ?? 18;
      } else {
        subtotal = (poForm.equipment_cost || 0) + (poForm.labour_cost || 0) + (poForm.transport_cost || 0) + (poForm.fnb_cost || 0) + (poForm.travel_cost || 0) + (poForm.accommodation_cost || 0) + (poForm.misc_cost || 0);
      }
      const gstAmount = subtotal * (finalGstRate / 100);
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
          gst_rate_applied: finalGstRate,
          is_package: poForm.is_package,
          package_cost: poForm.package_cost || 0,
          package_cost_gst: poForm.package_cost_gst ?? 18,
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
              const basePOs = pData.purchase_orders ?? getMergedProject(pId)?.purchase_orders ?? [];
              const updatedPOs = basePOs.map(p => p.id === editingPO.id ? updatedPO : p);

              // Update linked allocations with PO cost information
              const baseAllocs = pData.vendor_allocations ?? getMergedProject(pId)?.vendor_allocations ?? [];
              const updatedAllocations = baseAllocs.map(alloc => {
                  if (alloc.po_id === editingPO.id) {
                      // Update allocation with PO details including package cost if specified
                      const updatedAlloc = { ...alloc, description: poItems.find(i => i.id === alloc.id)?.description || alloc.description };
                      if (updatedPO.package_cost && updatedPO.package_cost > 0) {
                          // If PO has package cost, sync it to allocation
                          updatedAlloc.package_cost = updatedPO.package_cost;
                          updatedAlloc.package_cost_gst = updatedPO.package_cost_gst ?? 18;
                          updatedAlloc.gst_rate_applied = updatedPO.gst_rate_applied;
                          updatedAlloc.amount = updatedPO.amount; // Store the calculated total
                      } else {
                          // Remove package cost fields if switching back to itemized
                          delete updatedAlloc.package_cost;
                          delete updatedAlloc.package_cost_gst;
                          delete updatedAlloc.gst_rate_applied;
                      }
                      return updatedAlloc;
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
          if(await confirmDialog("PO Updated. Print now?")) generatePOPDF(updatedPO, 'print');
      } catch (e) {
          console.error(e);
          notify("Error updating PO: " + e.message, 'error');
      }
  };

  const handleFileUpload = (e) => {
      const files = Array.from(e.target.files);
      files.forEach(file => {
          if (file.size > 1024 * 1024) { // 1MB limit per file
              notify(`File ${file.name} is too large (max 1MB)`, 'info');
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
          if (!await confirmDialog("Are you sure you want to cancel this PO? This will release the allocated inventory for re-allocation.")) return;
      }

      try {
          const projectRef = doc(db, 'artifacts', appId, 'public', 'data', 'projects', pId);
          await runTransaction(db, async (transaction) => {
              const pDoc = await transaction.get(projectRef);
              if (!pDoc.exists()) throw "Project not found";
              
              const pData = pDoc.data();
              const basePOs = pData.purchase_orders ?? getMergedProject(pId)?.purchase_orders ?? [];
              const updatedPOs = basePOs.map(p => {
                  if (p.id === po.id) {
                      return { ...p, status: newStatus };
                  }
                  return p;
              });

              let updatedAllocations = pData.vendor_allocations ?? getMergedProject(pId)?.vendor_allocations ?? [];
              if (newStatus === 'Cancelled') {
                  updatedAllocations = updatedAllocations.filter(alloc => alloc.po_id !== po.id);
              }
              
              transaction.update(projectRef, { purchase_orders: updatedPOs, vendor_allocations: updatedAllocations });
          });
          logAction('projects', 'update_po_status', pId, { po_no: po.po_no, status: newStatus }, "PO Status Update");
      } catch (e) {
          console.error(e);
          notify("Error updating status: " + e.message, 'error');
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
          notify("Failed to generate PDF. Check console for details.", 'error');
      }
  };

  const allPOs = useMemo(() => {
      if (selectedProjectId) return [];
      const list = [];
      scopedProjects.forEach(p => {
          if (p.purchase_orders) {
              p.purchase_orders.forEach(po => list.push({ ...po, projectName: p.project_name, projectId: p.id }));
          }
      });
      return list.sort((a, b) => {
          const dateDiff = new Date(b.date) - new Date(a.date);
          if (dateDiff !== 0) return dateDiff;
          return (b.po_no || '').localeCompare(a.po_no || '');
      });
  }, [scopedProjects, selectedProjectId]);

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
          notify("Failed to generate PDF", 'error');
      }
  };

  const filteredAllPOs = useMemo(() => {
      return allPOs.filter(po => 
          ((po.vendor_name || '').toLowerCase().includes(poSearch.toLowerCase()) ||
          (po.po_no || '').toLowerCase().includes(poSearch.toLowerCase())) &&
          (showCancelledPOs || po.status !== 'Cancelled')
      );
  }, [allPOs, poSearch, showCancelledPOs]);

  const paginatedAllPOs = useMemo(() => {
    const start = (poCurrentPage - 1) * poItemsPerPage;
    return filteredAllPOs.slice(start, start + poItemsPerPage);
  }, [filteredAllPOs, poCurrentPage]);

  const poSubtotal = poForm.package_cost > 0 
    ? poForm.package_cost 
    : ((poForm.equipment_cost || 0) + (poForm.labour_cost || 0) + (poForm.transport_cost || 0) + (poForm.fnb_cost || 0) + (poForm.travel_cost || 0) + (poForm.accommodation_cost || 0) + (poForm.misc_cost || 0));
  const poGstAmount = poForm.package_cost > 0
    ? (poForm.package_cost * ((poForm.package_cost_gst || 0) / 100))
    : (poSubtotal * ((poForm.gst_rate || 0) / 100));
  const poGrandTotal = poSubtotal + poGstAmount;

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <h2 className="text-2xl font-bold text-slate-800">Outsourcing Manager</h2>
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
            {scopedProjects.filter(p => ['Confirmed', 'Ongoing'].includes(p.status)).map(p => (
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
                <h3 className="font-bold text-slate-700 flex items-center gap-2">
                    <AlertCircle size={18} className="text-indigo-500" /> Project Requirements
                </h3>
                <label className="flex items-center gap-2 text-xs cursor-pointer select-none bg-white px-2 py-1 rounded border border-slate-200 hover:bg-slate-50 bg-slate-50 border-slate-200 hover:bg-slate-50">
                    <input type="checkbox" checked={showPendingOnly} onChange={e => setShowPendingOnly(e.target.checked)} className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
                    <span className="text-slate-600 font-medium">Pending Only</span>
                </label>
            </div>
            {renderItemList(externalItems, "External Items (Priority)", "text-orange-600")}
            {renderItemList(internalItems, "Internal Items (Can Outsource)", "text-slate-500")}
          </div>

          {/* Right: Vendor Allocation */}
          <div className="rounded-xl border bg-white p-4 shadow-sm flex flex-col overflow-hidden bg-slate-50 border-slate-200">
            <div className="flex justify-between items-center mb-4">
                <h3 className="font-bold text-slate-700 flex items-center gap-2">
                  <Truck size={18} className="text-indigo-500" />
                  Vendor Allocations
                </h3>
                <button onClick={exportAllocationSummary} className="text-xs flex items-center gap-1 bg-white border border-slate-200 rounded px-2 py-1 hover:bg-slate-50 text-slate-600"><FileText size={14} /> Export PDF</button>
            </div>
            
            {/* New Allocation Button */}
            <div className="mb-4">
                <button onClick={() => setIsAllocWizardOpen(true)} className="w-full py-3 rounded-lg bg-indigo-600 text-white font-bold hover:bg-indigo-700 flex items-center justify-center gap-2">
                    <Plus size={20} /> Create New Allocation
                </button>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto space-y-4">
              {paginatedAllocations.map(group => (
                <div key={group.id} className="border rounded-lg overflow-hidden bg-white bg-slate-50 border-slate-200">
                    <div className="bg-slate-100 p-2 px-3 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 bg-slate-50">
                        <div className="font-bold text-slate-700">{group.name}</div>
                        {role !== 'tech' && (
                        <div className="text-xs text-slate-600 flex gap-3 bg-white px-2 py-1 rounded border">
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
                                    <div className="font-medium text-slate-800">{alloc.item_name} {alloc.description && <span className="text-xs font-normal text-slate-500 italic">- {alloc.description}</span>}</div>
                                    <div className="text-xs text-slate-500 text-slate-400"><span className="bg-slate-100 px-1 rounded bg-slate-600 text-slate-200">x{alloc.qty}</span> {role !== 'tech' ? `| Rate: ${alloc.rate} | Days: ${alloc.days} | GST: ${alloc.gst}%` : `| Days: ${alloc.days}`}</div>
                                </div>
                                <div className="text-right">
                                    {role !== 'tech' && <div className="font-bold text-slate-800">{formatCurrency(alloc.tax_amount)}</div>}
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
            {allocationsByVendor.length > allocItemsPerPage && (
                <div className="flex items-center justify-between pt-4 border-t mt-2">
                    <div className="text-xs text-slate-500">Page {allocPage} of {Math.ceil(allocationsByVendor.length / allocItemsPerPage)}</div>
                    <div className="flex gap-2">
                        <button onClick={() => setAllocPage(p => Math.max(1, p - 1))} disabled={allocPage === 1} className="px-2 py-1 rounded border bg-indigo-600 text-white hover:bg-indigo-700 border-indigo-600 disabled:opacity-50 text-xs">Prev</button>
                        <button onClick={() => setAllocPage(p => Math.min(Math.ceil(allocationsByVendor.length / allocItemsPerPage), p + 1))} disabled={allocPage === Math.ceil(allocationsByVendor.length / allocItemsPerPage)} className="px-2 py-1 rounded border bg-indigo-600 text-white hover:bg-indigo-700 border-indigo-600 disabled:opacity-50 text-xs">Next</button>
                    </div>
                </div>
            )}
          </div>
        </div>
        ) : (
          <div className="space-y-6">
             {/* Pending POs */}
             <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
                <h3 className="font-bold text-slate-700 mb-4 flex items-center gap-2"><AlertCircle size={18} className="text-orange-500"/> Pending Purchase Orders</h3>
                <div className="grid md:grid-cols-3 gap-4">
                   {pendingPOVendors.map((group, idx) => (
                      <div key={idx} className="border rounded-lg p-4 hover:shadow-md transition-shadow border-slate-200">
                         <div className="flex justify-between items-start mb-2">
                            <div className="font-bold text-slate-800">{group.vendor.name}</div>
                            <div className="text-xs bg-orange-100 text-orange-700 px-2 py-1 rounded">{group.items.length} Items</div>
                         </div>
                         <div className="text-sm text-slate-500 mb-3">Total Value: {formatCurrency(group.totalAmount)}</div>
                         <button onClick={() => openPOModal(group)} className="w-full py-2 bg-indigo-600 text-white rounded text-sm hover:bg-indigo-700">Create PO</button>
                      </div>
                   ))}
                   {pendingPOVendors.length === 0 && <div className="col-span-3 text-center text-slate-400 py-4">No pending items for PO.</div>}
                </div>
             </div>

             {/* Issued POs */}
             <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
                <div className="flex justify-between items-center mb-4">
                    <h3 className="font-bold text-slate-700 flex items-center gap-2"><FileCheck size={18} className="text-green-600"/> Issued Purchase Orders</h3>
                    <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
                        <input type="checkbox" checked={showCancelledPOs} onChange={e => setShowCancelledPOs(e.target.checked)} className="w-4 h-4 cursor-pointer accent-indigo-600 rounded border-slate-300" />
                        <span className="text-slate-600 font-medium">Show Cancelled</span>
                    </label>
                </div>
                <div className="overflow-x-auto">
                   <table className="w-full text-sm text-left">
                      <thead className="bg-slate-50 text-slate-700 font-semibold"><tr><th className="p-3">PO No</th><th className="p-3">Date</th><th className="p-3">Vendor</th><th className="p-3">Subject</th><th className="p-3 text-right">PO Amount</th><th className="p-3">Status</th><th className="p-3 text-center">Vendor Invoice</th><th className="p-3 text-center">Action</th></tr></thead>
                      <tbody className="divide-y divide-slate-100">
                         {(selectedProject.purchase_orders || []).filter(po => showCancelledPOs || po.status !== 'Cancelled').map((po, idx) => (
                            <tr key={idx} className="hover:bg-slate-50">
                               <td className="p-3 font-medium text-slate-800">{po.po_no}</td>
                               <td className="p-3 text-black">{new Date(po.date).toLocaleDateString()}</td>
                               <td className="p-3 text-black font-medium">{po.vendor_name}</td>
                               <td className="p-3 text-slate-600 truncate max-w-[200px]">{po.subject}</td>
                               <td className="p-3 text-right font-bold text-black">{formatCurrency((po.package_cost && po.package_cost > 0) ? po.package_cost * (1 + (po.package_cost_gst || 0) / 100) : po.amount)}</td>
                               <td className="p-3">
                                   <select className={`text-xs border rounded p-1 text-black ${po.status === 'Paid' ? 'bg-green-50 text-green-700 border-green-200' : 'bg-slate-50'}`} value={po.status || 'Draft'} onChange={(e) => updatePOStatus(po, e.target.value)}>
                                       {PO_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                                   </select>
                               </td>
                               <td className="p-3 text-center">
                                 <div className="flex flex-col items-center gap-1">
                                   {getInvoiceBadge(po)}
                                   {po.vendor_invoice?.invoice_no && (
                                     <span className="text-xs text-black font-medium">{formatCurrency(po.vendor_invoice.total_amount)}</span>
                                   )}
                                   <button onClick={() => openInvoiceModal(po)} className="text-xs text-purple-600 hover:underline flex items-center gap-1 mt-0.5"><ReceiptText size={12}/> {po.vendor_invoice?.invoice_no ? 'Edit' : 'Feed Invoice'}</button>
                                 </div>
                               </td>
                               <td className="p-3 text-center flex justify-center gap-2">
                                   <button onClick={() => generatePOPDF(po, 'print')} className="text-indigo-600 hover:underline flex items-center gap-1"><Printer size={14}/> Print</button>
                                   <button onClick={() => generatePOPDF(po, 'download')} className="text-blue-600 hover:underline flex items-center gap-1"><Download size={14}/> PDF</button>
                                   <button onClick={() => openPOModal(po, true)} className="text-orange-600 hover:underline flex items-center gap-1"><Edit size={14}/> Edit</button>
                                   <button onClick={() => handleDuplicatePO(po)} className="text-green-600 hover:underline flex items-center gap-1"><Copy size={14}/> Copy</button>
                               </td>
                            </tr>
                         ))}
                         {(selectedProject.purchase_orders || []).filter(po => showCancelledPOs || po.status !== 'Cancelled').length === 0 && <tr><td colSpan={8} className="p-6 text-center text-slate-400">No POs to display.</td></tr>}
                      </tbody>
                   </table>
                </div>
             </div>
          </div>
        )
      ) : (
             <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
                <div className="flex justify-between items-center mb-4">
                    <h3 className="font-bold text-slate-700 flex items-center gap-2"><FileCheck size={18} className="text-green-600"/> Recent Purchase Orders</h3>
                    <div className="flex items-center gap-4">
                        <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
                            <input type="checkbox" checked={showCancelledPOs} onChange={e => setShowCancelledPOs(e.target.checked)} className="w-4 h-4 cursor-pointer accent-indigo-600 rounded border-slate-300" />
                            <span className="text-slate-600 font-medium">Show Cancelled</span>
                        </label>
                        <div className="flex items-center rounded border px-3 py-1 bg-white">
                            <Search size={16} className="text-slate-400 mr-2" />
                            <input placeholder="Search Vendor or PO..." className="text-sm outline-none text-black bg-transparent" value={poSearch} onChange={(e) => setPoSearch(e.target.value)} />
                        </div>
                    </div>
                </div>
                <div className="overflow-x-auto">
                     <table className="w-full text-sm text-left">
                        <thead className="bg-slate-50 text-slate-700 font-semibold"><tr><th className="p-3">PO No</th><th className="p-3">Date</th><th className="p-3">Project</th><th className="p-3">Vendor</th><th className="p-3 text-right">PO Amount</th><th className="p-3">Status</th><th className="p-3 text-center">Vendor Invoice</th><th className="p-3 text-center">Actions</th></tr></thead>
                        <tbody className="divide-y divide-slate-100">
                           {paginatedAllPOs.map((po, idx) => (
                              <tr key={idx} className="hover:bg-slate-50">
                                 <td className="p-3 font-medium text-slate-800">{po.po_no}</td>
                                 <td className="p-3 text-black">{new Date(po.date).toLocaleDateString()}</td>
                                 <td className="p-3 text-black font-medium">{po.projectName}</td>
                                 <td className="p-3 text-black font-medium">{po.vendor_name}</td>
                                 <td className="p-3 text-right font-bold text-black">{formatCurrency(po.amount)}</td>
                                 <td className="p-3">
                                     <select className={`text-xs border rounded p-1 text-black ${po.status === 'Paid' ? 'bg-green-50 text-green-700 border-green-200' : 'bg-slate-50'}`} value={po.status || 'Draft'} onChange={(e) => updatePOStatus(po, e.target.value)}>
                                         {PO_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                                     </select>
                                 </td>
                                 <td className="p-3 text-center">
                                   <div className="flex flex-col items-center gap-1">
                                     {getInvoiceBadge(po)}
                                     {po.vendor_invoice?.invoice_no && (
                                       <span className="text-xs text-black font-medium">{formatCurrency(po.vendor_invoice.total_amount)}</span>
                                     )}
                                     <button onClick={() => openInvoiceModal(po)} className="text-xs text-purple-600 hover:underline flex items-center gap-1 mt-0.5"><ReceiptText size={12}/> {po.vendor_invoice?.invoice_no ? 'Edit' : 'Feed Invoice'}</button>
                                   </div>
                                 </td>
                                 <td className="p-3 text-center flex justify-center gap-2">
                                     <button onClick={() => generatePOPDF(po, 'print')} className="text-indigo-600 hover:underline flex items-center gap-1"><Printer size={14}/> Print</button>
                                     <button onClick={() => generatePOPDF(po, 'download')} className="text-blue-600 hover:underline flex items-center gap-1"><Download size={14}/> PDF</button>
                                      <button onClick={() => openPOModal(po, true)} className="text-orange-600 hover:underline flex items-center gap-1"><Edit size={14}/> Edit</button>
                                      <button onClick={() => handleDuplicatePO(po)} className="text-green-600 hover:underline flex items-center gap-1"><Copy size={14}/> Copy</button>
                                 </td>
                              </tr>
                           ))}
                           {filteredAllPOs.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-slate-400">No POs found.</td></tr>}
                        </tbody>
                     </table>
                </div>
                {filteredAllPOs.length > poItemsPerPage && (
                  <div className="flex items-center justify-between p-4 border-t bg-white bg-slate-50 border-slate-200">
                      <div className="text-sm text-slate-500">
                          Showing {Math.min((poCurrentPage - 1) * poItemsPerPage + 1, filteredAllPOs.length)} to {Math.min(poCurrentPage * poItemsPerPage, filteredAllPOs.length)} of {filteredAllPOs.length} results
                      </div>
                      <div className="flex gap-2">
                          <button onClick={() => setPoCurrentPage(p => Math.max(1, p - 1))} disabled={poCurrentPage === 1} className="px-3 py-1 rounded border bg-indigo-600 text-white hover:bg-indigo-700 border-indigo-600 disabled:opacity-50 text-sm">Previous</button>
                          <button onClick={() => setPoCurrentPage(p => Math.min(Math.ceil(filteredAllPOs.length / poItemsPerPage), p + 1))} disabled={poCurrentPage === Math.ceil(filteredAllPOs.length / poItemsPerPage)} className="px-3 py-1 rounded border bg-indigo-600 text-white hover:bg-indigo-700 border-indigo-600 disabled:opacity-50 text-sm">Next</button>
                      </div>
                  </div>
                )}
             </div>
          )}
      <EditAllocationModal
        isOpen={isEditModalOpen}
        onClose={() => setIsEditModalOpen(false)}
        allocation={editingAllocation}
        onSave={handleUpdateAllocation}
      />

      {/* Vendor Invoice Modal */}
      <Modal isOpen={isInvoiceModalOpen} onClose={() => setIsInvoiceModalOpen(false)} title={`Vendor Invoice — ${invoicingPO?.po_no || ''}`}>
        <div className="space-y-4">
          <div className="bg-slate-50 p-3 rounded text-sm border border-slate-200 text-slate-800">
            <div className="flex justify-between">
              <div><strong>Vendor:</strong> {invoicingPO?.vendor_name}</div>
              <div><strong>PO Amount:</strong> {formatCurrency((invoicingPO?.package_cost && invoicingPO?.package_cost > 0) ? invoicingPO?.package_cost * (1 + (invoicingPO?.package_cost_gst || 0) / 100) : (invoicingPO?.amount || 0))}</div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-bold text-slate-700">Invoice Number *</label>
              <input className="w-full rounded border border-slate-300 p-2 text-slate-800" value={invoiceForm.invoice_no} onChange={e => setInvoiceForm({...invoiceForm, invoice_no: e.target.value})} placeholder="INV/2025-26/001" />
            </div>
            <div>
              <label className="text-xs font-bold text-slate-700">Invoice Date *</label>
              <input type="date" className="w-full rounded border border-slate-300 p-2 text-slate-800" value={invoiceForm.invoice_date} onChange={e => setInvoiceForm({...invoiceForm, invoice_date: e.target.value})} />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="text-xs font-bold text-slate-700">Base Amount (excl. GST) ₹</label>
              <input type="number" step="0.01" className="w-full rounded border border-slate-300 p-2 text-slate-800" value={invoiceForm.base_amount} onChange={e => {
                const base = parseFloat(e.target.value) || 0;
                const gst = base * ((invoiceForm.gst_rate || 0) / 100);
                setInvoiceForm({...invoiceForm, base_amount: base, gst_amount: gst, total_amount: base + gst});
              }} />
            </div>
            <div>
              <label className="text-xs font-bold text-slate-700">GST Rate %</label>
              <select className="w-full rounded border border-slate-300 p-2 text-slate-800" value={invoiceForm.gst_rate} onChange={e => {
                const rate = parseFloat(e.target.value) || 0;
                const gst = (invoiceForm.base_amount || 0) * (rate / 100);
                setInvoiceForm({...invoiceForm, gst_rate: rate, gst_amount: gst, total_amount: (invoiceForm.base_amount || 0) + gst});
              }}>
                <option value="0">0% (Unregistered / Exempt)</option>
                <option value="5">5%</option>
                <option value="12">12%</option>
                <option value="18">18%</option>
                <option value="28">28%</option>
              </select>
            </div>
            <div className="bg-indigo-50 p-3 rounded-lg border border-indigo-200">
              <div className="text-xs text-slate-500">GST: {formatCurrency(invoiceForm.gst_amount)}</div>
              <div className="text-base font-bold text-indigo-700">Total: {formatCurrency(invoiceForm.total_amount)}</div>
              {(() => {
                const poAmt = invoicingPO ? ((invoicingPO.package_cost && invoicingPO.package_cost > 0)
                  ? invoicingPO.package_cost * (1 + (invoicingPO.package_cost_gst || 0) / 100)
                  : (invoicingPO.amount || 0)) : 0;
                const variance = (invoiceForm.total_amount || 0) - poAmt;
                if (Math.abs(variance) < 0.01) return null;
                return (
                  <div className={`text-xs font-semibold mt-1 ${variance > 0 ? 'text-red-600' : 'text-green-600'}`}>
                    {variance > 0 ? '▲ Overage' : '▼ Saving'}: {formatCurrency(Math.abs(variance))}
                  </div>
                );
              })()}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-bold text-slate-700">Invoice Status</label>
              <select className="w-full rounded border border-slate-300 p-2 text-slate-800" value={invoiceForm.status} onChange={e => setInvoiceForm({...invoiceForm, status: e.target.value})}>
                <option value="Received">Received — Under Review</option>
                <option value="Verified">Verified — Amounts Checked (use for accounting)</option>
                <option value="Accepted">Accepted — Final (use for accounting)</option>
                <option value="Disputed">Disputed — On Hold</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-bold text-slate-700">Date Received</label>
              <input type="date" className="w-full rounded border border-slate-300 p-2 text-slate-800" value={invoiceForm.received_date} onChange={e => setInvoiceForm({...invoiceForm, received_date: e.target.value})} />
            </div>
          </div>
          <div className="rounded-lg p-3 bg-amber-50 border border-amber-200 text-xs text-amber-800">
            <strong>Accounting Impact:</strong> When status is <strong>Verified</strong> or <strong>Accepted</strong>, the invoice amount replaces the PO amount in P&amp;L and GST Input Credit calculations. Set GST Rate to 0% for unregistered vendors.
          </div>
          <div>
            <label className="text-xs font-bold text-slate-700">Notes</label>
            <textarea className="w-full rounded border border-slate-300 p-2 text-sm text-black" rows={2} value={invoiceForm.notes} onChange={e => setInvoiceForm({...invoiceForm, notes: e.target.value})} placeholder="Payment terms, dispute details, reference numbers..." />
          </div>
          <button onClick={handleSaveVendorInvoice} className="w-full rounded bg-indigo-600 text-white py-2 font-bold hover:bg-indigo-700">
            Save Vendor Invoice
          </button>
        </div>
      </Modal>

      {/* Allocation Wizard Modal */}
      <Modal isOpen={isAllocWizardOpen} onClose={() => setIsAllocWizardOpen(false)} title="New Allocation">
          <div className="space-y-4 h-[70vh] flex flex-col">
              <div className="grid grid-cols-2 gap-4">
                  <div>
                      <label className="text-xs font-bold text-slate-700">Project</label>
                      <input className="w-full rounded border border-slate-300 p-2 bg-slate-50 text-slate-500" value={selectedProject?.project_name || ''} disabled />
                  </div>
                  <div>
                      <label className="text-xs font-bold text-slate-700">Vendor</label>
                      <select className="w-full rounded border border-slate-300 p-2 text-black" value={vendorForm.vendor_id} onChange={e => setVendorForm({...vendorForm, vendor_id: e.target.value})}>
                          <option value="">-- Select Vendor --</option>
                          {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                      </select>
                  </div>
              </div>

              <div className="flex-1 overflow-y-auto border rounded-lg">
                  <table className="w-full text-sm text-left">
                      <thead className="bg-slate-100 text-slate-500 font-bold sticky top-0"><tr><th className="p-2 w-8"></th><th className="p-2">Item</th><th className="p-2 text-center">Req</th><th className="p-2 text-center">Rem</th><th className="p-2 w-20">Qty</th><th className="p-2 w-24">Rate</th><th className="p-2 w-16">Days</th></tr></thead>
                      <tbody className="divide-y divide-slate-100">
                          {allProjectItems.map(item => {
                              const remaining = getRemainingQty(item.item_id);
                              const isSelected = allocWizardSelection[item.item_id]?.selected;
                              return (
                                  <tr key={item.item_id} className={isSelected ? 'bg-indigo-50' : ''}>
                                      <td className="p-2"><input type="checkbox" checked={!!isSelected} onChange={e => setAllocWizardSelection(prev => ({...prev, [item.item_id]: { ...prev[item.item_id], selected: e.target.checked, qty: prev[item.item_id]?.qty || remaining, rate: prev[item.item_id]?.rate || 0, days: prev[item.item_id]?.days || getDaysDifference(selectedProject.start_date, selectedProject.end_date) } }))} className="w-4 h-4 cursor-pointer accent-indigo-600" /></td>
                                      <td className="p-2"><div className="font-medium text-slate-800">{item.item_name}</div>{item.is_external && <span className="text-[10px] bg-purple-100 text-purple-700 px-1 rounded">Ext</span>}</td>
                                      <td className="p-2 text-center text-slate-500">{item.qty}</td>
                                      <td className="p-2 text-center font-bold text-slate-800">{remaining}</td>
                                      <td className="p-2"><input type="number" className="w-full border border-slate-300 rounded p-1 text-slate-800 bg-white" value={allocWizardSelection[item.item_id]?.qty || ''} onChange={e => setAllocWizardSelection(prev => ({...prev, [item.item_id]: { ...prev[item.item_id], qty: e.target.value } }))} disabled={!isSelected} /></td>
                                      <td className="p-2"><input type="number" className="w-full border border-slate-300 rounded p-1 text-slate-800 bg-white" value={allocWizardSelection[item.item_id]?.rate || ''} onChange={e => setAllocWizardSelection(prev => ({...prev, [item.item_id]: { ...prev[item.item_id], rate: e.target.value } }))} disabled={!isSelected} /></td>
                                      <td className="p-2"><input type="number" className="w-full border border-slate-300 rounded p-1 text-slate-800 bg-white" value={allocWizardSelection[item.item_id]?.days || ''} onChange={e => setAllocWizardSelection(prev => ({...prev, [item.item_id]: { ...prev[item.item_id], days: e.target.value } }))} disabled={!isSelected} /></td>
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
            <div className="bg-slate-50 p-3 rounded text-sm border text-slate-800"><strong>Vendor:</strong> {poVendorData?.vendor.name} <br/> <strong>Items:</strong> {poItems.length}</div>
            <div className="grid grid-cols-2 gap-4"><div><label className="text-xs font-bold text-slate-700">PO Number</label><input className="w-full rounded border border-slate-300 p-2 text-slate-800" value={poForm.po_no} onChange={e => setPoForm({...poForm, po_no: e.target.value})} /></div><div><label className="text-xs font-bold text-slate-700">Date</label><input type="date" className="w-full rounded border border-slate-300 p-2 text-slate-800" value={poForm.date} onChange={e => setPoForm({...poForm, date: e.target.value})} /></div></div>
            <div><label className="text-xs font-bold text-slate-700">Subject</label><input className="w-full rounded border border-slate-300 p-2 text-slate-800" value={poForm.subject} onChange={e => setPoForm({...poForm, subject: e.target.value})} /></div>
            
            <div className="border rounded overflow-hidden max-h-40 overflow-y-auto">
                <table className="w-full text-xs text-left">
                    <thead className="bg-slate-100 text-slate-800 font-bold sticky top-0">
                        <tr>
                            <th className="p-2">Item</th>
                            <th className="p-2 w-16">Qty</th>
                            <th className="p-2">Description</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {poItems.map((item, idx) => (
                            <tr key={idx}>
                                <td className="p-2 text-slate-800">{item.item_name}</td>
                                <td className="p-2"><input type="number" className="w-full border border-slate-300 rounded p-1 text-slate-800" value={item.qty} onChange={(e) => {
                                    const newItems = [...poItems];
                                    newItems[idx].qty = parseInt(e.target.value) || 0;
                                    setPoItems(newItems);
                                }} /></td>
                                <td className="p-2"><input type="text" className="w-full border border-slate-300 rounded p-1 text-slate-800" value={item.description || ''} onChange={(e) => {
                                    const newItems = [...poItems];
                                    newItems[idx].description = e.target.value;
                                    setPoItems(newItems);
                                }} /></td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <div className="border-t border-slate-200 pt-4 mt-4">
              <h4 className="text-sm font-bold text-slate-800 mb-2">Cost Breakdown</h4>
              <div className="flex items-center gap-2 mb-4 p-3 bg-slate-50 rounded border border-slate-200">
                  <input type="checkbox" id="isPackageCost" checked={poForm.package_cost > 0} onChange={e => {
                    if (e.target.checked) {
                      setPoForm({...poForm, package_cost: 1000, package_cost_gst: Number.isFinite(parseFloat(poForm.gst_rate)) ? parseFloat(poForm.gst_rate) : 18});
                    } else {
                      setPoForm({...poForm, package_cost: 0, package_cost_gst: 18});
                    }
                  }} className="w-4 h-4 cursor-pointer accent-indigo-600 accent-indigo-500 rounded border-slate-300 border-slate-200" />
                  <label htmlFor="isPackageCost" className="text-xs font-bold text-slate-700 cursor-pointer">Use Package Cost (Lump Sum)</label>
              </div>

              {poForm.package_cost > 0 ? (
                <div className="grid grid-cols-3 gap-4 mb-4">
                  <div>
                    <label className="text-xs font-bold text-slate-700">Package Cost (excl. GST)</label>
                    <input type="number" step="0.01" className="w-full rounded border border-slate-300 border-slate-200 bg-slate-50 text-slate-800 p-2" value={poForm.package_cost} onChange={e => setPoForm({...poForm, package_cost: parseFloat(e.target.value) || 0})} />
                  </div>
                  <div>
                    <label className="text-xs font-bold text-slate-700">GST Rate (%)</label>
                    <select className="w-full rounded border border-slate-300 p-2 text-slate-800" value={poForm.package_cost_gst ?? 18} onChange={e => setPoForm({...poForm, package_cost_gst: Number.isFinite(parseFloat(e.target.value)) ? parseFloat(e.target.value) : 18})}>
                        <option value="0">0%</option><option value="5">5%</option><option value="12">12%</option><option value="18">18%</option><option value="28">28%</option>
                    </select>
                  </div>
                  <div className="bg-indigo-50 p-3 rounded-lg text-right border border-indigo-200">
                    <div className="text-xs text-slate-600 font-semibold">Package Total</div>
                    <div className="text-lg font-bold text-indigo-700">{formatCurrency(poForm.package_cost * (1 + (poForm.package_cost_gst ?? 18) / 100))}</div>
                    <div className="text-xs text-slate-500">GST: {formatCurrency(poForm.package_cost * ((poForm.package_cost_gst ?? 18) / 100))}</div>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-4 mb-4">
                  <div><label className="text-xs font-bold text-slate-700">Equipment Cost</label><input type="number" className="w-full rounded border border-slate-300 border-slate-200 bg-slate-50 text-slate-800 p-2" value={poForm.equipment_cost} onChange={e => setPoForm({...poForm, equipment_cost: parseFloat(e.target.value) || 0})} /></div>
                  <div><label className="text-xs font-bold text-slate-700">Labour Cost</label><input type="number" className="w-full rounded border border-slate-300 border-slate-200 bg-slate-50 text-slate-800 p-2" value={poForm.labour_cost} onChange={e => setPoForm({...poForm, labour_cost: parseFloat(e.target.value) || 0})} /></div>
                  <div><label className="text-xs font-bold text-slate-700">Transport Cost</label><input type="number" className="w-full rounded border border-slate-300 border-slate-200 bg-slate-50 text-slate-800 p-2" value={poForm.transport_cost} onChange={e => setPoForm({...poForm, transport_cost: parseFloat(e.target.value) || 0})} /></div>
                  <div><label className="text-xs font-bold text-slate-700">F&B Cost</label><input type="number" className="w-full rounded border border-slate-300 bg-slate-50 text-slate-800 p-2" value={poForm.fnb_cost} onChange={e => setPoForm({...poForm, fnb_cost: parseFloat(e.target.value) || 0})} /></div>
                  <div><label className="text-xs font-bold text-slate-700">Travel Cost</label><input type="number" className="w-full rounded border border-slate-300 bg-slate-50 text-slate-800 p-2" value={poForm.travel_cost} onChange={e => setPoForm({...poForm, travel_cost: parseFloat(e.target.value) || 0})} /></div>
                  <div><label className="text-xs font-bold text-slate-700">Accommodation</label><input type="number" className="w-full rounded border border-slate-300 bg-slate-50 text-slate-800 p-2" value={poForm.accommodation_cost} onChange={e => setPoForm({...poForm, accommodation_cost: parseFloat(e.target.value) || 0})} /></div>
                  <div><label className="text-xs font-bold text-slate-700">Misc Cost</label><input type="number" className="w-full rounded border border-slate-300 bg-slate-50 text-slate-800 p-2" value={poForm.misc_cost} onChange={e => setPoForm({...poForm, misc_cost: parseFloat(e.target.value) || 0})} /></div>
                </div>
              )}

              <div className="grid grid-cols-3 gap-4 mt-4">
                  <div className="col-span-1">
                      <label className="text-xs font-bold text-slate-700">GST Rate</label>
                      <select className="w-full rounded border border-slate-300 p-2 text-slate-800 bg-slate-50" value={poForm.gst_rate} onChange={e => setPoForm({...poForm, gst_rate: parseFloat(e.target.value) || 0})}>
                          <option value="0">0%</option><option value="5">5%</option><option value="12">12%</option><option value="18">18%</option><option value="28">28%</option>
                      </select>
                  </div>
                  <div className="col-span-2 bg-slate-100 p-3 rounded-lg text-right">
                      <div className="text-xs text-slate-500">Subtotal: {formatCurrency(poSubtotal)}</div>
                      <div className="text-xs text-slate-500">GST ({poForm.package_cost > 0 ? poForm.package_cost_gst : poForm.gst_rate}%): {formatCurrency(poGstAmount)}</div>
                      <div className="text-lg font-bold text-indigo-700">Total: {formatCurrency(poGrandTotal)}</div>
                  </div>
              </div>
            </div>

            <div className="border-t pt-4 mt-4">
                <h4 className="text-sm font-bold text-slate-800 mb-2 flex items-center gap-2"><Paperclip size={16}/> Attachments</h4>
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

            <div><label className="text-xs font-bold text-slate-700">Terms & Conditions</label><textarea className="w-full rounded border border-slate-300 p-2 text-sm text-black" rows={3} value={poForm.terms} onChange={e => setPoForm({...poForm, terms: e.target.value})} /></div>
            <div><label className="text-xs font-bold text-slate-700">Internal Notes</label><textarea className="w-full rounded border border-slate-300 p-2 text-sm text-black" rows={2} value={poForm.notes} onChange={e => setPoForm({...poForm, notes: e.target.value})} /></div>
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
          <label className="text-xs font-bold text-slate-700">Quantity</label>
          <input
            type="number"
            className="w-full rounded border border-slate-300 p-1 text-black"
            value={formData.qty}
            onChange={(e) => setFormData({ ...formData, qty: e.target.value })}
          />
        </div>
        <div>
          <label className="text-xs font-bold text-slate-700">Rate</label>
          <input
            type="number"
            className="w-full rounded border border-slate-300 p-1 text-black"
            value={formData.rate}
            onChange={(e) => setFormData({ ...formData, rate: e.target.value })}
          />
        </div>
        <div>
          <label className="text-xs font-bold text-slate-700">Days</label>
          <input
            type="number"
            className="w-full rounded border border-slate-300 p-1 text-black"
            value={formData.days}
            onChange={(e) => setFormData({ ...formData, days: e.target.value })}
          />
        </div>
        <div>
          <label className="text-xs font-bold text-slate-700">GST %</label>
          <input
            type="number"
            className="w-full rounded border border-slate-300 p-1 text-black"
            value={formData.gst}
            onChange={(e) => setFormData({ ...formData, gst: e.target.value })}
          />
        </div>
        <div>
          <label className="text-xs font-bold text-slate-700">Description</label>
          <input
            type="text"
            className="w-full rounded border border-slate-300 p-1 text-black"
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
            className="w-full rounded border p-1 text-black bg-white"
            value={formData?.qty || ''}
            onChange={(e) => setFormData({ ...formData, qty: e.target.value })}
          />
        </div>
        <div>
          <label className="text-xs font-bold text-slate-700">Rate</label>
          <input
            type="number"
            className="w-full rounded border p-1 text-black bg-slate-50 border-slate-200"
            value={formData?.rate || ''}
            onChange={(e) => setFormData({ ...formData, rate: e.target.value })}
          />
        </div>
        <div>
          <label className="text-xs font-bold text-slate-700">Days</label>
          <input
            type="number"
            className="w-full rounded border p-1 text-black bg-slate-50 border-slate-200"
            value={formData?.days || ''}
            onChange={(e) => setFormData({ ...formData, days: e.target.value })}
          />
        </div>
        <div>
          <label className="text-xs font-bold text-slate-700">Description</label>
          <input
            type="text"
            className="w-full rounded border p-1 text-black bg-slate-50 border-slate-200"
            value={formData?.description || ''}
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

//version 1.1.0   reports, employee mgmt, expense mgmt, inventory mgmt

export default function App() {
  const location = useLocation();
  const [theme, setTheme] = useState(localStorage.getItem('theme') || 'light');
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState(null); 
  const [impersonating, setImpersonating] = useState(null); // { empId, name, role } | null — admin view-as
  // SaaS only: set when a platform staffer is inside a tenant workspace via an
  // audited support token (claim support:true). Null on private (no such claim).
  const [supportSession, setSupportSession] = useState(null); // { staffUid } | null
  const [showImpersonateModal, setShowImpersonateModal] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isAssistantOpen, setIsAssistantOpen] = useState(false);
  const [currentEmpId, setCurrentEmpId] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState(null);
  const [showForgotPass, setShowForgotPass] = useState(false);
  const [showEmpForgotPass, setShowEmpForgotPass] = useState(false);
  const [recoveryForm, setRecoveryForm] = useState({ key: '', new_pass: '' });
  const [isBootstrap, setIsBootstrap] = useState(false);
  const [resetRequestEmail, setResetRequestEmail] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [toasts, setToasts] = useState([]);

  const offlineState = useOfflineMode(db, appId);

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    localStorage.setItem('theme', theme);
  }, [theme]);

  // Keyboard shortcuts
  const navigate = useNavigate();
  useEffect(() => {
    if (!role) return; // Only active when logged in
    const handler = (e) => {
      const tag = document.activeElement?.tagName;
      const isTyping = ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || document.activeElement?.isContentEditable;

      // Ctrl+K or / = open global search
      if ((e.ctrlKey && e.key === 'k') || (!isTyping && e.key === '/')) {
        e.preventDefault();
        setIsSearchOpen(true);
        return;
      }
      // Escape = close search
      if (e.key === 'Escape') {
        setIsSearchOpen(false);
        return;
      }
      if (isTyping) return;
      // ? = show shortcuts (inside search overlay)
      if (e.key === '?') {
        e.preventDefault();
        setIsSearchOpen(true);
        return;
      }
      // Alt+key navigation shortcuts
      if (e.altKey) {
        switch (e.key.toLowerCase()) {
          case 'd': e.preventDefault(); navigate('/dashboard'); break;
          case 'p': e.preventDefault(); navigate('/projects'); break;
          case 'c': e.preventDefault(); navigate('/clients'); break;
          case 'i': e.preventDefault(); navigate('/inventory'); break;
          case 'f': if (can(role,'finance','view')) { e.preventDefault(); navigate('/finance'); } break;
          case 'a': if (can(role,'finance','view')) { e.preventDefault(); navigate('/accounting'); } break;
          case 'r': if (can(role,'reports','view')) { e.preventDefault(); navigate('/reports'); } break;
          default: break;
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [role, navigate]);


  // Login Form State
  const [loginForm, setLoginForm] = useState({ username: '', password: '', tenant: IS_SAAS ? (appId || '') : '' });
  const [loginError, setLoginError] = useState('');

  // Data States
  const [projects, setProjects] = useState([]);
  const [clients, setClients] = useState([]);
  const [inventory, setInventory] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [advances, setAdvances] = useState([]);
  const [vendorPayments, setVendorPayments] = useState([]);
  const [purchaseInvoicesList, setPurchaseInvoicesList] = useState([]);
  const [taxInvoicesList, setTaxInvoicesList] = useState([]);
  const [payments, setPayments] = useState([]);
  const [payouts, setPayouts] = useState([]);
  const [chartOfAccounts, setChartOfAccounts] = useState([]);
  const [journalEntries, setJournalEntries] = useState([]);
  const [openingBalances, setOpeningBalances] = useState([]);
  const [fiscalYearClosings, setFiscalYearClosings] = useState([]);
  const [recurringRules, setRecurringRules] = useState([]);
  const [partyAccounts, setPartyAccounts] = useState([]);  // M-5: stable party name registry
  const [lockedFYs, setLockedFYs] = useState([]);
  const [customInventoryCategories, setCustomInventoryCategories] = useState([]);
  const [customExpenseCategories, setCustomExpenseCategories] = useState([]);
  const [configurations, setConfigurations] = useState([]);

// HR Module State
const [timeLogs, setTimeLogs] = useState([]);
const [hrLeaves, setHrLeaves] = useState([]);
const [shiftRequests, setShiftRequests] = useState([]);
const [penalties, setPenalties] = useState([]);
const [hqSettings, setHqSettings] = useState(DEFAULT_HQ_SETTINGS);
const [payroll, setPayroll] = useState([]);
  // --- Auth & Data Fetching ---

  const currentEmployee = employees.find(e => e.id === currentEmpId);
  const effectiveRole = impersonating ? impersonating.role : role;       // use throughout routes
  const effectiveEmpId = impersonating ? impersonating.empId : currentEmpId;
  const chatUnread = useChatUnread(db, appId, effectiveEmpId);            // unread badge for the Chat nav item

  // Strip sensitive fields from employees before passing to child components
  // Strip password always; strip pay fields (hourlyRate + history) for roles
  // without employees.view_pay so colleague salary never enters their client
  // state. (The raw employees doc still embeds pay — SDK-readable — which is the
  // same accepted embedded-financial carve-out as projects/inventory, closed by
  // the future financial-field-split migration.)
  const canSeePayFields = can(effectiveRole, 'employees', 'view_pay');
  const safeEmployees = useMemo(() =>
    employees.map(({ password, password_hashed, ...rest }) => {
      if (canSeePayFields) return rest;
      const { hourlyRate, hourlyRateHistory, monthly_ctc, ctc, salary, ...noPay } = rest;
      return noPay;
    }),
    [employees, canSeePayFields]
  );

  useEffect(() => {
    // Handle initial custom token (Claude Code / embedding contexts only).
    if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
      signInWithCustomToken(auth, __initial_auth_token).catch(console.error);
    }

    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (!u) {
        // No session at all — create an anonymous one so the login page
        // can be shown (anonymous sessions are blocked from Firestore reads
        // of employees/settings by the hardened rules).
        setLoading(false);
        signInAnonymously(auth).catch(() => { /* ignore */ });
      }
      // If u is non-null but anonymous, leave it; the login flow will
      // upgrade to a real session via verifyLogin + signInWithCustomToken.
      // Do NOT call signInAnonymously when a real (non-anonymous) session
      // already exists — that would replace it with a fresh anonymous one.
    });
    return () => unsubscribe();
  }, []);

  // SaaS: detect an audited support session from the token's `support` claim so
  // every action is stamped and a banner is shown. No-op on private (the block
  // compiles out — IS_SAAS folds to false — and no token ever carries `support`).
  useEffect(() => {
    if (!IS_SAAS) return;
    if (!user || user.isAnonymous) { setSupportSession(null); return; }
    getIdTokenResult(user)
      .then((res) => {
        setSupportSession(res.claims && res.claims.support
          ? { staffUid: res.claims.staff_uid || '' }
          : null);
      })
      .catch(() => setSupportSession(null));
  }, [user]);

  // meta/active_apps registration now happens SERVER-SIDE inside verifyLogin
  // (Admin SDK) on each successful login. The old client write here let any
  // authenticated (even anonymous) session inject arbitrary appIds into the
  // scheduler registry — a squat/flood risk once appIds are SaaS tenant codes.
  // Rules now deny client writes to meta/active_apps.

  useEffect(() => {
    if (!user) return;
    // SaaS: no active tenant selected yet (pre-login) — nothing to subscribe to.
    if (!appId) { setLoading(false); return; }

    // Anonymous sessions (login page) must NOT read Firestore — the
    // verifyLogin Cloud Function handles all credential lookups server-side.
    if (user.isAnonymous) {
      setLoading(false);
      return;
    }

    const noop = () => {};
    // Non-anonymous: load employees (needed for role restore from localStorage
    // on page reload and for all app features).
    // Field-split slice 2: employee pay (hourlyRate/history/ctc/salary) lives in the
    // gated employee_pay sibling (admin/accountant = view_pay). Merge it back over the
    // base employee docs so admin/accountant see pay unchanged; manager/tech/user load
    // the base only (no pay). safeEmployees still strips pay defensively downstream.
    const payViewer = role === 'admin' || role === 'accountant';
    let _empBase = []; let _empPay = {};
    const _applyEmpMerge = () => setEmployees(_empBase.map(e => ({ ...e, ...(_empPay[e.id] || {}) })));
    const unsubEmployees = onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', 'employees'), (snap) => {
      _empBase = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      _applyEmpMerge();
    });
    const unsubEmployeePay = payViewer
      ? onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', 'employee_pay'), (snap) => {
          _empPay = Object.fromEntries(snap.docs.map(d => [d.id, d.data()]));
          _applyEmpMerge();
        }, () => {})
      : noop;

    if (!role) {
      setLoading(false); // Stop loading to show login screen
      return () => unsubEmployees();
    }

    // Owner-scoping: a MANAGER loads only the CLIENTS they own (manager-vs-manager
    // client isolation, enforced by firestore.rules). PROJECTS load in full for
    // every role — a manager sees OTHER projects OPERATIONALLY (shared calendar /
    // inventory-conflict view) while the UI strips financials on projects whose
    // client they don't own (projectFinanceVisible). Admin, accountant, user and
    // tech load everything. user.uid === emp id; the scoped client query is
    // REQUIRED — a global client query is denied by rules for a manager.
    const projectsCol = collection(db, 'artifacts', appId, 'public', 'data', 'projects');
    const clientsCol = collection(db, 'artifacts', appId, 'public', 'data', 'clients');
    const seesAllClients = role === 'admin' || role === 'accountant';
    const scopeClients = role === 'manager';
    const myEmpId = user.uid;

    // Field-split slice 3: project money is mirrored to the gated project_financials
    // sibling. Merge it back over base projects for authorised roles (admin/accountant
    // ALL; a manager only their OWN — two owner-scoped queries, since Firestore can't OR
    // client_owner_id/created_by in one); tech/user load base only. Transparent to the
    // ~25 downstream pages. Additive until slice-3b scrub — the overlay equals the base
    // values once backfilled, so this changes nothing visible.
    const _pfViewer = role === 'admin' || role === 'accountant';
    const _pfCol = collection(db, 'artifacts', appId, 'public', 'data', 'project_financials');
    let _projBase = []; let _finA = {}; let _finB = {};
    const _applyProjMerge = () => {
      const fin = { ..._finA, ..._finB };
      setProjects(_projBase.map(p => {
        const f = fin[p.id];
        if (!f) return p;
        const money = {};
        for (const k in f) { if (k !== 'client_owner_id' && k !== 'created_by' && k !== 'updated_at') money[k] = f[k]; }
        return { ...p, ...money };
      }));
    };
    const unsubProjects = onSnapshot(projectsCol, (snap) => {
      _projBase = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      _applyProjMerge();
    });
    let unsubProjFinA = noop; let unsubProjFinB = noop;
    if (_pfViewer) {
      unsubProjFinA = onSnapshot(_pfCol, (snap) => { _finA = {}; snap.docs.forEach(d => { _finA[d.id] = d.data(); }); _applyProjMerge(); }, noop);
    } else if (myEmpId) {
      // Any owner (manager for own projects, coordinator for referred clients) loads
      // their OWN project money via two owner-scoped queries; a coordinator's Commission
      // page needs it. tech/non-owners simply match nothing.
      unsubProjFinA = onSnapshot(query(_pfCol, where('client_owner_id', '==', myEmpId)), (snap) => { _finA = {}; snap.docs.forEach(d => { _finA[d.id] = d.data(); }); _applyProjMerge(); }, noop);
      unsubProjFinB = onSnapshot(query(_pfCol, where('created_by', '==', myEmpId)), (snap) => { _finB = {}; snap.docs.forEach(d => { _finB[d.id] = d.data(); }); _applyProjMerge(); }, noop);
    }
    let unsubClients;
    if (seesAllClients) {
      unsubClients = onSnapshot(clientsCol, (snap) => setClients(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
    } else if (scopeClients) {
      unsubClients = onSnapshot(query(clientsCol, where('owner_id', '==', myEmpId)),
        (snap) => setClients(snap.docs.map(d => ({ id: d.id, ...d.data() }))), () => {});
    } else {
      // tech / user: no raw client access (rules deny it — client docs carry
      // opening_balance/referral_rate). Load the stripped contact directory
      // (name/phone/address only) via getContacts so name resolution + the
      // Contacts page still work with zero financial fields.
      unsubClients = () => {};
      httpsCallable(getFunctions(), 'getContacts')({ appId })
        .then((res) => setClients((res.data && res.data.contacts) || []))
        .catch(() => setClients([]));
    }
    // Field-split slice 1: inventory rates/costs live in the gated inventory_financials
    // sibling (admin/accountant/manager read). Merge them back over the base inventory
    // docs so the ~13 downstream pages get rate_per_day/purchase_cost/etc unchanged for
    // authorised roles; tech/user load the base only (no money — their operational
    // stock/scan views need none, and the base is scrubbed of money by the migration).
    const invRatesViewer = role === 'admin' || role === 'accountant' || role === 'manager';
    let _invBase = []; let _invFin = {};
    const _applyInvMerge = () => setInventory(_invBase.map(it => ({ ...it, ...(_invFin[it.id] || {}) })));
    const unsubInventory = onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', 'inventory'), (snap) => {
      _invBase = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      _applyInvMerge();
    });
    const unsubInventoryFin = invRatesViewer
      ? onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', 'inventory_financials'), (snap) => {
          _invFin = Object.fromEntries(snap.docs.map(d => [d.id, d.data()]));
          _applyInvMerge();
        }, () => {})
      : noop;
    // Expenses: admin/accountant/manager see all; tech/user see ONLY their own
    // (amounts are financial). The scoped query is required once the rule restricts.
    const expensesViewer = role === 'admin' || role === 'accountant' || role === 'manager';
    const expensesCol = collection(db, 'artifacts', appId, 'public', 'data', 'expenses');
    const unsubExpenses = onSnapshot(
      expensesViewer ? expensesCol : query(expensesCol, where('employee_id', '==', user.uid)),
      (snap) => setExpenses(snap.docs.map(d => ({ id: d.id, ...d.data() }))), () => {});
    // Finance-viewer gate + helpers. Owner/Accountant see all finance data; other
    // roles are scoped (self-scoped for payroll, none for company ledgers) so a
    // restricted read never hits permission-denied once the rules tighten.
    const financeViewer = role === 'admin' || role === 'accountant';
    const finCol = (name) => collection(db, 'artifacts', appId, 'public', 'data', name);
    // advances + payouts carry employee_id → admin/accountant all; everyone else
    // sees ONLY their own (the scoped query is required once rules restrict reads).
    const unsubAdvances = onSnapshot(
      financeViewer ? finCol('advances') : query(finCol('advances'), where('employee_id', '==', myEmpId)),
      (snap) => setAdvances(snap.docs.map(d => ({ id: d.id, ...d.data() }))), noop);
    const unsubPayouts = onSnapshot(
      financeViewer ? finCol('payouts') : query(finCol('payouts'), where('employee_id', '==', myEmpId)),
      (snap) => setPayouts(snap.docs.map(d => ({ id: d.id, ...d.data() }))), noop);
    //version 1.3.0 finance implementation enabled code
    // Invoices + vendor payments: Owner/Accountant/Manager only (tech/user have no
    // stake). payments stays global for now — the 'user' commission view reads it
    // (owner-denormalisation scoping is a dedicated later Slice-C step).
    const partyFinanceViewer = financeViewer || role === 'manager';
    // payments: admin/accountant/manager see all; a Coordinator (user) sees only
    // payments of clients they referred (client_owner_id == me, for commission);
    // tech gets none. client_owner_id is maintained server-side (onPaymentWritten).
    const unsubPayments = partyFinanceViewer
      ? onSnapshot(finCol('payments'), (snap) => setPayments(snap.docs.map(d => ({ id: d.id, ...d.data() }))))
      : (role === 'user'
          ? onSnapshot(query(finCol('payments'), where('client_owner_id', '==', myEmpId)), (snap) => setPayments(snap.docs.map(d => ({ id: d.id, ...d.data() }))), noop)
          : noop);
    const unsubVendorPayments = partyFinanceViewer ? onSnapshot(finCol('vendor_payments'), (snap) => setVendorPayments(snap.docs.map(d => ({ id: d.id, ...d.data() }))), noop) : noop;
    // purchase_invoices: admin/accountant only (permissions.js) — a manager has no
    // stake in vendor/PO cost, and firestore.rules denies manager reads (round-17).
    const unsubPurchaseInvoices = financeViewer ? onSnapshot(finCol('purchase_invoices'), (snap) => setPurchaseInvoicesList(snap.docs.map(d => ({ id: d.id, ...d.data() }))), noop) : noop;
    const unsubTaxInvoices = partyFinanceViewer ? onSnapshot(finCol('tax_invoices'), (snap) => setTaxInvoicesList(snap.docs.map(d => ({ id: d.id, ...d.data() }))), noop) : noop;
    // Company-wide accounting ledgers are Owner/Accountant-only at the rule level;
    // only subscribe for those roles (others would get permission-denied).
    const unsubChartOfAccounts = financeViewer ? onSnapshot(finCol('chart_of_accounts'), (snap) => setChartOfAccounts(snap.docs.map(d => ({ id: d.id, ...d.data() }))), noop) : noop;
    const unsubJournalEntries = financeViewer ? onSnapshot(finCol('journal_entries'), (snap) => setJournalEntries(snap.docs.map(d => ({ id: d.id, ...d.data() }))), noop) : noop;
    const unsubOpeningBalances = financeViewer ? onSnapshot(finCol('opening_balances'), (snap) => setOpeningBalances(snap.docs.map(d => ({ id: d.id, ...d.data() }))), noop) : noop;
    const unsubFiscalYearClosings = financeViewer ? onSnapshot(finCol('fiscal_year_closings'), (snap) => setFiscalYearClosings(snap.docs.map(d => ({ id: d.id, ...d.data() }))), noop) : noop;
    const unsubRecurringRules = financeViewer ? onSnapshot(finCol('recurring_rules'), (snap) => setRecurringRules(snap.docs.map(d => ({ id: d.id, ...d.data() }))), noop) : noop;
    // M-5: stable party-name registry for ledger display-name resolution
    const unsubPartyAccounts = financeViewer ? onSnapshot(finCol('party_accounts'), (snap) => setPartyAccounts(snap.docs.map(d => ({ id: d.id, ...d.data() }))), noop) : noop;
    const unsubOrgSettings = onSnapshot(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'organization'), (snap) => {
      if (snap.exists()) setLockedFYs(snap.data().locked_fys || []);
    });
    const unsubCategorySettings = onSnapshot(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'categories'), (snap) => {
      if (snap.exists()) {
        setCustomInventoryCategories(snap.data().inventory_categories || []);
        setCustomExpenseCategories(snap.data().expense_categories || []);
      }
    });
    const unsubConfigurations = onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', 'configurations'), (snap) => setConfigurations(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
//version 1.3.0 finance implementation enabled code

    // HR Module Listeners
    const unsubTimeLogs = onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', 'timeLogs'), (snap) => setTimeLogs(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
    const unsubHrLeaves = onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', 'leaves'), (snap) => setHrLeaves(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
    const unsubShiftRequests = onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', 'shiftRequests'), (snap) => setShiftRequests(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
    // penalties (HR disciplinary): Owner/Accountant/Manager only. payroll (salary):
    // Owner/Accountant only. Others don't subscribe (rules deny them).
    const unsubPenalties = partyFinanceViewer ? onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', 'penalties'), (snap) => setPenalties(snap.docs.map(d => ({ id: d.id, ...d.data() }))), noop) : noop;
    const unsubPayroll = financeViewer ? onSnapshot(collection(db, 'artifacts', appId, 'public', 'data', 'payroll'), (snap) => setPayroll(snap.docs.map(d => ({ id: d.id, ...d.data() }))), noop) : noop;
    const unsubHqSettings = onSnapshot(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'hq'), (snap) => {
      if (snap.exists()) setHqSettings({ ...DEFAULT_HQ_SETTINGS, ...snap.data() });
    });

    setLoading(false);
//  //version 1.3.0 finance implementation depcreated code
    // return () => {
    //   unsubProjects(); unsubClients(); unsubInventory(); unsubExpenses(); unsubEmployees(); unsubAdvances();
    // };
//version 1.3.0 finance implementation depcreated code

  //version 1.3.0 finance implementation enabled code
    return () => {
    unsubProjects(); unsubProjFinA(); unsubProjFinB(); unsubClients(); unsubInventory(); unsubInventoryFin(); unsubExpenses(); unsubVendorPayments();
    unsubEmployees(); unsubEmployeePay(); unsubAdvances(); unsubPayments(); unsubPayouts(); unsubOrgSettings(); unsubCategorySettings();
    unsubTimeLogs(); unsubHrLeaves(); unsubShiftRequests(); unsubPenalties(); unsubPayroll(); unsubHqSettings(); unsubPurchaseInvoices(); unsubTaxInvoices();
    unsubChartOfAccounts(); unsubJournalEntries(); unsubOpeningBalances(); unsubFiscalYearClosings(); unsubRecurringRules(); unsubConfigurations(); unsubPartyAccounts();
    };  
      //version 1.3.0 finance implementation enabled code
  }, [user, role]);

  // Load RBAC config from Firestore so can() uses admin-configured permissions
  useEffect(() => {
    if (!role) return;
    const loadRBAC = async () => {
      try {
        const snap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'rbac'));
        if (snap.exists()) setLiveConfig(snap.data());
      } catch (e) {
        console.warn('RBAC config load failed, using defaults:', e.message);
      }
    };
    loadRBAC();
  }, [role]); // re-load if role changes (e.g. after login)

  // SaaS: load the tenant's plan entitlements so the nav/pages can hide features
  // the plan doesn't include. Local `ent` state makes the gated nav reactive;
  // setEntitlements() also populates the module singleton featureOn() uses in
  // pages. No-op on private — hasFeature() then defaults to ON (nothing hidden).
  const [ent, setEnt] = useState(null);
  useEffect(() => {
    if (!IS_SAAS || !role || !appId) return;
    getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'entitlements'))
      .then((snap) => { const e = snap.exists() ? snap.data() : null; setEnt(e); setEntitlements(e); })
      .catch(() => { setEnt(null); setEntitlements(null); });
  }, [role]);
  // A feature is ON unless entitlements are loaded AND explicitly disable it.
  const hasFeature = (f) => !ent || !ent.features || ent.features[f] !== false;

  // SaaS: load the tenant's credit-worthiness COLOUR labels (band per client/
  // vendor doc id), produced nightly by the cross-tenant bureau. Colour only —
  // the numeric score never reaches the tenant. No-op on private (the doc never
  // exists there), so the credit chip stays absent outside SaaS.
  const [creditLabels, setCreditLabels] = useState({});
  useEffect(() => {
    if (!IS_SAAS || !role || !appId) return;
    getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'credit_labels'))
      .then((snap) => setCreditLabels((snap.exists() && snap.data().labels) || {}))
      .catch(() => setCreditLabels({}));
  }, [role]);

  useEffect(() => {
    const storedUid = localStorage.getItem('rentalOpsUser');
    // Purge any legacy admin_temp shortcut — this was a privilege-injection vector.
    if (storedUid === 'admin_temp') {
      localStorage.removeItem('rentalOpsUser');
      return;
    }
    if (storedUid && employees.length > 0 && !role) {
      const emp = employees.find(e => e.id === storedUid);
      if (emp) {
        if (emp.status === 'Disabled' || emp.status === 'Deactivated') {
          localStorage.removeItem('rentalOpsUser');
        } else {
          setRole(emp.role);
          setCurrentEmpId(emp.id);
        }
      } else {
        // Stored UID no longer exists in employees — clear it
        localStorage.removeItem('rentalOpsUser');
      }
    }
  }, [employees, role]);

  const addToast = (msg, type = 'info') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, msg, type }]);
  };

  // Expose addToast to the global notify() bridge so non-prop modules
  // (other pages, util/pdf generators) can raise toasts too.
  useEffect(() => { registerToast(addToast); }, []);

  // One-shot notification: after login + first Firestore snapshot, alert the
  // user if any recurring rules have pending runs. Only admin/manager see it.
  const recurringNoticeShownRef = useRef(false);
  useEffect(() => {
    if (recurringNoticeShownRef.current) return;
    if (!role || !can(effectiveRole, 'finance', 'view')) return;
    if (!Array.isArray(recurringRules) || recurringRules.length === 0) return;
    const today = new Date().toISOString().slice(0, 10);
    const { due } = partitionRules(recurringRules, today);
    if (due.length === 0) return;
    recurringNoticeShownRef.current = true;
    addToast(`${due.length} recurring ${due.length === 1 ? 'rule is' : 'rules are'} due to post. Open Accounts → Recurring Entries to review.`, 'info');
  }, [recurringRules, role, effectiveRole]);

  const logAction = async (collectionName, action, docId, data, docName = '') => {
    // M-10: Always log, even when Firebase Auth has not finished initialising.
    // M-12: Snapshot the acting employee id + role so historical audits remain
    // accurate after employees are renamed, demoted, or removed.
    try {
      const actorEmp = employees.find(e => e.id === currentEmpId);
      await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'audit_logs'), {
        collection: collectionName,
        action: action,
        doc_id: docId,
        doc_name: docName,
        details: data,
        performed_by: user?.email || user?.uid || (actorEmp?.email) || 'system',
        actor_emp_id: currentEmpId || null,
        actor_name: actorEmp?.name || null,
        actor_role: impersonating ? `${role}->${impersonating.role}` : (role || null),
        impersonated: !!impersonating,
        ...(supportSession ? { support_session: true, support_staff: supportSession.staffUid } : {}),
        timestamp: new Date().toISOString()
      });
    } catch (e) {
      console.error("Audit Log Error", e);
    }
  };

  // Write the /users/{uid} Firestore mirror so server-side rules can resolve
  // the role via request.auth.uid without reading /employees.
  const writeUserMirror = async (uid, empId, empRole, empName, empEmail) => {
    try {
      await setDoc(
        doc(db, 'artifacts', appId, 'public', 'data', 'users', uid),
        {
          email: empEmail || null,
          employee_id: empId || null,
          role: empRole,
          name: empName || '',
          updated_at: new Date().toISOString(),
        },
        { merge: true }
      );
    } catch (err) {
      console.warn('User mirror write failed (non-fatal):', err?.message);
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoginError('');
    const { username, password } = { username: loginForm.username.trim(), password: loginForm.password };

    // SaaS: the company code entered at login selects the tenant. Private: the
    // fixed appId constant (setAppId is a no-op in private builds).
    const loginAppId = IS_SAAS ? String(loginForm.tenant || '').trim().toLowerCase() : appId;
    if (IS_SAAS && !loginAppId) {
      setLoginError('Please enter your company code.');
      return;
    }

    try {
      // Point the app at this tenant BEFORE signing in, so the auth-state
      // effects subscribe to the right workspace. No-op in private builds.
      setAppId(loginAppId);

      // All credential verification is done server-side — no anonymous Firestore reads.
      const fn = httpsCallable(getFunctions(), 'verifyLogin');
      const result = await fn({ username, password, appId: loginAppId });
      const { token, role: empRole, empId, name: empName, email: empEmail } = result.data;

      // Sign in with the custom token returned by the Cloud Function.
      await signInWithCustomToken(auth, token);

      // Write the /users/{uid} mirror so Firestore rules can resolve the role.
      const u = auth.currentUser;
      if (u) await writeUserMirror(u.uid, empId, empRole, empName, empEmail);

      setRole(empRole);
      setCurrentEmpId(empId || '');
      if (rememberMe && empId) localStorage.setItem('rentalOpsUser', empId);

    } catch (err) {
      // Surface the Cloud Function error message; all branches return 'Invalid credentials'
      // or a specific admin-safe message — no username-existence leakage.
      const msg = err?.message || 'Login failed. Please try again.';
      setLoginError(msg);
    }
  };

  // ── DEAD CODE BELOW — kept as reference only, no longer called ────────────
  // Legacy client-side login path removed in favour of verifyLogin Cloud Function.
  // The code below is intentionally unreachable and will be deleted in a future cleanup.
  const _legacyLoginUnused = async (username, password) => {
    void username; void password;
    // Admin Check with Employee Matching — REPLACED by verifyLogin CF
    if (username === 'admin') {
      let adminPass = null;
      try {
        const secSnap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'security'));
        if (secSnap.exists()) {
            adminPass = secSnap.data().admin_password || null;
        }
      } catch (err) { console.error("Error fetching admin settings", err); }

      if (!adminPass) return;
      const adminMatch = await verifyPassword(password, adminPass);
      if (adminMatch) {
        if (!adminPass.startsWith('v2:')) {
          try {
            const secRef = doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'security');
            const upgraded = await hashPassword(password);
            await updateDoc(secRef, { admin_password: upgraded, password_hashed: true });
          } catch (e) { console.warn('Failed to upgrade admin password hash:', e.message); }
        }
      setRole('admin');
      const adminEmp = employees.find(e => e.email === 'admin@rentalops.com' || e.role === 'admin');
      if (adminEmp) { setCurrentEmpId(adminEmp.id); } else { setCurrentEmpId(''); }
      return;
    }
    }

    // Employee Check — REPLACED by verifyLogin CF
    const emp = employees.find(e => e.username === username || e.email === username);
    if (emp) {
      if (emp.is_locked) return;
      if (!emp.password) return;
      const passwordMatch = await verifyPassword(password, emp.password);
      if (passwordMatch) {
        if (emp.status === 'Disabled' || emp.status === 'Deactivated') return;
        const updates = {};
        if (emp.failed_login_attempts > 0) updates.failed_login_attempts = 0;
        if (!emp.password.startsWith('v2:')) {
          const upgraded = await hashPassword(password);
          updates.password = upgraded;
          updates.password_hashed = true;
        }
        if (Object.keys(updates).length > 0) {
          updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'employees', emp.id), updates);
        }

        setRole(emp.role);
        setCurrentEmpId(emp.id);
        if (rememberMe) localStorage.setItem('rentalOpsUser', emp.id);
        // Pre-write the /users/{uid} mirror for the CURRENT Firebase Auth session
        // (which may be anonymous) so Firestore writes succeed immediately
        // without waiting for upgradeFirebaseAuth to complete.
        const preWriteUid = auth.currentUser?.uid;
        if (preWriteUid) {
          setDoc(
            doc(db, 'artifacts', appId, 'public', 'data', 'users', preWriteUid),
            { email: emp.email || null, employee_id: emp.id, role: emp.role, name: emp.name || '', updated_at: new Date().toISOString() },
            { merge: true }
          ).catch(err => console.warn('User mirror pre-write failed:', err?.message));
        }
        // C-4: Upgrade to Firebase Auth (best-effort) so Firestore rules can
        // resolve the role via /users/{uid}.  Use the real email when present;
        // otherwise synthesize a stable internal email from the employee ID so
        // employees without email still get a recognised Firebase Auth session.
        const authEmail = emp.email || `${emp.id}@rental-ops.internal`;
        upgradeFirebaseAuth(authEmail, password, {
          employee_id: emp.id,
          role: emp.role,
          name: emp.name || '',
        });
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

  // Recovery modal — no client-side Firestore read needed; the Cloud Function
  // handles both bootstrap (first-time setup) and normal reset server-side.
  const handleOpenRecovery = () => {
    setRecoveryForm({ key: '', new_pass: '' });
    setShowForgotPass(true);
  };

  const handleRecovery = async () => {
    if (!recoveryForm.key || !recoveryForm.new_pass) {
      return addToast('Enter both the Recovery Key and the New Password.', 'error');
    }
    if (recoveryForm.new_pass.length < 8) {
      return addToast('New password must be at least 8 characters.', 'error');
    }
    try {
      const fn = httpsCallable(getFunctions(), 'resetAdminPassword');
      await fn({ appId, recoveryKey: recoveryForm.key, newPassword: recoveryForm.new_pass });
      addToast('Password reset successfully. You can now log in.', 'success');
      setShowForgotPass(false);
      setRecoveryForm({ key: '', new_pass: '' });
    } catch (err) {
      const msg = err?.message || 'Recovery failed. Check your connection and try again.';
      addToast(msg, 'info');
    }
  };

  const handleEmpResetRequest = () => {
    if (!resetRequestEmail) return addToast("Please enter your email or username", 'error');
    const emp = employees.find(e => e.email === resetRequestEmail || e.username === resetRequestEmail);
    
    if (!emp) return addToast("No employee found with this email/username.", 'info');
    
    const admin = employees.find(e => e.role === 'admin') || { email: 'admin@rentalops.com' };
    const subject = `Password Reset Request: ${emp.name}`;
    const body = `Hello Admin,\n\nI (${emp.name}) have forgotten my password. Please reset it for me.\n\nUsername: ${emp.username}\nEmail: ${emp.email}`;
    
    window.location.href = `mailto:${admin.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    setShowEmpForgotPass(false); setResetRequestEmail('');
  };

  const handleLogout = () => {
    setRole(null);
    setCurrentEmpId(null);
    setImpersonating(null);
    // Keep the tenant code on SaaS logout so the user needn't retype it.
    setLoginForm({ username: '', password: '', tenant: IS_SAAS ? (appId || '') : '' });
    localStorage.removeItem('rentalOpsUser');
    // Sign out of Firebase Auth; onAuthStateChanged will create a fresh
    // anonymous session for the login screen automatically.
    signOut(auth).catch(() => { /* ignore */ });
  };

  // SaaS: leave an audited support session and return to the platform console
  // as the staff member (platformResumeStaff re-mints the staff token and logs
  // the session end). Falls back to a plain logout if resume fails.
  const handleExitSupport = async () => {
    try {
      const fn = httpsCallable(getFunctions(), 'platformResumeStaff');
      const { data } = await fn();
      await signInWithCustomToken(auth, data.token);
      setSupportSession(null);
      setAppId('');
      window.location.assign('/platform');
    } catch (err) {
      console.error('Exit support failed', err);
      handleLogout();
    }
  };

  const onProjectClick = (id) => {
    setSelectedProjectId(id);
  };

  // SaaS platform console — own shell, staff session. Null (branch folds away)
  // in private builds, so /platform there falls through to normal app routing.
  if (PlatformConsole && location.pathname.startsWith('/platform')) {
    return (
      <Suspense fallback={<div className="flex h-screen items-center justify-center"><LoadingSpinner /></div>}>
        <PlatformConsole />
      </Suspense>
    );
  }

  if (location.pathname.startsWith('/ledger/')) {
    return (
      <Suspense fallback={<div className="flex h-screen items-center justify-center"><LoadingSpinner /></div>}>
        <Routes>
          <Route path="/ledger/:token" element={<PublicLedger />} />
        </Routes>
      </Suspense>
    );
  }

  if (location.pathname.startsWith('/quote-approval/')) {
    return (
      <Suspense fallback={<div className="flex h-screen items-center justify-center"><LoadingSpinner /></div>}>
        <Routes>
          <Route path="/quote-approval/:token" element={<QuoteApproval />} />
        </Routes>
      </Suspense>
    );
  }

  if (location.pathname.startsWith('/reimbursable/')) {
    return (
      <Suspense fallback={<div className="flex h-screen items-center justify-center"><LoadingSpinner /></div>}>
        <Routes>
          <Route path="/reimbursable/:token" element={<PublicReimbursable />} />
        </Routes>
      </Suspense>
    );
  }

  if (location.pathname.startsWith('/employee-statement/')) {
    return (
      <Suspense fallback={<div className="flex h-screen items-center justify-center"><LoadingSpinner /></div>}>
        <Routes>
          <Route path="/employee-statement/:token" element={<PublicEmployeeLedger />} />
        </Routes>
      </Suspense>
    );
  }

  if (location.pathname.startsWith('/portal/')) {
    return (
      <Suspense fallback={<div className="flex h-screen items-center justify-center"><LoadingSpinner /></div>}>
        <Routes>
          <Route path="/portal/:token" element={<Portal />} />
        </Routes>
      </Suspense>
    );
  }

  if (loading) return <LoadingSpinner />;

  if (!user || !role) {
    return (
      <div className="flex h-screen items-center justify-center bg-gradient-to-br from-slate-50 via-indigo-50/30 to-slate-100 p-4">
        <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-xl border border-slate-200/60">
          <div className="mb-6 flex flex-col items-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-indigo-600 shadow-lg shadow-indigo-200 mb-4"><Box className="h-7 w-7 text-white" /></div>
            <h1 className="text-2xl font-bold text-slate-800">RentalOps</h1>
            <p className="mt-1 text-sm text-slate-500">Sign in to your account</p>
          </div>
          
          <form onSubmit={handleLogin} className="space-y-4">
             {IS_SAAS && (
               <div>
                 <label htmlFor="login-tenant" className="block text-sm font-semibold text-slate-700 mb-1.5">Company Code</label>
                 <input
                   id="login-tenant"
                   name="tenant"
                   autoComplete="organization"
                   className="w-full rounded-lg border border-slate-200 p-3 text-sm text-slate-800 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition-all"
                   placeholder="your-company"
                   value={loginForm.tenant}
                   onChange={e => setLoginForm({...loginForm, tenant: e.target.value})}
                 />
               </div>
             )}
             <div>
               <label htmlFor="login-username" className="block text-sm font-semibold text-slate-700 mb-1.5">Username / Email</label>
               <input 
                 id="login-username"
                 name="username"
                 autoComplete="username"
                 className="w-full rounded-lg border border-slate-200 p-3 text-sm text-slate-800 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition-all" 
                 placeholder="admin or email@example.com"
                 value={loginForm.username}
                 onChange={e => setLoginForm({...loginForm, username: e.target.value})}
               />
             </div>
             <div>
               <label htmlFor="login-password" className="block text-sm font-semibold text-slate-700 mb-1.5">Password</label>
               <input 
                 id="login-password"
                 name="password"
                 type="password"
                 autoComplete="current-password"
                 className="w-full rounded-lg border border-slate-200 p-3 text-sm text-slate-800 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 transition-all" 
                 placeholder="••••••••"
                 value={loginForm.password}
                 onChange={e => setLoginForm({...loginForm, password: e.target.value})}
               />
             </div>
             <div className="flex items-center gap-2">
                <input type="checkbox" id="rememberMe" checked={rememberMe} onChange={e => setRememberMe(e.target.checked)} className="rounded border-slate-300 text-indigo-600" />
                <label htmlFor="rememberMe" className="text-sm text-slate-500">Remember Me</label>
             </div>
             {loginError && <div role="alert" aria-live="assertive" className="text-red-600 text-sm bg-red-50 p-2.5 rounded-lg text-center border border-red-200">{loginError}</div>}
             <button type="submit" className="w-full bg-indigo-600 text-white p-3 rounded-lg font-semibold hover:bg-indigo-700 transition-all shadow-sm shadow-indigo-200 hover:shadow-md hover:shadow-indigo-200">Sign In</button>
             <div className="flex justify-between text-sm mt-4">
                <button type="button" onClick={() => setShowEmpForgotPass(true)} className="text-indigo-600 hover:underline">Forgot Employee Password?</button>
                <button type="button" onClick={handleOpenRecovery} className="text-slate-500 hover:underline">Admin Recovery</button>
             </div>
          </form>
          <div className="mt-6 text-center text-[11px] text-slate-400" title={VERSION_LABEL}>{VERSION_LABEL}</div>
        </div>
        <Modal isOpen={showForgotPass} onClose={() => { setShowForgotPass(false); setIsBootstrap(false); }} title={isBootstrap ? 'First-Time Admin Setup' : 'Admin Password Recovery'}>
            <div className="space-y-4">
              {isBootstrap ? (
                <>
                  <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
                    <strong>No admin account found.</strong> This appears to be a fresh installation. Set your admin password and choose a recovery key to get started.
                  </div>
                  <div><label className="text-sm font-medium">New Admin Password</label><input type="password" className="w-full rounded border p-2 text-black" value={recoveryForm.new_pass} onChange={e => setRecoveryForm({...recoveryForm, new_pass: e.target.value})} placeholder="Choose a strong password" /></div>
                  <div><label className="text-sm font-medium">Recovery Key <span className="text-slate-400 font-normal">(keep this safe — you'll need it to reset the password later)</span></label><input type="password" className="w-full rounded border p-2 text-black" value={recoveryForm.key} onChange={e => setRecoveryForm({...recoveryForm, key: e.target.value})} placeholder="Choose a secret recovery key" /></div>
                  <button onClick={handleRecovery} className="w-full rounded bg-green-600 text-white py-2 hover:bg-green-700 font-semibold">Initialise Admin Account</button>
                </>
              ) : (
                <>
                  <div><label className="text-sm font-medium">Recovery Key</label><input type="password" className="w-full rounded border p-2 text-black" value={recoveryForm.key} onChange={e => setRecoveryForm({...recoveryForm, key: e.target.value})} placeholder="Enter Recovery Key" /></div>
                  <div><label className="text-sm font-medium">New Password</label><input type="password" className="w-full rounded border p-2 text-black" value={recoveryForm.new_pass} onChange={e => setRecoveryForm({...recoveryForm, new_pass: e.target.value})} placeholder="Set New Password" /></div>
                  <button onClick={handleRecovery} className="w-full rounded bg-red-600 text-white py-2 hover:bg-red-700">Reset Password</button>
                </>
              )}
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
    <ErrorBoundary>
    <div className="flex h-screen w-full bg-slate-50 font-sans overflow-hidden">
      <GlobalSearch
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        role={effectiveRole}
        projects={projects}
        clients={clients}
        inventory={inventory}
      />
      {hasFeature('ai_accountant') && <AppAssistantLauncher onClick={() => setIsAssistantOpen(true)} />}
      <AppAssistant
        isOpen={hasFeature('ai_accountant') && isAssistantOpen}
        onClose={() => setIsAssistantOpen(false)}
        projects={projects}
        clients={clients}
        employees={safeEmployees}
        expenses={expenses}
        payments={payments}
        payouts={payouts}
        vendorPayments={vendorPayments}
        taxInvoices={taxInvoicesList}
        purchaseInvoices={purchaseInvoicesList}
        inventory={inventory}
        journalEntries={journalEntries}
        hrLeaves={hrLeaves}
        role={effectiveRole}
        db={db}
        appId={appId}
        logAction={logAction}
        addToast={addToast}
        currentUserId={user?.uid}
      />
      <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2">
        {toasts.map(t => (
          <Toast key={t.id} message={t.msg} type={t.type} onClose={() => setToasts(p => p.filter(x => x.id !== t.id))} />
        ))}
      </div>
      <DialogHost />
      <InstallPrompt />
      <LocationTracker db={db} appId={appId} currentEmpId={effectiveEmpId} employees={safeEmployees} timeLogs={timeLogs} />
      <aside className="hidden w-[260px] flex-col bg-white md:flex shadow-[1px_0_0_0_#e2e8f0] z-10">
        <div className="flex h-16 items-center gap-2 px-5 border-b border-slate-100">
          <div className="h-8 w-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white font-bold text-sm">T</div>
          <span className="font-bold text-lg text-slate-800 tracking-tight">TERMS</span>
          <span className="ml-auto text-[10px] font-medium text-slate-400 bg-slate-100 rounded-md px-1.5 py-0.5">v3.5.0</span>
        </div>
        <div className="px-4 pt-3 pb-1">
          <button
            onClick={() => setIsSearchOpen(true)}
            className="w-full flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-400 hover:border-indigo-300 hover:text-indigo-500 hover:bg-indigo-50/50 transition-all duration-150"
          >
            <Search size={14} />
            <span className="flex-1 text-left text-xs">Search…</span>
            <kbd className="text-[10px] border border-slate-200 rounded px-1 py-0.5 bg-white text-slate-400 font-mono">⌘K</kbd>
          </button>
        </div>
        <div className="flex-1 space-y-0.5 px-3 pt-2 overflow-y-auto">
          <div className="mb-1 px-3 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Main</div>
          <NavItem to="/dashboard" setMobileMenuOpen={setMobileMenuOpen} icon={LayoutDashboard} label="Dashboard" />
          {can(role,'projects','view') && <NavItem to="/projects" setMobileMenuOpen={setMobileMenuOpen} icon={Calendar} label="Projects" />}
          {can(role,'outsourcing','view') && <NavItem to="/outsourcing" setMobileMenuOpen={setMobileMenuOpen} icon={ShoppingBag} label="Outsource" />}
          {can(role,'clients','view') && <NavItem to="/clients" setMobileMenuOpen={setMobileMenuOpen} icon={Users} label="Clients" />}
          {!can(role,'clients','view') && can(role,'contacts','view') && <NavItem to="/contacts" setMobileMenuOpen={setMobileMenuOpen} icon={Users} label="Contacts" />}
          {can(role,'leads','view') && <NavItem to="/leads" setMobileMenuOpen={setMobileMenuOpen} icon={Target} label="Leads / CRM" />}
          {can(role,'chat','view') && <NavItem to="/chat" setMobileMenuOpen={setMobileMenuOpen} icon={MessageSquare} label="Chat" badge={chatUnread} />}
          {can(role,'tracking','view') && <NavItem to="/tracking" setMobileMenuOpen={setMobileMenuOpen} icon={MapPin} label="Live Map" />}
          {can(role,'commission','view') && <NavItem to="/commission" setMobileMenuOpen={setMobileMenuOpen} icon={Percent} label="Commission" />}
          {can(role,'inventory','view') && <NavItem to="/inventory" setMobileMenuOpen={setMobileMenuOpen} icon={Box} label="Inventory" />}
          {can(role,'inventory','view') && <NavItem to="/warehouse-scan" setMobileMenuOpen={setMobileMenuOpen} icon={Camera} label="Warehouse Scan" />}
          {can(role,'projects','view') && <NavItem to="/schedule" setMobileMenuOpen={setMobileMenuOpen} icon={CalendarDays} label="Schedule" />}
          {can(role,'reports','view') && <NavItem to="/asset-analytics" setMobileMenuOpen={setMobileMenuOpen} icon={BarChart3} label="Asset Analytics" />}
          {can(role,'reports','view') && <NavItem to="/analytics" setMobileMenuOpen={setMobileMenuOpen} icon={FileBarChart} label="Analytics" />}
          {can(role,'configurations','view') && <NavItem to="/configurations" setMobileMenuOpen={setMobileMenuOpen} icon={Layers} label="Configs" />}
          {can(role,'expenses','view_own') && <NavItem to="/expenses" setMobileMenuOpen={setMobileMenuOpen} icon={DollarSign} label="Expenses" />}
          {can(role,'finance','view') && <NavItem to="/finance" setMobileMenuOpen={setMobileMenuOpen} icon={Wallet} label="Finance" />}
          {can(role,'finance','view') && <NavItem to="/accounting" setMobileMenuOpen={setMobileMenuOpen} icon={ReceiptText} label="Accounts" />}
          <div className="my-3 border-t border-slate-100"></div>
          <div className="mb-1 px-3 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Operations</div>
          {can(role,'challans','view') && <NavItem to="/challans" setMobileMenuOpen={setMobileMenuOpen} icon={ClipboardList} label="Challans" />}
          {can(role,'documents','view') && <NavItem to="/documents" setMobileMenuOpen={setMobileMenuOpen} icon={FolderOpen} label="Documents" />}
          {can(role,'purchase_invoices','view') && <NavItem to="/purchase-invoices" setMobileMenuOpen={setMobileMenuOpen} icon={Receipt} label="Purchases" />}
          {can(role,'tax_invoices','view') && <NavItem to="/tax-invoices" setMobileMenuOpen={setMobileMenuOpen} icon={FileText} label="Tax Invoices" />}
          {can(role,'reports','view') && <NavItem to="/reports" setMobileMenuOpen={setMobileMenuOpen} icon={FileText} label="Reports" />}
          {can(role,'daily_reports','view') && <NavItem to="/daily-report" setMobileMenuOpen={setMobileMenuOpen} icon={CalendarDays} label="Daily Report" />}
          {can(role,'reports','view') && <NavItem to="/business-report" setMobileMenuOpen={setMobileMenuOpen} icon={BarChart3} label="Business Report" />}
          <div className="my-3 border-t border-slate-100"></div>
          <div className="mb-1 px-3 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Human Resource</div>
          {can(role,'hr_dashboard','view') && <NavItem to="/hr/dashboard" setMobileMenuOpen={setMobileMenuOpen} icon={BarChart3} label="HR Dashboard" />}
          {(can(role,'hr_attendance','view')) && <NavItem to="/hr/attendance" setMobileMenuOpen={setMobileMenuOpen} icon={Clock} label="Attendance" badge={shiftRequests.filter(s => s.status === 'Pending').length} />}
          {(can(role,'hr_leaves','view') || can(role,'hr_leaves','view_own')) && <NavItem to="/hr/leaves" setMobileMenuOpen={setMobileMenuOpen} icon={CalendarDays} label="Leave Mgmt" badge={hrLeaves.filter(l => l.status === 'Pending').length} />}
          {can(role,'hr_reports','view') && <NavItem to="/hr/reports" setMobileMenuOpen={setMobileMenuOpen} icon={FileBarChart} label="HR Reports" />}
          {can(role,'hr_payroll','view') && <NavItem to="/hr/payroll" setMobileMenuOpen={setMobileMenuOpen} icon={DollarSign} label="Payroll" />}
          {can(role,'hr_settings','view') && <NavItem to="/hr/settings" setMobileMenuOpen={setMobileMenuOpen} icon={Settings} label="HR Settings" />}
          {can(role,'hr_portal','view') && <NavItem to="/hr/portal" setMobileMenuOpen={setMobileMenuOpen} icon={UserCheck} label="My HR Portal" />}
          <div className="my-3 border-t border-slate-100"></div>
          <div className="mb-1 px-3 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Administration</div>
          {can(role,'employees','view') && <NavItem to="/employees" setMobileMenuOpen={setMobileMenuOpen} icon={UserCog} label="Employees" badge={employees.filter(e => e.is_locked).length} />}
          {can(role,'audit_logs','view') && <NavItem to="/audit" setMobileMenuOpen={setMobileMenuOpen} icon={Activity} label="Audit Logs" />}
          {role === 'admin' && <NavItem to="/data-portal" setMobileMenuOpen={setMobileMenuOpen} icon={Download} label="Data Portal" />}
          {can(role,'admin_tools','view') && <NavItem to="/admin" setMobileMenuOpen={setMobileMenuOpen} icon={Settings} label="Admin" />}
        </div>
        <div className="border-t border-slate-100 p-3">
          <div className="flex items-center justify-end gap-1 mb-2">
            <OfflineIndicator offlineState={offlineState} role={role} />
            <NotificationBell
              projects={projects}
              inventory={inventory}
              payments={payments}
              clients={clients}
              role={role}
              currentEmpId={currentEmpId}
            />
            <button onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')} className="p-2 rounded-lg hover:bg-slate-100 transition-colors">
              {theme === 'light' ? <Moon size={18} className="text-slate-400" /> : <Sun size={18} className="text-yellow-500" />}
            </button>
          </div>
          <Link to="/profile" onClick={() => setMobileMenuOpen(false)} className="mb-2 flex w-full items-center gap-3 rounded-xl hover:bg-slate-50 p-2.5 text-left transition-all duration-150 group">
            <div className={`h-9 w-9 rounded-lg flex items-center justify-center text-white text-xs font-bold shadow-sm ${ROLE_COLOR[role] || 'bg-slate-400'}`}>{(role||'U')[0].toUpperCase()}</div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-slate-800 truncate">{ROLE_LABELS[role] || role}</div>
              <div className="text-[11px] text-slate-400 group-hover:text-indigo-500 transition-colors">View Profile</div>
            </div>
            <Settings size={14} className="text-slate-300 group-hover:text-indigo-500 transition-colors" />
          </Link>
          <button onClick={handleLogout} className="flex w-full items-center gap-2 rounded-lg p-2 text-sm text-slate-500 hover:text-red-600 hover:bg-red-50 font-medium transition-all duration-150"><LogOut size={15} /> Sign Out</button>
          {role === 'admin' && !impersonating && (
            <button onClick={() => setShowImpersonateModal(true)} className="flex w-full items-center gap-2 rounded p-2 mt-1 text-sm text-amber-600 hover:bg-amber-50 font-medium"><Eye size={16} /> View as Employee…</button>
          )}
          {impersonating && (
            <button onClick={() => setImpersonating(null)} className="flex w-full items-center gap-2 rounded p-2 mt-1 text-sm text-amber-700 bg-amber-50 hover:bg-amber-100 font-semibold border border-amber-200"><Eye size={16} className="text-amber-600" /> Exit: {impersonating.name}</button>
          )}
          <a
            href="/version.json"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[11px] font-medium text-slate-500 transition-colors hover:border-indigo-200 hover:text-indigo-600"
            title={`Running version ${VERSION_LABEL} — click to verify the live deploy (/version.json)`}
          >
            <Package size={12} className="shrink-0 text-slate-400" />
            <span className="truncate">{VERSION_LABEL}</span>
          </a>
        </div>
      </aside>
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 items-center justify-between border-b border-slate-200 bg-white px-4 md:hidden shadow-sm z-20">
          <div className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-lg bg-indigo-600 flex items-center justify-center text-white font-bold text-xs">T</div>
            <span className="font-bold text-slate-800">TERMS</span>
          </div>
          <div className="flex items-center gap-1">
            <OfflineIndicator offlineState={offlineState} role={role} />
            <NotificationBell projects={projects} inventory={inventory} payments={payments} clients={clients} role={role} expenses={expenses} hrLeaves={hrLeaves} currentEmpId={currentEmpId} />
            <button onClick={() => setIsSearchOpen(true)} className="p-2 text-slate-400 hover:text-indigo-600 transition-colors"><Search size={18} /></button>
            <button onClick={() => setMobileMenuOpen(true)} className="p-2 text-slate-500 hover:text-slate-700"><Menu /></button>
          </div>
        </header>
        {mobileMenuOpen && (
          <div className="fixed inset-0 z-50 flex md:hidden">
            <div className="fixed inset-0 bg-black/50 backdrop-blur-sm transition-opacity" onClick={() => setMobileMenuOpen(false)}></div>
            <div className="relative flex w-[260px] flex-col bg-white shadow-2xl h-full">
              <div className="flex h-14 items-center justify-between px-5 border-b border-slate-100">
                 <div className="flex items-center gap-2">
                   <div className="h-7 w-7 rounded-lg bg-indigo-600 flex items-center justify-center text-white font-bold text-xs">T</div>
                   <span className="font-bold text-lg text-slate-800 tracking-tight">TERMS</span>
                 </div>
                 <button onClick={() => setMobileMenuOpen(false)} className="text-slate-400 hover:text-slate-600 p-1 rounded-lg hover:bg-slate-100 transition-colors"><X size={18}/></button>
              </div>
              
              <div className="flex-1 overflow-y-auto px-3 pt-3 space-y-0.5">
                  <div className="mb-1 px-3 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Main</div>
                  <NavItem to="/dashboard" setMobileMenuOpen={setMobileMenuOpen} icon={LayoutDashboard} label="Dashboard" />
                  {can(role,'projects','view') && <NavItem to="/projects" setMobileMenuOpen={setMobileMenuOpen} icon={Calendar} label="Projects" />}
                  {can(role,'outsourcing','view') && <NavItem to="/outsourcing" setMobileMenuOpen={setMobileMenuOpen} icon={ShoppingBag} label="Outsource" />}
                  {can(role,'clients','view') && <NavItem to="/clients" setMobileMenuOpen={setMobileMenuOpen} icon={Users} label="Clients" />}
          {!can(role,'clients','view') && can(role,'contacts','view') && <NavItem to="/contacts" setMobileMenuOpen={setMobileMenuOpen} icon={Users} label="Contacts" />}
          {can(role,'leads','view') && <NavItem to="/leads" setMobileMenuOpen={setMobileMenuOpen} icon={Target} label="Leads / CRM" />}
          {can(role,'chat','view') && <NavItem to="/chat" setMobileMenuOpen={setMobileMenuOpen} icon={MessageSquare} label="Chat" badge={chatUnread} />}
          {can(role,'tracking','view') && <NavItem to="/tracking" setMobileMenuOpen={setMobileMenuOpen} icon={MapPin} label="Live Map" />}
          {can(role,'commission','view') && <NavItem to="/commission" setMobileMenuOpen={setMobileMenuOpen} icon={Percent} label="Commission" />}
                  {can(role,'inventory','view') && <NavItem to="/inventory" setMobileMenuOpen={setMobileMenuOpen} icon={Box} label="Inventory" />}
          {can(role,'inventory','view') && <NavItem to="/warehouse-scan" setMobileMenuOpen={setMobileMenuOpen} icon={Camera} label="Warehouse Scan" />}
          {can(role,'projects','view') && <NavItem to="/schedule" setMobileMenuOpen={setMobileMenuOpen} icon={CalendarDays} label="Schedule" />}
          {can(role,'reports','view') && <NavItem to="/asset-analytics" setMobileMenuOpen={setMobileMenuOpen} icon={BarChart3} label="Asset Analytics" />}
          {can(role,'reports','view') && <NavItem to="/analytics" setMobileMenuOpen={setMobileMenuOpen} icon={FileBarChart} label="Analytics" />}
                  {can(role,'configurations','view') && <NavItem to="/configurations" setMobileMenuOpen={setMobileMenuOpen} icon={Layers} label="Configs" />}
                  <NavItem to="/expenses" setMobileMenuOpen={setMobileMenuOpen} icon={DollarSign} label="Expenses" />
                  {can(role,'finance','view') && <NavItem to="/finance" setMobileMenuOpen={setMobileMenuOpen} icon={Wallet} label="Finance" />}
                  {can(role,'finance','view') && <NavItem to="/accounting" setMobileMenuOpen={setMobileMenuOpen} icon={ReceiptText} label="Accounts" />}
                  <div className="my-3 border-t border-slate-100"></div>
                  <div className="mb-1 px-3 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Operations</div>
                  {can(role,'challans','view') && <NavItem to="/challans" setMobileMenuOpen={setMobileMenuOpen} icon={ClipboardList} label="Challans" />}
                  {can(role,'documents','view') && <NavItem to="/documents" setMobileMenuOpen={setMobileMenuOpen} icon={FolderOpen} label="Documents" />}
                  {can(role,'purchase_invoices','view') && <NavItem to="/purchase-invoices" setMobileMenuOpen={setMobileMenuOpen} icon={Receipt} label="Purchases" />}
                  {can(role,'tax_invoices','view') && <NavItem to="/tax-invoices" setMobileMenuOpen={setMobileMenuOpen} icon={FileText} label="Tax Invoices" />}
                  {can(role,'reports','view') && <NavItem to="/reports" setMobileMenuOpen={setMobileMenuOpen} icon={FileText} label="Reports" />}
          {can(role,'daily_reports','view') && <NavItem to="/daily-report" setMobileMenuOpen={setMobileMenuOpen} icon={CalendarDays} label="Daily Report" />}
                  {can(role,'reports','view') && <NavItem to="/business-report" setMobileMenuOpen={setMobileMenuOpen} icon={BarChart3} label="Business Report" />}
                  <div className="my-3 border-t border-slate-100"></div>
                  <div className="mb-1 px-3 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Human Resource</div>
                  {can(role,'hr_dashboard','view') && <NavItem to="/hr/dashboard" setMobileMenuOpen={setMobileMenuOpen} icon={BarChart3} label="HR Dashboard" />}
                  {(can(role,'hr_attendance','view')) && <NavItem to="/hr/attendance" setMobileMenuOpen={setMobileMenuOpen} icon={Clock} label="Attendance" badge={shiftRequests.filter(s => s.status === 'Pending').length} />}
                  {(can(role,'hr_leaves','view') || can(role,'hr_leaves','view_own')) && <NavItem to="/hr/leaves" setMobileMenuOpen={setMobileMenuOpen} icon={CalendarDays} label="Leave Mgmt" badge={hrLeaves.filter(l => l.status === 'Pending').length} />}
                  {can(role,'hr_reports','view') && <NavItem to="/hr/reports" setMobileMenuOpen={setMobileMenuOpen} icon={FileBarChart} label="HR Reports" />}
                  {can(role,'hr_payroll','view') && <NavItem to="/hr/payroll" setMobileMenuOpen={setMobileMenuOpen} icon={DollarSign} label="Payroll" />}
                  {can(role,'hr_settings','view') && <NavItem to="/hr/settings" setMobileMenuOpen={setMobileMenuOpen} icon={Settings} label="HR Settings" />}
                  {can(role,'hr_portal','view') && <NavItem to="/hr/portal" setMobileMenuOpen={setMobileMenuOpen} icon={UserCheck} label="My HR Portal" />}
                  <div className="my-3 border-t border-slate-100"></div>
                  <div className="mb-1 px-3 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Administration</div>
                  {can(role,'employees','view') && <NavItem to="/employees" setMobileMenuOpen={setMobileMenuOpen} icon={UserCog} label="Employees" badge={employees.filter(e => e.is_locked).length} />}
                  {can(role,'audit_logs','view') && <NavItem to="/audit" setMobileMenuOpen={setMobileMenuOpen} icon={Activity} label="Audit Logs" />}
                  {can(role,'admin_tools','view') && <NavItem to="/admin" setMobileMenuOpen={setMobileMenuOpen} icon={Settings} label="Admin" />}
              </div>

              <div className="border-t border-slate-100 p-3">
                  <Link to="/profile" onClick={() => setMobileMenuOpen(false)} className="mb-2 flex w-full items-center gap-3 rounded-xl hover:bg-slate-50 p-2.5 text-left transition-all group">
                    <div className={`h-9 w-9 rounded-lg flex items-center justify-center text-white text-xs font-bold shadow-sm ${role==='admin'?'bg-red-500':role==='manager'?'bg-blue-500':'bg-green-500'}`}>{role[0].toUpperCase()}</div>
                    <div className="flex-1">
                      <div className="text-sm font-semibold text-slate-800 capitalize">{role}</div>
                      <div className="text-[11px] text-slate-400 group-hover:text-indigo-500">View Profile</div>
                    </div>
                  </Link>
                  <button onClick={handleLogout} className="flex w-full items-center gap-2 rounded-lg p-2 text-sm text-slate-500 hover:text-red-600 hover:bg-red-50 font-medium transition-all"><LogOut size={15} /> Sign Out</button>
              </div>
            </div>
          </div>
        )}
        <main className="flex-1 overflow-y-auto overflow-x-hidden p-4 md:p-6 lg:p-8 relative bg-slate-50">
          <div className="mx-auto max-w-6xl w-full min-w-0">
            {supportSession && (
              <div className="mb-4 flex items-center gap-3 rounded-xl bg-rose-50 border border-rose-300 px-4 py-3 text-sm shadow-sm">
                <Shield size={17} className="text-rose-600 shrink-0" />
                <span className="flex-1 text-rose-800 font-medium">SUPPORT SESSION — working inside <strong>{appId}</strong>. Every action is audited and visible to this workspace&apos;s admins.</span>
                <button onClick={handleExitSupport} className="text-xs font-bold text-rose-700 hover:text-rose-900 border border-rose-300 px-3 py-1 rounded-lg hover:bg-rose-100 transition whitespace-nowrap">Exit Support</button>
              </div>
            )}
            {impersonating && (
              <div className="mb-4 flex items-center gap-3 rounded-xl bg-amber-50 border border-amber-300 px-4 py-3 text-sm shadow-sm">
                <Eye size={17} className="text-amber-600 shrink-0" />
                <span className="flex-1 text-amber-800 font-medium">Viewing as <strong>{impersonating.name}</strong> <span className="capitalize opacity-75">({impersonating.role})</span> — their role restrictions apply to all pages below</span>
                <button onClick={() => setImpersonating(null)} className="text-xs font-bold text-amber-700 hover:text-amber-900 border border-amber-300 px-3 py-1 rounded-lg hover:bg-amber-100 transition whitespace-nowrap">Exit View</button>
              </div>
            )}
            {offlineState.effectivelyOffline && (
              <div className="mb-4 flex items-center gap-3 rounded-xl bg-amber-50 border border-amber-200 px-4 py-2.5 text-sm shadow-sm">
                <WifiOff size={16} className="text-amber-600 shrink-0" />
                <span className="flex-1 text-amber-700 font-medium">
                  {offlineState.forcedOffline ? 'Flight Mode — ' : 'Offline — '}
                  Working from cached data. Changes will sync when reconnected.
                </span>
              </div>
            )}
            
              <Suspense fallback={<div className="flex items-center justify-center py-24"><LoadingSpinner /></div>}>
              <Routes>
                <Route path="/" element={<Navigate to="/dashboard" />} />
                <Route path="/dashboard" element={<Dashboard projects={projects} expenses={expenses} role={effectiveRole} clients={clients} onProjectClick={(id) => setSelectedProjectId(id)} employees={safeEmployees} payments={payments} db={db} appId={appId} timeLogs={timeLogs} hqSettings={hqSettings} currentEmpId={effectiveEmpId} logAction={logAction} addToast={addToast} payouts={payouts} vendorPayments={vendorPayments} taxInvoices={taxInvoicesList} purchaseInvoices={purchaseInvoicesList} inventory={inventory} journalEntries={journalEntries} hrLeaves={hrLeaves} currentUserId={user?.uid} />} />
                <Route path="/projects" element={<ProtectedRoute role={effectiveRole} resource="projects"><Projects projects={projects} clients={clients} inventory={inventory} expenses={expenses} employees={safeEmployees} role={effectiveRole} user={user} currentEmpId={effectiveEmpId} db={db} appId={appId} selectedProjectId={selectedProjectId} setSelectedProjectId={setSelectedProjectId} logAction={logAction} addToast={addToast} timeLogs={timeLogs} taxInvoices={taxInvoicesList} payments={payments} /></ProtectedRoute>} />
                <Route path="/projects/:projectId" element={<ProtectedRoute role={effectiveRole} resource="projects"><Projects projects={projects} clients={clients} inventory={inventory} expenses={expenses} employees={safeEmployees} role={effectiveRole} user={user} currentEmpId={effectiveEmpId} db={db} appId={appId} selectedProjectId={selectedProjectId} setSelectedProjectId={setSelectedProjectId} logAction={logAction} addToast={addToast} timeLogs={timeLogs} taxInvoices={taxInvoicesList} payments={payments} /></ProtectedRoute>} />
                <Route path="/outsourcing" element={<ProtectedRoute role={effectiveRole} resource="outsourcing"><Outsourcing projects={projects} clients={clients} inventory={inventory} role={effectiveRole} currentEmpId={effectiveEmpId} db={db} appId={appId} logAction={logAction} purchaseInvoices={purchaseInvoicesList} lockedFYs={lockedFYs} addToast={addToast} /></ProtectedRoute>} />
                <Route path="/clients" element={<ProtectedRoute role={effectiveRole} resource="clients"><Clients clients={clients} inventory={inventory} projects={projects} payments={payments} vendorPayments={vendorPayments} expenses={expenses} timeLogs={timeLogs} employees={safeEmployees} role={effectiveRole} currentEmpId={effectiveEmpId} db={db} appId={appId} logAction={logAction} creditLabels={creditLabels} /></ProtectedRoute>} />
                <Route path="/contacts" element={<ProtectedRoute role={effectiveRole} resource="contacts"><Contacts clients={clients} /></ProtectedRoute>} />
                <Route path="/inventory" element={<ProtectedRoute role={effectiveRole} resource="inventory"><Inventory inventory={inventory} clients={clients} projects={projects} role={effectiveRole} db={db} appId={appId} logAction={logAction} categories={[...CATEGORIES, ...customInventoryCategories.filter(c => !CATEGORIES.includes(c))]} /></ProtectedRoute>} />
                <Route path="/warehouse-scan" element={<ProtectedRoute role={effectiveRole} resource="inventory"><WarehouseScan projects={projects} inventory={inventory} clients={clients} role={effectiveRole} db={db} appId={appId} currentEmpId={effectiveEmpId} addToast={addToast} logAction={logAction} /></ProtectedRoute>} />
                <Route path="/schedule" element={<ProtectedRoute role={effectiveRole} resource="projects"><Schedule projects={projects} inventory={inventory} employees={safeEmployees} role={effectiveRole} db={db} appId={appId} currentEmpId={effectiveEmpId} logAction={logAction} /></ProtectedRoute>} />
                <Route path="/asset-analytics" element={<ProtectedRoute role={effectiveRole} resource="reports"><AssetAnalytics inventory={inventory} projects={projects} role={effectiveRole} /></ProtectedRoute>} />
                <Route path="/leads" element={<ProtectedRoute role={effectiveRole} resource="leads"><Leads role={effectiveRole} db={db} appId={appId} currentEmpId={effectiveEmpId} logAction={logAction} /></ProtectedRoute>} />
                <Route path="/chat" element={<ProtectedRoute role={effectiveRole} resource="chat"><Chat role={effectiveRole} db={db} appId={appId} employees={safeEmployees} projects={projects} currentEmpId={effectiveEmpId} /></ProtectedRoute>} />
                <Route path="/tracking" element={<ProtectedRoute role={effectiveRole} resource="tracking"><LiveMap role={effectiveRole} db={db} appId={appId} employees={safeEmployees} hqSettings={hqSettings} /></ProtectedRoute>} />
                <Route path="/commission" element={<ProtectedRoute role={effectiveRole} resource="commission"><Commission clients={clients} projects={projects} expenses={expenses} payments={payments} payouts={payouts} employees={safeEmployees} role={effectiveRole} currentEmpId={effectiveEmpId} db={db} appId={appId} logAction={logAction} /></ProtectedRoute>} />
                <Route path="/analytics" element={<ProtectedRoute role={effectiveRole} resource="reports"><Analytics projects={projects} clients={clients} expenses={expenses} payments={payments} role={effectiveRole} /></ProtectedRoute>} />
                <Route path="/configurations" element={<ProtectedRoute role={effectiveRole} resource="configurations"><ConfigurationBuilder configurations={configurations} inventory={inventory} clients={clients} role={effectiveRole} db={db} appId={appId} logAction={logAction} addToast={addToast} categories={[...CATEGORIES, ...customInventoryCategories.filter(c => !CATEGORIES.includes(c))]} /></ProtectedRoute>} />
                <Route path="/expenses" element={<ProtectedRoute role={effectiveRole} resource="expenses" action="view_own"><Expenses expenses={expenses} projects={projects} user={user} role={effectiveRole} db={db} appId={appId} advances={advances} payouts={payouts} currentEmpId={effectiveEmpId} employees={safeEmployees} logAction={logAction} expenseCats={[...EXPENSE_CATS, ...customExpenseCategories.filter(c => !EXPENSE_CATS.includes(c))]} lockedFYs={lockedFYs} /></ProtectedRoute>} />
                <Route path="/employees" element={<ProtectedRoute role={effectiveRole} resource="employees"><Employees employees={safeEmployees} role={effectiveRole} db={db} appId={appId} advances={advances} logAction={logAction} /></ProtectedRoute>} />
                <Route path="/admin" element={<ProtectedRoute role={effectiveRole} resource="admin_tools"><AdminTools db={db} appId={appId} logAction={logAction} role={effectiveRole} /></ProtectedRoute>} />
                <Route path="/finance" element={<ProtectedRoute role={effectiveRole} resource="finance"><Finance clients={clients} employees={safeEmployees} projects={projects} payments={payments} payouts={payouts} vendorPayments={vendorPayments} expenses={expenses} advances={advances} role={effectiveRole} db={db} appId={appId} user={user} logAction={logAction} lockedFYs={lockedFYs} /></ProtectedRoute>} />
                <Route path="/accounting" element={<ProtectedRoute role={effectiveRole} resource="finance"><Accounting clients={clients} projects={projects} taxInvoices={taxInvoicesList} purchaseInvoices={purchaseInvoicesList} payments={payments} vendorPayments={vendorPayments} payouts={payouts} expenses={expenses} advances={advances} employees={safeEmployees} chartOfAccounts={chartOfAccounts} manualJournalEntries={journalEntries} openingBalances={openingBalances} fiscalYearClosings={fiscalYearClosings} recurringRules={recurringRules} partyAccounts={partyAccounts} db={db} appId={appId} role={effectiveRole} user={user} logAction={logAction} addToast={addToast} lockedFYs={lockedFYs} /></ProtectedRoute>} />
                <Route path="/reports" element={<ProtectedRoute role={effectiveRole} resource="reports"><Reports projects={projects} clients={clients} employees={safeEmployees} expenses={expenses} inventory={inventory} payments={payments} vendorPayments={vendorPayments} payouts={payouts} advances={advances} role={effectiveRole} timeLogs={timeLogs} purchaseInvoices={purchaseInvoicesList} taxInvoices={taxInvoicesList} chartOfAccounts={chartOfAccounts} openingBalances={openingBalances} fiscalYearClosings={fiscalYearClosings} journalEntries={journalEntries} partyAccounts={partyAccounts} /></ProtectedRoute>} />
                <Route path="/daily-report" element={<ProtectedRoute role={effectiveRole} resource="daily_reports"><DailyReport projects={projects} clients={clients} employees={safeEmployees} expenses={expenses} timeLogs={timeLogs} role={effectiveRole} /></ProtectedRoute>} />
                <Route path="/business-report" element={<ProtectedRoute role={effectiveRole} resource="reports"><BusinessReport projects={projects} clients={clients} employees={safeEmployees} expenses={expenses} inventory={inventory} payments={payments} vendorPayments={vendorPayments} payouts={payouts} role={effectiveRole} /></ProtectedRoute>} />
                <Route path="/challans" element={<ProtectedRoute role={effectiveRole} resource="challans"><ChallanManager projects={projects} clients={clients} inventory={inventory} db={db} appId={appId} logAction={logAction} user={user} role={effectiveRole} currentEmpId={effectiveEmpId} /></ProtectedRoute>} />
                <Route path="/documents" element={<ProtectedRoute role={effectiveRole} resource="documents"><DocumentsHub projects={projects} clients={clients} role={effectiveRole} currentEmpId={effectiveEmpId} db={db} appId={appId} logAction={logAction} /></ProtectedRoute>} />
                <Route path="/purchase-invoices" element={<ProtectedRoute role={effectiveRole} resource="purchase_invoices"><PurchaseInvoices db={db} appId={appId} logAction={logAction} inventory={inventory} clients={clients} projects={projects} role={effectiveRole} purchaseInvoicesExternal={purchaseInvoicesList} setPurchaseInvoicesExternal={setPurchaseInvoicesList} lockedFYs={lockedFYs} /></ProtectedRoute>} />
                <Route path="/tax-invoices" element={<ProtectedRoute role={effectiveRole} resource="tax_invoices"><TaxInvoices db={db} appId={appId} role={effectiveRole} currentEmpId={effectiveEmpId} user={user} logAction={logAction} addToast={addToast} taxInvoices={taxInvoicesList} projects={projects} clients={clients} payments={payments} lockedFYs={lockedFYs} /></ProtectedRoute>} />
                <Route path="/audit" element={<ProtectedRoute role={effectiveRole} resource="audit_logs"><AuditLogs db={db} appId={appId} role={effectiveRole} /></ProtectedRoute>} />
                              <Route path="/data-portal" element={<ProtectedRoute role={effectiveRole} resource="admin_tools"><DataPortal db={db} appId={appId} role={effectiveRole} logAction={logAction} addToast={addToast} /></ProtectedRoute>} />
                <Route path="/profile" element={<ProfileSettings employee={currentEmployee} db={db} appId={appId} logAction={logAction} />} />
                {/* HR Module Routes */}
                <Route path="/hr/dashboard" element={<ProtectedRoute role={effectiveRole} resource="hr_dashboard"><HRDashboard employees={safeEmployees} timeLogs={timeLogs} hrLeaves={hrLeaves} shiftRequests={shiftRequests} penalties={penalties} /></ProtectedRoute>} />
                <Route path="/hr/attendance" element={<ProtectedRoute role={effectiveRole} resource="hr_attendance"><HRAttendance employees={safeEmployees} timeLogs={timeLogs} shiftRequests={shiftRequests} penalties={penalties} role={effectiveRole} currentEmpId={effectiveEmpId} db={db} appId={appId} logAction={logAction} addToast={addToast} hqSettings={hqSettings} /></ProtectedRoute>} />
                <Route path="/hr/leaves" element={<ProtectedRoute role={effectiveRole} resource="hr_leaves" action="view_own"><HRLeaves employees={safeEmployees} hrLeaves={hrLeaves} role={effectiveRole} currentEmpId={effectiveEmpId} db={db} appId={appId} logAction={logAction} addToast={addToast} /></ProtectedRoute>} />
                <Route path="/hr/reports" element={<ProtectedRoute role={effectiveRole} resource="hr_reports"><HRReports employees={safeEmployees} timeLogs={timeLogs} hrLeaves={hrLeaves} shiftRequests={shiftRequests} penalties={penalties} payroll={payroll} projects={projects} expenses={expenses} payouts={payouts} advances={advances} role={effectiveRole} db={db} appId={appId} logAction={logAction} hqSettings={hqSettings} /></ProtectedRoute>} />
                <Route path="/hr/payroll" element={<ProtectedRoute role={effectiveRole} resource="hr_payroll"><HRPayroll employees={safeEmployees} timeLogs={timeLogs} penalties={penalties} payroll={payroll} hrLeaves={hrLeaves} role={effectiveRole} db={db} appId={appId} logAction={logAction} addToast={addToast} /></ProtectedRoute>} />
                <Route path="/hr/settings" element={<ProtectedRoute role={effectiveRole} resource="hr_settings"><HRSettings hqSettings={hqSettings} role={effectiveRole} db={db} appId={appId} logAction={logAction} addToast={addToast} /></ProtectedRoute>} />
                <Route path="/hr/portal" element={<ProtectedRoute role={effectiveRole} resource="hr_portal"><HRPortal employees={safeEmployees} timeLogs={timeLogs} hrLeaves={hrLeaves} shiftRequests={shiftRequests} penalties={penalties} hqSettings={hqSettings} projects={projects} role={effectiveRole} currentEmpId={effectiveEmpId} db={db} appId={appId} logAction={logAction} addToast={addToast} /></ProtectedRoute>} />
              </Routes>
              </Suspense>
            {/* ===== ADMIN IMPERSONATION MODAL ===== */}
            {showImpersonateModal && (
              <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
                <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden">
                  <div className="flex items-center justify-between border-b p-4">
                    <div className="flex items-center gap-2">
                      <Eye size={18} className="text-amber-600" />
                      <h3 className="text-lg font-semibold text-slate-800">View App as Employee</h3>
                    </div>
                    <button onClick={() => setShowImpersonateModal(false)} className="rounded-full p-1 hover:bg-slate-100 text-slate-500"><X size={20} /></button>
                  </div>
                  <div className="p-4 space-y-2 max-h-[60vh] overflow-y-auto">
                    <p className="text-sm text-slate-500 mb-3">Temporarily view the app with an employee&apos;s role and permissions. No data is changed; exit anytime.</p>
                    {employees.filter(e => e.status !== 'Disabled' && e.status !== 'Deactivated').map(emp => (
                      <button key={emp.id}
                        onClick={() => { setImpersonating({ empId: emp.id, name: emp.name, role: emp.role || 'tech' }); setShowImpersonateModal(false); }}
                        className="w-full flex items-center gap-3 p-3 rounded-xl border border-slate-200 hover:border-amber-300 hover:bg-amber-50 text-left transition-colors">
                        <div className={`h-9 w-9 rounded-full flex items-center justify-center text-white text-sm font-bold shrink-0 ${emp.role === 'admin' ? 'bg-red-500' : emp.role === 'manager' ? 'bg-blue-500' : 'bg-green-500'}`}>
                          {(emp.name || '?')[0].toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-slate-800 truncate">{emp.name}</div>
                          <div className="text-xs text-slate-500 capitalize">{emp.role || 'tech'}{emp.designation ? ` \u00b7 ${emp.designation}` : ''}</div>
                        </div>
                        <span className={`text-xs px-2 py-0.5 rounded font-semibold shrink-0 ${emp.role === 'admin' ? 'bg-red-100 text-red-700' : emp.role === 'manager' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}`}>{emp.role || 'tech'}</span>
                      </button>
                    ))}
                    {employees.filter(e => e.status !== 'Disabled' && e.status !== 'Deactivated').length === 0 && (
                      <p className="text-sm text-slate-400 text-center py-4">No active employees found.</p>
                    )}
                  </div>
                </div>
              </div>
            )}
           
          </div>
        </main>
      </div>
    </div>
    </ErrorBoundary>
  );
}
