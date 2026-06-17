CREATE TABLE "dashboard_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"snapshot_date" date DEFAULT now() NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"alert_type" text NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"severity" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "dashboard_snapshots_snapshot_date_idx" ON "dashboard_snapshots" USING btree ("snapshot_date");--> statement-breakpoint
CREATE INDEX "dashboard_snapshots_created_at_idx" ON "dashboard_snapshots" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "market_alerts_created_at_idx" ON "market_alerts" USING btree ("created_at");