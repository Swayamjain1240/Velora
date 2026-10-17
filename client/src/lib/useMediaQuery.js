'use strict';

import { useEffect, useState } from 'react';

// Reads a CSS media query in React. The initial value comes from matchMedia
// during the first render (not from an effect), so a phone never paints the
// desktop table before switching, and jsdom (where every query is false) keeps
// rendering the desktop presentation the component tests assert.
export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const list = window.matchMedia(query);
    const onChange = (event) => setMatches(event.matches);
    setMatches(list.matches);
    if (list.addEventListener) list.addEventListener('change', onChange);
    else list.addListener(onChange);
    return () => {
      if (list.removeEventListener) list.removeEventListener('change', onChange);
      else list.removeListener(onChange);
    };
  }, [query]);

  return matches;
}

export default useMediaQuery;
