/**
 * App.tsx
 *
 * Root component. Defines top-level routes and the wallet-aware navigation.
 *
 * Routes:
 *   /              → Dashboard (connect wallet, open a job by id)
 *   /post          → PostJob (client creates + funds a new escrow)
 *   /activity      → Activity (earnings + open escrows for the wallet, #73)
 *   /jobs/:id      → JobDetail (milestone tracker, release + dispute)
 *   /jobs/:id/receipt → Receipt (printable/exportable record)
 *   /profile/:addr → Profile (reputation score)
 *   *              → NotFound (catch-all for unknown paths, #29)
 */

import { BrowserRouter, Link, Route, Routes } from "react-router-dom";
import { WalletProvider } from "./hooks/WalletProvider";
import { useWallet } from "./hooks/wallet-context";
import { ACTIVE_NETWORK } from "./lib/stellar";
import AddressField from "./components/AddressField";
import NotificationsBell from "./components/NotificationsBell";
import Logo from "./components/Logo";
import Dashboard from "./pages/Dashboard";
import Activity from "./pages/Activity";
import PostJob from "./pages/PostJob";
import JobDetail from "./pages/JobDetail";
import Receipt from "./pages/Receipt";
import Profile from "./pages/Profile";
import FreelancerDirectory from "./pages/FreelancerDirectory";
import NotFound from "./pages/NotFound";

function Nav() {
  const { publicKey, connecting, connect, disconnect } = useWallet();
  return (
    <nav className="nav" aria-label="Main navigation">
      <Link to="/" className="nav-brand" aria-label="Stellar Freelance Platform Home">
        <Logo size={28} />
      </Link>
      <Link to="/">My Jobs</Link>
      <Link to="/activity">Activity</Link>
      <Link to="/post">Post a Job</Link>
      <span className="nav-spacer" style={{ display: "inline-flex", alignItems: "center" }}>
        {publicKey ? (
          <>
            <NotificationsBell />
            <AddressField address={publicKey} truncate />{" "}
            <button onClick={disconnect}>Disconnect</button>
          </>
        ) : (
          <button onClick={() => void connect()} disabled={connecting}>
            {connecting ? "Connecting…" : "Connect Freighter"}
          </button>
        )}
      </span>
    </nav>
  );
}

function NetworkMismatchBanner() {
  const { publicKey, networkMismatch } = useWallet();

  if (!publicKey || !networkMismatch) return null;

  const networkName = ACTIVE_NETWORK === "testnet" ? "Testnet" : "Mainnet";

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="alert alert-error"
      style={{
        margin: 0,
        borderRadius: 0,
        padding: "0.8rem 1rem",
        textAlign: "center",
      }}
    >
      Freighter is connected to a different network. Please switch to {networkName} in your wallet.
    </div>
  );
}

export default function App() {
  return (
    <WalletProvider>
      <BrowserRouter>
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>
        <Nav />
        <NetworkMismatchBanner />
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/freelancers" element={<FreelancerDirectory />} />
          <Route path="/post" element={<PostJob />} />
          <Route path="/activity" element={<Activity />} />
          <Route path="/jobs/:id" element={<JobDetail />} />
          <Route path="/jobs/:id/receipt" element={<Receipt />} />
          <Route path="/profile/:address" element={<Profile />} />
          {/* Last route: React Router picks the most specific match, so this
              only renders when nothing above matched (issue #29). */}
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </WalletProvider>
  );
}
