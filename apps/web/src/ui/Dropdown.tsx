// Toolbar dropdown: a chip that opens a small panel under it. Closes on an outside click, on Esc, or when an item
// asks to (render-prop `close`). Used to fold the toolbar's many pills into a few menus.
import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

export function Dropdown({
  label,
  icon,
  active = false,
  align = "right",
  className = "",
  children,
}: {
  label: ReactNode;
  icon?: ReactNode;
  /** Highlight the chip (something inside is on). */
  active?: boolean;
  align?: "left" | "right";
  className?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  return (
    <div className={`dd ${className}`} ref={wrap}>
      <button className={`chip dd-trigger ${active || open ? "on" : ""}`} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((o) => !o)}>
        {icon}
        {label}
        <ChevronDown size={13} className={`dd-caret ${open ? "up" : ""}`} />
      </button>
      {open && (
        <div className={`dd-panel panel dd-${align}`} role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

/** One row in a dropdown panel. */
export function DropdownItem({ on = false, onClick, icon, children, hint }: { on?: boolean; onClick: () => void; icon?: ReactNode; children: ReactNode; hint?: string }) {
  return (
    <button className={`dd-item ${on ? "on" : ""}`} role="menuitemradio" aria-checked={on} title={hint} onClick={onClick}>
      {icon}
      <span>{children}</span>
    </button>
  );
}
