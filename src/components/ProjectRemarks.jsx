import { useState, useMemo } from 'react';
import { notify } from '../utils/toast';
import { formatDate } from '../utils/helpers';

// Initial state for project remarks
const initialRemarkForm = {
  remark: '',
  addressed_to: 'general', // general, client, vendor, employee
  addressed_to_id: '',
  date: new Date().toISOString().split('T')[0]
};

/**
 * ProjectRemarks Component
 * Allows team members, admins, and managers to add remarks to projects
 */
export function ProjectRemarks({
  project,
  currentUser,
  role,
  employees,
  clients,
  onSaveRemark,
  onClose
}) {
  const [remarkForm, setRemarkForm] = useState(initialRemarkForm);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Get team members assigned to this project
  const projectTeam = useMemo(() => {
    if (!project?.team || !employees) return [];
    return employees.filter(emp => project.team.includes(emp.id));
  }, [project, employees]);

  // Get vendors associated with project (from outsourcing items)
  const projectVendors = useMemo(() => {
    if (!project?.items || !clients) return [];
    const vendorIds = new Set();
    project.items.forEach(item => {
      if (item.is_external && item.vendor_id) {
        vendorIds.add(item.vendor_id);
      }
    });
    // Also check outsourcing array if exists
    if (project.outsourcing) {
      project.outsourcing.forEach(out => {
        if (out.vendor_id) vendorIds.add(out.vendor_id);
      });
    }
    return clients.filter(c => vendorIds.has(c.id) || c.type === 'vendor');
  }, [project, clients]);

  // Get project client
  const projectClient = useMemo(() => {
    if (!project?.client_id || !clients) return null;
    return clients.find(c => c.id === project.client_id);
  }, [project, clients]);

  // Check if current user is allowed to add remarks
  const canAddRemark = useMemo(() => {
    if (role === 'admin' || role === 'manager') return true;
    // Tech/Employee can add only if they're in the project team
    if (project?.team && currentUser?.employee_id) {
      return project.team.includes(currentUser.employee_id);
    }
    return false;
  }, [role, project, currentUser]);

  // Get addressed_to options based on role
  const addressedToOptions = useMemo(() => {
    const options = [{ value: 'general', label: 'General Remark' }];
    
    if (role === 'admin' || role === 'manager') {
      if (projectClient) {
        options.push({ value: 'client', label: `Client: ${projectClient.name}` });
      }
      if (projectVendors.length > 0) {
        options.push({ value: 'vendor', label: 'Vendor' });
      }
      if (projectTeam.length > 0) {
        options.push({ value: 'employee', label: 'Team Member' });
      }
    }
    return options;
  }, [role, projectClient, projectVendors, projectTeam]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!remarkForm.remark.trim()) {
      notify('Please enter a remark', 'error');
      return;
    }

    setIsSubmitting(true);
    try {
      const newRemark = {
        ...remarkForm,
        created_by: currentUser?.uid || 'unknown',
        created_by_name: currentUser?.displayName || currentUser?.email || 'Unknown User',
        created_by_role: role,
        created_at: new Date().toISOString(),
        id: Date.now().toString()
      };

      // If addressed to specific entity, add name
      if (remarkForm.addressed_to === 'client' && projectClient) {
        newRemark.addressed_to_name = projectClient.name;
        newRemark.addressed_to_id = projectClient.id;
      } else if (remarkForm.addressed_to === 'vendor' && remarkForm.addressed_to_id) {
        const vendor = projectVendors.find(v => v.id === remarkForm.addressed_to_id);
        newRemark.addressed_to_name = vendor?.name || 'Unknown Vendor';
      } else if (remarkForm.addressed_to === 'employee' && remarkForm.addressed_to_id) {
        const emp = projectTeam.find(e => e.id === remarkForm.addressed_to_id);
        newRemark.addressed_to_name = emp?.name || 'Unknown Employee';
      }

      await onSaveRemark(project.id, newRemark);
      setRemarkForm(initialRemarkForm);
    } catch (error) {
      console.error('Error saving remark:', error);
      notify('Failed to save remark', 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Sort remarks by date (newest first)
  const sortedRemarks = useMemo(() => {
    if (!project?.remarks) return [];
    return [...project.remarks].sort((a, b) => 
      new Date(b.created_at || b.date) - new Date(a.created_at || a.date)
    );
  }, [project?.remarks]);

  if (!canAddRemark && (!project?.remarks || project.remarks.length === 0)) {
    return (
      <div className="p-4 text-center text-gray-500">
        You are not authorized to view or add remarks for this project.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Add Remark Form */}
      {canAddRemark && (
        <form onSubmit={handleSubmit} className="bg-gray-50 p-4 rounded-lg space-y-4">
          <h4 className="font-semibold text-gray-700">Add New Remark</h4>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Date
              </label>
              <input
                type="date"
                value={remarkForm.date}
                onChange={(e) => setRemarkForm(prev => ({ ...prev, date: e.target.value }))}
                className="w-full border rounded px-3 py-2"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Addressed To
              </label>
              <select
                value={remarkForm.addressed_to}
                onChange={(e) => setRemarkForm(prev => ({ 
                  ...prev, 
                  addressed_to: e.target.value,
                  addressed_to_id: ''
                }))}
                className="w-full border rounded px-3 py-2"
              >
                {addressedToOptions.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>

            {remarkForm.addressed_to === 'vendor' && projectVendors.length > 0 && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Select Vendor
                </label>
                <select
                  value={remarkForm.addressed_to_id}
                  onChange={(e) => setRemarkForm(prev => ({ ...prev, addressed_to_id: e.target.value }))}
                  className="w-full border rounded px-3 py-2"
                  required
                >
                  <option value="">-- Select Vendor --</option>
                  {projectVendors.map(v => (
                    <option key={v.id} value={v.id}>{v.name}</option>
                  ))}
                </select>
              </div>
            )}

            {remarkForm.addressed_to === 'employee' && projectTeam.length > 0 && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Select Team Member
                </label>
                <select
                  value={remarkForm.addressed_to_id}
                  onChange={(e) => setRemarkForm(prev => ({ ...prev, addressed_to_id: e.target.value }))}
                  className="w-full border rounded px-3 py-2"
                  required
                >
                  <option value="">-- Select Employee --</option>
                  {projectTeam.map(emp => (
                    <option key={emp.id} value={emp.id}>{emp.name}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Remark
            </label>
            <textarea
              value={remarkForm.remark}
              onChange={(e) => setRemarkForm(prev => ({ ...prev, remark: e.target.value }))}
              className="w-full border rounded px-3 py-2"
              rows={3}
              placeholder="Enter your remark here..."
              required
            />
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={isSubmitting}
              className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {isSubmitting ? 'Saving...' : 'Add Remark'}
            </button>
          </div>
        </form>
      )}

      {/* Remarks List */}
      <div>
        <h4 className="font-semibold text-gray-700 mb-3">
          Remarks History ({sortedRemarks.length})
        </h4>
        
        {sortedRemarks.length === 0 ? (
          <p className="text-gray-500 text-center py-4">No remarks yet</p>
        ) : (
          <div className="space-y-3 max-h-96 overflow-y-auto">
            {sortedRemarks.map((remark, index) => (
              <div 
                key={remark.id || index} 
                className={`p-3 rounded-lg border ${
                  remark.addressed_to === 'client' ? 'bg-blue-50 border-blue-200' :
                  remark.addressed_to === 'vendor' ? 'bg-orange-50 border-orange-200' :
                  remark.addressed_to === 'employee' ? 'bg-green-50 border-green-200' :
                  'bg-white border-gray-200'
                }`}
              >
                <div className="flex justify-between items-start mb-2">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">
                      {remark.created_by_name || 'Unknown'}
                    </span>
                    <span className={`text-xs px-2 py-0.5 rounded ${
                      remark.created_by_role === 'admin' ? 'bg-red-100 text-red-700' :
                      remark.created_by_role === 'manager' ? 'bg-purple-100 text-purple-700' :
                      'bg-gray-100 text-gray-700'
                    }`}>
                      {remark.created_by_role || 'user'}
                    </span>
                  </div>
                  <span className="text-xs text-gray-500">
                    {formatDate(remark.date || remark.created_at)}
                  </span>
                </div>
                
                {remark.addressed_to && remark.addressed_to !== 'general' && (
                  <div className="text-xs text-gray-600 mb-1">
                    <span className="font-medium">To:</span>{' '}
                    {remark.addressed_to_name || remark.addressed_to}
                  </div>
                )}
                
                <p className="text-gray-800 text-sm whitespace-pre-wrap">
                  {remark.remark}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default ProjectRemarks;
