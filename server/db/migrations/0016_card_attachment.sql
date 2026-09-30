CREATE TABLE "card_attachment" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"post_id" uuid NOT NULL,
	"uploader_id" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"storage_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "card_attachment" ADD CONSTRAINT "card_attachment_post_id_post_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."post"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_card_attachment_post" ON "card_attachment" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "idx_card_attachment_expires" ON "card_attachment" USING btree ("expires_at");