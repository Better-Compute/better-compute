import { ComputeError, field, manifest, type StepDefinition } from '@better-compute/core';
import { stepNotReady } from './engine.js';
import { defineStep } from './step.js';

// Built-in control-plane steps (PLAN.md §11.4). They poll the store and report "not ready yet"
// until their condition holds; the step's timeout bounds the wait.

/**
 * `wait.agentJoined`: the target node has a connected session, optionally as a given role
 * (`ramdisk` after a PXE boot, `node` after kexec into the installed OS).
 */
export const waitAgentJoined: StepDefinition<{ role?: 'node' | 'ramdisk' | 'site' }> = defineStep({
  id: 'wait.agentJoined',
  runsOn: 'control-plane',
  timeout: '15m',
  retrySafe: true,
  input: manifest({ role: field.option(['node', 'ramdisk', 'site']).optional() }),
  async run(input, context) {
    if (!context.node) throw new ComputeError('INVALID_STATE', 'wait.agentJoined needs a node');
    const { rows } = await context.sql.query<{ role: string | null; boot_id: string | null; connected: boolean }>(
      `SELECT role, boot_id,
              (connected_at IS NOT NULL AND (disconnected_at IS NULL OR connected_at > disconnected_at)) AS connected
         FROM node_sessions WHERE node_id = $1`,
      [context.node.id],
    );
    const session = rows[0];
    if (!session?.connected || (input.role !== undefined && session.role !== input.role)) throw stepNotReady(5_000);
    return { role: session.role, bootId: session.boot_id };
  },
});

/** `wait.generationObserved`: the node has converged the desired state it was last given. */
export const waitGenerationObserved: StepDefinition<Record<string, never>> = defineStep({
  id: 'wait.generationObserved',
  runsOn: 'control-plane',
  timeout: '10m',
  retrySafe: true,
  input: manifest({}),
  async run(_input, context) {
    if (!context.node) throw new ComputeError('INVALID_STATE', 'wait.generationObserved needs a node');
    const { rows } = await context.sql.query<{ generation: number; observed_generation: number }>(
      'SELECT generation, observed_generation FROM nodes WHERE id = $1',
      [context.node.id],
    );
    const node = rows[0];
    if (!node) throw new ComputeError('NOT_FOUND', `Node ${context.node.id} does not exist`);
    if (Number(node.observed_generation) < Number(node.generation)) throw stepNotReady(5_000);
    return { generation: Number(node.generation) };
  },
});

/** The steps `provisionModule()` registers unless told otherwise. */
export const builtinSteps: readonly StepDefinition[] = Object.freeze([waitAgentJoined, waitGenerationObserved]);
