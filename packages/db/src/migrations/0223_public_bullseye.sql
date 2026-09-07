ALTER TABLE "issues" ADD COLUMN "start_date" date;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "due_date" date;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "estimated_hours" numeric(8, 2);