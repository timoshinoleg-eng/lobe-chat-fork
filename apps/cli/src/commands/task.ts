import type { Command } from 'commander';
import pc from 'picocolors';

import { getTrpcClient } from '../api/client';
import { getAuthInfo } from '../api/http';
import { streamAgentEvents } from '../utils/agentStream';
import { confirm, outputJson, printTable, timeAgo, truncate } from '../utils/format';
import { log } from '../utils/logger';

export function registerTaskCommand(program: Command) {
  const task = program.command('task').description('Manage agent tasks');

  // ── list ──────────────────────────────────────────────

  task
    .command('list')
    .description('List tasks')
    .option(
      '--status <status>',
      'Filter by status (pending/running/paused/completed/failed/canceled)',
    )
    .option('--root', 'Only show root tasks (no parent)')
    .option('--parent <id>', 'Filter by parent task ID')
    .option('--agent <id>', 'Filter by assignee agent ID')
    .option('-L, --limit <n>', 'Page size', '50')
    .option('--offset <n>', 'Offset', '0')
    .option('--tree', 'Display as tree structure')
    .option('--json [fields]', 'Output JSON')
    .action(
      async (options: {
        agent?: string;
        json?: string | boolean;
        limit?: string;
        offset?: string;
        parent?: string;
        root?: boolean;
        status?: string;
        tree?: boolean;
      }) => {
        const client = await getTrpcClient();

        const input: Record<string, any> = {};
        if (options.status) input.status = options.status;
        if (options.root) input.parentTaskId = null;
        if (options.parent) input.parentTaskId = options.parent;
        if (options.agent) input.assigneeAgentId = options.agent;
        if (options.limit) input.limit = Number.parseInt(options.limit, 10);
        if (options.offset) input.offset = Number.parseInt(options.offset, 10);

        // For tree mode, fetch all tasks (no pagination limit)
        if (options.tree) {
          input.limit = 100;
          delete input.offset;
        }

        const result = await client.task.list.query(input as any);

        if (options.json !== undefined) {
          outputJson(result.data, options.json);
          return;
        }

        if (!result.data || result.data.length === 0) {
          log.info('No tasks found.');
          return;
        }

        if (options.tree) {
          // Build tree display
          const taskMap = new Map<string, any>();
          for (const t of result.data) taskMap.set(t.id, t);

          const roots = result.data.filter((t: any) => !t.parentTaskId);
          const children = new Map<string, any[]>();
          for (const t of result.data) {
            if (t.parentTaskId) {
              const list = children.get(t.parentTaskId) || [];
              list.push(t);
              children.set(t.parentTaskId, list);
            }
          }

          const printNode = (t: any, prefix: string, isLast: boolean, isRoot: boolean) => {
            const connector = isRoot ? '' : isLast ? '└── ' : '├── ';
            const name = truncate(t.name || t.instruction, 40);
            console.log(
              `${prefix}${connector}${pc.dim(t.identifier)} ${statusBadge(t.status)} ${name}`,
            );
            const childList = children.get(t.id) || [];
            const newPrefix = isRoot ? '' : prefix + (isLast ? '    ' : '│   ');
            childList.forEach((child: any, i: number) => {
              printNode(child, newPrefix, i === childList.length - 1, false);
            });
          };

          for (const root of roots) {
            printNode(root, '', true, true);
          }
          log.info(`Total: ${result.total}`);
          return;
        }

        const rows = result.data.map((t: any) => [
          pc.dim(t.identifier),
          truncate(t.name || t.instruction, 40),
          statusBadge(t.status),
          priorityLabel(t.priority),
          t.assigneeAgentId ? pc.dim(t.assigneeAgentId) : '-',
          t.parentTaskId ? pc.dim('↳ subtask') : '',
          timeAgo(t.createdAt),
        ]);

        printTable(rows, ['ID', 'NAME', 'STATUS', 'PRI', 'AGENT', 'TYPE', 'CREATED']);
        log.info(`Total: ${result.total}`);
      },
    );

  // ── view ──────────────────────────────────────────────

  task
    .command('view <id>')
    .description('View task details (by ID or identifier like TASK-1)')
    .option('--topic <topicId>', 'View messages of a specific topic')
    .option('--json [fields]', 'Output JSON')
    .action(async (id: string, options: { json?: string | boolean; topic?: string }) => {
      const client = await getTrpcClient();

      // If --topic is specified, show topic messages
      if (options.topic) {
        let topicId = options.topic;

        // If it's a number, treat as seq index (e.g. --topic=1)
        const seqNum = Number.parseInt(topicId, 10);
        if (!Number.isNaN(seqNum) && String(seqNum) === topicId) {
          const topicsResult = await client.task.getTopics.query({ id });
          const match = (topicsResult.data || []).find((t: any) => t.seq === seqNum);
          if (!match) {
            log.error(`Topic #${seqNum} not found for this task.`);
            return;
          }
          topicId = match.id;
          log.info(`Topic #${seqNum}: ${pc.bold(match.title || 'Untitled')} ${pc.dim(topicId)}`);
        }

        const messages = await client.message.getMessages.query({ topicId });
        const items = Array.isArray(messages) ? messages : [];

        if (options.json !== undefined) {
          outputJson(items, options.json);
          return;
        }

        if (items.length === 0) {
          log.info('No messages in this topic.');
          return;
        }

        console.log();
        for (const msg of items) {
          const role =
            msg.role === 'assistant'
              ? pc.green('Assistant')
              : msg.role === 'user'
                ? pc.blue('User')
                : pc.dim(msg.role);

          console.log(`${pc.bold(role)} ${pc.dim(timeAgo(msg.createdAt))}`);
          if (msg.content) {
            console.log(msg.content);
          }
          console.log();
        }
        return;
      }

      const result = await client.task.detail.query({ id });

      if (options.json !== undefined) {
        outputJson(result.data, options.json);
        return;
      }

      const t = result.data;

      // ── Header ──
      console.log(`\n${pc.bold(t.identifier)} ${t.name || ''}`);
      console.log(
        `${pc.dim('Status:')} ${statusBadge(t.status)}  ${pc.dim('Priority:')} ${priorityLabel(t.priority)}`,
      );
      console.log(`${pc.dim('Instruction:')} ${t.instruction}`);
      if (t.description) console.log(`${pc.dim('Description:')} ${t.description}`);
      if (t.assigneeAgentId) console.log(`${pc.dim('Agent:')} ${t.assigneeAgentId}`);
      if (t.assigneeUserId) console.log(`${pc.dim('User:')} ${t.assigneeUserId}`);
      if (t.parentTaskId) console.log(`${pc.dim('Parent:')} ${t.parentTaskId}`);
      console.log(
        `${pc.dim('Topics:')} ${t.totalTopics}  ${pc.dim('Created:')} ${timeAgo(t.createdAt)}`,
      );
      if (t.error) console.log(`${pc.red('Error:')} ${t.error}`);

      // ── Checkpoint ──
      {
        const cp = t.checkpoint as any;
        console.log(`\n${pc.bold('Checkpoint:')}`);
        const hasConfig =
          cp.onAgentRequest !== undefined ||
          cp.topic?.before ||
          cp.topic?.after ||
          cp.tasks?.beforeIds?.length > 0 ||
          cp.tasks?.afterIds?.length > 0;

        if (hasConfig) {
          if (cp.onAgentRequest !== undefined)
            console.log(`  onAgentRequest: ${cp.onAgentRequest}`);
          if (cp.topic?.before) console.log(`  topic.before: ${cp.topic.before}`);
          if (cp.topic?.after) console.log(`  topic.after: ${cp.topic.after}`);
          if (cp.tasks?.beforeIds?.length > 0)
            console.log(`  tasks.before: ${cp.tasks.beforeIds.join(', ')}`);
          if (cp.tasks?.afterIds?.length > 0)
            console.log(`  tasks.after: ${cp.tasks.afterIds.join(', ')}`);
        } else {
          console.log(`  ${pc.dim('(not configured, default: onAgentRequest=true)')}`);
        }
      }

      // ── Review ──
      {
        const rv = t.review as any;
        console.log(`\n${pc.bold('Review:')}`);
        if (rv && rv.enabled) {
          console.log(
            `  judge: ${rv.judge?.model || 'default'}${rv.judge?.provider ? ` (${rv.judge.provider})` : ''}`,
          );
          console.log(`  maxIterations: ${rv.maxIterations}  autoRetry: ${rv.autoRetry}`);
          if (rv.criteria?.length > 0) {
            for (const c of rv.criteria) {
              console.log(
                `  - ${c.name}: ≥ ${c.threshold}%${c.weight ? ` (weight: ${c.weight})` : ''}`,
              );
            }
          }
        } else {
          console.log(`  ${pc.dim('(not configured)')}`);
        }
      }

      // ── Subtasks ──
      if (t.subtasks && t.subtasks.length > 0) {
        console.log(`\n${pc.bold('Subtasks:')}`);
        for (const s of t.subtasks) {
          console.log(
            `  ${pc.dim(s.identifier)} ${statusBadge(s.status)} ${s.name || s.instruction}`,
          );
        }
      }

      // ── Dependencies ──
      if (t.dependencies && t.dependencies.length > 0) {
        console.log(`\n${pc.bold('Dependencies:')}`);
        for (const d of t.dependencies as any[]) {
          console.log(`  ${pc.dim(d.type)}: ${d.dependsOnId}`);
        }
      }

      // ── Activities ──
      {
        const activities: { data: any; time: number; type: 'topic' | 'brief' }[] = [];

        for (const tp of t.topics || []) {
          activities.push({
            data: tp,
            time: new Date(tp.createdAt).getTime(),
            type: 'topic',
          });
        }

        for (const b of t.briefs || []) {
          activities.push({
            data: b,
            time: new Date(b.createdAt).getTime(),
            type: 'brief',
          });
        }

        if (activities.length > 0) {
          activities.sort((a, b) => a.time - b.time);

          console.log(`\n${pc.bold('Activities:')}`);
          for (const act of activities) {
            if (act.type === 'topic') {
              const tp = act.data;
              const sBadge = statusBadge(tp.status || 'running');
              console.log(
                `  💬 ${pc.dim(timeAgo(tp.createdAt))} Topic #${tp.seq} ${pc.dim(tp.id)} ${sBadge} ${tp.title || 'Untitled'}`,
              );
            } else {
              const b = act.data;
              const icon = briefIcon(b.type);
              const pri =
                b.priority === 'urgent'
                  ? pc.red(' [urgent]')
                  : b.priority === 'normal'
                    ? pc.yellow(' [normal]')
                    : '';
              const resolved = b.resolvedAt ? pc.green(' ✓') : b.readAt ? pc.dim(' (read)') : '';
              console.log(`  ${icon} ${pc.dim(timeAgo(b.createdAt))} ${b.title}${pri}${resolved}`);
              if (b.summary) console.log(`    ${pc.dim(truncate(b.summary, 80))}`);
              if (b.artifacts?.length > 0)
                console.log(`    ${pc.dim(`📎 ${b.artifacts.length} artifact(s)`)}`);
            }
          }
        }
      }

      console.log();
    });

  // ── create ──────────────────────────────────────────────

  task
    .command('create')
    .description('Create a new task')
    .requiredOption('-i, --instruction <text>', 'Task instruction')
    .option('-n, --name <name>', 'Task name')
    .option('--agent <id>', 'Assign to agent')
    .option('--parent <id>', 'Parent task ID')
    .option('--priority <n>', 'Priority (0=none, 1=urgent, 2=high, 3=normal, 4=low)', '0')
    .option('--prefix <prefix>', 'Identifier prefix', 'TASK')
    .option('--json [fields]', 'Output JSON')
    .action(
      async (options: {
        agent?: string;
        instruction: string;
        json?: string | boolean;
        name?: string;
        parent?: string;
        prefix?: string;
        priority?: string;
      }) => {
        const client = await getTrpcClient();

        const input: Record<string, any> = {
          instruction: options.instruction,
        };
        if (options.name) input.name = options.name;
        if (options.agent) input.assigneeAgentId = options.agent;
        if (options.parent) input.parentTaskId = options.parent;
        if (options.priority) input.priority = Number.parseInt(options.priority, 10);
        if (options.prefix) input.identifierPrefix = options.prefix;

        const result = await client.task.create.mutate(input as any);

        if (options.json !== undefined) {
          outputJson(result.data, options.json);
          return;
        }

        log.info(`Task created: ${pc.bold(result.data.identifier)} ${result.data.name || ''}`);
      },
    );

  // ── edit ──────────────────────────────────────────────

  task
    .command('edit <id>')
    .description('Update a task')
    .option('-n, --name <name>', 'Task name')
    .option('-i, --instruction <text>', 'Task instruction')
    .option('--agent <id>', 'Assign to agent')
    .option('--priority <n>', 'Priority (0-4)')
    .option('--heartbeat-interval <n>', 'Heartbeat interval in seconds')
    .option('--heartbeat-timeout <n>', 'Heartbeat timeout in seconds (0 to disable)')
    .option('--description <text>', 'Task description')
    .option('--json [fields]', 'Output JSON')
    .action(
      async (
        id: string,
        options: {
          agent?: string;
          description?: string;
          heartbeatInterval?: string;
          heartbeatTimeout?: string;
          instruction?: string;
          json?: string | boolean;
          name?: string;
          priority?: string;
        },
      ) => {
        const client = await getTrpcClient();

        const input: Record<string, any> = { id };
        if (options.name) input.name = options.name;
        if (options.instruction) input.instruction = options.instruction;
        if (options.description) input.description = options.description;
        if (options.agent) input.assigneeAgentId = options.agent;
        if (options.priority) input.priority = Number.parseInt(options.priority, 10);
        if (options.heartbeatInterval)
          input.heartbeatInterval = Number.parseInt(options.heartbeatInterval, 10);
        if (options.heartbeatTimeout !== undefined) {
          const val = Number.parseInt(options.heartbeatTimeout, 10);
          input.heartbeatTimeout = val === 0 ? null : val;
        }

        const result = await client.task.update.mutate(input as any);

        if (options.json !== undefined) {
          outputJson(result.data, typeof options.json === 'string' ? options.json : undefined);
          return;
        }

        log.info(`Task updated: ${pc.bold(result.data.identifier)}`);
      },
    );

  // ── delete ──────────────────────────────────────────────

  task
    .command('delete <id>')
    .description('Delete a task')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (id: string, options: { yes?: boolean }) => {
      if (!options.yes) {
        const ok = await confirm(`Delete task ${pc.bold(id)}?`);
        if (!ok) return;
      }

      const client = await getTrpcClient();
      await client.task.delete.mutate({ id });
      log.info(`Task ${pc.bold(id)} deleted.`);
    });

  // ── clear ──────────────────────────────────────────────

  task
    .command('clear')
    .description('Delete all tasks')
    .option('-y, --yes', 'Skip confirmation')
    .action(async (options: { yes?: boolean }) => {
      if (!options.yes) {
        const ok = await confirm(`Delete ${pc.red('ALL')} tasks? This cannot be undone.`);
        if (!ok) return;
      }

      const client = await getTrpcClient();
      const result = (await client.task.clearAll.mutate()) as any;
      log.info(`${result.count} task(s) deleted.`);
    });

  // ── start ──────────────────────────────────────────────

  task
    .command('start <id>')
    .description('Start a task (pending → running)')
    .option('--no-run', 'Only update status, do not trigger agent execution')
    .option('-p, --prompt <text>', 'Additional context for the agent')
    .option('-f, --follow', 'Follow agent output in real-time (default: run in background)')
    .option('--json', 'Output full JSON event stream')
    .option('-v, --verbose', 'Show detailed tool call info')
    .action(
      async (
        id: string,
        options: {
          follow?: boolean;
          json?: boolean;
          prompt?: string;
          run?: boolean;
          verbose?: boolean;
        },
      ) => {
        const client = await getTrpcClient();
        const statusResult = await client.task.updateStatus.mutate({ id, status: 'running' });
        log.info(`Task ${pc.bold(statusResult.data.identifier)} started.`);

        // Auto-run unless --no-run
        if (options.run === false) return;

        // Default agent to inbox if not assigned
        const taskDetail = await client.task.find.query({ id });
        if (!taskDetail.data.assigneeAgentId) {
          await client.task.update.mutate({ assigneeAgentId: 'inbox', id });
          log.info(`Assigned default agent: ${pc.dim('inbox')}`);
        }

        const result = (await client.task.run.mutate({
          id,
          ...(options.prompt && { prompt: options.prompt }),
        })) as any;

        if (!result.success) {
          log.error(`Failed to run task: ${result.error || result.message || 'Unknown error'}`);
          process.exit(1);
        }

        log.info(
          `Operation: ${pc.dim(result.operationId)} · Topic: ${pc.dim(result.topicId || 'n/a')}`,
        );

        if (!options.follow) {
          log.info(
            `Agent running in background. Use ${pc.dim(`lh task view ${id}`)} to check status.`,
          );
          return;
        }

        const { serverUrl, headers } = await getAuthInfo();
        const streamUrl = `${serverUrl}/api/agent/stream?operationId=${encodeURIComponent(result.operationId)}`;

        await streamAgentEvents(streamUrl, headers, {
          json: options.json,
          verbose: options.verbose,
        });

        // Send heartbeat after completion
        try {
          await client.task.heartbeat.mutate({ id });
        } catch {
          // ignore heartbeat errors
        }
      },
    );

  // ── run ──────────────────────────────────────────────

  task
    .command('run <id>')
    .description('Run a task — trigger agent execution')
    .option('-p, --prompt <text>', 'Additional context for the agent')
    .option('-f, --follow', 'Follow agent output in real-time (default: run in background)')
    .option('--topics <n>', 'Run N topics in sequence (default: 1, implies --follow)', '1')
    .option('--delay <s>', 'Delay between topics in seconds', '0')
    .option('--json', 'Output full JSON event stream')
    .option('-v, --verbose', 'Show detailed tool call info')
    .action(
      async (
        id: string,
        options: {
          delay?: string;
          follow?: boolean;
          json?: boolean;
          prompt?: string;
          topics?: string;
          verbose?: boolean;
        },
      ) => {
        const topicCount = Number.parseInt(options.topics || '1', 10);
        const delaySec = Number.parseInt(options.delay || '0', 10);

        // --topics > 1 implies --follow
        const shouldFollow = options.follow || topicCount > 1;

        for (let i = 0; i < topicCount; i++) {
          if (i > 0) {
            log.info(`\n${'─'.repeat(60)}`);
            log.info(`Topic ${i + 1}/${topicCount}`);
            if (delaySec > 0) {
              log.info(`Waiting ${delaySec}s before next topic...`);
              await new Promise((r) => setTimeout(r, delaySec * 1000));
            }
          }

          const client = await getTrpcClient();

          // Only pass extra prompt on first topic
          const result = (await client.task.run.mutate({
            id,
            ...(i === 0 && options.prompt && { prompt: options.prompt }),
          })) as any;

          if (!result.success) {
            log.error(`Failed to run task: ${result.error || result.message || 'Unknown error'}`);
            process.exit(1);
          }

          const operationId = result.operationId;
          if (i === 0) {
            log.info(`Task ${pc.bold(result.taskIdentifier)} running`);
          }
          log.info(`Operation: ${pc.dim(operationId)} · Topic: ${pc.dim(result.topicId || 'n/a')}`);

          if (!shouldFollow) {
            log.info(
              `Agent running in background. Use ${pc.dim(`lh task view ${id}`)} to check status.`,
            );
            return;
          }

          // Connect to SSE stream and wait for completion
          const { serverUrl, headers } = await getAuthInfo();
          const streamUrl = `${serverUrl}/api/agent/stream?operationId=${encodeURIComponent(operationId)}`;

          await streamAgentEvents(streamUrl, headers, {
            json: options.json,
            verbose: options.verbose,
          });

          // Update heartbeat after each topic
          try {
            await client.task.heartbeat.mutate({ id });
          } catch {
            // ignore heartbeat errors
          }
        }
      },
    );

  // ── pause ──────────────────────────────────────────────

  task
    .command('pause <id>')
    .description('Pause a running task')
    .action(async (id: string) => {
      const client = await getTrpcClient();
      const result = await client.task.updateStatus.mutate({ id, status: 'paused' });
      log.info(`Task ${pc.bold(result.data.identifier)} paused.`);
    });

  // ── resume ──────────────────────────────────────────────

  task
    .command('resume <id>')
    .description('Resume a paused task')
    .action(async (id: string) => {
      const client = await getTrpcClient();
      const result = await client.task.updateStatus.mutate({ id, status: 'running' });
      log.info(`Task ${pc.bold(result.data.identifier)} resumed.`);
    });

  // ── complete ──────────────────────────────────────────────

  task
    .command('complete <id>')
    .description('Mark a task as completed')
    .action(async (id: string) => {
      const client = await getTrpcClient();
      const result = (await client.task.updateStatus.mutate({ id, status: 'completed' })) as any;
      log.info(`Task ${pc.bold(result.data.identifier)} completed.`);
      if (result.unlocked?.length > 0) {
        log.info(`Unlocked: ${result.unlocked.map((id: string) => pc.bold(id)).join(', ')}`);
      }
      if (result.paused?.length > 0) {
        log.info(
          `Paused (checkpoint): ${result.paused.map((id: string) => pc.yellow(id)).join(', ')}`,
        );
      }
      if (result.checkpointTriggered) {
        log.info(`${pc.yellow('Checkpoint triggered')} — parent task paused for review.`);
      }
      if (result.allSubtasksDone) {
        log.info(`All subtasks of parent task completed.`);
      }
    });

  // ── cancel ──────────────────────────────────────────────

  task
    .command('cancel <id>')
    .description('Cancel a task')
    .action(async (id: string) => {
      const client = await getTrpcClient();
      const result = await client.task.updateStatus.mutate({ id, status: 'canceled' });
      log.info(`Task ${pc.bold(result.data.identifier)} canceled.`);
    });

  // ── tree ──────────────────────────────────────────────

  task
    .command('tree <id>')
    .description('Show task tree (subtasks + dependencies)')
    .option('--json [fields]', 'Output JSON')
    .action(async (id: string, options: { json?: string | boolean }) => {
      const client = await getTrpcClient();
      const result = await client.task.getTaskTree.query({ id });

      if (options.json !== undefined) {
        outputJson(result.data, options.json);
        return;
      }

      if (!result.data || result.data.length === 0) {
        log.info('No tasks found.');
        return;
      }

      // Build tree display (raw SQL returns snake_case)
      const taskMap = new Map<string, any>();
      for (const t of result.data) taskMap.set(t.id, t);

      const printNode = (taskId: string, indent: number) => {
        const t = taskMap.get(taskId);
        if (!t) return;

        const prefix = indent === 0 ? '' : '  '.repeat(indent) + '├── ';
        const name = t.name || t.identifier || '';
        const status = t.status || 'pending';
        const identifier = t.identifier || t.id;
        console.log(`${prefix}${pc.dim(identifier)} ${statusBadge(status)} ${name}`);

        // Print children (handle both camelCase and snake_case)
        for (const child of result.data) {
          const childParent = child.parentTaskId || child.parent_task_id;
          if (childParent === taskId) {
            printNode(child.id, indent + 1);
          }
        }
      };

      // Find root - resolve identifier first
      const resolved = await client.task.find.query({ id });
      const rootId = resolved.data.id;
      const root = result.data.find((t: any) => t.id === rootId);
      if (root) printNode(root.id, 0);
      else log.info('Root task not found in tree.');
    });

  // ── heartbeat ──────────────────────────────────────────────

  task
    .command('heartbeat <id>')
    .description('Manually send heartbeat for a running task')
    .action(async (id: string) => {
      const client = await getTrpcClient();
      await client.task.heartbeat.mutate({ id });
      log.info(`Heartbeat sent for ${pc.bold(id)}.`);
    });

  // ── watchdog ──────────────────────────────────────────────

  task
    .command('watchdog')
    .description('Run watchdog check — detect and fail stuck tasks')
    .action(async () => {
      const client = await getTrpcClient();
      const result = (await client.task.watchdog.mutate()) as any;

      if (result.failed?.length > 0) {
        log.info(
          `${pc.red('Stuck tasks failed:')} ${result.failed.map((id: string) => pc.bold(id)).join(', ')}`,
        );
      } else {
        log.info('No stuck tasks found.');
      }
    });

  // ── checkpoint ──────────────────────────────────────────────

  const cp = task.command('checkpoint').description('Manage task checkpoints');

  cp.command('view <id>')
    .description('View checkpoint config for a task')
    .action(async (id: string) => {
      const client = await getTrpcClient();
      const result = await client.task.getCheckpoint.query({ id });
      const c = result.data as any;

      console.log(`\n${pc.bold('Checkpoint config:')}`);
      console.log(`  onAgentRequest: ${c.onAgentRequest ?? pc.dim('not set (default: true)')}`);
      if (c.topic) {
        console.log(`  topic.before: ${c.topic.before ?? false}`);
        console.log(`  topic.after: ${c.topic.after ?? false}`);
      }
      if (c.tasks?.beforeIds?.length > 0) {
        console.log(`  tasks.beforeIds: ${c.tasks.beforeIds.join(', ')}`);
      }
      if (c.tasks?.afterIds?.length > 0) {
        console.log(`  tasks.afterIds: ${c.tasks.afterIds.join(', ')}`);
      }
      if (
        !c.topic &&
        !c.tasks?.beforeIds?.length &&
        !c.tasks?.afterIds?.length &&
        c.onAgentRequest === undefined
      ) {
        console.log(`  ${pc.dim('(no checkpoints configured)')}`);
      }
      console.log();
    });

  cp.command('set <id>')
    .description('Configure checkpoints')
    .option('--on-agent-request <bool>', 'Allow agent to request review (true/false)')
    .option('--topic-before <bool>', 'Pause before each topic (true/false)')
    .option('--topic-after <bool>', 'Pause after each topic (true/false)')
    .option('--before <ids>', 'Pause before these subtask identifiers (comma-separated)')
    .option('--after <ids>', 'Pause after these subtask identifiers (comma-separated)')
    .action(
      async (
        id: string,
        options: {
          after?: string;
          before?: string;
          onAgentRequest?: string;
          topicAfter?: string;
          topicBefore?: string;
        },
      ) => {
        const client = await getTrpcClient();

        // Get current config first
        const current = (await client.task.getCheckpoint.query({ id })).data as any;
        const checkpoint: any = { ...current };

        if (options.onAgentRequest !== undefined) {
          checkpoint.onAgentRequest = options.onAgentRequest === 'true';
        }
        if (options.topicBefore !== undefined || options.topicAfter !== undefined) {
          checkpoint.topic = { ...checkpoint.topic };
          if (options.topicBefore !== undefined)
            checkpoint.topic.before = options.topicBefore === 'true';
          if (options.topicAfter !== undefined)
            checkpoint.topic.after = options.topicAfter === 'true';
        }
        if (options.before !== undefined) {
          checkpoint.tasks = { ...checkpoint.tasks };
          checkpoint.tasks.beforeIds = options.before
            .split(',')
            .map((s: string) => s.trim())
            .filter(Boolean);
        }
        if (options.after !== undefined) {
          checkpoint.tasks = { ...checkpoint.tasks };
          checkpoint.tasks.afterIds = options.after
            .split(',')
            .map((s: string) => s.trim())
            .filter(Boolean);
        }

        await client.task.updateCheckpoint.mutate({ checkpoint, id });
        log.info('Checkpoint updated.');
      },
    );

  // ── review ──────────────────────────────────────────────

  const rv = task.command('review').description('Manage task review (LLM-as-Judge)');

  rv.command('view <id>')
    .description('View review config for a task')
    .action(async (id: string) => {
      const client = await getTrpcClient();
      const result = await client.task.getReview.query({ id });
      const r = result.data as any;

      if (!r) {
        log.info('Review not configured for this task.');
        return;
      }

      console.log(`\n${pc.bold('Review config:')}`);
      console.log(`  enabled: ${r.enabled}`);
      console.log(`  judge: ${r.judge.model} (${r.judge.provider})`);
      console.log(`  maxIterations: ${r.maxIterations}`);
      console.log(`  autoRetry: ${r.autoRetry}`);
      console.log(`  criteria:`);
      for (const c of r.criteria || []) {
        console.log(
          `    - ${c.name}: ≥ ${c.threshold}%${c.weight ? ` (weight: ${c.weight})` : ''}`,
        );
      }
      console.log();
    });

  rv.command('set <id>')
    .description('Configure review')
    .option('--model <model>', 'Judge model (uses default if omitted)')
    .option('--provider <provider>', 'Judge provider (uses default if omitted)')
    .requiredOption(
      '--criteria <criteria>',
      'Criteria as name:threshold pairs (comma-separated, e.g. "准确性:80,可读性:70")',
    )
    .option('--max-iterations <n>', 'Max review iterations', '3')
    .option('--no-auto-retry', 'Disable auto retry on failure')
    .action(
      async (
        id: string,
        options: {
          autoRetry?: boolean;
          criteria: string;
          maxIterations?: string;
          model: string;
          provider: string;
        },
      ) => {
        const client = await getTrpcClient();

        const criteria = options.criteria.split(',').map((c: string) => {
          const [name, threshold] = c.trim().split(':');
          return { name: name.trim(), threshold: Number.parseInt(threshold, 10) };
        });

        await client.task.updateReview.mutate({
          id,
          review: {
            autoRetry: options.autoRetry !== false,
            criteria,
            enabled: true,
            judge: {
              ...(options.model && { model: options.model }),
              ...(options.provider && { provider: options.provider }),
            },
            maxIterations: Number.parseInt(options.maxIterations || '3', 10),
          },
        });

        log.info('Review configured.');
      },
    );

  rv.command('run <id>')
    .description('Manually run review on content')
    .requiredOption('--content <text>', 'Content to review')
    .action(async (id: string, options: { content: string }) => {
      const client = await getTrpcClient();
      const result = (await client.task.runReview.mutate({
        content: options.content,
        id,
      })) as any;
      const r = result.data;

      console.log(
        `\n${r.passed ? pc.green('✓ Review passed') : pc.red('✗ Review failed')} (${r.overallScore}%)`,
      );
      for (const s of r.scores) {
        const icon = s.passed ? pc.green('✓') : pc.red('✗');
        console.log(`  ${icon} ${s.criterion}: ${s.score}% (≥ ${s.threshold}%) — ${s.feedback}`);
      }
      if (r.suggestions?.length > 0) {
        console.log(`\n${pc.dim('Suggestions:')}`);
        for (const s of r.suggestions) {
          console.log(`  - ${s}`);
        }
      }
      console.log();
    });

  // ── dep ──────────────────────────────────────────────

  const dep = task.command('dep').description('Manage task dependencies');

  dep
    .command('add <taskId> <dependsOnId>')
    .description('Add dependency (taskId blocks on dependsOnId)')
    .option('--type <type>', 'Dependency type (blocks/relates)', 'blocks')
    .action(async (taskId: string, dependsOnId: string, options: { type?: string }) => {
      const client = await getTrpcClient();
      await client.task.addDependency.mutate({
        dependsOnId,
        taskId,
        type: (options.type || 'blocks') as any,
      });
      log.info(`Dependency added: ${taskId} ${options.type || 'blocks'} on ${dependsOnId}`);
    });

  dep
    .command('rm <taskId> <dependsOnId>')
    .description('Remove dependency')
    .action(async (taskId: string, dependsOnId: string) => {
      const client = await getTrpcClient();
      await client.task.removeDependency.mutate({ dependsOnId, taskId });
      log.info(`Dependency removed.`);
    });

  dep
    .command('list <taskId>')
    .description('List dependencies for a task')
    .option('--json [fields]', 'Output JSON')
    .action(async (taskId: string, options: { json?: string | boolean }) => {
      const client = await getTrpcClient();
      const result = await client.task.getDependencies.query({ id: taskId });

      if (options.json !== undefined) {
        outputJson(result.data, options.json);
        return;
      }

      if (!result.data || result.data.length === 0) {
        log.info('No dependencies.');
        return;
      }

      const rows = result.data.map((d: any) => [d.type, d.dependsOnId, timeAgo(d.createdAt)]);
      printTable(rows, ['TYPE', 'DEPENDS ON', 'CREATED']);
    });
}

function statusBadge(status: string): string {
  switch (status) {
    case 'backlog': {
      return pc.dim('○ backlog');
    }
    case 'running': {
      return pc.blue('● running');
    }
    case 'paused': {
      return pc.yellow('◐ paused');
    }
    case 'completed': {
      return pc.green('✓ completed');
    }
    case 'failed': {
      return pc.red('✗ failed');
    }
    case 'canceled': {
      return pc.dim('⊘ canceled');
    }
    default: {
      return status;
    }
  }
}

function briefIcon(type: string): string {
  switch (type) {
    case 'decision': {
      return '📋';
    }
    case 'result': {
      return '✅';
    }
    case 'insight': {
      return '💡';
    }
    case 'error': {
      return '❌';
    }
    default: {
      return '📌';
    }
  }
}

function priorityLabel(priority: number | null | undefined): string {
  switch (priority) {
    case 1: {
      return pc.red('urgent');
    }
    case 2: {
      return pc.yellow('high');
    }
    case 3: {
      return 'normal';
    }
    case 4: {
      return pc.dim('low');
    }
    default: {
      return pc.dim('-');
    }
  }
}
