export function pct(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

export function money(value: number): string {
  return `$${Math.round(value)}`;
}
