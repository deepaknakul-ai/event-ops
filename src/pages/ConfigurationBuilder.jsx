import React, { useState, useMemo, useRef, useEffect } from 'react';
import { confirmDialog } from '../utils/dialog';
import { collection, addDoc, updateDoc, deleteDoc, doc, getDoc } from 'firebase/firestore';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { Plus, Trash2, Edit, Save, X, Search, Copy, Package, Zap, Weight, Monitor, Layers, Volume2, Lightbulb, Speaker, Cpu, Cable, ChevronDown, ChevronUp, Printer } from 'lucide-react';
import { CATEGORIES } from '../utils/constants';
import { calculateWallSpecs, LEDTileModel } from '../utils/helpers';
import { can } from '../utils/permissions';

// Category grouping for intelligent analysis
const CATEGORY_GROUPS = {
  sound: { label: 'Sound / Audio', icon: Volume2, color: 'violet', match: ['Sound', 'Audio'] },
  lighting: { label: 'Lighting', icon: Lightbulb, color: 'amber', match: ['Lighting'] },
  video: { label: 'Video / LED / Projectors', icon: Monitor, color: 'indigo', match: ['Video', 'LED', 'LED Wall', 'Projectors', 'Camera'] },
  rigging: { label: 'Trussing & Rigging', icon: Layers, color: 'slate', match: ['Trussing', 'Rigging'] },
  power: { label: 'Power & Cabling', icon: Cable, color: 'red', match: ['Power', 'Cables'] },
  other: { label: 'Other / Accessories', icon: Package, color: 'gray', match: ['Accessories'] },
};

const getCategoryGroup = (cat) => {
  for (const [key, grp] of Object.entries(CATEGORY_GROUPS)) {
    if (grp.match.includes(cat)) return key;
  }
  return 'other';
};

const colorMap = {
  violet: { bg: 'bg-violet-50', border: 'border-violet-200', text: 'text-violet-700', badge: 'bg-violet-100 text-violet-700', iconBg: 'bg-violet-100 text-violet-600' },
  amber: { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-700', badge: 'bg-amber-100 text-amber-700', iconBg: 'bg-amber-100 text-amber-600' },
  indigo: { bg: 'bg-indigo-50', border: 'border-indigo-200', text: 'text-indigo-700', badge: 'bg-indigo-100 text-indigo-700', iconBg: 'bg-indigo-100 text-indigo-600' },
  slate: { bg: 'bg-slate-50', border: 'border-slate-200', text: 'text-slate-700', badge: 'bg-slate-100 text-slate-700', iconBg: 'bg-slate-100 text-slate-600' },
  red: { bg: 'bg-red-50', border: 'border-red-200', text: 'text-red-700', badge: 'bg-red-100 text-red-700', iconBg: 'bg-red-100 text-red-600' },
  gray: { bg: 'bg-gray-50', border: 'border-gray-200', text: 'text-gray-700', badge: 'bg-gray-100 text-gray-700', iconBg: 'bg-gray-100 text-gray-600' },
};

// Intelligent analysis of items by category group
const analyzeItems = (items) => {
  const groups = {};
  let grandTotalPower = 0, grandTotalWeight = 0, grandTotalQty = 0;
  items.forEach(item => {
    const grpKey = getCategoryGroup(item.category);
    if (!groups[grpKey]) groups[grpKey] = { items: [], totalPower: 0, totalWeight: 0, totalQty: 0, breakdown: {} };
    const grp = groups[grpKey];
    const qty = parseInt(item.qty) || 0;
    const wallQty = parseInt(item.wallQty) || 1;
    // LED items with led_specs already have total wall power/weight — multiply by wallQty only
    const isLedTotal = item.is_led && item.led_specs;
    const pw = isLedTotal ? (parseFloat(item.power_watts) || 0) * wallQty : (parseFloat(item.power_watts) || 0) * qty;
    const wt = isLedTotal ? (parseFloat(item.weight) || 0) * wallQty : (parseFloat(item.weight) || 0) * qty;
    const effectiveQty = isLedTotal ? qty * wallQty : qty;
    grp.items.push(item);
    grp.totalPower += pw;
    grp.totalWeight += wt;
    grp.totalQty += effectiveQty;
    grandTotalPower += pw;
    grandTotalWeight += wt;
    grandTotalQty += effectiveQty;
    const subKey = item.sub_category || item.attributes?.fixture_type || item.category || 'General';
    if (!grp.breakdown[subKey]) grp.breakdown[subKey] = { items: [], power: 0, weight: 0, qty: 0 };
    grp.breakdown[subKey].items.push(item);
    grp.breakdown[subKey].power += pw;
    grp.breakdown[subKey].weight += wt;
    grp.breakdown[subKey].qty += qty;
  });
  return { groups, grandTotalPower, grandTotalWeight, grandTotalQty };
};

// Get human-readable key specs for an item
const getKeySpecs = (item, grpKey) => {
  const parts = [];
  const a = item.attributes || {};
  if (grpKey === 'sound') {
    if (a.signal_type) parts.push(a.signal_type);
    if (a.frequency) parts.push(a.frequency);
    if (a.channels) parts.push(a.channels + 'ch');
    if (a.pattern) parts.push(a.pattern);
    if (item.connector_type) parts.push(item.connector_type);
  } else if (grpKey === 'lighting') {
    if (a.fixture_type) parts.push(a.fixture_type);
    if (a.beam_angle) parts.push(a.beam_angle);
    if (a.lamp_type) parts.push(a.lamp_type);
    if (a.dmx_mode) parts.push('DMX: ' + a.dmx_mode);
  } else if (grpKey === 'video') {
    if (a.resolution) parts.push(a.resolution);
    if (a.lumens) parts.push(a.lumens + ' lm');
    if (a.ratio) parts.push(a.ratio);
    if (a.inputs) parts.push(a.inputs);
    if (item.is_led && item.tilesWide && item.tilesHigh) parts.push(item.tilesWide + '\u00d7' + item.tilesHigh + ' tiles');
  } else if (grpKey === 'rigging') {
    if (a.truss_type) parts.push(a.truss_type);
    if (a.length) parts.push(a.length);
    if (a.load_capacity) parts.push('WLL: ' + a.load_capacity);
    if (a.connection) parts.push(a.connection);
  }
  if (item.dimensions) parts.push(item.dimensions);
  if (item.ip_rating) parts.push(item.ip_rating);
  return parts.join(' \u00b7 ');
};

// Sound department insights
const SoundInsights = ({ items }) => {
  const speakers = items.filter(i => {
    const nm = (i.item_name || '').toLowerCase();
    const sub = (i.sub_category || '').toLowerCase();
    return nm.includes('speaker') || nm.includes('sub') || nm.includes('monitor') || nm.includes('top') || nm.includes('line array') || sub.includes('speaker') || sub.includes('pa');
  });
  const speakerPower = speakers.reduce((s, i) => s + (parseFloat(i.power_watts) || 0) * (parseInt(i.qty) || 0), 0);
  const amps = items.filter(i => { const nm = (i.item_name || '').toLowerCase(); return nm.includes('amp') || nm.includes('amplifier'); });
  const ampPower = amps.reduce((s, i) => s + (parseFloat(i.power_watts) || 0) * (parseInt(i.qty) || 0), 0);
  const mixers = items.filter(i => (i.item_name || '').toLowerCase().includes('mixer') || (i.item_name || '').toLowerCase().includes('console'));
  const mics = items.filter(i => { const nm = (i.item_name || '').toLowerCase(); return nm.includes('mic') || nm.includes('microphone'); });
  const totalChannels = mics.reduce((s, i) => s + (parseInt(i.qty) || 0), 0);
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
      {speakers.length > 0 && (
        <div className="bg-violet-50 rounded-lg p-3 border border-violet-100">
          <div className="text-[10px] text-violet-500 font-bold uppercase">Speakers/Subs</div>
          <div className="font-bold text-violet-800">{speakers.reduce((s, i) => s + (parseInt(i.qty) || 0), 0)} units</div>
          <div className="text-xs text-violet-600">{speakerPower.toLocaleString()} W combined</div>
        </div>
      )}
      {amps.length > 0 && (
        <div className="bg-violet-50 rounded-lg p-3 border border-violet-100">
          <div className="text-[10px] text-violet-500 font-bold uppercase">Amplifiers</div>
          <div className="font-bold text-violet-800">{amps.reduce((s, i) => s + (parseInt(i.qty) || 0), 0)} units</div>
          <div className="text-xs text-violet-600">{ampPower.toLocaleString()} W total</div>
        </div>
      )}
      {mixers.length > 0 && (
        <div className="bg-violet-50 rounded-lg p-3 border border-violet-100">
          <div className="text-[10px] text-violet-500 font-bold uppercase">Mixing Console</div>
          <div className="font-bold text-violet-800">{mixers.map(m => m.item_name).join(', ')}</div>
          <div className="text-xs text-violet-600">{mixers.map(m => m.attributes?.channels ? m.attributes.channels + 'ch' : '').filter(Boolean).join(', ')}</div>
        </div>
      )}
      {mics.length > 0 && (
        <div className="bg-violet-50 rounded-lg p-3 border border-violet-100">
          <div className="text-[10px] text-violet-500 font-bold uppercase">Microphones</div>
          <div className="font-bold text-violet-800">{totalChannels} channels</div>
          <div className="text-xs text-violet-600">{mics.length} types</div>
        </div>
      )}
    </div>
  );
};

// Lighting department insights
const LightingInsights = ({ items }) => {
  const byFixture = {};
  items.forEach(item => {
    const fType = item.attributes?.fixture_type || item.sub_category || 'General';
    if (!byFixture[fType]) byFixture[fType] = { qty: 0, power: 0, items: [] };
    const qty = parseInt(item.qty) || 0;
    byFixture[fType].qty += qty;
    byFixture[fType].power += (parseFloat(item.power_watts) || 0) * qty;
    byFixture[fType].items.push(item);
  });
  return (
    <div className="mb-3">
      <div className="text-xs font-bold text-amber-700 uppercase mb-2">Lighting Breakdown by Type</div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        {Object.entries(byFixture).map(([fType, data]) => (
          <div key={fType} className="bg-amber-50 rounded-lg p-3 border border-amber-100">
            <div className="text-[10px] text-amber-500 font-bold uppercase">{fType}</div>
            <div className="font-bold text-amber-800">{data.qty} fixtures</div>
            <div className="text-xs text-amber-600">{data.power.toLocaleString()} W total</div>
            <div className="text-[10px] text-amber-400 mt-0.5">{data.items.map(i => i.item_name + ' \u00d7' + i.qty).join(', ')}</div>
          </div>
        ))}
      </div>
    </div>
  );
};

// Video / LED / Projector insights
const VideoInsights = ({ items }) => {
  const ledItems = items.filter(i => ['LED', 'LED Wall'].includes(i.category));
  const projectors = items.filter(i => i.category === 'Projectors');
  const cameras = items.filter(i => i.category === 'Camera');
  const screens = items.filter(i => { const nm = (i.item_name || '').toLowerCase(); return nm.includes('screen') || nm.includes('display') || nm.includes('tv') || nm.includes('monitor'); });
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
      {ledItems.map((item, idx) => {
        const specs = item.led_specs;
        return (
          <div key={idx} className="bg-indigo-50 rounded-lg p-3 border border-indigo-100 col-span-2">
            <div className="text-[10px] text-indigo-500 font-bold uppercase">LED Wall {'\u2014'} {item.item_name}</div>
            {specs ? (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-1">
                {specs.physicalDimensions && <div><div className="text-[10px] text-indigo-400">Size</div><div className="font-bold text-indigo-800 text-sm">{specs.physicalDimensions.totalWidthM}m {'\u00d7'} {specs.physicalDimensions.totalHeightM}m</div></div>}
                {specs.resolution && <div><div className="text-[10px] text-indigo-400">Resolution</div><div className="font-bold text-indigo-800 text-sm">{specs.resolution.totalPixelWidth} {'\u00d7'} {specs.resolution.totalPixelHeight}</div></div>}
                {specs.power && <div><div className="text-[10px] text-indigo-400">Max Power</div><div className="font-bold text-indigo-800 text-sm">{specs.power.maxPowerWatts?.toLocaleString()} W</div></div>}
                {specs.wallConfiguration && <div><div className="text-[10px] text-indigo-400">Tiles</div><div className="font-bold text-indigo-800 text-sm">{specs.wallConfiguration.tilesWide} {'\u00d7'} {specs.wallConfiguration.tilesHigh} = {specs.logistics?.totalTilesNeeded}</div></div>}
                {specs.physicalDimensions?.totalWeightKg && <div><div className="text-[10px] text-indigo-400">Weight</div><div className="font-bold text-indigo-800 text-sm">{specs.physicalDimensions.totalWeightKg} kg</div></div>}
                {specs.resolution?.pixelDensity && <div><div className="text-[10px] text-indigo-400">Pixel Pitch</div><div className="font-bold text-indigo-800 text-sm">{specs.resolution.pixelDensity}</div></div>}
              </div>
            ) : (
              <div className="mt-1">
                <div className="font-bold text-indigo-800">{item.qty} panels {'\u00d7'} {item.power_watts || '?'}W</div>
                {item.attributes?.resolution && <div className="text-xs text-indigo-600">Resolution: {item.attributes.resolution}</div>}
                {item.attributes?.ratio && <div className="text-xs text-indigo-600">Pitch: {item.attributes.ratio}</div>}
              </div>
            )}
          </div>
        );
      })}
      {projectors.length > 0 && (
        <div className="bg-indigo-50 rounded-lg p-3 border border-indigo-100">
          <div className="text-[10px] text-indigo-500 font-bold uppercase">Projectors</div>
          {projectors.map((p, i) => (<div key={i} className="mt-1"><div className="font-medium text-indigo-800 text-xs">{p.item_name} {'\u00d7'}{p.qty}</div><div className="text-[10px] text-indigo-500">{[p.attributes?.lumens && (p.attributes.lumens + ' lm'), p.attributes?.resolution, p.attributes?.ratio && ('Throw: ' + p.attributes.ratio)].filter(Boolean).join(' \u00b7 ')}</div></div>))}
        </div>
      )}
      {cameras.length > 0 && (
        <div className="bg-indigo-50 rounded-lg p-3 border border-indigo-100">
          <div className="text-[10px] text-indigo-500 font-bold uppercase">Cameras</div>
          {cameras.map((c, i) => (<div key={i} className="mt-1"><div className="font-medium text-indigo-800 text-xs">{c.item_name} {'\u00d7'}{c.qty}</div><div className="text-[10px] text-indigo-500">{[c.attributes?.resolution, c.attributes?.inputs].filter(Boolean).join(' \u00b7 ')}</div></div>))}
        </div>
      )}
      {screens.length > 0 && (
        <div className="bg-indigo-50 rounded-lg p-3 border border-indigo-100">
          <div className="text-[10px] text-indigo-500 font-bold uppercase">Screens / Displays</div>
          {screens.map((s, i) => (<div key={i} className="mt-1"><div className="font-medium text-indigo-800 text-xs">{s.item_name} {'\u00d7'}{s.qty}</div><div className="text-[10px] text-indigo-500">{s.dimensions || ''} {s.attributes?.resolution || ''}</div></div>))}
        </div>
      )}
    </div>
  );
};

// Rigging insights
const RiggingInsights = ({ items }) => {
  const byType = {};
  items.forEach(item => {
    const t = item.attributes?.truss_type || item.sub_category || 'General';
    if (!byType[t]) byType[t] = { qty: 0, weight: 0, items: [] };
    const qty = parseInt(item.qty) || 0;
    byType[t].qty += qty;
    byType[t].weight += (parseFloat(item.weight) || 0) * qty;
    byType[t].items.push(item);
  });
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-3">
      {Object.entries(byType).map(([type, data]) => (
        <div key={type} className="bg-slate-50 rounded-lg p-3 border border-slate-200">
          <div className="text-[10px] text-slate-400 font-bold uppercase">{type}</div>
          <div className="font-bold text-slate-800">{data.qty} pcs</div>
          <div className="text-xs text-slate-600">{data.weight.toFixed(1)} kg</div>
          {data.items.some(i => i.attributes?.load_capacity) && <div className="text-[10px] text-slate-400 mt-0.5">WLL: {data.items.map(i => i.attributes?.load_capacity).filter(Boolean).join(', ')}</div>}
        </div>
      ))}
    </div>
  );
};

// Power / cabling insights with grand total
const PowerInsights = ({ items, config }) => {
  const analysis = config ? analyzeItems(config.items || []) : null;
  return (
    <div className="mb-3">
      {analysis && (
        <div className="bg-red-50 rounded-lg p-3 border border-red-100 mb-2">
          <div className="text-[10px] text-red-500 font-bold uppercase">Full Config Power Draw</div>
          <div className="font-bold text-red-800">{analysis.grandTotalPower.toLocaleString()} W</div>
          <div className="text-xs text-red-600">{'\u2248'} {(analysis.grandTotalPower / 230).toFixed(1)} A @ 230V {'\u00b7'} {'\u2248'} {(analysis.grandTotalPower / 1000).toFixed(1)} kW</div>
        </div>
      )}
    </div>
  );
};

// Group analysis card
const GroupAnalysisCard = ({ grpKey, grp, config }) => {
  const meta = CATEGORY_GROUPS[grpKey] || CATEGORY_GROUPS.other;
  const cm = colorMap[meta.color] || colorMap.gray;
  const Icon = meta.icon;
  const [expanded, setExpanded] = useState(true);
  return (
    <div className={'rounded-xl border ' + cm.border + ' ' + cm.bg + ' overflow-hidden'}>
      <button className="w-full px-5 py-3 flex items-center justify-between" onClick={() => setExpanded(e => !e)}>
        <div className="flex items-center gap-3">
          <div className={'p-2 rounded-lg ' + cm.iconBg}><Icon size={18} /></div>
          <div className="text-left">
            <div className={'font-bold text-sm ' + cm.text}>{meta.label}</div>
            <div className="text-xs text-slate-500">{grp.items.length} line items {'\u00b7'} {grp.totalQty} units</div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right"><div className="text-xs text-slate-500">Power</div><div className={'font-bold text-sm ' + cm.text}>{grp.totalPower.toLocaleString()} W</div></div>
          <div className="text-right"><div className="text-xs text-slate-500">Weight</div><div className={'font-bold text-sm ' + cm.text}>{grp.totalWeight.toFixed(1)} kg</div></div>
          {expanded ? <ChevronUp size={16} className="text-slate-400" /> : <ChevronDown size={16} className="text-slate-400" />}
        </div>
      </button>
      {expanded && (
        <div className="border-t px-5 py-4 space-y-4 bg-white/60">
          {grpKey === 'sound' && <SoundInsights items={grp.items} />}
          {grpKey === 'lighting' && <LightingInsights items={grp.items} breakdown={grp.breakdown} />}
          {grpKey === 'video' && <VideoInsights items={grp.items} />}
          {grpKey === 'rigging' && <RiggingInsights items={grp.items} />}
          {grpKey === 'power' && <PowerInsights items={grp.items} config={config} />}
          <div className="overflow-x-auto"><table className="w-full text-xs">
            <thead className="text-slate-500 uppercase border-b">
              <tr>
                <th className="text-left py-1.5 pr-2">Item</th>
                <th className="text-left py-1.5">Brand</th>
                <th className="text-center py-1.5">Qty</th>
                <th className="text-right py-1.5">Unit Power</th>
                <th className="text-right py-1.5">Total W</th>
                <th className="text-right py-1.5">kW</th>
                <th className="text-right py-1.5">Amps</th>
                <th className="text-right py-1.5">Unit Wt</th>
                <th className="text-right py-1.5">Total Wt</th>
                <th className="text-left py-1.5 pl-2">Key Specs</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {grp.items.map((item, idx) => {
                const qty = parseInt(item.qty) || 0;
                const wallQty = parseInt(item.wallQty) || 1;
                const specs = getKeySpecs(item, grpKey);
                const isLedT = item.is_led && item.led_specs;
                const unitPw = isLedT ? (item.tileModelData?.power?.maxPower || (qty > 0 ? parseFloat(item.power_watts) / qty : 0)) : parseFloat(item.power_watts) || 0;
                const totalPw = isLedT ? (parseFloat(item.power_watts) || 0) * wallQty : unitPw * qty;
                const unitWt = isLedT ? (item.tileModelData?.weight || (qty > 0 ? parseFloat(item.weight) / qty : 0)) : parseFloat(item.weight) || 0;
                const totalWt = isLedT ? (parseFloat(item.weight) || 0) * wallQty : unitWt * qty;
                const displayQty = isLedT ? qty * wallQty : qty;
                return (
                  <tr key={item.id || idx} className="hover:bg-white/80">
                    <td className="py-1.5 pr-2 font-medium text-slate-800">
                      {item.item_name}
                      {isLedT && wallQty > 1 && <span className="ml-1 text-[10px] bg-indigo-100 text-indigo-600 px-1 rounded">{wallQty} walls</span>}
                    </td>
                    <td className="py-1.5 text-slate-500">{item.brand || '\u2014'}</td>
                    <td className="py-1.5 text-center font-semibold">{displayQty}{isLedT && wallQty > 1 ? <span className="text-[10px] text-slate-400 ml-0.5">({qty}&times;{wallQty})</span> : ''}</td>
                    <td className="py-1.5 text-right text-amber-700">{unitPw ? unitPw.toLocaleString() + 'W' : '\u2014'}</td>
                    <td className="py-1.5 text-right font-semibold text-amber-700">{totalPw ? totalPw.toLocaleString() + 'W' : '\u2014'}</td>
                    <td className="py-1.5 text-right text-amber-600">{totalPw ? (totalPw / 1000).toFixed(2) : '\u2014'}</td>
                    <td className="py-1.5 text-right text-red-600">{totalPw ? (totalPw / 230).toFixed(1) + 'A' : '\u2014'}</td>
                    <td className="py-1.5 text-right text-emerald-700">{unitWt ? unitWt.toFixed(1) + 'kg' : '\u2014'}</td>
                    <td className="py-1.5 text-right font-semibold text-emerald-700">{totalWt ? totalWt.toFixed(1) + 'kg' : '\u2014'}</td>
                    <td className="py-1.5 pl-2 text-slate-500 max-w-[200px] truncate">{specs || '\u2014'}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="font-bold border-t text-xs">
              <tr>
                <td className="py-1.5" colSpan={2}>Group Total</td>
                <td className="py-1.5 text-center">{grp.totalQty}</td>
                <td className="py-1.5"></td>
                <td className={'py-1.5 text-right ' + cm.text}>{grp.totalPower.toLocaleString()} W</td>
                <td className={'py-1.5 text-right ' + cm.text}>{(grp.totalPower / 1000).toFixed(2)} kW</td>
                <td className="py-1.5 text-right text-red-600 font-bold">{(grp.totalPower / 230).toFixed(1)} A</td>
                <td className="py-1.5"></td>
                <td className={'py-1.5 text-right ' + cm.text}>{grp.totalWeight.toFixed(1)} kg</td>
                <td></td>
              </tr>
            </tfoot>
          </table></div>
        </div>
      )}
    </div>
  );
};

// MAIN COMPONENT
const ConfigurationBuilder = ({ configurations = [], inventory = [], clients = [], role, db, appId, logAction, addToast, categories = CATEGORIES }) => {
  const [viewMode, setViewMode] = useState('list');
  const [editingId, setEditingId] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterClient, setFilterClient] = useState('');

  const initialForm = {
    config_name: '', client_id: '', client_name: '', description: '', venue: '', event_type: '',
    items: [], notes: '',
  };
  const [form, setForm] = useState({ ...initialForm });

  const [showItemModal, setShowItemModal] = useState(false);
  const [editingItemIdx, setEditingItemIdx] = useState(null);
  const [itemSearch, setItemSearch] = useState('');
  const [itemCategoryFilter, setItemCategoryFilter] = useState('');
  const [showItemDropdown, setShowItemDropdown] = useState(false);
  const [itemForm, setItemForm] = useState({
    item_id: '', item_name: '', brand: '', category: '', sub_category: '', qty: 1,
    power_watts: '', current_amps: '', weight: '', dimensions: '',
    connector_type: '', ip_rating: '', remarks: '', specifications: '',
    attributes: {},
    is_led: false, tilesWide: 0, tilesHigh: 0, tileModelData: null,
  });
  const itemDropdownRef = useRef(null);

  const [clientSearch, setClientSearch] = useState('');
  const [showClientDropdown, setShowClientDropdown] = useState(false);
  const clientDropdownRef = useRef(null);
  const [selectedConfig, setSelectedConfig] = useState(null);

  useEffect(() => {
    const handler = (e) => {
      if (itemDropdownRef.current && !itemDropdownRef.current.contains(e.target)) setShowItemDropdown(false);
      if (clientDropdownRef.current && !clientDropdownRef.current.contains(e.target)) setShowClientDropdown(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const filteredConfigs = useMemo(() => {
    let list = [...configurations];
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(c => c.config_name?.toLowerCase().includes(q) || c.client_name?.toLowerCase().includes(q) || c.venue?.toLowerCase().includes(q));
    }
    if (filterClient) list = list.filter(c => c.client_id === filterClient);
    return list.sort((a, b) => (b.updated_at || b.created_at || '').localeCompare(a.updated_at || a.created_at || ''));
  }, [configurations, searchQuery, filterClient]);

  const filteredInventory = useMemo(() => {
    let items = inventory.filter(i => i.status !== 'Retired');
    if (itemCategoryFilter) items = items.filter(i => i.category === itemCategoryFilter);
    if (itemSearch) {
      const q = itemSearch.toLowerCase();
      items = items.filter(i => i.name?.toLowerCase().includes(q) || i.category?.toLowerCase().includes(q) || i.brand?.toLowerCase().includes(q));
    }
    return items;
  }, [inventory, itemCategoryFilter, itemSearch]);

  const analysis = useMemo(() => analyzeItems(form.items), [form.items]);

  const resetForm = () => { setForm({ ...initialForm, items: [] }); setEditingId(null); setClientSearch(''); };
  const openNewConfig = () => { resetForm(); setViewMode('form'); };

  const openEditConfig = (config) => {
    setForm({
      config_name: config.config_name || '', client_id: config.client_id || '', client_name: config.client_name || '',
      description: config.description || '', venue: config.venue || '', event_type: config.event_type || '',
      items: config.items || [], notes: config.notes || '',
    });
    setClientSearch(config.client_name || '');
    setEditingId(config.id);
    setViewMode('form');
  };

  const openDetailView = (config) => { setSelectedConfig(config); setViewMode('detail'); };

  const duplicateConfig = (config) => {
    setForm({
      config_name: (config.config_name || '') + ' (Copy)', client_id: config.client_id || '', client_name: config.client_name || '',
      description: config.description || '', venue: config.venue || '', event_type: config.event_type || '',
      items: (config.items || []).map(i => ({ ...i, id: Date.now().toString() + Math.random().toString(36).slice(2, 6) })),
      notes: config.notes || '',
    });
    setClientSearch(config.client_name || '');
    setEditingId(null);
    setViewMode('form');
  };

  const handleSelectClient = (client) => {
    setForm({ ...form, client_id: client.id, client_name: client.name });
    setClientSearch(client.name);
    setShowClientDropdown(false);
  };

  const openItemModal = (idx = null) => {
    if (idx !== null) {
      const item = form.items[idx];
      setItemForm({ ...item });
      setEditingItemIdx(idx);
      setItemSearch(item.item_name || '');
    } else {
      setItemForm({
        item_id: '', item_name: '', brand: '', category: '', sub_category: '', qty: 1,
        power_watts: '', current_amps: '', weight: '', dimensions: '',
        connector_type: '', ip_rating: '', remarks: '', specifications: '',
        attributes: {},
        is_led: false, tilesWide: 0, tilesHigh: 0, wallQty: 1, tileModelData: null,
      });
      setEditingItemIdx(null);
      setItemSearch('');
    }
    setItemCategoryFilter('');
    setShowItemModal(true);
  };

  const handleSelectInventoryItem = (invItem) => {
    setItemForm(prev => ({
      ...prev,
      item_id: invItem.id,
      item_name: invItem.name,
      brand: invItem.brand || '',
      category: invItem.category || '',
      sub_category: invItem.sub_category || '',
      power_watts: invItem.power_watts || '',
      current_amps: invItem.current_amps || '',
      weight: invItem.weight || '',
      dimensions: invItem.dimensions || '',
      connector_type: invItem.connector_type || '',
      ip_rating: invItem.ip_rating || '',
      specifications: invItem.specifications || '',
      attributes: invItem.attributes ? { ...invItem.attributes } : {},
      is_led: ['LED Wall', 'LED'].includes(invItem.category),
      tileModelData: invItem.tile_model || null,
    }));
    setItemSearch(invItem.name);
    setShowItemDropdown(false);
  };

  const handleSaveItem = () => {
    if (!itemForm.item_name) { addToast('Select an inventory item', 'error'); return; }
    if (!itemForm.qty || parseInt(itemForm.qty) < 1) { addToast('Quantity must be at least 1', 'error'); return; }
    const newItem = {
      ...itemForm,
      id: editingItemIdx !== null ? form.items[editingItemIdx].id : Date.now().toString(),
      qty: parseInt(itemForm.qty) || 1,
    };
    if (newItem.is_led && newItem.tileModelData && newItem.tilesWide > 0 && newItem.tilesHigh > 0) {
      try {
        const td = newItem.tileModelData;
        const invItem = inventory.find(i => i.id === newItem.item_id);
        const tileModel = new LEDTileModel({
          modelName: td.modelName || td.name || newItem.item_name,
          dimensions: td.dimensions || td.dim || { width: td.width_mm || 0, height: td.height_mm || 0, depth: td.depth_mm || 0 },
          pixelPitch: td.pixelPitch || td.pixel_pitch || td.pitch || 0,
          resolution: td.resolution || { pixelWidth: td.pixelWidth || 0, pixelHeight: td.pixelHeight || 0 },
          power: td.power || td.powerSpecs || { maxPower: td.maxPower || 0, avgPower: td.avgPower || 0 },
          weight: td.weight || td.weightKg || invItem?.weight || 0,
          inventory: td.inventory || { totalTiles: invItem?.total || 0, tilesPerCase: td.tilesPerCase || invItem?.tiles_per_case || 1 }
        });
        const specs = calculateWallSpecs(tileModel, parseInt(newItem.tilesWide), parseInt(newItem.tilesHigh), 230);
        if (specs) {
          newItem.led_specs = specs;
          newItem.power_watts = specs.power?.maxPowerWatts || newItem.power_watts;
          newItem.weight = specs.physicalDimensions?.totalWeightKg || newItem.weight;
          newItem.qty = specs.logistics?.totalTilesNeeded || (parseInt(newItem.tilesWide) * parseInt(newItem.tilesHigh));
        }
      } catch (err) { console.warn('LED wall spec calculation skipped:', err.message); }
    }
    const updatedItems = [...form.items];
    if (editingItemIdx !== null) { updatedItems[editingItemIdx] = newItem; } else { updatedItems.push(newItem); }
    setForm({ ...form, items: updatedItems });
    setShowItemModal(false);
  };

  const handleRemoveItem = (idx) => { setForm({ ...form, items: form.items.filter((_, i) => i !== idx) }); };

  // ---------- PDF PRINT ----------
  const printConfigPDF = async (config) => {
    try {
      const pdfDoc = new jsPDF();
      const pw = pdfDoc.internal.pageSize.width;
      const ph = pdfDoc.internal.pageSize.height;
      let y = 15;

      // Org settings
      let org = {};
      try {
        const snap = await getDoc(doc(db, 'artifacts', appId, 'public', 'data', 'settings', 'organization'));
        org = snap.data() || {};
      } catch (_) { /* ignore */ }

      // --- Header ---
      if (org.logo) { try { pdfDoc.addImage(org.logo, 'JPEG', 14, 10, 22, 22); } catch (_) {} }
      pdfDoc.setFontSize(15); pdfDoc.setFont('helvetica', 'bold');
      pdfDoc.text(org.name || 'RENTAL OPS', org.logo ? 40 : 14, 20);
      pdfDoc.setFontSize(8); pdfDoc.setFont('helvetica', 'normal');
      if (org.address) { const al = pdfDoc.splitTextToSize(org.address, 100); pdfDoc.text(al, org.logo ? 40 : 14, 25); }
      if (org.gstin) pdfDoc.text('GSTIN: ' + org.gstin, org.logo ? 40 : 14, org.address ? 33 : 25);

      pdfDoc.setFontSize(13); pdfDoc.setFont('helvetica', 'bold');
      pdfDoc.text('EQUIPMENT CONFIGURATION', pw - 14, 20, { align: 'right' });
      pdfDoc.setFontSize(8); pdfDoc.setFont('helvetica', 'normal');
      pdfDoc.text('Technical Specification Sheet', pw - 14, 25, { align: 'right' });
      pdfDoc.text('Date: ' + new Date().toLocaleDateString('en-IN'), pw - 14, 30, { align: 'right' });

      y = 40;
      pdfDoc.setLineWidth(0.5); pdfDoc.line(14, y, pw - 14, y); y += 6;

      // --- Config & Client Info ---
      pdfDoc.setFontSize(10); pdfDoc.setFont('helvetica', 'bold');
      pdfDoc.text('Configuration: ' + (config.config_name || '-'), 14, y);
      y += 5;
      pdfDoc.setFont('helvetica', 'normal'); pdfDoc.setFontSize(9);
      if (config.client_name) { pdfDoc.text('Client: ' + config.client_name, 14, y); y += 4; }
      if (config.venue) { pdfDoc.text('Venue: ' + config.venue, 14, y); y += 4; }
      if (config.event_type) { pdfDoc.text('Event Type: ' + config.event_type, 14, y); y += 4; }
      if (config.description) { const dl = pdfDoc.splitTextToSize('Description: ' + config.description, pw - 28); pdfDoc.text(dl, 14, y); y += dl.length * 4; }
      y += 4;

      // --- Analysis ---
      const a = analyzeItems(config.items || []);

      // --- Grand totals summary box ---
      pdfDoc.setFillColor(245, 245, 250);
      pdfDoc.roundedRect(14, y, pw - 28, 16, 2, 2, 'F');
      pdfDoc.setFontSize(9); pdfDoc.setFont('helvetica', 'bold');
      const summaryY = y + 6;
      pdfDoc.text('Total Items: ' + a.grandTotalQty, 18, summaryY);
      pdfDoc.text('Total Power: ' + a.grandTotalPower.toLocaleString() + ' W (' + (a.grandTotalPower / 1000).toFixed(1) + ' kW)', 65, summaryY);
      pdfDoc.text('Current: ' + (a.grandTotalPower / 230).toFixed(1) + ' A @ 230V', 145, summaryY);
      pdfDoc.text('Weight: ' + a.grandTotalWeight.toFixed(1) + ' kg', 18, summaryY + 6);
      pdfDoc.text('Est. Circuits: ~' + Math.ceil(a.grandTotalPower / 3000) + ' x 16A', 65, summaryY + 6);
      pdfDoc.text('Line Items: ' + (config.items || []).length, 145, summaryY + 6);
      y += 22;

      // --- Category-wise Equipment Tables ---
      const groupOrder = ['sound', 'lighting', 'video', 'rigging', 'power', 'other'];
      const groupLabels = { sound: 'SOUND', lighting: 'LIGHTING', video: 'VIDEO / LED', rigging: 'RIGGING & TRUSS', power: 'POWER DISTRIBUTION', other: 'OTHER EQUIPMENT' };

      for (const grpKey of groupOrder) {
        const grp = a.groups[grpKey];
        if (!grp) continue;

        // Check page space
        if (y > ph - 50) { pdfDoc.addPage(); y = 15; }

        // Group header
        pdfDoc.setFontSize(10); pdfDoc.setFont('helvetica', 'bold');
        pdfDoc.setFillColor(grpKey === 'sound' ? 59 : grpKey === 'lighting' ? 234 : grpKey === 'video' ? 99 : grpKey === 'rigging' ? 107 : grpKey === 'power' ? 239 : 107,
                             grpKey === 'sound' ? 130 : grpKey === 'lighting' ? 179 : grpKey === 'video' ? 102 : grpKey === 'rigging' ? 114 : grpKey === 'power' ? 68 : 114,
                             grpKey === 'sound' ? 246 : grpKey === 'lighting' ? 8 : grpKey === 'video' ? 241 : grpKey === 'rigging' ? 128 : grpKey === 'power' ? 68 : 128);
        pdfDoc.roundedRect(14, y, pw - 28, 8, 1, 1, 'F');
        pdfDoc.setTextColor(255, 255, 255);
        pdfDoc.text(groupLabels[grpKey] || grpKey.toUpperCase(), 18, y + 5.5);
        pdfDoc.text(grp.totalPower.toLocaleString() + ' W | ' + grp.totalWeight.toFixed(1) + ' kg | ' + grp.totalQty + ' units', pw - 18, y + 5.5, { align: 'right' });
        pdfDoc.setTextColor(0, 0, 0);
        y += 10;

        // Build table rows
        const rows = grp.items.map((item, idx) => {
          const qty = parseInt(item.qty) || 0;
          const wallQty = parseInt(item.wallQty) || 1;
          const isLed = item.is_led && item.led_specs;
          const unitPw = isLed ? (item.tileModelData?.power?.maxPower || (qty > 0 ? parseFloat(item.power_watts) / qty : 0)) : parseFloat(item.power_watts) || 0;
          const totalPw = isLed ? (parseFloat(item.power_watts) || 0) * wallQty : unitPw * qty;
          const displayQty = isLed ? qty * wallQty : qty;
          const totalWt = isLed ? (parseFloat(item.weight) || 0) * wallQty : (parseFloat(item.weight) || 0) * qty;
          const specs = getKeySpecs(item, grpKey);

          // Build resolution/LED info string
          let resInfo = '';
          if (isLed && item.led_specs) {
            const ls = item.led_specs;
            const parts = [];
            if (ls.resolution) parts.push((ls.resolution.totalPixelWidth || 0) + 'x' + (ls.resolution.totalPixelHeight || 0) + 'px');
            if (ls.resolution?.pixelDensity) parts.push('PP: ' + ls.resolution.pixelDensity);
            if (ls.physicalDimensions) parts.push((ls.physicalDimensions.totalWidthM || 0) + 'x' + (ls.physicalDimensions.totalHeightM || 0) + 'm');
            if (item.tilesWide && item.tilesHigh) parts.push(item.tilesWide + 'x' + item.tilesHigh + ' tiles');
            if (wallQty > 1) parts.push(wallQty + ' walls');
            resInfo = parts.join(' | ');
          } else if (item.attributes?.resolution) {
            resInfo = item.attributes.resolution;
          }

          return [
            idx + 1,
            (item.item_name || '') + (item.brand ? ' (' + item.brand + ')' : '') + (isLed ? ' [LED]' : ''),
            displayQty + (isLed && wallQty > 1 ? ' (' + qty + 'x' + wallQty + ')' : ''),
            unitPw ? unitPw.toLocaleString() : '-',
            totalPw ? totalPw.toLocaleString() : '-',
            totalPw ? (totalPw / 1000).toFixed(2) : '-',
            totalPw ? (totalPw / 230).toFixed(1) : '-',
            totalWt ? totalWt.toFixed(1) : '-',
            resInfo || specs || '-',
          ];
        });

        // Footer row
        rows.push([
          { content: 'GROUP TOTAL', colSpan: 2, styles: { fontStyle: 'bold', fillColor: [240, 240, 245] } },
          { content: String(grp.totalQty), styles: { fontStyle: 'bold', fillColor: [240, 240, 245], halign: 'center' } },
          { content: '', styles: { fillColor: [240, 240, 245] } },
          { content: grp.totalPower.toLocaleString(), styles: { fontStyle: 'bold', fillColor: [240, 240, 245], halign: 'right' } },
          { content: (grp.totalPower / 1000).toFixed(2), styles: { fontStyle: 'bold', fillColor: [240, 240, 245], halign: 'right' } },
          { content: (grp.totalPower / 230).toFixed(1), styles: { fontStyle: 'bold', fillColor: [240, 240, 245], halign: 'right' } },
          { content: grp.totalWeight.toFixed(1), styles: { fontStyle: 'bold', fillColor: [240, 240, 245], halign: 'right' } },
          { content: '', styles: { fillColor: [240, 240, 245] } },
        ]);

        autoTable(pdfDoc, {
          startY: y,
          head: [['#', 'Item', 'Qty', 'Unit W', 'Total W', 'kW', 'Amps', 'Wt (kg)', 'Resolution / Specs']],
          body: rows,
          theme: 'grid',
          margin: { left: 14, right: 14 },
          styles: { fontSize: 7, cellPadding: 1.5, overflow: 'linebreak' },
          headStyles: { fillColor: [60, 60, 70], textColor: 255, fontSize: 7 },
          columnStyles: {
            0: { cellWidth: 7, halign: 'center' },
            1: { cellWidth: 42 },
            2: { cellWidth: 14, halign: 'center' },
            3: { cellWidth: 14, halign: 'right' },
            4: { cellWidth: 16, halign: 'right' },
            5: { cellWidth: 12, halign: 'right' },
            6: { cellWidth: 12, halign: 'right' },
            7: { cellWidth: 14, halign: 'right' },
            8: { cellWidth: 51 },
          },
        });
        y = (pdfDoc.lastAutoTable?.finalY || y + 30) + 6;
      }

      // --- LED Wall Details Section ---
      const ledItems = (config.items || []).filter(i => i.is_led && i.led_specs);
      if (ledItems.length > 0) {
        if (y > ph - 60) { pdfDoc.addPage(); y = 15; }

        pdfDoc.setFontSize(11); pdfDoc.setFont('helvetica', 'bold');
        pdfDoc.text('LED WALL SPECIFICATIONS', 14, y); y += 6;

        ledItems.forEach(item => {
          if (y > ph - 40) { pdfDoc.addPage(); y = 15; }
          const ls = item.led_specs;
          const wallQty = parseInt(item.wallQty) || 1;
          pdfDoc.setFontSize(9); pdfDoc.setFont('helvetica', 'bold');
          pdfDoc.text(item.item_name + (item.brand ? ' (' + item.brand + ')' : '') + (wallQty > 1 ? '  x' + wallQty + ' walls' : ''), 14, y); y += 5;
          pdfDoc.setFont('helvetica', 'normal'); pdfDoc.setFontSize(8);

          const details = [];
          if (item.tilesWide && item.tilesHigh) details.push(['Wall Layout', item.tilesWide + ' x ' + item.tilesHigh + ' tiles']);
          if (ls.logistics?.totalTilesNeeded) details.push(['Tiles per Wall', String(ls.logistics.totalTilesNeeded)]);
          if (wallQty > 1) details.push(['Total Tiles', String(ls.logistics.totalTilesNeeded * wallQty)]);
          if (ls.physicalDimensions) {
            details.push(['Physical Size', ls.physicalDimensions.totalWidthM + ' x ' + ls.physicalDimensions.totalHeightM + ' m']);
          }
          if (ls.resolution) {
            details.push(['Resolution', (ls.resolution.totalPixelWidth || 0) + ' x ' + (ls.resolution.totalPixelHeight || 0) + ' pixels']);
            if (ls.resolution.pixelDensity) details.push(['Pixel Pitch', ls.resolution.pixelDensity]);
          }
          if (ls.power) {
            const mp = ls.power.maxPowerWatts || 0;
            details.push(['Max Power (per wall)', mp.toLocaleString() + ' W (' + (mp / 1000).toFixed(2) + ' kW)']);
            if (wallQty > 1) details.push(['Total Power (' + wallQty + ' walls)', (mp * wallQty).toLocaleString() + ' W (' + (mp * wallQty / 1000).toFixed(2) + ' kW)']);
            details.push(['Max Current', (ls.power.maxAmpsAt230V || 0) + ' A' + (wallQty > 1 ? ' (total: ' + (ls.power.maxAmpsAt230V * wallQty).toFixed(1) + ' A)' : '')]);
            if (ls.power.avgPowerWatts) details.push(['Avg Power', ls.power.avgPowerWatts.toLocaleString() + ' W (' + (ls.power.avgAmpsAt230V || 0) + ' A)']);
          }
          if (ls.physicalDimensions?.totalWeightKg) {
            details.push(['Weight (per wall)', ls.physicalDimensions.totalWeightKg + ' kg']);
            if (wallQty > 1) details.push(['Total Weight', (ls.physicalDimensions.totalWeightKg * wallQty).toFixed(1) + ' kg']);
          }
          if (ls.logistics?.totalFlightCasesNeeded) {
            details.push(['Flight Cases (per wall)', String(ls.logistics.totalFlightCasesNeeded)]);
            if (wallQty > 1) details.push(['Total Flight Cases', String(ls.logistics.totalFlightCasesNeeded * wallQty)]);
          }

          autoTable(pdfDoc, {
            startY: y,
            body: details.map(([k, v]) => [k, v]),
            theme: 'plain',
            margin: { left: 16, right: 80 },
            styles: { fontSize: 7.5, cellPadding: 1 },
            columnStyles: { 0: { cellWidth: 35, fontStyle: 'bold', textColor: [80, 80, 100] }, 1: { cellWidth: 65 } },
          });
          y = (pdfDoc.lastAutoTable?.finalY || y + 20) + 5;
        });
      }

      // --- Power Consumption Summary ---
      if (y > ph - 50) { pdfDoc.addPage(); y = 15; }
      pdfDoc.setFontSize(11); pdfDoc.setFont('helvetica', 'bold');
      pdfDoc.text('POWER CONSUMPTION SUMMARY', 14, y); y += 6;

      const powerRows = Object.entries(a.groups)
        .filter(([, g]) => g.totalPower > 0)
        .map(([key, grp]) => {
          const label = (CATEGORY_GROUPS[key] || CATEGORY_GROUPS.other).label;
          const pct = a.grandTotalPower > 0 ? ((grp.totalPower / a.grandTotalPower) * 100).toFixed(1) : '0';
          return [label, grp.totalPower.toLocaleString() + ' W', (grp.totalPower / 1000).toFixed(2) + ' kW', (grp.totalPower / 230).toFixed(1) + ' A', pct + '%'];
        });

      powerRows.push([
        { content: 'GRAND TOTAL', styles: { fontStyle: 'bold', fillColor: [255, 240, 240] } },
        { content: a.grandTotalPower.toLocaleString() + ' W', styles: { fontStyle: 'bold', fillColor: [255, 240, 240] } },
        { content: (a.grandTotalPower / 1000).toFixed(2) + ' kW', styles: { fontStyle: 'bold', fillColor: [255, 240, 240] } },
        { content: (a.grandTotalPower / 230).toFixed(1) + ' A', styles: { fontStyle: 'bold', fillColor: [255, 240, 240] } },
        { content: '100%', styles: { fontStyle: 'bold', fillColor: [255, 240, 240] } },
      ]);

      autoTable(pdfDoc, {
        startY: y,
        head: [['Department', 'Power (W)', 'Power (kW)', 'Current (A)', '% of Total']],
        body: powerRows,
        theme: 'grid',
        margin: { left: 14, right: 14 },
        styles: { fontSize: 8, cellPadding: 2 },
        headStyles: { fillColor: [180, 40, 40], textColor: 255 },
        columnStyles: {
          0: { cellWidth: 40 },
          1: { cellWidth: 30, halign: 'right' },
          2: { cellWidth: 28, halign: 'right' },
          3: { cellWidth: 28, halign: 'right' },
          4: { cellWidth: 24, halign: 'right' },
        },
      });
      y = (pdfDoc.lastAutoTable?.finalY || y + 20) + 5;

      // Circuits estimate
      pdfDoc.setFontSize(8); pdfDoc.setFont('helvetica', 'normal');
      pdfDoc.text('Estimated 16A circuits required: ~' + Math.ceil(a.grandTotalPower / 3000), 14, y);
      pdfDoc.text('Estimated 32A circuits required: ~' + Math.ceil(a.grandTotalPower / 7000), 100, y);
      y += 8;

      // --- Notes ---
      if (config.notes) {
        if (y > ph - 30) { pdfDoc.addPage(); y = 15; }
        pdfDoc.setFontSize(9); pdfDoc.setFont('helvetica', 'bold');
        pdfDoc.text('NOTES', 14, y); y += 4;
        pdfDoc.setFont('helvetica', 'normal'); pdfDoc.setFontSize(8);
        const nl = pdfDoc.splitTextToSize(config.notes, pw - 28);
        pdfDoc.text(nl, 14, y); y += nl.length * 3.5;
      }

      // --- Footer on each page ---
      const pageCount = pdfDoc.internal.getNumberOfPages();
      for (let i = 1; i <= pageCount; i++) {
        pdfDoc.setPage(i);
        pdfDoc.setFontSize(7); pdfDoc.setFont('helvetica', 'normal'); pdfDoc.setTextColor(150, 150, 150);
        pdfDoc.text('Generated by ' + (org.name || 'Rental-Ops') + ' | ' + new Date().toLocaleString('en-IN'), 14, ph - 8);
        pdfDoc.text('Page ' + i + ' of ' + pageCount, pw - 14, ph - 8, { align: 'right' });
        pdfDoc.setTextColor(0, 0, 0);
      }

      pdfDoc.save('Config_' + (config.config_name || 'export').replace(/[^a-zA-Z0-9]/g, '_') + '.pdf');
      addToast('Configuration PDF downloaded', 'success');
    } catch (error) {
      console.error('Config PDF error:', error);
      addToast('Failed to generate PDF', 'error');
    }
  };

  const handleDuplicateItem = (idx) => {
    const src = form.items[idx];
    const dup = { ...src, id: Date.now().toString() + Math.random().toString(36).slice(2, 6) };
    const updatedItems = [...form.items];
    updatedItems.splice(idx + 1, 0, dup);
    setForm({ ...form, items: updatedItems });
    addToast('Item duplicated', 'success');
  };

  const handleSaveConfig = async () => {
    if (!form.config_name.trim()) { addToast('Configuration name is required', 'error'); return; }
    if (!form.client_id) { addToast('Please select a client', 'error'); return; }
    if (form.items.length === 0) { addToast('Add at least one item', 'error'); return; }
    const a = analyzeItems(form.items);
    const payload = {
      ...form,
      total_power_watts: a.grandTotalPower,
      total_weight_kg: a.grandTotalWeight,
      total_items: a.grandTotalQty,
      updated_at: new Date().toISOString(),
    };
    try {
      if (editingId) {
        await updateDoc(doc(db, 'artifacts', appId, 'public', 'data', 'configurations', editingId), payload);
        await logAction('configurations', 'update', editingId, payload, form.config_name);
        addToast('Configuration updated', 'success');
      } else {
        payload.created_at = new Date().toISOString();
        const docRef = await addDoc(collection(db, 'artifacts', appId, 'public', 'data', 'configurations'), payload);
        await logAction('configurations', 'create', docRef.id, payload, form.config_name);
        addToast('Configuration created', 'success');
      }
      resetForm();
      setViewMode('list');
    } catch (err) {
      console.error(err);
      addToast('Failed to save configuration', 'error');
    }
  };

  const handleDeleteConfig = async (config) => {
    if (!await confirmDialog('Delete configuration "' + config.config_name + '"?')) return;
    try {
      await deleteDoc(doc(db, 'artifacts', appId, 'public', 'data', 'configurations', config.id));
      await logAction('configurations', 'delete', config.id, {}, config.config_name);
      addToast('Configuration deleted', 'success');
      if (viewMode === 'detail') setViewMode('list');
    } catch (err) {
      console.error(err);
      addToast('Failed to delete configuration', 'error');
    }
  };

  // DETAIL VIEW
  if (viewMode === 'detail' && selectedConfig) {
    const config = selectedConfig;
    const detailAnalysis = analyzeItems(config.items || []);
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => setViewMode('list')} className="text-slate-400 hover:text-indigo-600 transition-colors">{'\u2190'} Back</button>
            <h2 className="text-xl font-bold text-slate-800">{config.config_name}</h2>
          </div>
          <div className="flex gap-2">
            <button onClick={() => printConfigPDF(config)} className="px-3 py-1.5 text-sm bg-emerald-100 text-emerald-700 rounded-lg hover:bg-emerald-200 flex items-center gap-1"><Printer size={14} /> Print PDF</button>
            {can(role, 'configurations', 'create') && <button onClick={() => duplicateConfig(config)} className="px-3 py-1.5 text-sm bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 flex items-center gap-1"><Copy size={14} /> Duplicate</button>}
            {can(role, 'configurations', 'edit') && <button onClick={() => openEditConfig(config)} className="px-3 py-1.5 text-sm bg-indigo-100 text-indigo-700 rounded-lg hover:bg-indigo-200 flex items-center gap-1"><Edit size={14} /> Edit</button>}
            {can(role, 'configurations', 'delete') && <button onClick={() => handleDeleteConfig(config)} className="px-3 py-1.5 text-sm bg-red-100 text-red-700 rounded-lg hover:bg-red-200 flex items-center gap-1"><Trash2 size={14} /> Delete</button>}
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div className="bg-white rounded-xl border border-slate-200 p-4">
            <div className="text-xs text-slate-500 font-semibold uppercase">Client</div>
            <div className="mt-0.5 font-bold text-slate-800">{config.client_name || '\u2014'}</div>
            {config.venue && <div className="text-xs text-slate-400 mt-0.5">{'\ud83d\udccd'} {config.venue}</div>}
          </div>
          <div className="bg-white rounded-xl border border-slate-200 p-4">
            <div className="text-xs text-slate-500 font-semibold uppercase flex items-center gap-1"><Package size={11}/> Total Items</div>
            <div className="mt-0.5 font-bold text-slate-800">{detailAnalysis.grandTotalQty} units</div>
            <div className="text-xs text-slate-400">{(config.items || []).length} line items</div>
          </div>
          <div className="bg-white rounded-xl border border-amber-200 p-4 bg-amber-50/30">
            <div className="text-xs text-amber-600 font-semibold uppercase flex items-center gap-1"><Zap size={11}/> Total Power</div>
            <div className="mt-0.5 font-bold text-amber-700">{detailAnalysis.grandTotalPower.toLocaleString()} W</div>
            <div className="text-xs text-amber-500">{'\u2248'} {(detailAnalysis.grandTotalPower / 230).toFixed(1)}A @ 230V</div>
          </div>
          <div className="bg-white rounded-xl border border-emerald-200 p-4 bg-emerald-50/30">
            <div className="text-xs text-emerald-600 font-semibold uppercase flex items-center gap-1"><Weight size={11}/> Gross Weight</div>
            <div className="mt-0.5 font-bold text-emerald-700">{detailAnalysis.grandTotalWeight.toFixed(1)} kg</div>
            <div className="text-xs text-emerald-500">{'\u2248'} {(detailAnalysis.grandTotalWeight / 1000).toFixed(2)} tons</div>
          </div>
          <div className="bg-white rounded-xl border border-red-200 p-4 bg-red-50/30">
            <div className="text-xs text-red-600 font-semibold uppercase flex items-center gap-1"><Cpu size={11}/> Power Draw</div>
            <div className="mt-0.5 font-bold text-red-700">{(detailAnalysis.grandTotalPower / 1000).toFixed(1)} kW</div>
            <div className="text-xs text-red-500">~{Math.ceil(detailAnalysis.grandTotalPower / 3000)} {'\u00d7'} 16A circuits</div>
          </div>
        </div>

        {(config.event_type || config.description) && (
          <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-1">
            {config.event_type && <div className="text-sm"><span className="text-xs font-semibold text-slate-500 uppercase mr-2">Event:</span>{config.event_type}</div>}
            {config.description && <div className="text-sm"><span className="text-xs font-semibold text-slate-500 uppercase mr-2">Description:</span>{config.description}</div>}
          </div>
        )}

        <div className="space-y-4">
          {Object.entries(detailAnalysis.groups).map(([grpKey, grp]) => (
            <GroupAnalysisCard key={grpKey} grpKey={grpKey} grp={grp} config={config} />
          ))}
        </div>

        <div className="bg-gradient-to-r from-red-50 to-amber-50 rounded-xl border border-red-200 p-5">
          <div className="font-bold text-red-800 text-sm mb-3 flex items-center gap-2"><Zap size={16}/> Power Consumption Summary</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {Object.entries(detailAnalysis.groups).filter(([, g]) => g.totalPower > 0).map(([key, grp]) => {
              const meta = CATEGORY_GROUPS[key] || CATEGORY_GROUPS.other;
              return (
                <div key={key} className="bg-white/80 rounded-lg p-3 border border-red-100">
                  <div className="text-[10px] text-red-400 font-bold uppercase">{meta.label}</div>
                  <div className="font-bold text-red-800">{grp.totalPower.toLocaleString()} W</div>
                  <div className="text-xs text-red-500">{detailAnalysis.grandTotalPower > 0 ? ((grp.totalPower / detailAnalysis.grandTotalPower) * 100).toFixed(0) : 0}% of total</div>
                </div>
              );
            })}
          </div>
          <div className="mt-3 pt-3 border-t border-red-200 flex items-center justify-between">
            <div className="font-bold text-red-900">Grand Total Power</div>
            <div className="text-right">
              <div className="font-bold text-red-900 text-lg">{detailAnalysis.grandTotalPower.toLocaleString()} W</div>
              <div className="text-xs text-red-600">{'\u2248'} {(detailAnalysis.grandTotalPower / 230).toFixed(1)}A @ 230V {'\u00b7'} {(detailAnalysis.grandTotalPower / 1000).toFixed(1)} kW {'\u00b7'} ~{Math.ceil(detailAnalysis.grandTotalPower / 3000)} {'\u00d7'} 16A circuits needed</div>
            </div>
          </div>
        </div>

        {config.notes && (
          <div className="bg-white rounded-xl border border-slate-200 p-5">
            <div className="text-xs font-semibold text-slate-500 uppercase mb-1">Notes</div>
            <p className="text-sm text-slate-700 whitespace-pre-wrap">{config.notes}</p>
          </div>
        )}
      </div>
    );
  }

  // FORM VIEW
  if (viewMode === 'form') {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => { resetForm(); setViewMode('list'); }} className="text-slate-400 hover:text-indigo-600 transition-colors">{'\u2190'} Back</button>
            <h2 className="text-xl font-bold text-slate-800">{editingId ? 'Edit Configuration' : 'New Configuration'}</h2>
          </div>
          <button onClick={handleSaveConfig} className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-semibold flex items-center gap-2"><Save size={16}/> Save</button>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-5 space-y-4">
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-bold text-slate-700 mb-1">Configuration Name *</label>
              <input className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500" placeholder="e.g. Wedding Setup A" value={form.config_name} onChange={e => setForm({ ...form, config_name: e.target.value })} />
            </div>
            <div ref={clientDropdownRef}>
              <label className="block text-sm font-bold text-slate-700 mb-1">Client *</label>
              <div className="relative">
                <input className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500" placeholder="Search client..." value={showClientDropdown ? clientSearch : (form.client_name || clientSearch)} onChange={e => { setClientSearch(e.target.value); setShowClientDropdown(true); if (!e.target.value) setForm({ ...form, client_id: '', client_name: '' }); }} onFocus={() => setShowClientDropdown(true)} />
                {form.client_id && !showClientDropdown && <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600" onClick={() => { setForm({ ...form, client_id: '', client_name: '' }); setClientSearch(''); }}><X size={16} /></button>}
                {showClientDropdown && (
                  <ul className="absolute z-50 mt-1 max-h-48 w-full overflow-auto rounded-lg border bg-white shadow-lg">
                    {clients.filter(c => c.name?.toLowerCase().includes(clientSearch.toLowerCase())).length === 0
                      ? <li className="px-3 py-2 text-sm text-slate-400">No clients found</li>
                      : clients.filter(c => c.name?.toLowerCase().includes(clientSearch.toLowerCase())).map(c => (
                        <li key={c.id} className={'cursor-pointer px-3 py-2 text-sm hover:bg-indigo-50 ' + (form.client_id === c.id ? 'bg-indigo-100 font-semibold' : '')} onClick={() => handleSelectClient(c)}>{c.name}</li>
                      ))
                    }
                  </ul>
                )}
              </div>
            </div>
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-bold text-slate-700 mb-1">Venue</label>
              <input className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Venue name" value={form.venue} onChange={e => setForm({ ...form, venue: e.target.value })} />
            </div>
            <div>
              <label className="block text-sm font-bold text-slate-700 mb-1">Event Type</label>
              <input className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="e.g. Wedding, Corporate, Concert" value={form.event_type} onChange={e => setForm({ ...form, event_type: e.target.value })} />
            </div>
          </div>
          <div>
            <label className="block text-sm font-bold text-slate-700 mb-1">Description</label>
            <textarea className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" rows={2} placeholder="Brief description..." value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
          </div>
        </div>

        {form.items.length > 0 && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="bg-white rounded-xl border border-slate-200 p-3 flex items-center gap-3">
                <div className="p-2 rounded-lg bg-indigo-50 text-indigo-600"><Package size={16}/></div>
                <div><div className="text-[10px] text-slate-500 font-semibold uppercase">Items / Qty</div><div className="font-bold text-slate-800 text-sm">{form.items.length} / {analysis.grandTotalQty}</div></div>
              </div>
              <div className="bg-white rounded-xl border border-amber-200 p-3 flex items-center gap-3 bg-amber-50/30">
                <div className="p-2 rounded-lg bg-amber-50 text-amber-600"><Zap size={16}/></div>
                <div><div className="text-[10px] text-amber-600 font-semibold uppercase">Total Power</div><div className="font-bold text-amber-700 text-sm">{analysis.grandTotalPower.toLocaleString()} W</div></div>
              </div>
              <div className="bg-white rounded-xl border border-emerald-200 p-3 flex items-center gap-3 bg-emerald-50/30">
                <div className="p-2 rounded-lg bg-emerald-50 text-emerald-600"><Weight size={16}/></div>
                <div><div className="text-[10px] text-emerald-600 font-semibold uppercase">Gross Weight</div><div className="font-bold text-emerald-700 text-sm">{analysis.grandTotalWeight.toFixed(1)} kg</div></div>
              </div>
              <div className="bg-white rounded-xl border border-red-200 p-3 flex items-center gap-3 bg-red-50/30">
                <div className="p-2 rounded-lg bg-red-50 text-red-600"><Cpu size={16}/></div>
                <div><div className="text-[10px] text-red-600 font-semibold uppercase">Power Draw</div><div className="font-bold text-red-700 text-sm">{(analysis.grandTotalPower / 1000).toFixed(1)} kW {'\u00b7'} {(analysis.grandTotalPower / 230).toFixed(1)}A</div></div>
              </div>
            </div>
            <div className="space-y-3">
              {Object.entries(analysis.groups).map(([grpKey, grp]) => (
                <GroupAnalysisCard key={grpKey} grpKey={grpKey} grp={grp} config={form} />
              ))}
            </div>
          </>
        )}

        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="px-5 py-3 border-b bg-slate-50 flex items-center justify-between">
            <span className="font-bold text-sm text-slate-800">Equipment ({form.items.length})</span>
            {can(role, 'configurations', 'create') && <button onClick={() => openItemModal()} className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-semibold hover:bg-indigo-700 flex items-center gap-1"><Plus size={14}/> Add Item</button>}
          </div>
          {form.items.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-8">No items added yet. Click "Add Item" to start building your configuration.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500 uppercase">
                  <tr>
                    <th className="text-left px-4 py-2">#</th>
                    <th className="text-left px-4 py-2">Item</th>
                    <th className="text-left px-4 py-2">Category</th>
                    <th className="text-center px-4 py-2">Qty</th>
                    <th className="text-right px-4 py-2">Unit W</th>
                    <th className="text-right px-4 py-2">Total W</th>
                    <th className="text-right px-4 py-2">kW</th>
                    <th className="text-right px-4 py-2">Amps</th>
                    <th className="text-right px-4 py-2">Weight</th>
                    <th className="text-left px-4 py-2">Key Specs</th>
                    <th className="text-center px-4 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {form.items.map((item, idx) => {
                    const grpKey = getCategoryGroup(item.category);
                    const specs = getKeySpecs(item, grpKey);
                    const qty = parseInt(item.qty) || 0;
                    const wallQty = parseInt(item.wallQty) || 1;
                    const isLedT = item.is_led && item.led_specs;
                    const unitPw = isLedT ? (item.tileModelData?.power?.maxPower || (qty > 0 ? parseFloat(item.power_watts) / qty : 0)) : parseFloat(item.power_watts) || 0;
                    const totalPw = isLedT ? (parseFloat(item.power_watts) || 0) * wallQty : unitPw * qty;
                    const totalWt = isLedT ? (parseFloat(item.weight) || 0) * wallQty : (parseFloat(item.weight) || 0) * qty;
                    const displayQty = isLedT ? qty * wallQty : qty;
                    return (
                      <tr key={item.id || idx} className="hover:bg-slate-50/50">
                        <td className="px-4 py-2 text-slate-400">{idx + 1}</td>
                        <td className="px-4 py-2 font-medium text-slate-800">
                          {item.item_name}
                          {item.brand && <span className="text-xs text-slate-400 ml-1">({item.brand})</span>}
                          {item.is_led && <span className="ml-1.5 text-[10px] bg-indigo-100 text-indigo-600 px-1.5 py-0.5 rounded">LED</span>}
                          {isLedT && wallQty > 1 && <span className="ml-1 text-[10px] bg-violet-100 text-violet-600 px-1.5 py-0.5 rounded">{wallQty} walls</span>}
                        </td>
                        <td className="px-4 py-2"><span className="text-xs bg-slate-100 px-2 py-0.5 rounded text-slate-600">{item.category}</span></td>
                        <td className="px-4 py-2 text-center font-semibold">{displayQty}{isLedT && wallQty > 1 ? <span className="text-[10px] text-slate-400 ml-0.5">({qty}&times;{wallQty})</span> : ''}</td>
                        <td className="px-4 py-2 text-right text-amber-700">{unitPw ? unitPw.toLocaleString() + 'W' : '\u2014'}</td>
                        <td className="px-4 py-2 text-right font-semibold text-amber-700">{totalPw ? totalPw.toLocaleString() + 'W' : '\u2014'}</td>
                        <td className="px-4 py-2 text-right text-amber-600">{totalPw ? (totalPw / 1000).toFixed(2) : '\u2014'}</td>
                        <td className="px-4 py-2 text-right text-red-600">{totalPw ? (totalPw / 230).toFixed(1) + 'A' : '\u2014'}</td>
                        <td className="px-4 py-2 text-right text-emerald-700">{totalWt ? totalWt.toFixed(1) + 'kg' : '\u2014'}</td>
                        <td className="px-4 py-2 text-xs text-slate-500 max-w-[180px] truncate">{specs || '\u2014'}</td>
                        <td className="px-4 py-2 text-center whitespace-nowrap">
                          <button onClick={() => handleDuplicateItem(idx)} className="text-slate-400 hover:text-slate-600 mr-1.5" title="Duplicate"><Copy size={14}/></button>
                          <button onClick={() => openItemModal(idx)} className="text-indigo-600 hover:text-indigo-800 mr-1.5" title="Edit"><Edit size={14}/></button>
                          <button onClick={() => handleRemoveItem(idx)} className="text-red-500 hover:text-red-700" title="Delete"><Trash2 size={14}/></button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <label className="block text-sm font-bold text-slate-700 mb-1">Notes</label>
          <textarea className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" rows={3} placeholder="Additional notes for client / tech crew..." value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} />
        </div>

        {showItemModal && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
            <div className="w-full max-w-lg bg-white rounded-2xl shadow-2xl max-h-[90dvh] overflow-y-auto">
              <div className="flex items-center justify-between px-5 py-3 border-b bg-slate-50">
                <h3 className="font-bold text-slate-800">{editingItemIdx !== null ? 'Edit Item' : 'Add Item'}</h3>
                <button onClick={() => setShowItemModal(false)} className="text-slate-400 hover:text-slate-600"><X size={18}/></button>
              </div>
              <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
                <div ref={itemDropdownRef}>
                  <label className="block text-sm font-bold text-slate-700 mb-1">Select Item *</label>
                  <div className="flex gap-2 mb-2">
                    <select className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm" value={itemCategoryFilter} onChange={e => setItemCategoryFilter(e.target.value)}>
                      <option value="">All Categories</option>
                      {categories.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div className="relative">
                    <input className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Search inventory..." value={showItemDropdown ? itemSearch : (itemForm.item_name || itemSearch)} onChange={e => { setItemSearch(e.target.value); setShowItemDropdown(true); }} onFocus={() => setShowItemDropdown(true)} />
                    {showItemDropdown && (
                      <ul className="absolute z-50 mt-1 max-h-48 w-full overflow-auto rounded-lg border bg-white shadow-lg">
                        {filteredInventory.length === 0
                          ? <li className="px-3 py-2 text-sm text-slate-400">No items found</li>
                          : filteredInventory.map(inv => (
                            <li key={inv.id} className={'cursor-pointer px-3 py-2 text-sm hover:bg-indigo-50 ' + (itemForm.item_id === inv.id ? 'bg-indigo-100 font-semibold' : '')} onClick={() => handleSelectInventoryItem(inv)}>
                              <div className="flex items-center justify-between">
                                <span><span className="font-medium">{inv.name}</span> <span className="text-xs text-slate-400">{inv.brand ? '(' + inv.brand + ')' : ''}</span></span>
                                <span className="text-xs text-slate-400">{inv.category}</span>
                              </div>
                              <div className="text-[10px] text-slate-400 mt-0.5">
                                {[inv.power_watts && (inv.power_watts + 'W'), inv.weight && (inv.weight + 'kg'), inv.dimensions].filter(Boolean).join(' \u00b7 ')}
                              </div>
                            </li>
                          ))
                        }
                      </ul>
                    )}
                  </div>
                </div>

                {itemForm.item_id && (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs space-y-1">
                    <div className="font-bold text-slate-700 text-sm flex items-center gap-2">
                      {itemForm.item_name} {itemForm.brand && <span className="text-slate-400 font-normal">({itemForm.brand})</span>}
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-slate-500">
                      {itemForm.category && <span>Category: <strong className="text-slate-700">{itemForm.category}</strong></span>}
                      {itemForm.sub_category && <span>Sub: <strong className="text-slate-700">{itemForm.sub_category}</strong></span>}
                      {itemForm.power_watts && <span>Power: <strong className="text-amber-700">{itemForm.power_watts}W</strong></span>}
                      {itemForm.current_amps && <span>Current: <strong className="text-amber-700">{itemForm.current_amps}A</strong></span>}
                      {itemForm.weight && <span>Weight: <strong className="text-emerald-700">{itemForm.weight}kg</strong></span>}
                      {itemForm.dimensions && <span>Dims: <strong className="text-slate-700">{itemForm.dimensions}</strong></span>}
                      {itemForm.connector_type && <span>Connector: <strong className="text-slate-700">{itemForm.connector_type}</strong></span>}
                      {itemForm.ip_rating && <span>IP: <strong className="text-slate-700">{itemForm.ip_rating}</strong></span>}
                    </div>
                    {Object.keys(itemForm.attributes || {}).length > 0 && (
                      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-slate-500 pt-1 border-t border-slate-200 mt-1">
                        {Object.entries(itemForm.attributes).filter(([, v]) => v).map(([k, v]) => (
                          <span key={k}>{k.replace(/_/g, ' ')}: <strong className="text-slate-700">{v}</strong></span>
                        ))}
                      </div>
                    )}
                    {itemForm.specifications && <div className="text-slate-500 pt-1 border-t border-slate-200 mt-1">Specs: {itemForm.specifications}</div>}
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Quantity *</label>
                    <input type="number" min="1" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" value={itemForm.qty} onChange={e => setItemForm({ ...itemForm, qty: e.target.value })} />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Power (W/unit) {'\u2014'} auto-filled</label>
                    <input type="number" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-slate-50" value={itemForm.power_watts} onChange={e => setItemForm({ ...itemForm, power_watts: e.target.value })} />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Weight (kg/unit) {'\u2014'} auto-filled</label>
                    <input type="number" step="0.1" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-slate-50" value={itemForm.weight} onChange={e => setItemForm({ ...itemForm, weight: e.target.value })} />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Current (A/unit) {'\u2014'} auto-filled</label>
                    <input type="number" step="0.1" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm bg-slate-50" value={itemForm.current_amps} onChange={e => setItemForm({ ...itemForm, current_amps: e.target.value })} />
                  </div>
                </div>

                {itemForm.is_led && (
                  <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-4 space-y-3">
                    <div className="text-sm font-bold text-indigo-800 flex items-center gap-1.5"><Monitor size={14}/> LED Wall Configuration</div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                        <label className="block text-xs font-semibold text-indigo-600 mb-1">Tiles Wide</label>
                        <input type="number" min="1" className="w-full rounded-lg border border-indigo-200 px-3 py-2 text-sm bg-white" value={itemForm.tilesWide} onChange={e => setItemForm({ ...itemForm, tilesWide: parseInt(e.target.value) || 0 })} />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-indigo-600 mb-1">Tiles High</label>
                        <input type="number" min="1" className="w-full rounded-lg border border-indigo-200 px-3 py-2 text-sm bg-white" value={itemForm.tilesHigh} onChange={e => setItemForm({ ...itemForm, tilesHigh: parseInt(e.target.value) || 0 })} />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-indigo-600 mb-1">No. of Walls</label>
                        <input type="number" min="1" className="w-full rounded-lg border border-indigo-200 px-3 py-2 text-sm bg-white" value={itemForm.wallQty || 1} onChange={e => setItemForm({ ...itemForm, wallQty: parseInt(e.target.value) || 1 })} />
                      </div>
                    </div>
                    {(itemForm.wallQty || 1) > 1 && <div className="text-xs text-indigo-600">{'\u2139\ufe0f'} {itemForm.wallQty} identical walls of {itemForm.tilesWide || 0}&times;{itemForm.tilesHigh || 0} tiles. Total tiles: {(itemForm.tilesWide || 0) * (itemForm.tilesHigh || 0) * (itemForm.wallQty || 1)}</div>}
                    {!itemForm.tileModelData && <div className="text-xs text-amber-600">{'\u26a0'} No tile model data in inventory. Wall specs won't auto-calculate. Enter power/weight manually.</div>}
                  </div>
                )}

                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">Remarks</label>
                  <input className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Optional remarks..." value={itemForm.remarks} onChange={e => setItemForm({ ...itemForm, remarks: e.target.value })} />
                </div>
              </div>
              <div className="flex justify-end gap-2 px-5 py-3 border-t bg-slate-50">
                <button onClick={() => setShowItemModal(false)} className="px-4 py-2 text-sm text-slate-600 bg-slate-200 rounded-lg hover:bg-slate-300">Cancel</button>
                <button onClick={handleSaveItem} className="px-4 py-2 text-sm text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 font-semibold">{editingItemIdx !== null ? 'Update' : 'Add'}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // LIST VIEW
  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2"><Layers size={22} className="text-indigo-600"/> Configuration Builder</h2>
        {can(role, 'configurations', 'create') && <button onClick={openNewConfig} className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-semibold hover:bg-indigo-700 flex items-center gap-2"><Plus size={16}/> New Configuration</button>}
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"/>
          <input className="w-full rounded-lg border border-slate-300 pl-9 pr-3 py-2 text-sm" placeholder="Search configurations..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
        </div>
        <select className="rounded-lg border border-slate-300 px-3 py-2 text-sm" value={filterClient} onChange={e => setFilterClient(e.target.value)}>
          <option value="">All Clients</option>
          {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>

      {filteredConfigs.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 p-12 text-center">
          <Layers size={40} className="mx-auto text-slate-300 mb-3"/>
          <p className="text-slate-500 text-sm">No configurations found. Create your first technical configuration for a pre-quote validation.</p>
        </div>
      ) : (
        <div className="grid gap-4">
          {filteredConfigs.map(config => {
            const cAnalysis = analyzeItems(config.items || []);
            const groupKeys = Object.keys(cAnalysis.groups);
            return (
              <div key={config.id} className="bg-white rounded-xl border border-slate-200 hover:border-indigo-200 hover:shadow-md transition-all cursor-pointer group" onClick={() => openDetailView(config)}>
                <div className="p-5">
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <h3 className="font-bold text-slate-800 group-hover:text-indigo-600 transition-colors truncate">{config.config_name}</h3>
                        <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full font-medium shrink-0">{(config.items || []).length} items</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                        <span className="font-medium text-slate-700">{config.client_name || 'No client'}</span>
                        {config.venue && <span>{'\ud83d\udccd'} {config.venue}</span>}
                        {config.event_type && <span>{'\ud83c\udfaa'} {config.event_type}</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0 ml-4" onClick={e => e.stopPropagation()}>
                      <button onClick={() => printConfigPDF(config)} className="p-1.5 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg" title="Print PDF"><Printer size={14}/></button>
                      {can(role, 'configurations', 'create') && <button onClick={() => duplicateConfig(config)} className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg" title="Duplicate"><Copy size={14}/></button>}
                      {can(role, 'configurations', 'edit') && <button onClick={() => openEditConfig(config)} className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg" title="Edit"><Edit size={14}/></button>}
                      {can(role, 'configurations', 'delete') && <button onClick={() => handleDeleteConfig(config)} className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg" title="Delete"><Trash2 size={14}/></button>}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-3 mt-2">
                    <span className="text-xs flex items-center gap-1 text-amber-600 font-medium bg-amber-50 px-2 py-0.5 rounded-full"><Zap size={10}/> {cAnalysis.grandTotalPower.toLocaleString()} W</span>
                    <span className="text-xs flex items-center gap-1 text-emerald-600 font-medium bg-emerald-50 px-2 py-0.5 rounded-full"><Weight size={10}/> {cAnalysis.grandTotalWeight.toFixed(1)} kg</span>
                    <span className="text-xs flex items-center gap-1 text-slate-500 bg-slate-50 px-2 py-0.5 rounded-full"><Package size={10}/> {cAnalysis.grandTotalQty} units</span>
                    {groupKeys.map(gk => {
                      const meta = CATEGORY_GROUPS[gk] || CATEGORY_GROUPS.other;
                      const cm = colorMap[meta.color] || colorMap.gray;
                      return <span key={gk} className={'text-[10px] font-medium px-2 py-0.5 rounded-full ' + cm.badge}>{meta.label}</span>;
                    })}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default ConfigurationBuilder;
