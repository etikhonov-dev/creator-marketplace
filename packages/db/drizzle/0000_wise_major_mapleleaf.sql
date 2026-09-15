CREATE TYPE "public"."bid_event_type" AS ENUM('placed', 'repriced', 'withdrawn', 'reinstated', 'won', 'lost');--> statement-breakpoint
CREATE TYPE "public"."bid_status" AS ENUM('pending', 'won', 'lost', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."campaign_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."genre" AS ENUM('beauty', 'fashion', 'fitness', 'gaming', 'music', 'food', 'tech', 'travel');--> statement-breakpoint
CREATE TABLE "bid_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"bid_id" uuid NOT NULL,
	"type" "bid_event_type" NOT NULL,
	"amount_cents" bigint,
	"fit_score" numeric(5, 2),
	"actor" text NOT NULL,
	"run_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bids" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"creator_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"fit_score" numeric(5, 2) NOT NULL,
	"pitch" text,
	"status" "bid_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "bids_amount_positive" CHECK ("bids"."amount_cents" > 0),
	CONSTRAINT "bids_fit_score_in_range" CHECK ("bids"."fit_score" BETWEEN 0 AND 100),
	CONSTRAINT "bids_decided_at_matches_status" CHECK (("bids"."status" IN ('won','lost')) = ("bids"."decided_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "campaign_closings" (
	"campaign_id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"bid_count" integer NOT NULL,
	"winning_bid_count" integer NOT NULL,
	"total_awarded_cents" bigint NOT NULL,
	CONSTRAINT "closings_counts_non_negative" CHECK ("campaign_closings"."bid_count" >= 0 AND "campaign_closings"."winning_bid_count" >= 0 AND "campaign_closings"."total_awarded_cents" >= 0),
	CONSTRAINT "closings_winners_within_bids" CHECK ("campaign_closings"."winning_bid_count" <= "campaign_closings"."bid_count")
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_name" text NOT NULL,
	"title" text NOT NULL,
	"brief" text NOT NULL,
	"target_genre" "genre" NOT NULL,
	"min_followers" integer DEFAULT 0 NOT NULL,
	"min_engagement_rate" numeric(5, 4) DEFAULT '0' NOT NULL,
	"budget_cents" bigint NOT NULL,
	"bidding_deadline" timestamp with time zone NOT NULL,
	"status" "campaign_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaigns_budget_positive" CHECK ("campaigns"."budget_cents" > 0),
	CONSTRAINT "campaigns_min_followers_non_negative" CHECK ("campaigns"."min_followers" >= 0),
	CONSTRAINT "campaigns_min_engagement_in_range" CHECK ("campaigns"."min_engagement_rate" BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE TABLE "closing_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"campaigns_closed" integer DEFAULT 0 NOT NULL,
	"bids_decided" integer DEFAULT 0 NOT NULL,
	"total_awarded_cents" bigint DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "creators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"handle" varchar(64) NOT NULL,
	"display_name" text NOT NULL,
	"genre" "genre" NOT NULL,
	"follower_count" integer NOT NULL,
	"engagement_rate" numeric(5, 4) NOT NULL,
	"stats_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "creators_handle_unique" UNIQUE("handle"),
	CONSTRAINT "creators_followers_non_negative" CHECK ("creators"."follower_count" >= 0),
	CONSTRAINT "creators_engagement_in_range" CHECK ("creators"."engagement_rate" BETWEEN 0 AND 1)
);
--> statement-breakpoint
ALTER TABLE "bid_events" ADD CONSTRAINT "bid_events_bid_id_bids_id_fk" FOREIGN KEY ("bid_id") REFERENCES "public"."bids"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bid_events" ADD CONSTRAINT "bid_events_run_id_closing_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."closing_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bids" ADD CONSTRAINT "bids_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bids" ADD CONSTRAINT "bids_creator_id_creators_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."creators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_closings" ADD CONSTRAINT "campaign_closings_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_closings" ADD CONSTRAINT "campaign_closings_run_id_closing_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."closing_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bid_events_by_bid_idx" ON "bid_events" USING btree ("bid_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "bids_one_per_creator_per_campaign" ON "bids" USING btree ("campaign_id","creator_id");--> statement-breakpoint
CREATE INDEX "bids_by_creator_idx" ON "bids" USING btree ("creator_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "campaigns_open_by_deadline_idx" ON "campaigns" USING btree ("bidding_deadline") WHERE "campaigns"."status" = 'open';--> statement-breakpoint
CREATE INDEX "closing_runs_unfinished_idx" ON "closing_runs" USING btree ("started_at") WHERE "closing_runs"."finished_at" IS NULL;