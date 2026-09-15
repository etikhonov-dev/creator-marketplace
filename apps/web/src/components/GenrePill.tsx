export function GenrePill({ genre, muted = false }: { genre: string; muted?: boolean }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
      muted ? 'bg-slate-100 text-slate-600' : 'bg-indigo-100 text-indigo-700'
    }`}>
      {genre}
    </span>
  )
}
