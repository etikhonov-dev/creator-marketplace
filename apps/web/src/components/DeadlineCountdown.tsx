import { useEffect, useState } from 'react'

function format(msLeft: number): string {
  if (msLeft <= 0) return 'deadline passed'
  const s = Math.floor(msLeft / 1000)
  if (s < 60) return `in ${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `in ${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `in ${h}h ${m % 60}m`
  return `in ${Math.floor(h / 24)}d`
}

/**
 * Ticks every second inside the last hour and stops ticking beyond it — a
 * "in 3d" label re-rendering once a second is pure waste, and the urgency
 * signal only matters near the end.
 */
export function DeadlineCountdown({ deadline }: { deadline: string }) {
  const target = new Date(deadline).getTime()
  const [now, setNow] = useState(() => Date.now())
  const msLeft = target - now
  const ticking = msLeft > 0 && msLeft < 3_600_000

  useEffect(() => {
    if (!ticking) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [ticking])

  const urgent = msLeft > 0 && msLeft < 300_000
  return (
    <span
      className={`text-xs tabular-nums ${urgent ? 'font-medium text-amber-700' : 'text-slate-500'}`}
      title={new Date(deadline).toLocaleString()}
    >
      Closes {format(msLeft)}
    </span>
  )
}
