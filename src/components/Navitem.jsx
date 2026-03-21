// c:\APP\temp\rental-ops\src\components\NavItem.jsx
import React from 'react';
import { Link, useLocation } from 'react-router-dom';

const NavItem = ({ to, icon: Icon, label, badge, setMobileMenuOpen }) => {
  const location = useLocation();
  const isActive = location.pathname.startsWith(to);
  return (
    <Link 
      to={to} 
      onClick={() => setMobileMenuOpen(false)} 
      className={`group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-[13px] transition-all duration-150 ${
        isActive 
          ? 'nav-active bg-indigo-50 text-indigo-700 font-semibold shadow-sm shadow-indigo-100' 
          : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900 font-medium'
      }`}
    >
      <div className={`flex items-center justify-center w-8 h-8 rounded-lg transition-colors duration-150 ${
        isActive ? 'bg-indigo-100 text-indigo-600' : 'bg-transparent text-slate-400 group-hover:bg-slate-100 group-hover:text-slate-600'
      }`}>
        <Icon size={18} />
      </div>
      <span className="flex-1 text-left">{label}</span>
      {badge > 0 && (
        <span className="bg-red-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center leading-none">
          {badge}
        </span>
      )}
    </Link>
  );
};

export default NavItem;
