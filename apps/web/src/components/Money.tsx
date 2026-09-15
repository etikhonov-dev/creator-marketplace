const EUR = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' })

/**
 * Cents in, euros out. The only place the UI divides by 100, so a stray float
 * cannot spread: everything upstream of here is an integer.
 */
export function Money({ cents }: { cents: number }) {
  return <span className="tabular-nums">{EUR.format(cents / 100)}</span>
}
