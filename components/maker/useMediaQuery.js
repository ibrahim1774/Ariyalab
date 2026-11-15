import { useEffect, useState } from 'react';

/** True while the media query matches. False on the server and where matchMedia does not exist. */
export default function useMediaQuery(query) {
  // Ask matchMedia straight away so a phone never renders the desktop variant first.
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia(query);
    const update = () => setMatches(mq.matches);
    update();
    if (mq.addEventListener) mq.addEventListener('change', update);
    else mq.addListener?.(update);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', update);
      else mq.removeListener?.(update);
    };
  }, [query]);
  return matches;
}
