import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, Route, Routes } from "react-router-dom";
import { get, type User } from "./lib/api";
import { mainStyle, PageHeader, Shell } from "./components/Shell";
import { Footer } from "./components/kit";
import { SignIn } from "./screens/SignIn";
import { Today } from "./screens/Today";
import { Receiving } from "./screens/Receiving";
import { Inventory } from "./screens/Inventory";
import { Fill } from "./screens/Fill";
import { Recalls } from "./screens/Recalls";
import { Outbox } from "./screens/Outbox";
import { Patients } from "./screens/Patients";
import { Integrations } from "./screens/Integrations";
import { Register } from "./screens/Register";
import { StockHelp } from "./screens/StockHelp";
import { AIAgents } from "./screens/AIAgents";
import { Transfers } from "./screens/Transfers";
import { Dscsa } from "./screens/Dscsa";
import { Refills } from "./screens/Refills";


type Role = User["role"];
const ALL: Role[] = ["pharmacist", "technician", "cashier", "admin"];
const CLINICAL: Role[] = ["pharmacist", "technician", "cashier"];
const NOT_CASHIER: Role[] = ["pharmacist", "technician", "admin"];
const STAFF: Role[] = ["pharmacist", "technician"];
/** Same rules as the sidebar, so a typed or bookmarked address does not show a screen the API will refuse. */
const ACCESS: Record<string, Role[]> = {
  "/receiving": CLINICAL, "/inventory": CLINICAL, "/fill": CLINICAL, "/recalls": STAFF, "/outbox": STAFF,
  "/register": ["cashier", "pharmacist"], "/stock": STAFF, "/transfers": ["pharmacist"], "/refills": STAFF, "/dscsa": STAFF,
  "/patients": NOT_CASHIER, "/agents": NOT_CASHIER, "/integrations": ["admin", "pharmacist"]
};

function G({ user, path, children }: { user: User; path: string; children: React.ReactNode }) {
  return (ACCESS[path] ?? ALL).includes(user.role) ? <>{children}</> : <NotForRole user={user} />;
}

function NotForRole({ user }: { user: User }) {
  return (
    <>
      <PageHeader title="Not available for your role" sub={`Signed in as ${user.title}.`} />
      <main style={mainStyle()}>
        <p role="status" style={{ margin: 0, fontSize: 15 }}>This screen is not part of your role in the demo. <Link to={user.role === "admin" ? "/integrations" : "/"}>Go to your start page</Link>.</p>
        <Footer />
      </main>
    </>
  );
}

export function App() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: () => get<{ user: User; today: string }>("/api/me"), retry: false });
  useEffect(() => {
    const h = () => void qc.invalidateQueries({ queryKey: ["me"] });
    window.addEventListener("lg:unauthenticated", h);
    return () => window.removeEventListener("lg:unauthenticated", h);
  }, [qc]);

  if (me.isLoading) return <div style={{ padding: 40 }} className="dim">Loading…</div>;
  if (me.isError || !me.data) return <SignIn />;
  const user = me.data.user;
  return (
    <Shell user={user}>
      <Routes>
        <Route path="/" element={user.role === "admin" ? <Navigate to="/integrations" replace /> : <Today user={user} />} />
        <Route path="/patients" element={<G user={user} path="/patients"><Patients user={user} /></G>} />
        <Route path="/integrations" element={<G user={user} path="/integrations"><Integrations user={user} /></G>} />
        <Route path="/receiving" element={<G user={user} path="/receiving"><Receiving user={user} /></G>} />
        <Route path="/inventory" element={<G user={user} path="/inventory"><Inventory user={user} /></G>} />
        <Route path="/fill" element={<G user={user} path="/fill"><Fill user={user} /></G>} />
        <Route path="/recalls" element={<G user={user} path="/recalls"><Recalls user={user} /></G>} />
        <Route path="/register" element={<G user={user} path="/register"><Register user={user} /></G>} />
        <Route path="/transfers" element={<G user={user} path="/transfers"><Transfers user={user} /></G>} />
        <Route path="/stock" element={<G user={user} path="/stock"><StockHelp user={user} /></G>} />
        <Route path="/agents" element={<G user={user} path="/agents"><AIAgents user={user} /></G>} />
        <Route path="/dscsa" element={<G user={user} path="/dscsa"><Dscsa user={user} /></G>} />
        <Route path="/refills" element={<G user={user} path="/refills"><Refills user={user} /></G>} />
        <Route path="/outbox" element={<G user={user} path="/outbox"><Outbox /></G>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
