CREATE TABLE "staxx_error_server" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"last_seen_at" timestamp with time zone,
	"last_address" varchar(64),
	"blocked" boolean DEFAULT false NOT NULL,
	"report_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staxx_error_shape" (
	"hash" varchar(64) PRIMARY KEY NOT NULL,
	"post_id" uuid NOT NULL,
	"shape" varchar(300) NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now(),
	"last_seen_at" timestamp with time zone,
	"servers_seen" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staxx_error_sighting" (
	"server_id" varchar(64) NOT NULL,
	"hash" varchar(64) NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staxx_error_sighting_server_id_hash_pk" PRIMARY KEY("server_id","hash")
);
--> statement-breakpoint
ALTER TABLE "board" ADD COLUMN "visibility" varchar(10) DEFAULT 'public' NOT NULL;