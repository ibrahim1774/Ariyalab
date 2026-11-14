import { useEffect, useRef } from 'react';

// One observer for every section: elements fade and rise in when they scroll
// into view. Server HTML is fully visible; hiding only starts after hydration,
// and never when the visitor prefers reduced motion.
let observer = null;

function getObserver() {
  if (observer) return observer;
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.setAttribute('data-reveal', 'in');
          observer.unobserve(entry.target);
        }
      }
    },
    { threshold: 0.12 }
  );
  return observer;
}

export default function useReveal() {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const io = getObserver();
    el.setAttribute('data-reveal', 'pending');
    io.observe(el);
    return () => io.unobserve(el);
  }, []);
  return ref;
}
