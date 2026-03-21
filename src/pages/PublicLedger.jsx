import React, { useState, useEffect, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { getDocs, query, collection, where, getDoc, doc } from 'firebase/firestore';
import { db } from '../firebase';
import { appId } from '../utils/constants';
import { formatCurrency, getProjectGrandTotal } from '../utils/helpers';
import { LoadingSpinner } from '../components/Shared';
import { FileText } from 'lucide-react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';

const PublicLedger = () => {
  const { token } = useParams();
  const [client, setClient] = useState(null);
  const [orgSettings, setOrgSettings] = useState(null);
  const [projects, setProjects] = useState([]);
  const [payments, setPayments] = useState([]);
  const [vendorPayments, setVendorPayments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [fyFilter, setFyFilter] = useState('ALL');

  useEffect(() => {
    let isMounted = true;
    const fetchLedgerData = async () => {
      setLoading(true);
      setError('');
      try {
        const clientSnap = await getDocs(
          query(
            collection(db, 'artifacts', appId, 'public', 'data', 'clients'),
            where('ledger_link_token', '==', token)
          )
        );

        if (clientSnap.empty) {
          if (isMounted) {
            setClient(null);
            setError('Invalid or expired ledger link.');
            setLoading(false);
          }
          return;
        }

        const clientDoc = clientSnap.docs[0];
        const clientData = { id: clientDoc.id, ...clientDoc.data() };

        const [projectsSnap, paymentsSnap, vendorPaymentsSnap, orgSnap] = await Promise.all([
          getDocs(collection(db, 'artifacts', appId, 'public', 'data', 'projects')),
          getDocs(collection(db, 'artifacts', appId, 'public', 'data', 'payments')),
          getDocs(collection(db, 'artifacts', appId, 'public', 'data', 'vendor_payments')),
          getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'organization'))
        ]);

        if (!isMounted) return;
        if (clientData.ledger_link_enabled === false) {
          setClient(null);
          setError('This ledger link has been disabled.');
          setLoading(false);
          return;
        }

        if (clientData.ledger_link_expires_at) {
          const expiresAt = new Date(clientData.ledger_link_expires_at);
          if (Number.isNaN(expiresAt.getTime()) || expiresAt < new Date()) {
            setClient(null);
            setError('This ledger link has expired.');
            setLoading(false);
            return;
          }
        }

        setClient(clientData);
        setProjects(projectsSnap.docs.map(d => ({ id: d.id, ...d.data() })));
        setPayments(paymentsSnap.docs.map(d => ({ id: d.id, ...d.data() })));
        setVendorPayments(vendorPaymentsSnap.docs.map(d => ({ id: d.id, ...d.data() })));
        setOrgSettings(orgSnap.exists() ? orgSnap.data() : null);
      } catch (err) {
        console.error('Public ledger load failed:', err);
        if (isMounted) setError('Failed to load ledger. Please try again later.');
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    if (token) fetchLedgerData();
    return () => { isMounted = false; };
  }, [token]);

  // Returns the Indian FY label (e.g. "2024-25") for any date string
  const getEntryFY = (dateStr) => {
    if (!dateStr) return 'Unknown';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return 'Unknown';
    const m = d.getMonth(); // 0 = Jan
    const y = d.getFullYear();
    if (m < 3) return `${y - 1}-${String(y).slice(-2)}`; // Jan–Mar → prev FY
    return `${y}-${String(y + 1).slice(-2)}`; // Apr–Dec → current FY
  };

  const { allRows, fyList } = useMemo(() => {
    if (!client) return { allRows: [], fyList: ['ALL'] };

    const includeClientLedger = client.type === 'Client' || client.type === 'Both';
    const includeVendorLedger = client.type === 'Vendor' || client.type === 'Both';
    const raw = [];

    if (includeClientLedger) {
      projects
        .filter(p => p.client_id === client.id && ['Completed', 'Closed'].includes(p.status))
        .forEach(p => raw.push({
          date: p.end_date,
          desc: `Invoice: ${p.project_name}`,
          debit: getProjectGrandTotal(p),
          credit: 0,
          invoice_status: p.invoice_status || 'Not Invoiced',
          invoice_no: p.invoice_no || '—',
          invoice_date: p.invoice_date || '—'
        }));
      payments
        .filter(p => p.client_id === client.id)
        .forEach(p => raw.push({
          date: p.date,
          desc: `Payment: ${p.mode} - ${p.reference}`,
          debit: 0,
          credit: parseFloat(p.amount || 0),
          invoice_status: null, invoice_no: null, invoice_date: null
        }));
    }

    if (includeVendorLedger) {
      projects.forEach(p => {
        if (p.purchase_orders) {
          p.purchase_orders.forEach(po => {
            if (po.vendor_id === client.id && po.status !== 'Cancelled') {
              const poAmount = (po.package_cost && po.package_cost > 0)
                ? po.package_cost * (1 + (po.package_cost_gst || 0) / 100)
                : parseFloat(po.amount || 0);
              raw.push({
                date: po.date,
                desc: `Vendor Bill: ${po.po_no} (${p.project_name})`,
                debit: 0, credit: poAmount,
                invoice_status: null, invoice_no: null, invoice_date: null
              });
            }
          });
        }
      });
      vendorPayments
        .filter(p => p.vendor_id === client.id)
        .forEach(p => raw.push({
          date: p.date,
          desc: `Vendor Payment: ${p.mode} - ${p.reference}`,
          debit: parseFloat(p.amount || 0), credit: 0,
          invoice_status: null, invoice_no: null, invoice_date: null
        }));
    }

    raw.sort((a, b) => new Date(a.date) - new Date(b.date));

    // Group by FY
    const fyBuckets = {};
    raw.forEach(r => {
      const fy = getEntryFY(r.date);
      if (!fyBuckets[fy]) fyBuckets[fy] = [];
      fyBuckets[fy].push(r);
    });

    const sortedFYs = Object.keys(fyBuckets).sort((a, b) => parseInt(a) - parseInt(b));

    const result = [];
    let runningBalance = 0;

    sortedFYs.forEach((fy, fyIdx) => {
      // Section header row
      result.push({ _type: 'fy_header', fy });

      // Balance Carried Forward (only after the first FY and only if non-zero)
      if (fyIdx > 0 && runningBalance !== 0) {
        result.push({
          _type: 'bcf',
          fy,
          Date: fyBuckets[fy][0]?.date || '',
          Description: `Balance Carried Forward from FY ${sortedFYs[fyIdx - 1]}`,
          Debit: runningBalance > 0 ? runningBalance : 0,
          Credit: runningBalance < 0 ? Math.abs(runningBalance) : 0,
          Balance: runningBalance
        });
      }

      fyBuckets[fy].forEach(row => {
        runningBalance += (row.debit - row.credit);
        result.push({
          _type: 'row',
          fy,
          Date: row.date,
          Description: row.desc,
          invoice_status: row.invoice_status,
          invoice_no: row.invoice_no,
          invoice_date: row.invoice_date,
          Debit: row.debit,
          Credit: row.credit,
          Balance: runningBalance
        });
      });
    });

    return { allRows: result, fyList: ['ALL', ...sortedFYs] };
  }, [client, projects, payments, vendorPayments]);

  // Rows visible in the table (filtered by selected FY)
  const visibleRows = useMemo(() => {
    if (fyFilter === 'ALL') return allRows;
    return allRows.filter(r => r.fy === fyFilter);
  }, [allRows, fyFilter]);

  // Flat rows for PDF / Excel export (no fy_header separators)
  const exportRows = useMemo(() => {
    const source = fyFilter === 'ALL' ? allRows : allRows.filter(r => r.fy === fyFilter);
    return source
      .filter(r => r._type !== 'fy_header')
      .map(r => ({
        Date: r.Date,
        Description: r.Description,
        'Invoice Status': r.invoice_status || '',
        'Invoice No': r.invoice_no || '',
        'Invoice Date': r.invoice_date || '',
        Debit: r.Debit,
        Credit: r.Credit,
        Balance: r.Balance
      }));
  }, [allRows, fyFilter]);

  const exportPDF = () => {
    if (exportRows.length === 0) return alert('No data to export');
    const doc = new jsPDF();
    doc.setFontSize(16);
    doc.text(orgSettings?.name || 'Ledger Statement', 14, 18);
    if (orgSettings?.logo) {
      try {
        const logoType = orgSettings.logo.startsWith('data:image/jpeg') ? 'JPEG' : 'PNG';
        doc.addImage(orgSettings.logo, logoType, 160, 10, 30, 20);
      } catch (e) { console.warn('Logo render failed', e); }
    }
    doc.setFontSize(12);
    doc.text('Ledger Statement', 14, 26);
    doc.setFontSize(10);
    doc.text(`Generated: ${new Date().toLocaleDateString()}`, 14, 32);
    if (client) doc.text(`Party: ${client.name} (${client.type})`, 14, 38);
    if (fyFilter !== 'ALL') doc.text(`Financial Year: FY ${fyFilter}`, 14, 44);

    const headers = ['Date', 'Description', 'Debit', 'Credit', 'Balance'];
    const data = exportRows.map(row => headers.map(h =>
      typeof row[h] === 'number' ? row[h].toFixed(2) : (row[h] || '')
    ));

    autoTable(doc, {
      head: [headers],
      body: data,
      startY: fyFilter !== 'ALL' ? 50 : 44,
      didParseCell: ({ row: r, cell }) => {
        if (r.raw?.[1]?.toString()?.startsWith('Balance Carried Forward')) {
          cell.styles.fillColor = [255, 251, 235];
          cell.styles.fontStyle = 'bold';
        }
      }
    });
    const footerY = doc.internal.pageSize.getHeight() - 12;
    doc.setFontSize(9);
    doc.text(orgSettings?.name ? `Generated by ${orgSettings.name}` : 'Generated by RentalOps', 14, footerY);
    doc.save(`ledger_${client?.name || 'party'}${fyFilter !== 'ALL' ? `_FY${fyFilter}` : ''}.pdf`);
  };

  const exportExcel = () => {
    if (exportRows.length === 0) return alert('No data to export');
    const ws = XLSX.utils.json_to_sheet(exportRows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, fyFilter === 'ALL' ? 'Ledger' : `FY ${fyFilter}`);
    XLSX.writeFile(wb, `ledger_${client?.name || 'party'}${fyFilter !== 'ALL' ? `_FY${fyFilter}` : ''}.xlsx`);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 text-slate-700">
        <LoadingSpinner />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 text-slate-700 p-6">
        <div className="max-w-md w-full bg-white border border-slate-200 rounded-xl p-6 text-center">
          <div className="text-lg font-semibold text-slate-800">Ledger Unavailable</div>
          <div className="text-sm text-slate-500 mt-2">{error}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-black">
      <div className="max-w-5xl mx-auto p-4 md:p-8 space-y-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4 md:p-6 shadow-sm">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-400">{orgSettings?.name || 'RentalOps'}</div>
              <h1 className="text-2xl font-bold text-slate-800">Ledger Statement</h1>
              <div className="text-sm text-slate-500 mt-1">
                {client?.name} • {client?.type}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {/* FY Filter */}
              <select
                value={fyFilter}
                onChange={e => setFyFilter(e.target.value)}
                className="border border-slate-200 rounded px-3 py-2 text-sm text-slate-700 bg-white focus:ring-2 focus:ring-indigo-200"
              >
                {fyList.map(fy => (
                  <option key={fy} value={fy}>{fy === 'ALL' ? 'All Years' : `FY ${fy}`}</option>
                ))}
              </select>
              <button onClick={exportPDF} className="bg-red-600 text-white px-4 py-2 rounded hover:bg-red-700 flex items-center gap-2">
                <FileText size={16} /> PDF
              </button>
              <button onClick={exportExcel} className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700 flex items-center gap-2">
                <FileText size={16} /> Excel
              </button>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="p-4 border-b flex items-center justify-between bg-slate-50">
              <span className="font-semibold">
                {fyFilter === 'ALL' ? 'All Financial Years' : `FY ${fyFilter}`}
              </span>
              {fyFilter !== 'ALL' && (() => {
                const fyRows = visibleRows.filter(r => r._type === 'row' || r._type === 'bcf');
                const closing = fyRows.length > 0 ? fyRows[fyRows.length - 1].Balance : null;
                return closing !== null ? (
                  <span className={`text-sm font-bold px-3 py-1 rounded-full ${closing >= 0 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                    Closing Balance: {formatCurrency(Math.abs(closing))} {closing >= 0 ? 'Dr' : 'Cr'}
                  </span>
                ) : null;
              })()}
            </div>
          <div className="overflow-x-auto max-h-[70vh]">
            <table className="w-full text-sm text-left">
              <thead className="bg-slate-100 text-slate-600 text-xs uppercase">
                <tr>
                  <th className="p-3 whitespace-nowrap">Date</th>
                  <th className="p-3">Description</th>
                  <th className="p-3 text-right">Debit</th>
                  <th className="p-3 text-right">Credit</th>
                  <th className="p-3 text-right">Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visibleRows.map((row, idx) => {
                  if (row._type === 'fy_header') {
                    return (
                      <tr key={`fyhdr-${idx}`}>
                        <td colSpan={5} className="px-4 py-2 bg-indigo-700 text-white font-bold text-xs uppercase tracking-widest">
                          ◆&nbsp; Financial Year {row.fy}
                        </td>
                      </tr>
                    );
                  }
                  if (row._type === 'bcf') {
                    return (
                      <tr key={`bcf-${idx}`} className="bg-amber-50 font-semibold border-y-2 border-amber-200">
                        <td className="p-3 whitespace-nowrap text-amber-800 text-xs">
                          {row.Date ? new Date(row.Date).toLocaleDateString('en-IN') : '—'}
                        </td>
                        <td className="p-3 italic text-amber-800">{row.Description}</td>
                        <td className="p-3 text-right text-slate-700">{row.Debit > 0 ? formatCurrency(row.Debit) : '—'}</td>
                        <td className="p-3 text-right text-slate-700">{row.Credit > 0 ? formatCurrency(row.Credit) : '—'}</td>
                        <td className="p-3 text-right font-bold text-indigo-700">{formatCurrency(row.Balance)}</td>
                      </tr>
                    );
                  }
                  return (
                    <tr key={idx} className="hover:bg-slate-50">
                      <td className="p-3 whitespace-nowrap text-slate-500">
                        {row.Date ? new Date(row.Date).toLocaleDateString('en-IN') : '—'}
                      </td>
                      <td className="p-3 text-slate-700">
                        <div>{row.Description}</div>
                        {row.invoice_status && (
                          <div className="flex flex-wrap gap-1.5 mt-1">
                            <span className={`text-xs font-semibold px-1.5 py-0.5 rounded ${row.invoice_status === 'Invoiced' ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'}`}>
                              {row.invoice_status}
                            </span>
                            {row.invoice_no && row.invoice_no !== '—' && (
                              <span className="text-xs bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded"> Inv# {row.invoice_no}</span>
                            )}
                            {row.invoice_date && row.invoice_date !== '—' && (
                              <span className="text-xs bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded"> {new Date(row.invoice_date).toLocaleDateString('en-IN')}</span>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="p-3 text-right text-slate-600">{row.Debit > 0 ? formatCurrency(row.Debit) : '—'}</td>
                      <td className="p-3 text-right text-slate-600">{row.Credit > 0 ? formatCurrency(row.Credit) : '—'}</td>
                      <td className={`p-3 text-right font-semibold ${row.Balance >= 0 ? 'text-slate-800' : 'text-red-600'}`}>
                        {formatCurrency(Math.abs(row.Balance))} {row.Balance >= 0 ? 'Dr' : 'Cr'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {visibleRows.length === 0 && (
              <div className="p-8 text-center text-slate-400">No ledger entries found.</div>
            )}
          </div>
        </div>
        <div className="text-xs text-slate-400 text-center">Generated by {orgSettings?.name || 'RentalOps'}</div>
      </div>
    </div>
  );
};

export default PublicLedger;
