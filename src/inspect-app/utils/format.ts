export function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = Math.round(seconds - minutes * 60);
  return `${minutes}m ${String(rem).padStart(2, '0')}s`;
}

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return new Intl.NumberFormat('en-US').format(n);
}

export function formatPercent(used: number, max: number): string {
  if (!max) return '—';
  return `${Math.round((used / max) * 100)}%`;
}

export function safeUrl(href: string | null | undefined): string {
  if (!href) return '#';
  try {
    const url = new URL(href);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '#';
    return url.toString();
  } catch {
    return '#';
  }
}
