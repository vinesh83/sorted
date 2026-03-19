import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { LoginPage } from './pages/LoginPage';
import { SelectParalegal } from './pages/SelectParalegal';
import { ReviewPage } from './pages/ReviewPage';
import { HistoryPage } from './pages/HistoryPage';
import { AdminPage } from './pages/AdminPage';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { token, paralegal } = useAuth();
  if (!token) return <Navigate to="/login" replace />;
  if (!paralegal) return <Navigate to="/select" replace />;
  return <>{children}</>;
}

function ParalegalRoute({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/select"
            element={
              <ParalegalRoute>
                <SelectParalegal />
              </ParalegalRoute>
            }
          />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <ReviewPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/history"
            element={
              <ProtectedRoute>
                <HistoryPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin"
            element={
              <ProtectedRoute>
                <AdminPage />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
