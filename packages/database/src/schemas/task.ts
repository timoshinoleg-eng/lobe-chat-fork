import { index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { idGenerator } from '../utils/idGenerator';
import { createdAt, timestamps, timestamptz, varchar255 } from './_helpers';
import { documents } from './file';
import { users } from './user';

// ── Tasks ────────────────────────────────────────────────

export const tasks = pgTable(
  'tasks',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => idGenerator('tasks'))
      .notNull(),

    // Workspace-level identifier (e.g. 'TASK-1', 'PROJ-42')
    identifier: text('identifier').notNull(),
    seq: integer('seq').notNull(),
    // Creator (user or agent)
    createdByUserId: text('created_by_user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    createdByAgentId: text('created_by_agent_id'),

    // Assignee (user and agent can coexist, both nullable)
    assigneeUserId: text('assignee_user_id'),
    assigneeAgentId: text('assignee_agent_id'),

    // Tree structure (self-referencing, no depth limit)
    parentTaskId: text('parent_task_id'),

    // Task definition
    name: text('name'),
    description: varchar255('description'),
    instruction: text('instruction').notNull(),

    // Lifecycle (same state machine for user and agent)
    // 'backlog' | 'running' | 'paused' | 'completed' | 'failed' | 'canceled'
    status: text('status').notNull().default('backlog'),
    priority: integer('priority').default(0), // 'no' | 'urgent' | 'high' | 'normal' | 'low'

    // Heartbeat
    heartbeatInterval: integer('heartbeat_interval').default(300), // seconds
    heartbeatTimeout: integer('heartbeat_timeout').$defaultFn(() => 600), // seconds
    lastHeartbeatAt: timestamptz('last_heartbeat_at'),

    // Schedule (optional)
    schedulePattern: text('schedule_pattern'),
    scheduleTimezone: text('schedule_timezone').default('UTC'),

    // Topic management
    totalTopics: integer('total_topics').default(0),
    maxTopics: integer('max_topics'), // null = unlimited
    currentTopicId: text('current_topic_id'),

    // Context & config (each task independent, no inheritance from parent)
    context: jsonb('context').default({}),
    config: jsonb('config').default({}), // CheckpointConfig, ReviewConfig, etc.
    error: text('error'),

    // Timestamps
    startedAt: timestamptz('started_at'),
    completedAt: timestamptz('completed_at'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('tasks_identifier_idx').on(t.identifier, t.createdByUserId),
    index('tasks_created_by_user_id_idx').on(t.createdByUserId),
    index('tasks_created_by_agent_id_idx').on(t.createdByAgentId),
    index('tasks_assignee_user_id_idx').on(t.assigneeUserId),
    index('tasks_assignee_agent_id_idx').on(t.assigneeAgentId),
    index('tasks_parent_task_id_idx').on(t.parentTaskId),
    index('tasks_status_idx').on(t.status),
    index('tasks_priority_idx').on(t.priority),
    index('tasks_heartbeat_idx').on(t.status, t.lastHeartbeatAt),
  ],
);

export type NewTask = typeof tasks.$inferInsert;
export type TaskItem = typeof tasks.$inferSelect;

// ── Task Dependencies ────────────────────────────────────

export const taskDependencies = pgTable(
  'task_dependencies',
  {
    id: uuid('id').defaultRandom().primaryKey().notNull(),

    taskId: text('task_id')
      .references(() => tasks.id, { onDelete: 'cascade' })
      .notNull(),
    dependsOnId: text('depends_on_id')
      .references(() => tasks.id, { onDelete: 'cascade' })
      .notNull(),

    // 'blocks' | 'relates'
    type: text('type').notNull().default('blocks'),

    // Reserved for conditional dependencies: {"on": "success"} / {"on": "failure"}
    condition: jsonb('condition'),

    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('task_deps_unique_idx').on(t.taskId, t.dependsOnId),
    index('task_deps_task_id_idx').on(t.taskId),
    index('task_deps_depends_on_id_idx').on(t.dependsOnId),
  ],
);

export type NewTaskDependency = typeof taskDependencies.$inferInsert;
export type TaskDependencyItem = typeof taskDependencies.$inferSelect;

// ── Task Documents (MVP Workspace) ───────────────────────

export const taskDocuments = pgTable(
  'task_documents',
  {
    id: uuid('id').defaultRandom().primaryKey().notNull(),
    taskId: text('task_id')
      .references(() => tasks.id, { onDelete: 'cascade' })
      .notNull(),
    documentId: text('document_id')
      .references(() => documents.id, { onDelete: 'cascade' })
      .notNull(),

    // 'agent' | 'user' | 'system'
    pinnedBy: text('pinned_by').notNull().default('agent'),

    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('task_docs_unique_idx').on(t.taskId, t.documentId),
    index('task_docs_task_id_idx').on(t.taskId),
    index('task_docs_document_id_idx').on(t.documentId),
  ],
);

export type NewTaskDocument = typeof taskDocuments.$inferInsert;
export type TaskDocumentItem = typeof taskDocuments.$inferSelect;

// ── Task Topics ─────────────────────────────────────────

export const taskTopics = pgTable(
  'task_topics',
  {
    id: uuid('id').defaultRandom().primaryKey().notNull(),
    taskId: text('task_id')
      .references(() => tasks.id, { onDelete: 'cascade' })
      .notNull(),
    topicId: text('topic_id').notNull(),

    seq: integer('seq').notNull(), // topic sequence within task (1, 2, 3...)
    operationId: text('operation_id'), // agent execution operation ID
    // 'running' | 'completed' | 'failed'
    status: text('status').notNull().default('running'),

    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('task_topics_unique_idx').on(t.taskId, t.topicId),
    index('task_topics_task_id_idx').on(t.taskId),
    index('task_topics_topic_id_idx').on(t.topicId),
    index('task_topics_status_idx').on(t.taskId, t.status),
  ],
);

export type NewTaskTopic = typeof taskTopics.$inferInsert;
export type TaskTopicItem = typeof taskTopics.$inferSelect;
