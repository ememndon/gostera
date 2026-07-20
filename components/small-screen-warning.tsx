"use client";

import { useEffect, useState } from "react";
import { Monitor } from "lucide-react";

export function SmallScreenWarning() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const check = () => setShow(window.innerWidth < 1024);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  if (!show) return null;

  return (
    <div className="fixed inset-0 z-[100] bg-background flex flex-col items-center justify-center p-8 text-center gap-4">
      <Monitor className="h-12 w-12 text-muted-foreground" />
      <h1 className="text-xl font-bold">Screen too small</h1>
      <p className="text-muted-foreground text-sm max-w-xs">
        Gostera is designed for screens 1024px and wider. Please use a laptop
        or desktop, or rotate your tablet to landscape mode.
      </p>
      <p className="text-xs text-muted-foreground/60">
        Current width: {typeof window !== "undefined" ? window.innerWidth : 0}px
      </p>
    </div>
  );
}
