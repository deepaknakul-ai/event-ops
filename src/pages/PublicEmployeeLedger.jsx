import React, { useState, useEffect, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { appId } from '../utils/constants';
import { formatCurrency } from '../utils/helpers';
import { LoadingSpinner } from '../components/Shared';
import { FileText, Wallet, TrendingUp, IndianRupee } from 'lucide-react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from '@e965/xlsx';

const PublicEmployeeLedger = () => {
  const { token } = useParams();
  const [employee, setEmployee] = useState(null);
  const [orgSettings, setOrgSettings] = useState(null);
  const [payouts, setPayouts] = useState([]);
  const [advances, setAdvances] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [fyFilter, setFyFilter] = useState('ALL');

  useEffect(() => {
    let isMounted = true;
    const fetchData = async () => {
      setLoading(true);
      setError('');
      try {
        // Token validation + scoped data all happen server-side (Admin SDK).
        const fn = httpsCallable(getFunctions(), 'getEmployeeStatement');
        const res = await fn({ appId, token });
        const data = res.data || {};
        if (!isMounted) return;
        setEmployee(data.employee || null);
        setPayouts(data.payouts || []);
        setAdvances(data.advances || []);
        setOrgSettings(data.org || null);
      } catch (err) {
        console.error('Employee statement load failed:', err);
        if (isMounted) { setEmployee(null); setError(err?.message || 'Failed to load statement. Please try again later.'); }
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    if (token) fetchData();
    return () => { isMounted = false; };
  }, [token]);

  // Indian FY label (e.g. "2024-25")
  const getEntryFY = (dateStr) => {
    if (!dateStr) return 'Unknown';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return 'Unknown';
    const m = d.getMonth();
    const y = d.getFullYear();
    if (m < 3) return `${y - 1}-${String(y).slice(-2)}`;
    return `${y}-${String(y + 1).slice(-2)}`;
  };

  const { allRows, fyList, fySummaries } = useMemo(() => {
    if (!employee) return { allRows: [], fyList: ['ALL'], fySummaries: {} };

    const raw = [];

    // Add payouts (salary/cash disbursements)
    payouts.forEach(p => raw.push({
      date: p.date,
      desc: `Payout: ${p.mode || 'Cash'}${p.reference ? ' - ' + p.reference : ''}`,
      type: 'payout',
      amount: parseFloat(p.amount || 0),
      remarks: p.remarks || ''
    }));

    // Add advances
    advances.forEach(a => raw.push({
      date: a.date,
      desc: `Advance${a.remarks ? ': ' + a.remarks : ''}`,
      type: 'advance',
      amount: parseFloat(a.amount || 0),
      remarks: a.remarks || ''
    }));

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
    let runningTotal = 0;
    const summaries = {};

    sortedFYs.forEach((fy, fyIdx) => {
      result.push({ _type: 'fy_header', fy });

      let fyPayoutTotal = 0;
      let fyAdvanceTotal = 0;

      // Balance Carried Forward
      if (fyIdx > 0 && runningTotal !== 0) {
        result.push({
          _type: 'bcf',
          fy,
          Date: fyBuckets[fy][0]?.date || '',
          Description: `Balance Carried Forward from FY ${sortedFYs[fyIdx - 1]}`,
          Amount: runningTotal,
          RunningTotal: runningTotal,
          type: 'bcf'
        });
      }

      fyBuckets[fy].forEach(row => {
        runningTotal += row.amount;
        if (row.type === 'payout') fyPayoutTotal += row.amount;
        if (row.type === 'advance') fyAdvanceTotal += row.amount;

        result.push({
          _type: 'row',
          fy,
          Date: row.date,
          Description: row.desc,
          type: row.type,
          Amount: row.amount,
          RunningTotal: runningTotal,
          remarks: row.remarks
        });
      });

      summaries[fy] = {
        payouts: fyPayoutTotal,
        advances: fyAdvanceTotal,
        total: fyPayoutTotal + fyAdvanceTotal,
        closing: runningTotal
      };
    });

    // Overall summary
    summaries['ALL'] = {
      payouts: payouts.reduce((s, p) => s + parseFloat(p.amount || 0), 0),
      advances: advances.reduce((s, a) => s + parseFloat(a.amount || 0), 0),
      total: payouts.reduce((s, p) => s + parseFloat(p.amount || 0), 0) + advances.reduce((s, a) => s + parseFloat(a.amount || 0), 0),
      closing: runningTotal
    };

    return { allRows: result, fyList: ['ALL', ...sortedFYs], fySummaries: summaries };
  }, [employee, payouts, advances]);

  const visibleRows = useMemo(() => {
    if (fyFilter === 'ALL') return allRows;
    return allRows.filter(r => r.fy === fyFilter);
  }, [allRows, fyFilter]);

  const currentSummary = fySummaries[fyFilter] || { payouts: 0, advances: 0, total: 0, closing: 0 };

  const exportRows = useMemo(() => {
    const source = fyFilter === 'ALL' ? allRows : allRows.filter(r => r.fy === fyFilter);
    return source
      .filter(r => r._type !== 'fy_header')
      .map(r => ({
        Date: r.Date,
        Description: r.Description,
        Type: r.type === 'payout' ? 'Payout' : r.type === 'advance' ? 'Advance' : 'B/F',
        Amount: r.Amount,
        'Running Total': r.RunningTotal
      }));
  }, [allRows, fyFilter]);

  const exportPDF = () => {
    if (exportRows.length === 0) return alert('No data to export');
    const pdfDoc = new jsPDF();
    pdfDoc.setFontSize(16);
    pdfDoc.text(orgSettings?.name || 'Payment Statement', 14, 18);
    if (orgSettings?.logo) {
      try {
        const logoType = orgSettings.logo.startsWith('data:image/jpeg') ? 'JPEG' : 'PNG';
        pdfDoc.addImage(orgSettings.logo, logoType, 160, 10, 30, 20);
      } catch (e) { console.warn('Logo render failed', e); }
    }
    pdfDoc.setFontSize(12);
    pdfDoc.text('Employee Payment Statement', 14, 26);
    pdfDoc.setFontSize(10);
    pdfDoc.text(`Employee: ${employee?.name}`, 14, 34);
    pdfDoc.text(`Generated: ${new Date().toLocaleDateString('en-IN')}`, 14, 40);
    if (fyFilter !== 'ALL') pdfDoc.text(`Financial Year: FY ${fyFilter}`, 14, 46);

    let startY = fyFilter !== 'ALL' ? 52 : 46;

    // Summary box
    pdfDoc.setFillColor(245, 247, 250);
    pdfDoc.rect(14, startY, 182, 18, 'F');
    pdfDoc.setFontSize(9);
    pdfDoc.text(`Payouts: ${currentSummary.payouts.toFixed(2)}`, 18, startY + 8);
    pdfDoc.text(`Advances: ${currentSummary.advances.toFixed(2)}`, 80, startY + 8);
    pdfDoc.text(`Total Received: ${currentSummary.total.toFixed(2)}`, 140, startY + 8);
    startY += 24;

    const headers = ['Date', 'Description', 'Type', 'Amount', 'Running Total'];
    const data = exportRows.map(row => [
      row.Date ? new Date(row.Date).toLocaleDateString('en-IN') : '—',
      row.Description,
      row.Type,
      row.Amount?.toFixed(2) || '0.00',
      row['Running Total']?.toFixed(2) || '0.00'
    ]);

    autoTable(pdfDoc, {
      head: [headers],
      body: data,
      startY,
      didParseCell: ({ row: r, cell }) => {
        if (r.raw?.[1]?.toString()?.startsWith('Balance Carried Forward')) {
          cell.styles.fillColor = [255, 251, 235];
          cell.styles.fontStyle = 'bold';
        }
      }
    });
    const footerY = pdfDoc.internal.pageSize.getHeight() - 12;
    pdfDoc.setFontSize(9);
    pdfDoc.text(orgSettings?.name ? `Generated by ${orgSettings.name}` : 'Generated by RentalOps', 14, footerY);
    pdfDoc.save(`employee_statement_${employee?.name || 'employee'}${fyFilter !== 'ALL' ? `_FY${fyFilter}` : ''}.pdf`);
  };

  const exportExcel = () => {
    if (exportRows.length === 0) return alert('No data to export');
    const ws = XLSX.utils.json_to_sheet(exportRows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, fyFilter === 'ALL' ? 'Statement' : `FY ${fyFilter}`);
    XLSX.writeFile(wb, `employee_statement_${employee?.name || 'employee'}${fyFilter !== 'ALL' ? `_FY${fyFilter}` : ''}.xlsx`);
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
          <div className="text-lg font-semibold text-slate-800">Statement Unavailable</div>
          <div className="text-sm text-slate-500 mt-2">{error}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-black">
      <div className="max-w-5xl mx-auto p-4 md:p-8 space-y-4">
        {/* Header */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 md:p-6 shadow-sm">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <div className="text-xs uppercase tracking-wide text-slate-400">{orgSettings?.name || 'RentalOps'}</div>
              <h1 className="text-2xl font-bold text-slate-800">Payment Statement</h1>
              <div className="text-sm text-slate-500 mt-1">
                {employee?.name}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={fyFilter}
                onChange={e => setFyFilter(e.target.value)}
                className="border border-slate-200 rounded px-3 py-2 text-sm text-slate-700 bg-white focus:ring-2 focus:ring-indigo-200"
              >
                {fyList.map(fy => (
                  <option key={fy} value={fy}>{fy === 'ALL' ? 'All Years' : `FY ${fy}`}</option>
                ))}
              </select>
              <button onClick={exportPDF} className="bg-red-600 text-white px-4 py-2 rounded hover:bg-red-700 flex items-center gap-2 text-sm">
                <FileText size={16} /> PDF
              </button>
              <button onClick={exportExcel} className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700 flex items-center gap-2 text-sm">
                <FileText size={16} /> Excel
              </button>
            </div>
          </div>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-emerald-100 flex items-center justify-center">
                <Wallet size={20} className="text-emerald-600" />
              </div>
              <div>
                <div className="text-xs text-slate-400 uppercase tracking-wide">Payouts</div>
                <div className="text-lg font-bold text-emerald-700">{formatCurrency(currentSummary.payouts)}</div>
              </div>
            </div>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-blue-100 flex items-center justify-center">
                <TrendingUp size={20} className="text-blue-600" />
              </div>
              <div>
                <div className="text-xs text-slate-400 uppercase tracking-wide">Advances</div>
                <div className="text-lg font-bold text-blue-700">{formatCurrency(currentSummary.advances)}</div>
              </div>
            </div>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-indigo-100 flex items-center justify-center">
                <IndianRupee size={20} className="text-indigo-600" />
              </div>
              <div>
                <div className="text-xs text-slate-400 uppercase tracking-wide">Total Received</div>
                <div className="text-lg font-bold text-indigo-700">{formatCurrency(currentSummary.total)}</div>
              </div>
            </div>
          </div>
        </div>

        {/* Statement Table */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="p-4 border-b flex items-center justify-between bg-slate-50">
            <span className="font-semibold text-slate-700">
              {fyFilter === 'ALL' ? 'All Financial Years' : `FY ${fyFilter}`}
            </span>
            <span className="text-xs text-slate-500">
              {visibleRows.filter(r => r._type === 'row').length} transactions
            </span>
          </div>
          <div className="overflow-x-auto max-h-[70vh]">
            <table className="w-full text-sm text-left">
              <thead className="bg-slate-100 text-slate-600 text-xs uppercase sticky top-0">
                <tr>
                  <th className="p-3 whitespace-nowrap">Date</th>
                  <th className="p-3">Description</th>
                  <th className="p-3 text-center">Type</th>
                  <th className="p-3 text-right">Amount</th>
                  <th className="p-3 text-right">Running Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visibleRows.map((row, idx) => {
                  if (row._type === 'fy_header') {
                    return (
                      <tr key={`fyhdr-${idx}`}>
                        <td colSpan={5} className="px-4 py-2 bg-indigo-700 text-white font-bold text-xs uppercase tracking-widest">
                          &#9670;&nbsp; Financial Year {row.fy}
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
                        <td className="p-3 text-center">
                          <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded">B/F</span>
                        </td>
                        <td className="p-3 text-right text-slate-700">{formatCurrency(row.Amount)}</td>
                        <td className="p-3 text-right font-bold text-indigo-700">{formatCurrency(row.RunningTotal)}</td>
                      </tr>
                    );
                  }
                  return (
                    <tr key={idx} className="hover:bg-slate-50">
                      <td className="p-3 whitespace-nowrap text-slate-500">
                        {row.Date ? new Date(row.Date).toLocaleDateString('en-IN') : '—'}
                      </td>
                      <td className="p-3 text-slate-700">{row.Description}</td>
                      <td className="p-3 text-center">
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded ${
                          row.type === 'payout' ? 'bg-emerald-100 text-emerald-700' : 'bg-blue-100 text-blue-700'
                        }`}>
                          {row.type === 'payout' ? 'Payout' : 'Advance'}
                        </span>
                      </td>
                      <td className="p-3 text-right font-medium text-emerald-700">{formatCurrency(row.Amount)}</td>
                      <td className="p-3 text-right font-semibold text-slate-800">{formatCurrency(row.RunningTotal)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {visibleRows.length === 0 && (
              <div className="p-8 text-center text-slate-400">No payment records found.</div>
            )}
          </div>
        </div>

        <div className="text-xs text-slate-400 text-center">Generated by {orgSettings?.name || 'RentalOps'}</div>
      </div>
    </div>
  );
};

export default PublicEmployeeLedger;
