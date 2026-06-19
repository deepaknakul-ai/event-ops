import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { Building2, FileText, Wallet, AlertCircle, Printer, Loader, CheckCircle2 } from 'lucide-react';
import { appId } from '../utils/constants';
import { formatCurrency, fmtDate } from '../utils/helpers';

// Public, magic-link self-service portal for a client/vendor. All data is
// fetched through the token-validated getPortalData Cloud Function — the page
// itself has no Firestore access and needs no login.
const Portal = () => {
  const { token } = useParams();
  const [state, setState] = useState({ loading: true, error: '', data: null });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const fn = httpsCallable(getFunctions(), 'getPortalData');
        const res = await fn({ appId, token });
        if (alive) setState({ loading: false, error: '', data: res.data });
      } catch (e) {
        if (alive) setState({ loading: false, error: e?.message || 'Could not load this link.', data: null });
      }
    })();
    return () => { alive = false; };
  }, [token]);

  if (state.loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50">
        <div className="flex flex-col items-center gap-3 text-slate-500">
          <Loader className="h-8 w-8 animate-spin text-indigo-600" />
          <span className="text-sm font-medium">Loading your portal…</span>
        </div>
      </div>
    );
  }
  if (state.error || !state.data) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50 px-4">
        <div className="max-w-sm rounded-xl border border-red-200 bg-white p-6 text-center shadow-sm">
          <AlertCircle className="mx-auto mb-3 h-10 w-10 text-red-500" />
          <div className="text-base font-bold text-slate-800">Link unavailable</div>
          <div className="mt-1 text-sm text-slate-500">{state.error || 'This link is invalid or has expired. Please ask for a new one.'}</div>
        </div>
      </div>
    );
  }

  const { party, org, summary, projects, invoices, payments, vendor, isVendor } = state.data;
  const statusColor = (s) => ({
    Quoted: 'bg-slate-100 text-slate-600', Confirmed: 'bg-blue-100 text-blue-700', Ongoing: 'bg-amber-100 text-amber-700',
    Completed: 'bg-emerald-100 text-emerald-700', Closed: 'bg-emerald-100 text-emerald-700', Cancelled: 'bg-red-100 text-red-600',
  }[s] || 'bg-slate-100 text-slate-600');

  return (
    <div className="min-h-screen bg-slate-50 print:bg-white">
      {/* Header */}
      <div className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-4">
          <div className="flex items-center gap-3">
            {org.logo ? <img src={org.logo} alt="" className="h-10 w-10 rounded object-contain" /> : <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-600 text-white"><Building2 size={20} /></div>}
            <div>
              <div className="text-base font-bold text-slate-800">{org.name || 'Customer Portal'}</div>
              <div className="text-xs text-slate-400">{isVendor ? 'Vendor' : 'Client'} Portal</div>
            </div>
          </div>
          <button onClick={() => window.print()} className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 print:hidden"><Printer size={15} /> Print</button>
        </div>
      </div>

      <div className="mx-auto max-w-5xl space-y-5 px-4 py-6">
        {/* Party */}
        <div className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="text-lg font-bold text-slate-800">{party.name}</div>
          {party.gstin && <div className="text-xs text-slate-500 mt-0.5">GSTIN: {party.gstin}</div>}
          {party.address && <div className="text-xs text-slate-500 mt-0.5 whitespace-pre-line">{party.address}</div>}
        </div>

        {/* Summary */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4"><div className="text-[11px] font-medium text-slate-500">Total Billed</div><div className="mt-1 text-lg font-bold text-slate-800">{formatCurrency(summary.billed)}</div></div>
          <div className="rounded-xl border border-emerald-100 bg-emerald-50 p-4"><div className="text-[11px] font-medium text-slate-500">Received</div><div className="mt-1 text-lg font-bold text-emerald-700">{formatCurrency(summary.received)}</div></div>
          <div className={`rounded-xl border p-4 ${summary.outstanding > 0.5 ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-white'}`}><div className="text-[11px] font-medium text-slate-500">Outstanding</div><div className={`mt-1 text-lg font-bold ${summary.outstanding > 0.5 ? 'text-amber-700' : 'text-slate-800'}`}>{formatCurrency(summary.outstanding)}</div></div>
          <div className="rounded-xl border border-slate-200 bg-white p-4"><div className="text-[11px] font-medium text-slate-500">Projects</div><div className="mt-1 text-lg font-bold text-slate-800">{summary.projectCount}</div></div>
        </div>

        {/* Projects */}
        <Section icon={<Building2 size={16} className="text-indigo-600" />} title="Projects">
          {projects.length === 0 ? <Empty text="No projects yet." /> : (
            <Table head={['Project', 'Venue', 'Period', 'Status']}>
              {projects.map((p) => (
                <tr key={p.id} className="border-t border-slate-100">
                  <td className="px-3 py-2 font-medium text-slate-700">{p.name}</td>
                  <td className="px-3 py-2 text-slate-500">{p.venue || '—'}</td>
                  <td className="px-3 py-2 text-slate-500">{fmtDate(p.start_date)} – {fmtDate(p.end_date)}</td>
                  <td className="px-3 py-2"><span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${statusColor(p.status)}`}>{p.status || '—'}</span></td>
                </tr>
              ))}
            </Table>
          )}
        </Section>

        {/* Invoices */}
        <Section icon={<FileText size={16} className="text-blue-600" />} title="Invoices">
          {invoices.length === 0 ? <Empty text="No invoices yet." /> : (
            <Table head={['Invoice No', 'Date', 'Amount']}>
              {invoices.map((i, idx) => (
                <tr key={idx} className="border-t border-slate-100">
                  <td className="px-3 py-2 font-medium text-slate-700">{i.invoice_no}</td>
                  <td className="px-3 py-2 text-slate-500">{fmtDate(i.date)}</td>
                  <td className="px-3 py-2 text-right font-semibold text-slate-800">{formatCurrency(i.amount)}</td>
                </tr>
              ))}
            </Table>
          )}
        </Section>

        {/* Payments */}
        <Section icon={<Wallet size={16} className="text-emerald-600" />} title="Payments Received">
          {payments.length === 0 ? <Empty text="No payments recorded." /> : (
            <Table head={['Date', 'Mode', 'Reference', 'Amount']}>
              {payments.map((p, idx) => (
                <tr key={idx} className="border-t border-slate-100">
                  <td className="px-3 py-2 text-slate-500">{fmtDate(p.date)}</td>
                  <td className="px-3 py-2 text-slate-500">{p.mode || '—'}</td>
                  <td className="px-3 py-2 text-slate-500">{p.ref || '—'}</td>
                  <td className="px-3 py-2 text-right font-semibold text-emerald-700">{formatCurrency(p.amount)}</td>
                </tr>
              ))}
            </Table>
          )}
        </Section>

        {/* Vendor engagement */}
        {isVendor && vendor && (
          <Section icon={<CheckCircle2 size={16} className="text-amber-600" />} title="Vendor Engagement">
            <div className="grid grid-cols-3 gap-3 px-3 py-3 text-sm">
              <div><div className="text-[11px] text-slate-500">Job Value</div><div className="font-bold text-slate-800">{formatCurrency(vendor.billed)}</div></div>
              <div><div className="text-[11px] text-slate-500">Paid</div><div className="font-bold text-emerald-700">{formatCurrency(vendor.paid)}</div></div>
              <div><div className="text-[11px] text-slate-500">Balance</div><div className={`font-bold ${vendor.balance > 0.5 ? 'text-amber-700' : 'text-slate-800'}`}>{formatCurrency(vendor.balance)}</div></div>
            </div>
            {vendor.jobs.length > 0 && (
              <Table head={['Project', 'Item', 'Amount']}>
                {vendor.jobs.map((j, idx) => (
                  <tr key={idx} className="border-t border-slate-100">
                    <td className="px-3 py-2 text-slate-700">{j.project}</td>
                    <td className="px-3 py-2 text-slate-500">{j.item}</td>
                    <td className="px-3 py-2 text-right font-semibold text-slate-800">{formatCurrency(j.amount)}</td>
                  </tr>
                ))}
              </Table>
            )}
          </Section>
        )}

        <div className="pb-8 text-center text-xs text-slate-400">
          {org.name}{org.phone ? ` · ${org.phone}` : ''}{org.email ? ` · ${org.email}` : ''}
        </div>
      </div>
    </div>
  );
};

const Section = ({ icon, title, children }) => (
  <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
    <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3"><span>{icon}</span><h3 className="text-sm font-bold text-slate-800">{title}</h3></div>
    {children}
  </div>
);
const Table = ({ head, children }) => (
  <div className="overflow-x-auto">
    <table className="w-full text-sm">
      <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
        <tr>{head.map((h, i) => <th key={i} className={`px-3 py-2 font-semibold ${i === head.length - 1 && /amount/i.test(h) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  </div>
);
const Empty = ({ text }) => <div className="px-4 py-6 text-center text-sm text-slate-400">{text}</div>;

export default Portal;
