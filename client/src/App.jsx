import { Route, Routes } from 'react-router-dom';
import ErrorBanner from './components/ErrorBanner.jsx';
import ScrollToTopOnNavigate from './components/ScrollToTopOnNavigate.jsx';
import { AuthProvider } from './auth/AuthProvider.jsx';
import RequireAuth from './auth/RequireAuth.jsx';
import RequireManager from './auth/RequireManager.jsx';
import Login from './pages/auth/Login.jsx';
import ManagerHome from './pages/manager/ManagerHome.jsx';
import StuckList from './pages/manager/StuckList.jsx';
import TraineeDetail from './pages/manager/TraineeDetail.jsx';
import TrackPreview from './pages/manager/TrackPreview.jsx';
import NotFound from './pages/NotFound.jsx';
import Dashboard from './pages/training/Dashboard.jsx';
import Lesson from './pages/training/Lesson.jsx';
import Quiz from './pages/training/Quiz.jsx';
import Stage from './pages/training/Stage.jsx';
import StatusGuide from './pages/reference/StatusGuide.jsx';

// The router itself lives in main.jsx (BrowserRouter), so tests can wrap
// App in a MemoryRouter instead. AuthProvider needs the router (for logout).
export default function App() {
  return (
    <ErrorBanner>
      <AuthProvider>
        <ScrollToTopOnNavigate />
        <Routes>
          <Route
            path="/"
            element={
              <RequireAuth>
                <Dashboard />
              </RequireAuth>
            }
          />
          <Route
            path="/stage/:code"
            element={
              <RequireAuth>
                <Stage />
              </RequireAuth>
            }
          />
          <Route
            path="/stage/:code/lesson/:lessonId"
            element={
              <RequireAuth>
                <Lesson />
              </RequireAuth>
            }
          />
          <Route
            path="/stage/:code/quiz"
            element={
              <RequireAuth>
                <Quiz />
              </RequireAuth>
            }
          />
          {/* The management area (S07). Every one of these is inside
              RequireManager: a staff session renders the no-access message and
              fires no manager request. The server checks the role again on
              every call. */}
          <Route
            path="/manager"
            element={
              <RequireManager>
                <ManagerHome />
              </RequireManager>
            }
          />
          <Route
            path="/manager/stuck"
            element={
              <RequireManager>
                <StuckList />
              </RequireManager>
            }
          />
          <Route
            path="/manager/trainee/:id"
            element={
              <RequireManager>
                <TraineeDetail />
              </RequireManager>
            }
          />
          <Route
            path="/manager/preview"
            element={
              <RequireManager>
                <TrackPreview />
              </RequireManager>
            }
          />
          <Route
            path="/manager/preview/:track"
            element={
              <RequireManager>
                <TrackPreview />
              </RequireManager>
            }
          />
          <Route
            path="/status-guide"
            element={
              // Firm-wide reference: it needs a sign-in, but not a track.
              <RequireAuth requireTrack={false}>
                <StatusGuide />
              </RequireAuth>
            }
          />
          <Route path="/login" element={<Login />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </AuthProvider>
    </ErrorBanner>
  );
}
