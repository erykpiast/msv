import { useEffect } from 'react';
import { tokens } from '../theme/tokens';

function pulseElement(element: HTMLElement) {
  element.setAttribute('data-pulse', 'true');
  window.setTimeout(() => element.removeAttribute('data-pulse'), tokens.highlightPulseMs);
}

export function scrollToHash(hash: string) {
  if (!hash) return;
  const id = hash.startsWith('#') ? hash.slice(1) : hash;
  const target = document.getElementById(id);
  if (!target) return;
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  pulseElement(target);
}

export function useAnchorScroll() {
  useEffect(() => {
    const handler = () => scrollToHash(window.location.hash);
    window.addEventListener('hashchange', handler);
    if (window.location.hash) {
      // Defer first-paint scroll so the hash target has mounted.
      const id = window.setTimeout(handler, 100);
      return () => {
        window.clearTimeout(id);
        window.removeEventListener('hashchange', handler);
      };
    }
    return () => window.removeEventListener('hashchange', handler);
  }, []);
}
