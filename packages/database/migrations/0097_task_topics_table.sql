CREATE TABLE IF NOT EXISTS "task_topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" text NOT NULL,
	"topic_id" text NOT NULL,
	"seq" integer NOT NULL,
	"operation_id" text,
	"status" text DEFAULT 'running' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_topics" DROP CONSTRAINT IF EXISTS "task_topics_task_id_tasks_id_fk";
ALTER TABLE "task_topics" ADD CONSTRAINT "task_topics_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "task_topics_unique_idx" ON "task_topics" USING btree ("task_id","topic_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_topics_task_id_idx" ON "task_topics" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_topics_topic_id_idx" ON "task_topics" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_topics_status_idx" ON "task_topics" USING btree ("task_id","status");