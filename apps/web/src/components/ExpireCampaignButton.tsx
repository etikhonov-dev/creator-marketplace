import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client.js'
import { messageFor } from '../api/errorCopy.js'

/**
 * Demo affordance. Vite inlines VITE_* at build time, so when dev tools are off
 * this component and its call site are compiled out of the bundle entirely —
 * there is no runtime flag anyone can flip in the browser.
 *
 * The copy is "Expire deadline now", never "Close auction", because that is
 * exactly what it does: it moves a deadline. The worker still decides winners.
 */
export function ExpireCampaignButton({ campaignId }: { campaignId: string }) {
  const enabled = import.meta.env['VITE_ENABLE_DEV_TOOLS'] === 'true'
  const queryClient = useQueryClient()

  const mutation = useMutation({
    mutationFn: () => api.expireCampaign(campaignId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['campaigns'] })
      void queryClient.invalidateQueries({ queryKey: ['bids'] })
    },
  })

  if (!enabled) return null

  return (
    <div className="mt-3 rounded-md border border-dashed border-amber-400 bg-amber-50/60 p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="rounded bg-amber-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900">
          Demo
        </span>
        <button
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending}
          title="Sets the deadline to now. The scheduled worker closes the auction on its next pass (~15s)."
          className="text-xs font-medium text-amber-900 underline decoration-dotted disabled:opacity-50"
        >
          {mutation.isPending ? 'Setting deadline…' : 'Expire deadline now (demo)'}
        </button>
      </div>
      {mutation.isSuccess && (
        <p className="mt-1.5 text-xs text-amber-900">
          Deadline set. The worker closes this auction within ~15 seconds — this page updates on its own.
        </p>
      )}
      {mutation.isError && (
        <p className="mt-1.5 text-xs text-red-700">{messageFor(mutation.error)}</p>
      )}
    </div>
  )
}
