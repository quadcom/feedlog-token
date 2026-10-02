ALTER TABLE "staxx_error_shape" ADD COLUMN "report_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "staxx_error_shape" ADD COLUMN "explanation_id" varchar(64);--> statement-breakpoint
ALTER TABLE "staxx_error_shape" ADD COLUMN "explanation_title" varchar(200);--> statement-breakpoint
ALTER TABLE "staxx_error_shape" ADD COLUMN "written_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "staxx_error_shape" ADD COLUMN "released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "staxx_error_shape" ADD COLUMN "release_ref" varchar(64);