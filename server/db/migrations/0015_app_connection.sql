CREATE TABLE "app_connection" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text,
	"session_id" text,
	"app" text NOT NULL,
	"label" text NOT NULL,
	"user_code" text,
	"device_code_hash" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"code_expires_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text
);
--> statement-breakpoint
ALTER TABLE "app_connection" ADD CONSTRAINT "app_connection_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_connection" ADD CONSTRAINT "app_connection_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_app_connection_org" ON "app_connection" USING btree ("org_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "idx_app_connection_user" ON "app_connection" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_app_connection_session" ON "app_connection" USING btree ("session_id") WHERE "app_connection"."session_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_app_connection_user_code" ON "app_connection" USING btree ("user_code") WHERE "app_connection"."user_code" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_app_connection_device_code" ON "app_connection" USING btree ("device_code_hash") WHERE "app_connection"."device_code_hash" IS NOT NULL;