// Printable QR labels for inventory assets. Each QR encodes the inventory
// item id (or `id|serial` for serialised units) so the warehouse-scan flow can
// resolve a scan back to the asset. Reuses the bundled `qrcode` library.
import jsPDF from "jspdf";
import QRCode from "qrcode";

export const generateAssetLabelsPDF = async (items, { orgName = '' } = {}) => {
  const list = [];
  (items || []).forEach((it) => {
    if (it.is_composite) return; // labels are for physical units
    const serials = Array.isArray(it.serial_numbers) ? it.serial_numbers.filter(Boolean) : [];
    if (serials.length) {
      serials.forEach((sn) => list.push({ code: `${it.id}|${sn}`, name: it.name || '', sub: `SN: ${sn}`, cat: it.category || '' }));
    } else {
      const sub = it.asset_id ? `Asset: ${it.asset_id}` : (it.serial_number ? `SN: ${it.serial_number}` : (it.category || ''));
      list.push({ code: String(it.id), name: it.name || '', sub, cat: it.category || '' });
    }
  });
  if (!list.length) return { count: 0 };

  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageW = 210, pageH = 297, mX = 8, mY = 10, cols = 3, rows = 8;
  const cellW = (pageW - mX * 2) / cols;
  const cellH = (pageH - mY * 2) / rows;
  const per = cols * rows;

  for (let i = 0; i < list.length; i++) {
    const lab = list[i];
    const pos = i % per;
    if (i > 0 && pos === 0) doc.addPage();
    const c = pos % cols, r = Math.floor(pos / cols);
    const x = mX + c * cellW, y = mY + r * cellH;
    const qrUrl = await QRCode.toDataURL(String(lab.code), { margin: 0, width: 220 });
    const qrSize = Math.min(cellW, cellH) - 13;
    doc.setDrawColor(225); doc.roundedRect(x + 1, y + 1, cellW - 2, cellH - 2, 1.5, 1.5, 'S');
    doc.addImage(qrUrl, 'PNG', x + (cellW - qrSize) / 2, y + 2.5, qrSize, qrSize);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.setTextColor(20);
    const nameLines = doc.splitTextToSize(lab.name, cellW - 5).slice(0, 2);
    doc.text(nameLines, x + cellW / 2, y + qrSize + 4.5, { align: 'center' });
    if (lab.sub) { doc.setFont('helvetica', 'normal'); doc.setFontSize(5.6); doc.setTextColor(120); doc.text(doc.splitTextToSize(lab.sub, cellW - 5).slice(0, 1), x + cellW / 2, y + qrSize + 4.5 + nameLines.length * 2.8, { align: 'center' }); }
    doc.setTextColor(0);
  }
  doc.save(`Asset_QR_Labels${orgName ? '_' + orgName.replace(/\s+/g, '_') : ''}.pdf`);
  return { count: list.length };
};
