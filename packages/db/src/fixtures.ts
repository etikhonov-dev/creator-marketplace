import type { Genre } from '@marketplace/domain'

/** Minutes from seed time, so the demo has the right shape whenever it runs. */
export type DeadlineOffsetMinutes = number

export const CREATOR_FIXTURES: ReadonlyArray<{
  id: string; handle: string; displayName: string; genre: Genre
  followerCount: number; engagementRate: string; statsAgeHours: number
}> = [
  { id: '11111111-0000-4000-8000-000000000001', handle: '@mia.beats',      displayName: 'Mia Bekker',      genre: 'music',   followerCount: 412_000,   engagementRate: '0.0620', statsAgeHours: 2 },
  { id: '11111111-0000-4000-8000-000000000002', handle: '@liftwithlena',   displayName: 'Lena Fischer',    genre: 'fitness', followerCount: 128_000,   engagementRate: '0.0780', statsAgeHours: 1 },
  { id: '11111111-0000-4000-8000-000000000003', handle: '@glowbyjo',       displayName: 'Johanna Weiss',   genre: 'beauty',  followerCount: 890_000,   engagementRate: '0.0210', statsAgeHours: 6 },
  { id: '11111111-0000-4000-8000-000000000004', handle: '@kitchen.kai',    displayName: 'Kai Nowak',       genre: 'food',    followerCount: 34_000,    engagementRate: '0.0710', statsAgeHours: 3 },
  { id: '11111111-0000-4000-8000-000000000005', handle: '@pixelpatrick',   displayName: 'Patrick Adeyemi', genre: 'gaming',  followerCount: 1_240_000, engagementRate: '0.0150', statsAgeHours: 12 },
  { id: '11111111-0000-4000-8000-000000000006', handle: '@sofi.styles',    displayName: 'Sofia Rossi',     genre: 'fashion', followerCount: 61_000,    engagementRate: '0.0440', statsAgeHours: 4 },
  { id: '11111111-0000-4000-8000-000000000007', handle: '@tinytechtom',    displayName: 'Tom Haverkamp',   genre: 'tech',    followerCount: 12_400,    engagementRate: '0.0530', statsAgeHours: 8 },
  { id: '11111111-0000-4000-8000-000000000008', handle: '@wander.with.wu', displayName: 'Wen Wu',          genre: 'travel',  followerCount: 205_000,   engagementRate: '0.0110', statsAgeHours: 30 },
]

export const CAMPAIGN_FIXTURES: ReadonlyArray<{
  id: string; brandName: string; title: string; brief: string; targetGenre: Genre
  minFollowers: number; minEngagementRate: string; budgetCents: number
  deadlineOffsetMinutes: DeadlineOffsetMinutes
}> = [
  // ── Already past deadline: the bootstrap's `worker --once` settles these, so
  //    won/lost state is visible on first page load.
  { id: '22222222-0000-4000-8000-000000000001', brandName: "L'Oréal Paris", title: 'Summer Glow launch',       brief: 'Three-part story series featuring the new Summer Glow serum.', targetGenre: 'beauty',  minFollowers: 50_000,  minEngagementRate: '0.0150', budgetCents: 1_200_000, deadlineOffsetMinutes: -240 },
  { id: '22222222-0000-4000-8000-000000000002', brandName: 'Sony Music',    title: 'Album drop amplification', brief: 'Use the lead single in one Reel plus one feed post.',           targetGenre: 'music',   minFollowers: 100_000, minEngagementRate: '0.0200', budgetCents: 800_000,   deadlineOffsetMinutes: -180 },
  // ── Deadline two minutes out. Biddable on first load, then `awaiting_results`
  //    once it lapses, then `settled` on the looping worker's next tick — the
  //    one campaign that demonstrates all three phases without touching the DB.
  { id: '22222222-0000-4000-8000-000000000003', brandName: 'ABOUT YOU',     title: 'Autumn capsule try-on',    brief: 'Try-on haul of six autumn pieces, your styling.',               targetGenre: 'fashion', minFollowers: 25_000,  minEngagementRate: '0.0200', budgetCents: 600_000,   deadlineOffsetMinutes: 2 },
  // ── Closing soon: the reviewer can bid and watch it settle.
  { id: '22222222-0000-4000-8000-000000000004', brandName: 'Zalando',       title: 'Sneaker week teaser',      brief: 'One unboxing Reel before Sneaker Week.',                        targetGenre: 'fashion', minFollowers: 10_000,  minEngagementRate: '0.0100', budgetCents: 450_000,   deadlineOffsetMinutes: 6 },
  { id: '22222222-0000-4000-8000-000000000005', brandName: 'HelloFresh',    title: 'Weeknight recipe series',  brief: 'Three recipes using the autumn box.',                           targetGenre: 'food',    minFollowers: 20_000,  minEngagementRate: '0.0300', budgetCents: 700_000,   deadlineOffsetMinutes: 12 },
  // ── Comfortably open.
  { id: '22222222-0000-4000-8000-000000000006', brandName: 'Gymshark',      title: 'Winter training push',     brief: 'Four-week training series in the new range.',                   targetGenre: 'fitness', minFollowers: 75_000,  minEngagementRate: '0.0400', budgetCents: 1_500_000, deadlineOffsetMinutes: 2_880 },
  { id: '22222222-0000-4000-8000-000000000007', brandName: 'Logitech G',    title: 'Peripheral review drop',   brief: 'Honest review of the new keyboard and mouse.',                  targetGenre: 'gaming',  minFollowers: 200_000, minEngagementRate: '0.0100', budgetCents: 950_000,   deadlineOffsetMinutes: 4_320 },
  { id: '22222222-0000-4000-8000-000000000008', brandName: 'Flixbus',       title: 'City-hop challenge',       brief: 'Three cities in one weekend, on a budget.',                     targetGenre: 'travel',  minFollowers: 0,       minEngagementRate: '0.0000', budgetCents: 300_000,   deadlineOffsetMinutes: 7_200 },
  { id: '22222222-0000-4000-8000-000000000009', brandName: 'Nothing',       title: 'Phone (3) first look',     brief: 'First-look video within 24h of embargo lift.',                  targetGenre: 'tech',    minFollowers: 10_000,  minEngagementRate: '0.0450', budgetCents: 550_000,   deadlineOffsetMinutes: 5_760 },
  { id: '22222222-0000-4000-8000-00000000000a', brandName: 'Oatly',         title: 'Barista edition tasting',  brief: 'Coffee-shop style taste test.',                                 targetGenre: 'food',    minFollowers: 500_000, minEngagementRate: '0.0500', budgetCents: 400_000,   deadlineOffsetMinutes: 8_640 },
]

/**
 * Bids on the two already-expired campaigns, so the budget genuinely binds and
 * the greedy rule visibly rejects someone. Amounts chosen so campaign 1's
 * €12,000 budget cannot cover all four bids.
 */
export const BID_FIXTURES: ReadonlyArray<{
  campaignId: string; creatorId: string; amountCents: number; pitch: string
}> = [
  { campaignId: '22222222-0000-4000-8000-000000000001', creatorId: '11111111-0000-4000-8000-000000000003', amountCents: 550_000, pitch: 'Serum fits my skincare series exactly.' },
  { campaignId: '22222222-0000-4000-8000-000000000001', creatorId: '11111111-0000-4000-8000-000000000006', amountCents: 400_000, pitch: 'Beauty-adjacent fashion audience, high save rate.' },
  { campaignId: '22222222-0000-4000-8000-000000000001', creatorId: '11111111-0000-4000-8000-000000000002', amountCents: 380_000, pitch: 'Post-workout glow angle.' },
  { campaignId: '22222222-0000-4000-8000-000000000001', creatorId: '11111111-0000-4000-8000-000000000001', amountCents: 260_000, pitch: 'Can pair with a track release.' },
  { campaignId: '22222222-0000-4000-8000-000000000002', creatorId: '11111111-0000-4000-8000-000000000001', amountCents: 420_000, pitch: 'Lead single already in my rotation.' },
  { campaignId: '22222222-0000-4000-8000-000000000002', creatorId: '11111111-0000-4000-8000-000000000005', amountCents: 500_000, pitch: 'Gaming crossover, music in streams.' },
]
