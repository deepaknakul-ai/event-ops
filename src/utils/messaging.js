// Client-side messaging helpers.
//
// emailDocument() ships a generated jsPDF document to the sendDocumentEmail
// Cloud Function (which sends via the SMTP/API provider configured in
// settings/communication). whatsappShare() opens a prefilled wa.me chat —
// note WhatsApp deep links carry text only, not file attachments, so it
// sends a message + optional link today; the official API (later) can attach
// the PDF. Both are provider-agnostic entry points used by <SendMenu>.
import { getFunctions, httpsCallable } from 'firebase/functions';
import { appId } from './constants';

// jsPDF doc → bare base64 (no data: prefix).
export const pdfToBase64 = (pdfDoc) => {
  const uri = pdfDoc.output('datauristring');
  return (uri.split(',')[1]) || '';
};

export const emailDocument = async ({ pdfDoc, attachmentBase64, filename = 'document.pdf', to, cc, subject, html, text }) => {
  if (!to) throw new Error('Recipient email is required');
  const contentBase64 = attachmentBase64 || (pdfDoc ? pdfToBase64(pdfDoc) : null);
  const fn = httpsCallable(getFunctions(), 'sendDocumentEmail');
  const res = await fn({
    appId,
    to,
    cc: cc || undefined,
    subject,
    html: html || undefined,
    text: text || undefined,
    attachment: contentBase64 ? { filename, contentBase64, contentType: 'application/pdf' } : undefined,
  });
  return res.data;
};

// Build a wa.me URL and open it. Indian numbers default to +91 when a bare
// 10-digit number is supplied.
export const whatsappShare = ({ phone, message = '', link = '' }) => {
  const clean = String(phone || '').replace(/[^0-9]/g, '');
  const num = clean.length === 10 ? `91${clean}` : clean;
  const body = encodeURIComponent(`${message}${link ? `\n\n${link}` : ''}`);
  const base = num ? `https://wa.me/${num}` : 'https://wa.me/';
  window.open(`${base}?text=${body}`, '_blank', 'noopener,noreferrer');
};
