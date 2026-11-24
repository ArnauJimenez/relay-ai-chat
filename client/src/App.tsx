import { AuthScreen } from "./components/AuthScreen";
import { Dashboard } from "./components/Dashboard";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { SocketProvider } from "./context/SocketContext";

function App() {
  return (
    <AuthProvider>
      <SocketProvider>
        <AuthenticatedApp />
      </SocketProvider>
    </AuthProvider>
  );
}

function AuthenticatedApp() {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? <Dashboard /> : <AuthScreen />;
}

export default App;
