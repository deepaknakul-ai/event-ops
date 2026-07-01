import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { appId } from '../utils/constants';
import { formatCurrency } from '../utils/helpers';
import { LoadingSpinner } from '../components/Shared';
import { FileText, Download, Image as ImageIcon, Receipt, Building2 } from 'lucide-react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from '@e965/xlsx';

const PublicReimbursable = () => {
  const { token } = useParams();
  const [project, setProject] = useState(null);
  const [client, setClient] = useState(null);
  const [orgSettings, setOrgSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let isMounted = true;
    const fetchData = async () => {
      setLoading(true);
      setError('');
      try {
        // Token validation + scoped (curated) data all happen server-side.
        const fn = httpsCallable(getFunctions(), 'getReimbursableData');
        const res = await fn({ appId, token });
        const data = res.data || {};
        if (isMounted) {
          setProject(data.project || null);
          setClient(data.client || null);
          setOrgSettings(data.org || null);
          setLoading(false);
        }
      } catch (err) {
        console.error(err);
        if (isMounted) { setError(err?.message || 'Failed to load data.'); setLoading(false); }
      }
    };
    if (token) fetchData();
    return () => { isMounted = false; };
  }, [token]);

  const expenses = (project?.reimbursable_expenses || []).sort((a, b) => new Date(a.date) - new Date(b.date));
  const total = expenses.reduce((sum, e) => sum + (parseFloat(e.amount) || 0), 0);

  const exportPDF = () => {
    const pdf = new jsPDF();
    const orgName = orgSettings?.company_name || 'RentalOps';

    // Header
    pdf.setFontSize(16);
    pdf.setFont(undefined, 'bold');
    pdf.text(orgName, 14, 20);
    pdf.setFontSize(10);
    pdf.setFont(undefined, 'normal');
    if (orgSettings?.address) pdf.text(orgSettings.address, 14, 27);
    if (orgSettings?.gstin) pdf.text(`GSTIN: ${orgSettings.gstin}`, 14, 33);

    pdf.setFontSize(14);
    pdf.setFont(undefined, 'bold');
    pdf.text('Client Reimbursable Expenses', 14, 45);
    pdf.setFontSize(10);
    pdf.setFont(undefined, 'normal');
    pdf.text(`Project: ${project.project_name}`, 14, 52);
    if (client) pdf.text(`Client: ${client.name}`, 14, 58);
    pdf.text(`Date Range: ${project.start_date || '-'} to ${project.end_date || '-'}`, 14, client ? 64 : 58);
    pdf.text(`Generated: ${new Date().toLocaleDateString('en-IN')}`, 14, client ? 70 : 64);

    const startY = client ? 78 : 72;
    const rows = expenses.map((e, i) => [
      i + 1,
      e.date ? new Date(e.date).toLocaleDateString('en-IN') : '-',
      e.description,
      e.category,
      formatCurrency(e.amount),
      e.remarks || '-'
    ]);
    rows.push(['', '', '', '', '', '']);
    rows.push(['', '', '', 'TOTAL', formatCurrency(total), '']);

    autoTable(pdf, {
      startY,
      head: [['#', 'Date', 'Description', 'Category', 'Amount', 'Remarks']],
      body: rows,
      styles: { fontSize: 9, cellPadding: 3 },
      headStyles: { fillColor: [13, 148, 136], textColor: 255, fontStyle: 'bold' },
      columnStyles: { 0: { cellWidth: 10 }, 4: { halign: 'right', fontStyle: 'bold' } },
      didParseCell: (data) => {
        if (data.section === 'body' && data.row.index === rows.length - 1) {
          data.cell.styles.fontStyle = 'bold';
          data.cell.styles.fillColor = [240, 253, 250];
        }
      }
    });

    pdf.save(`Reimbursable_${project.project_name.replace(/[^a-zA-Z0-9]/g, '_')}.pdf`);
  };

  const exportExcel = () => {
    const data = expenses.map((e, i) => ({
      '#': i + 1,
      'Date': e.date ? new Date(e.date).toLocaleDateString('en-IN') : '-',
      'Description': e.description,
      'Category': e.category,
      'Amount': parseFloat(e.amount) || 0,
      'Remarks': e.remarks || '',
      'Proof Link': e.proof_url || ''
    }));
    data.push({ '#': '', 'Date': '', 'Description': '', 'Category': 'TOTAL', 'Amount': total, 'Remarks': '', 'Proof Link': '' });

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Reimbursable Expenses');
    XLSX.writeFile(wb, `Reimbursable_${project.project_name.replace(/[^a-zA-Z0-9]/g, '_')}.xlsx`);
  };

  if (loading) return <LoadingSpinner />;

  if (error) {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-50 p-4">
        <div className="w-full max-w-md rounded-xl bg-white p-8 shadow-lg text-center">
          <div className="mb-4 mx-auto h-16 w-16 rounded-full bg-red-100 flex items-center justify-center">
            <Receipt size={28} className="text-red-500" />
          </div>
          <h1 className="text-xl font-bold text-slate-800 mb-2">Link Error</h1>
          <p className="text-slate-500">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-teal-50 to-slate-100 p-4 md:p-8">
      <div className="mx-auto max-w-4xl">
        {/* Header */}
        <div className="rounded-xl bg-white shadow-lg border border-slate-200 overflow-hidden mb-6">
          <div className="bg-gradient-to-r from-teal-600 to-teal-700 px-6 py-5 text-white">
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  {orgSettings?.company_name && (
                    <span className="text-teal-100 text-sm flex items-center gap-1"><Building2 size={14} /> {orgSettings.company_name}</span>
                  )}
                </div>
                <h1 className="text-2xl font-bold">Client Reimbursable Expenses</h1>
                <div className="text-teal-100 mt-1">{project.project_name}</div>
              </div>
              <div className="text-right">
                <div className="text-3xl font-bold">{formatCurrency(total)}</div>
                <div className="text-teal-200 text-sm">{expenses.length} expense(s)</div>
              </div>
            </div>
          </div>
          <div className="px-6 py-3 bg-teal-50 flex flex-wrap items-center justify-between gap-2 text-sm text-slate-600">
            <div>
              {client && <span className="mr-4"><strong>Client:</strong> {client.name}</span>}
              <span className="mr-4"><strong>Period:</strong> {project.start_date || '-'} to {project.end_date || '-'}</span>
            </div>
            <div className="flex gap-2">
              <button onClick={exportPDF} className="flex items-center gap-1.5 rounded-lg border border-teal-200 bg-white px-3 py-1.5 text-sm text-teal-700 hover:bg-teal-50 transition shadow-sm">
                <Download size={14} /> PDF
              </button>
              <button onClick={exportExcel} className="flex items-center gap-1.5 rounded-lg border border-teal-200 bg-white px-3 py-1.5 text-sm text-teal-700 hover:bg-teal-50 transition shadow-sm">
                <Download size={14} /> Excel
              </button>
            </div>
          </div>
        </div>

        {/* Expenses Table */}
        {expenses.length === 0 ? (
          <div className="rounded-xl bg-white p-12 shadow-lg border text-center text-slate-400">
            No reimbursable expenses recorded for this project yet.
          </div>
        ) : (
          <div className="rounded-xl bg-white shadow-lg border border-slate-200 overflow-hidden">
            {/* Desktop Table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="bg-slate-50 text-slate-600 text-xs uppercase border-b">
                  <tr>
                    <th className="p-3 w-10">#</th>
                    <th className="p-3">Date</th>
                    <th className="p-3">Description</th>
                    <th className="p-3">Category</th>
                    <th className="p-3 text-right">Amount</th>
                    <th className="p-3 text-center">Proof</th>
                    <th className="p-3">Remarks</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {expenses.map((exp, idx) => (
                    <tr key={exp.id || idx} className="text-slate-700 hover:bg-slate-50">
                      <td className="p-3 text-slate-400">{idx + 1}</td>
                      <td className="p-3 whitespace-nowrap">{exp.date ? new Date(exp.date).toLocaleDateString('en-IN') : '-'}</td>
                      <td className="p-3 font-medium text-slate-800">{exp.description}</td>
                      <td className="p-3"><span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded">{exp.category}</span></td>
                      <td className="p-3 text-right font-semibold text-slate-800">{formatCurrency(exp.amount)}</td>
                      <td className="p-3 text-center">
                        {exp.proof_url ? (
                          <a href={exp.proof_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-teal-700 bg-teal-50 px-2 py-1 rounded border border-teal-100 hover:bg-teal-100 transition">
                            {exp.proof_url.toLowerCase().includes('.pdf') ? <FileText size={12} /> : <ImageIcon size={12} />} View
                          </a>
                        ) : (
                          <span className="text-xs text-slate-300">—</span>
                        )}
                      </td>
                      <td className="p-3 text-xs text-slate-500">{exp.remarks || '-'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-teal-50 border-t-2 border-teal-200">
                  <tr>
                    <td colSpan={4} className="p-3 text-right font-bold text-teal-800">Total Reimbursable</td>
                    <td className="p-3 text-right font-bold text-teal-800 text-lg">{formatCurrency(total)}</td>
                    <td colSpan={2}></td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/* Mobile Cards */}
            <div className="md:hidden divide-y divide-slate-100">
              {expenses.map((exp, idx) => (
                <div key={exp.id || idx} className="p-4">
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <div className="font-semibold text-slate-800">{exp.description}</div>
                      <div className="text-xs text-slate-500">{exp.date ? new Date(exp.date).toLocaleDateString('en-IN') : '-'} · {exp.category}</div>
                    </div>
                    <div className="text-lg font-bold text-slate-800">{formatCurrency(exp.amount)}</div>
                  </div>
                  {exp.remarks && <div className="text-xs text-slate-400 mb-2">{exp.remarks}</div>}
                  {exp.proof_url && (
                    <a href={exp.proof_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-teal-700 bg-teal-50 px-2 py-1 rounded border border-teal-100">
                      {exp.proof_url.toLowerCase().includes('.pdf') ? <FileText size={12} /> : <ImageIcon size={12} />} View Proof
                    </a>
                  )}
                </div>
              ))}
              <div className="p-4 bg-teal-50 flex justify-between items-center">
                <span className="font-bold text-teal-800">Total</span>
                <span className="text-xl font-bold text-teal-800">{formatCurrency(total)}</span>
              </div>
            </div>
          </div>
        )}

        <div className="mt-6 text-center text-xs text-slate-400">
          Powered by RentalOps {orgSettings?.company_name ? `· ${orgSettings.company_name}` : ''}
        </div>
      </div>
    </div>
  );
};

export default PublicReimbursable;
