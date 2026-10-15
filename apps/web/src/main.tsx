import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { StorePage } from "./pages/StorePage";
import { parseRoute, useLocation } from "./router";
import "./styles.css";

/** "/" = area view (3D city); "/store/:id" = the shop owner's page (docs/STORE_PAGE.md). */
function Root() {
  const route = parseRoute(useLocation());
  return route.page === "store" ? <StorePage key={`${route.storeId}:${route.run ?? ""}`} storeId={route.storeId} run={route.run} /> : <App />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
