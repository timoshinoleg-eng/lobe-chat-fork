import type { CheckpointConfig } from '@lobechat/types';
import { and, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';

import type { NewTask, TaskItem, TaskTopicItem } from '../schemas/task';
import { taskDependencies, taskDocuments, tasks, taskTopics } from '../schemas/task';
import type { LobeChatDatabase } from '../type';

export class TaskModel {
  private readonly userId: string;
  private readonly db: LobeChatDatabase;

  constructor(db: LobeChatDatabase, userId: string) {
    this.db = db;
    this.userId = userId;
  }

  // ========== CRUD ==========

  async create(
    data: Omit<NewTask, 'id' | 'identifier' | 'seq' | 'createdByUserId'> & {
      identifierPrefix?: string;
    },
  ): Promise<TaskItem> {
    const { identifierPrefix = 'TASK', ...rest } = data;

    // Get next seq for this user
    const seqResult = await this.db
      .select({ maxSeq: sql<number>`COALESCE(MAX(${tasks.seq}), 0)` })
      .from(tasks)
      .where(eq(tasks.createdByUserId, this.userId));

    const nextSeq = Number(seqResult[0].maxSeq) + 1;
    const identifier = `${identifierPrefix}-${nextSeq}`;

    const result = await this.db
      .insert(tasks)
      .values({
        ...rest,
        createdByUserId: this.userId,
        identifier,
        seq: nextSeq,
      } as NewTask)
      .returning();

    return result[0];
  }

  async findById(id: string): Promise<TaskItem | null> {
    const result = await this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.createdByUserId, this.userId)))
      .limit(1);

    return result[0] || null;
  }

  // Resolve id or identifier (e.g. 'TASK-1') to a task
  async resolve(idOrIdentifier: string): Promise<TaskItem | null> {
    if (idOrIdentifier.startsWith('task_')) return this.findById(idOrIdentifier);
    return this.findByIdentifier(idOrIdentifier.toUpperCase());
  }

  async findByIdentifier(identifier: string): Promise<TaskItem | null> {
    const result = await this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.identifier, identifier), eq(tasks.createdByUserId, this.userId)))
      .limit(1);

    return result[0] || null;
  }

  async update(
    id: string,
    data: Partial<Omit<NewTask, 'id' | 'identifier' | 'seq' | 'createdByUserId'>>,
  ): Promise<TaskItem | null> {
    const result = await this.db
      .update(tasks)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(tasks.id, id), eq(tasks.createdByUserId, this.userId)))
      .returning();

    return result[0] || null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db
      .delete(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.createdByUserId, this.userId)))
      .returning();

    return result.length > 0;
  }

  async deleteAll(): Promise<number> {
    const result = await this.db
      .delete(tasks)
      .where(eq(tasks.createdByUserId, this.userId))
      .returning();

    return result.length;
  }

  // ========== Query ==========

  async list(options?: {
    assigneeAgentId?: string;
    limit?: number;
    offset?: number;
    parentTaskId?: string | null;
    status?: string;
  }): Promise<{ tasks: TaskItem[]; total: number }> {
    const { status, parentTaskId, assigneeAgentId, limit = 50, offset = 0 } = options || {};

    const conditions = [eq(tasks.createdByUserId, this.userId)];

    if (status) conditions.push(eq(tasks.status, status));
    if (assigneeAgentId) conditions.push(eq(tasks.assigneeAgentId, assigneeAgentId));

    if (parentTaskId === null) {
      conditions.push(isNull(tasks.parentTaskId));
    } else if (parentTaskId) {
      conditions.push(eq(tasks.parentTaskId, parentTaskId));
    }

    const where = and(...conditions);

    const countResult = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(where);

    const taskList = await this.db
      .select()
      .from(tasks)
      .where(where)
      .orderBy(desc(tasks.createdAt))
      .limit(limit)
      .offset(offset);

    return { tasks: taskList, total: Number(countResult[0].count) };
  }

  async findSubtasks(parentTaskId: string): Promise<TaskItem[]> {
    return this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.parentTaskId, parentTaskId), eq(tasks.createdByUserId, this.userId)))
      .orderBy(tasks.seq);
  }

  // Recursive query to get full task tree
  async getTaskTree(rootTaskId: string): Promise<TaskItem[]> {
    const result = await this.db.execute(sql`
      WITH RECURSIVE task_tree AS (
        SELECT * FROM tasks WHERE id = ${rootTaskId} AND created_by_user_id = ${this.userId}
        UNION ALL
        SELECT t.* FROM tasks t
        JOIN task_tree tt ON t.parent_task_id = tt.id
      )
      SELECT * FROM task_tree
    `);

    return result.rows as TaskItem[];
  }

  // ========== Status ==========

  async updateStatus(
    id: string,
    status: string,
    extra?: { completedAt?: Date; error?: string; startedAt?: Date },
  ): Promise<TaskItem | null> {
    return this.update(id, { status, ...extra });
  }

  async batchUpdateStatus(ids: string[], status: string): Promise<number> {
    const result = await this.db
      .update(tasks)
      .set({ status, updatedAt: new Date() })
      .where(and(inArray(tasks.id, ids), eq(tasks.createdByUserId, this.userId)))
      .returning();

    return result.length;
  }

  // ========== Checkpoint ==========

  getCheckpointConfig(task: TaskItem): CheckpointConfig {
    return (task.config as Record<string, any>)?.checkpoint || {};
  }

  async updateCheckpointConfig(id: string, checkpoint: CheckpointConfig): Promise<TaskItem | null> {
    const task = await this.findById(id);
    if (!task) return null;

    const config = { ...(task.config as Record<string, any>), checkpoint };
    return this.update(id, { config });
  }

  // ========== Review Config ==========

  getReviewConfig(task: TaskItem): Record<string, any> | undefined {
    return (task.config as Record<string, any>)?.review;
  }

  async updateReviewConfig(id: string, review: Record<string, any>): Promise<TaskItem | null> {
    const task = await this.findById(id);
    if (!task) return null;

    const config = { ...(task.config as Record<string, any>), review };
    return this.update(id, { config });
  }

  // Check if a task should pause after a topic completes
  // Default: pause (when no checkpoint config is set)
  // Explicit: pause only if topic.after is true
  shouldPauseOnTopicComplete(task: TaskItem): boolean {
    const checkpoint = this.getCheckpointConfig(task);
    const hasAnyConfig = Object.keys(checkpoint).length > 0;
    return hasAnyConfig ? !!checkpoint.topic?.after : true;
  }

  // Check if a task should be paused before starting (parent's tasks.beforeIds)
  shouldPauseBeforeStart(parentTask: TaskItem, childIdentifier: string): boolean {
    const checkpoint = this.getCheckpointConfig(parentTask);
    return checkpoint.tasks?.beforeIds?.includes(childIdentifier) ?? false;
  }

  // Check if a task should be paused after completing (parent's tasks.afterIds)
  shouldPauseAfterComplete(parentTask: TaskItem, childIdentifier: string): boolean {
    const checkpoint = this.getCheckpointConfig(parentTask);
    return checkpoint.tasks?.afterIds?.includes(childIdentifier) ?? false;
  }

  // ========== Heartbeat ==========

  async updateHeartbeat(id: string): Promise<void> {
    await this.db
      .update(tasks)
      .set({ lastHeartbeatAt: new Date(), updatedAt: new Date() })
      .where(eq(tasks.id, id));
  }

  // Find stuck tasks (running but heartbeat timed out)
  // Only checks tasks that have both lastHeartbeatAt and heartbeatTimeout set
  static async findStuckTasks(db: LobeChatDatabase): Promise<TaskItem[]> {
    return db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.status, 'running'),
          isNotNull(tasks.lastHeartbeatAt),
          isNotNull(tasks.heartbeatTimeout),
          sql`${tasks.lastHeartbeatAt} < now() - make_interval(secs => ${tasks.heartbeatTimeout})`,
        ),
      );
  }

  // ========== Dependencies ==========

  async addDependency(taskId: string, dependsOnId: string, type: string = 'blocks'): Promise<void> {
    await this.db
      .insert(taskDependencies)
      .values({ dependsOnId, taskId, type })
      .onConflictDoNothing();
  }

  async removeDependency(taskId: string, dependsOnId: string): Promise<void> {
    await this.db
      .delete(taskDependencies)
      .where(
        and(eq(taskDependencies.taskId, taskId), eq(taskDependencies.dependsOnId, dependsOnId)),
      );
  }

  async getDependencies(taskId: string) {
    return this.db.select().from(taskDependencies).where(eq(taskDependencies.taskId, taskId));
  }

  async getDependents(taskId: string) {
    return this.db.select().from(taskDependencies).where(eq(taskDependencies.dependsOnId, taskId));
  }

  // Check if all dependencies of a task are completed
  async areAllDependenciesCompleted(taskId: string): Promise<boolean> {
    const result = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(taskDependencies)
      .innerJoin(tasks, eq(taskDependencies.dependsOnId, tasks.id))
      .where(
        and(
          eq(taskDependencies.taskId, taskId),
          eq(taskDependencies.type, 'blocks'),
          ne(tasks.status, 'completed'),
        ),
      );

    return Number(result[0].count) === 0;
  }

  // Find tasks that are now unblocked after a dependency completes
  async getUnlockedTasks(completedTaskId: string): Promise<TaskItem[]> {
    // Find all tasks that depend on the completed task
    const dependents = await this.getDependents(completedTaskId);
    const unlocked: TaskItem[] = [];

    for (const dep of dependents) {
      if (dep.type !== 'blocks') continue;

      // Check if ALL dependencies of this task are now completed
      const allDone = await this.areAllDependenciesCompleted(dep.taskId);
      if (!allDone) continue;

      // Get the task itself — only unlock if it's in backlog
      const task = await this.findById(dep.taskId);
      if (task && task.status === 'backlog') {
        unlocked.push(task);
      }
    }

    return unlocked;
  }

  // Check if all subtasks of a parent task are completed
  async areAllSubtasksCompleted(parentTaskId: string): Promise<boolean> {
    const result = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(
        and(
          eq(tasks.parentTaskId, parentTaskId),
          ne(tasks.status, 'completed'),
          eq(tasks.createdByUserId, this.userId),
        ),
      );

    return Number(result[0].count) === 0;
  }

  // ========== Documents (MVP Workspace) ==========

  async pinDocument(taskId: string, documentId: string, pinnedBy: string = 'agent'): Promise<void> {
    await this.db
      .insert(taskDocuments)
      .values({ documentId, pinnedBy, taskId })
      .onConflictDoNothing();
  }

  async unpinDocument(taskId: string, documentId: string): Promise<void> {
    await this.db
      .delete(taskDocuments)
      .where(and(eq(taskDocuments.taskId, taskId), eq(taskDocuments.documentId, documentId)));
  }

  async getPinnedDocuments(taskId: string) {
    return this.db
      .select()
      .from(taskDocuments)
      .where(eq(taskDocuments.taskId, taskId))
      .orderBy(taskDocuments.createdAt);
  }

  // Get all pinned docs from a task tree (recursive)
  async getTreePinnedDocuments(rootTaskId: string) {
    const result = await this.db.execute(sql`
      WITH RECURSIVE task_tree AS (
        SELECT id FROM tasks WHERE id = ${rootTaskId}
        UNION ALL
        SELECT t.id FROM tasks t
        JOIN task_tree tt ON t.parent_task_id = tt.id
      )
      SELECT td.*, tt.id as source_task_id
      FROM task_documents td
      JOIN task_tree tt ON td.task_id = tt.id
      ORDER BY td.created_at
    `);

    return result.rows;
  }

  // ========== Topic Management ==========

  async incrementTopicCount(id: string): Promise<void> {
    await this.db
      .update(tasks)
      .set({
        totalTopics: sql`${tasks.totalTopics} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(tasks.id, id));
  }

  async updateCurrentTopic(id: string, topicId: string): Promise<void> {
    await this.db
      .update(tasks)
      .set({ currentTopicId: topicId, updatedAt: new Date() })
      .where(eq(tasks.id, id));
  }

  async getTopicsWithDetails(taskId: string) {
    const { topics } = await import('../schemas/topic');
    return this.db
      .select({
        createdAt: topics.createdAt,
        id: topics.id,
        metadata: topics.metadata,
        operationId: taskTopics.operationId,
        seq: taskTopics.seq,
        status: taskTopics.status,
        title: topics.title,
        updatedAt: topics.updatedAt,
      })
      .from(taskTopics)
      .innerJoin(topics, eq(taskTopics.topicId, topics.id))
      .where(eq(taskTopics.taskId, taskId))
      .orderBy(desc(taskTopics.seq));
  }

  async getTopicsWithHandoff(taskId: string, limit = 4) {
    const { topics } = await import('../schemas/topic');
    return this.db
      .select({ metadata: topics.metadata, title: topics.title })
      .from(taskTopics)
      .innerJoin(topics, eq(taskTopics.topicId, topics.id))
      .where(eq(taskTopics.taskId, taskId))
      .orderBy(desc(taskTopics.seq))
      .limit(limit);
  }

  async addTopic(
    taskId: string,
    topicId: string,
    params: { operationId?: string; seq: number },
  ): Promise<void> {
    await this.db
      .insert(taskTopics)
      .values({ operationId: params.operationId, seq: params.seq, taskId, topicId })
      .onConflictDoNothing();
  }

  async updateTopicStatus(taskId: string, topicId: string, status: string): Promise<void> {
    await this.db
      .update(taskTopics)
      .set({ status })
      .where(and(eq(taskTopics.taskId, taskId), eq(taskTopics.topicId, topicId)));
  }

  async getTopics(taskId: string): Promise<TaskTopicItem[]> {
    return this.db
      .select()
      .from(taskTopics)
      .where(eq(taskTopics.taskId, taskId))
      .orderBy(desc(taskTopics.seq));
  }
}
