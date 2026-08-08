import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { formatCurrency, getProjectGrandTotal, publicAppId } from '../utils/helpers';
import { LoadingSpinner } from '../components/Shared';
import { CheckCircle, XCircle, Package, Calendar, MapPin, Building2, ThumbsDown } from 'lucide-react';

const QuoteApproval = () => {
  const { token } = useParams();
  const [project, setProject] = useState(null);
  const [orgSettings, setOrgSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionStatus, setActionStatus] = useState(null); // null | 'approved' | 'rejected'
  const [processing, setProcessing] = useState(false);

  useEffect(() => {
    const fetchData = async () => {
      try {
        // Token validation happens server-side; internal cost fields are stripped.
        const fn = httpsCallable(getFunctions(), 'getQuoteApprovalData');
        const res = await fn({ appId: publicAppId(), token });
        const data = res.data || {};
        const projData = data.project || null;
        setProject(projData);
        setOrgSettings(data.org || null);

        // Already responded
        if (projData && (projData.quote_status === 'approved' || projData.quote_status === 'rejected')) {
          setActionStatus(projData.quote_status);
        }
      } catch (err) {
        console.error(err);
        setError(err?.message || 'Failed to load quote details. Please try again later.');
      }
      setLoading(false);
    };
    fetchData();
  }, [token]);

  const handleApprove = async () => {
    setProcessing(true);
    try {
      const fn = httpsCallable(getFunctions(), 'submitQuoteApproval');
      await fn({ appId: publicAppId(), token, decision: 'approved' });
      setActionStatus('approved');
    } catch (err) {
      alert('Could not process approval. Please try again or contact us directly.');
    }
    setProcessing(false);
  };

  const handleReject = async () => {
    setProcessing(true);
    try {
      const fn = httpsCallable(getFunctions(), 'submitQuoteApproval');
      await fn({ appId: publicAppId(), token, decision: 'rejected' });
      setActionStatus('rejected');
    } catch (err) {
      alert('Could not process your response. Please try again or contact us directly.');
    }
    setProcessing(false);
  };

  if (loading) return <LoadingSpinner />;

  if (error) return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-lg p-8 max-w-md text-center">
        <XCircle size={48} className="text-red-400 mx-auto mb-4" />
        <div className="text-xl font-bold text-slate-800 mb-2">Link Not Found</div>
        <div className="text-slate-500 text-sm">{error}</div>
      </div>
    </div>
  );

  if (actionStatus === 'approved') return (
    <div className="min-h-screen bg-green-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-lg p-8 max-w-md text-center border border-green-100">
        <CheckCircle size={56} className="text-green-500 mx-auto mb-4" />
        <div className="text-2xl font-bold text-green-700 mb-2">Quote Approved!</div>
        <div className="text-slate-600 mb-1">
          <span className="font-semibold">"{project?.project_name}"</span> has been confirmed.
        </div>
        <div className="text-sm text-slate-400 mt-3">
          {orgSettings?.name || 'The service provider'} has been notified and will be in touch shortly.
        </div>
        {orgSettings?.phone && (
          <div className="mt-4 text-sm text-slate-500">Questions? Call us at <span className="font-medium text-indigo-600">{orgSettings.phone}</span></div>
        )}
      </div>
    </div>
  );

  if (actionStatus === 'rejected') return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-lg p-8 max-w-md text-center border border-slate-200">
        <ThumbsDown size={48} className="text-slate-400 mx-auto mb-4" />
        <div className="text-xl font-bold text-slate-700 mb-2">Quote Declined</div>
        <div className="text-slate-500 mb-1">Your response has been recorded for <span className="font-semibold">"{project?.project_name}"</span>.</div>
        <div className="text-sm text-slate-400 mt-3">Please reach out to us if you'd like to discuss the requirements further.</div>
        {orgSettings?.phone && (
          <a href={`tel:${orgSettings.phone}`} className="mt-4 inline-block text-sm text-indigo-600 font-medium hover:underline">
            📞 {orgSettings.phone}
          </a>
        )}
      </div>
    </div>
  );

  const usePackageCost = project.package_cost > 0;
  const total = getProjectGrandTotal(project);

  return (
    <div className="min-h-screen bg-slate-100 py-8 px-4">
      <div className="max-w-2xl mx-auto space-y-5">

        {/* Org Header */}
        <div className="flex items-center gap-3">
          {orgSettings?.logo && (
            <img src={orgSettings.logo} alt="logo" className="h-10 w-10 rounded object-contain" />
          )}
          <div>
            <div className="font-bold text-slate-800 text-lg">{orgSettings?.name || 'RentalOps'}</div>
            {orgSettings?.gstin && <div className="text-xs text-slate-500">GSTIN: {orgSettings.gstin}</div>}
          </div>
        </div>

        {/* Project Header Banner */}
        <div className="bg-gradient-to-r from-indigo-600 to-blue-600 rounded-2xl p-6 text-white shadow">
          <div className="text-xs uppercase font-semibold text-indigo-200 mb-1 tracking-widest">
            Quotation for Approval
          </div>
          <div className="text-2xl font-bold mb-3">{project.project_name}</div>
          <div className="flex flex-wrap gap-4 text-sm text-indigo-100">
            <span className="flex items-center gap-1.5">
              <MapPin size={14} /> {project.venue || 'Venue TBD'}
            </span>
            <span className="flex items-center gap-1.5">
              <Calendar size={14} /> {project.start_date} → {project.end_date}
            </span>
          </div>
        </div>

        {/* Items / Package Cost */}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
          <div className="bg-slate-50 px-5 py-3 text-sm font-semibold text-slate-700 flex items-center gap-2 border-b">
            <Package size={16} className="text-indigo-500" /> Equipment &amp; Services
          </div>

          {usePackageCost ? (
            <div className="p-5">
              <div className="grid grid-cols-2 gap-4 text-sm mb-4">
                <div>
                  <div className="text-slate-500 text-xs uppercase font-semibold mb-1">Package Cost (Base)</div>
                  <div className="text-2xl font-bold text-slate-800">{formatCurrency(project.package_cost)}</div>
                </div>
                <div>
                  <div className="text-slate-500 text-xs uppercase font-semibold mb-1">GST @ {project.package_cost_gst ?? 18}%</div>
                  <div className="text-2xl font-bold text-slate-500">
                    {formatCurrency(project.package_cost * ((project.package_cost_gst ?? 18) / 100))}
                  </div>
                </div>
              </div>
              <div className="text-xs text-slate-500 mb-2">Included services:</div>
              <div className="space-y-1">
                {(project.items || []).map((item, i) => (
                  <div key={i} className="text-sm text-slate-700 flex items-center gap-2">
                    <span className="text-indigo-400">•</span> {item.item_name} × {item.qty} for {item.days} day(s)
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500 text-xs uppercase border-b">
                <tr>
                  <th className="px-4 py-3 text-left">Item / Service</th>
                  <th className="px-3 py-3 text-center">Qty</th>
                  <th className="px-3 py-3 text-center">Days</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(project.items || []).map((item, idx) => (
                  <tr key={idx} className="hover:bg-slate-50">
                    <td className="px-4 py-3 text-slate-700 font-medium">
                      {item.item_name}
                      {item.description && <div className="text-xs text-slate-400">{item.description}</div>}
                    </td>
                    <td className="px-3 py-3 text-center text-slate-600">{item.qty}</td>
                    <td className="px-3 py-3 text-center text-slate-600">{item.days}</td>
                    <td className="px-4 py-3 text-right font-semibold text-slate-800">{formatCurrency(item.total)}</td>
                  </tr>
                ))}
                {(project.items || []).length === 0 && (
                  <tr><td colSpan={4} className="p-4 text-center text-slate-400 italic">No items listed.</td></tr>
                )}
              </tbody>
            </table>
          )}

          <div className="border-t px-5 py-4 flex justify-between items-center bg-slate-50">
            <span className="font-semibold text-slate-600">Grand Total (incl. GST)</span>
            <span className="text-xl font-bold text-indigo-600">{formatCurrency(total)}</span>
          </div>
        </div>

        {/* Action Buttons — only shown if not yet responded */}
        <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm">
          <div className="text-sm text-slate-600 mb-5 text-center leading-relaxed">
            Please review the quotation above and confirm your acceptance or request changes.
          </div>
          <div className="flex gap-4">
            <button
              onClick={handleReject}
              disabled={processing}
              className="flex-1 rounded-xl border-2 border-slate-300 text-slate-600 py-3 font-bold hover:border-red-300 hover:text-red-600 hover:bg-red-50 transition disabled:opacity-50"
            >
              <span className="flex items-center justify-center gap-2">
                <XCircle size={18} /> Decline
              </span>
            </button>
            <button
              onClick={handleApprove}
              disabled={processing}
              className="flex-1 rounded-xl bg-green-600 text-white py-3 font-bold hover:bg-green-700 transition shadow-sm disabled:opacity-50"
            >
              <span className="flex items-center justify-center gap-2">
                <CheckCircle size={18} /> {processing ? 'Processing…' : 'Approve & Confirm'}
              </span>
            </button>
          </div>
          <div className="text-xs text-slate-400 text-center mt-3">
            By clicking "Approve &amp; Confirm", you accept this quotation and the project will be scheduled.
          </div>
        </div>

        {/* Org Footer */}
        {orgSettings && (
          <div className="text-center text-xs text-slate-400 pb-4 space-y-0.5">
            <div className="font-medium text-slate-500">{orgSettings.name}</div>
            {orgSettings.address && <div>{orgSettings.address}</div>}
            {orgSettings.email && <div>{orgSettings.email}</div>}
            {orgSettings.phone && <div>{orgSettings.phone}</div>}
          </div>
        )}
      </div>
    </div>
  );
};

export default QuoteApproval;
