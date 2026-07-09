import { createRoot } from "react-dom/client";
import { Shell } from "./components/shell";

// Suppress decryption errors from the Provider's internal pipeline when a
// re-minted user syncs a document that has sidecars/awareness encrypted with
// an old key. The ActiveSession component handles this gracefully via its own
// try/catch and shows a "New Key Issued" state.
function isDecryptionError(value: unknown): boolean {
  const msg = String((value as any)?.message ?? value ?? "").toLowerCase();
  return msg.includes("decrypt") || msg.includes("operationerror");
}

window.addEventListener("unhandledrejection", (e) => {
  if (isDecryptionError(e.reason)) e.preventDefault();
});

window.addEventListener("error", (e) => {
  if (isDecryptionError(e.error) || isDecryptionError(e.message)) e.preventDefault();
});

createRoot(document.getElementById("root")!).render(<Shell />);
