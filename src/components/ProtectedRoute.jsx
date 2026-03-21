import React from 'react';
import { Navigate } from 'react-router-dom';
import { can } from '../utils/permissions';

/**
 * ProtectedRoute — wraps a route and redirects unauthorized users to /dashboard.
 *
 * Usage:
 *   <ProtectedRoute role={role} resource="finance" action="view">
 *     <Finance ... />
 *   </ProtectedRoute>
 */
const ProtectedRoute = ({ role, resource, action = 'view', children, fallback = '/dashboard' }) => {
  if (!can(role, resource, action)) {
    return <Navigate to={fallback} replace />;
  }
  return children;
};

export default ProtectedRoute;
