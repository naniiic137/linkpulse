import { useEffect, useState } from 'react';

/** Remaining whole seconds until `deadline` (epoch ms). Returns 0 once passed, or when deadline is null. */
export function secondsLeft(deadline: number | null, now: number = Date.now()): number {
  if (deadline === null) return 0;
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

export function useCountdown(deadline: number | null): number {
  const [left, setLeft] = useState(() => secondsLeft(deadline));
  useEffect(() => {
    setLeft(secondsLeft(deadline));
    if (deadline === null) return;
    const id = window.setInterval(() => {
      const s = secondsLeft(deadline);
      setLeft(s);
      if (s === 0) window.clearInterval(id);
    }, 250);
    return () => window.clearInterval(id);
  }, [deadline]);
  return left;
}
