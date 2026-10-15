import { useEffect, useState } from "react";
import { useSim } from "../state/store";

/** One short line, bottom centre, gone after 2.5 s. */
export function Toast() {
  const toast = useSim((s) => s.toast);
  const [shown, setShown] = useState<number | null>(null);
  useEffect(() => {
    if (!toast) return;
    setShown(toast.id);
    const id = setTimeout(() => setShown(null), 2500);
    return () => clearTimeout(id);
  }, [toast]);
  if (!toast || shown !== toast.id) return null;
  return (
    <div className="toast" role="status">
      {toast.text}
    </div>
  );
}
